// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql8-realworld-rtk-field
//
// DB-first (no handlers) for real-world phrasing:
// ✅ "RTK tower for field ####" (always resolves field->tower correctly)
// ✅ "tower info / network id / frequency for <tower>" (tower detail)
// ✅ "field info for <name>" (field detail list)
// ✅ "RTK tower info for <field name>" (field->tower by name)
//
// Keeps:
// ✅ paging followups
// ✅ followup interpreter
// ✅ OpenAI->SQL fallback for everything else
// ✅ handlers fallback as last resort
// ✅ clean output: only what user asked (no tips)

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";

// last resort fallback
import { llmPlan } from "./llmPlanner.js";
import { executePlannedQuestion } from "./executePlannedQuestion.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }
function norm(s) { return (s || "").toString().trim().toLowerCase(); }

function extractBearer(authHeader) {
  const h = safeStr(authHeader);
  if (!h) return "";
  const m = h.match(/^bearer\s+(.+)$/i);
  return m ? safeStr(m[1]) : "";
}

function makeThreadId() {
  try { return crypto.randomUUID(); }
  catch { return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
}

/* =========================
   Basic intent detection
========================= */
function isRtkTowerQuestion(q) {
  const s = norm(q);
  return s.includes("rtk") || s.includes("tower");
}
function wantsTowerDetail(q) {
  const s = norm(q);
  return s.includes("network id") || s.includes("networkid") || s.includes("frequency") || s.includes("mhz") || s.includes("tower info") || s.includes("tower information") || s.includes("details");
}
function wantsFieldInfo(q) {
  const s = norm(q);
  return s.includes("field info") || s.includes("field information") || (s.includes("field") && s.includes("information"));
}
function wantsFieldToTower(q) {
  const s = norm(q);
  // treat any mention of rtk/tower + "field" as field->tower intent
  return isRtkTowerQuestion(s) && s.includes("field");
}
function activeFieldsWhere() {
  return "(fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive'))";
}
function activeFarmsWhere() {
  return "(farms.status IS NULL OR farms.status='' OR LOWER(farms.status) NOT IN ('archived','inactive'))";
}

/* =========================
   Safe string normalization for SQL LIKE (no injection)
========================= */
function normForSqlLike(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
function squishForSqlLike(s) {
  return normForSqlLike(s).replace(/\s+/g, "").slice(0, 60);
}

/* =========================
   Parse "field ####" or bare ####
========================= */
function extractFieldNumber(q) {
  const s = norm(q);
  let m = s.match(/\bfield\s+(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\b(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/* =========================
   Extract “target phrase” (for Ruby’s / New Berlin / etc.)
   - handles: "... for Ruby's field"
   - handles: "network id for new berlin rtk tower"
========================= */
function extractAfterFor(q) {
  const s = (q || "").toString().trim();
  let m = s.match(/\bfor\s+(.+)$/i);
  if (m && m[1]) return m[1].trim();
  return "";
}
function stripTrailingWords(s) {
  return (s || "")
    .toString()
    .replace(/\b(rtk|tower|towers|field|fields|info|information|details)\b.*$/i, "")
    .trim();
}
function extractTowerNamePhrase(q) {
  // best-effort: remove leading question words and keep tower name chunk
  let s = (q || "").toString().trim();
  s = s.replace(/^what\s+is\s+/i, "");
  s = s.replace(/^what\s+are\s+/i, "");
  s = s.replace(/^give\s+me\s+/i, "");
  s = s.replace(/^tell\s+me\s+/i, "");
  s = s.replace(/^i\s+need\s+to\s+know\s+/i, "");
  s = s.replace(/^can\s+you\s+please\s+provide\s+me\s+with\s+/i, "");
  s = s.replace(/^can\s+you\s+/i, "");

  // If "for X", grab that
  const aft = extractAfterFor(s);
  if (aft) s = aft;

  // remove trailing "rtk tower" etc
  s = stripTrailingWords(s);
  return s.trim();
}

function extractFieldNamePhrase(q) {
  // Accept:
  // - "Ruby's field"
  // - "field information for Ruby's"
  // - "RTK tower info for Ruby's field"
  let s = (q || "").toString().trim();

  // if "for X" use that
  const aft = extractAfterFor(s);
  if (aft) s = aft;

  // remove "field" word but keep the name
  s = s.replace(/\bfield\b/ig, "").trim();

  // strip any trailing "rtk/tower/info" words
  s = stripTrailingWords(s);

  return s.trim();
}

/* =========================
   Output formatting (clean)
========================= */
function formatScalar(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) return `${rows[0][keys[0]]}`;
  }
  return null;
}

function formatFieldTowerRow(r) {
  const out = [];
  out.push(`Field: ${r.field || "(unknown)"}`);
  if (r.farm) out.push(`Farm: ${r.farm}`);
  if (r.county) out.push(`County: ${r.county}${r.state ? ", " + r.state : ""}`);
  out.push(`RTK tower: ${r.tower ? r.tower : "(none assigned)"}`);
  if (r.frequencyMHz) out.push(`Frequency: ${r.frequencyMHz} MHz`);
  if (r.networkId != null && String(r.networkId).trim() !== "") out.push(`Network ID: ${r.networkId}`);
  return out.join("\n");
}

function formatTowerDetailRow(r) {
  const out = [];
  out.push(`RTK tower: ${r.tower || "(unknown)"}`);
  if (r.frequencyMHz) out.push(`Frequency: ${r.frequencyMHz} MHz`);
  if (r.networkId != null && String(r.networkId).trim() !== "") out.push(`Network ID: ${r.networkId}`);
  if (r.fieldsUsing != null) out.push(`Fields using tower: ${r.fieldsUsing}`);
  if (r.farmsUsing != null) out.push(`Farms using tower: ${r.farmsUsing}`);
  return out.join("\n");
}

function formatFieldInfoRow(r) {
  const out = [];
  out.push(`Field: ${r.field || "(unknown)"}`);
  if (r.farm) out.push(`Farm: ${r.farm}`);
  if (r.county) out.push(`County: ${r.county}${r.state ? ", " + r.state : ""}`);
  if (r.status) out.push(`Status: ${r.status}`);
  if (r.tillable != null) out.push(`Tillable: ${Number(r.tillable).toLocaleString(undefined,{maximumFractionDigits:2})} ac`);
  if (r.helAcres != null && Number(r.helAcres) > 0) out.push(`HEL acres: ${Number(r.helAcres).toLocaleString(undefined,{maximumFractionDigits:2})}`);
  if (r.crpAcres != null && Number(r.crpAcres) > 0) out.push(`CRP acres: ${Number(r.crpAcres).toLocaleString(undefined,{maximumFractionDigits:2})}`);
  if (r.tower) out.push(`RTK tower: ${r.tower}`);
  return out.join("\n");
}

function pageBlocks(blocks, limitBlocks = 3) {
  const take = Math.min(limitBlocks, blocks.length);
  const out = [];
  for (let i = 0; i < take; i++) out.push(blocks[i]);
  if (blocks.length > take) out.push(`(…plus ${blocks.length - take} more matches)`);
  return out.join("\n\n");
}

function formatSqlResult({ question, rows }) {
  const scalar = formatScalar(rows);
  if (scalar != null) return { answer: scalar, continuation: null };

  if (!Array.isArray(rows) || rows.length === 0) return { answer: "(no matches)", continuation: null };

  // If it looks like our structured projections, render them cleanly
  const r0 = rows[0] || {};
  if ("tower" in r0 && ("frequencyMHz" in r0 || "networkId" in r0) && !("field" in r0) && !("tillable" in r0)) {
    // tower detail
    const blocks = rows.slice(0, 3).map(formatTowerDetailRow);
    return { answer: pageBlocks(blocks, 1), continuation: null };
  }

  if ("field" in r0 && ("tower" in r0 || "frequencyMHz" in r0 || "networkId" in r0) && !("tillable" in r0)) {
    // field -> tower
    const blocks = rows.slice(0, 3).map(formatFieldTowerRow);
    return { answer: pageBlocks(blocks, 1), continuation: null };
  }

  if ("field" in r0 && ("tillable" in r0 || "status" in r0 || "helAcres" in r0 || "crpAcres" in r0)) {
    // field info blocks
    const blocks = rows.slice(0, 3).map(formatFieldInfoRow);
    return { answer: pageBlocks(blocks, 3), continuation: null };
  }

  // fallback: bullets
  const lines = [];
  for (const r of rows) {
    const label = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? "").toString().trim();
    if (label) lines.push(`• ${label}`);
  }
  return { answer: lines.length ? lines.join("\n") : "(no matches)", continuation: null };
}

/* =========================
   DB queries (deterministic)
========================= */

// field -> tower by number
function dbFieldToTowerByNumber(db, n) {
  const sql = `
    SELECT
      fields.name AS field,
      farms.name AS farm,
      fields.county AS county,
      fields.state AS state,
      rtkTowers.name AS tower,
      rtkTowers.frequencyMHz AS frequencyMHz,
      rtkTowers.networkId AS networkId
    FROM fields
    LEFT JOIN farms ON farms.id = fields.farmId
    LEFT JOIN rtkTowers ON rtkTowers.id = fields.rtkTowerId
    WHERE
      (
        fields.field_num = ${n}
        OR fields.id = '${n}'
        OR fields.name_norm LIKE '${n}%'
        OR fields.name LIKE '${n}-%'
      )
      AND ${activeFieldsWhere()}
    LIMIT 5
  `.trim();
  return runSql({ db, sql, limitDefault: 5 });
}

// field -> tower by name phrase
function dbFieldToTowerByName(db, phrase) {
  const p = normForSqlLike(phrase);
  const sq = squishForSqlLike(phrase);
  if (!p && !sq) return { ok: false, rows: [] };

  const toks = p.split(" ").filter(t => t.length >= 2).slice(0, 4);
  const andClauses = toks.map(t => `fields.name_norm LIKE '%${t}%'`);
  const squishClause = sq ? `fields.name_sq LIKE '%${sq}%'` : null;

  const nameMatch =
    andClauses.length
      ? `(${andClauses.join(" AND ")}${squishClause ? ` OR ${squishClause}` : ""})`
      : (squishClause ? `(${squishClause})` : "0=1");

  const sql = `
    SELECT
      fields.name AS field,
      farms.name AS farm,
      fields.county AS county,
      fields.state AS state,
      rtkTowers.name AS tower,
      rtkTowers.frequencyMHz AS frequencyMHz,
      rtkTowers.networkId AS networkId
    FROM fields
    LEFT JOIN farms ON farms.id = fields.farmId
    LEFT JOIN rtkTowers ON rtkTowers.id = fields.rtkTowerId
    WHERE
      ${nameMatch}
      AND ${activeFieldsWhere()}
    ORDER BY fields.field_num ASC, fields.name_norm ASC
    LIMIT 5
  `.trim();
  return runSql({ db, sql, limitDefault: 5 });
}

// tower detail by name phrase
function dbTowerDetailByName(db, phrase) {
  const p = normForSqlLike(phrase);
  const sq = squishForSqlLike(phrase);
  if (!p && !sq) return { ok: false, rows: [] };

  const toks = p.split(" ").filter(t => t.length >= 2).slice(0, 4);
  const andClauses = toks.map(t => `rtkTowers.name_norm LIKE '%${t}%'`);
  const squishClause = sq ? `rtkTowers.name_sq LIKE '%${sq}%'` : null;

  const nameMatch =
    andClauses.length
      ? `(${andClauses.join(" AND ")}${squishClause ? ` OR ${squishClause}` : ""})`
      : (squishClause ? `(${squishClause})` : "0=1");

  const sql = `
    SELECT
      rtkTowers.name AS tower,
      rtkTowers.frequencyMHz AS frequencyMHz,
      rtkTowers.networkId AS networkId,
      (
        SELECT COUNT(*)
        FROM fields
        WHERE fields.rtkTowerId = rtkTowers.id
          AND ${activeFieldsWhere()}
      ) AS fieldsUsing,
      (
        SELECT COUNT(DISTINCT fields.farmId)
        FROM fields
        WHERE fields.rtkTowerId = rtkTowers.id
          AND ${activeFieldsWhere()}
      ) AS farmsUsing
    FROM rtkTowers
    WHERE ${nameMatch}
    LIMIT 3
  `.trim();
  return runSql({ db, sql, limitDefault: 3 });
}

// field info by name phrase
function dbFieldInfoByName(db, phrase) {
  const p = normForSqlLike(phrase);
  const sq = squishForSqlLike(phrase);
  if (!p && !sq) return { ok: false, rows: [] };

  const toks = p.split(" ").filter(t => t.length >= 2).slice(0, 4);
  const andClauses = toks.map(t => `fields.name_norm LIKE '%${t}%'`);
  const squishClause = sq ? `fields.name_sq LIKE '%${sq}%'` : null;

  const nameMatch =
    andClauses.length
      ? `(${andClauses.join(" AND ")}${squishClause ? ` OR ${squishClause}` : ""})`
      : (squishClause ? `(${squishClause})` : "0=1");

  const sql = `
    SELECT
      fields.name AS field,
      farms.name AS farm,
      fields.county AS county,
      fields.state AS state,
      fields.status AS status,
      fields.tillable AS tillable,
      fields.helAcres AS helAcres,
      fields.crpAcres AS crpAcres,
      rtkTowers.name AS tower
    FROM fields
    LEFT JOIN farms ON farms.id = fields.farmId
    LEFT JOIN rtkTowers ON rtkTowers.id = fields.rtkTowerId
    WHERE
      ${nameMatch}
      AND ${activeFieldsWhere()}
    ORDER BY fields.field_num ASC, fields.name_norm ASC
    LIMIT 10
  `.trim();
  return runSql({ db, sql, limitDefault: 10 });
}

/* =========================
   Main
========================= */
export async function handleChat({
  question,
  snapshot,
  authHeader = "",
  state = null,
  threadId = "",
  continuation = null,
  debugAI = false
}) {
  const qRaw0 = safeStr(question);
  const tid = safeStr(threadId) || makeThreadId();
  const debug = !!debugAI;

  if (!qRaw0) {
    return { ok: false, error: "missing_question", answer: "Missing question.", action: null, meta: { intent: "chat", error: true, threadId: tid }, state: state || null };
  }

  if (!snapshot?.ok || !snapshot?.json) {
    return { ok: false, error: snapshot?.error || "snapshot_not_loaded", answer: "Snapshot data isn’t available right now. Try /context/reload, then retry.", action: null, meta: { intent: "chat", error: true, snapshotOk: !!snapshot?.ok, threadId: tid }, state: state || null };
  }

  // ensure DB
  let dbInfo = null;
  try { dbInfo = ensureDbFromSnapshot(snapshot); } catch (e) { dbInfo = { ok: false, error: safeStr(e?.message || e) }; }

  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  const ctx = getThreadContext(tid) || {};

  // paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return { ok: fu?.ok !== false, answer: safeStr(fu?.answer) || "No response.", action: fu?.action || null, meta: { ...(fu?.meta || {}), threadId: tid }, state: state || null };
    }
  } catch { clearContinuation(tid); }

  // followup interpreter rewrite
  let routedQuestion = qRaw;
  try {
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp?.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // ===========================
  // DB-FIRST REAL WORLD INTENTS
  // ===========================
  if (dbInfo?.ok && getDb()) {
    const db = getDb();
    const s = norm(routedQuestion);

    // A) Field -> Tower (always correct)
    if (wantsFieldToTower(routedQuestion) || (isRtkTowerQuestion(routedQuestion) && extractFieldNumber(routedQuestion) != null)) {
      const fn = extractFieldNumber(routedQuestion);
      let ex = null;

      if (fn != null) ex = dbFieldToTowerByNumber(db, fn);
      if (!ex || !ex.ok || !ex.rows || ex.rows.length === 0) {
        const phrase = extractFieldNamePhrase(routedQuestion);
        if (phrase) ex = dbFieldToTowerByName(db, phrase);
      }

      if (ex && ex.ok && ex.rows && ex.rows.length) {
        const r0 = ex.rows[0] || {};
        const towerName = (r0.tower || "").toString().trim();
        if (towerName) {
          applyContextDelta(tid, { lastEntity: { type: "tower", id: towerName, name: towerName }, lastIntent: "field_tower_lookup" });
        }
        const formatted = formatSqlResult({ question: routedQuestion, rows: ex.rows });
        let out = safeStr(formatted.answer);
        if (debug) out += `\n\n[DB: field→tower]`;
        return { ok: true, answer: out, action: null, meta: { routed: "db_field_tower", threadId: tid, sql: debug ? ex.sql : undefined }, state: state || null };
      }
    }

    // B) Tower detail (network id / frequency)
    if (isRtkTowerQuestion(routedQuestion) && wantsTowerDetail(routedQuestion) && !s.includes("field")) {
      const towerPhrase = extractTowerNamePhrase(routedQuestion);
      const ex = dbTowerDetailByName(db, towerPhrase);
      if (ex.ok && ex.rows && ex.rows.length) {
        const towerName = (ex.rows[0].tower || "").toString().trim();
        if (towerName) applyContextDelta(tid, { lastEntity: { type: "tower", id: towerName, name: towerName }, lastIntent: "tower_detail" });
        const formatted = formatSqlResult({ question: routedQuestion, rows: ex.rows });
        let out = safeStr(formatted.answer);
        if (debug) out += `\n\n[DB: tower detail]`;
        return { ok: true, answer: out, action: null, meta: { routed: "db_tower_detail", threadId: tid, sql: debug ? ex.sql : undefined }, state: state || null };
      }
    }

    // C) Field info (Ruby’s field, etc.) — IMPORTANT: must override tower bias
    if (wantsFieldInfo(routedQuestion) || (s.includes("field information") && !isRtkTowerQuestion(routedQuestion))) {
      const phrase = extractFieldNamePhrase(routedQuestion);
      const ex = dbFieldInfoByName(db, phrase);
      if (ex.ok && ex.rows && ex.rows.length) {
        const formatted = formatSqlResult({ question: routedQuestion, rows: ex.rows });
        let out = safeStr(formatted.answer);
        if (debug) out += `\n\n[DB: field info]`;
        return { ok: true, answer: out, action: null, meta: { routed: "db_field_info", threadId: tid, sql: debug ? ex.sql : undefined }, state: state || null };
      }
    }

    // D) If user asks “RTK tower info for Ruby’s field” but phrased weird, force field→tower by name
    if (isRtkTowerQuestion(routedQuestion) && (s.includes("for") || s.includes("ruby")) && !extractFieldNumber(routedQuestion)) {
      const phrase = extractFieldNamePhrase(routedQuestion);
      if (phrase) {
        const ex = dbFieldToTowerByName(db, phrase);
        if (ex.ok && ex.rows && ex.rows.length) {
          const r0 = ex.rows[0] || {};
          const towerName = (r0.tower || "").toString().trim();
          if (towerName) applyContextDelta(tid, { lastEntity: { type: "tower", id: towerName, name: towerName }, lastIntent: "field_tower_lookup" });
          const formatted = formatSqlResult({ question: routedQuestion, rows: ex.rows });
          let out = safeStr(formatted.answer);
          if (debug) out += `\n\n[DB: field→tower by name]`;
          return { ok: true, answer: out, action: null, meta: { routed: "db_field_tower_name", threadId: tid, sql: debug ? ex.sql : undefined }, state: state || null };
        }
      }
    }
  }

  // ===========================
  // OpenAI -> SQL fallback
  // ===========================
  if (dbInfo?.ok && getDb()) {
    const sqlPlan = await planSql({ question: routedQuestion, debug });
    if (sqlPlan.ok && sqlPlan.sql) {
      const exec = runSql({ db: getDb(), sql: sqlPlan.sql, limitDefault: 80 });
      if (exec.ok) {
        const formatted = formatSqlResult({ question: routedQuestion, rows: exec.rows || [] });
        let out = safeStr(formatted.answer);
        if (debug) out += `\n\n[AI SQL: ON • ${sqlPlan.meta.model} • ${sqlPlan.meta.ms}ms]`;
        return { ok: true, answer: out, action: null, meta: { routed: "sql", threadId: tid, sql: debug ? exec.sql : undefined, sqlRows: exec.rows?.length || 0 }, state: state || null };
      }
    }
  }

  // ===========================
  // LAST resort: old handlers
  // ===========================
  const planRes = await llmPlan({ question: routedQuestion, threadCtx: getThreadContext(tid) || {}, snapshot, authPresent: !!token, debug });
  if (!planRes.ok || !planRes.plan) {
    const r = await executePlannedQuestion({ rewriteQuestion: routedQuestion, snapshot, user, state, includeArchived: false });
    let answer = safeStr(r?.answer) || "No response.";
    if (debug) answer += `\n\n[Fallback: handlers]`;
    return { ok: r?.ok !== false, answer, action: r?.action || null, meta: { ...(r?.meta || {}), threadId: tid }, state: r?.state || state || null };
  }

  const plan = planRes.plan;
  if (plan.action === "clarify") {
    let answer = safeStr(plan.ask) || "Active only, or include archived?";
    if (debug) answer += `\n\n[AI Planner: ON • clarify • ${planRes.meta.model} • ${planRes.meta.ms}ms]`;
    return { ok: true, answer, action: null, meta: { routed: "llm_clarify", threadId: tid }, state: state || null };
  }

  const includeArchived = plan.includeArchived === true;
  const rewriteQuestion2 = safeStr(plan.rewriteQuestion) || routedQuestion;
  const r = await executePlannedQuestion({ rewriteQuestion: rewriteQuestion2, snapshot, user, state, includeArchived });

  let answer = safeStr(r?.answer) || "No response.";
  if (debug) answer += `\n\n[AI Planner: ON • execute • ${planRes.meta.model} • ${planRes.meta.ms}ms]`;
  return { ok: r?.ok !== false, answer, action: r?.action || null, meta: { ...(r?.meta || {}), threadId: tid }, state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null) };
}