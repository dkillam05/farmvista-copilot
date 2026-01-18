// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-17-debug-proof-all-domains-HTTP200d-pendingFix
//
// FIX (critical):
// ✅ Implements server-side pending disambiguation per client threadId.
//    - If a domain tool returns candidates, we store pending and return "Did you mean".
//    - If user replies Yes / number / exact name, we resolve immediately to the correct domain tool.
// ✅ Prevents "Yes" from being interpreted as a new unrelated question (grain bags, etc.).
//
// Keeps:
// ✅ OpenAI tools loop
// ✅ HTTP 200 always (frontend keeps meta + proof footer)
// ✅ meta.toolsCalled + dbQueryUsed + snapshot
// ✅ Domains still own logic; handleChat only orchestrates.

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

/* ---------------- thread store (pending) ---------------- */
const TTL_MS = 12 * 60 * 60 * 1000;
const THREADS = new Map();

function nowMs(){ return Date.now(); }

function getThread(threadId){
  const tid = String(threadId || "").trim();
  if (!tid) return null;

  const cur = THREADS.get(tid);
  if (cur && (nowMs() - (cur.updatedAt || 0)) <= TTL_MS) return cur;

  const fresh = { pending: null, updatedAt: nowMs() };
  THREADS.set(tid, fresh);
  return fresh;
}

function pruneThreads(){
  const now = nowMs();
  for (const [k, v] of THREADS.entries()){
    if (!v?.updatedAt || (now - v.updatedAt) > TTL_MS) THREADS.delete(k);
  }
}

function setPending(thread, pending){
  if (!thread) return;
  thread.pending = pending || null;
  thread.updatedAt = nowMs();
}

/* ---------------- basics ---------------- */
function jsonTry(s){ try { return JSON.parse(s); } catch { return null; } }
function safeStr(v){ return (v == null ? "" : String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }

function isYesLike(s){
  return ["yes","y","yea","yep","yeah","ok","okay","sure","correct","right"].includes(norm(s));
}
function isNoLike(s){
  return ["no","n","nope","nah"].includes(norm(s));
}

function pickCandidateFromReply(text, candidates){
  const t = safeStr(text).trim();

  // number selection
  const mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (mNum){
    const n = parseInt(mNum[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= Math.min(8, candidates.length)) return candidates[n - 1] || null;
  }

  // exact name
  const exact = candidates.find(c => safeStr(c?.name).trim().toLowerCase() === t.toLowerCase());
  if (exact) return exact;

  // prefix
  const pref = t.toLowerCase();
  if (pref && pref.length >= 3){
    const hit = candidates.find(c => safeStr(c?.name).toLowerCase().startsWith(pref));
    if (hit) return hit;
  }

  return null;
}

function formatDidYouMean(kind, candidates){
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push("");
  lines.push(`Reply with "yes" to pick the first one, or reply with the option number (1–8), or type the exact name.`);
  return lines.join("\n");
}

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

/* ---------------- tools ---------------- */
function dbQueryToolDef(){
  return {
    type: "function",
    name: "db_query",
    description: "Read-only SQL SELECT query against the FarmVista SQLite snapshot. Single statement only; no semicolons.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
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

/* =====================================================================
   HTTP handler
===================================================================== */
export async function handleChatHttp(req,res){
  pruneThreads();

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

    const textRaw = safeStr(req.body?.text || "").trim();
    const threadId = safeStr(req.body?.threadId || "").trim();
    const thread = getThread(threadId);

    if(!textRaw) {
      meta.usedOpenAI = false;
      return respond(res, false, "Missing message text.", meta, "missing_text");
    }

    /* ==========================================================
       ✅ PENDING DISAMBIGUATION HANDLER (THIS FIXES YOUR BUG)
       If user says Yes after a did-you-mean, resolve immediately.
    ========================================================== */
    if (thread?.pending?.kind && Array.isArray(thread.pending.candidates) && thread.pending.candidates.length){
      const pend = thread.pending;
      const cands = pend.candidates;

      if (isNoLike(textRaw)){
        setPending(thread, null);
        return respond(res, true, "Okay — tell me the exact name you meant.", meta);
      }

      let picked = null;
      if (isYesLike(textRaw)) picked = cands[0] || null;
      else picked = pickCandidateFromReply(textRaw, cands.slice(0, 8));

      if (picked?.id || picked?.name){
        setPending(thread, null);

        // Resolve directly via the domain tool that triggered the pending
        if (pend.kind === "field"){
          const out = fieldsHandleToolCall("field_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["field_profile(direct)"];
          if (out?.ok && out.text) return respond(res, true, out.text, meta);
          return respond(res, false, "Could not load that field profile.", meta, "pending_field_profile_failed");
        }

        if (pend.kind === "rtk tower"){
          const out = rtkTowersHandleToolCall("rtk_tower_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["rtk_tower_profile(direct)"];
          if (out?.ok && out.text) return respond(res, true, out.text, meta);
          return respond(res, false, "Could not load that RTK tower profile.", meta, "pending_rtk_profile_failed");
        }

        if (pend.kind === "farm"){
          const out = farmsHandleToolCall("farm_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["farm_profile(direct)"];
          if (out?.ok && out.text) return respond(res, true, out.text, meta);
          return respond(res, false, "Could not load that farm profile.", meta, "pending_farm_profile_failed");
        }
      }

      // If user typed something else, fall through to OpenAI as a new question
    }

    const system = `
You are FarmVista Copilot.

HARD RULES:
- You MUST call at least one tool to answer every user message.
- Prefer domain tools (grain/fields/farms/rtk). Use db_query only if needed.
- Return concise results. Do not mention internal IDs.

IMPORTANT:
- If a tool returns candidates (ambiguous), ask the user to confirm.
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
      { role:"user", content: textRaw }
    ];

    // First call MUST use tools
    let rsp = await openai({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input,
      temperature: 0.2
    });

    const toolInput = [...input];
    if (Array.isArray(rsp.output)) toolInput.push(...rsp.output);

    // Tool loop
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

        // If a domain tool returns candidates, store pending and return prompt immediately
        if (result && result.ok === false && Array.isArray(result.candidates) && result.candidates.length){
          const kind =
            name.startsWith("field_") ? "field" :
            name.startsWith("rtk_") ? "rtk tower" :
            name.startsWith("farm_") ? "farm" :
            "item";

          setPending(thread, { kind, candidates: result.candidates, originalText: textRaw });

          return respond(res, true, formatDidYouMean(kind, result.candidates), meta);
        }

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

      // Allow final text
      rsp = await openai({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "auto",
        input: toolInput,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) toolInput.push(...rsp.output);
    }

    const answer = extractAssistantText(rsp);
    if (!answer) {
      return respond(res, false, "OpenAI returned no final text. See meta.toolsCalled.", meta, "no_final_text_from_openai");
    }

    return respond(res, true, answer, meta);

  }catch(e){
    const msg = safeStr(e?.message || e);
    if (msg.toLowerCase().includes("missing openai_api_key")) meta.usedOpenAI = false;
    return respond(res, false, `Backend error: ${msg}`, meta, msg);
  }
}