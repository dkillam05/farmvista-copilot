// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-15-handleChat-sqlFirst40-bushelCommit-bagCtx-noStatus
//
// FIX (per Dane, HARD):
// ✅ MANDATORY COMMIT RULE:
//    If grain bag rows exist AND user asks for bushels -> MUST compute bushels
//    (JOIN productsGrainBags + partial-feet math + crop factor). No early exits.
//
// FIX (per Dane, HARD):
// ✅ DO NOT rely on ANY "status" concept for grain bags.
//    - Prefer v_grainBag_open_remaining for "bags down now" and bushels now.
//    - If the view isn't present, use grain bag events + appliedTo pickup logic (already in snapshot-build.js).
//    - Never say "no bushel data available" if bag rows exist.
//
// FIX (critical):
// ✅ Carry context across turns for "those 46 bags" followups:
//    - If assistant previously reported "X <crop> grain bags", store that in thread.
//    - If user then asks "how many bushels are in those X bags", force the model to compute bushels
//      for that same crop (and year if present).
//
// ALSO KEEPS (do not trim):
// ✅ OpenAI-led (no routing/intent trees)
// ✅ SQL sanitizer
// ✅ did-you-mean pending + yes/no + numeric/prefix selection
// ✅ RTK field-prefix guardrail (0964/0505)
// ✅ view preference v_grainBag_open_remaining when available
// ✅ grain bag bushel math rules (productsGrainBags join + crop factors)
// ✅ chatbot aliases + crop normalize
// ✅ global ask-back fallback contract (never "No answer")

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

  const grainish = t.includes("grain bag") || t.includes("grain bags") || (t.includes("grain") && t.includes("bag")) || t.includes("field bag") || t.includes("field bags");
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
  return ["yes", "y", "yep", "yeah", "correct", "right", "ok", "okay", "sure"].includes(v);
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
    pending: null,      // { kind, query, candidates:[{id,name,score?}], originalText }
    lastTowerName: "",
    lastBagCtx: null,   // { cropType, cropYear, bagCount }
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

// --- SQL sanitizer ---
function cleanSql(raw) {
  let s = safeStr(raw || "").trim();
  s = s.replace(/;\s*$/g, "").trim();
  if (s.includes(";")) throw new Error("multi_statement_sql_not_allowed");
  return s;
}

// -------- OpenAI wrapper --------
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

========================
GLOBAL FALLBACK UX CONTRACT (HARD)
========================
- NEVER respond with: "No answer", "not available", "could not be retrieved", or empty.
- If you are uncertain OR your first query returns 0 rows OR it looks mismatched:
  1) Ask a short clarifying question (1 sentence).
  2) Provide a short option list (up to 5) pulled from the DB using tools.
- If user asks a broad storage question like "in storage" / "how much do I have":
  ask: "Do you mean bins, field bags, or total (bins + bags)?"
- If cropYear matters (grain bags) and multiple cropYear values exist for that crop,
  ask which year (or all years) BEFORE final totals.

========================
CHATBOT ALIASES (USE THESE)
========================
Crop aliases:
${cropAliasLines}

========================
GRAIN BAGS — NO STATUS (HARD)
========================
Do NOT rely on ANY "status" concept to decide if bags are down.
For "bags down right now" and "bushels in bags right now", prefer:
- v_grainBag_open_remaining

If view is unavailable, use:
- grainBagEvents with pickups accounted via appliedTo logic (already built in snapshot).

========================
GRAIN BAGS — HARD BAG COUNT RULE
========================
- If the user asks "How many grain bags..." they ALWAYS mean TOTAL BAGS (full+partial), not entry rows.
- TOTAL BAGS = SUM(COALESCE(remainingFull,0)) + SUM(COALESCE(remainingPartial,0)) (prefer the VIEW)
- Only talk about entry rows if user explicitly says: entries / events / rows / records.

========================
GRAIN BAGS → FIELD LINK (HARD)
========================
- Grain bags ARE tied to fields through grain bag data.
- For questions like "what fields are the bags in?":
  Use bag data (preferred v_grainBag_open_remaining.fieldName), GROUP BY fieldName.
  Do NOT resolve fields via resolve_field.

========================
GRAIN BAG BUSHELS — REQUIRED MATH (HARD)
========================
When user asks for BUSHELS in grain bags, you MUST compute.

Preferred source:
- v_grainBag_open_remaining(cropType,cropYear,bagSkuId,remainingFull,remainingPartial,remainingPartialFeetSum,fieldName)

You MUST JOIN productsGrainBags:
- productsGrainBags(id, bushelsCorn, lengthFt)

