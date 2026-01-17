// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-16h-handleChat-domainsSimple-autoPickSingle-noDYMloop
//
// Goal: keep handleChat BORING.
// - Domains do the real work (fields/grain/rtk/farms).
// - handleChat only does: thread/pending, tiny prefix guardrail, OpenAI tool loop, dispatch tools.
// - Disambiguation ONLY when >1 choice; auto-pick single.
// - No "did-you-mean" loops (confirm resolves directly via domain tool, no OpenAI).

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";
import { resolveBinSiteTool, resolveBinSite } from "./resolve-binSites.js";

import { fieldsToolDefs, fieldsHandleToolCall, looksLikeRtkFieldPrefix, findFieldsByPrefix } from "./domains/fields.js";
import { farmsToolDefs, farmsHandleToolCall } from "./domains/farms.js";
import { rtkTowersToolDefs, rtkTowersHandleToolCall, userAsksTowerDetails } from "./domains/rtkTowers.js";
import {
  grainToolDefs,
  grainHandleToolCall,
  userReferencesThoseBags,
  extractExplicitBagNumber,
  userAsksBagBushels,
  userAsksGroupedByField,
  assistantHasBushelNumber,
  sqlLooksLikeBagRows,
  sqlLooksLikeCapacityChain
} from "./domains/grain.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TURNS = 24;
const THREADS = new Map();

/* ---------------- small utils ---------------- */
function nowMs() { return Date.now(); }
function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(v) { return safeStr(v).trim().toLowerCase(); }
function jsonTryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function isYesLike(s) { return ["yes","y","yea","yep","yeah","ok","okay","sure","correct","right"].includes(norm(s)); }
function isNoLike(s) { return ["no","n","nope","nah"].includes(norm(s)); }

function cleanSql(raw) {
  let s = safeStr(raw || "").trim();
  s = s.replace(/;\s*$/g, "").trim();
  if (s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

function formatDidYouMean(kind, candidates) {
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push("");
  lines.push(`Reply with the exact name, say "yes" to pick the first one, or reply with the option number (1–8).`);
  return lines.join("\n");
}

/* ---------------- crop alias normalize (tiny) ---------------- */
const CROP_ALIAS = new Map([
  ["corn","corn"],["kern","corn"],["cornn","corn"],["maize","corn"],
  ["soybeans","soybeans"],["soy","soybeans"],["beans","soybeans"],["sb","soybeans"],["soys","soybeans"],
  ["wheat","wheat"],["hrw","wheat"],["srw","wheat"],
  ["milo","milo"],["sorghum","milo"],
  ["oats","oats"]
]);

function normalizeUserText(userText) {
  const s = safeStr(userText);
  if (!s) return s;
  const parts = s.split(/(\b)/);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || !/^[A-Za-z]+$/.test(tok)) continue;
    const low = tok.toLowerCase();
    const canon = CROP_ALIAS.get(low);
    if (canon && canon !== low) parts[i] = canon;
  }
  return parts.join("");
}

function looksLikeBagCountQuestion(text) {
  const t = norm(text);
  if (!t.includes("how many")) return false;
  if (!t.includes("bag")) return false;
  const grainish = t.includes("grain") || t.includes("grain bag") || t.includes("grain bags") || t.includes("field bag") || t.includes("field bags");
  if (!grainish) return false;
  const entryWords = ["entry","entries","event","events","row","rows","record","records","putdown event","put down event"];
  for (const w of entryWords) if (t.includes(w)) return false;
  return true;
}

function rewriteBagCountQuestion(userText) {
  if (!looksLikeBagCountQuestion(userText)) return userText;
  return `${userText}\n\nIMPORTANT: interpret as TOTAL BAGS (full + partial), NOT entry rows.`;
}

/* ---------------- threads ---------------- */
function pruneThreads() {
  const now = nowMs();
  for (const [k, v] of THREADS.entries()) {
    if (!v?.updatedAt || (now - v.updatedAt) > TTL_MS) THREADS.delete(k);
  }
}

function getThread(threadId) {
  if (!threadId) return null;
  const cur = THREADS.get(threadId);
  if (cur && (nowMs() - (cur.updatedAt || 0)) <= TTL_MS) return cur;

  const fresh = {
    messages: [],
    pending: null, // { kind, candidates:[{id,name}], originalText }
    lastTowerName: "",
    lastBagCtx: null,
    updatedAt: nowMs()
  };
  THREADS.set(threadId, fresh);
  return fresh;
}

function pushMsg(thread, role, content) {
  if (!thread) return;
  thread.messages.push({ role, content: safeStr(content) });
  if (thread.messages.length > (MAX_TURNS * 2)) thread.messages = thread.messages.slice(-MAX_TURNS * 2);
  thread.updatedAt = nowMs();
}

