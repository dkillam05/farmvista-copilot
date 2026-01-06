// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql2-clean-output
//
// Change:
// ✅ Clean output formatting for SQL results (Option A style):
//    - counts/sums => single number / single line
//    - list queries => bullets only (no key:value spam)
//    - default: hide acres unless user asked for acres/tillable
// ✅ Paging for SQL lists via meta.continuation so "show all / more" works globally
//
// Keeps:
// ✅ Build/ensure SQLite DB from snapshot
// ✅ OpenAI generates SELECT SQL
// ✅ Run SQL and format result
// ✅ Fallback to existing llmPlanner + executePlannedQuestion if SQL fails
// ✅ paging followups (/chat/followups.js)
// ✅ conversation interpreter (/chat/followupInterpreter.js)
// ✅ threadId / continuation passthrough
// ✅ debugAI footer

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";

// existing deterministic fallback
import { llmPlan } from "./llmPlanner.js";
import { executePlannedQuestion } from "./executePlannedQuestion.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

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

function norm(s) { return (s || "").toString().trim().toLowerCase(); }

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

function looksLikeListQuery(q) {
  const s = norm(q);
  return (
    s.startsWith("list") ||
    s.startsWith("show") ||
    s.includes("list ") ||
    s.includes("show ") ||
    s.includes("fields in") ||
    s.includes("fields on") ||
    s.includes("farms") ||
    s.includes("counties") ||
    s.includes("towers")
  );
}

// Prefer readable label fields
function pickLabelField(row) {
  if (!row || typeof row !== "object") return null;

  // common
  if (row.label != null) return "label";
  if (row.name != null) return "name";
  if (row.field != null) return "field";
  if (row.fieldName != null) return "fieldName";
  if (row.farm != null) return "farm";
  if (row.farmName != null) return "farmName";
  if (row.county != null) return "county";
  if (row.tower != null) return "tower";
  if (row.towerName != null) return "towerName";

  // fallback: first stringy field
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && v.trim()) return k;
  }
  return null;
}

function formatScalar(rows) {
  if (!Array.isArray(rows) || !rows.length) return "(no matches)";

  if (rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) {
      const v = rows[0][keys[0]];
      return `${v}`;
    }
  }

  return null;
}

// Build a bullet list (Option A): bullets only; acres only if asked and present
function buildBullets({ rows, includeAcres }) {
  const lines = [];
  for (const r of rows) {
    const labelKey = pickLabelField(r);
    const label = labelKey ? String(r[labelKey] ?? "").trim() : "";
    if (!label) continue;

    let line = `• ${label}`;

    if (includeAcres) {
      // try common acres columns
      const acres =
        (r.acres != null ? Number(r.acres) : null) ??
        (r.tillable != null ? Number(r.tillable) : null) ??
        (r.tillableAcres != null ? Number(r.tillableAcres) : null);

      if (Number.isFinite(acres)) {
        // show with up to 2 decimals, no trailing junk
        const a = acres.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        line += ` — ${a} ac`;
      }
    }

    lines.push(line);
  }

  if (!lines.length) return ["(no matches)"];
  return lines;
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
    ? { kind: "page", title: title || "", lines: allLines, offset: pageSize, pageSize }
    : null;

  return { answer: out.join("\n"), continuation };
}

function formatSqlResult({ question, rows }) {
  const scalar = formatScalar(rows);
  if (scalar != null) {
    // single value answer
    return { answer: scalar, continuation: null };
  }

  const includeAcres = userAskedForAcres(question);
  const allLines = buildBullets({ rows, includeAcres });

  // For lists: show up to 25 by default (paging handled by followups.js)
  const title = ""; // Option A: no extra header unless you want it later
  return pageLines({ title, allLines, limit: 25 });
}

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

  const n = normalizeQuestion(qRaw0);
  const qRaw = safeStr(n?.text || qRaw0);

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

  // 3) SQL path (best answers)
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

  // 4) fallback: your current planner/handlers
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
    if (debug) answer += `\n\n[AI Planner fallback: ON (SQL failed)]`;
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

  const cont = r?.meta?.continuation || null;
  if (cont) setContinuation(tid, cont);

  const delta = r?.meta?.contextDelta || null;
  if (delta) applyContextDelta(tid, delta);

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