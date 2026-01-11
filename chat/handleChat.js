// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-11-handleChat-sqlFirst11b-human-followups-result-context-farm-fields-fix
//
// Fixes (additive, keeps your long file):
// ✅ Prevent "fields in <something> farm" from being misrouted to county fast path
// ✅ Add fast path: list fields by FARM (resolve farm -> query fields by farmId)
// ✅ Make "yes" work for farm disambiguation by returning fields list directly
//
// Keeps:
// ✅ SQL-first correctness
// ✅ Human followups: include acres, yes, either of those, farm number, fields in county
// ✅ did-you-mean memory (PENDING)
// ✅ result context memory (RESULT_CTX)
// ✅ OpenAI tools fallback

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
// Memory maps (in-memory; per Cloud Run instance)
// ==============================

// Did-you-mean disambiguation memory (existing pattern)
const PENDING = new Map(); // threadId -> { kind, query, candidates:[{id,name,score}], createdAt, originalQuestion }

// result context memory for "human follow-ups"
const RESULT_CTX = new Map(); // threadId -> { lastType, items:[{id,name,...}], selectedFarm?, selectedField?, lastPrompt?, pendingRefine?, createdAt }

// TTL cleanup
const TTL_MS = 10 * 60 * 1000;

function nowMs() { return Date.now(); }

function pruneMemory() {
  const now = nowMs();
  for (const [k, v] of PENDING.entries()) {
    if (!v?.createdAt || (now - v.createdAt) > TTL_MS) PENDING.delete(k);
  }
  for (const [k, v] of RESULT_CTX.entries()) {
    if (!v?.createdAt || (now - v.createdAt) > TTL_MS) RESULT_CTX.delete(k);
  }
}

// ==============================
// Helpers
// ==============================

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

// Active filter snippet used in deterministic SQL
function activeWhere(aliasOrNull) {
  const a = aliasOrNull ? `${aliasOrNull}.` : "";
  return `(${a}archived IS NULL OR ${a}archived = 0)`;
}

function fmtAcres(n) {
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
        if (c?.type === "output_text" && typeof c.text === "string") {
          const t = c.text.trim();
          if (t) parts.push(t);
        }
      }
    }
  }
  return parts.join("\n").trim();
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
// Deterministic "human" intent detection
// ==============================

function looksLikeListFarms(text) {
  const t = norm(text);
  return (
    t === "farms" ||
    t.includes("show me all the farms") ||
    t.includes("list all the farms") ||
    t.includes("list farms") ||
    t.includes("show farms")
  );
}

function looksLikeIncludeTillable(text) {
  const t = norm(text);
  return (
    t.includes("include tillable") ||
    t.includes("add tillable") ||
    t.includes("include acres") ||
    t.includes("add acres") ||
    t.includes("with acres") ||
    t === "include tillable acres" ||
    t === "include acres"
  );
}