Compute CORN-rated bushels:
- fullCornBu = remainingFull * bushelsCorn
- partialCornBu = (remainingPartialFeetSum / lengthFt) * bushelsCorn
- totalCornBu = fullCornBu + partialCornBu

Apply crop factor:
- corn 1.00, soybeans 0.93, wheat 1.07, milo 1.02, oats 0.78
- totalBu = totalCornBu * cropFactor

MANDATORY COMMIT RULE (HARD):
- If qualifying rows exist (row count > 0), you MUST return a numeric bushel total.
- Returning 0/null/"not available" is ONLY allowed when row count = 0.

========================
RTK TOWERS — IMPORTANT
========================
- When user asks RTK tower info for a FIELD:
  1) Resolve/select the field
  2) Read fields.rtkTowerId
  3) JOIN rtkTowers by id to get name, networkId, frequency

- If user provides numeric field prefix like "0964":
  treat as prefix for field.name (0964-...)

Avoid resolver traps:
- Do NOT treat crop words like "corn" or "soybeans" as field/farm names.

========================
GRAIN BUSHELS
========================
Bins:
- SUM(binSiteBins.onHandBushels) filter by lower(lastCropType)=lower(crop)

Field grain bags:
- Use grain bag bushels math above

SQL tool rule:
- db_query must be a SINGLE statement with NO semicolons.

