// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-04-handleChat-llm2
//
// Adds OpenAI planning:
// ✅ OpenAI decides clarify vs execute and rewrites the question
// ✅ Deterministic execution uses snapshot-only handlers (no hallucinations)
// ✅ If scope is ambiguous, asks: "Active only, or include archived?" and stores pendingClarify
//
// Keeps:
// ✅ normalize.js
// ✅ followups.js paging
// ✅ followupInterpreter.js deterministic rewrites
// ✅ conversationStore context + delta
// ✅ threadId + continuation passthrough

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";
import { llmPlan } from "./llmPlanner.js";
import { executePlannedQuestion } from "./executePlannedQuestion.js";

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

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

export async function handleChat({
  question,
  snapshot,
  authHeader = "",
  state = null,
  threadId = "",
  continuation = null
}) {
  const qRaw0 = safeStr(question);
  const tid = safeStr(threadId) || makeThreadId();

  if (!qRaw0) {
    return {
      ok: false,
      error: "missing_question",
      answer: "Missing question.",
      action: null,
      meta: { intent: "chat", error: true, threadId: tid },
      state: state || null
    };
  }

  if (!snapshot?.ok || !snapshot?.json) {
    return {
      ok: false,
      error: snapshot?.error || "snapshot_not_loaded",
      answer: "Snapshot data isn’t available right now. Try /context/reload, then retry.",
      action: null,
      meta: { intent: "chat", error: true, snapshotOk: !!snapshot?.ok, threadId: tid },
      state: state || null
    };
  }

  // ✅ Normalize
  const n = normalizeQuestion(qRaw0);
  const qRaw = safeStr(n?.text || qRaw0);

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  // Seed continuation if provided
  try {
    if (continuation && typeof continuation === "object") {
      setContinuation(tid, continuation);
    }
  } catch {}

  const ctx = getThreadContext(tid) || {};

  // 1) Paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return {
        ok: fu?.ok !== false,
        answer: safeStr(fu?.answer) || "No response.",
        action: fu?.action || null,
        meta: {
          ...(fu?.meta || {}),
          threadId: tid,
          ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
        },
        state: state || null
      };
    }
  } catch {
    clearContinuation(tid);
  }

  // 2) Deterministic followup interpreter
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
    authPresent: !!token
  });

  // If planner fails, fallback to execute routedQuestion as-is (active only)
  if (!planRes.ok || !planRes.plan) {
    const r = await executePlannedQuestion({ rewriteQuestion: routedQuestion, snapshot, user, includeArchived: false });

    const cont = r?.meta?.continuation || null;
    if (cont) setContinuation(tid, cont);

    const delta = r?.meta?.contextDelta || null;
    if (delta) applyContextDelta(tid, delta);

    return {
      ok: r?.ok !== false,
      answer: safeStr(r?.answer) || "No response.",
      action: r?.action || null,
      meta: {
        ...(r?.meta || {}),
        threadId: tid,
        llm: { ok: false, error: planRes?.error || "planner_failed" },
        ...(routedQuestion !== qRaw ? { routedQuestion } : {}),
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: state || null
    };
  }

  const plan = planRes.plan;

  // 3a) Clarify
  if (plan.action === "clarify") {
    applyContextDelta(tid, {
      pendingClarify: {
        baseQuestion: safeStr(plan.rewriteQuestion || routedQuestion),
        asked: safeStr(plan.ask || "Active only, or include archived?")
      }
    });

    return {
      ok: true,
      answer: safeStr(plan.ask) || "Active only, or include archived?",
      action: null,
      meta: {
        routed: "llm_clarify",
        threadId: tid,
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: state || null
    };
  }

  // 3b) Execute
  const includeArchived = plan.includeArchived === true ? true : false;
  const rewriteQuestion = safeStr(plan.rewriteQuestion) || routedQuestion;

  const r = await executePlannedQuestion({ rewriteQuestion, snapshot, user, includeArchived });

  const cont = r?.meta?.continuation || null;
  if (cont) setContinuation(tid, cont);

  const delta = r?.meta?.contextDelta || null;
  if (delta) applyContextDelta(tid, delta);

  // clear pending clarify once we execute
  applyContextDelta(tid, { pendingClarify: null });

  return {
    ok: r?.ok !== false,
    answer: safeStr(r?.answer) || "No response.",
    action: r?.action || null,
    meta: {
      ...(r?.meta || {}),
      threadId: tid,
      planned: { includeArchived, rewriteQuestion },
      ...(routedQuestion !== qRaw ? { routedQuestion } : {}),
      ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
    },
    state: state || null
  };
}