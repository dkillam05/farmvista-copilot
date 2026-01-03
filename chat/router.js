// /chat/router.js  (FULL FILE)
// Rev: 2026-01-02-router-fields-only1
//
// Deterministic router: only one category right now (farms + fields).
// Everything else => "not wired yet" message.

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
  // status
  "archived", "inactive", "active",
  // counting / listing
  "how many", "count", "total", "number of", "list", "show", "find", "lookup", "search",
  // phrasing
  "which farm", "what farm", "on farm", "in farm"
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
      answer: 'Ask me something about a field or farm. Example: "How many fields do we farm?"',
      meta: { routed: "none", reason: "empty" }
    };
  }

  if (hasAny(q, FF_TERMS)) {
    const includeArchived = detectIncludeArchived(q);
    return await handleFarmsFields({ question: raw, snapshot, user, includeArchived });
  }

  return {
    ok: true,
    answer:
      'That category isn’t wired yet. For now I can answer questions about farms and fields. ' +
      'Try: "How many active fields do we have?" or "List fields on Lov Shack."',
    meta: { routed: "none", reason: "no_match" }
  };
}