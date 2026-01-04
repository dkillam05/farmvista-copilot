// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-04-handleChat-conversation3-normalize
//
// CHANGE:
// ✅ Adds global input normalization via /chat/normalize.js
//    - fixes common typos like "how mans"
//    - normalizes paging commands like "show more" -> "more"
// ✅ Normalization is applied BEFORE followups, interpreter, and routing.
// ✅ Adds meta.normalized + meta.normalizedRules when a rewrite occurs.
//
// Keeps:
// ✅ threadId / continuation passthrough
// ✅ paging followups
// ✅ conversation interpreter
// ✅ contextDelta persistence

'use strict';

import crypto from "crypto";
import { routeQuestion } from "./router.js";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

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

  // ✅ Normalize input once, globally
  const n = normalizeQuestion(qRaw0);
  const qRaw = safeStr(n?.text || qRaw0);

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  // If client sent a continuation, seed the followup store.
  try {
    if (continuation && typeof continuation === "object") {
      setContinuation(tid, continuation);
    }
  } catch {
    // ignore
  }

  const ctx = getThreadContext(tid) || {};

  // 1) Paging follow-ups first (after normalization)
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

  // 2) Conversational follow-ups (same thing but CRP/by county/etc.)
  let routedQuestion = qRaw;
  try {
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp && interp.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // 3) Route normally
  try {
    const r = await routeQuestion({ question: routedQuestion, snapshot, user, state });

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
        ...(routedQuestion !== qRaw ? { routedQuestion } : {}),
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
    };
  } catch (e) {
    return {
      ok: false,
      error: "chat_failed",
      answer: "Sorry — the chat service hit an error.",
      action: null,
      meta: {
        detail: safeStr(e?.message || e),
        threadId: tid,
        ...(n?.meta?.changed ? { normalized: qRaw, normalizedRules: n.meta.rules } : {})
      },
      state: state || null
    };
  }
}