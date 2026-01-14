// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-13-handleChat-sqlFirst37-bagcount-never-rows-askback
//
// FIX (per Dane, HARD):
// ✅ "How many grain bags..." NEVER means entry rows. It ALWAYS means total BAGS (full+partial).
// ✅ Force this by (1) system prompt hard rule + (2) tiny userText rewrite guardrail (no routing trees).
//
// ALSO KEEPS (do not trim):
// ✅ OpenAI-led (no routing/intent trees)
// ✅ SQL sanitizer
// ✅ did-you-mean pending + yes/no + numeric/prefix selection
// ✅ RTK field-prefix guardrail (0964/0505)
// ✅ grain bag DOWN definition with NULL/empty status included
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
   - If user says "how many ... grain bags" we force interpretation as BAG COUNT (full+partial),
     never event/entry rows.
   - User can still ask for entries by saying: "how many bag entries" or "how many putDown events".
===================================================================== */
function looksLikeBagCountQuestion(text) {
  const t = (text || "").toString().trim().toLowerCase();
  if (!t) return false;

  // Must be a "how many" count style question + mention bags
  if (!t.includes("how many")) return false;
  if (!t.includes("bag")) return false;

  // Must refer to grain bags (or just "bags" with grain context)
  const grainish = t.includes("grain bag") || t.includes("grain bags") || (t.includes("grain") && t.includes("bag")) || t.includes("field bag") || t.includes("field bags");
  if (!grainish) return false;

  // If they explicitly ask for entries/events/rows/records, do NOT rewrite.
  const entryWords = ["entry", "entries", "event", "events", "row", "rows", "record", "records", "putdown event", "put down event"];
  for (const w of entryWords) {
    if (t.includes(w)) return false;
  }

  return true;
}

function rewriteBagCountQuestion(userText) {
  if (!looksLikeBagCountQuestion(userText)) return userText;
  // Minimal clarification appended; does not change meaning, only removes ambiguity.
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
- If cropYear matters (grainBagEvents) and multiple cropYear values exist for that crop,
  ask which year (or all years) BEFORE final totals.

========================
CHATBOT ALIASES (USE THESE)
========================
When user uses slang/typos, treat as canonical.
For SQL crop filters, use case-insensitive IN lists.

Crop aliases:
${cropAliasLines}

========================
GRAIN BAGS — HARD DEFINITIONS (DO NOT GUESS)
========================

DOWN BAG definition (matches our real data):
- A bag is DOWN if:
  type = 'putDown'
  AND (status IS NULL OR status = '' OR lower(status) <> 'pickedup')

HARD BAG COUNT RULE (THIS IS NOT AMBIGUOUS):
- If the user asks "How many grain bags..." they ALWAYS mean TOTAL BAGS,
  not event/entry rows.
- TOTAL BAGS = SUM(COALESCE(countFull,0)) + SUM(COALESCE(countPartial,0))
- Only talk about entry rows if user explicitly says: entries / events / rows / records.

IMPORTANT: Grain bags DO have crop info:
- grainBagEvents.cropType exists
- grainBagEvents.cropYear exists
- v_grainBag_open_remaining.cropType exists (if the view exists)

Prefer the view when available:
- v_grainBag_open_remaining gives remainingFull/remainingPartial after pickups.
- Prefer it for: bags still down / bags by field / bags by crop / bushels in bags right now.

========================
GRAIN BAG BUSHELS — REQUIRED MATH
========================
When user asks for BUSHELS in grain bags, you MUST compute bag bushels.

Preferred source (if view exists):
- v_grainBag_open_remaining(cropType,cropYear,bagSkuId,remainingFull,remainingPartial,remainingPartialFeetSum)

Fallback source:
- grainBagEvents(cropType,cropYear,bagSkuId,countFull,countPartial,partialFeetSum) with DOWN BAG definition

You MUST JOIN productsGrainBags to get capacity:
- productsGrainBags(id, bushelsCorn, lengthFt)

Compute CORN-rated bushels:
- fullCornBu = remainingFull * bushelsCorn
- partialCornBu = (remainingPartialFeetSum / lengthFt) * bushelsCorn
- totalCornBu = fullCornBu + partialCornBu

Apply crop factor (grain-capacity.js):
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

    // normalize slang/typos for chatbot only
    let userText = normalizeUserText(userTextRaw);

    // HARD: rewrite bag-count questions so the model cannot interpret as entry rows
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
            result = runSql({
              sql,
              params: Array.isArray(args.params) ? args.params : [],
              limit: Number.isFinite(args.limit) ? args.limit : 200
            });
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

    // ONE SAFE RETRY: force ask-back behavior if model still returns empty/no-answer
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

      // Run db_query tool calls from retry
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
      if (towerName) {
        thread.lastTowerName = towerName;
        thread.updatedAt = nowMs();
      }
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