// /chat/followupInterpreter.js  (FULL FILE)
// Rev: 2026-01-05-followupInterpreter6-rtk-followups
//
// Global follow-up interpreter (deterministic).
// Translates short follow-ups into explicit questions using stored context.
//
// Paging ("more", "show all") is handled by /chat/followups.js.
// This file handles conversational follow-ups like:
// - "including archived" / "active only"
// - "same thing but HEL"
// - "by county"
// - ✅ RTK follow-ups:
//    - After listing tower fields, "including tillable acres" reruns the same tower field list WITH acres.

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function hasAny(s, arr) {
  for (const t of arr) if (s.includes(t)) return true;
  return false;
}

function wantsIncludeArchived(s) {
  const q = norm(s);
  return q.includes("including archived") || q.includes("include archived") || q.includes("incl archived") || q.includes("archived too") || q === "include archived";
}

function wantsActiveOnly(s) {
  const q = norm(s);
  return q.includes("active only") || q.includes("only active") || q === "active only";
}

function extractMetric(s) {
  const q = norm(s);

  if (q.includes("hel")) return "hel";
  if (q.includes("crp")) return "crp";
  if (q.includes("tillable") || q.includes("acres")) return "tillable";
  if (q.includes("fields") || q.includes("count")) return "fields";

  return "";
}

function wantsByFarm(s) {
  const q = norm(s);
  return q.includes("by farm") || (q.includes("by") && q.includes("farm"));
}

function wantsByCounty(s) {
  const q = norm(s);
  return q.includes("by county") || (q.includes("by") && q.includes("county"));
}

function isSameThingFollowup(s) {
  const q = norm(s);
  return hasAny(q, ["same", "same thing", "same but", "do that again", "do it again"]);
}

function isSwitchBreakdownFollowup(s) {
  const q = norm(s);
  return wantsByFarm(q) || wantsByCounty(q);
}

function isThatEntityFollowup(s) {
  const q = norm(s);
  return hasAny(q, ["that field", "that one", "that farm", "that county", "that tower", "that"]);
}

/* ===========================
   NEW: RTK follow-up helpers
=========================== */

function wantsIncludeTillable(s) {
  const q = norm(s);
  return (
    q.includes("include tillable") ||
    q.includes("including tillable") ||
    q.includes("with tillable") ||
    (q.includes("include") && q.includes("acres")) ||
    (q.includes("including") && q.includes("acres")) ||
    q === "include tillable acres" ||
    q === "including tillable acres"
  );
}

function wantsRemoveTillable(s) {
  const q = norm(s);
  return (
    q.includes("no tillable") ||
    q.includes("without acres") ||
    q.includes("remove acres") ||
    q.includes("no acres") ||
    q === "no acres"
  );
}

function buildTowerFieldsQuestion(towerName, withTillable) {
  const t = (towerName || "").toString().trim();
  if (!t) return "";
  if (withTillable) return `List fields on ${t} tower with tillable acres`;
  return `List fields on ${t} tower`;
}

/* ===========================
   Totals question builder
=========================== */

function buildTotalsQuestion({ metric, by }) {
  const m = metric || "tillable";
  if (by === "farm") {
    if (m === "hel") return "HEL acres by farm";
    if (m === "crp") return "CRP acres by farm";
    if (m === "fields") return "Fields by farm";
    return "Tillable acres by farm";
  }
  if (by === "county") {
    if (m === "hel") return "HEL acres by county";
    if (m === "crp") return "CRP acres by county";
    if (m === "fields") return "Fields by county";
    return "Tillable acres by county";
  }
  // overall
  if (m === "hel") return "Total HEL acres";
  if (m === "crp") return "Total CRP acres";
  if (m === "fields") return "How many active fields do we have?";
  return "Total tillable acres";
}

/**
 * Returns:
 * - null if not a follow-up we can interpret
 * - { rewriteQuestion, contextDelta } if we can rewrite and should proceed to routing
 */
export function interpretFollowup({ question, ctx }) {
  const raw = (question || "").toString().trim();
  const q = norm(raw);
  if (!q) return null;

  const c = ctx || {};
  const lastIntent = (c.lastIntent || "").toString();
  const lastMetric = (c.lastMetric || "").toString();
  const lastBy = (c.lastBy || "").toString();
  const lastEntity = c.lastEntity || null;
  const lastScope = c.lastScope || {};

  // ✅ Scope follow-ups
  if (wantsIncludeArchived(q) || wantsActiveOnly(q)) {
    if (lastIntent) {
      const includeArchived = wantsIncludeArchived(q) ? true : (wantsActiveOnly(q) ? false : !!lastScope.includeArchived);
      const metric = extractMetric(q) || lastMetric;
      const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : lastBy);

      const rq = buildTotalsQuestion({ metric: metric || lastMetric, by: by || lastBy });
      return {
        rewriteQuestion: rq,
        contextDelta: { lastScope: { includeArchived } }
      };
    }
    return null;
  }

  // ✅ RTK follow-up: after listing tower fields, include tillable acres
  // Works when rtk.handler sets:
  // lastIntent = "tower_fields" OR "tower_fields_tillable"
  // lastEntity.type = "tower"
  if ((lastIntent === "tower_fields" || lastIntent === "tower_fields_tillable") && lastEntity && lastEntity.type === "tower") {
    const towerName = (lastEntity.name || lastEntity.id || "").toString().trim();

    if (wantsIncludeTillable(q) && lastIntent !== "tower_fields_tillable") {
      const rq = buildTowerFieldsQuestion(towerName, true);
      if (rq) return { rewriteQuestion: rq, contextDelta: { lastIntent: "tower_fields_tillable", lastMetric: "tillable" } };
    }

    if (wantsRemoveTillable(q) && lastIntent !== "tower_fields") {
      const rq = buildTowerFieldsQuestion(towerName, false);
      if (rq) return { rewriteQuestion: rq, contextDelta: { lastIntent: "tower_fields", lastMetric: "fields" } };
    }
  }

  // ✅ "same thing but ..." / switch breakdowns
  if (isSameThingFollowup(q) || isSwitchBreakdownFollowup(q)) {
    const metric = extractMetric(q) || lastMetric || "";
    const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : (lastBy || ""));

    if (lastIntent.includes("totals") || lastIntent.includes("count") || lastIntent.includes("breakdown") || lastIntent.includes("farm") || lastIntent.includes("county") || lastIntent.includes("metric_by_")) {
      const rq = buildTotalsQuestion({ metric, by });
      return {
        rewriteQuestion: rq,
        contextDelta: { lastMetric: metric || lastMetric || null, lastBy: by || lastBy || null }
      };
    }

    return null;
  }

  // ✅ "that one" entity follow-ups
  if (isThatEntityFollowup(q) && lastEntity) {
    if (lastEntity.type === "field") {
      return { rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name}`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "farm") {
      return { rewriteQuestion: `Tillable acres by farm`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "county") {
      return { rewriteQuestion: `Tillable acres by county`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "tower") {
      // default: list fields on that tower
      const rq = buildTowerFieldsQuestion(lastEntity.name || lastEntity.id, false);
      if (rq) return { rewriteQuestion: rq, contextDelta: {} };
    }
  }

  return null;
}