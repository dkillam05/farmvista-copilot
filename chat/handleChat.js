// /chat/handleChat.js
// Rev: 2026-01-16-FINAL
//
// handleChat does NOTHING except:
// - load DB
// - force OpenAI to call a tool
// - return tool output

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { grainToolDefs, grainHandleToolCall } from "./domains/grain.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_BASE    = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function jsonTry(s){ try{return JSON.parse(s);}catch{return null;} }

async function openai(payload){
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

export async function handleChatHttp(req,res){
  try{
    await ensureDbReady();
    const dbStatus = await getDbStatus();

    const text = String(req.body?.text || "").trim();
    if(!text) return res.status(400).json({ok:false,error:"missing_text"});

    const system = `
You are FarmVista Copilot.
You MUST call exactly one tool to answer.
You MUST NOT answer in plain text.
Always use grain_bags_entry for grain questions.
`.trim();

    const input = [
      { role:"system", content: system },
      { role:"user", content: text }
    ];

    const rsp = await openai({
      model: OPENAI_MODEL,
      tools: grainToolDefs(),
      tool_choice: "required",
      input
    });

    const call = rsp.output?.find(o=>o.type==="function_call");
    if(!call) throw new Error("No tool call");

    const result = grainHandleToolCall(call.name, jsonTry(call.arguments));
    if(!result?.ok) throw new Error("Tool failed");

    return res.json({
      ok:true,
      text: result.text,
      meta:{ snapshot: dbStatus.snapshot }
    });

  }catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
}