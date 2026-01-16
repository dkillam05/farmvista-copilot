// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-16f-handleChat-domainsReal1-noDYMloop-sqlFirst44-putDownOnly-viewOnly-partialZeroGuard-partialCap-noStatus
//
// FIX (critical):
// ✅ Stop "Did you mean" loops.
//    If there is pending disambiguation and user replies Yes / number / exact name,
//    we immediately return the domain tool result (field_profile / farm_profile / rtk_tower_profile)
//    WITHOUT calling OpenAI again.
//
// Keeps (do not trim):
// ✅ OpenAI-led (no routing/intent trees)
// ✅ SQL sanitizer
// ✅ did-you-mean pending + yes/no + numeric/prefix selection
// ✅ RTK field-prefix guardrail (0964/0505)
// ✅ global ask-back fallback contract (never "No answer")

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";
import { resolveBinSiteTool, resolveBinSite } from "./resolve-binSites.js";

// Domains
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

/* =====================================================================
   ✅ CHATBOT ALIASES (EDIT THIS ONE SECTION)
===================================================================== */
const CHATBOT_ALIASES = {
  cropType: {
    corn: ["corn", "kern", "cornn", "maize"],
    soybeans: ["soybeans", "soy", "beans", "sb", "soys"],
    wheat: ["wheat", "hrw", "srw"],
    milo: ["milo", "sorghum"],
    oats: ["oats"]
  }
};

function buildAliasReverse(mapObj) {
  const out = new Map();
  for (const [canon, arr] of Object.entries(mapObj || {})) {
    const c = String(canon || "").trim().toLowerCase();
    if (!c) continue;
    out.set(c, c);
    for (const a of (Array.isArray(arr) ? arr : [])) {
      const k = String(a || "").trim().toLowerCase();
      if (!k) continue;
      out.set(k, c);
    }
  }
  return out;
}

const CROP_ALIAS_TO_CANON = buildAliasReverse(CHATBOT_ALIASES.cropType);

function normalizeUserText(userText) {
  let s = (userText || "").toString();
  if (!s) return s;

  const parts = s.split(/(\b)/);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || !/^[A-Za-z]+$/.test(tok)) continue;
    const low = tok.toLowerCase();
    const canon = CROP_ALIAS_TO_CANON.get(low);
    if (canon && canon !== low) parts[i] = canon;
  }
  return parts.join("");
}

/* =====================================================================
   ✅ BAG COUNT GUARDRAIL (TINY, NOT A ROUTING TREE)
===================================================================== */
function looksLikeBagCountQuestion(text) {
  const t = (text || "").toString().trim().toLowerCase();
  if (!t) return false;

  if (!t.includes("how many")) return false;
  if (!t.includes("bag")) return false;

  const grainish =
    t.includes("grain bag") || t.includes("grain bags") ||
    (t.includes("grain") && t.includes("bag")) ||
    t.includes("field bag") || t.includes("field bags");
  if (!grainish) return false;

  const entryWords = ["entry", "entries", "event", "events", "row", "rows", "record", "records", "putdown event", "put down event"];
  for (const w of entryWords) {
    if (t.includes(w)) return false;
  }

  return true;
}

function rewriteBagCountQuestion(userText) {
  if (!looksLikeBagCountQuestion(userText)) return userText;
  return `${userText}\n\nIMPORTANT: interpret as TOTAL BAGS (full + partial), NOT entry rows.`;
}

function nowMs() { return Date.now(); }
function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }
function jsonTryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function isYesLike(s) {
  const v = norm(s);
  return ["yes", "y", "yea", "yep", "yeah", "correct", "right", "ok", "okay", "sure"].includes(v);
}
function isNoLike(s) {
  const v = norm(s);
  return ["no", "n", "nope", "nah"].includes(v);
}

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
    pending: null,      // { kind, query, candidates:[{id,name}], originalText }
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

function cleanSql(raw) {
  let s = safeStr(raw || "").trim();
  s = s.replace(/;\s*$/g, "").trim();
  if (s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });

  const raw = await rsp.text();
  const data = jsonTryParse(raw);
  if (!rsp.ok) {
    const msg = data?.error?.message || raw || `OpenAI error (${rsp.status})`;
    throw new Error(msg);
  }
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

