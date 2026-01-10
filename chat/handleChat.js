// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-10-handleChat-sqlFirst1
//
// RULE: Never guess about DB facts.
// The model MUST call db_query for anything about farms/fields/towers/equipment/counts/assignments.
//
// Uses OpenAI Responses API via fetch (Node 20+).

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString();

function safeStr(v) {
  return (v == null ? "" : String(v));
}

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

function extractToolCalls(responseJson) {
  // Responses API: output is array of items; tool calls have type === "tool_call"
  const out = [];
  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  for (const it of items) {
    if (it?.type === "tool_call") out.push(it);
  }
  return out;
}

function outputText(responseJson) {
  // Most convenient: output_text
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

    const tools = [
      {
        type: "function",
        function: {
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
      }
    ];

    const system = buildSystemPrompt(dbStatus);

    // 1) Initial OpenAI call
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: system },
        // threadId is optional – we pass it in content to help the model keep continuity if you later add storage
        { role: "user", content: threadId ? `threadId=${threadId}\n\n${userText}` : userText }
      ],
      tools,
      // keep it deterministic
      temperature: 0.2
    });

    // 2) Tool-call loop
    for (let i = 0; i < 8; i++) {
      const toolCalls = extractToolCalls(rsp);
      if (!toolCalls.length) break;

      const toolOutputs = [];

      for (const tc of toolCalls) {
        if (tc?.name !== "db_query") continue;

        const args = jsonTryParse(tc.arguments) || {};
        const sql = safeStr(args.sql || "");
        const params = Array.isArray(args.params) ? args.params : [];
        const limit = Number.isFinite(args.limit) ? args.limit : 200;

        let result;
        try {
          result = runSql({ sql, params, limit });
        } catch (e) {
          result = { ok: false, error: e?.message || String(e) };
        }

        toolOutputs.push({
          type: "tool_output",
          tool_call_id: tc.id,
          output: JSON.stringify(result)
        });
      }

      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: system },
          { role: "user", content: threadId ? `threadId=${threadId}\n\n${userText}` : userText },
          // Provide prior model output + tool outputs back to continue reasoning
          ...(Array.isArray(rsp.output) ? rsp.output : []),
          ...toolOutputs
        ],
        tools,
        temperature: 0.2
      });
    }

    const text = outputText(rsp).trim() || "No answer.";

    // Debug footer metadata
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
