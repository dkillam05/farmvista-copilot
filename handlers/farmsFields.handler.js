// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-05-handler-filteredlists2-kit
//
// Now uses shared rules from /chat/handlerKit.js
// ✅ Default A→Z for farms/counties summaries, optional largest/smallest first
// ✅ Fields always numeric sort
// ✅ Paged output standardized by buildPaged()
// ✅ Natural-language "fields with hel" => auto threshold > 0 (one place)
//
// Keeps existing intent set:
// ✅ filtered field lists
// ✅ metric-by-county and metric-by-farm
// ✅ counties we farm in
// ✅ totals overall
// ✅ list fields on a farm
// ✅ field lookup

'use strict';

import {
  getSnapshotCollections,
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine
} from "../data/fieldData.js";

import {
  detectSortMode,
  sortRows,
  sortFieldsByNumberThenName,
  buildPaged,
  stripBullet,
  fmtInt,
  fmtAcre
} from "../chat/handlerKit.js";

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

// ------------------------
// Intent helpers
// ------------------------
function wantsCount(q) { return q.includes("how many") || q.includes("count") || q.includes("total") || q.includes("number of"); }
function wantsAcres(q) { return q.includes("acres") || q.includes("tillable") || q.includes("acre"); }
function wantsHel(q) { return q.includes("hel"); }
function wantsCrp(q) { return q.includes("crp"); }
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
  if (q.includes("fields") && !wantsAcres(q) && !wantsHel(q) && !wantsCrp(q)) return "fields";
  return "tillable";
}

function metricLabel(metric) {
  if (metric === "hel") return "HEL acres";
  if (metric === "crp") return "CRP acres";
  if (metric === "fields") return "Fields";
  return "Tillable acres";
}

