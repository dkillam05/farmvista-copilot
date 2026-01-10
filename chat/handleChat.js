// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-10-handleChat-sqlFirst5-resolver-enforcement
//
// Fixes based on live tests:
// ✅ If user says "tower", prefer field/tower resolvers (avoid mistakenly resolving as farm)
// ✅ If resolve_* returns candidates, MUST respond with "Did you mean" list (never "could not find")
// ✅ Keeps SQL-first, tool_choice required, text extraction

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString();

function safeStr(v) { return (v == null ? "" : String(v)); }

function jsonTryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const text = await rsp.text();
  const data = jsonTryParse(text);
  if (!rsp.ok) {
    const msg = data?.error?.message || text || `OpenAI error (${rsp.status})`;
    throw new Error(msg);
  }
  return data;
}

function extractFunctionCalls(responseJson) {
  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return items.filter(it => it && it.type === "function_call");
}

function extractAssistantText(responseJson) {
  const direct = safeStr(responseJson?.output_text || "").trim();
  if (direct) return direct;

  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const parts = [];

  for (const it of items) {
    if (!it) continue;
    if (it.type === "message") {
      const content = Array.isArray(it.content) ? it.content : [];
      for (const c of content) {
        if (!c) continue;
        if (c.type === "output_text" && typeof c.text === "string") {
          const t = c.text.trim();
          if (t) parts.push(t);
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function buildSystemPrompt(dbStatus, userText) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  const u = (userText || "").toLowerCase();
  const mentionsTower = u.includes("tower");
  const mentionsFarm = u.includes("farm");

  // Intent hint: if they say "tower" and NOT "farm", treat named entity as field/tower, not farm
  const intentHint = (mentionsTower && !mentionsFarm)
    ? "USER INTENT HINT: This question is about RTK towers/assignments. Do NOT assume the name refers to a farm."
    : "";

  return `
You are FarmVista Copilot (SQL-first + fuzzy resolvers).

MANDATORY RULES:
- If user mentions a FIELD name (even partial/typo), call resolve_field(query) first.
- If user mentions an RTK TOWER name (even partial/typo), call resolve_rtk_tower(query) first.
- Only use resolve_farm(query) when the user clearly indicates they mean a FARM (e.g., says 'farm' or asks for farms list).
- After you get a match id, use db_query by ID to fetch facts.

DID-YOU-MEAN RULE (HARD):
- If any resolve_* tool returns candidates (and match is null), you MUST respond with:
  "Did you mean:" + candidate list (5–12 items) and ask which one.
- Never respond "I could not find ..." if candidates were provided.

SQL-FIRST RULE (HARD):
- For all database facts, do not guess. Use tools.

${intentHint}

DATABASE SNAPSHOT CONTEXT:
- snapshotId: ${snapshotId}
- loadedAt: ${loadedAt || "unknown"}
- counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

TABLES:
- farms(id, name)
- fields(id, name, farmId, farmName, rtkTowerId, rtkTowerName, county, state, acresTillable, archived)
- rtkTowers(id, name, networkId, frequency, provider)
`.trim();
}

export async function handleChatHttp(req, res) {
  try {
    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    const userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    const tools = [
      {
        type: "function",
        name: "db_query",
        description: "Run a read-only SQL SELECT query against the FarmVista SQLite snapshot database.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
            params: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
            limit: { type: "number" }
          },
          required: ["sql"]
        }
      },
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool
    ];

    const system = buildSystemPrompt(dbStatus, userText);
    const userContent = threadId ? `threadId=${threadId}\n\n${userText}` : userText;

    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userContent }
    ];

    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    for (let i = 0; i < 10; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let didAny = false;

      for (const call of calls) {
        const name = safeStr(call?.name);
        const args = jsonTryParse(call.arguments) || {};
        let result = null;

        if (name === "db_query") {
          didAny = true;
          const sql = safeStr(args.sql || "");
          const params = Array.isArray(args.params) ? args.params : [];
          const limit = Number.isFinite(args.limit) ? args.limit : 200;
          try {
            result = runSql({ sql, params, limit });
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }
        } else if (name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
        } else {
          continue;
        }

        input_list.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result ?? { ok: false, error: "no_result" })
        });
      }

      if (!didAny) break;

      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "auto",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    const text = extractAssistantText(rsp) || "No answer.";

    const meta = {
      usedOpenAI: true,
      model: OPENAI_MODEL,
      snapshot: dbStatus?.snapshot || null
    };

    return res.json({ ok: true, text, meta: debugAI ? meta : undefined });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