DB snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}
`.trim();
}

// best-effort: capture last tower name from assistant output
function captureLastTowerNameFromAssistant(text) {
  const t = safeStr(text);
  let m = t.match(/tower[^.\n]*?\bis named\s+"([^"]+)"\b/i);
  if (m && m[1]) return m[1].trim();
  m = t.match(/rtk tower[^.\n]*?\b([A-Za-z0-9][A-Za-z0-9 \-']{2,})\b/i);
  if (m && m[1]) return m[1].trim();
  return "";
}

// capture: "I found 46 corn grain bags..." -> {bagCount:46, cropType:"corn"}
function captureLastBagCtxFromAssistant(text) {
  const s = safeStr(text || "");
  if (!s) return null;

  // Examples handled:
  // "I found 46 corn grain bags currently down"
  // "There are 12 soybeans grain bags down"
  // "Found 9 wheat bags down"
  const re = /\b(?:found|there are|i found)\s+(\d{1,6})\s+([a-z]+)\s+(?:grain\s+)?bags?\b/i;
  const m = s.match(re);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const crop = (m[2] || "").trim().toLowerCase();
  if (!Number.isFinite(n) || n < 0) return null;
  if (!crop) return null;

  // only accept known crops (aliases already normalized in many cases)
  const known = ["corn", "soybeans", "wheat", "milo", "oats"];
  if (!known.includes(crop)) return null;

  return { bagCount: n, cropType: crop, cropYear: null };
}

function userAsksTowerDetails(text) {
  const t = norm(text);
  return (t.includes("network") || t.includes("frequency") || t.includes("freq") || t.includes("net id") || t.includes("network id"));
}

function pickCandidateFromUserReply(userText, candidates) {
  const t = safeStr(userText).trim();

  const mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (mNum) {
    const n = parseInt(mNum[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= Math.min(8, candidates.length)) return candidates[n - 1] || null;
  }

  const prefix = t.toLowerCase();
  if (prefix && prefix.length >= 3) {
    const hit = candidates.find(c => safeStr(c?.name).toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }

  const exact = candidates.find(c => safeStr(c?.name).trim().toLowerCase() === prefix.toLowerCase());
  if (exact) return exact;

  return null;
}

// RTK+Field prefix guardrail
function looksLikeRtkFieldPrefix(text) {
  const t = norm(text);
  if (!t.includes("rtk")) return null;
  if (!t.includes("field")) return null;
  const m = t.match(/\bfield\s*[:#]?\s*(\d{3,5})\b/);
  if (!m) return null;
  const prefix = m[1];
  if (t.includes(`${prefix}-`)) return null;
  return prefix;
}

function findFieldsByPrefix(prefix) {
  const sql = `
    SELECT id, name, rtkTowerId, rtkTowerName
    FROM fields
    WHERE name LIKE ?
    ORDER BY name
    LIMIT 8
  `;
  return runSql({ sql, params: [`${prefix}-%`], limit: 8 });
}

function isEmptyOrNoAnswer(text) {
  const t = safeStr(text).trim();
  if (!t) return true;
  const low = t.toLowerCase();
  if (low === "no answer.") return true;
  if (low === "no answer") return true;
  return false;
}

/* =====================================================================
   ✅ BUSHEL COMMIT ENFORCEMENT (TINY, NOT A ROUTING TREE)
===================================================================== */
function userAsksBagBushels(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;

  const hasBushelWord = /\bbushels?\b/.test(t);
  const hasBu = /\bbu\b/.test(t) || /\bbu\.\b/.test(t);
  if (!(hasBushelWord || hasBu)) return false;

  const bagContext = t.includes("bag") && (t.includes("grain") || t.includes("field") || t.includes("bags") || t.includes("those"));
  return !!bagContext;
}

function userAsksGroupedByField(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return (
    t.includes("by field") ||
    t.includes("grouped by field") ||
    t.includes("per field") ||
    t.includes("each field") ||
    (t.includes("fields") && (t.includes("bushel") || /\bbu\b/.test(t)))
  );
}

function assistantHasBushelNumber(text) {
  const s = safeStr(text);
  if (!s) return false;
  const re = /\b\d[\d,]*\.?\d*\s*(bu|bushels?)\b/i;
  return re.test(s);
}

function sqlLooksLikeBagRows(sqlLower) {
  if (!sqlLower) return false;
  return (
    sqlLower.includes("v_grainbag_open_remaining") ||
    sqlLower.includes("grainbagevents")
  );
}

function sqlLooksLikeProductsJoin(sqlLower) {
  if (!sqlLower) return false;
  return (
    sqlLower.includes("productsgrainbags") ||
    sqlLower.includes("bushelscorn") ||
    sqlLower.includes("lengthft")
  );
}

function userReferencesThoseBags(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return t.includes("those") && t.includes("bag");
}

function extractExplicitBagNumber(text) {
  const t = (text || "").toString().toLowerCase();
  const m = t.match(/\bthose\s+(\d{1,6})\s+bags?\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
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

    // pending disambiguation
    if (thread && thread.pending) {
      const pend = thread.pending;
      const cands = Array.isArray(pend.candidates) ? pend.candidates : [];

      if (isYesLike(userText)) {
        const top = cands[0] || null;
        if (top?.id && top?.name) {
          userText = `${pend.originalText}\n\nUser confirmed: ${top.name} (id=${top.id}). Use that.`;
          thread.pending = null;
          thread.updatedAt = nowMs();
        }
      } else if (isNoLike(userText)) {
        thread.pending = null;
        thread.updatedAt = nowMs();
        return res.json({
          ok: true,
          text: "Okay — tell me the exact name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      } else {
        const pick = pickCandidateFromUserReply(userText, cands.slice(0, 8));
        if (pick?.id && pick?.name && pend.originalText) {
          userText = `${pend.originalText}\n\nUser selected: ${pick.name} (id=${pick.id}). Use that.`;
          thread.pending = null;
          thread.updatedAt = nowMs();
        }
      }
    }

    // Carry "those 46 bags" context across turns (NO STATUS; must compute bushels)
    if (thread && thread.lastBagCtx && userReferencesThoseBags(userTextRaw)) {
      const n = extractExplicitBagNumber(userTextRaw);
      // If user said "those 46 bags", attach the crop context we previously captured.
      // This does not route; it just removes ambiguity.
      if (!n || n === thread.lastBagCtx.bagCount) {
        userText = [
          userText,
          "",
          `IMPORTANT CONTEXT: The user is referring to the previously mentioned ${thread.lastBagCtx.bagCount} ${thread.lastBagCtx.cropType} grain bags.`,
          `Compute BUSHELS for those bags using v_grainBag_open_remaining + JOIN productsGrainBags + partial-feet math + crop factor. Do NOT use or mention any status concept.`,
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
          if (thread) {
            setPending(thread, { kind: "field", query: prefix, candidates, originalText: safeStr(body.text || body.message || body.q || "").trim() });
          }
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
      resolveBinSiteTool
    ];

    const wantsBagBushels = userAsksBagBushels(userTextRaw) || userAsksBagBushels(userText);
    const wantsGroupedByField = userAsksGroupedByField(userTextRaw) || userAsksGroupedByField(userText);
    let sawQualifyingBagRows = false;
    let sawProductsJoinEvidence = false;

    // First call (OpenAI-led)
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
              if (!sawProductsJoinEvidence && sqlLooksLikeProductsJoin(sqlLower)) {
                sawProductsJoinEvidence = true;
              }
            } catch {}
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }

        } else if (name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "field", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("field", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "farm", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("farm", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "rtk tower", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("rtk tower", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "bin site", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("bin site", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }
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

    /* =====================================================================
       ✅ MANDATORY BUSHEL COMMIT (ENFORCEMENT PASS)
    ===================================================================== */
    if (wantsBagBushels && sawQualifyingBagRows && !assistantHasBushelNumber(text)) {
      input_list.push({
        role: "user",
        content: [
          "MANDATORY COMMIT RULE ENFORCEMENT:",
          "You have qualifying grain bag rows (rowCount > 0). The user asked for BUSHELS.",
          "Do NOT stop after bag counts. You MUST compute and return numeric bushel totals by completing the full bag bushel pipeline:",
          "- Prefer v_grainBag_open_remaining when available (remainingFull, remainingPartialFeetSum, cropType, cropYear, bagSkuId, fieldName).",
          "- JOIN productsGrainBags to get (bushelsCorn, lengthFt).",
          "- Compute corn-rated bushels (full + partial feet) then apply crop factor.",
          "- Return a numeric total in bushels (bu).",
          wantsGroupedByField ? "- ALSO group by fieldName and return bushels per field (and a grand total)." : "",
          "",
          "HARD: Do NOT rely on or mention any status concept. Use the view or appliedTo math.",
          "Use db_query as needed."
        ].filter(Boolean).join("\n")
      });

      let rspB = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "required",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rspB.output)) input_list.push(...rspB.output);

      for (let i = 0; i < 10; i++) {
        const calls = extractFunctionCalls(rspB);
        if (!calls.length) break;

        let didAny = false;

        for (const call of calls) {
          const name = safeStr(call?.name);
          const args = jsonTryParse(call.arguments) || {};
          let result = null;

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
                if (!sawProductsJoinEvidence && sqlLooksLikeProductsJoin(sqlLower)) {
                  sawProductsJoinEvidence = true;
                }
              } catch {}
            } catch (e) {
              result = { ok: false, error: e?.message || String(e) };
            }

          } else if (name === "resolve_field") {
            didAny = true;
            result = resolveField(safeStr(args.query || ""));
            if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
              if (thread) setPending(thread, { kind: "field", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
              return res.json({ ok: true, text: formatDidYouMean("field", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
            }

          } else if (name === "resolve_farm") {
            didAny = true;
            result = resolveFarm(safeStr(args.query || ""));
            if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
              if (thread) setPending(thread, { kind: "farm", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
              return res.json({ ok: true, text: formatDidYouMean("farm", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
            }

          } else if (name === "resolve_rtk_tower") {
            didAny = true;
            result = resolveRtkTower(safeStr(args.query || ""));
            if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
              if (thread) setPending(thread, { kind: "rtk tower", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
              return res.json({ ok: true, text: formatDidYouMean("rtk tower", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
            }

          } else if (name === "resolve_binSite") {
            didAny = true;
            result = resolveBinSite(safeStr(args.query || ""));
            if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
              if (thread) setPending(thread, { kind: "bin site", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
              return res.json({ ok: true, text: formatDidYouMean("bin site", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
            }
          }

          input_list.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result ?? { ok: false, error: "no_result" })
          });
        }

        if (!didAny) break;

        rspB = await openaiResponsesCreate({
          model: OPENAI_MODEL,
          tools,
          tool_choice: "auto",
          input: input_list,
          temperature: 0.2
        });

        if (Array.isArray(rspB.output)) input_list.push(...rspB.output);
      }

      const tb = extractAssistantText(rspB);
      if (tb) text = tb;
    }

    // ONE SAFE RETRY: ask-back behavior only if empty/no-answer
    if (isEmptyOrNoAnswer(text)) {
      input_list.push({
        role: "user",
        content: "You returned no answer. Follow GLOBAL FALLBACK UX CONTRACT: ask one clarifying question and show up to 5 DB-backed options. Do not refuse."
      });

      let rsp2 = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "required",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp2.output)) input_list.push(...rsp2.output);

      for (let i = 0; i < 6; i++) {
        const calls = extractFunctionCalls(rsp2);
        if (!calls.length) break;

        for (const call of calls) {
          if (safeStr(call?.name) !== "db_query") continue;
          const args = jsonTryParse(call.arguments) || {};
          let result;
          try {
            const sql = cleanSql(args.sql || "");
            result = runSql({
              sql,
              params: Array.isArray(args.params) ? args.params : [],
              limit: Number.isFinite(args.limit) ? args.limit : 50
            });
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }
          input_list.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result)
          });
        }

        rsp2 = await openaiResponsesCreate({
          model: OPENAI_MODEL,
          tools,
          tool_choice: "auto",
          input: input_list,
          temperature: 0.2
        });

        if (Array.isArray(rsp2.output)) input_list.push(...rsp2.output);
      }

      const t2 = extractAssistantText(rsp2);
      if (t2) text = t2;
    }

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