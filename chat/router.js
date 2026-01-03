// /chat/router.js  (FULL FILE)
// Rev: 2026-01-03-router-followups3-state
//
// Deterministic router: farms + fields is the only handler today.
// Adds resolver-state support so "first one" / "2" / exact option label
// can finalize a prior disambiguation list instead of re-running fuzzy match.

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

/* =====================================================================
   Resolver state helpers
===================================================================== */

function coerceCandidatesFromResponse(r) {
  const out = [];

  // Supported shapes (best-effort, non-breaking):
  // meta.candidates: [{ id, label }]
  // meta.matches:    [{ id, label }]
  // meta.options:    [{ id, label }]
  // action.choices:  [{ id, label }]  (or { value, label })
  const m = r?.meta || {};
  const a = r?.action || {};

  const pools = [];
  if (Array.isArray(m.candidates)) pools.push(m.candidates);
  if (Array.isArray(m.matches)) pools.push(m.matches);
  if (Array.isArray(m.options)) pools.push(m.options);
  if (Array.isArray(a.choices)) pools.push(a.choices);

  for (const pool of pools) {
    for (const it of pool) {
      const id = (it && (it.id || it.value || it.fieldId)) ? String(it.id || it.value || it.fieldId) : "";
      const label = (it && (it.label || it.name || it.text)) ? String(it.label || it.name || it.text) : "";
      if (!id && !label) continue;
      out.push({ id, label });
    }
    if (out.length) break;
  }

  // De-dupe by id+label
  const seen = new Set();
  const deduped = [];
  for (const c of out) {
    const k = `${c.id}|||${c.label}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(c);
  }
  return deduped;
}

function pickIndexFromUserText(q) {
  const s = norm(q);

  if (!s) return -1;

  // "first one", "second", "third"
  if (s.includes("first")) return 0;
  if (s.includes("second")) return 1;
  if (s.includes("third")) return 2;
  if (s.includes("fourth")) return 3;
  if (s.includes("fifth")) return 4;

  // "#2", "2", "option 2", "number 2"
  const m = s.match(/(?:^|\b)(?:#|option\s+|number\s+)?(\d{1,2})(?:\b|$)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n >= 1) return n - 1;
  }

  return -1;
}

function pickCandidateFromUserText(q, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const s = norm(q);

  // index-based pick
  const idx = pickIndexFromUserText(s);
  if (idx >= 0 && idx < candidates.length) return candidates[idx];

  // exact label match (normalized)
  for (const c of candidates) {
    const lab = norm(c?.label);
    if (lab && lab === s) return c;
  }

  // substring label match (user typed "stone seed")
  for (const c of candidates) {
    const lab = norm(c?.label);
    if (lab && s && (lab.includes(s) || s.includes(lab))) return c;
  }

  return null;
}

/* =====================================================================
   Router
===================================================================== */

export async function routeQuestion({ question, snapshot, user, state = null }) {
  const raw = (question || "").toString();
  const q = norm(raw);

  if (!q) {
    return {
      ok: true,
      answer: 'Ask me something about a field or farm. Example: "How many active fields do we have?"',
      meta: { routed: "none", reason: "empty" },
      state: state || null
    };
  }

  // If we’re awaiting a pick from a previous disambiguation list, resolve it here.
  if (state && state.mode === "pick_field" && Array.isArray(state.candidates) && state.candidates.length) {
    const picked = pickCandidateFromUserText(q, state.candidates);

    if (!picked) {
      return {
        ok: true,
        answer: "Which one did you mean? Reply with 1, 2, 3… or type the name.",
        meta: { routed: "resolver", mode: "pick_field", awaiting: true, candidates: state.candidates },
        state
      };
    }

    const includeArchived = !!state.includeArchived;

    const r = await handleFarmsFields({
      question: picked.id || picked.label || raw,
      snapshot,
      user,
      includeArchived,
      meta: { routerFallback: false, routerReason: "resolver_pick_field", directPick: true, picked: picked }
    });

    // After a successful pick, clear resolver state by default.
    return {
      ok: r?.ok !== false,
      answer: r?.answer,
      action: r?.action || null,
      meta: r?.meta || {},
      state: null
    };
  }

  const includeArchived = detectIncludeArchived(q);

  // Normal farms/fields route
  if (hasAny(q, FF_TERMS)) {
    const r = await handleFarmsFields({
      question: raw,
      snapshot,
      user,
      includeArchived,
      meta: { routerFallback: false, routerReason: "ff_match" }
    });

    // If handler returned a candidate list, arm resolver state
    const candidates = coerceCandidatesFromResponse(r);
    if (candidates.length) {
      return {
        ok: r?.ok !== false,
        answer: r?.answer,
        action: r?.action || null,
        meta: r?.meta || {},
        state: { mode: "pick_field", candidates, includeArchived }
      };
    }

    return {
      ok: r?.ok !== false,
      answer: r?.answer,
      action: r?.action || null,
      meta: r?.meta || {},
      state: null
    };
  }

  // Not a farms/fields keyword match — still route, but flag fallback.
  const softHit = hasAny(q, SOFT_TERMS);

  {
    const r = await handleFarmsFields({
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

    // If handler returned a candidate list, arm resolver state
    const candidates = coerceCandidatesFromResponse(r);
    if (candidates.length) {
      return {
        ok: r?.ok !== false,
        answer: r?.answer,
        action: r?.action || null,
        meta: r?.meta || {},
        state: { mode: "pick_field", candidates, includeArchived }
      };
    }

    return {
      ok: r?.ok !== false,
      answer: r?.answer,
      action: r?.action || null,
      meta: r?.meta || {},
      state: null
    };
  }
}