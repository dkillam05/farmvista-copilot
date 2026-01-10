// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-10-handleChat-sqlFirst7-count-defaults-active-null-archived
//
// Fix:
// ✅ Default "how many fields do we have" = COUNT ALL rows in fields
// ✅ Only filter active/non-archived if user explicitly asks
// ✅ When filtering non-archived: archived IS NULL OR archived=0 (NULL means not archived)

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString();

// Pending disambiguation memory (keeps yes/no working)
const PENDING = new Map(); // threadId -> { kind, query, candidates, createdAt, originalQuestion }

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

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

function isYesLike(s) {
  const v = norm(s);
  return ["yes", "y", "yep", "yeah", "correct", "right", "that", "that one", "yes i did"].includes(v);
}

function isNoLike(s) {
  const v = norm(s);
  return ["no", "n", "nope", "nah"].includes(v);
}

function prunePending() {
  const now = Date.now();
  for (const [k, v] of PENDING.entries()) {
    if (!v?.createdAt || (now - v.createdAt) > (10 * 60 * 1000)) PENDING.delete(k);
  }
}

function formatDidYouMean(kind, candidates) {
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push(``);
  lines.push(`Reply with the exact name, or say "yes" to pick the first one.`);
  return lines.join("\n");
}

function buildSystemPrompt(dbStatus, userText) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  const u = (userText || "").toLowerCase();

  const mentionsTower = u.includes("tower");
  const mentionsFarm = u.includes("farm");

  const intentHint = (mentionsTower && !mentionsFarm)
    ? "USER INTENT HINT: This question is about RTK towers/assignments. Do NOT assume the name refers to a farm."
    : "";

  return `
You are FarmVista Copilot (SQL-first + fuzzy resolvers).

COUNTING DEFAULTS (HARD):
- If user asks "How many fields do we have?" or "count fields" WITHOUT saying active/non-archived, COUNT ALL rows:
  SELECT COUNT(*) FROM fields;
- Only apply active/non-archived filters if user explicitly asks for active/non-archived.
- IMPORTANT: fields.archived can be NULL. Treat NULL as NOT archived.
  Non-archived condition: (archived IS NULL OR archived = 0)

MANDATORY WORKFLOW:
- If user mentions a FIELD name (even partial/typo), call resolve_field(query) first.
- If user mentions an RTK TOWER name (even partial/typo), call resolve_rtk_tower(query) first.
- Only use resolve_farm(query) when user clearly indicates they mean a FARM.
- After you get a match id, use db_query by ID (or JOIN by id) to fetch final facts.

DID-YOU-MEAN RULE (HARD):
- If resolve_* returns candidates and match is null, respond with "Did you mean:" list and ask which one.

SQL-FIRST RULE (HARD):
- For all DB facts, do not guess. Use tools.

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
    prunePending();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    // Follow-up yes/no for pending disambiguation
    if (threadId && PENDING.has(threadId)) {
      const pend = PENDING.get(threadId);
      if (isYesLike(userText)) {
        const top = pend?.candidates?.[0] || null;
        if (top && pend.originalQuestion) {
          userText = `${pend.originalQuestion}\n\nUser confirmed: ${top.name} (id=${top.id}). Proceed using that id.`;
          PENDING.delete(threadId);
        }
      } else if (isNoLike(userText)) {
        PENDING.delete(threadId);
        return res.json({
          ok: true,
          text: "Okay — tell me the exact field/farm/tower name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      }
    }

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

    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userText }
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
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (threadId) {
              PENDING.set(threadId, {
                kind: "field",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("field", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (threadId) {
              PENDING.set(threadId, {
                kind: "farm",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("farm", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (threadId) {
              PENDING.set(threadId, {
                kind: "rtk tower",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("rtk tower", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
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