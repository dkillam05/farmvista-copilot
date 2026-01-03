// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-02-handler-fields-only3-totals
//
// Farms + Fields handler only.
// ✅ Adds County/State output for field lookups
// ✅ Adds totals + breakdowns:
//    - count fields (active vs incl archived)
//    - tillable acres totals
//    - HEL acres totals (hasHEL / helAcres)
//    - CRP acres totals (hasCRP / crpAcres)
//    - breakdown by farm
//    - breakdown by county
//
// Uses snapshot-only /data/fieldData.js helpers.
//
// Requires these exports from /data/fieldData.js:
// - getSnapshotCollections(snapshot)
// - tryResolveField({ snapshot, query, includeArchived })
// - buildFieldBundle({ snapshot, fieldId })
// - formatFieldOptionLine({ snapshot, fieldId })

'use strict';

import {
  getSnapshotCollections,
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine
} from "../data/fieldData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true;
  return v !== "archived" && v !== "inactive";
}

function wantsCount(q) {
  return q.includes("how many") || q.includes("count") || q.includes("total") || q.includes("number of");
}

function wantsAcres(q) {
  return q.includes("acres") || q.includes("tillable") || q.includes("acre");
}

function wantsHel(q) {
  return q.includes("hel");
}

function wantsCrp(q) {
  return q.includes("crp");
}

function wantsByFarm(q) {
  return q.includes("by farm") || (q.includes("farm") && (q.includes("breakdown") || q.includes("totals") || q.includes("total")));
}

function wantsByCounty(q) {
  return q.includes("by county") || q.includes("county totals") || (q.includes("county") && (q.includes("breakdown") || q.includes("totals") || q.includes("total")));
}

function wantsList(q) {
  return q.includes("list") || q.includes("show");
}

function extractFarmNameGuess(raw) {
  // heuristic: "... on <farm>" or "... in <farm>" at end
  const m = String(raw || "").match(/\b(?:on|in)\s+([a-z0-9][a-z0-9\s\-\._]{1,60})$/i);
  if (!m) return "";
  return (m[1] || "").toString().trim();
}

function extractCountyGuess(raw) {
  // Supports: "in Pike county", "Pike county", "county Pike"
  const s = String(raw || "").trim();

  let m = s.match(/\bin\s+([A-Za-z][A-Za-z\s\-]{2,})\s+county\b/i);
  if (m && m[1]) return m[1].trim();

  m = s.match(/\b([A-Za-z][A-Za-z\s\-]{2,})\s+county\b/i);
  if (m && m[1]) return m[1].trim();

  m = s.match(/\bcounty\s+([A-Za-z][A-Za-z\s\-]{2,})\b/i);
  if (m && m[1]) return m[1].trim();

  return "";
}

