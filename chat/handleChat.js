// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-04-handleChat-conversation5-openai-planning-requestdebug
//
// Adds:
// ✅ OpenAI planning (llmPlanner) with request-controlled debugAI
// ✅ Visible footer when debugAI=true (no Cloud Run env required)
// ✅ pendingClarify stored in conversationStore for scope follow-up replies
//
// Keeps:
// ✅ normalize
// ✅ paging followups + continuation
// ✅ followupInterpreter
// ✅ contextDelta persistence

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";
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

function boolish(v) {
  const s = safeStr(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
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

  // normalize
  const n = normalizeQuestion(qRaw0);
  const qRaw = safeStr(n?.text || qRaw0);

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  // seed continuation if provided
  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  const ctx = getThreadContext(tid) || {};

  // 1) paging followups first
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return {
        ok: fu?.ok !== false,
        answer: safeStr(fu?.answer) || "No response.",
        action: fu?.action || null,
        meta: { ...(fu?.meta || {}), threadId: tid, ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {}) },
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

  // 3) OpenAI plan
  const planRes = await llmPlan({
    question: routedQuestion,
    threadCtx: getThreadContext(tid) || {},
    snapshot,
    authPresent: !!token,
    debug
  });

  // planner failed -> fallback execute without planner
  if (!planRes.ok || !planRes.plan) {
    const r = await executePlannedQuestion({ rewriteQuestion: routedQuestion, snapshot, user, state, includeArchived: false });

    const cont = r?.meta?.continuation || null;
    if (cont) setContinuation(tid, cont);

    const delta = r?.meta?.contextDelta || null;
    if (delta) applyContextDelta(tid, delta);

    let answer = safeStr(r?.answer) || "No response.";
    if (debug) {
      answer += `\n\n[AI Planner: OFF • ${planRes?.meta?.error || planRes?.error || "planner_failed"}]`;
    }

    return {
      ok: r?.ok !== false,
      answer,
      action: r?.action || null,
      meta: {
        ...(r?.meta || {}),
        threadId: tid,
        aiPlanner: planRes.meta,
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
    };
  }

  const plan = planRes.plan;

  // 3a) clarify
  if (plan.action === "clarify") {
    applyContextDelta(tid, {
      pendingClarify: { baseQuestion: safeStr(plan.rewriteQuestion || routedQuestion), asked: safeStr(plan.ask) }
    });

    let answer = safeStr(plan.ask) || "Active only, or include archived?";
    if (debug) {
      answer += `\n\n[AI Planner: ON • clarify • ${planRes.meta.model} • ${planRes.meta.ms}ms]`;
    }

    return {
      ok: true,
      answer,
      action: null,
      meta: {
        routed: "llm_clarify",
        threadId: tid,
        aiPlanner: { ...planRes.meta, action: "clarify", includeArchived: plan.includeArchived ?? null, rewriteQuestion: plan.rewriteQuestion }
      },
      state: state || null
    };
  }

  // 3b) execute
  const includeArchived = plan.includeArchived === true;
  const rewriteQuestion = safeStr(plan.rewriteQuestion) || routedQuestion;

  const r = await executePlannedQuestion({ rewriteQuestion, snapshot, user, state, includeArchived });

  const cont = r?.meta?.continuation || null;
  if (cont) setContinuation(tid, cont);

  const delta = r?.meta?.contextDelta || null;
  if (delta) applyContextDelta(tid, delta);

  applyContextDelta(tid, { pendingClarify: null });

  let answer = safeStr(r?.answer) || "No response.";
  if (debug) {
    answer += `\n\n[AI Planner: ON • execute • ${planRes.meta.model} • ${planRes.meta.ms}ms]`;
  }

  return {
    ok: r?.ok !== false,
    answer,
    action: r?.action || null,
    meta: {
      ...(r?.meta || {}),
      threadId: tid,
      aiPlanner: { ...planRes.meta, action: "execute", includeArchived, rewriteQuestion }
    },
    state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
  };
}