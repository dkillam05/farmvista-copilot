// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-17-debug-proof-all-domains-HTTP200d-pendingFix+memoryTopic
//
// FIXES:
// ✅ Keeps lightweight per-thread message history (so "list them" refers to prior answer)
// ✅ Tracks lastTopic based on tool calls (bin_sites / rtk / fields / grain / farms)
// ✅ Still uses OpenAI for everything, but now OpenAI has context
//
// Keeps:
// ✅ pending disambiguation Yes/1/exact-name
// ✅ HTTP 200 always with meta proof footer
// ✅ tool loop (required then auto)
// ✅ db_query schema fixed

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { grainToolDefs, grainHandleToolCall } from "./domains/grain.js";
import { fieldsToolDefs, fieldsHandleToolCall } from "./domains/fields.js";
import { farmsToolDefs, farmsHandleToolCall } from "./domains/farms.js";
import { rtkTowersToolDefs, rtkTowersHandleToolCall } from "./domains/rtkTowers.js";
import { binSitesToolDefs, binSitesHandleToolCall } from "./domains/binSites.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL   = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE    = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

/* ---------------- thread store (pending + memory) ---------------- */
const TTL_MS = 12 * 60 * 60 * 1000;
const THREADS = new Map();
const MAX_MSGS = 20;

function nowMs(){ return Date.now(); }

