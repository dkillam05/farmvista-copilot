// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16a  domain:grain
//
// Purpose:
// - OWN all grain-specific guardrails + detection helpers + (later) hard SQL queries.
// - Starting point: exports helpers + tool defs placeholders.
// - NOT wired yet: no behavior change until handleChat uses these exports.
//
// IMPORTANT:
// - Keep PUTDOWN ONLY / VIEW ONLY rules here once we wire it.
// - Keep partialZeroGuard here once we wire it.

'use strict';

import { safeStr } from "../lib/shared.js";

export function grainToolDefs() {
  // We will wire these later. For now, placeholders so file exists.
  return [];
}

export function grainHandleToolCall(/* name, args, ctx */) {
  // Not wired yet.
  return null;
}

/* =====================================================================
   ✅ BUSHEL COMMIT ENFORCEMENT helpers (moved from handleChat, unchanged)
===================================================================== */
export function userAsksBagBushels(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;

  const hasBushelWord = /\bbushels?\b/.test(t);
  const hasBu = /\bbu\b/.test(t) || /\bbu\.\b/.test(t);
  if (!(hasBushelWord || hasBu)) return false;

  const bagContext = t.includes("bag") && (t.includes("grain") || t.includes("field") || t.includes("bags") || t.includes("those"));
  return !!bagContext;
}

export function userAsksGroupedByField(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return (
    t.includes("by field") ||
    t.includes("grouped by field") ||
    t.includes("per field") ||
    t.includes("each field") ||
    (t.includes("fields") && (t.includes("bushel") || /\bbu\b/.test(t)))
  );
}

export function assistantHasBushelNumber(text) {
  const s = safeStr(text);
  if (!s) return false;
  const re = /\b\d[\d,]*\.?\d*\s*(bu|bushels?)\b/i;
  return re.test(s);
}

export function sqlLooksLikeBagRows(sqlLower) {
  if (!sqlLower) return false;
  // PutDown-only truth must come from the view.
  return sqlLower.includes("v_grainbag_open_remaining");
}

export function sqlLooksLikeCapacityChain(sqlLower) {
  if (!sqlLower) return false;
  return (
    sqlLower.includes("inventorygrainbagmovements") ||
    sqlLower.includes("productsgrainbags") ||
    sqlLower.includes("bushelscorn") ||
    sqlLower.includes("lengthft") ||
    sqlLower.includes("productid") ||
    sqlLower.includes("remainingpartial")
  );
}

export function userReferencesThoseBags(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return t.includes("those") && t.includes("bag");
}

export function extractExplicitBagNumber(text) {
  const t = (text || "").toString().toLowerCase();
  const m = t.match(/\bthose\s+(\d{1,6})\s+bags?\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}