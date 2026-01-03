// /chat/followups.js  (FULL FILE)
// Rev: 2026-01-03-followups-global1
//
// Global follow-up memory keyed by threadId.
// Stores a single "continuation" per thread:
// - paging ("more", "next", "rest", "all", "remaining")
// - no per-handler follow-up parsing
//
// Continuation shape:
// {
//   kind: "page",
//   title: "Farm totals (active only):",
//   lines: [ "• ...", ... ],
//   offset: 0,
//   pageSize: 10
// }

'use strict';

const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const STORE = new Map(); // threadId -> { cont, exp }

function nowMs() { return Date.now(); }

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function cleanExpired() {
  const t = nowMs();
  for (const [k, v] of STORE.entries()) {
    if (!v || !v.exp || v.exp <= t) STORE.delete(k);
  }
}

export function setContinuation(threadId, cont) {
  cleanExpired();
  const id = (threadId || "").toString().trim();
  if (!id) return;

  if (!cont) {
    STORE.delete(id);
    return;
  }

  STORE.set(id, { cont, exp: nowMs() + TTL_MS });
}

export function getContinuation(threadId) {
  cleanExpired();
  const id = (threadId || "").toString().trim();
  if (!id) return null;
  const rec = STORE.get(id);
  return rec ? rec.cont : null;
}

export function clearContinuation(threadId) {
  const id = (threadId || "").toString().trim();
  if (!id) return;
  STORE.delete(id);
}

function wantsMore(q) {
  const s = norm(q);
  if (!s) return false;

  // common followups
  if (s === "more" || s === "next" || s === "rest" || s === "remaining") return true;
  if (s.includes("the rest")) return true;
  if (s.includes("show more")) return true;
  if (s.includes("more farms")) return true;
  if (s.includes("more counties")) return true;
  if (s.includes("the 11 more")) return true;
  if (s.includes("the other")) return true;
  if (s.includes("keep going")) return true;

  // "can you tell me the 11 more farms"
  if (s.includes("11") && s.includes("more")) return true;

  return false;
}

function wantsAll(q) {
  const s = norm(q);
  if (!s) return false;

  if (s === "all") return true;
  if (s.includes("show all")) return true;
  if (s.includes("list all")) return true;
  if (s.includes("all of them")) return true;
  if (s.includes("everything")) return true;

  return false;
}

function pageFromContinuation(cont, mode) {
  const lines = Array.isArray(cont?.lines) ? cont.lines : [];
  const title = (cont?.title || "").toString();
  const pageSize = Math.max(5, Math.min(50, Number(cont?.pageSize) || 10));
  let offset = Math.max(0, Number(cont?.offset) || 0);

  if (!lines.length) {
    return { ok: false, answer: "Please check /chat/followups.js — continuation is empty." };
  }

  let slice;
  if (mode === "all") {
    slice = lines.slice(offset);
    offset = lines.length;
  } else {
    slice = lines.slice(offset, offset + pageSize);
    offset = offset + slice.length;
  }

  const remaining = Math.max(0, lines.length - offset);
  const moreLine = remaining
    ? `…plus ${remaining} more.`
    : null;

  const out = [];
  if (title) out.push(title);
  out.push(...slice);
  if (moreLine) out.push(moreLine);

  const next = { ...cont, offset };
  const done = offset >= lines.length;

  return { ok: true, answer: out.join("\n"), next, done };
}

export function tryHandleFollowup({ threadId, question }) {
  cleanExpired();

  const q = norm(question);
  if (!q) return null;

  const cont = getContinuation(threadId);
  if (!cont) return null;

  const all = wantsAll(q);
  const more = wantsMore(q);

  if (!all && !more) return null;

  const res = pageFromContinuation(cont, all ? "all" : "page");
  if (!res.ok) {
    clearContinuation(threadId);
    return { ok: false, answer: res.answer, meta: { followup: true, source: "/chat/followups.js" } };
  }

  if (res.done) clearContinuation(threadId);
  else setContinuation(threadId, res.next);

  return {
    ok: true,
    answer: res.answer,
    meta: { followup: true, source: "/chat/followups.js", done: !!res.done }
  };
}