// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-04-handleChat-conversation4-openai-planning
//
// Adds:
// ✅ OpenAI planning step (llmPlanner) after normalize+followups+followupInterpreter
// ✅ Deterministic execution via executePlannedQuestion (snapshot-only)
// ✅ Scope clarification (active vs archived) via pendingClarify + followupInterpreter
// ✅ Debug meta.aiPlanner and optional answer footer when FV_AI_DEBUG=1
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

function envBool(name) {
  const v = safeStr(process.env[name]);
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
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
  const aiDebug = envBool("FV_AI_DEBUG");

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

  // Seed continuation if client sent it
  try {
    if (continuation && typeof continuation === "object") setContinuation(tid, continuation);
  } catch {}

  const ctx = getThreadContext(tid) || {};

  // 1) Paging followups first
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

  // 2) Deterministic followup interpreter (same thing but…)
  let routedQuestion = qRaw;
  try {
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp && interp.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // 3) OpenAI planning
  const planRes = await llmPlan({
    question: routedQuestion,
    threadCtx: getThreadContext(tid) || {},
    snapshot,
    authPresent: !!token
  });

  // If planner failed, fallback to deterministic execution (active only)
  if (!planRes.ok || !planRes.plan) {
    const r = await executePlannedQuestion({
      rewriteQuestion: routedQuestion,
      snapshot,
      user,
      state,
      includeArchived: false
    });

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
        aiPlanner: { used: planRes?.meta?.used || false, ok: false, model: planRes?.meta?.model || null, ms: planRes?.meta?.ms || 0, error: planRes?.error || "planner_failed" },
        ...(routedQuestion !== qRaw ? { routedQuestion } : {}),
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
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

    const msg = safeStr(plan.ask) || "Active only, or include archived?";
    const answer = aiDebug ? `${msg}\n\n[AI: ON • clarify • ${planRes.meta.model} • ${planRes.meta.ms}ms]` : msg;

    return {
      ok: true,
      answer,
      action: null,
      meta: {
        routed: "llm_clarify",
        threadId: tid,
        aiPlanner: { used: true, ok: true, model: planRes.meta.model, ms: planRes.meta.ms, action: "clarify", includeArchived: plan.includeArchived ?? null, rewriteQuestion: plan.rewriteQuestion, reason: plan.reason || null },
        ...(aiDebug && planRes.meta.plan ? { aiPlan: planRes.meta.plan } : {}),
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: state || null
    };
  }

  // 3b) Execute
  const includeArchived = plan.includeArchived === true ? true : false;
  const rewriteQuestion = safeStr(plan.rewriteQuestion) || routedQuestion;

  const r = await executePlannedQuestion({
    rewriteQuestion,
    snapshot,
    user,
    state,
    includeArchived
  });

  const cont = r?.meta?.continuation || null;
  if (cont) setContinuation(tid, cont);

  const delta = r?.meta?.contextDelta || null;
  if (delta) applyContextDelta(tid, delta);

  applyContextDelta(tid, { pendingClarify: null });

  let answer = safeStr(r?.answer) || "No response.";
  if (aiDebug) {
    answer += `\n\n[AI: ON • execute • ${planRes.meta.model} • ${planRes.meta.ms}ms]`;
  }

  return {
    ok: r?.ok !== false,
    answer,
    action: r?.action || null,
    meta: {
      ...(r?.meta || {}),
      threadId: tid,
      aiPlanner: { used: true, ok: true, model: planRes.meta.model, ms: planRes.meta.ms, action: "execute", includeArchived, rewriteQuestion, reason: plan.reason || null },
      ...(aiDebug && planRes.meta.plan ? { aiPlan: planRes.meta.plan } : {}),
      ...(routedQuestion !== qRaw ? { routedQuestion } : {}),
      ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
    },
    state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
  };
}