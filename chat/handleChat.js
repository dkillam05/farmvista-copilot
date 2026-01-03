// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-03-handleChat-followups1
//
// Chat entry point:
// - validates snapshot is loaded
// - generates/returns threadId (backend-owned)
// - checks global followups BEFORE routing
// - routes question through the deterministic router
//
// IMPORTANT:
// - Must export NAMED function: handleChat
//   because index.js imports: import { handleChat } from "./chat/handleChat.js";

'use strict';

import crypto from "crypto";
import { routeQuestion } from "./router.js";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";

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
  try {
    return crypto.randomUUID();
  } catch {
    // fallback
    return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  }
}

export async function handleChat({
  question,
  snapshot,
  authHeader = "",
  state = null,
  threadId = ""
}) {
  const q = safeStr(question);
  const tid = safeStr(threadId) || makeThreadId();

  if (!q) {
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

  // 1) Global follow-ups first (paging / "the rest" / "more" / "all")
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: q });
    if (fu) {
      return {
        ok: fu?.ok !== false,
        answer: safeStr(fu?.answer) || "No response.",
        action: fu?.action || null,
        meta: { ...(fu?.meta || {}), threadId: tid },
        state: state || null
      };
    }
  } catch (e) {
    // If followups fail, do not block routing; just clear the stored continuation
    clearContinuation(tid);
  }

  // 2) Route normally
  try {
    const r = await routeQuestion({ question: q, snapshot, user, state });

    // If handler supplies continuation, store it globally
    // expected shape: r.meta.continuation
    const cont = r?.meta?.continuation || null;
    if (cont) setContinuation(tid, cont);

    return {
      ok: r?.ok !== false,
      answer: safeStr(r?.answer) || "No response.",
      action: r?.action || null,
      meta: { ...(r?.meta || {}), threadId: tid },
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