function metricValueRow(row, metric) {
  if (metric === "fields") return Number(row.fields) || 0;
  if (metric === "hel") return Number(row.hel) || 0;
  if (metric === "crp") return Number(row.crp) || 0;
  return Number(row.tillable) || 0;
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
    return { ok: false, answer: "Please check /data/fieldData.js — snapshot collections not loaded.", meta: { routed: "farmsFields", reason: cols.reason } };
  }

  const raw = (question || "").toString();
  const q = norm(raw);
  const sortMode = detectSortMode(raw);

  // ✅ Natural-language "fields with HEL/CRP" fallback (auto threshold > 0)
  const _autofilterGuard = meta?.routerReason === "nl_fields_with_metric_autothreshold";

  const mentionsFields = (q.includes("field") || q.includes("fields"));
  const wantsTheseFields =
    wantsList(q) ||
    q.includes("just") ||
    q.includes("only") ||
    q.includes("with ") ||
    q.includes("has ") ||
    q.includes("have ") ||
    q.includes("that have") ||
    q.includes("where ");

  const wantsFieldsWithHel = mentionsFields && q.includes("hel") && wantsTheseFields;
  const wantsFieldsWithCrp = mentionsFields && q.includes("crp") && wantsTheseFields;

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

  // ✅ Metric summaries by county (A→Z default; largest/smallest optional)
  if (q.includes("by county") && (wantsAcres(q) || wantsHel(q) || wantsCrp(q) || q.includes("fields"))) {
    const metric = metricFromQuery(q);
    const rows = totalsByCounty({ cols, includeArchived }).map(r => ({
      name: r.key,
      value: metricValueRow({ fields: r.fields, tillable: r.tillable, hel: r.hel, crp: r.crp }, metric),
      raw: r
    }));

    sortRows(rows, sortMode);

    const title = `${metricLabel(metric)} by county (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;

    const lines = rows.map(x => {
      const r = x.raw;
      if (metric === "fields") return `• ${r.key}\n  ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.key}\n  ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.key}\n  ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.key}\n  ${fmtAcre(r.tillable)} tillable ac`;
    });

    const paged = buildPaged({ title, lines, pageSize: 12, showTip: true, tipMode: sortMode });
    return { ok: true, answer: paged.answer, meta: { routed: "farmsFields", intent: "metric_by_county", continuation: paged.continuation } };
  }

  // ✅ Metric summaries by farm (A→Z default; largest/smallest optional)
  if (q.includes("by farm") && (wantsAcres(q) || wantsHel(q) || wantsCrp(q) || q.includes("fields"))) {
    const metric = metricFromQuery(q);
    const rows = totalsByFarm({ cols, includeArchived }).map(r => ({
      name: r.name,
      value: metricValueRow(r, metric),
      raw: r
    }));

    sortRows(rows, sortMode);

    const title = `${metricLabel(metric)} by farm (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;

    const lines = rows.map(x => {
      const r = x.raw;
      if (metric === "fields") return `• ${r.name}\n  ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.name}\n  ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.name}\n  ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.name}\n  ${fmtAcre(r.tillable)} tillable ac`;
    });

    const paged = buildPaged({ title, lines, pageSize: 12, showTip: true, tipMode: sortMode });
    return { ok: true, answer: paged.answer, meta: { routed: "farmsFields", intent: "metric_by_farm", continuation: paged.continuation } };
  }

  // ✅ Filtered field lists (fields numeric sort; farms A→Z default, optional largest/smallest by group total)
  if (looksLikeFilteredList(q)) {
    const metric = wantsHel(q) ? "hel" : wantsCrp(q) ? "crp" : "tillable";
    const thresh = extractThreshold(raw);

    if (!thresh || !Number.isFinite(thresh.value)) {
      return { ok: false, answer: "Please check /handlers/farmsFields.handler.js — could not parse the threshold number in your filter.", meta: { routed: "farmsFields", intent: "filtered_list_failed" } };
    }

    const op = thresh.op || ">";
    const minVal = Number(thresh.value);
    const grouped = wantsGroupByFarm(q);

    const matches = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const v = (metric === "hel") ? num(f?.helAcres) : (metric === "crp") ? num(f?.crpAcres) : num(f?.tillable);
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

    const title = `Fields with ${metricLabel(metric)} ${op} ${minVal} (${includeArchived ? "incl archived" : "active only"}):`;
    if (!matches.length) return { ok: true, answer: `${title}\n\n(none found)` };

    let lines = [];

    if (!grouped) {
      matches.sort((a, b) => sortFieldsByNumberThenName(a.label, b.label));
      lines = matches.map(it => `• ${it.label} — ${fmtAcre(it.value)} ac`);
    } else {
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

      // farm order: A→Z default; allow largest/smallest by total
      if (sortMode === "largest") farms.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
      else if (sortMode === "smallest") farms.sort((a, b) => (a.total - b.total) || a.name.localeCompare(b.name));
      else farms.sort((a, b) => a.name.localeCompare(b.name));

      for (const f of farms) {
        lines.push(`Farm: ${f.name} (${f.items.length} fields)`);
        for (const it of f.items) lines.push(`• ${it.label} — ${fmtAcre(it.value)} ac`);
        lines.push("");
      }
      while (lines.length && !lines[lines.length - 1]) lines.pop();
    }

    const paged = buildPaged({ title, lines, pageSize: grouped ? 80 : 60, showTip: grouped, tipMode: sortMode });
    return { ok: true, answer: paged.answer, meta: { routed: "farmsFields", intent: "filtered_list", continuation: paged.continuation } };
  }

  // ✅ Counties we farm in (A→Z default; allow largest/smallest by tillable)
  if (wantsCountiesWeFarmIn(q)) {
    const rows = totalsByCounty({ cols, includeArchived }).map(r => ({
      name: r.key,
      value: r.tillable,
      raw: r
    }));

    sortRows(rows, sortMode);

    const title = `Counties we farm in (${includeArchived ? "incl archived" : "active only"}) — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}:`;
    const lines = rows.map(x => `• ${x.raw.key}: ${fmtAcre(x.raw.tillable)} tillable ac • ${fmtInt(x.raw.fields)} fields`);

    const paged = buildPaged({ title, lines, pageSize: 15, showTip: true, tipMode: sortMode });
    return { ok: true, answer: paged.answer, meta: { routed: "farmsFields", intent: "counties_list", continuation: paged.continuation } };
  }

  // Totals overall
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

  // List fields on a farm (numeric field order)
  if ((wantsList(q) || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = (raw.match(/\b(?:on|in)\s+([a-z0-9][a-z0-9\s\-\._]{1,60})$/i)?.[1] || "").trim();
    const farm = findFarmByName(cols, farmGuess);
    if (!farm) return { ok: false, answer: `Which farm? Example: "List fields on Illiopolis-MtAuburn"` };

    const labels = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      if (!includeArchived && !isActiveStatus(f?.status)) continue;
      if ((f?.farmId || "") !== farm.id) continue;
      labels.push(formatFieldOptionLine({ snapshot, fieldId }) || fieldId);
    }

    labels.sort(sortFieldsByNumberThenName);
    const lines = labels.map(l => `• ${l}`);

    const title = `Fields on ${farm.name || farm.id} (${fmtInt(labels.length)}):`;
    const paged = buildPaged({ title, lines, pageSize: 40 });

    return { ok: true, answer: paged.answer, meta: { routed: "farmsFields", intent: "list_fields_on_farm", continuation: paged.continuation } };
  }

  // Field lookup (default)
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