function findFarmByName(cols, farmName) {
  const needle = norm(farmName);
  if (!needle) return null;

  for (const [id, f] of Object.entries(cols.farms || {})) {
    if (norm(f?.name) === needle) return { id, ...f };
  }
  for (const [id, f] of Object.entries(cols.farms || {})) {
    const n = norm(f?.name);
    if (n && n.startsWith(needle)) return { id, ...f };
  }
  for (const [id, f] of Object.entries(cols.farms || {})) {
    const n = norm(f?.name);
    if (n && n.includes(needle)) return { id, ...f };
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function fmtAcre(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function buildTotals({ cols, includeArchived }) {
  const totals = {
    fieldsTotal: 0,
    fieldsActive: 0,
    tillableAcres: 0,
    helAcres: 0,
    crpAcres: 0,
    fieldsWithHEL: 0,
    fieldsWithCRP: 0
  };

  for (const [, f] of Object.entries(cols.fields || {})) {
    const active = isActiveStatus(f?.status);
    totals.fieldsTotal += 1;
    if (active) totals.fieldsActive += 1;

    if (!includeArchived && !active) continue;

    totals.tillableAcres += num(f?.tillable);

    const hasHEL = !!f?.hasHEL || num(f?.helAcres) > 0;
    const hasCRP = !!f?.hasCRP || num(f?.crpAcres) > 0;

    if (hasHEL) totals.fieldsWithHEL += 1;
    if (hasCRP) totals.fieldsWithCRP += 1;

    totals.helAcres += num(f?.helAcres);
    totals.crpAcres += num(f?.crpAcres);
  }

  return totals;
}

function totalsByFarm({ cols, includeArchived }) {
  // farmId -> { name, fields, tillable, hel, crp }
  const map = new Map();

  for (const [, f] of Object.entries(cols.fields || {})) {
    const active = isActiveStatus(f?.status);
    if (!includeArchived && !active) continue;

    const farmId = (f?.farmId || "").toString().trim() || "(none)";
    if (!map.has(farmId)) {
      const farm = cols.farms?.[farmId] || null;
      map.set(farmId, {
        farmId,
        name: (farm?.name || farmId).toString(),
        fields: 0,
        tillable: 0,
        hel: 0,
        crp: 0
      });
    }
    const rec = map.get(farmId);
    rec.fields += 1;
    rec.tillable += num(f?.tillable);
    rec.hel += num(f?.helAcres);
    rec.crp += num(f?.crpAcres);
  }

  const arr = Array.from(map.values());
  arr.sort((a, b) => (b.tillable - a.tillable) || a.name.localeCompare(b.name));
  return arr;
}

function totalsByCounty({ cols, includeArchived }) {
  // "County, ST" -> { fields, tillable, hel, crp }
  const map = new Map();

  for (const [, f] of Object.entries(cols.fields || {})) {
    const active = isActiveStatus(f?.status);
    if (!includeArchived && !active) continue;

    const county = (f?.county || "").toString().trim() || "(unknown)";
    const state = (f?.state || "").toString().trim();
    const key = state ? `${county}, ${state}` : county;

    if (!map.has(key)) {
      map.set(key, { key, fields: 0, tillable: 0, hel: 0, crp: 0 });
    }
    const rec = map.get(key);
    rec.fields += 1;
    rec.tillable += num(f?.tillable);
    rec.hel += num(f?.helAcres);
    rec.crp += num(f?.crpAcres);
  }

  const arr = Array.from(map.values());
  arr.sort((a, b) => (b.tillable - a.tillable) || a.key.localeCompare(b.key));
  return arr;
}

export async function handleFarmsFields({ question, snapshot, user, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) {
    return {
      ok: false,
      answer: "Snapshot not loaded (missing farms/fields).",
      meta: { routed: "farmsFields", reason: cols.reason }
    };
  }

  const q = norm(question);

  // -----------------------
  // A) TOTALS / BREAKDOWNS
  // -----------------------
  const askedTotals =
    wantsCount(q) ||
    wantsAcres(q) ||
    wantsHel(q) ||
    wantsCrp(q) ||
    q.includes("totals") ||
    q.includes("breakdown");

  // County-specific list/count (e.g. "acres in Macoupin county", "fields in Pike county")
  const countyGuess = extractCountyGuess(question);
  const farmGuessForTotals = extractFarmNameGuess(question);
  const farmGuessHit = farmGuessForTotals ? findFarmByName(cols, farmGuessForTotals) : null;

  if (askedTotals && (wantsByFarm(q) || wantsByCounty(q) || q.includes("county") || q.includes("farm") || q.includes("fields") || q.includes("acres") || wantsHel(q) || wantsCrp(q))) {
    // If they ask "by farm" explicitly
    if (wantsByFarm(q)) {
      const arr = totalsByFarm({ cols, includeArchived });
      const top = arr.slice(0, 10);

      const lines = [];
      lines.push(`Farm totals (${includeArchived ? "incl archived" : "active only"}):`);
      for (const r of top) {
        lines.push(`• ${r.name}: ${fmtAcre(r.tillable)} tillable ac • HEL ${fmtAcre(r.hel)} • CRP ${fmtAcre(r.crp)} • ${r.fields} fields`);
      }
      if (arr.length > top.length) lines.push(`…plus ${arr.length - top.length} more farms.`);

      return { ok: true, answer: lines.join("\n"), meta: { routed: "farmsFields", intent: "totals_by_farm" } };
    }

    // If they ask "by county" explicitly
    if (wantsByCounty(q)) {
      const arr = totalsByCounty({ cols, includeArchived });
      const top = arr.slice(0, 10);

      const lines = [];
      lines.push(`County totals (${includeArchived ? "incl archived" : "active only"}):`);
      for (const r of top) {
        lines.push(`• ${r.key}: ${fmtAcre(r.tillable)} tillable ac • HEL ${fmtAcre(r.hel)} • CRP ${fmtAcre(r.crp)} • ${r.fields} fields`);
      }
      if (arr.length > top.length) lines.push(`…plus ${arr.length - top.length} more counties.`);

      return { ok: true, answer: lines.join("\n"), meta: { routed: "farmsFields", intent: "totals_by_county" } };
    }

    // If they ask totals for a specific farm name (e.g. "Farm totals for Illiopolis-MtAuburn")
    if (farmGuessHit && (q.includes("farm") || q.includes("totals") || q.includes("acres") || q.includes("fields") || wantsHel(q) || wantsCrp(q))) {
      const farmId = farmGuessHit.id;
      let fields = 0, tillable = 0, hel = 0, crp = 0;

      for (const [, f] of Object.entries(cols.fields || {})) {
        const active = isActiveStatus(f?.status);
        if (!includeArchived && !active) continue;
        if ((f?.farmId || "") !== farmId) continue;

        fields += 1;
        tillable += num(f?.tillable);
        hel += num(f?.helAcres);
        crp += num(f?.crpAcres);
      }

      return {
        ok: true,
        answer:
          `Farm: ${farmGuessHit.name}\n` +
          `Fields: ${fmtInt(fields)}\n` +
          `Tillable acres: ${fmtAcre(tillable)}\n` +
          `HEL acres: ${fmtAcre(hel)}\n` +
          `CRP acres: ${fmtAcre(crp)}`,
        meta: { routed: "farmsFields", intent: "farm_totals", farmId }
      };
    }

    // If they ask totals for a specific county (e.g. "acres in Macoupin county")
    if (countyGuess && q.includes("county")) {
      const needle = norm(countyGuess);
      let fields = 0, tillable = 0, hel = 0, crp = 0;
      let matchedKey = "";

      for (const [, f] of Object.entries(cols.fields || {})) {
        const active = isActiveStatus(f?.status);
        if (!includeArchived && !active) continue;

        const c = norm(f?.county);
        if (!c) continue;
        if (c !== needle && !c.startsWith(needle) && !c.includes(needle)) continue;

        const state = (f?.state || "").toString().trim();
        matchedKey = state ? `${(f?.county || countyGuess).toString().trim()}, ${state}` : (f?.county || countyGuess).toString().trim();

        fields += 1;
        tillable += num(f?.tillable);
        hel += num(f?.helAcres);
        crp += num(f?.crpAcres);
      }

      if (!fields) {
        return {
          ok: true,
          answer: `I couldn’t find any ${includeArchived ? "" : "active "}fields in ${countyGuess} County.`,
          meta: { routed: "farmsFields", intent: "county_totals", county: countyGuess }
        };
      }

      return {
        ok: true,
        answer:
          `County: ${matchedKey}\n` +
          `Fields: ${fmtInt(fields)}\n` +
          `Tillable acres: ${fmtAcre(tillable)}\n` +
          `HEL acres: ${fmtAcre(hel)}\n` +
          `CRP acres: ${fmtAcre(crp)}`,
        meta: { routed: "farmsFields", intent: "county_totals", county: matchedKey }
      };
    }

    // Otherwise: overall totals (fields/acres/hel/crp)
    const t = buildTotals({ cols, includeArchived });

    // If they ONLY asked for fields count, keep it short.
    if (wantsCount(q) && q.includes("field") && !wantsAcres(q) && !wantsHel(q) && !wantsCrp(q)) {
      if (includeArchived) {
        const archived = t.fieldsTotal - t.fieldsActive;
        return {
          ok: true,
          answer: `Fields: ${fmtInt(t.fieldsActive)} active, ${fmtInt(archived)} archived/inactive (${fmtInt(t.fieldsTotal)} total).`,
          meta: { routed: "farmsFields", intent: "count_fields", ...t }
        };
      }
      return {
        ok: true,
        answer: `Active fields: ${fmtInt(t.fieldsActive)}. (Say “including archived” if you want the total.)`,
        meta: { routed: "farmsFields", intent: "count_fields", ...t }
      };
    }

    // Full totals line set
    const lines = [];
    lines.push(`Totals (${includeArchived ? "incl archived" : "active only"}):`);
    lines.push(`Fields: ${fmtInt(includeArchived ? t.fieldsTotal : t.fieldsActive)}`);
    lines.push(`Tillable acres: ${fmtAcre(t.tillableAcres)}`);
    lines.push(`HEL acres: ${fmtAcre(t.helAcres)} (${fmtInt(t.fieldsWithHEL)} fields)`);
    lines.push(`CRP acres: ${fmtAcre(t.crpAcres)} (${fmtInt(t.fieldsWithCRP)} fields)`);

    return { ok: true, answer: lines.join("\n"), meta: { routed: "farmsFields", intent: "totals_overall", ...t } };
  }

  // -----------------------
  // B) LIST FIELDS ON A FARM
  // -----------------------
  if ((wantsList(q) || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = extractFarmNameGuess(question);
    const farm = findFarmByName(cols, farmGuess);

    if (!farm) {
      return {
        ok: true,
        answer: `I couldn’t find that farm name. Try: "List fields on Illiopolis-MtAuburn" or use the exact farm name.`,
        meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmGuess }
      };
    }

    const ids = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      if (!includeArchived && !isActiveStatus(f?.status)) continue;
      if ((f?.farmId || "") === farm.id) ids.push(fieldId);
    }

    ids.sort((a, b) => {
      const la = formatFieldOptionLine({ snapshot, fieldId: a }) || "";
      const lb = formatFieldOptionLine({ snapshot, fieldId: b }) || "";
      return la.localeCompare(lb);
    });

    if (!ids.length) {
      return {
        ok: true,
        answer: `No ${includeArchived ? "" : "active "}fields found on ${farm.name || farm.id}.`,
        meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmId: farm.id }
      };
    }

    const lines = ids.slice(0, 40).map(id => `• ${formatFieldOptionLine({ snapshot, fieldId: id })}`);
    const more = ids.length > 40 ? `\n…plus ${ids.length - 40} more.` : "";

    return {
      ok: true,
      answer: `Fields on ${farm.name || farm.id} (${ids.length}):\n${lines.join("\n")}${more}`,
      meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmId: farm.id, count: ids.length }
    };
  }

  // -----------------------
  // C) FIELD LOOKUP (default)
  // -----------------------
  const res = tryResolveField({ snapshot, query: question, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
    if (!b.ok) {
      return {
        ok: true,
        answer: "Found the field id but could not load details.",
        meta: { routed: "farmsFields", intent: "field_lookup", reason: b.reason }
      };
    }

    const fieldName = (b.field?.name || b.fieldId).toString();
    const farmName = (b.farm?.name || "").toString();

    const county = (b.field?.county || "").toString().trim();
    const state  = (b.field?.state  || "").toString().trim();

    const status = (b.field?.status || "active").toString() || "active";
    const tillable = (typeof b.field?.tillable === "number") ? b.field.tillable : null;

    const hasHEL = !!b.field?.hasHEL || num(b.field?.helAcres) > 0;
    const hasCRP = !!b.field?.hasCRP || num(b.field?.crpAcres) > 0;

    const helAcres = num(b.field?.helAcres);
    const crpAcres = num(b.field?.crpAcres);

    const parts = [];
    parts.push(`Field: ${fieldName}`);
    if (farmName) parts.push(`Farm: ${farmName}`);
    if (county) parts.push(`County: ${county}${state ? ", " + state : ""}`);
    parts.push(`Status: ${status}`);
    if (tillable != null) parts.push(`Tillable: ${fmtAcre(tillable)} acres`);
    if (hasHEL) parts.push(`HEL acres: ${fmtAcre(helAcres)}`);
    if (hasCRP) parts.push(`CRP acres: ${fmtAcre(crpAcres)}`);

    return {
      ok: true,
      answer: parts.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "field_lookup",
        fieldId: b.fieldId,
        confidence: res.confidence || null,
        county: county || null,
        state: state || null
      }
    };
  }

  if (res.ok && res.resolved === false && Array.isArray(res.candidates) && res.candidates.length) {
    const lines = res.candidates
      .map(c => `• ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`)
      .join("\n");

    return {
      ok: true,
      answer: `I found a few close matches. Which one did you mean?\n${lines}`,
      meta: { routed: "farmsFields", intent: "field_disambiguation", candidates: res.candidates.map(c => c.fieldId) }
    };
  }

  return {
    ok: true,
    answer:
      `I can help with farms and fields. Try:\n` +
      `• "How many active fields do we have?"\n` +
      `• "Totals acres (tillable/HEL/CRP)"\n` +
      `• "Farm totals by farm"\n` +
      `• "County totals by county"\n` +
      `• "What county is 0801-Lloyd N340 in?"`,
    meta: { routed: "farmsFields", intent: "help" }
  };
}