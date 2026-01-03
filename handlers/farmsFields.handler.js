// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-03-handler-followups-global2
//
// Keeps your working totals + field lookup behavior.
// Adds contextDelta so global conversation can carry on.
//
// Rules (per Dane):
// ✅ No "Quick check" menus.
// ✅ No 3-choice disambiguation lists (resolver auto-picks).
// ✅ When returning truncated lists, attach meta.continuation for paging ("more/the rest/show all").
// ✅ Always attach meta.contextDelta to support global follow-ups ("same but CRP", "by county", "that field", etc.).
// ✅ If can't answer, return "Please check <file> ..."

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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function fmtAcre(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Intent helpers
function wantsCount(q) { return q.includes("how many") || q.includes("count") || q.includes("total") || q.includes("number of"); }
function wantsAcres(q) { return q.includes("acres") || q.includes("tillable") || q.includes("acre"); }
function wantsHel(q) { return q.includes("hel"); }
function wantsCrp(q) { return q.includes("crp"); }
function wantsByFarm(q) { return q.includes("by farm") || (q.includes("farm") && (q.includes("breakdown") || q.includes("totals") || q.includes("total"))); }
function wantsByCounty(q) { return q.includes("by county") || q.includes("county totals") || (q.includes("county") && (q.includes("breakdown") || q.includes("totals") || q.includes("total"))); }
function wantsList(q) { return q.includes("list") || q.includes("show"); }

function extractFarmNameGuess(raw) {
  const m = String(raw || "").match(/\b(?:on|in)\s+([a-z0-9][a-z0-9\s\-\._]{1,60})$/i);
  if (!m) return "";
  return (m[1] || "").toString().trim();
}

function extractCountyGuess(raw) {
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

function metricFromQuery(q) {
  if (wantsHel(q)) return "hel";
  if (wantsCrp(q)) return "crp";
  if (wantsAcres(q)) return "tillable";
  if (wantsCount(q) && q.includes("field")) return "fields";
  return "all";
}

export async function handleFarmsFields({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) {
    return {
      ok: false,
      answer: "Please check /data/fieldData.js — snapshot collections not loaded.",
      meta: {
        routed: "farmsFields",
        reason: cols.reason,
        debugFile: "/data/fieldData.js",
        contextDelta: { lastIntent: "snapshot_error", lastScope: { includeArchived: !!includeArchived } }
      }
    };
  }

  const raw = (question || "").toString();
  const q = norm(raw);

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

  const countyGuess = extractCountyGuess(raw);
  const farmGuessForTotals = extractFarmNameGuess(raw);
  const farmGuessHit = farmGuessForTotals ? findFarmByName(cols, farmGuessForTotals) : null;
  const metric = metricFromQuery(q);

  if (askedTotals) {
    if (wantsByFarm(q)) {
      const arr = totalsByFarm({ cols, includeArchived });
      const allLines = arr.map(r =>
        `• ${r.name}: ${fmtAcre(r.tillable)} tillable ac • HEL ${fmtAcre(r.hel)} • CRP ${fmtAcre(r.crp)} • ${r.fields} fields`
      );

      const pageSize = 10;
      const first = allLines.slice(0, pageSize);
      const remaining = allLines.length - first.length;

      const out = [];
      out.push(`Farm totals (${includeArchived ? "incl archived" : "active only"}):`);
      out.push(...first);
      if (remaining > 0) out.push(`…plus ${remaining} more farms.`);

      return {
        ok: true,
        answer: out.join("\n"),
        meta: {
          routed: "farmsFields",
          intent: "totals_by_farm",
          continuation: (remaining > 0) ? {
            kind: "page",
            title: `Farm totals (${includeArchived ? "incl archived" : "active only"}):`,
            lines: allLines,
            offset: pageSize,
            pageSize
          } : null,
          contextDelta: {
            lastIntent: "totals_by_farm",
            lastMetric: metric,
            lastBy: "farm",
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    if (wantsByCounty(q)) {
      const arr = totalsByCounty({ cols, includeArchived });
      const allLines = arr.map(r =>
        `• ${r.key}: ${fmtAcre(r.tillable)} tillable ac • HEL ${fmtAcre(r.hel)} • CRP ${fmtAcre(r.crp)} • ${r.fields} fields`
      );

      const pageSize = 10;
      const first = allLines.slice(0, pageSize);
      const remaining = allLines.length - first.length;

      const out = [];
      out.push(`County totals (${includeArchived ? "incl archived" : "active only"}):`);
      out.push(...first);
      if (remaining > 0) out.push(`…plus ${remaining} more counties.`);

      return {
        ok: true,
        answer: out.join("\n"),
        meta: {
          routed: "farmsFields",
          intent: "totals_by_county",
          continuation: (remaining > 0) ? {
            kind: "page",
            title: `County totals (${includeArchived ? "incl archived" : "active only"}):`,
            lines: allLines,
            offset: pageSize,
            pageSize
          } : null,
          contextDelta: {
            lastIntent: "totals_by_county",
            lastMetric: metric,
            lastBy: "county",
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    if (farmGuessHit && (q.includes("farm") || q.includes(" on ") || q.includes(" in "))) {
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
        meta: {
          routed: "farmsFields",
          intent: "farm_totals",
          farmId,
          contextDelta: {
            lastIntent: "farm_totals",
            lastMetric: metric,
            lastBy: "farm",
            lastEntity: { type: "farm", id: farmId, name: farmGuessHit.name || farmId },
            lastScope: { includeArchived: !!includeArchived, farmId, farmName: farmGuessHit.name || farmId }
          }
        }
      };
    }

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
          meta: {
            routed: "farmsFields",
            intent: "county_totals_none",
            contextDelta: {
              lastIntent: "county_totals",
              lastMetric: metric,
              lastBy: "county",
              lastEntity: { type: "county", id: countyGuess, name: countyGuess },
              lastScope: { includeArchived: !!includeArchived, county: countyGuess }
            }
          }
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
        meta: {
          routed: "farmsFields",
          intent: "county_totals",
          county: matchedKey,
          contextDelta: {
            lastIntent: "county_totals",
            lastMetric: metric,
            lastBy: "county",
            lastEntity: { type: "county", id: matchedKey, name: matchedKey },
            lastScope: { includeArchived: !!includeArchived, county: matchedKey }
          }
        }
      };
    }

    const t = buildTotals({ cols, includeArchived });

    if (wantsCount(q) && q.includes("field") && !wantsAcres(q) && !wantsHel(q) && !wantsCrp(q)) {
      if (includeArchived) {
        const archived = t.fieldsTotal - t.fieldsActive;
        return {
          ok: true,
          answer: `Fields: ${fmtInt(t.fieldsActive)} active, ${fmtInt(archived)} archived/inactive (${fmtInt(t.fieldsTotal)} total).`,
          meta: {
            routed: "farmsFields",
            intent: "count_fields",
            ...t,
            contextDelta: {
              lastIntent: "count_fields",
              lastMetric: "fields",
              lastBy: "",
              lastScope: { includeArchived: !!includeArchived }
            }
          }
        };
      }
      return {
        ok: true,
        answer: `Active fields: ${fmtInt(t.fieldsActive)}.`,
        meta: {
          routed: "farmsFields",
          intent: "count_fields",
          ...t,
          contextDelta: {
            lastIntent: "count_fields",
            lastMetric: "fields",
            lastBy: "",
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    const lines = [];
    lines.push(`Totals (${includeArchived ? "incl archived" : "active only"}):`);
    lines.push(`Fields: ${fmtInt(includeArchived ? t.fieldsTotal : t.fieldsActive)}`);
    lines.push(`Tillable acres: ${fmtAcre(t.tillableAcres)}`);
    lines.push(`HEL acres: ${fmtAcre(t.helAcres)} (${fmtInt(t.fieldsWithHEL)} fields)`);
    lines.push(`CRP acres: ${fmtAcre(t.crpAcres)} (${fmtInt(t.fieldsWithCRP)} fields)`);

    return {
      ok: true,
      answer: lines.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "totals_overall",
        ...t,
        contextDelta: {
          lastIntent: "totals_overall",
          lastMetric: metric,
          lastBy: "",
          lastScope: { includeArchived: !!includeArchived }
        }
      }
    };
  }

  // -----------------------
  // B) LIST FIELDS ON A FARM
  // -----------------------
  if ((wantsList(q) || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = extractFarmNameGuess(raw);
    const farm = findFarmByName(cols, farmGuess);

    if (!farm) {
      return {
        ok: false,
        answer: "Please check /handlers/farmsFields.handler.js — could not extract farm name for list-fields query.",
        meta: {
          routed: "farmsFields",
          intent: "list_fields_on_farm_failed",
          debugFile: "/handlers/farmsFields.handler.js",
          farmGuess,
          contextDelta: { lastIntent: "list_fields_on_farm_failed", lastScope: { includeArchived: !!includeArchived } }
        }
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
        meta: {
          routed: "farmsFields",
          intent: "list_fields_on_farm",
          farmId: farm.id,
          contextDelta: {
            lastIntent: "list_fields_on_farm",
            lastMetric: "fields",
            lastBy: "farm",
            lastEntity: { type: "farm", id: farm.id, name: farm.name || farm.id },
            lastScope: { includeArchived: !!includeArchived, farmId: farm.id, farmName: farm.name || farm.id }
          }
        }
      };
    }

    const allLines = ids.map(id => `• ${formatFieldOptionLine({ snapshot, fieldId: id })}`);
    const pageSize = 40;
    const first = allLines.slice(0, pageSize);
    const remaining = allLines.length - first.length;

    const out = [];
    out.push(`Fields on ${farm.name || farm.id} (${ids.length}):`);
    out.push(...first);
    if (remaining > 0) out.push(`…plus ${remaining} more.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "list_fields_on_farm",
        farmId: farm.id,
        count: ids.length,
        continuation: (remaining > 0) ? {
          kind: "page",
          title: `Fields on ${farm.name || farm.id} (${ids.length}):`,
          lines: allLines,
          offset: pageSize,
          pageSize
        } : null,
        contextDelta: {
          lastIntent: "list_fields_on_farm",
          lastMetric: "fields",
          lastBy: "farm",
          lastEntity: { type: "farm", id: farm.id, name: farm.name || farm.id },
          lastScope: { includeArchived: !!includeArchived, farmId: farm.id, farmName: farm.name || farm.id }
        }
      }
    };
  }

  // -----------------------
  // C) FIELD LOOKUP (default)
  // -----------------------
  const res = tryResolveField({ snapshot, query: raw, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
    if (!b.ok) {
      return {
        ok: false,
        answer: "Please check /handlers/farmsFields.handler.js — buildFieldBundle failed after resolver selection.",
        meta: {
          routed: "farmsFields",
          intent: "field_lookup_failed",
          debugFile: "/handlers/farmsFields.handler.js",
          bundleReason: b.reason,
          contextDelta: { lastIntent: "field_lookup_failed", lastScope: { includeArchived: !!includeArchived } }
        }
      };
    }

    const f = b.field || {};
    const farm = b.farm || {};

    const parts = [];
    parts.push(`Field: ${f.name || b.fieldId}`);
    if (farm.name) parts.push(`Farm: ${farm.name}`);
    if (f.county) parts.push(`County: ${f.county}${f.state ? ", " + f.state : ""}`);
    parts.push(`Status: ${f.status || "active"}`);
    if (typeof f.tillable === "number") parts.push(`Tillable: ${fmtAcre(f.tillable)} acres`);
    if (num(f.helAcres) > 0) parts.push(`HEL acres: ${fmtAcre(f.helAcres)}`);
    if (num(f.crpAcres) > 0) parts.push(`CRP acres: ${fmtAcre(f.crpAcres)}`);

    if (res.ambiguous) {
      parts.push(`(Auto-selected best match — check /data/fieldData.js scoring if wrong.)`);
    }

    return {
      ok: true,
      answer: parts.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "field_lookup",
        fieldId: b.fieldId,
        confidence: res.confidence || null,
        contextDelta: {
          lastIntent: "field_lookup",
          lastMetric: "field",
          lastBy: "",
          lastEntity: { type: "field", id: b.fieldId, name: f.name || b.fieldId },
          lastScope: { includeArchived: !!includeArchived }
        }
      }
    };
  }

  return {
    ok: false,
    answer: "Please check /data/fieldData.js — resolver could not match this query.",
    meta: {
      routed: "farmsFields",
      intent: "no_match",
      debugFile: "/data/fieldData.js",
      resolverDebug: res?.debug || null,
      contextDelta: { lastIntent: "no_match", lastScope: { includeArchived: !!includeArchived } }
    }
  };
}