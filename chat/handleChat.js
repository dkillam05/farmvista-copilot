// /chat/router.js  (FULL FILE)
// Rev: 2026-01-03-router-followups1
//
// Deterministic router:
// - Routes farms/fields questions to handleFarmsFields
// - For anything else, DO NOT hard-refuse.
//   Instead, fall back to handleFarmsFields in "clarify" mode so it can ask
//   a follow-up question instead of returning a dead-end canned answer.
//
// This immediately improves UX: the bot asks 1–2 follow-ups when unsure.

'use strict';

import { handleFarmsFields } from "../handlers/farmsFields.handler.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function hasAny(q, terms) {
  for (const t of terms) {
    if (q.includes(t)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------
   Farms + Fields terms
--------------------------------------------------------------------- */
const FF_TERMS = [
  // fields
  "field", "fields", "tillable", "acres", "fieldid", "farmid",
  // farms
  "farm", "farms",
  // geography (fields are tied to counties/states)
  "county", "counties", "state", "where is", "location",
  // status
  "archived", "inactive", "active",
  // counting / listing
  "how many", "count", "total", "number of", "list", "show", "find", "lookup", "search",
  // phrasing
  "which farm", "what farm", "on farm", "in farm"
];

/* ---------------------------------------------------------------------
   Soft terms for other common categories (so we can at least clarify)
   These don't route to another handler yet, but they help us avoid
   "no_match" dead ends by prompting clarification.
--------------------------------------------------------------------- */
const SOFT_TERMS = [
  // RTK / towers
  "rtk", "tower", "towers", "base station", "frequency", "network id",
  // grain bags / grain
  "grain", "bag", "bags", "putdown", "pickup", "ticket", "elevator",
  // contracts
  "contract", "contracts", "basis", "delivery",
  // equipment
  "equipment", "tractor", "combine", "sprayer", "implement"
];

function detectIncludeArchived(q) {
  // user explicitly wants archived/inactive included
  if (q.includes("archived") || q.includes("inactive")) return true;

  // user explicitly wants active only
  if (q.includes("active only") || q.includes("only active")) return false;

  // default: active-only
  return false;
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

  // Primary route: farms/fields
  if (hasAny(q, FF_TERMS)) {
    const includeArchived = detectIncludeArchived(q);
    return await handleFarmsFields({ question: raw, snapshot, user, includeArchived });
  }

  // If the user asked about something else we recognize (rtk, grain bags, contracts, etc.)
  // we still do NOT dead-end. We fall back to farmsFields handler but flag it so it can ask
  // a follow-up question like "Do you mean RTK towers? grain bags? farms/fields?"
  if (hasAny(q, SOFT_TERMS)) {
    const includeArchived = detectIncludeArchived(q);
    const r = await handleFarmsFields({ question: raw, snapshot, user, includeArchived });

    // Ensure router metadata reveals why we fell back (useful for debugging)
    return {
      ...(r || {}),
      meta: {
        ...(r?.meta || {}),
        routed: r?.meta?.routed || "farmsFields",
        routerFallback: true,
        routerReason: "soft_match_other_category"
      }
    };
  }

  // Absolute fallback: still do NOT refuse.
  // Route to farmsFields in fallback mode so it can ask a clarifying question.
  const includeArchived = detectIncludeArchived(q);
  const r = await handleFarmsFields({ question: raw, snapshot, user, includeArchived });

  return {
    ...(r || { ok: true, answer: "" }),
    answer: (r && r.answer) ? r.answer : "What are you trying to look up — farms/fields, RTK towers, grain bags, contracts, or equipment?",
    meta: {
      ...(r?.meta || {}),
      routed: r?.meta?.routed || "farmsFields",
      routerFallback: true,
      routerReason: "no_match_clarify"
    }
  };
}