function setPending(thread, pending) {
  if (!thread) return;
  thread.pending = pending || null;
  thread.updatedAt = nowMs();
}

/* ---------------- OpenAI ---------------- */
async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });

  const raw = await rsp.text();
  const data = jsonTryParse(raw);
  if (!rsp.ok) throw new Error(data?.error?.message || raw || `OpenAI error (${rsp.status})`);
  return data;
}

function extractFunctionCalls(responseJson) {
  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return items.filter(it => it && it.type === "function_call");
}

function extractAssistantText(responseJson) {
  const direct = safeStr(responseJson?.output_text || "").trim();
  if (direct) return direct;

  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const parts = [];
  for (const it of items) {
    if (it?.type !== "message") continue;
    const content = Array.isArray(it.content) ? it.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        const t = c.text.trim();
        if (t) parts.push(t);
      }
    }
  }
  return parts.join("\n").trim();
}

/* ---------------- dispatch ---------------- */
function dispatchDomainTool(name, args) {
  let r = null;
  r = grainHandleToolCall(name, args); if (r) return r;
  r = fieldsHandleToolCall(name, args); if (r) return r;
  r = farmsHandleToolCall(name, args); if (r) return r;
  r = rtkTowersHandleToolCall(name, args); if (r) return r;
  return null;
}

function directResolveFromPending(pend, picked) {
  const kind = norm(pend?.kind || "");
  const idOrName = safeStr(picked?.id || picked?.name).trim();
  if (!idOrName) return null;

  if (kind === "field") return fieldsHandleToolCall("field_profile", { query: idOrName });
  if (kind === "farm") return farmsHandleToolCall("farm_profile", { query: idOrName });
  if (kind.includes("tower") || kind === "rtk") return rtkTowersHandleToolCall("rtk_tower_profile", { query: idOrName });

  return null;
}

