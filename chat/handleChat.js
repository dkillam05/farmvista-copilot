// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-13-handleChat-stability-no-trim-openai-led
//
// GOAL (per Dane):
// - Do NOT trim working logic
// - Do NOT hardcode intents
// - Let OpenAI decide what to query
// - Prevent resolver traps (crop words / numeric prefixes)
// - NEVER hard-fail common farmer questions
//
// This file is intentionally verbose and defensive.

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";
import { resolveBinSiteTool, resolveBinSite } from "./resolve-binSites.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TURNS = 24;
const THREADS = new Map();

/* =========================
   Utilities
========================= */
function nowMs(){ return Date.now(); }
function safeStr(v){ return (v == null ? "" : String(v)); }
function norm(s){ return safeStr(s).trim().toLowerCase(); }
function jsonTryParse(s){ try { return JSON.parse(s); } catch { return null; } }

function isYesLike(s){
  const v = norm(s);
  return ["yes","y","yep","yeah","correct","right","ok","okay","sure"].includes(v);
}
function isNoLike(s){
  const v = norm(s);
  return ["no","n","nope","nah"].includes(v);
}

/* =========================
   Thread memory
========================= */
function pruneThreads(){
  const now = nowMs();
  for (const [k,v] of THREADS.entries()){
    if (!v?.updatedAt || (now - v.updatedAt) > TTL_MS){
      THREADS.delete(k);
    }
  }
}
function getThread(threadId){
  if (!threadId) return null;
  const cur = THREADS.get(threadId);
  if (cur && (nowMs() - (cur.updatedAt||0)) <= TTL_MS) return cur;
  const fresh = { messages:[], pending:null, updatedAt:nowMs() };
  THREADS.set(threadId,fresh);
  return fresh;
}
function pushMsg(thread, role, content){
  if (!thread) return;
  thread.messages.push({ role, content:safeStr(content) });
  if (thread.messages.length > (MAX_TURNS*2)){
    thread.messages = thread.messages.slice(-(MAX_TURNS*2));
  }
  thread.updatedAt = nowMs();
}
function setPending(thread, pending){
  if (!thread) return;
  thread.pending = pending || null;
  thread.updatedAt = nowMs();
}

/* =========================
   SQL safety
========================= */
function cleanSql(raw){
  let s = safeStr(raw||"").trim();
  s = s.replace(/;\s*$/g,"").trim();
  if (s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

/* =========================
   OpenAI
========================= */
async function openaiResponsesCreate(payload){
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

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
  if (!rsp.ok){
    throw new Error(data?.error?.message || raw || `OpenAI error ${rsp.status}`);
  }
  return data;
}

function extractFunctionCalls(json){
  return Array.isArray(json?.output)
    ? json.output.filter(x => x?.type==="function_call")
    : [];
}

function extractAssistantText(json){
  if (json?.output_text) return String(json.output_text).trim();
  const parts=[];
  for (const it of (json?.output||[])){
    if (it?.type!=="message") continue;
    for (const c of (it.content||[])){
      if (c?.type==="output_text" && c.text) parts.push(c.text.trim());
    }
  }
  return parts.join("\n").trim();
}

/* =========================
   Resolver guardrails
   (THIS fixes your field/RTK regressions)
========================= */
function shouldResolveField(query){
  if (!query) return false;
  const q = norm(query);

  // DO NOT resolve crops or pure numbers
  if (["corn","soybeans","beans","soy","wheat","milo","oats"].includes(q)) return false;
  if (/^\d+$/.test(q)) return false;

  return true;
}

/* =========================
   Tools
========================= */
function dbQueryToolDef(){
  return {
    type:"function",
    name:"db_query",
    description:"Run a read-only SQL SELECT query. Single statement only.",
    parameters:{
      type:"object",
      properties:{
        sql:{ type:"string" },
        params:{ type:"array", items:{ type:["string","number","boolean","null"] }},
        limit:{ type:"number" }
      },
      required:["sql"]
    }
  };
}

/* =========================
   System prompt (minimal, non-opinionated)
========================= */
function buildSystemPrompt(dbStatus){
  const snap = dbStatus?.snapshot?.id || "unknown";
  return `
You are FarmVista Copilot.

You decide what data to look up.
You MUST use db_query for facts.
Do NOT guess.
Do NOT show internal IDs.

Avoid resolver traps:
- Crop words are NOT field names.
- Numeric prefixes alone are NOT field names.

Grain rules:
- Bin bushels come from binSiteBins.onHandBushels.
- Grain bags are putDown rows not pickedUp.
- Bag COUNT = sum(countFull + countPartial), never row count.
- Bag BUSHELS = compute from productsGrainBags + bag data, then apply crop factors.

Snapshot: ${snap}
`.trim();
}

/* =========================
   Handler
========================= */
export async function handleChatHttp(req,res){
  try{
    pruneThreads();

    // NEVER hard-fail the whole chat on snapshot issues
    let dbStatus=null;
    try{
      await ensureDbReady({ force:false });
      dbStatus = await getDbStatus();
    }catch(e){
      // allow OpenAI to respond with partial info
      dbStatus = null;
    }

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId||"").trim();

    if (!userText){
      return res.status(400).json({ ok:false, error:"missing_text" });
    }

    const thread = getThread(threadId);

    /* ----- pending yes/no resolution ----- */
    if (thread?.pending){
      if (isYesLike(userText)){
        const top = thread.pending?.candidates?.[0];
        if (top?.name){
          userText = `${thread.pending.originalText}\nConfirmed: ${top.name}`;
        }
        thread.pending=null;
      } else if (isNoLike(userText)){
        thread.pending=null;
        return res.json({ ok:true, text:"Okay — tell me the exact name." });
      }
    }

    const input = [
      { role:"system", content: buildSystemPrompt(dbStatus) },
      ...(thread?.messages||[]),
      { role:"user", content:userText }
    ];

    const tools = [
      dbQueryToolDef(),
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

    if (Array.isArray(rsp.output)) input.push(...rsp.output);

    for (let i=0;i<10;i++){
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      for (const call of calls){
        let result=null;
        const args = jsonTryParse(call.arguments)||{};

        if (call.name==="db_query"){
          try{
            result = runSql({
              sql: cleanSql(args.sql),
              params: Array.isArray(args.params)?args.params:[],
              limit: Number.isFinite(args.limit)?args.limit:200
            });
          }catch(e){
            result = { ok:false, error:e.message };
          }
        }

        else if (call.name==="resolve_field" && shouldResolveField(args.query)){
          result = resolveField(args.query);
          if (!result?.match && result?.candidates?.length){
            setPending(thread,{
              kind:"field",
              query:args.query,
              candidates:result.candidates,
              originalText:userText
            });
            return res.json({ ok:true, text:formatDidYouMean("field",result.candidates) });
          }
        }

        else if (call.name==="resolve_farm"){
          result = resolveFarm(args.query);
        }
        else if (call.name==="resolve_rtk_tower"){
          result = resolveRtkTower(args.query);
        }
        else if (call.name==="resolve_binSite"){
          result = resolveBinSite(args.query);
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

      if (Array.isArray(rsp.output)) input.push(...rsp.output);
    }

    const text = extractAssistantText(rsp) || "Sorry, I couldn't process that request right now.";

    pushMsg(thread,"user",userText);
    pushMsg(thread,"assistant",text);

    return res.json({
      ok:true,
      text,
      meta: debugAI ? { model:OPENAI_MODEL, snapshot:dbStatus?.snapshot||null } : undefined
    });

  }catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
}