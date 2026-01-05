// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-04-handler-filteredlists3-counties-farms-countyfields
//
// Adds:
// ✅ farms count: "How many farms do we have?"
// ✅ farms list:  "List all farms" (paged)
// ✅ county field list: "List fields in Macoupin County" (paged)
// ✅ county field list with acres: "List fields in Macoupin County with tillable acres"
// ✅ county field list grouped: "List fields in Macoupin County by farm"
//
// Keeps:
// ✅ filtered field lists (threshold + optional group by farm)
// ✅ counties we farm in list
// ✅ totals / breakdowns (by farm/by county/overall)
// ✅ list fields on a farm
// ✅ field lookup (auto-pick resolver)
// ✅ no menus / no 3-choice lists
// ✅ meta.continuation for "more/show all"

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

// ------------------------
// Intent helpers
// ------------------------
function wantsCount(q) { return q.includes("how many") || q.includes("count") || q.includes("total") || q.includes("number of"); }
function wantsAcres(q) { return q.includes("acres") || q.includes("tillable") || q.includes("acre"); }
function wantsHel(q) { return q.includes("hel"); }
function wantsCrp(q) { return q.includes("crp"); }
function wantsByFarm(q) { return q.includes("by farm") || (q.includes("farm") && (q.includes("breakdown") || q.includes("totals") || q.includes("total"))); }
function wantsByCounty(q) { return q.includes("by county") || q.includes("county totals") || (q.includes("county") && (q.includes("breakdown") || q.includes("totals") || q.includes("total"))); }
function wantsList(q) { return q.includes("list") || q.includes("show"); }

function wantsGroupByFarm(q) {
  return q.includes("by farm") || q.includes("group by farm") || (q.includes("group") && q.includes("farm"));
}

function wantsCountiesWeFarmIn(q) {
  const s = norm(q);
  if (!s.includes("county") && !s.includes("counties")) return false;

  if (s.includes("counties we farm in")) return true;
  if (s.includes("counties do we farm in")) return true;
  if (s.includes("what counties") && s.includes("farm")) return true;
  if ((s.includes("list") || s.includes("show")) && s.includes("count") && s.includes("farm")) return true;
  if (s.includes("per county") && s.includes("tillable")) return true;

  return false;
}

function wantsFarmsCount(q) {
  const s = norm(q);
  if (!wantsCount(s)) return false;
  return s.includes("farm") || s.includes("farms");
}

function wantsFarmsList(q) {
  const s = norm(q);
  // "list farms", "show farms", "list all farms"
  if (!(wantsList(s) || s.includes("all"))) return false;
  return s.includes("farm") || s.includes("farms");
}

function wantsCountyFieldList(q) {
  const s = norm(q);
  // "list fields in macoupin county", "show fields in sangamon county"
  if (!(wantsList(s) || s.includes("which"))) return false;
  if (!s.includes("field")) return false;
  return s.includes("county");
}

function wantsCountyFieldListByFarm(q) {
  const s = norm(q);
  return wantsCountyFieldList(s) && wantsGroupByFarm(s);
}

function wantsCountyFieldListWithAcres(q) {
  const s = norm(q);
  return wantsCountyFieldList(s) && (s.includes("tillable") || s.includes("acres") || s.includes("with acres"));
}

function looksLikeFilteredList(q) {
  if (!(wantsList(q) || q.includes("which"))) return false;
  if (!q.includes("field")) return false;

  return (
    q.includes("more than") ||
    q.includes("greater than") ||
    q.includes("over ") ||
    q.includes("above ") ||
    q.includes("at least") ||
    q.includes(">") ||
    q.includes(">=")
  );
}

function extractThreshold(raw) {
  const s = (raw || "").toString();

  let m = s.match(/>=\s*([0-9]*\.?[0-9]+)/);
  if (m) return { op: ">=", value: Number(m[1]) };

  m = s.match(/>\s*([0-9]*\.?[0-9]+)/);
  if (m) return { op: ">", value: Number(m[1]) };

  m = s.match(/\b(at\s+least)\s*([0-9]*\.?[0-9]+)/i);
  if (m) return { op: ">=", value: Number(m[2]) };

  m = s.match(/\b(more\s+than|greater\s+than|over|above)\s*([0-9]*\.?[0-9]+)/i);
  if (m) return { op: ">", value: Number(m[2]) };

  m = s.match(/([0-9]*\.?[0-9]+)/);
  if (m) return { op: ">", value: Number(m[1]) };

  return null;
}

