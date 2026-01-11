// /chat/contextStore.js  (FULL FILE)
// Rev: 2026-01-11-contextStore1
//
// Generic conversation memory keyed by threadId.
// Stores:
// - last_list: ordered items for "number 5" follow-ups
// - last_selection: last chosen entity (farm/field/tower/etc)
// - pending_disambiguation: candidates for yes/no
//
// In-memory only (per instance), TTL-based.

'use strict';

const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (matches your UX goal)

const STORE = new Map(); // threadId -> { lastList, lastSelection, pending, updatedAt }

function nowMs() { return Date.now(); }

function getBucket(threadId) {
  if (!threadId) return null;
  const cur = STORE.get(threadId);
  if (cur && (nowMs() - (cur.updatedAt || 0)) <= TTL_MS) return cur;

  const fresh = { lastList: null, lastSelection: null, pending: null, updatedAt: nowMs() };
  STORE.set(threadId, fresh);
  return fresh;
}

export function pruneContextStore() {
  const now = nowMs();
  for (const [k, v] of STORE.entries()) {
    if (!v?.updatedAt || (now - v.updatedAt) > TTL_MS) STORE.delete(k);
  }
}

export function setLastList(threadId, listType, items) {
  const b = getBucket(threadId);
  if (!b) return;
  b.lastList = {
    type: String(listType || ""),
    items: Array.isArray(items) ? items : [],
    createdAt: nowMs()
  };
  b.updatedAt = nowMs();
}

export function getLastList(threadId) {
  const b = getBucket(threadId);
  return b?.lastList || null;
}

export function setLastSelection(threadId, selType, item) {
  const b = getBucket(threadId);
  if (!b) return;
  b.lastSelection = {
    type: String(selType || ""),
    item: item || null,
    createdAt: nowMs()
  };
  b.updatedAt = nowMs();
}

export function getLastSelection(threadId) {
  const b = getBucket(threadId);
  return b?.lastSelection || null;
}

export function setPending(threadId, pending) {
  const b = getBucket(threadId);
  if (!b) return;
  b.pending = pending || null; // { kind, query, candidates:[{id,name,score}], originalText, createdAt }
  b.updatedAt = nowMs();
}

export function getPending(threadId) {
  const b = getBucket(threadId);
  return b?.pending || null;
}

export function clearPending(threadId) {
  const b = getBucket(threadId);
  if (!b) return;
  b.pending = null;
  b.updatedAt = nowMs();
}

export function clearLastList(threadId) {
  const b = getBucket(threadId);
  if (!b) return;
  b.lastList = null;
  b.updatedAt = nowMs();
}