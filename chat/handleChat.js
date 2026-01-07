// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql4-no-handler-for-fieldnum
//
// Change:
// ✅ Deterministic DB lookup for "Field #### RTK/tower" (NO handlers, NO OpenAI needed)
// ✅ If not matched, uses OpenAI -> SQL -> SQLite
// ✅ Clean output (Option A): bullets only; acres only if user asks
// ✅ SQL lists get continuation for "show all/more"
//
// Keeps:
// ✅ paging followups (/chat/followups.js)
// ✅ conversation interpreter (/chat/followupInterpreter.js)
// ✅ threadId / continuation passthrough
// ✅ debugAI footer
// ✅ OLD handler fallback kept as LAST resort (you can remove later)

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";

// old deterministic fallback (last resort)
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
   Output formatting (Option A)
========================= */
function userAskedForAcres(q) {
  const s = norm(q);
  return (
    s.includes("acres") ||
    s.includes("tillable") ||
    s.includes("with acres") ||
    s.includes("include acres") ||
    s.includes("including acres") ||
    s.includes("include tillable") ||
    s.includes("including tillable")
  );
}

function formatScalar(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) return `${rows[0][keys[0]]}`;
  }
  return null;
}

function pickLabelField(row) {
  if (!row || typeof row !== "object") return null;
  if (row.label != null) return "label";
  if (row.name != null) return "name";
  if (row.field != null) return "field";
  if (row.fieldName != null) return "fieldName";
  if (row.farm != null) return "farm";
  if (row.farmName != null) return "farmName";
  if (row.county != null) return "county";
  if (row.tower != null) return "tower";
  if (row.towerName != null) return "towerName";
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && v.trim()) return k;
  }
  return null;
}

function buildBullets({ rows, includeAcres }) {
  const lines = [];
  for (const r of rows) {
    const labelKey = pickLabelField(r);
    const label = labelKey ? String(r[labelKey] ?? "").trim() : "";
    if (!label) continue;

    let line = `• ${label}`;

    if (includeAcres) {
      const acres =
        (r.acres != null ? Number(r.acres) : null) ??
        (r.tillable != null ? Number(r.tillable) : null) ??
        (r.tillableAcres != null ? Number(r.tillableAcres) : null);

      if (Number.isFinite(acres)) {
        const a = acres.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        line += ` — ${a} ac`;
      }
    }

    lines.push(line);
  }
  return lines.length ? lines : ["(no matches)"];
}

function pageLines({ title, allLines, limit = 25 }) {
  const pageSize = Math.max(10, Math.min(80, Number(limit) || 25));
  const first = allLines.slice(0, pageSize);
  const remaining = allLines.length - first.length;

  const out = [];
  if (title) out.push(title);
  out.push(...first);
  if (remaining > 0) out.push(`…plus ${remaining} more.`);

  const continuation = (remaining > 0)
    ? { kind: "page", title: title || "", lines: allLines, offset: pageSize, pageSize: pageSize }
    : null;

  return { answer: out.join("\n"), continuation };
}

function formatSqlResult({ question, rows }) {
  const scalar = formatScalar(rows);
  if (scalar != null) return { answer: scalar, continuation: null };

  const includeAcres = userAskedForAcres(question);
  const allLines = buildBullets({ rows, includeAcres });
  return pageLines({ title: "", allLines, limit: 25 });
}

/* =========================
   Deterministic DB primitives (NO handlers)
========================= */

// field number like 1323 or "field 1323"
function extractFieldNumber(q) {
  const s = norm(q);
  let m = s.match(/\bfield\s+(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);

  m = s.match(/\b(\d{3,4})\b/);
  if (m) return parseInt(m[1], 10);

  return null;
}

function isRtkTowerQuestion(q) {
  const s = norm(q);
  return s.includes("rtk") || s.includes("tower");
}

function runFieldTowerLookup(db, fieldNum) {
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
      AND (fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive'))
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

  // ensure DB for current snapshot
  let dbInfo = null;
  try { dbInfo = ensureDbFromSnapshot(snapshot); } catch (e) { dbInfo = { ok: false, error: safeStr(e?.message || e) }; }

  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  const ctx = getThreadContext(tid) || {};

  // 1) paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return {
        ok: fu?.ok !== false,
        answer: safeStr(fu?.answer) || "No response.",
        action: fu?.action || null,
        meta: { ...(fu?.meta || {}), threadId: tid },
        state: state || null
      };
    }
  } catch {
    clearContinuation(tid);
  }

  // 2) deterministic followup interpreter
  let routedQuestion = qRaw;
  try {
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp && interp.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // ✅ 2.5) Deterministic DB lookup for FIELD #### tower questions (no OpenAI, no handlers)
  if (dbInfo?.ok && getDb() && isRtkTowerQuestion(routedQuestion)) {
    const fn = extractFieldNumber(routedQuestion);
    if (fn != null) {
      const exec = runFieldTowerLookup(getDb(), fn);
      if (exec.ok && exec.rows && exec.rows.length) {
        const formatted = formatSqlResult({ question: routedQuestion, rows: exec.rows });

        let out = safeStr(formatted.answer) || "(no response)";
        if (debug) out += `\n\n[DB Lookup: field_num → tower]`;

        return {
          ok: true,
          answer: out,
          action: null,
          meta: {
            routed: "db_field_tower",
            threadId: tid,
            continuation: formatted.continuation || null,
            sqlRows: exec.rows.length,
            sql: debug ? exec.sql : undefined
          },
          state: state || null
        };
      }
      // If no match, continue to OpenAI→SQL (maybe the field number wasn't the real ID)
    }
  }

  // 3) OpenAI -> SQL -> DB
  if (dbInfo?.ok && getDb()) {
    const sqlPlan = await planSql({ question: routedQuestion, debug });

    if (sqlPlan.ok && sqlPlan.sql) {
      const exec = runSql({ db: getDb(), sql: sqlPlan.sql, limitDefault: 80 });

      if (exec.ok) {
        const formatted = formatSqlResult({ question: routedQuestion, rows: exec.rows || [] });

        let out = safeStr(formatted.answer) || "(no response)";
        if (debug) out += `\n\n[AI SQL: ON • ${sqlPlan.meta.model} • ${sqlPlan.meta.ms}ms]`;

        return {
          ok: true,
          answer: out,
          action: null,
          meta: {
            routed: "sql",
            threadId: tid,
            continuation: formatted.continuation || null,
            sql: debug ? exec.sql : undefined,
            sqlRows: exec.rows?.length || 0
          },
          state: state || null
        };
      }
    }
  }

  // 4) LAST resort: old planner/handlers
  const planRes = await llmPlan({
    question: routedQuestion,
    threadCtx: getThreadContext(tid) || {},
    snapshot,
    authPresent: !!token,
    debug
  });

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

  return {
    ok: r?.ok !== false,
    answer,
    action: r?.action || null,
    meta: { ...(r?.meta || {}), threadId: tid },
    state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
  };
}