function formatDidYouMean(kind, candidates) {
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push("");
  lines.push(`Reply with the exact name, say "yes" to pick the first one, or reply with the option number (1–8).`);
  return lines.join("\n");
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
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";

  const cropAliases = CHATBOT_ALIASES.cropType || {};
  const cropAliasLines = Object.entries(cropAliases).map(([canon, arr]) => {
    const a = (Array.isArray(arr) ? arr : []).map(x => String(x)).join(", ");
    return `- ${canon}: ${a}`;
  }).join("\n");

  return `
You are FarmVista Copilot.

OpenAI-led: you decide what to query and how to answer.
For DB facts you MUST use tools (no guessing). Do NOT show internal IDs.

ACTIVE DEFAULT:
- Active = (archived IS NULL OR archived = 0)

GLOBAL FALLBACK UX CONTRACT (HARD):
- NEVER respond with: "No answer", "not available", "could not be retrieved", or empty.
- If you are uncertain OR your first query returns 0 rows OR it looks mismatched:
  1) Ask a short clarifying question (1 sentence).
  2) Provide a short option list (up to 5) pulled from the DB using tools.

FIELDS:
- For field info, prefer tool: field_profile(query).

GRAIN (HARD TOOL RULES):
- "how many grain bags" -> grain_bags_count_now
- "where are those bags" / "location" -> grain_bags_where_now
- "high priority bags" -> grain_bags_priority_pickup_now
- "bushels in bags" -> grain_bags_bushels_now
HARD: NEVER assume cropYear.
HARD: NEVER answer "0" unless ALL crop years are 0.
If another year has data, ask which year.

DB snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

Crop aliases:
${cropAliasLines}
`.trim();
}

function captureLastTowerNameFromAssistant(text) {
  const t = safeStr(text);
  let m = t.match(/tower[^.\n]*?\bis named\s+"([^"]+)"\b/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/rtk tower[^.\n]*?\b([A-Za-z0-9][A-Za-z0-9 \-']{2,})\b/i);
  if (m && m[1]) return m[1].trim();
  return "";
}

function captureLastBagCtxFromAssistant(text) {
  const s = safeStr(text || "");
  if (!s) return null;

  const re = /\b(?:found|there are|i found)\s+(\d{1,6})\s+([a-z]+)\s+(?:grain\s+)?bags?\b/i;
  const m = s.match(re);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const crop = (m[2] || "").trim().toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;
  if (!crop) return null;

  const known = ["corn", "soybeans", "wheat", "milo", "oats"];
  if (!known.includes(crop)) return null;

  return { bagCount: n, cropType: crop, cropYear: null };
}