function parseFarmNumber(text) {
  // "farm number 5" / "farm #5" / "number 5"
  const t = norm(text);
  let m = t.match(/\bfarm\s*(number|#)\s*(\d{1,3})\b/);
  if (m) return Number(m[2]);
  m = t.match(/\bnumber\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * COUNTY parser (FIXED):
 * - Only triggers when user explicitly says "county"
 * - Or when they say "fields in <X county>"
 * - NEVER triggers if they mention "farm" in the same request
 */
function parseCountyFields(text) {
  const t = norm(text);

  // Prevent farm requests from being misrouted as county
  if (t.includes("farm")) return null;

  // Require explicit "county"
  let m = t.match(/\bfields?\s+in\s+([a-z\s\-]+?)\s+county\b/);
  if (m) return m[1].trim();

  // Also allow "in Greene county" anywhere
  m = t.match(/\bin\s+([a-z\s\-]+?)\s+county\b/);
  if (m) return m[1].trim();

  return null;
}

/**
 * FARM parser (NEW):
 * Handles:
 * - "fields in the carlinville farm"
 * - "fields in carlinville farm"
 * - "field list for the cville farm"
 * - "all fields in that farm"
 */
function parseFarmFieldsQuery(text) {
  const t = norm(text);

  // Must mention farm OR "that farm"
  if (!t.includes("farm")) return null;

  // If they say "that farm", rely on selectedFarm context
  if (t.includes("that farm") || t.includes("the farm i asked") || t.includes("the farm that i asked")) {
    return { kind: "selectedFarm", query: "" };
  }

  // Try to capture a farm name phrase near "farm"
  // Examples: "carlinville farm", "cville farm", "cville-stdcty-barnet farm"
  let m = t.match(/\bfields?\b.*\b([a-z0-9\-\s]+?)\s+farm\b/);
  if (m && m[1] && m[1].trim().length >= 2) return { kind: "query", query: m[1].trim() };

  m = t.match(/\bfarm\b.*\b([a-z0-9\-\s]+)\b/);
  // Too risky; skip generic
  return null;
}

function looksLikeHelQuestion(text) {
  const t = norm(text);
  return (t.includes("hel") && (t.includes(">") || t.includes("greater") || t.includes("have") || t.includes("any")));
}

function looksLikeEitherOfThose(text) {
  const t = norm(text);
  return (
    t.includes("either") ||
    t.includes("both") ||
    t.includes("those fields") ||
    t.includes("either one") ||
    t.includes("do either")
  );
}

// ==============================
// Deterministic fast paths
// ==============================

function listActiveFarmsAndRemember(threadId) {
  // IMPORTANT: select id internally, but DO NOT display it
  const sql = `
    SELECT id, name
    FROM farms
    WHERE ${activeWhere("")}
    ORDER BY name
    LIMIT 500
  `;
  const r = runSql({ sql, limit: 500 });
  const rows = r.rows || [];

  if (threadId) {
    RESULT_CTX.set(threadId, {
      lastType: "farms",
      items: rows.map(x => ({ id: safeStr(x.id), name: safeStr(x.name) })),
      createdAt: nowMs()
    });
  }

  if (!rows.length) return "No active farms found.";

  const lines = ["Here are the active farms:"];
  rows.forEach((x, i) => lines.push(`${i + 1}. ${safeStr(x.name)}`));
  lines.push("");
  lines.push('You can reply like: "farm number 5" or type the farm name.');
  return lines.join("\n");
}

function listActiveFarmsWithTillableAndRemember(threadId) {
  const sql = `
    SELECT f.id AS farmId,
           f.name AS farmName,
           COALESCE(SUM(CASE WHEN ${activeWhere("fl")} THEN fl.acresTillable ELSE 0 END), 0) AS totalTillable
    FROM farms f
    LEFT JOIN fields fl ON fl.farmId = f.id
    WHERE ${activeWhere("f")}
    GROUP BY f.id, f.name
    ORDER BY f.name
    LIMIT 500
  `;
  const r = runSql({ sql, limit: 500 });
  const rows = r.rows || [];

  if (threadId) {
    RESULT_CTX.set(threadId, {
      lastType: "farms_with_acres",
      items: rows.map(x => ({ id: safeStr(x.farmId), name: safeStr(x.farmName), totalTillable: Number(x.totalTillable || 0) })),
      createdAt: nowMs()
    });
  }

  if (!rows.length) return "No active farms found.";

  const lines = ["Active farms with total tillable acres:"];
  rows.forEach((x, i) => lines.push(`${i + 1}. ${safeStr(x.farmName)} — ${fmtAcres(x.totalTillable)} acres`));
  lines.push("");
  lines.push('You can reply like: "farm number 5" or type the farm name.');
  return lines.join("\n");
}

function listFieldsInCountyAndRemember(countyQuery, threadId) {
  const county = countyQuery.trim();
  const sql = `
    SELECT id, name, farmName, acresTillable, county, state, hasHEL, helAcres
    FROM fields
    WHERE ${activeWhere("")}
      AND lower(county) = lower(?)
    ORDER BY name
    LIMIT 200
  `;
  const r = runSql({ sql, params: [county], limit: 200 });
  const rows = r.rows || [];

  if (threadId) {
    RESULT_CTX.set(threadId, {
      lastType: "fields",
      items: rows.map(x => ({
        id: safeStr(x.id),
        name: safeStr(x.name),
        farmName: safeStr(x.farmName),
        acresTillable: Number(x.acresTillable || 0),
        hasHEL: Number(x.hasHEL || 0),
        helAcres: Number(x.helAcres || 0)
      })),
      createdAt: nowMs()
    });
  }

  if (!rows.length) return `No active fields found in ${county} County.`;

  const lines = [`Active fields in ${county} County:`];
  rows.forEach((x, i) => {
    lines.push(`${i + 1}. ${safeStr(x.name)} — Farm: ${safeStr(x.farmName) || "(unknown)"} — ${fmtAcres(x.acresTillable)} tillable acres`);
  });
  return lines.join("\n");
}

/**
 * NEW: list fields by farmId (used for carlinville/cville farm requests)
 */
function listFieldsInFarmByIdAndRemember(farmId, farmName, threadId) {
  const sql = `
    SELECT id, name, farmName, acresTillable, county, state, hasHEL, helAcres
    FROM fields
    WHERE ${activeWhere("")}
      AND farmId = ?
    ORDER BY name
    LIMIT 500
  `;
  const r = runSql({ sql, params: [farmId], limit: 500 });
  const rows = r.rows || [];

  if (threadId) {
    RESULT_CTX.set(threadId, {
      lastType: "fields",
      items: rows.map(x => ({
        id: safeStr(x.id),
        name: safeStr(x.name),
        farmName: safeStr(x.farmName),
        acresTillable: Number(x.acresTillable || 0),
        hasHEL: Number(x.hasHEL || 0),
        helAcres: Number(x.helAcres || 0)
      })),
      selectedFarm: { id: safeStr(farmId), name: safeStr(farmName) },
      createdAt: nowMs()
    });
  }

  if (!rows.length) return `No active fields found for farm ${farmName}.`;

  const lines = [`Active fields in farm ${farmName}:`];
  rows.forEach((x, i) => {
    lines.push(`${i + 1}. ${safeStr(x.name)} — ${fmtAcres(x.acresTillable)} tillable acres — ${safeStr(x.county)} County`);
  });
  return lines.join("\n");
}

function answerHelForLastFields(threadId) {
  const ctx = threadId ? RESULT_CTX.get(threadId) : null;
  const items = ctx?.items || [];
  if (!items.length) return "Which fields do you mean? I don't have a recent field list to reference.";

  const focus = items.slice(0, 20);
  const any = focus.filter(f => Number(f.helAcres || 0) > 0);

  if (!any.length) return "No — none of those fields have HEL acres greater than 0.";

  const lines = ["Yes — these fields have HEL acres greater than 0:"];
  any.forEach(f => lines.push(`- ${f.name} — HEL acres: ${fmtAcres(f.helAcres)}`));
  return lines.join("\n");
}

function selectFarmByNumber(threadId, n) {
  const ctx = threadId ? RESULT_CTX.get(threadId) : null;
  const items = ctx?.items || [];
  if (!items.length) return null;
  if (!Number.isFinite(n) || n <= 0 || n > items.length) return null;
  return items[n - 1] || null;
}

// ==============================
// System prompt
// ==============================

function buildSystemPrompt(dbStatus) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";
  const loadedAt = dbStatus?.snapshot?.loadedAt || null;

  return `
You are FarmVista Copilot (SQL-first + fuzzy resolvers).

ACTIVE DEFAULT (HARD):
- Unless user explicitly requests archived/inactive, filter to active:
  (archived IS NULL OR archived = 0)

IMPORTANT:
- When listing entities (farms/fields/towers), prefer selecting the entity id internally (do NOT display ids).
  This enables reliable follow-ups like "farm number 5" and "either one of those fields".

DB snapshot:
- snapshotId: ${snapshotId}
- loadedAt: ${loadedAt || "unknown"}
- counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

Tables:
- farms(id, name, status, archived)
- fields(id, name, farmId, farmName, rtkTowerId, rtkTowerName, county, state, acresTillable, hasHEL, helAcres, hasCRP, crpAcres, archived)
- rtkTowers(id, name, networkId, frequency)
`.trim();
}

// ==============================
// Main handler
// ==============================

export async function handleChatHttp(req, res) {
  try {
    pruneMemory();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    // ==============================
    // FAST PATH 0 (NEW): Fields in FARM (fixes carlinville/cville farm flow)
    // ==============================
    const farmFieldsReq = parseFarmFieldsQuery(userText);
    if (farmFieldsReq && threadId) {
      // If it references "that farm", use selectedFarm
      if (farmFieldsReq.kind === "selectedFarm") {
        const ctx = RESULT_CTX.get(threadId);
        const sf = ctx?.selectedFarm;
        if (sf?.id && sf?.name) {
          const out = listFieldsInFarmByIdAndRemember(sf.id, sf.name, threadId);
          return res.json({
            ok: true,
            text: out,
            meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:fields_in_farm_selected" } : undefined
          });
        }
        // If no selectedFarm, fall through to OpenAI
      }

      if (farmFieldsReq.kind === "query") {
        const rr = resolveFarm(farmFieldsReq.query);

        // clear match
        if (rr?.match?.id) {
          const out = listFieldsInFarmByIdAndRemember(rr.match.id, rr.match.name, threadId);
          return res.json({
            ok: true,
            text: out,
            meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:fields_in_farm" } : undefined
          });
        }

        // candidates -> did you mean (but store as special kind so "yes" returns fields)
        if (!rr?.match && Array.isArray(rr?.candidates) && rr.candidates.length) {
          PENDING.set(threadId, {
            kind: "farm_fields",
            query: farmFieldsReq.query,
            candidates: rr.candidates,
            createdAt: nowMs(),
            originalQuestion: userText
          });
          return res.json({
            ok: true,
            text: formatDidYouMean("farm", rr.candidates),
            meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
          });
        }
      }
    }

    // ==============================
    // FAST PATH 1: List farms
    // ==============================
    if (looksLikeListFarms(userText)) {
      const out = listActiveFarmsAndRemember(threadId);
      return res.json({
        ok: true,
        text: out,
        meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:list_farms" } : undefined
      });
    }

    // ==============================
    // FAST PATH 2: Follow-up "include tillable acres" after farms list
    // ==============================
    if (threadId) {
      const ctx = RESULT_CTX.get(threadId);
      if (ctx?.lastType === "farms" && looksLikeIncludeTillable(userText)) {
        ctx.pendingRefine = "farms_with_acres";
        ctx.createdAt = nowMs();
        RESULT_CTX.set(threadId, ctx);

        const out = listActiveFarmsWithTillableAndRemember(threadId);
        return res.json({
          ok: true,
          text: out,
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:farms_include_acres" } : undefined
        });
      }

      if (isYesLike(userText) && ctx?.pendingRefine === "farms_with_acres") {
        ctx.pendingRefine = null;
        ctx.createdAt = nowMs();
        RESULT_CTX.set(threadId, ctx);

        const out = listActiveFarmsWithTillableAndRemember(threadId);
        return res.json({
          ok: true,
          text: out,
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:yes_apply_refine" } : undefined
        });
      }
    }

    // ==============================
    // FAST PATH 3: Farm number N
    // ==============================
    const farmNum = parseFarmNumber(userText);
    if (threadId && farmNum != null) {
      const pick = selectFarmByNumber(threadId, farmNum);
      if (pick) {
        const prev = RESULT_CTX.get(threadId) || {};
        RESULT_CTX.set(threadId, {
          ...prev,
          selectedFarm: { id: pick.id, name: pick.name },
          createdAt: nowMs()
        });

        return res.json({
          ok: true,
          text: `Got it — farm #${farmNum} is **${pick.name}**. Ask: "show me all fields in this farm".`,
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:farm_number" } : undefined
        });
      }
    }

    // ==============================
    // FAST PATH 4: Fields in a county (FIXED to require 'county' and not 'farm')
    // ==============================
    const countyQ = parseCountyFields(userText);
    if (countyQ) {
      const out = listFieldsInCountyAndRemember(countyQ, threadId);
      return res.json({
        ok: true,
        text: out,
        meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:fields_in_county" } : undefined
      });
    }

    // ==============================
    // FAST PATH 5: HEL question about "either/both/those fields"
    // ==============================
    if (threadId) {
      const ctx = RESULT_CTX.get(threadId);
      if (ctx?.lastType === "fields" && looksLikeHelQuestion(userText) && looksLikeEitherOfThose(userText)) {
        const out = answerHelForLastFields(threadId);
        return res.json({
          ok: true,
          text: out,
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:hel_for_last_fields" } : undefined
        });
      }
    }

    // ======================================================
    // Existing YES / NO DISAMBIGUATION (did-you-mean) — extended for farm_fields
    // ======================================================
    if (threadId && PENDING.has(threadId)) {
      const pend = PENDING.get(threadId);

      // NEW: if they asked for fields in a farm and we had candidates, "yes" should list fields
      if (pend.kind === "farm_fields" && isYesLike(userText)) {
        const top = pend?.candidates?.[0] || null;
        if (top?.id && top?.name) {
          PENDING.delete(threadId);
          const out = listFieldsInFarmByIdAndRemember(top.id, top.name, threadId);
          return res.json({
            ok: true,
            text: out,
            meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null, route: "fast:yes_farm_fields" } : undefined
          });
        }
      }

      // Existing behavior
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

    // ==============================
    // Normal OpenAI tool flow (fallback)
    // ==============================

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

    const system = buildSystemPrompt(dbStatus);

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
          const sql = safeStr(args.sql || "");
          const params = Array.isArray(args.params) ? args.params : [];
          const limit = Number.isFinite(args.limit) ? args.limit : 200;

          try {
            result = runSql({ sql, params, limit });
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }

          // capture list context opportunistically when ids are included
          if (threadId && result && Array.isArray(result.rows) && result.rows.length) {
            const sqlLow = sql.toLowerCase();

            if (sqlLow.includes("from farms") && result.rows[0]?.id && result.rows[0]?.name) {
              RESULT_CTX.set(threadId, {
                lastType: "farms",
                items: result.rows.map(r => ({ id: safeStr(r.id), name: safeStr(r.name) })),
                createdAt: nowMs()
              });
            }

            if (sqlLow.includes("from fields") && result.rows[0]?.id && result.rows[0]?.name) {
              RESULT_CTX.set(threadId, {
                lastType: "fields",
                items: result.rows.map(r => ({
                  id: safeStr(r.id),
                  name: safeStr(r.name),
                  farmName: safeStr(r.farmName || ""),
                  acresTillable: Number(r.acresTillable || 0),
                  hasHEL: Number(r.hasHEL || 0),
                  helAcres: Number(r.helAcres || 0)
                })),
                createdAt: nowMs()
              });
            }

            if (sqlLow.includes("from rtktowers") && result.rows[0]?.id && result.rows[0]?.name) {
              RESULT_CTX.set(threadId, {
                lastType: "rtkTowers",
                items: result.rows.map(r => ({ id: safeStr(r.id), name: safeStr(r.name) })),
                createdAt: nowMs()
              });
            }
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
                createdAt: nowMs(),
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
                createdAt: nowMs(),
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
                createdAt: nowMs(),
                originalQuestion: safeStr(body.text || body.message || body.q || "").trim()
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("rtk tower", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
        } else {
          continue;
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