function metricFromQuery(q) {
  if (wantsHel(q)) return "hel";
  if (wantsCrp(q)) return "crp";
  if (q.includes("tillable")) return "tillable";
  if (q.includes("acres") || q.includes("acre")) return "tillable";
  return "tillable";
}

function metricLabel(metric) {
  if (metric === "hel") return "HEL acres";
  if (metric === "crp") return "CRP acres";
  if (metric === "tillable") return "Tillable acres";
  return "Acres";
}

function metricValue(field, metric) {
  if (metric === "hel") return num(field?.helAcres);
  if (metric === "crp") return num(field?.crpAcres);
  if (metric === "tillable") return num(field?.tillable);
  return 0;
}

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

// ------------------------
// Totals builders
// ------------------------
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

// =====================================================================
// Handler
// =====================================================================
export async function handleFarmsFields({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) {
    return {
      ok: false,
      answer: "Please check /data/fieldData.js — snapshot collections not loaded.",
      meta: { routed: "farmsFields", reason: cols.reason, debugFile: "/data/fieldData.js" }
    };
  }

  const raw = (question || "").toString();
  const q = norm(raw);

  // =====================================================================
  // A) FARMS: count + list
  // =====================================================================
  if (wantsFarmsCount(q)) {
    let total = 0, active = 0;
    for (const [, f] of Object.entries(cols.farms || {})) {
      total += 1;
      if (isActiveStatus(f?.status)) active += 1;
    }

    if (includeArchived) {
      const archived = total - active;
      return {
        ok: true,
        answer: `Farms: ${fmtInt(active)} active, ${fmtInt(archived)} archived/inactive (${fmtInt(total)} total).`,
        meta: { routed: "farmsFields", intent: "count_farms" }
      };
    }

    return {
      ok: true,
      answer: `Active farms: ${fmtInt(active)}. (Say "including archived" for total.)`,
      meta: { routed: "farmsFields", intent: "count_farms" }
    };
  }

  if (wantsFarmsList(q)) {
    const farms = [];
    for (const [farmId, f] of Object.entries(cols.farms || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;
      farms.push((f?.name || farmId).toString());
    }
    farms.sort((a, b) => a.localeCompare(b));

    const title = `Farms (${includeArchived ? "incl archived" : "active only"}):`;
    const lines = farms.map(n => `• ${n}`);

    const pageSize = 30;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more farms.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "list_farms",
        continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null
      }
    };
  }

  // =====================================================================
  // B) COUNTY: list fields in county (NEW)
  // =====================================================================
  if (wantsCountyFieldList(q)) {
    const countyGuess = extractCountyGuess(raw);
    if (!countyGuess) {
      return {
        ok: false,
        answer: 'Which county? Example: "List fields in Macoupin County"',
        meta: { routed: "farmsFields", intent: "county_fields_need_county" }
      };
    }

    const needle = norm(countyGuess);
    const includeAcres = wantsCountyFieldListWithAcres(q);
    const grouped = wantsCountyFieldListByFarm(q);

    const matches = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const c = norm(f?.county);
      if (!c) continue;
      if (c !== needle && !c.startsWith(needle) && !c.includes(needle)) continue;

      const farmId = (f?.farmId || "").toString().trim() || "";
      const farm = farmId ? (cols.farms?.[farmId] || null) : null;
      const farmName = (farm?.name || farmId || "(none)").toString();

      matches.push({
        fieldId,
        label: formatFieldOptionLine({ snapshot, fieldId }) || fieldId,
        farmName,
        tillable: num(f?.tillable)
      });
    }

    if (!matches.length) {
      return {
        ok: true,
        answer: `No ${includeArchived ? "" : "active "}fields found in ${countyGuess} County.`,
        meta: { routed: "farmsFields", intent: "county_fields_none" }
      };
    }

    // Sort
    matches.sort((a, b) => (a.farmName.localeCompare(b.farmName)) || a.label.localeCompare(b.label));

    const title = `Fields in ${countyGuess} County (${includeArchived ? "incl archived" : "active only"}):`;

    let lines = [];
    if (grouped) {
      const map = new Map();
      for (const m of matches) {
        const k = m.farmName || "(none)";
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(m);
      }
      const farms = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));

      for (const [farmName, items] of farms) {
        lines.push(`Farm: ${farmName} (${items.length} fields)`);
        for (const it of items) {
          if (!includeAcres) lines.push(`• ${it.label}`);
          else lines.push(`• ${it.label}\n  ${fmtAcre(it.tillable)} ac`);
        }
        lines.push("");
      }
      while (lines.length && !lines[lines.length - 1]) lines.pop();
    } else {
      lines = matches.map(it => {
        if (!includeAcres) return `• ${it.label}`;
        return `• ${it.label}\n  ${fmtAcre(it.tillable)} ac`;
      });
    }

    const pageSize = grouped ? 60 : 35;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more lines.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "county_fields_list",
        continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null
      }
    };
  }

  // =====================================================================
  // 0) FILTERED FIELD LISTS (existing)
  // =====================================================================
  if (looksLikeFilteredList(q)) {
    const metric = metricFromQuery(q);
    const thresh = extractThreshold(raw);

    if (!thresh || !Number.isFinite(thresh.value)) {
      return {
        ok: false,
        answer: "Please check /handlers/farmsFields.handler.js — could not parse the threshold number in your filter.",
        meta: { routed: "farmsFields", intent: "filtered_list_failed", debugFile: "/handlers/farmsFields.handler.js" }
      };
    }

    const op = thresh.op || ">";
    const minVal = Number(thresh.value);
    const grouped = wantsGroupByFarm(q);

    const matches = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const v = metricValue(f, metric);
      const pass = (op === ">=") ? (v >= minVal) : (v > minVal);
      if (!pass) continue;

      const farmId = (f?.farmId || "").toString().trim() || "";
      const farm = farmId ? (cols.farms?.[farmId] || null) : null;
      const farmName = (farm?.name || farmId || "(none)").toString();

      matches.push({
        fieldId,
        label: formatFieldOptionLine({ snapshot, fieldId }) || fieldId,
        value: v,
        farmName
      });
    }

    matches.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));

    const title = `Fields with ${metricLabel(metric)} ${op} ${minVal} (${includeArchived ? "incl archived" : "active only"}):`;

    let allLines = [];

    if (grouped) {
      const farmMap = new Map();
      for (const m of matches) {
        const k = (m.farmName || "(none)").toString();
        if (!farmMap.has(k)) farmMap.set(k, { name: k, items: [] });
        farmMap.get(k).items.push(m);
      }

      const farms = Array.from(farmMap.values());
      for (const f of farms) {
        f.items.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));
        f.total = f.items.reduce((s, x) => s + (Number(x.value) || 0), 0);
      }
      farms.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));

      for (const f of farms) {
        allLines.push(`Farm: ${f.name} (${f.items.length} fields)`);
        for (const it of f.items) {
          allLines.push(`• ${it.label} — ${fmtAcre(it.value)} ac`);
        }
        allLines.push("");
      }

      while (allLines.length && !allLines[allLines.length - 1]) allLines.pop();
    } else {
      allLines = matches.map(it => `• ${it.label} — ${fmtAcre(it.value)} ac`);
    }

    const pageSize = grouped ? 80 : 60;
    const first = allLines.slice(0, pageSize);
    const remaining = allLines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more lines.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "filtered_list",
        continuation: (remaining > 0) ? { kind: "page", title, lines: allLines, offset: pageSize, pageSize } : null
      }
    };
  }

  // =====================================================================
  // 1) COUNTIES WE FARM IN (existing)
  // =====================================================================
  if (wantsCountiesWeFarmIn(q)) {
    const arr = totalsByCounty({ cols, includeArchived });
    const title = `Counties we farm in (${includeArchived ? "incl archived" : "active only"}):`;

    const allLines = arr.map(r => `• ${r.key}: ${fmtAcre(r.tillable)} tillable ac • ${r.fields} fields`);
    const pageSize = 15;
    const first = allLines.slice(0, pageSize);
    const remaining = allLines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more counties.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "counties_list",
        continuation: (remaining > 0) ? { kind: "page", title, lines: allLines, offset: pageSize, pageSize } : null
      }
    };
  }

  // -----------------------
  // TOTALS / BREAKDOWNS + list fields on a farm + field lookup
  // (unchanged from your file below)
  // -----------------------

  // A) TOTALS / BREAKDOWNS
  const askedTotals =
    wantsCount(q) || wantsAcres(q) || wantsHel(q) || wantsCrp(q) || q.includes("totals") || q.includes("breakdown");

  const countyGuess = extractCountyGuess(raw);
  const farmGuessForTotals = extractFarmNameGuess(raw);
  const farmGuessHit = farmGuessForTotals ? findFarmByName(cols, farmGuessForTotals) : null;

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
        meta: { routed: "farmsFields", intent: "totals_by_farm", continuation: (remaining > 0) ? { kind: "page", title: "Farm totals", lines: allLines, offset: pageSize, pageSize } : null }
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
        meta: { routed: "farmsFields", intent: "totals_by_county", continuation: (remaining > 0) ? { kind: "page", title: "County totals", lines: allLines, offset: pageSize, pageSize } : null }
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
        meta: { routed: "farmsFields", intent: "farm_totals", farmId }
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
        return { ok: true, answer: `I couldn’t find any ${includeArchived ? "" : "active "}fields in ${countyGuess} County.`, meta: { routed: "farmsFields", intent: "county_totals_none" } };
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

    const t = buildTotals({ cols, includeArchived });
    const lines = [];
    lines.push(`Totals (${includeArchived ? "incl archived" : "active only"}):`);
    lines.push(`Fields: ${fmtInt(includeArchived ? t.fieldsTotal : t.fieldsActive)}`);
    lines.push(`Tillable acres: ${fmtAcre(t.tillableAcres)}`);
    lines.push(`HEL acres: ${fmtAcre(t.helAcres)} (${fmtInt(t.fieldsWithHEL)} fields)`);
    lines.push(`CRP acres: ${fmtAcre(t.crpAcres)} (${fmtInt(t.fieldsWithCRP)} fields)`);

    return { ok: true, answer: lines.join("\n"), meta: { routed: "farmsFields", intent: "totals_overall" } };
  }

  // B) LIST FIELDS ON A FARM
  if ((wantsList(q) || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = extractFarmNameGuess(raw);
    const farm = findFarmByName(cols, farmGuess);

    if (!farm) {
      return { ok: false, answer: `Please check /handlers/farmsFields.handler.js — couldn't extract farm name.`, meta: { routed: "farmsFields" } };
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

    const lines = ids.map(id => `• ${formatFieldOptionLine({ snapshot, fieldId: id })}`);
    const pageSize = 40;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(`Fields on ${farm.name || farm.id} (${ids.length}):`);
    out.push(...first);
    if (remaining > 0) out.push(`…plus ${remaining} more.`);

    return { ok: true, answer: out.join("\n"), meta: { routed: "farmsFields", intent: "list_fields_on_farm", continuation: (remaining > 0) ? { kind: "page", title: "Fields on farm", lines, offset: pageSize, pageSize } : null } };
  }

  // C) FIELD LOOKUP (default)
  const res = tryResolveField({ snapshot, query: raw, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
    if (!b.ok) return { ok: false, answer: "Please check /data/fieldData.js — bundle load failed.", meta: { routed: "farmsFields" } };

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

    if (res.ambiguous) parts.push(`(Auto-selected best match — check /data/fieldData.js scoring if wrong.)`);

    return { ok: true, answer: parts.join("\n"), meta: { routed: "farmsFields", intent: "field_lookup" } };
  }

  return { ok: false, answer: "Please check /data/fieldData.js — resolver could not match this query.", meta: { routed: "farmsFields", intent: "no_match" } };
}