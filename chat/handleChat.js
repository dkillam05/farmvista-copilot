// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-03-handleChat-conversation1
//
// Chat entry point:
// - validates snapshot is loaded
// - generates/returns threadId (backend-owned if not provided)
// - checks global paging followups BEFORE routing (more/rest/all)
// - checks global conversational followups BEFORE routing (same thing but CRP/by county/etc.)
// - routes question
// - stores global continuation + contextDelta
//
// IMPORTANT:
// - Must export NAMED function: handleChat
//   because index.js imports: import { handleChat } from "./chat/handleChat.js";

'use strict';

import crypto from "crypto";
import { routeQuestion } from "./router.js";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";

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
  threadId = ""
}) {
  const qRaw = safeStr(question);
  const tid = safeStr(threadId) || makeThreadId();

  if (!qRaw) {
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

  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  // 0) Load per-thread context (may be null)
  const ctx = getThreadContext(tid) || {};

  // 1) Paging follow-ups first (more/rest/all)
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

  // 2) Conversational follow-ups (same thing but CRP/by county/etc.)
  let routedQuestion = qRaw;
  try {
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp && interp.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {
    // do nothing; route raw question
  }

  // 3) Route normally
  try {
    const r = await routeQuestion({ question: routedQuestion, snapshot, user, state });

    // Store continuation (paging) if provided
    const cont = r?.meta?.continuation || null;
    if (cont) setContinuation(tid, cont);

    // Store contextDelta if provided
    const delta = r?.meta?.contextDelta || null;
    if (delta) applyContextDelta(tid, delta);

    return {
      ok: r?.ok !== false,
      answer: safeStr(r?.answer) || "No response.",
      action: r?.action || null,
      meta: { ...(r?.meta || {}), threadId: tid, routedQuestion: routedQuestion !== qRaw ? routedQuestion : undefined },
      state: Object.prototype.hasOwnProperty.call(r || {}, "state") ? (r.state || null) : (state || null)
    };
  } catch (e) {
    return {
      ok: false,
      error: "chat_failed",
      answer: "Sorry — the chat service hit an error.",
      action: null,
      meta: { detail: safeStr(e?.message || e), threadId: tid },
      state: state || null
    };
  }
}