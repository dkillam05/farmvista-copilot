// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-12-handleChat-sqlFirst32-fix-didyoumean-numeric-that-tower-bagdown
//
// Fixes (NO routing/intent trees; keeps your working flow):
// ✅ Grain bag DOWN definition uses NULL/empty status correctly (matches your real data)
// ✅ Prefer v_grainBag_open_remaining when available (bags still down / bags by field / bag bushels)
// ✅ "Did you mean" follow-up now supports:
//    - "yes" (first option)
//    - option number ("1", "2", etc.)
//    - prefix match ("0964") for options like "0964-Cinda 105"
// ✅ "that tower" follow-up: if last assistant message named a tower, and user asks network/frequency,
//    we bias the next turn toward that RTK tower (without hard-coded intents).
// ✅ Keeps: SQL sanitizer, empty-response retry, pending did-you-mean, resolvers, OpenAI-led behavior.

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

  // add a couple slots for follow-up coreference (no new files)
  const fresh = {
    messages: [],
    pending: null,           // { kind, query, candidates:[{id,name,score}], originalText }
    lastTowerName: "",       // last RTK tower named by assistant
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

// --- SQL sanitizer (fixes "multi-statement" false positives) ---
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

  return `
You are FarmVista Copilot.

OpenAI-led: you decide what to query and how to answer.
For DB facts you MUST use tools (no guessing). Do NOT show internal IDs.

Active fields:
- Active = (archived IS NULL OR archived = 0)

========================
GRAIN BAGS — HARD DEFINITIONS (DO NOT GUESS)
========================

DOWN BAG definition (matches our real data):
- A bag is DOWN if:
  type = 'putDown'
  AND (status IS NULL OR status = '' OR lower(status) <> 'pickedup')

Bag counting rules:
- Total bags down (full + partial) =
  SUM(COALESCE(countFull,0)) + SUM(COALESCE(countPartial,0))
- NEVER count rows as bags.

Prefer the view when available:
- v_grainBag_open_remaining gives remainingFull/remainingPartial after pickups.
- Prefer it for:
  - "bags still down"
  - "bags by field"
  - "bushels in bags right now"

========================
GRAIN BUSHELS
========================

Bins:
- Bin bushels: SUM(binSiteBins.onHandBushels), filter by lower(lastCropType)=lower(crop).

Field grain bags:
- Compute rated CORN bushels from productsGrainBags + bag data, then apply grain-capacity factors.
- Factors: corn 1.00, soybeans 0.93, wheat 1.07, milo 1.02, oats 0.78.

Avoid resolver traps:
- Do NOT treat crop words like "corn" or "soybeans" as field/farm names.
- Use resolvers only when user clearly refers to a field/farm/tower/bin site by name.

SQL tool rule:
- db_query must be a SINGLE statement with NO semicolons.

DB snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}
`.trim();
}

// Try to capture the last tower name from assistant output (best-effort).
function captureLastTowerNameFromAssistant(text) {
  const t = safeStr(text);
  // common phrasing: '... tower ... is named "Sharpsburg".'
  let m = t.match(/tower[^.\n]*?\bis named\s+"([^"]+)"\b/i);
  if (m && m[1]) return m[1].trim();

  // alternate: '... tower ... is Sharpsburg.'
  m = t.match(/tower[^.\n]*?\bis\s+"?([A-Za-z0-9][A-Za-z0-9 \-']{2,})"?\b/i);
  if (m && m[1]) {
    const name = m[1].trim();
    // avoid capturing generic words
    if (!/assigned|associated|information|details|network|frequency/i.test(name)) return name;
  }
  return "";
}

function userAsksTowerDetails(text) {
  const t = norm(text);
  // minimal: only for network/frequency follow-ups
  return (
    t.includes("network") ||
    t.includes("frequency") ||
    t.includes("freq") ||
    t.includes("net id") ||
    t.includes("network id")
  );
}

// numeric or prefix selection from did-you-mean candidates
function pickCandidateFromUserReply(userText, candidates) {
  const t = safeStr(userText).trim();

  // Option number (1-8)
  const mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (mNum) {
    const n = parseInt(mNum[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= Math.min(8, candidates.length)) {
      return candidates[n - 1] || null;
    }
  }

  // Prefix match: "0964" should match "0964-Cinda 105"
  // Use start-of-name digits/letters match
  const prefix = t.toLowerCase();
  if (prefix && prefix.length >= 3) {
    const hit = candidates.find(c => safeStr(c?.name).toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }

  // Exact name match
  const exact = candidates.find(c => safeStr(c?.name).trim().toLowerCase() === prefix.toLowerCase());
  if (exact) return exact;

  return null;
}

export async function handleChatHttp(req, res) {
  try {
    pruneThreads();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    const thread = getThread(threadId);

    // ---- Handle pending "Did you mean" (yes/no/number/prefix) ----
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

    // ---- "that tower" follow-up helper (no intent routing; only helps pronoun resolution) ----
    // If user is asking network/frequency and we have lastTowerName, prepend a clarification.
    if (thread && thread.lastTowerName && userAsksTowerDetails(userText)) {
      const t = norm(userText);
      // Only if they didn't already name a tower explicitly
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

    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "auto",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // Empty-response retry: db_query only
    const firstCalls = extractFunctionCalls(rsp);
    const firstText = extractAssistantText(rsp);
    if (!firstCalls.length && !firstText) {
      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools: [dbQueryToolDef()],
        tool_choice: "required",
        input: input_list,
        temperature: 0.2
      });
      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

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
            if (thread) setPending(thread, {
              kind: "field",
              query: safeStr(args.query || ""),
              candidates: result.candidates,
              originalText: safeStr(body.text || body.message || body.q || "")
            });
            return res.json({
              ok: true,
              text: formatDidYouMean("field", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, {
              kind: "farm",
              query: safeStr(args.query || ""),
              candidates: result.candidates,
              originalText: safeStr(body.text || body.message || body.q || "")
            });
            return res.json({
              ok: true,
              text: formatDidYouMean("farm", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, {
              kind: "rtk tower",
              query: safeStr(args.query || ""),
              candidates: result.candidates,
              originalText: safeStr(body.text || body.message || body.q || "")
            });
            return res.json({
              ok: true,
              text: formatDidYouMean("rtk tower", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, {
              kind: "bin site",
              query: safeStr(args.query || ""),
              candidates: result.candidates,
              originalText: safeStr(body.text || body.message || body.q || "")
            });
            return res.json({
              ok: true,
              text: formatDidYouMean("bin site", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
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

    const text = extractAssistantText(rsp) || "No answer.";

    // ---- Save conversation + remember last tower name (for "that" follow-ups) ----
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