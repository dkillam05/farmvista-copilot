// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-17-debug-proof-always-all-domains
//
// Goals:
// ✅ OpenAI handles every question.
// ✅ Tool use is REQUIRED (no plain text answers).
// ✅ Always return proof meta so UI footer shows who answered + what tools were used.
// ✅ Support ALL domains (grain/fields/farms/rtk) + db_query fallback.
//
// Notes:
// - handleChat remains BORING: orchestrator + tool runner + meta.

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { grainToolDefs, grainHandleToolCall } from "./domains/grain.js";
import { fieldsToolDefs, fieldsHandleToolCall } from "./domains/fields.js";
import { farmsToolDefs, farmsHandleToolCall } from "./domains/farms.js";
import { rtkTowersToolDefs, rtkTowersHandleToolCall } from "./domains/rtkTowers.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL   = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE    = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

function jsonTry(s){ try { return JSON.parse(s); } catch { return null; } }
function safeStr(v){ return (v == null ? "" : String(v)); }

function cleanSql(raw){
  let s = safeStr(raw || "").trim();
  s = s.replace(/;\s*$/g, "").trim();
  if (s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

async function openai(payload){
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const r = await fetch(`${OPENAI_BASE}/responses`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body:JSON.stringify(payload)
  });

  const t = await r.text();
  const j = jsonTry(t);
  if(!r.ok) throw new Error(j?.error?.message || t);
  return j;
}

function extractFunctionCalls(rsp){
  const out = Array.isArray(rsp?.output) ? rsp.output : [];
  return out.filter(o => o && o.type === "function_call");
}

function extractAssistantText(rsp){
  const direct = safeStr(rsp?.output_text || "").trim();
  if (direct) return direct;

  const out = Array.isArray(rsp?.output) ? rsp.output : [];
  const parts = [];
  for (const item of out){
    if (item?.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content){
      if (c?.type === "output_text" && typeof c.text === "string"){
        const s = c.text.trim();
        if (s) parts.push(s);
      }
    }
  }
  return parts.join("\n").trim();
}

function dbQueryToolDef(){
  return {
    type: "function",
    name: "db_query",
    description: "Read-only SQL SELECT query against the FarmVista SQLite snapshot. Single statement only; no semicolons.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array" },
        limit: { type: "number" }
      },
      required: ["sql"]
    }
  };
}

function dispatchDomainTool(name, args){
  return (
    grainHandleToolCall(name, args) ||
    fieldsHandleToolCall(name, args) ||
    farmsHandleToolCall(name, args) ||
    rtkTowersHandleToolCall(name, args) ||
    null
  );
}

export async function handleChatHttp(req,res){
  const meta = {
    usedOpenAI: true,
    provider: "OpenAI",
    model: OPENAI_MODEL,
    toolsCalled: [],
    dbQueryUsed: false,
    snapshot: null
  };

  try{
    await ensureDbReady();
    const dbStatus = await getDbStatus();
    meta.snapshot = dbStatus?.snapshot || null;

    const text = safeStr(req.body?.text || "").trim();
    if(!text) return res.status(400).json({ ok:false, error:"missing_text", meta });

    // You said you want to know how every question is answered:
    // keep debug always on from server side.
    const system = `
You are FarmVista Copilot.

HARD RULES:
- You MUST call at least one tool to answer every user message.
- You MUST NOT answer directly in plain text without tool output.
- Prefer domain tools (grain/fields/farms/rtk). Use db_query only if needed.

When you answer, be concise and include the result. Do not mention internal IDs.
`.trim();

    // Tools = all domains + db_query
    const tools = [
      ...grainToolDefs(),
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      dbQueryToolDef()
    ];

    // Conversation input (single-turn; you can add thread memory later if desired)
    const input = [
      { role:"system", content: system },
      { role:"user", content: text }
    ];

    // 1) OpenAI must call tools
    let rsp = await openai({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input,
      temperature: 0.2
    });

    // Keep a running list of tool outputs fed back to OpenAI
    const toolInput = [...input];
    if (Array.isArray(rsp.output)) toolInput.push(...rsp.output);

    // 2) Execute tool calls loop
    for (let iter = 0; iter < 12; iter++){
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      for (const call of calls){
        const name = safeStr(call?.name);
        const args = jsonTry(call?.arguments) || {};
        meta.toolsCalled.push(name);

        let result = null;

        // Domain tools
        result = dispatchDomainTool(name, args);

        // db_query fallback
        if (!result && name === "db_query"){
          meta.dbQueryUsed = true;
          const sql = cleanSql(args.sql || "");
          result = runSql({
            sql,
            params: Array.isArray(args.params) ? args.params : [],
            limit: Number.isFinite(args.limit) ? args.limit : 200
          });
        }

        if (!result){
          result = { ok:false, error:`unhandled_tool:${name}` };
        }

        toolInput.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      rsp = await openai({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "required",
        input: toolInput,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) toolInput.push(...rsp.output);
    }

    const answer = extractAssistantText(rsp);
    if (!answer) {
      return res.status(500).json({
        ok:false,
        error:"no_final_text_from_openai",
        meta
      });
    }

    return res.json({ ok:true, text: answer, meta });

  }catch(e){
    return res.status(500).json({ ok:false, error: safeStr(e?.message || e), meta });
  }
}