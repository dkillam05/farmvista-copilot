// /chat/followupInterpreter.js  (FULL FILE)
// Rev: 2026-01-06-followupInterpreter7-smart-list-followups
//
// Global follow-up interpreter (deterministic).
// Paging ("more", "show all") is handled by /chat/followups.js.
//
// Adds (scalable):
// ✅ "list fields" / "show fields" follow-up uses lastEntity:
//    - lastEntity=farm   => "List fields on <farm>"
//    - lastEntity=county => "List fields in <county> County"
//    - lastEntity=tower  => "List fields on <tower> tower"
// ✅ "with acres" / "include tillable acres" upgrades the last list to include acres.
// ✅ RTK: "including tillable acres" after tower fields list upgrades to acres list.
// ✅ Scope follow-ups: "include archived" / "active only" keep same intent.

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
   LIST follow-ups (NEW)
=========================== */

function isListFieldsFollowup(s) {
  const q = norm(s);
  // very common employee follow-ups
  if (q === "list fields" || q === "show fields" || q === "fields") return true;
  if (q === "list them" || q === "show them") return true;
  if (q.includes("list fields")) return true;
  if (q.includes("show fields")) return true;
  return false;
}

function wantsWithAcres(s) {
  const q = norm(s);
  return q.includes("with acres") || q.includes("with tillable") || q.includes("include acres") || q.includes("including acres") || q.includes("include tillable") || q.includes("including tillable");
}

function wantsNoAcres(s) {
  const q = norm(s);
  return q === "no acres" || q.includes("without acres") || q.includes("remove acres") || q.includes("no tillable");
}

function buildListFieldsForEntity(entity, withAcres) {
  if (!entity || !entity.type) return "";
  const name = (entity.name || entity.id || "").toString().trim();
  if (!name) return "";

  if (entity.type === "farm") {
    return withAcres ? `List fields on ${name} with acres` : `List fields on ${name}`;
  }
  if (entity.type === "county") {
    // if they stored "Sangamon, IL" we can still use it
    // your farmsFields handler recognizes "... County" patterns via planner or future logic;
    // we keep it simple:
    const countyName = name.replace(/,\s*[A-Z]{2}\b/i, "").trim() || name;
    return withAcres ? `List fields in ${countyName} County with acres` : `List fields in ${countyName} County`;
  }
  if (entity.type === "tower") {
    return withAcres ? `List fields on ${name} tower with tillable acres` : `List fields on ${name} tower`;
  }
  if (entity.type === "field") {
    // list fields doesn't apply; return lookup
    return `Tell me about ${name}`;
  }
  return "";
}

/* ===========================
   RTK follow-up helpers
=========================== */

function wantsIncludeTillableRTK(s) {
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

function wantsRemoveTillableRTK(s) {
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
   Totals builder
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
  if (m === "hel") return "Total HEL acres";
  if (m === "crp") return "Total CRP acres";
  if (m === "fields") return "How many active fields do we have?";
  return "Total tillable acres";
}

/* ===========================
   Main
=========================== */

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

  // ✅ Scope follow-ups keep context
  if (wantsIncludeArchived(q) || wantsActiveOnly(q)) {
    if (lastIntent) {
      const includeArchived = wantsIncludeArchived(q) ? true : (wantsActiveOnly(q) ? false : !!lastScope.includeArchived);
      const metric = extractMetric(q) || lastMetric;
      const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : lastBy);

      const rq = buildTotalsQuestion({ metric: metric || lastMetric, by: by || lastBy });
      return { rewriteQuestion: rq, contextDelta: { lastScope: { includeArchived } } };
    }
    return null;
  }

  // ✅ NEW: "list fields" follow-up uses lastEntity
  if (isListFieldsFollowup(q) && lastEntity) {
    const rq = buildListFieldsForEntity(lastEntity, false);
    if (rq) {
      return { rewriteQuestion: rq, contextDelta: { lastIntent: "list_fields_followup" } };
    }
  }

  // ✅ NEW: "with acres" upgrades last entity list to include acres
  if (wantsWithAcres(q) && lastEntity) {
    const rq = buildListFieldsForEntity(lastEntity, true);
    if (rq) {
      return { rewriteQuestion: rq, contextDelta: { lastIntent: "list_fields_with_acres_followup", lastMetric: "tillable" } };
    }
  }

  // ✅ NEW: "no acres" downgrades the last entity list to non-acres
  if (wantsNoAcres(q) && lastEntity) {
    const rq = buildListFieldsForEntity(lastEntity, false);
    if (rq) {
      return { rewriteQuestion: rq, contextDelta: { lastIntent: "list_fields_followup", lastMetric: "fields" } };
    }
  }

  // ✅ RTK follow-up: after listing tower fields, include tillable acres
  if ((lastIntent === "tower_fields" || lastIntent === "tower_fields_tillable") && lastEntity && lastEntity.type === "tower") {
    const towerName = (lastEntity.name || lastEntity.id || "").toString().trim();

    if (wantsIncludeTillableRTK(q) && lastIntent !== "tower_fields_tillable") {
      const rq = buildTowerFieldsQuestion(towerName, true);
      if (rq) return { rewriteQuestion: rq, contextDelta: { lastIntent: "tower_fields_tillable", lastMetric: "tillable" } };
    }

    if (wantsRemoveTillableRTK(q) && lastIntent !== "tower_fields") {
      const rq = buildTowerFieldsQuestion(towerName, false);
      if (rq) return { rewriteQuestion: rq, contextDelta: { lastIntent: "tower_fields", lastMetric: "fields" } };
    }
  }

  // ✅ "same thing but …" / switch breakdowns
  if (isSameThingFollowup(q) || isSwitchBreakdownFollowup(q)) {
    const metric = extractMetric(q) || lastMetric || "";
    const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : (lastBy || ""));

    if (
      lastIntent.includes("totals") ||
      lastIntent.includes("count") ||
      lastIntent.includes("breakdown") ||
      lastIntent.includes("farm") ||
      lastIntent.includes("county") ||
      lastIntent.includes("metric_by_")
    ) {
      const rq = buildTotalsQuestion({ metric, by });
      return { rewriteQuestion: rq, contextDelta: { lastMetric: metric || lastMetric || null, lastBy: by || lastBy || null } };
    }

    return null;
  }

  // ✅ "that one" entity follow-ups
  if (isThatEntityFollowup(q) && lastEntity) {
    const rq = buildListFieldsForEntity(lastEntity, false);
    if (rq) return { rewriteQuestion: rq, contextDelta: {} };
  }

  return null;
}