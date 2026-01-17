// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-16-final-tool-only
//
// RULES (HARD):
// - OpenAI MUST call a tool for EVERY answer
// - NO text-only answers
// - NO fallbacks
// - NO local logic deciding answers
// - If no tool is called → ERROR

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { fieldsToolDefs, fieldsHandleToolCall } from "./domains/fields.js";
import { farmsToolDefs, farmsHandleToolCall } from "./domains/farms.js";
import { rtkTowersToolDefs, rtkTowersHandleToolCall } from "./domains/rtkTowers.js";
import { grainToolDefs, grainHandleToolCall } from "./domains/grain.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_BASE  = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/* ---------------- OpenAI ---------------- */
async function openaiResponsesCreate(payload) {
  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const text = await rsp.text();
  const data = JSON.parse(text);

  if (!rsp.ok) {
    throw new Error(data?.error?.message || text);
  }
  return data;
}

function extractFunctionCalls(resp) {
  return Array.isArray(resp?.output)
    ? resp.output.filter(o => o.type === "function_call")
    : [];
}

/* ---------------- tool dispatch ---------------- */
function dispatchTool(name, args) {
  return (
    grainHandleToolCall(name, args) ||
    fieldsHandleToolCall(name, args) ||
    farmsHandleToolCall(name, args) ||
    rtkTowersHandleToolCall(name, args) ||
    null
  );
}

/* =====================================================================
   HTTP handler
===================================================================== */
export async function handleChatHttp(req, res) {
  try {
    await ensureDbReady();
    const dbStatus = await getDbStatus();

    const userText = (req.body?.text || "").trim();
    if (!userText) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    const system = `
You are FarmVista Copilot.

HARD RULES:
- You MUST call a tool to answer.
- You MUST NOT answer with plain text.
- If you do not call a tool, the request FAILS.
- All answers must come from domain tools.

DB snapshot: ${dbStatus.snapshot?.id || "unknown"}
`.trim();

    const tools = [
      ...grainToolDefs(),
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      {
        type: "function",
        name: "db_query",
        description: "Read-only SQL",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
            params: { type: "array" }
          },
          required: ["sql"]
        }
      }
    ];

    // FIRST CALL — tool REQUIRED
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: userText }
      ],
      tools,
      tool_choice: "required",
      temperature: 0
    });

    const calls = extractFunctionCalls(rsp);

    if (!calls.length) {
      // 🔥 THIS IS INTENTIONAL
      return res.status(500).json({
        ok: false,
        error: "OpenAI did not call a tool (tool-only mode enforced)"
      });
    }

    // Execute tools
    for (const call of calls) {
      const result = dispatchTool(call.name, JSON.parse(call.arguments || "{}"));
      if (!result) {
        return res.status(500).json({
          ok: false,
          error: `Unhandled tool call: ${call.name}`
        });
      }

      return res.json({
        ok: true,
        text: result.text,
        meta: { snapshot: dbStatus.snapshot }
      });
    }

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}