function pickCandidateFromReply(userText, candidates) {
  const t = safeStr(userText).trim();

  const mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (mNum) {
    const n = parseInt(mNum[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= Math.min(8, candidates.length)) return candidates[n - 1] || null;
  }

  const exact = candidates.find(c => safeStr(c?.name).trim().toLowerCase() === t.toLowerCase());
  if (exact) return exact;

  const prefix = t.toLowerCase();
  if (prefix && prefix.length >= 3) {
    const hit = candidates.find(c => safeStr(c?.name).toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }

  return null;
}

function dbQueryToolDef() {
  return {
    type: "function",
    name: "db_query",
    description: "Run a read-only SQL SELECT query against the FarmVista SQLite snapshot database. Single statement only; do not include semicolons.",
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

function buildSystemPrompt(dbStatus) {
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  return `
You are FarmVista Copilot.
Use domain tools first (fields/grain/rtk/farms). Use db_query only if needed.
Ask follow-ups ONLY when there is more than one real choice.
Never answer "0" for grain bags unless all crop years are 0.
Snapshot: ${snapshotId}
`.trim();
}

/* =====================================================================
   HTTP handler
===================================================================== */
export async function handleChatHttp(req, res) {
  try {
    pruneThreads();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    const userTextRaw = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();
    if (!userTextRaw) return res.status(400).json({ ok: false, error: "missing_text" });

    let userText = rewriteBagCountQuestion(normalizeUserText(userTextRaw));
    const thread = getThread(threadId);

    /* ----- pending: only ask if >1; auto-pick 1; resolve immediately ----- */
    if (thread && thread.pending) {
      const pend = thread.pending;
      const cands = Array.isArray(pend.candidates) ? pend.candidates : [];

      if (cands.length === 1) {
        const picked = cands[0];
        thread.pending = null;
        thread.updatedAt = nowMs();
        const out = directResolveFromPending(pend, picked);
        if (out?.ok && out.text) return res.json({ ok: true, text: out.text, meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
        userText = safeStr(picked.name || picked.id);
      } else {
        if (isNoLike(userText)) {
          thread.pending = null;
          thread.updatedAt = nowMs();
          return res.json({ ok: true, text: "Okay — tell me the exact name you meant.", meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
        }

        const picked = isYesLike(userText) ? (cands[0] || null) : pickCandidateFromReply(userText, cands.slice(0, 8));
        if (picked?.id || picked?.name) {
          thread.pending = null;
          thread.updatedAt = nowMs();
          const out = directResolveFromPending(pend, picked);
          if (out?.ok && out.text) return res.json({ ok: true, text: out.text, meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
          userText = safeStr(picked.name || picked.id);
        }
      }
    }

    /* ----- grain "those bags" context helper (kept) ----- */
    if (thread && thread.lastBagCtx && userReferencesThoseBags(userTextRaw)) {
      const n = extractExplicitBagNumber(userTextRaw);
      if (!n || n === thread.lastBagCtx.bagCount) {
        userText = [
          userText,
          "",
          `IMPORTANT: user refers to previous ${thread.lastBagCtx.cropType} grain bags.`,
          `Prefer tool grain_bags_bushels_now with cropType=${thread.lastBagCtx.cropType}.`
        ].join("\n");
      }
    }

    /* ----- RTK field prefix guardrail: only ask if >1 ----- */
    const prefix = looksLikeRtkFieldPrefix(userText);
    if (prefix) {
      try {
        const r = findFieldsByPrefix(prefix);
        const rows = Array.isArray(r?.rows) ? r.rows : [];
        if (rows.length === 1) {
          const exactName = safeStr(rows[0].name);
          userText = userText.replace(new RegExp(`\\bfield\\s*[:#]?\\s*${prefix}\\b`, "i"), `field ${exactName}`);
        } else if (rows.length > 1) {
          const candidates = rows.map(x => ({ id: safeStr(x.id), name: safeStr(x.name) }));
          setPending(thread, { kind: "field", query: prefix, candidates, originalText: userTextRaw });
          return res.json({ ok: true, text: formatDidYouMean("field", candidates), meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
        }
      } catch {}
    }

    /* ----- tower follow-up helper (kept) ----- */
    if (thread && thread.lastTowerName && userAsksTowerDetails(userText)) {
      const t = norm(userText);
      if (!t.includes("tower") && !t.includes(thread.lastTowerName.toLowerCase())) {
        userText = `User is asking about RTK tower "${thread.lastTowerName}".\n\n${userText}`;
      }
    }

    const system = buildSystemPrompt(dbStatus);
    const input_list = [
      { role: "system", content: system },
      ...(thread?.messages || []),
      { role: "user", content: userText }
    ];

    const tools = [
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      ...grainToolDefs(),
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool,
      resolveBinSiteTool,
      dbQueryToolDef()
    ];

    const wantsBagBushels = userAsksBagBushels(userTextRaw) || userAsksBagBushels(userText);
    let sawQualifyingBagRows = false;

    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    for (let i = 0; i < 10; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let didAny = false;

      for (const call of calls) {
        const name = safeStr(call?.name);
        const args = jsonTryParse(call.arguments) || {};
        let result = null;

        // domain tools first
        result = dispatchDomainTool(name, args);

        // fallback tools
        if (!result && name === "db_query") {
          didAny = true;
          try {
            const sql = cleanSql(args.sql || "");
            const sqlLower = sql.toLowerCase();
            result = runSql({
              sql,
              params: Array.isArray(args.params) ? args.params : [],
              limit: Number.isFinite(args.limit) ? args.limit : 200
            });
            try {
              const rows = Array.isArray(result?.rows) ? result.rows : [];
              if (!sawQualifyingBagRows && rows.length > 0 && sqlLooksLikeBagRows(sqlLower)) sawQualifyingBagRows = true;
              if (sqlLooksLikeCapacityChain(sqlLower)) { /* no-op */ }
            } catch {}
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }
        } else if (!result && name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
        } else if (!result && name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
        } else if (!result && name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
        } else if (!result && name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
        }

        if (result) didAny = true;

        // resolver candidate UX (only ask if >1)
        if (name === "resolve_field" && result && !result.match && Array.isArray(result.candidates) && result.candidates.length) {
          if (result.candidates.length === 1) {
            const one = result.candidates[0];
            const out = fieldsHandleToolCall("field_profile", { query: safeStr(one.id || one.name) });
            if (out?.ok && out.text) return res.json({ ok: true, text: out.text, meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
          }
          setPending(thread, { kind: "field", query: safeStr(args.query || ""), candidates: result.candidates, originalText: userTextRaw });
          return res.json({ ok: true, text: formatDidYouMean("field", result.candidates), meta: debugAI ? { usedOpenAI: false, snapshot: dbStatus?.snapshot || null } : undefined });
        }

        input_list.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result ?? { ok: false, error: "no_result" })
        });
      }

      if (!didAny) break;

      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "required",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    let text = extractAssistantText(rsp) || "";
    if (!text.trim()) text = "Tell me what you meant and I’ll pull it up.";

    // keep your existing bushel enforcement logic if you have it elsewhere;
    // here we only ensure we never return empty.
    if (wantsBagBushels && sawQualifyingBagRows && !assistantHasBushelNumber(text)) {
      // no-op here; handled by your existing grain domain + prompt rules
    }

    // save convo
    if (thread) {
      pushMsg(thread, "user", userTextRaw);
      pushMsg(thread, "assistant", text);

      const m = text.match(/RTK Tower:\s*\n- Name:\s*(.+)$/mi);
      if (m && m[1]) thread.lastTowerName = safeStr(m[1]).trim();

      thread.updatedAt = nowMs();
    }

    return res.json({
      ok: true,
      text,
      meta: debugAI ? { usedOpenAI: true, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}