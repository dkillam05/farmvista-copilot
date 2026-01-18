// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-17-debug-proof-always-all-domains-HTTP200b
//
// FIX:
// ✅ db_query schema is now valid (params has items).
// ✅ Always returns HTTP 200 JSON with meta (so UI always shows OpenAI footer).
//
// Everything else unchanged.

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
        // ✅ FIX: array must declare items
        params: {
          type: "array",
          items: { type: ["string", "number", "boolean", "null"] }
        },
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

function respond(res, ok, text, meta, errorMsg){
  const payload = { ok: !!ok, text: safeStr(text || "").trim(), meta: meta || {} };
  if (errorMsg) payload.error = safeStr(errorMsg);
  return res.status(200).json(payload);
}

export async function handleChatHttp(req,res){
  const meta = {
    usedOpenAI: true,
    provider: "OpenAI",
    model: OPENAI_MODEL,
    toolsCalled: [],
    dbQueryUsed: false,
    snapshot: null,
    route: "/chat"
  };

  try{
    await ensureDbReady();
    const dbStatus = await getDbStatus();
    meta.snapshot = dbStatus?.snapshot || null;

    const text = safeStr(req.body?.text || "").trim();
    if(!text) {
      meta.usedOpenAI = false;
      return respond(res, false, "Missing message text.", meta, "missing_text");
    }

    const system = `
You are FarmVista Copilot.

HARD RULES:
- You MUST call at least one tool to answer every user message.
- You MUST NOT answer directly in plain text without tool output.
- Prefer domain tools (grain/fields/farms/rtk). Use db_query only if needed.

Return concise results. Do not mention internal IDs.
`.trim();

    const tools = [
      ...grainToolDefs(),
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      dbQueryToolDef()
    ];

    const input = [
      { role:"system", content: system },
      { role:"user", content: text }
    ];

    let rsp = await openai({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input,
      temperature: 0.2
    });

    const toolInput = [...input];
    if (Array.isArray(rsp.output)) toolInput.push(...rsp.output);

    for (let iter = 0; iter < 12; iter++){
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      for (const call of calls){
        const name = safeStr(call?.name);
        const args = jsonTry(call?.arguments) || {};
        meta.toolsCalled.push(name);

        let result = null;

        try {
          result = dispatchDomainTool(name, args);
        } catch (e) {
          result = { ok:false, error:`domain_error:${safeStr(e?.message || e)}` };
        }

        if (!result && name === "db_query"){
          meta.dbQueryUsed = true;
          try {
            const sql = cleanSql(args.sql || "");
            result = runSql({
              sql,
              params: Array.isArray(args.params) ? args.params : [],
              limit: Number.isFinite(args.limit) ? args.limit : 200
            });
          } catch (e) {
            result = { ok:false, error:`db_query_error:${safeStr(e?.message || e)}` };
          }
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
      return respond(
        res,
        false,
        "OpenAI returned no final text. Check meta.toolsCalled for what it attempted.",
        meta,
        "no_final_text_from_openai"
      );
    }

    return respond(res, true, answer, meta);

  }catch(e){
    const msg = safeStr(e?.message || e);

    if (msg.toLowerCase().includes("missing openai_api_key")) {
      meta.usedOpenAI = false;
    }

    return respond(res, false, `Backend error: ${msg}`, meta, msg);
  }
}