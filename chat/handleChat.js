// /chat/handleChat.js
// Rev: 2026-01-12-handleChat-full-stable-openai-led
//
// GOALS (DO NOT BREAK):
// - OpenAI decides what to look up
// - Resolvers are fallback only
// - Conversation context is preserved
// - No intent trees
// - No trimming of existing working behavior
//
// FIXES:
// - Grain bags counted correctly (full + partial)
// - Grain bag bushels calculated correctly (corn baseline + crop factors)
// - NULL / empty status treated as DOWN
// - RTK tower follow-ups work (no re-resolve traps)

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";
import { resolveBinSiteTool, resolveBinSite } from "./resolve-binSites.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL   = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE    = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

const TTL_MS   = 12 * 60 * 60 * 1000;
const MAX_TURNS = 24;
const THREADS  = new Map();

/* ----------------------- utilities ----------------------- */
function nowMs(){ return Date.now(); }
function safeStr(v){ return v == null ? "" : String(v); }
function norm(s){ return safeStr(s).trim().toLowerCase(); }
function jsonTryParse(s){ try{ return JSON.parse(s); } catch{ return null; } }

function pruneThreads(){
  const now = nowMs();
  for(const [k,v] of THREADS.entries()){
    if(!v?.updatedAt || (now - v.updatedAt) > TTL_MS) THREADS.delete(k);
  }
}
function getThread(id){
  if(!id) return null;
  const cur = THREADS.get(id);
  if(cur && (nowMs() - (cur.updatedAt||0)) <= TTL_MS) return cur;
  const fresh = { messages:[], pending:null, updatedAt:nowMs() };
  THREADS.set(id, fresh);
  return fresh;
}
function pushMsg(thread, role, content){
  if(!thread) return;
  thread.messages.push({ role, content:safeStr(content) });
  if(thread.messages.length > MAX_TURNS*2){
    thread.messages = thread.messages.slice(-MAX_TURNS*2);
  }
  thread.updatedAt = nowMs();
}

/* ---------------- SQL safety ---------------- */
function cleanSql(raw){
  let s = safeStr(raw).trim();
  s = s.replace(/;\s*$/g,"").trim();
  if(s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

/* ---------------- OpenAI ---------------- */
async function openaiResponsesCreate(payload){
  const rsp = await fetch(`${OPENAI_BASE}/responses`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body:JSON.stringify(payload)
  });
  const raw = await rsp.text();
  const data = jsonTryParse(raw);
  if(!rsp.ok) throw new Error(data?.error?.message || raw);
  return data;
}
function extractFunctionCalls(r){
  return Array.isArray(r?.output) ? r.output.filter(x=>x?.type==="function_call") : [];
}
function extractAssistantText(r){
  if(r?.output_text) return r.output_text.trim();
  const out=[];
  for(const m of (r?.output||[])){
    if(m?.type==="message"){
      for(const c of (m.content||[])){
        if(c?.type==="output_text" && c.text) out.push(c.text.trim());
      }
    }
  }
  return out.join("\n").trim();
}

/* ---------------- system prompt ---------------- */
function buildSystemPrompt(dbStatus){
  return `
You are FarmVista Copilot.

You are OpenAI-led. Decide what to query and how.
Resolvers are fallback only.

DO NOT re-resolve entities already discussed in this conversation.

ACTIVE:
- Active fields: archived IS NULL OR archived = 0

GRAIN BAGS (HARD RULES):
- DOWN bag =
  type='putDown'
  AND (status IS NULL OR status='' OR lower(status)<>'pickedup')

- Bag count = SUM(countFull) + SUM(countPartial)
- NEVER count rows as bags

GRAIN BAG BUSHELS:
- Baseline: productsGrainBags.bushelsCorn
- Partial bags use partialFeetSum / lengthFt
- Apply crop factors:
  corn 1.00
  soybeans 0.93
  wheat 1.07
  milo 1.02
  oats 0.78

RTK TOWERS:
- Always JOIN rtkTowers when RTK info is requested

SQL:
- Single SELECT only
- No semicolons

DB snapshot: ${dbStatus?.snapshot?.id || "unknown"}
`.trim();
}

/* ---------------- tools ---------------- */
const dbQueryTool = {
  type:"function",
  name:"db_query",
  description:"Run a single SELECT query against the snapshot database.",
  parameters:{
    type:"object",
    properties:{
      sql:{type:"string"},
      params:{type:"array"},
      limit:{type:"number"}
    },
    required:["sql"]
  }
};

/* ---------------- handler ---------------- */
export async function handleChatHttp(req,res){
  try{
    pruneThreads();
    await ensureDbReady({force:false});
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    const userText = safeStr(body.text || body.message || body.q).trim();
    const threadId = safeStr(body.threadId).trim();
    if(!userText) return res.status(400).json({ok:false,error:"missing_text"});

    const thread = getThread(threadId);

    const input = [
      {role:"system", content:buildSystemPrompt(dbStatus)},
      ...(thread?.messages||[]),
      {role:"user", content:userText}
    ];

    const tools = [
      dbQueryTool,
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool,
      resolveBinSiteTool
    ];

    let rsp = await openaiResponsesCreate({
      model:OPENAI_MODEL,
      tools,
      tool_choice:"auto",
      input,
      temperature:0.2
    });

    if(Array.isArray(rsp.output)) input.push(...rsp.output);

    for(let i=0;i<10;i++){
      const calls = extractFunctionCalls(rsp);
      if(!calls.length) break;

      for(const call of calls){
        let result=null;
        if(call.name==="db_query"){
          try{
            result = runSql({
              sql: cleanSql(call.arguments?.sql || ""),
              params: call.arguments?.params || [],
              limit: call.arguments?.limit || 200
            });
          }catch(e){
            result = {ok:false,error:e.message};
          }
        }else if(call.name==="resolve_field"){
          result = resolveField(call.arguments?.query||"");
        }else if(call.name==="resolve_farm"){
          result = resolveFarm(call.arguments?.query||"");
        }else if(call.name==="resolve_rtk_tower"){
          result = resolveRtkTower(call.arguments?.query||"");
        }else if(call.name==="resolve_binSite"){
          result = resolveBinSite(call.arguments?.query||"");
        }

        input.push({
          type:"function_call_output",
          call_id:call.call_id,
          output:JSON.stringify(result||{})
        });
      }

      rsp = await openaiResponsesCreate({
        model:OPENAI_MODEL,
        tools,
        tool_choice:"auto",
        input,
        temperature:0.2
      });

      if(Array.isArray(rsp.output)) input.push(...rsp.output);
    }

    const text = extractAssistantText(rsp) || "No answer.";

    if(thread){
      pushMsg(thread,"user",userText);
      pushMsg(thread,"assistant",text);
    }

    return res.json({ok:true,text,meta:{snapshot:dbStatus?.snapshot||null}});

  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}