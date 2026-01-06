// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-05-handler-filteredlists2-counties-metric-by-helcrp-autofilter-sortmode
//
// Default sorting:
// ✅ Farms / Counties summaries: A→Z
// ✅ Fields lists: numeric by leading field number, then name
//
// User overrides:
// ✅ "largest first" / "descending" / "high to low" => largest first (by metric)
// ✅ "smallest first" / "ascending" / "low to high" => smallest first (by metric)
//
// Adds:
// ✅ Metric summaries by county and by farm (tillable/HEL/CRP/fields)
// ✅ Natural-language "fields with HEL/CRP" => auto threshold >0 (routes into filtered list)
//
// Keeps existing behaviors:
// ✅ filtered field lists (threshold + optional group by farm)
// ✅ counties we farm in list intent
// ✅ totals overall
// ✅ list fields on a farm
// ✅ field lookup (auto-pick resolver)
// ✅ paging via meta.continuation

'use strict';

import {
  getSnapshotCollections,
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine
} from "../data/fieldData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

/* =========================
   Sort helpers
========================= */
function alphaKey(s) {
  return (s || "").toString().trim().toLowerCase();
}

// For labels like "0504-Bierman (FarmName)" or "0504-Bierman"
function fieldSortKey(label) {
  const s = (label || "").toString().trim();
  const m = s.match(/^\s*(\d{3,4})\s*[-–—]\s*(.*)$/);
  const n = m ? parseInt(m[1], 10) : 999999;
  const rest = alphaKey(m ? m[2] : s);
  return { n, rest, full: alphaKey(s) };
}

function sortFieldsByNumberThenName(a, b) {
  const A = fieldSortKey(a);
  const B = fieldSortKey(b);
  if (A.n !== B.n) return A.n - B.n;
  if (A.rest !== B.rest) return A.rest.localeCompare(B.rest);
  return A.full.localeCompare(B.full);
}

function detectSortMode(qRaw) {
  const q = alphaKey(qRaw);

  const largest = (
    q.includes("largest first") ||
    q.includes("biggest first") ||
    q.includes("descending") ||
    q.includes("high to low") ||
    q.includes("most first") ||
    q.includes("top first")
  );

  const smallest = (
    q.includes("smallest first") ||
    q.includes("ascending") ||
    q.includes("low to high") ||
    q.includes("least first") ||
    q.includes("bottom first")
  );

  if (largest) return "largest";
  if (smallest) return "smallest";
  return "az";
}

function sortRows({ rows, mode, nameKey, valueKey }) {
  const m = mode || "az";
  const nk = nameKey || "name";
  const vk = valueKey || "value";

  rows.sort((a, b) => {
    const an = alphaKey(a?.[nk]);
    const bn = alphaKey(b?.[nk]);
    const av = Number(a?.[vk]) || 0;
    const bv = Number(b?.[vk]) || 0;

    if (m === "largest") {
      const d = bv - av;
      if (d !== 0) return d;
      return an.localeCompare(bn);
    }
    if (m === "smallest") {
      const d = av - bv;
      if (d !== 0) return d;
      return an.localeCompare(bn);
    }
    return an.localeCompare(bn);
  });

  return rows;
}

function sortHintLine(mode) {
  if (mode === "largest") return `Tip: say "A-Z" to sort alphabetically.`;
  if (mode === "smallest") return `Tip: say "A-Z" to sort alphabetically.`;
  return `Tip: say "largest first" to sort by acres.`;
}

/* =========================
   Data helpers
========================= */
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
  if (metric === "fields") return "Fields";
  return "Value";
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

/* ------------------------
   Totals builders
------------------------ */
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

  return Array.from(map.values());
}

function totalsByCounty({ cols, includeArchived }) {
  const map = new Map();

  for (const [, f] of Object.entries(cols.fields || {})) {
    const active = isActiveStatus(f?.status);
    if (!includeArchived && !active) continue;

    const county = (f?.county || "").toString().trim() || "(unknown)";
    const state = (f?.state || "").toString().trim();
    const key = state ? `${county}, ${state}` : county;

    if (!map.has(key)) map.set(key, { key, fields: 0, tillable: 0, hel: 0, crp: 0 });

    const rec = map.get(key);
    rec.fields += 1;
    rec.tillable += num(f?.tillable);
    rec.hel += num(f?.helAcres);
    rec.crp += num(f?.crpAcres);
  }

  return Array.from(map.values());
}

