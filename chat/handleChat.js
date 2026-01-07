// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql7-fieldtower-real
//
// Fixes your exact broken thread:
// ✅ "RTK tower for field 710" returns tower details (not just field label)
// ✅ Saves lastEntity=tower so follow-ups like "info from that RTK tower" work
// ✅ DB-first for field->tower (number OR name), no handlers needed
// ✅ Clean output: no tips, no giant tower list unless asked
//
// Keeps:
// ✅ paging followups (/chat/followups.js)
// ✅ followupInterpreter (/chat/followupInterpreter.js)
// ✅ OpenAI->SQL fallback for other questions
// ✅ handlers fallback as LAST resort

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
   Detect question types
========================= */
function isRtkTowerQuestion(q) {
  const s = norm(q);
  return s.includes("rtk") || s.includes("tower");
}
function mentionsField(q) {
  return norm(q).includes("field");
}
function extractFieldNumber(q) {
  const s = norm(q);
  let m = s.match(/\bfield\s+(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/\b(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}
function extractFieldNamePhrase(q) {
  const s = (q || "").toString();
  let m = s.match(/\bfield\s+(.+?)(?:\brtk\b|\btower\b|\binfo\b|\binformation\b|\buse\b|\buses\b|\busing\b|\bassigned\b|$)/i);
  if (m && m[1]) return m[1].toString().trim().replace(/\b(rtK|tower|info|information|use|uses|using|assigned)\b.*$/i, "").trim();
  return "";
}
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
function activeFieldsWhere() {
  return "(fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive'))";
}

/* =========================
   Output formatting (clean)
========================= */
function formatFieldTowerRow(row) {
  const r = row || {};
  const out = [];

  out.push(`Field: ${r.field || "(unknown)"}`);
  if (r.farm) out.push(`Farm: ${r.farm}`);
  if (r.county) out.push(`County: ${r.county}${r.state ? ", " + r.state : ""}`);

  out.push(`RTK tower: ${r.tower ? r.tower : "(none assigned)"}`);
  if (r.frequencyMHz) out.push(`Frequency: ${r.frequencyMHz} MHz`);
  if (r.networkId != null && String(r.networkId).trim() !== "") out.push(`Network ID: ${r.networkId}`);

  return out.join("\n");
}

function formatSqlResult({ question, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return { answer: "(no matches)", continuation: null };

  // single scalar
  if (rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) return { answer: String(rows[0][keys[0]]), continuation: null };
  }

  // If it looks like our field->tower projection, show block
  if (rows.length >= 1) {
    const r0 = rows[0] || {};
    if ("field" in r0 && ("tower" in r0 || "frequencyMHz" in r0 || "networkId" in r0)) {
      // If multiple matches, show first 3 blocks
      const blocks = [];
      const take = Math.min(3, rows.length);
      for (let i = 0; i < take; i++) blocks.push(formatFieldTowerRow(rows[i]));
      if (rows.length > take) blocks.push(`(…plus ${rows.length - take} more matches)`);
      return { answer: blocks.join("\n\n"), continuation: null };
    }
  }

  // default: bullets on label/name/field/etc.
  const lines = [];
  for (const r of rows) {
    const label = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? "").toString().trim();
    if (!label) continue;
    lines.push(`• ${label}`);
  }
  return { answer: lines.length ? lines.join("\n") : "(no matches)", continuation: null };
}

/* =========================
   Deterministic DB lookups: field -> tower
========================= */
function runFieldTowerLookupByNumber(db, fieldNum) {
  const n = Number(fieldNum);
  if (!Number.isFinite(n)) return { ok: false, rows: [] };

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

function runFieldTowerLookupByName(db, phrase) {
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

  // ✅ DB-first: field -> tower (number OR name)
  if (dbInfo?.ok && getDb() && isRtkTowerQuestion(routedQuestion) && mentionsField(routedQuestion)) {
    const db = getDb();

    const fn = extractFieldNumber(routedQuestion);
    let ex = null;

    if (fn != null) ex = runFieldTowerLookupByNumber(db, fn);
    if (!ex || !ex.ok || !ex.rows || ex.rows.length === 0) {
      const phrase = extractFieldNamePhrase(routedQuestion);
      if (phrase) ex = runFieldTowerLookupByName(db, phrase);
    }

    if (ex && ex.ok && ex.rows && ex.rows.length) {
      // store last tower for followups
      const r0 = ex.rows[0] || {};
      const towerName = (r0.tower || "").toString().trim();
      const fieldName = (r0.field || "").toString().trim();

      applyContextDelta(tid, {
        lastIntent: "field_tower_lookup",
        lastEntity: towerName ? { type: "tower", id: towerName, name: towerName } : null,
        lastField: fieldName ? { id: fieldName, name: fieldName } : null,
        lastScope: { includeArchived: false }
      });

      const formatted = formatSqlResult({ question: routedQuestion, rows: ex.rows });
      let out = safeStr(formatted.answer) || "(no response)";
      if (debug) out += `\n\n[DB Lookup: field → tower]`;

      return { ok: true, answer: out, action: null, meta: { routed: "db_field_tower", threadId: tid, sql: debug ? ex.sql : undefined }, state: state || null };
    }
  }

  // OpenAI -> SQL -> DB
  if (dbInfo?.ok && getDb()) {
    const sqlPlan = await planSql({ question: routedQuestion, debug });
    if (sqlPlan.ok && sqlPlan.sql) {
      const exec = runSql({ db: getDb(), sql: sqlPlan.sql, limitDefault: 80 });
      if (exec.ok) {
        const formatted = formatSqlResult({ question: routedQuestion, rows: exec.rows || [] });
        let out = safeStr(formatted.answer) || "(no response)";
        if (debug) out += `\n\n[AI SQL: ON • ${sqlPlan.meta.model} • ${sqlPlan.meta.ms}ms]`;
        return { ok: true, answer: out, action: null, meta: { routed: "sql", threadId: tid, sql: debug ? exec.sql : undefined, sqlRows: exec.rows?.length || 0 }, state: state || null };
      }
    }
  }

  // LAST resort: old handlers
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