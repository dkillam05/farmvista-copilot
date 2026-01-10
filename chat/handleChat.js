// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-10-handleChat-sqlFirst3-textparse-toolchoice-required
//
// Fix:
// ✅ tool_choice:"required" so model MUST call at least one tool when tools are provided
// ✅ robust text extraction from Responses API output items (message -> content -> output_text)
// ✅ keeps SQL-first rule and function_call loop

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

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

// Some responses return empty output_text, but include a message item with content parts.
// We pull assistant text out of response.output[].message.content[].output_text.text
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

function buildSystemPrompt(dbStatus) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  return `
You are FarmVista Copilot (SQL-first).

CRITICAL RULES:
1) If the user asks about ANY factual data that would live in the FarmVista database (farms, fields, RTK towers, equipment, assignments, counts, IDs, network IDs, frequencies, locations, etc.), you MUST call db_query first. Do not guess.
2) If db_query returns 0 rows, say "Not found in the current snapshot" and then run a second db_query to fetch closest matches using LIKE on name fields.
3) Keep answers short and specific.

DATABASE SNAPSHOT CONTEXT:
- snapshotId: ${snapshotId}
- loadedAt: ${loadedAt || "unknown"}
- counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

SQL HINTS (use these tables/columns):
- farms: id, name
- fields: id, name, farmId, farmName, rtkTowerId, rtkTowerName, county, state, acresTillable, archived
- rtkTowers: id, name, networkId, frequency, provider
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
      }
    ];

    const system = buildSystemPrompt(dbStatus);
    const userContent = threadId ? `threadId=${threadId}\n\n${userText}` : userText;

    // Running input list
    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userContent }
    ];

    // 1) Initial call — force at least one tool call when tools exist
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // 2) Tool-call loop
    for (let i = 0; i < 8; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let didAny = false;

      for (const call of calls) {
        if (call?.name !== "db_query") continue;
        didAny = true;

        const args = jsonTryParse(call.arguments) || {};
        const sql = safeStr(args.sql || "");
        const params = Array.isArray(args.params) ? args.params : [];
        const limit = Number.isFinite(args.limit) ? args.limit : 200;

        let result;
        try {
          result = runSql({ sql, params, limit });
        } catch (e) {
          result = { ok: false, error: e?.message || String(e) };
        }

        input_list.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      if (!didAny) break;

      // After tools, let the model respond normally (don’t require more tool calls)
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
