// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-03-handleChat-router2
//
// Chat entry point:
// - validates snapshot is loaded
// - routes question through the deterministic router
// - returns stable response shape
//
// IMPORTANT:
// - Must export NAMED function: handleChat
//   because index.js imports: import { handleChat } from "./chat/handleChat.js";

'use strict';

import { routeQuestion } from "./router.js";

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function extractBearer(authHeader) {
  const h = safeStr(authHeader);
  if (!h) return "";
  const m = h.match(/^bearer\s+(.+)$/i);
  return m ? safeStr(m[1]) : "";
}

export async function handleChat({ question, snapshot, authHeader = "" }) {
  const q = safeStr(question);

  if (!q) {
    return { ok: false, error: "missing_question", answer: "Missing question.", meta: { intent: "chat", error: true } };
  }

  // snapshot loader returns { ok, json, ... }
  if (!snapshot?.ok || !snapshot?.json) {
    return {
      ok: false,
      error: snapshot?.error || "snapshot_not_loaded",
      answer: "Snapshot data isn’t available right now. Try /context/reload, then retry.",
      meta: { intent: "chat", error: true, snapshotOk: !!snapshot?.ok }
    };
  }

  // For now we don’t verify token here; we just pass a minimal user context forward.
  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  try {
    const r = await routeQuestion({ question: q, snapshot, user });

    return {
      ok: r?.ok !== false,
      answer: safeStr(r?.answer) || "No response.",
      action: r?.action || null,
      meta: r?.meta || {}
    };
  } catch (e) {
    return {
      ok: false,
      error: "chat_failed",
      answer: "Sorry — the chat service hit an error.",
      meta: { detail: safeStr(e?.message || e) }
    };
  }
}
