// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-handleChat-router1
//
// Chat entry point:
// - validates snapshot is loaded
// - (optional) notes auth header presence (token verification can be added later)
// - routes question through the deterministic router
//
// Returns a stable shape:
//   { ok, answer, action?, meta? }

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
    return { ok: false, error: "missing_question", answer: "Missing question." };
  }

  // Snapshot loader returns an object like { ok, json, ...meta }
  if (!snapshot?.ok || !snapshot?.json) {
    return {
      ok: false,
      error: snapshot?.error || "snapshot_not_loaded",
      answer: "Snapshot not loaded. Try /context/reload and then ask again.",
      meta: { snapshotOk: !!snapshot?.ok }
    };
  }

  // For now we do NOT verify the token here (keeps this minimal & non-breaking).
  // We pass a small user context object so handlers can evolve later.
  const token = extractBearer(authHeader);
  const user = token ? { hasAuth: true } : null;

  try {
    const r = await routeQuestion({ question: q, snapshot, user });

    // Normalize router output
    const ok = (r && typeof r === "object") ? (r.ok !== false) : true;

    return {
      ok,
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