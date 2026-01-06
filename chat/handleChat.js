// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql1
//
// Change:
// ✅ Build/ensure SQLite DB from snapshot
// ✅ OpenAI generates SELECT SQL
// ✅ Run SQL and format result
// ✅ Fallback to existing llmPlanner + executePlannedQuestion if SQL fails
//
// Keeps:
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

function formatRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "(no matches)";

  // If single scalar result
  if (rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) {
      const v = rows[0][keys[0]];
      return `${v}`;
    }
  }

  // Print key=value lines for up to 25 rows
  const max = Math.min(25, rows.length);
  const lines = [];
  for (let i = 0; i < max; i++) {
    const r = rows[i] || {};
    const parts = [];
    for (const [k, v] of Object.entries(r)) {
      parts.push(`${k}: ${v}`);
    }
    lines.push(`• ${parts.join(" • ")}`);
  }
  if (rows.length > max) lines.push(`…plus ${rows.length - max} more rows.`);
  return lines.join("\n");
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
        const answer = formatRows(exec.rows);

        let out = answer;
        if (debug) {
          out += `\n\n[AI SQL: ON • ${sqlPlan.meta.model} • ${sqlPlan.meta.ms}ms]`;
        }

        return {
          ok: true,
          answer: out,
          action: null,
          meta: {
            routed: "sql",
            threadId: tid,
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