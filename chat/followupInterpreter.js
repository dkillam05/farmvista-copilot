// /chat/followupInterpreter.js  (FULL FILE)
// Rev: 2026-01-04-followupInterpreter5-pendingClarify
//
// Adds pendingClarify support:
// - If ctx.pendingClarify exists and user replies "active only" or "include archived",
//   we rewrite to the stored baseQuestion plus scope directive.

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function hasAny(s, arr) { for (const t of arr) if (s.includes(t)) return true; return false; }

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

function wantsByFarm(s) { const q = norm(s); return q.includes("by farm") || (q.includes("by") && q.includes("farm")); }
function wantsByCounty(s) { const q = norm(s); return q.includes("by county") || (q.includes("by") && q.includes("county")); }

function isSameThingFollowup(s) { const q = norm(s); return hasAny(q, ["same", "same thing", "same but", "do that again", "do it again"]); }
function isSwitchBreakdownFollowup(s) { const q = norm(s); return wantsByFarm(q) || wantsByCounty(q); }
function isThatEntityFollowup(s) { const q = norm(s); return hasAny(q, ["that field", "that one", "that farm", "that county", "that"]); }

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
    return "Tillable acres by county";
  }
  if (m === "hel") return "Total HEL acres";
  if (m === "crp") return "Total CRP acres";
  if (m === "fields") return "How many active fields do we have?";
  return "Total tillable acres";
}

export function interpretFollowup({ question, ctx }) {
  const raw = (question || "").toString().trim();
  const q = norm(raw);
  if (!q) return null;

  const c = ctx || {};

  // ✅ Pending scope clarification
  if (c.pendingClarify && (wantsIncludeArchived(q) || wantsActiveOnly(q))) {
    const base = (c.pendingClarify.baseQuestion || "").toString().trim();
    if (!base) return null;
    const suffix = wantsIncludeArchived(q) ? " including archived" : " active only";
    return {
      rewriteQuestion: `${base}${suffix}`.trim(),
      contextDelta: { pendingClarify: null, lastScope: { includeArchived: wantsIncludeArchived(q) } }
    };
  }

  const lastIntent = (c.lastIntent || "").toString();
  const lastMetric = (c.lastMetric || "").toString();
  const lastBy = (c.lastBy || "").toString();
  const lastEntity = c.lastEntity || null;
  const lastScope = c.lastScope || {};

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

  if (isSameThingFollowup(q) || isSwitchBreakdownFollowup(q)) {
    const metric = extractMetric(q) || lastMetric || "";
    const by = wantsByFarm(q) ? "farm" : (wantsByCounty(q) ? "county" : (lastBy || ""));

    if (lastIntent.includes("totals") || lastIntent.includes("count") || lastIntent.includes("breakdown") || lastIntent.includes("farm") || lastIntent.includes("county")) {
      const rq = buildTotalsQuestion({ metric, by });
      return { rewriteQuestion: rq, contextDelta: { lastMetric: metric || lastMetric || null, lastBy: by || lastBy || null } };
    }

    if (lastIntent === "field_lookup" && lastEntity && lastEntity.type === "field") {
      return { rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name || ""}`.trim(), contextDelta: {} };
    }
    return null;
  }

  if (isThatEntityFollowup(q) && lastEntity) {
    if (lastEntity.type === "field") return { rewriteQuestion: `Tell me about ${lastEntity.id || lastEntity.name}`.trim(), contextDelta: {} };
    if (lastEntity.type === "farm") return { rewriteQuestion: `Farm totals for ${lastEntity.name || lastEntity.id}`.trim(), contextDelta: {} };
    if (lastEntity.type === "county") return { rewriteQuestion: `Tillable acres by county`.trim(), contextDelta: {} };
  }

  return null;
}