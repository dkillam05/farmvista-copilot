// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-10-handleChat-sqlFirst2-responses-toolsfix
//
// Fix:
// ✅ OpenAI Responses API tool schema: tools[] must have top-level {type,name,description,parameters}
// ✅ Tool call items are type "function_call" with "call_id", not "tool_call" with "id"
// ✅ Tool outputs are type "function_call_output" with "call_id"
//
// Rule: Never guess about DB facts. MUST call db_query for DB questions.

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

function outputText(responseJson) {
  return safeStr(responseJson?.output_text || "");
}

function buildSystemPrompt(dbStatus) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  return `
You are FarmVista Copilot (SQL-first).

CRITICAL RULES:
1) If the user asks about ANY factual data that would live in the FarmVista database (farms, fields, RTK towers, equipment, assignments, counts, IDs, network IDs, frequencies, locations, etc.), you MUST call db_query first. Do not guess. Do not answer from memory.
2) If db_query returns 0 rows, say "Not found in the current snapshot" and then run a second db_query to fetch closest matches using LIKE on name fields.
3) Keep answers short and specific. If multiple matches, present 5–15 options and ask the user to pick.

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

    if (!userText) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    // Responses API tool schema: name is TOP-LEVEL (not nested)
    // https://platform.openai.com/docs/guides/function-calling :contentReference[oaicite:1]{index=1}
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

    // Keep a running input list like the docs show
    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userContent }
    ];

    // 1) Initial model call
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      input: input_list,
      temperature: 0.2
    });

    // Append model output items to the running input
    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // 2) Tool-call loop
    for (let i = 0; i < 8; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let any = false;

      for (const call of calls) {
        if (call?.name !== "db_query") continue;

        any = true;

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

        // Provide function call output back to model
        input_list.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      if (!any) break;

      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    const text = outputText(rsp).trim() || "No answer.";

    const meta = {
      usedOpenAI: true,
      model: OPENAI_MODEL,
      snapshot: dbStatus?.snapshot || null
    };

    return res.json({
      ok: true,
      text,
      meta: debugAI ? meta : undefined
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
