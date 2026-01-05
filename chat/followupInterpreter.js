// /chat/followupInterpreter.js  (FULL FILE)
// Rev: 2026-01-04-followupInterpreter2-rtk-tower-followups
//
// CHANGE:
// ✅ If last context is an RTK tower fields list, then:
//    - "include tillable acres" => rerun same tower fields with acres
//    - "total those acres" / "sum those acres" => total tillable acres for that tower
//
// Keeps existing behavior for farms/fields totals follow-ups.

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
  if (q.includes("tillable") || q.includes("acres") || q.includes("acre")) return "tillable";
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
  return wantsByFarm(q) || wantsByCounty(q);
}

function isThatEntityFollowup(s) {
  const q = norm(s);
  return hasAny(q, ["that field", "that one", "that farm", "that county", "that"]);
}

function isIncludeTillableFollowup(s) {
  const q = norm(s);
  return (
    q === "include tillable acres" ||
    q === "include acres" ||
    q === "with acres" ||
    q.includes("include tillable") ||
    q.includes("include acres") ||
    q.includes("with tillable") ||
    q.includes("with acres")
  );
}

function isTotalThoseAcresFollowup(s) {
  const q = norm(s);
  return (
    q.includes("total those acres") ||
    q.includes("sum those acres") ||
    q.includes("total the acres") ||
    q.includes("sum the acres") ||
    q === "total acres" ||
    q === "sum acres"
  );
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
  const lastEntity = c.lastEntity || null; // { type, id, name }
  const lastScope = c.lastScope || {};

  // ✅ RTK tower fields follow-ups (global)
  // If we just listed fields for a tower, keep that tower context.
  if (lastEntity && lastEntity.type === "tower" && (lastIntent === "tower_fields" || lastIntent === "tower_fields_tillable")) {
    const towerName = (lastEntity.name || lastEntity.id || "").toString().trim();

    if (isIncludeTillableFollowup(q)) {
      return {
        rewriteQuestion: `Fields on ${towerName} tower with tillable acres`,
        contextDelta: { lastIntent: "tower_fields_tillable", lastMetric: "tillable" }
      };
    }

    if (isTotalThoseAcresFollowup(q) || (q.includes("total") && q.includes("acres"))) {
      return {
        rewriteQuestion: `Total tillable acres for the ${towerName} tower`,
        contextDelta: { lastIntent: "tower_tillable_total", lastMetric: "tillable" }
      };
    }
  }

  // If user says include archived/active only as follow-up
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

  // "same thing but ..."
  if (isSameThingFollowup(q) || isSwitchBreakdownFollowup(q)) {
    const metric = extractMetric(q) || lastMetric || "";
    const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : (lastBy || ""));

    if (
      lastIntent.includes("totals") ||
      lastIntent.includes("count") ||
      lastIntent.includes("breakdown") ||
      lastIntent.includes("farm") ||
      lastIntent.includes("county")
    ) {
      const rq = buildTotalsQuestion({ metric, by });
      return {
        rewriteQuestion: rq,
        contextDelta: {
          lastMetric: metric || lastMetric || null,
          lastBy: by || lastBy || null
        }
      };
    }

    if (lastIntent === "field_lookup" && lastEntity && lastEntity.type === "field") {
      return {
        rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name || ""}`.trim(),
        contextDelta: {}
      };
    }

    return null;
  }

  // "that field/farm/county"
  if (isThatEntityFollowup(q) && lastEntity) {
    if (lastEntity.type === "field") {
      return { rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name}`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "farm") {
      const metric = extractMetric(q) || lastMetric || "tillable";
      return { rewriteQuestion: `${metric === "hel" ? "HEL acres" : metric === "crp" ? "CRP acres" : "Farm totals"} for ${lastEntity.name || lastEntity.id}`.trim(), contextDelta: {} };
    }
    if (lastEntity.type === "county") {
      return { rewriteQuestion: `County totals for ${lastEntity.name || lastEntity.id} County`.trim(), contextDelta: {} };
    }
  }

  return null;
}