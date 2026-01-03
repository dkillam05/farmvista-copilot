// /chat/followupInterpreter.js  (FULL FILE)
// Rev: 2026-01-03-followupInterpreter1
//
// Global follow-up interpreter (deterministic).
// Translates short follow-ups into explicit questions using stored context.
//
// NOTE: Paging ("more", "the rest") is handled by /chat/followups.js.
// This file handles "same thing but CRP", "by county", "including archived", etc.

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function hasAny(s, arr) {
  for (const t of arr) if (s.includes(t)) return true;
  return false;
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

function wantsIncludeArchived(s) {
  const q = norm(s);
  return q.includes("including archived") || q.includes("include archived") || q.includes("incl archived") || q.includes("archived too");
}

function wantsActiveOnly(s) {
  const q = norm(s);
  return q.includes("active only") || q.includes("only active");
}

function isSameThingFollowup(s) {
  const q = norm(s);
  return hasAny(q, ["same", "same thing", "same but", "do that again", "do it again"]);
}

function isSwitchBreakdownFollowup(s) {
  const q = norm(s);
  // "by county", "by farm" even without "same"
  return wantsByFarm(q) || wantsByCounty(q);
}

function isThatEntityFollowup(s) {
  const q = norm(s);
  return hasAny(q, ["that field", "that one", "that farm", "that county", "that"]);
}

function buildTotalsQuestion({ metric, by }) {
  const m = metric || "tillable";
  if (by === "farm") {
    if (m === "hel") return "HEL acres by farm";
    if (m === "crp") return "CRP acres by farm";
    if (m === "fields") return "How many fields by farm";
    return "Farm totals by farm";
  }
  if (by === "county") {
    if (m === "hel") return "HEL acres by county";
    if (m === "crp") return "CRP acres by county";
    if (m === "fields") return "How many fields by county";
    return "County totals by county";
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
  const lastBy = (c.lastBy || "").toString(); // "farm" | "county" | ""
  const lastEntity = c.lastEntity || null;     // { type, id, name }
  const lastScope = c.lastScope || {};         // { includeArchived, county, farmId, farmName }

  // If user says "including archived" / "active only" as a follow-up, keep same intent
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
    // no prior context; let router handle normally
    return null;
  }

  // "same thing but crp/hel/by county/by farm"
  if (isSameThingFollowup(q) || isSwitchBreakdownFollowup(q)) {
    const metric = extractMetric(q) || lastMetric || "";
    const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : (lastBy || ""));

    // If lastIntent was a totals-type, rewrite to a totals prompt
    if (lastIntent.includes("totals") || lastIntent.includes("count") || lastIntent.includes("breakdown") || lastIntent.includes("farm") || lastIntent.includes("county")) {
      const rq = buildTotalsQuestion({ metric, by });
      return {
        rewriteQuestion: rq,
        contextDelta: {
          lastMetric: metric || lastMetric || null,
          lastBy: by || lastBy || null
        }
      };
    }

    // If last intent was field lookup, "same thing but hel" means: show HEL for that field (already shown)
    if (lastIntent === "field_lookup" && lastEntity && lastEntity.type === "field") {
      // Re-run field lookup for same entity
      return {
        rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name || ""}`.trim(),
        contextDelta: {}
      };
    }

    // Otherwise, let router handle
    return null;
  }

  // "that county" / "that farm" / "that field"
  if (isThatEntityFollowup(q) && lastEntity) {
    if (lastEntity.type === "field") {
      return { rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name}`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "farm") {
      const metric = extractMetric(q) || lastMetric || "tillable";
      return { rewriteQuestion: `${metric.toUpperCase() === "HEL" ? "HEL acres" : metric === "crp" ? "CRP acres" : "Farm totals"} for ${lastEntity.name || lastEntity.id}`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "county") {
      const metric = extractMetric(q) || lastMetric || "tillable";
      return { rewriteQuestion: `County totals for ${lastEntity.name || lastEntity.id} County`.trim(), contextDelta: {} };
    }
  }

  return null;
}