/* =========================
   Handler
========================= */
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
  const sortMode = detectSortMode(raw);

  // ✅ Natural-language "fields with HEL/CRP" fallback (auto threshold > 0)
  const _autofilterGuard = meta?.routerReason === "nl_fields_with_metric_autothreshold";

  const mentionsFields = (q.includes("field") || q.includes("fields"));
  const mentionsHel = q.includes("hel");
  const mentionsCrp = q.includes("crp");

  const wantsTheseFields =
    wantsList(q) ||
    q.includes("just") ||
    q.includes("only") ||
    q.includes("with ") ||
    q.includes("has ") ||
    q.includes("have ") ||
    q.includes("that have") ||
    q.includes("where ");

  const wantsFieldsWithHel = mentionsFields && mentionsHel && wantsTheseFields;
  const wantsFieldsWithCrp = mentionsFields && mentionsCrp && wantsTheseFields;

  const hasComparator =
    q.includes(">") || q.includes(">=") ||
    q.includes("more than") || q.includes("greater than") ||
    q.includes("over ") || q.includes("above ") ||
    q.includes("at least");

  if (!_autofilterGuard && (wantsFieldsWithHel || wantsFieldsWithCrp) && !hasComparator) {
    const rewritten = wantsFieldsWithHel
      ? "Show fields with HEL acres > 0"
      : "Show fields with CRP acres > 0";

    return await handleFarmsFields({
      question: rewritten,
      snapshot,
      user,
      includeArchived,
      meta: { ...(meta || {}), routerReason: "nl_fields_with_metric_autothreshold" }
    });
  }

  // ✅ Metric summaries by county (A→Z default, optional largest/smallest)
  if (q.includes("by county") && (wantsAcres(q) || wantsHel(q) || wantsCrp(q) || q.includes("fields"))) {
    const metric =
      wantsHel(q) ? "hel" :
      wantsCrp(q) ? "crp" :
      (q.includes("fields") && !wantsAcres(q) && !wantsHel(q) && !wantsCrp(q)) ? "fields" :
      "tillable";

    const rows = totalsByCounty({ cols, includeArchived }).map(r => ({
      name: r.key,
      value: (metric === "fields") ? r.fields : (metric === "hel") ? r.hel : (metric === "crp") ? r.crp : r.tillable,
      raw: r
    }));

    sortRows({ rows, mode: sortMode, nameKey: "name", valueKey: "value" });

    const title = `${metricLabel(metric)} by county (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;

    const lines = rows.map(x => {
      const r = x.raw;
      if (metric === "fields") return `• ${r.key}\n  ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.key}\n  ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.key}\n  ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.key}\n  ${fmtAcre(r.tillable)} tillable ac`;
    });

    const pageSize = 12;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more counties.`);
    out.push(`\n${sortHintLine(sortMode)}`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "metric_by_county",
        continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null
      }
    };
  }

  // ✅ Metric summaries by farm (A→Z default, optional largest/smallest)
  if (q.includes("by farm") && (wantsAcres(q) || wantsHel(q) || wantsCrp(q) || q.includes("fields"))) {
    const metric =
      wantsHel(q) ? "hel" :
      wantsCrp(q) ? "crp" :
      (q.includes("fields") && !wantsAcres(q) && !wantsHel(q) && !wantsCrp(q)) ? "fields" :
      "tillable";

    const rows = totalsByFarm({ cols, includeArchived }).map(r => ({
      name: r.name,
      value: (metric === "fields") ? r.fields : (metric === "hel") ? r.hel : (metric === "crp") ? r.crp : r.tillable,
      raw: r
    }));

    sortRows({ rows, mode: sortMode, nameKey: "name", valueKey: "value" });

    const title = `${metricLabel(metric)} by farm (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;

    const lines = rows.map(x => {
      const r = x.raw;
      if (metric === "fields") return `• ${r.name}\n  ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.name}\n  ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.name}\n  ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.name}\n  ${fmtAcre(r.tillable)} tillable ac`;
    });

    const pageSize = 12;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more farms.`);
    out.push(`\n${sortHintLine(sortMode)}`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "farmsFields",
        intent: "metric_by_farm",
        continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null
      }
    };
  }

  // =====================================================================
  // FILTERED FIELD LISTS (existing)
  // =====================================================================
  if (looksLikeFilteredList(q)) {
    const metric = metricFromQuery(q);
    const thresh = extractThreshold(raw);

    if (!thresh || !Number.isFinite(thresh.value)) {
      return {
        ok: false,
        answer: "Please check /handlers/farmsFields.handler.js — could not parse the threshold number in your filter.",
        meta: { routed: "farmsFields", intent: "filtered_list_failed" }
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
        label: formatFieldOptionLine({ snapshot, fieldId }) || fieldId,
        value: v,
        farmName
      });
    }

    // Fields must be numeric order when listing raw matches
    if (!grouped) {
      matches.sort((a, b) => sortFieldsByNumberThenName(a.label, b.label));
    } else {
      // grouped mode: still keep fields inside each farm numeric, farms A-Z default
      // total-based ordering only if user asked largest/smallest
      // We'll build groups then sort accordingly.
    }

    const title = `Fields with ${metricLabel(metric)} ${op} ${minVal} (${includeArchived ? "incl archived" : "active only"}):`;

    if (!matches.length) {
      return { ok: true, answer: `${title}\n(none found)` };
    }

    let allLines = [];

    if (grouped) {
      const farmMap = new Map();
      for (const m of matches) {
        const k = (m.farmName || "(none)").toString();
        if (!farmMap.has(k)) farmMap.set(k, []);
        farmMap.get(k).push(m);
      }

      const farms = Array.from(farmMap.entries()).map(([name, items]) => {
        items.sort((a, b) => sortFieldsByNumberThenName(a.label, b.label));
        const total = items.reduce((s, x) => s + (Number(x.value) || 0), 0);
        return { name, items, total };
      });

      // farms sorting: A-Z default, optional largest/smallest by total
      if (sortMode === "largest") farms.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
      else if (sortMode === "smallest") farms.sort((a, b) => (a.total - b.total) || a.name.localeCompare(b.name));
      else farms.sort((a, b) => a.name.localeCompare(b.name));

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
  // COUNTIES WE FARM IN (default A→Z, optional largest/smallest by tillable)
  // =====================================================================
  if (wantsCountiesWeFarmIn(q)) {
    const rows = totalsByCounty({ cols, includeArchived }).map(r => ({
      name: r.key,
      value: r.tillable,
      raw: r
    }));

    sortRows({ rows, mode: sortMode, nameKey: "name", valueKey: "value" });

    const title = `Counties we farm in (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;

    const allLines = rows.map(x => {
      const r = x.raw;
      return `• ${r.key}: ${fmtAcre(r.tillable)} tillable ac • ${r.fields} fields`;
    });

    const pageSize = 15;
    const first = allLines.slice(0, pageSize);
    const remaining = allLines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more counties.`);
    out.push(`\n${sortHintLine(sortMode)}`);

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

  // =====================================================================
  // TOTALS OVERALL (fallback)
  // =====================================================================
  const askedTotals =
    wantsCount(q) || wantsAcres(q) || wantsHel(q) || wantsCrp(q) ||
    q.includes("totals") || q.includes("breakdown");

  if (askedTotals) {
    const t = buildTotals({ cols, includeArchived });

    const lines = [];
    lines.push(`Totals (${includeArchived ? "incl archived" : "active only"}):`);
    lines.push(`Fields: ${fmtInt(includeArchived ? t.fieldsTotal : t.fieldsActive)}`);
    lines.push(`Tillable acres: ${fmtAcre(t.tillableAcres)}`);
    lines.push(`HEL acres: ${fmtAcre(t.helAcres)} (${fmtInt(t.fieldsWithHEL)} fields)`);
    lines.push(`CRP acres: ${fmtAcre(t.crpAcres)} (${fmtInt(t.fieldsWithCRP)} fields)`);

    return { ok: true, answer: lines.join("\n"), meta: { routed: "farmsFields", intent: "totals_overall" } };
  }

  // =====================================================================
  // LIST FIELDS ON A FARM (fields numeric order)
  // =====================================================================
  if ((wantsList(q) || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = extractFarmNameGuess(raw);
    const farm = findFarmByName(cols, farmGuess);

    if (!farm) {
      return { ok: false, answer: "Please check /handlers/farmsFields.handler.js — could not extract farm name for list-fields query." };
    }

    const ids = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      if (!includeArchived && !isActiveStatus(f?.status)) continue;
      if ((f?.farmId || "") === farm.id) ids.push(fieldId);
    }

    const labels = ids.map(id => (formatFieldOptionLine({ snapshot, fieldId: id }) || id));
    labels.sort(sortFieldsByNumberThenName);

    const allLines = labels.map(l => `• ${l}`);
    const pageSize = 40;
    const first = allLines.slice(0, pageSize);
    const remaining = allLines.length - first.length;

    const out = [];
    out.push(`Fields on ${farm.name || farm.id} (${ids.length}):`);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: { routed: "farmsFields", intent: "list_fields_on_farm", continuation: (remaining > 0) ? { kind: "page", title: `Fields on ${farm.name || farm.id} (${ids.length}):`, lines: allLines, offset: pageSize, pageSize } : null }
    };
  }

  // =====================================================================
  // FIELD LOOKUP (default)
  // =====================================================================
  const res = tryResolveField({ snapshot, query: raw, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
    if (!b.ok) return { ok: false, answer: "Please check /data/fieldData.js — resolver returned fieldId but bundle load failed." };

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