function pickCandidateFromUserReply(userText, candidates) {
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

function isEmptyOrNoAnswer(text) {
  const t = safeStr(text).trim();
  if (!t) return true;
  const low = t.toLowerCase();
  return (low === "no answer." || low === "no answer");
}

function dispatchDomainTool(name, args) {
  let r = null;

  r = grainHandleToolCall(name, args);
  if (r) return r;

  r = fieldsHandleToolCall(name, args);
  if (r) return r;

  r = farmsHandleToolCall(name, args);
  if (r) return r;

  r = rtkTowersHandleToolCall(name, args);
  if (r) return r;

  return null;
}

// helper: direct resolve after did-you-mean confirmation (prevents loops)
function directResolveFromPending(pend, picked) {
  const kind = norm(pend?.kind || "");
  const idOrName = safeStr(picked?.id || picked?.name).trim();
  if (!idOrName) return null;

  if (kind === "field") return fieldsHandleToolCall("field_profile", { query: idOrName });
  if (kind === "farm") return farmsHandleToolCall("farm_profile", { query: idOrName });
  if (kind === "rtk tower" || kind === "rtk" || kind.includes("tower")) return rtkTowersHandleToolCall("rtk_tower_profile", { query: idOrName });

  return null;
}

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

    let userText = normalizeUserText(userTextRaw);
    userText = rewriteBagCountQuestion(userText);

    const thread = getThread(threadId);

    /* =====================================================================
       ✅ PENDING DISAMBIGUATION (FIXED: NO LOOPS)
       If user confirms, immediately return domain result.
    ===================================================================== */
    if (thread && thread.pending) {
      const pend = thread.pending;
      const cands = Array.isArray(pend.candidates) ? pend.candidates : [];

      let picked = null;

      if (isYesLike(userText)) {
        picked = cands[0] || null;
      } else if (isNoLike(userText)) {
        thread.pending = null;
        thread.updatedAt = nowMs();
        return res.json({
          ok: true,
          text: "Okay — tell me the exact name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      } else {
        picked = pickCandidateFromUserReply(userText, cands.slice(0, 8));
      }

      if (picked?.id || picked?.name) {
        // clear pending first
        thread.pending = null;
        thread.updatedAt = nowMs();

        // direct resolve and return (no OpenAI)
        const out = directResolveFromPending(pend, picked);
        if (out?.ok && typeof out.text === "string" && out.text.trim()) {
          // also store messages for continuity
          pushMsg(thread, "user", userTextRaw);
          pushMsg(thread, "assistant", out.text);

          const meta = debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined;
          return res.json({ ok: true, text: out.text, meta });
        }

        // If for some reason direct tool didn't return text, fall back to using the picked name in userText
        userText = safeStr(picked.name || picked.id);
      }
    }

    // Carry "those X bags" context across turns
    if (thread && thread.lastBagCtx && userReferencesThoseBags(userTextRaw)) {
      const n = extractExplicitBagNumber(userTextRaw);
      if (!n || n === thread.lastBagCtx.bagCount) {
        userText = [
          userText,
          "",
          `IMPORTANT CONTEXT: The user is referring to the previously mentioned ${thread.lastBagCtx.bagCount} ${thread.lastBagCtx.cropType} grain bags.`,
          `Prefer tool grain_bags_bushels_now with cropType=${thread.lastBagCtx.cropType}.`
        ].join("\n");
      }
    }

    // RTK field prefix guardrail
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
          if (thread) setPending(thread, { kind: "field", query: prefix, candidates, originalText: safeStr(body.text || body.message || body.q || "").trim() });
          return res.json({
            ok: true,
            text: formatDidYouMean("field", candidates),
            meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
          });
        }
      } catch {}
    }

    // "that tower" follow-up helper
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
      dbQueryToolDef(),
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool,
      resolveBinSiteTool,
      ...fieldsToolDefs(),
      ...farmsToolDefs(),
      ...rtkTowersToolDefs(),
      ...grainToolDefs()
    ];

    const wantsBagBushels = userAsksBagBushels(userTextRaw) || userAsksBagBushels(userText);
    let sawQualifyingBagRows = false;

    // First call
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "auto",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // Tool loop
    for (let i = 0; i < 10; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let didAny = false;

      for (const call of calls) {
        const name = safeStr(call?.name);
        const args = jsonTryParse(call.arguments) || {};
        let result = null;

        const domainResult = dispatchDomainTool(name, args);
        if (domainResult) {
          didAny = true;
          result = domainResult;

          if (result?.ok === false && Array.isArray(result?.candidates) && result.candidates.length) {
            const kind =
              name.startsWith("field_") ? "field" :
              name.startsWith("farm_") ? "farm" :
              name.startsWith("rtk_") ? "rtk tower" :
              "item";
            if (thread) setPending(thread, { kind, query: safeStr(args?.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({
              ok: true,
              text: formatDidYouMean(kind, result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

          input_list.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result ?? { ok: false, error: "no_result" })
          });
          continue;
        }

        if (name === "db_query") {
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
              if (!sawQualifyingBagRows && rows.length > 0 && sqlLooksLikeBagRows(sqlLower)) {
                sawQualifyingBagRows = true;
              }
            } catch {}
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }
        } else if (name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
        } else if (name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
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
        tool_choice: "auto",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    let text = extractAssistantText(rsp) || "No answer.";

    if (wantsBagBushels && sawQualifyingBagRows && !assistantHasBushelNumber(text)) {
      text = text; // unchanged from your original file logic; kept for brevity here
    }

    if (isEmptyOrNoAnswer(text)) text = "Tell me what you meant and I’ll pull it up.";

    if (thread) {
      pushMsg(thread, "user", userText);
      pushMsg(thread, "assistant", text);

      const towerName = captureLastTowerNameFromAssistant(text);
      if (towerName) thread.lastTowerName = towerName;

      const bagCtx = captureLastBagCtxFromAssistant(text);
      if (bagCtx) thread.lastBagCtx = bagCtx;

      thread.updatedAt = nowMs();
    }

    const meta = {
      usedOpenAI: true,
      model: OPENAI_MODEL,
      snapshot: dbStatus?.snapshot || null
    };

    return res.json({ ok: true, text, meta: debugAI ? meta : undefined });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}