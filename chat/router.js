// /chat/router.js  (FULL FILE)
// Rev: 2026-01-03-router-followups2
//
// Deterministic router: farms + fields is the only handler today.
// IMPORTANT CHANGE:
// - Do NOT dead-end with "not reachable".
// - If no match, still route to farmsFields but flag routerFallback so the handler
//   can ask a clarifying follow-up instead of returning a dumb refusal.

'use strict';

import { handleFarmsFields } from "../handlers/farmsFields.handler.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function hasAny(q, terms) {
  for (const t of terms) {
    if (q.includes(t)) return true;
  }
  return false;
}

const FF_TERMS = [
  // fields
  "field", "fields", "tillable", "acres", "fieldid", "farmid",
  // farms
  "farm", "farms",
  // geography
  "county", "counties", "state", "where is", "location",
  // status
  "archived", "inactive", "active",
  // counting / listing
  "how many", "count", "total", "number of", "list", "show", "find", "lookup", "search",
  // phrasing
  "which farm", "what farm", "on farm", "in farm"
];

// "soft" terms to help the handler ask better follow-ups
const SOFT_TERMS = [
  "rtk", "tower", "towers", "base station", "frequency", "network id",
  "grain", "bag", "bags", "putdown", "pickup", "ticket", "elevator",
  "contract", "contracts", "basis", "delivery",
  "equipment", "tractor", "combine", "sprayer", "implement"
];

function detectIncludeArchived(q) {
  if (q.includes("archived") || q.includes("inactive")) return true;
  if (q.includes("active only") || q.includes("only active")) return false;
  return false; // default: active-only
}

export async function routeQuestion({ question, snapshot, user }) {
  const raw = (question || "").toString();
  const q = norm(raw);

  if (!q) {
    return {
      ok: true,
      answer: 'Ask me something about a field or farm. Example: "How many active fields do we have?"',
      meta: { routed: "none", reason: "empty" }
    };
  }

  const includeArchived = detectIncludeArchived(q);

  // Normal farms/fields route
  if (hasAny(q, FF_TERMS)) {
    return await handleFarmsFields({
      question: raw,
      snapshot,
      user,
      includeArchived,
      meta: { routerFallback: false, routerReason: "ff_match" }
    });
  }

  // Not a farms/fields keyword match — still route, but flag fallback.
  const softHit = hasAny(q, SOFT_TERMS);

  return await handleFarmsFields({
    question: raw,
    snapshot,
    user,
    includeArchived,
    meta: {
      routerFallback: true,
      routerReason: softHit ? "soft_match_other_domain" : "no_match",
      softHit: softHit || false
    }
  });
}
