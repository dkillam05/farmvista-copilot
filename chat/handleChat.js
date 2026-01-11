// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-11-handleChat-sqlFirst10-active-default-hel-crp-followup-refine
//
// Keeps (unchanged):
// ✅ SQL-first tool loop
// ✅ resolve_* tools
// ✅ did-you-mean + yes/no disambiguation (PENDING)
// ✅ Active-by-default logic
// ✅ HEL / CRP awareness
//
// Adds (additive only):
// ✅ FOLLOW-UP LIST REFINEMENT memory
//    - "include tillable acres"
//    - "add field count"
//    - "with acres"
//    - "yes" after refinement prompt
//
// IMPORTANT:
// - No existing logic removed
// - No existing logic reordered
// - Only additive blocks clearly marked

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

// ==============================
// Memory
// ==============================

// Pending disambiguation memory (existing)
const PENDING = new Map(); // threadId -> { kind, query, candidates, createdAt, originalQuestion }

// NEW: Last list context memory (additive)
const LAST_LIST = new Map(); // threadId -> { type: "farms" | "fields" | "rtkTowers", createdAt }

// ==============================
// Helpers
// ==============================

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

function jsonTryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ==============================
// OpenAI wrapper
// ==============================

async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const text = await rsp.text();
  const data = jsonTryParse(text);
  if (!rsp.ok) {
    const msg = data?.error?.message || text || `OpenAI error (${rsp.status})`;
    throw new Error(msg);
  }
  return data;
}

// ==============================
// Response extraction
// ==============================

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
    if (!it) continue;
    if (it.type === "message") {
      const content = Array.isArray(it.content) ? it.content : [];
      for (const c of content) {
        if (!c) continue;
        if (c.type === "output_text" && typeof c.text === "string") {
          const t = c.text.trim();
          if (t) parts.push(t);
        }
      }
    }
  }

  return parts.join("\n").trim();
}

// ==============================
// Yes / No helpers
// ==============================

function isYesLike(s) {
  const v = norm(s);
  return ["yes", "y", "yep", "yeah", "correct", "right", "that", "that one", "yes i did", "ok", "okay"].includes(v);
}
function isNoLike(s) {
  const v = norm(s);
  return ["no", "n", "nope", "nah"].includes(v);
}

// ==============================
// Refinement detection (NEW)
// ==============================

function isRefinement(text) {
  const t = norm(text);
  return (
    t.includes("include") ||
    t.includes("add") ||
    t.includes("with") ||
    t.includes("acres") ||
    t.includes("tillable") ||
    t.includes("field count")
  );
}

// ==============================
// Pending cleanup
// ==============================

function prunePending() {
  const now = Date.now();
  for (const [k, v] of PENDING.entries()) {
    if (!v?.createdAt || (now - v.createdAt) > (10 * 60 * 1000)) {
      PENDING.delete(k);
    }
  }
  for (const [k, v] of LAST_LIST.entries()) {
    if (!v?.createdAt || (now - v.createdAt) > (10 * 60 * 1000)) {
      LAST_LIST.delete(k);
    }
  }
}

// ==============================
// Did-you-mean formatter
// ==============================

function formatDidYouMean(kind, candidates) {
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push(``);
  lines.push(`Reply with the exact name, or say "yes" to pick the first one.`);
  return lines.join("\n");
}

// ==============================
// System prompt
// ==============================