function getThread(threadId){
  const tid = String(threadId || "").trim();
  if (!tid) return null;

  const cur = THREADS.get(tid);
  if (cur && (nowMs() - (cur.updatedAt || 0)) <= TTL_MS) return cur;

  const fresh = { pending: null, messages: [], lastTopic: "", updatedAt: nowMs() };
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

function pushThreadMsg(thread, role, content){
  if (!thread) return;
  const c = String(content ?? "").trim();
  if (!c) return;
  thread.messages.push({ role, content: c });
  if (thread.messages.length > MAX_MSGS) thread.messages = thread.messages.slice(-MAX_MSGS);
  thread.updatedAt = nowMs();
}

function setLastTopicFromTool(thread, toolName){
  if (!thread) return;
  const n = String(toolName || "");
  let topic = "";
  if (n.startsWith("bin_sites_")) topic = "bin_sites";
  else if (n.startsWith("rtk_") || n.startsWith("rtk_tower") || n.startsWith("rtk_towers_")) topic = "rtk";
  else if (n.startsWith("field_") || n.startsWith("fields_")) topic = "fields";
  else if (n.startsWith("grain_") || n.startsWith("grain_bags_")) topic = "grain";
  else if (n.startsWith("farm_") || n.startsWith("farms_")) topic = "farms";
  if (topic) thread.lastTopic = topic;
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

  const mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (mNum){
    const n = parseInt(mNum[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= Math.min(8, candidates.length)) return candidates[n - 1] || null;
  }

  const exact = candidates.find(c => safeStr(c?.name).trim().toLowerCase() === t.toLowerCase());
  if (exact) return exact;

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
    binSitesHandleToolCall(name, args) ||
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

    // Always store user message for context
    pushThreadMsg(thread, "user", textRaw);

    /* ==========================================================
       ✅ PENDING DISAMBIGUATION HANDLER
    ========================================================== */
    if (thread?.pending?.kind && Array.isArray(thread.pending.candidates) && thread.pending.candidates.length){
      const pend = thread.pending;
      const cands = pend.candidates;

      if (isNoLike(textRaw)){
        setPending(thread, null);
        const msg = "Okay — tell me the exact name you meant.";
        pushThreadMsg(thread, "assistant", msg);
        return respond(res, true, msg, meta);
      }

      let picked = null;
      if (isYesLike(textRaw)) picked = cands[0] || null;
      else picked = pickCandidateFromReply(textRaw, cands.slice(0, 8));

      if (picked?.id || picked?.name){
        setPending(thread, null);

        if (pend.kind === "field"){
          const out = fieldsHandleToolCall("field_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["field_profile(direct)"];
          thread.lastTopic = "fields";
          if (out?.ok && out.text) {
            pushThreadMsg(thread, "assistant", out.text);
            return respond(res, true, out.text, meta);
          }
          const msg = "Could not load that field profile.";
          pushThreadMsg(thread, "assistant", msg);
          return respond(res, false, msg, meta, "pending_field_profile_failed");
        }

        if (pend.kind === "rtk tower"){
          const out = rtkTowersHandleToolCall("rtk_tower_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["rtk_tower_profile(direct)"];
          thread.lastTopic = "rtk";
          if (out?.ok && out.text) {
            pushThreadMsg(thread, "assistant", out.text);
            return respond(res, true, out.text, meta);
          }
          const msg = "Could not load that RTK tower profile.";
          pushThreadMsg(thread, "assistant", msg);
          return respond(res, false, msg, meta, "pending_rtk_profile_failed");
        }

        if (pend.kind === "farm"){
          const out = farmsHandleToolCall("farm_profile", { query: safeStr(picked.id || picked.name) });
          meta.usedOpenAI = false;
          meta.toolsCalled = ["farm_profile(direct)"];
          thread.lastTopic = "farms";
          if (out?.ok && out.text) {
            pushThreadMsg(thread, "assistant", out.text);
            return respond(res, true, out.text, meta);
          }
          const msg = "Could not load that farm profile.";
          pushThreadMsg(thread, "assistant", msg);
          return respond(res, false, msg, meta, "pending_farm_profile_failed");
        }
      }
      // else fall through to OpenAI
    }

    const system = `
You are FarmVista Copilot.

HARD RULES:
- You MUST call at least one tool to answer every user message.
- Prefer domain tools first. Use db_query only if needed.
- If a tool returns candidates, ask the user to confirm.
- Return concise results. Do not mention internal IDs.

Context:
- last_topic=${safeStr(thread?.lastTopic || "")}
`.trim();

    const tools = [
      ...grainToolDefs(),
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      ...binSitesToolDefs(),
      dbQueryToolDef()
    ];

    // Include lightweight history so "list them" stays on-topic
    const input = [
      { role:"system", content: system },
      ...(Array.isArray(thread?.messages) ? thread.messages.slice(-MAX_MSGS) : []),
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

    for (let iter = 0; iter < 12; iter++){
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      for (const call of calls){
        const name = safeStr(call?.name);
        const args = jsonTry(call?.arguments) || {};
        meta.toolsCalled.push(name);
        setLastTopicFromTool(thread, name);

        let result = dispatchDomainTool(name, args);

        if (result && result.ok === false && Array.isArray(result.candidates) && result.candidates.length){
          const kind =
            name.startsWith("field_") ? "field" :
            (name.startsWith("rtk_") || name.startsWith("rtk_tower") || name.startsWith("rtk_towers_")) ? "rtk tower" :
            name.startsWith("farm_") ? "farm" :
            "item";

          setPending(thread, { kind, candidates: result.candidates, originalText: textRaw });
          const msg = formatDidYouMean(kind, result.candidates);
          pushThreadMsg(thread, "assistant", msg);
          return respond(res, true, msg, meta);
        }

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
      const msg = "OpenAI returned no final text. See meta.toolsCalled.";
      pushThreadMsg(thread, "assistant", msg);
      return respond(res, false, msg, meta, "no_final_text_from_openai");
    }

    pushThreadMsg(thread, "assistant", answer);
    return respond(res, true, answer, meta);

  }catch(e){
    const msg = safeStr(e?.message || e);
    if (msg.toLowerCase().includes("missing openai_api_key")) meta.usedOpenAI = false;
    pushThreadMsg(getThread(safeStr(req.body?.threadId || "").trim()), "assistant", `Backend error: ${msg}`);
    return respond(res, false, `Backend error: ${msg}`, meta, msg);
  }
}