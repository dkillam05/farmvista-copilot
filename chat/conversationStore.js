// /chat/conversationStore.js  (FULL FILE)
// Rev: 2026-01-09-conversationStore2-aliases
//
// Global per-thread conversation context (12h TTL).
// Stores one context object per threadId.
// This is deterministic memory (NOT AI).
//
// Adds (non-breaking):
// ✅ Aliases for simpler callers:
//    - getThread()  -> getThreadContext()
//    - setThread()  -> setThreadContext()
//    - clearThread()-> clearThreadContext()
//
// Keeps:
// ✅ deepClone / deepMerge / applyContextDelta semantics unchanged

'use strict';

const TTL_MS = 12 * 60 * 60 * 1000;
const STORE = new Map(); // threadId -> { ctx, exp }

function nowMs() { return Date.now(); }

function cleanExpired() {
  const t = nowMs();
  for (const [k, v] of STORE.entries()) {
    if (!v || !v.exp || v.exp <= t) STORE.delete(k);
  }
}

function deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj || {})); } catch { return {}; }
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, delta) {
  const out = deepClone(base || {});
  if (!isPlainObject(delta)) return out;

  for (const [k, v] of Object.entries(delta)) {
    if (v === null) {
      // explicit clear
      delete out[k];
      continue;
    }
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function getThreadContext(threadId) {
  cleanExpired();
  const id = (threadId || "").toString().trim();
  if (!id) return null;
  const rec = STORE.get(id);
  return rec ? deepClone(rec.ctx) : null;
}

export function setThreadContext(threadId, ctx) {
  cleanExpired();
  const id = (threadId || "").toString().trim();
  if (!id) return;
  STORE.set(id, { ctx: deepClone(ctx || {}), exp: nowMs() + TTL_MS });
}

export function applyContextDelta(threadId, delta) {
  cleanExpired();
  const id = (threadId || "").toString().trim();
  if (!id) return;

  const cur = getThreadContext(id) || {};
  const next = deepMerge(cur, delta || {});
  STORE.set(id, { ctx: next, exp: nowMs() + TTL_MS });
}

export function clearThreadContext(threadId) {
  const id = (threadId || "").toString().trim();
  if (!id) return;
  STORE.delete(id);
}

/* =========================================================
   Compatibility aliases (non-breaking)
========================================================= */

export function getThread(threadId) {
  return getThreadContext(threadId);
}

export function setThread(threadId, data) {
  return setThreadContext(threadId, data);
}

export function clearThread(threadId) {
  return clearThreadContext(threadId);
}