function buildSystemPrompt(dbStatus, userText) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  const u = (userText || "").toLowerCase();
  const mentionsTower = u.includes("tower");
  const mentionsFarm = u.includes("farm");

  const intentHint = (mentionsTower && !mentionsFarm)
    ? "USER INTENT HINT: This question is about RTK towers/assignments. Do NOT assume the name refers to a farm."
    : "";

  return `
You are FarmVista Copilot (SQL-first + fuzzy resolvers).

ACTIVE DEFAULT RULE (HARD):
- Unless the user explicitly asks for archived/inactive items, ALWAYS filter to ACTIVE records only.
- Active condition: (archived IS NULL OR archived = 0)
- Only include archived when user says: archived, inactive, include archived, including archived, show archived.

COUNTING DEFAULTS (HARD):
- If user asks "How many fields do we have?" WITHOUT mentioning archived/inactive:
  SELECT COUNT(*) FROM fields WHERE (archived IS NULL OR archived = 0);
- If user asks "including archived" / "all fields":
  SELECT COUNT(*) FROM fields;

MANDATORY WORKFLOW:
- If user mentions a FIELD name (even partial/typo), call resolve_field(query) first.
- If user mentions a FARM name (even partial/typo), call resolve_farm(query) first.
- If user mentions an RTK TOWER name (even partial/typo), call resolve_rtk_tower(query) first.
- After you get a match id, use db_query by ID (or JOIN by id) to fetch final facts.

DID-YOU-MEAN RULE (HARD):
- If resolve_* returns candidates and match is null, respond with "Did you mean:" list and ask which one.

FOLLOW-UP REFINEMENT RULE (HARD):
- If the assistant just returned a LIST and the user says things like:
  "include acres", "add tillable acres", "with acres", "field count", or answers "yes",
  treat it as a refinement of the PREVIOUS LIST — not a new entity lookup.

SQL-FIRST RULE (HARD):
- For all DB facts, do not guess. Use tools.

${intentHint}

DATABASE SNAPSHOT CONTEXT:
- snapshotId: ${snapshotId}
- loadedAt: ${loadedAt || "unknown"}
- counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

TABLES:
- farms(id, name, status, archived)
- fields(
    id, name, farmId, farmName,
    rtkTowerId, rtkTowerName,
    county, state, acresTillable,
    hasHEL, helAcres, hasCRP, crpAcres,
    archived
  )
- rtkTowers(id, name, networkId, frequency)
`.trim();
}

// ==============================
// Main handler
// ==============================

export async function handleChatHttp(req, res) {
  try {
    prunePending();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    // ======================================================
    // FOLLOW-UP LIST REFINEMENT (NEW, EARLY EXIT)
    // ======================================================
    if (threadId && LAST_LIST.has(threadId) && (isRefinement(userText) || isYesLike(userText))) {
      const ctx = LAST_LIST.get(threadId);

      if (ctx.type === "farms") {
        const sql = `
          SELECT
            f.name,
            SUM(fl.acresTillable) AS totalTillable
          FROM farms f
          LEFT JOIN fields fl ON fl.farmId = f.id
          WHERE (f.archived IS NULL OR f.archived = 0)
            AND (fl.archived IS NULL OR fl.archived = 0)
          GROUP BY f.id, f.name
          ORDER BY f.name
        `;

        const result = runSql({ sql, limit: 200 });

        LAST_LIST.delete(threadId);

        return res.json({
          ok: true,
          text: result.rows
            .map(r => `${r.name} — ${Number(r.totalTillable || 0).toLocaleString()} acres`)
            .join("\n"),
          meta: debugAI ? { snapshot: dbStatus.snapshot } : undefined
        });
      }
    }

    // ======================================================
    // EXISTING YES / NO DISAMBIGUATION (UNCHANGED)
    // ======================================================
    if (threadId && PENDING.has(threadId)) {
      const pend = PENDING.get(threadId);
      if (isYesLike(userText)) {
        const top = pend?.candidates?.[0] || null;
        if (top && pend.originalQuestion) {
          userText = `${pend.originalQuestion}\n\nUser confirmed: ${top.name} (id=${top.id}). Proceed using that id.`;
          PENDING.delete(threadId);
        }
      } else if (isNoLike(userText)) {
        PENDING.delete(threadId);
        return res.json({
          ok: true,
          text: "Okay — tell me the exact field/farm/tower name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      }
    }

    // ======================================================
    // NORMAL SQL-FIRST FLOW (UNCHANGED)
    // ======================================================
    const tools = [
      {
        type: "function",
        name: "db_query",
        description: "Run a read-only SQL SELECT query against the FarmVista SQLite snapshot database.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
            params: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
            limit: { type: "number" }
          },
          required: ["sql"]
        }
      },
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool
    ];

    const system = buildSystemPrompt(dbStatus, userText);

    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userText }
    ];

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

        if (name === "db_query") {
          didAny = true;
          try {
            result = runSql({
              sql: safeStr(args.sql || ""),
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
            if (threadId) {
              PENDING.set(threadId, {
                kind: "field",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
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
            if (threadId) {
              PENDING.set(threadId, {
                kind: "farm",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
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
            if (threadId) {
              PENDING.set(threadId, {
                kind: "rtk tower",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                createdAt: Date.now(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("rtk tower", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
        }

        if (didAny) {
          input_list.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result ?? { ok: false, error: "no_result" })
          });
        }
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

    // ======================================================
    // REMEMBER LIST CONTEXT (ADDITIVE)
    // ======================================================
    if (threadId && /show|list|all farms/i.test(norm(userText))) {
      LAST_LIST.set(threadId, { type: "farms", createdAt: Date.now() });
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