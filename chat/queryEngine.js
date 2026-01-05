// /chat/queryEngine.js  (FULL FILE)
// Rev: 2026-01-04-queryEngine2-guards-countyfix
//
// Fixes:
// ✅ Correct routing for county questions vs farm questions
// ✅ Implements "Tillable acres by county" and "List fields in <County> County with acres"
// ✅ Adds hard guardrails so engine won't hijack equipment/grain/contracts/rtk/etc.
// ✅ Fixes missing wantsCounty() bug
//
// Still deterministic: no AI, no OpenAI calls.

'use strict';

import { getSnapshotCollections, formatFieldOptionLine } from "../data/fieldData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
function fmtAcre(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true;
  return v !== "archived" && v !== "inactive";
}

function wantsCount(q) {
  const s = norm(q);
  return s.includes("how many") || s.includes("count") || s.includes("number of");
}
function wantsList(q) {
  const s = norm(q);
  return s.includes("list") || s.includes("show");
}
function wantsByFarm(q) {
  const s = norm(q);
  return s.includes("by farm") || (s.includes("by") && s.includes("farm"));
}
function wantsByCounty(q) {
  const s = norm(q);
  return s.includes("by county") || (s.includes("by") && s.includes("county"));
}
function wantsAcres(q) {
  const s = norm(q);
  return s.includes("acres") || s.includes("tillable") || s.includes("acre");
}
function wantsHEL(q) { return norm(q).includes("hel"); }
function wantsCRP(q) { return norm(q).includes("crp"); }

function mentionsFarms(q) {
  const s = norm(q);
  return s.includes(" farm ") || s.endsWith(" farm") || s.includes(" farms") || s.includes("farms");
}
function mentionsCounties(q) {
  const s = norm(q);
  return s.includes("county") || s.includes("counties") || s.includes("countys");
}
function mentionsFields(q) {
  const s = norm(q);
  return s.includes("field") || s.includes("fields");
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

function countyKey(f) {
  const c = (f?.county || "").toString().trim();
  const st = (f?.state || "").toString().trim();
  if (!c) return "";
  return st ? `${c}, ${st}` : c;
}

function farmNameFromId(cols, farmId) {
  const farm = farmId ? (cols.farms?.[farmId] || null) : null;
  return (farm?.name || farmId || "").toString();
}

function buildPagedAnswer({ title, lines, pageSizeDefault = 25 }) {
  const pageSize = Math.max(10, Math.min(80, Number(pageSizeDefault) || 25));
  const first = lines.slice(0, pageSize);
  const remaining = lines.length - first.length;

  const out = [];
  out.push(title);
  out.push("");
  out.push(...first);
  if (remaining > 0) out.push(`\n…plus ${remaining} more.`);

  return {
    answer: out.join("\n"),
    continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null
  };
}

// ✅ Guardrails: don't hijack other domains
function hasBlockedDomainTerms(q) {
  const s = norm(q);
  const blocked = [
    "equipment", "tractor", "combine", "sprayer", "implement",
    "work order", "workorder", "maintenance", "service",
    "grain", "contract", "basis", "delivery", "elevator",
    "employee", "vendor", "invoice", "receipt",
    "rtk", "tower", "towers", "network id", "mhz"
  ];
  return blocked.some(t => s.includes(t));
}

export function tryGenericQuery({ question, snapshot, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) {
    return { ok: false, answer: "Please check /data/fieldData.js — snapshot collections not loaded.", meta: { debugFile: "/data/fieldData.js" } };
  }

  const raw = (question || "").toString();
  const q = norm(raw);

  // If it smells like other domains, bail.
  if (hasBlockedDomainTerms(q)) return null;

  // Only engage when question is about fields/farms/counties/acres/HEL/CRP
  const likely =
    mentionsFarms(q) || mentionsCounties(q) || mentionsFields(q) ||
    wantsAcres(q) || wantsHEL(q) || wantsCRP(q);

  if (!likely) return null;

  // -----------------------------
  // 1) HOW MANY COUNTIES?
  // (must come BEFORE farm count)
  // -----------------------------
  if (wantsCount(q) && mentionsCounties(q)) {
    const keys = new Set();
    for (const [, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;
      const k = countyKey(f);
      if (k) keys.add(k);
    }
    return {
      ok: true,
      answer: `Counties (from fields): ${fmtInt(keys.size)}.`,
      meta: { routed: "genericQuery", intent: "count_counties" }
    };
  }

  // -----------------------------
  // 2) HOW MANY FARMS?
  // -----------------------------
  if (wantsCount(q) && mentionsFarms(q)) {
    const farmIds = new Set();
    for (const [, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;
      const farmId = (f?.farmId || "").toString().trim();
      if (farmId) farmIds.add(farmId);
    }
    return {
      ok: true,
      answer: `Farms (from fields): ${fmtInt(farmIds.size)}.`,
      meta: { routed: "genericQuery", intent: "count_farms_from_fields" }
    };
  }

  // -----------------------------
  // 3) LIST FARMS
  // -----------------------------
  if ((wantsList(q) || q.includes("all")) && mentionsFarms(q) && !mentionsFields(q)) {
    const names = new Set();
    for (const [, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;
      const farmId = (f?.farmId || "").toString().trim();
      if (!farmId) continue;
      const nm = farmNameFromId(cols, farmId).trim();
      if (nm) names.add(nm);
    }

    const arr = Array.from(names.values()).sort((a, b) => a.localeCompare(b));
    const lines = arr.map(n => `• ${n}`);
    const title = `Farms (${includeArchived ? "incl archived fields" : "active fields only"}): ${fmtInt(arr.length)}`;

    const paged = buildPagedAnswer({ title, lines, pageSizeDefault: 30 });
    return {
      ok: true,
      answer: paged.answer,
      meta: { routed: "genericQuery", intent: "list_farms", continuation: paged.continuation }
    };
  }

  // -----------------------------
  // 4) LIST FIELDS IN A COUNTY (with optional acres)
  // -----------------------------
  if ((wantsList(q) || q.includes("which")) && mentionsFields(q) && mentionsCounties(q)) {
    const countyGuess = extractCountyGuess(raw);
    if (!countyGuess) return null;

    const needle = norm(countyGuess);
    const includeAcres = wantsAcres(q) || q.includes("with acres");

    const matches = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const c = norm(f?.county);
      if (!c) continue;
      if (c !== needle && !c.startsWith(needle) && !c.includes(needle)) continue;

      const label = formatFieldOptionLine({ snapshot, fieldId }) || fieldId;
      const till = num(f?.tillable);
      matches.push({ label, till });
    }

    matches.sort((a, b) => a.label.localeCompare(b.label));

    const title = `Fields in ${countyGuess} County (${includeArchived ? "incl archived" : "active only"}): ${fmtInt(matches.length)}`;
    const lines = matches.map(m => includeAcres ? `• ${m.label}\n  ${fmtAcre(m.till)} ac` : `• ${m.label}`);

    const paged = buildPagedAnswer({ title, lines, pageSizeDefault: 25 });
    return {
      ok: true,
      answer: paged.answer,
      meta: { routed: "genericQuery", intent: "list_fields_in_county", continuation: paged.continuation }
    };
  }

  // -----------------------------
  // 5) TILLABLE/HEL/CRP BY COUNTY
  // -----------------------------
  if (wantsByCounty(q) && (wantsAcres(q) || wantsHEL(q) || wantsCRP(q) || mentionsFields(q))) {
    const metric = wantsHEL(q) ? "hel" : wantsCRP(q) ? "crp" : wantsAcres(q) ? "tillable" : "fields";
    const map = new Map();

    for (const [, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const k = countyKey(f);
      if (!k) continue;

      if (!map.has(k)) map.set(k, { fields: 0, tillable: 0, hel: 0, crp: 0 });
      const rec = map.get(k);
      rec.fields += 1;
      rec.tillable += num(f?.tillable);
      rec.hel += num(f?.helAcres);
      rec.crp += num(f?.crpAcres);
    }

    const rows = Array.from(map.entries()).map(([k, v]) => ({ k, ...v }));
    rows.sort((a, b) => (b.tillable - a.tillable) || a.k.localeCompare(b.k));

    const title =
      metric === "fields" ? `Fields by county (${includeArchived ? "incl archived" : "active only"}):`
      : metric === "hel" ? `HEL acres by county (${includeArchived ? "incl archived" : "active only"}):`
      : metric === "crp" ? `CRP acres by county (${includeArchived ? "incl archived" : "active only"}):`
      : `Tillable acres by county (${includeArchived ? "incl archived" : "active only"}):`;

    const lines = rows.map(r => {
      if (metric === "fields") return `• ${r.k}: ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.k}: ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.k}: ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.k}: ${fmtAcre(r.tillable)} tillable ac`;
    });

    const paged = buildPagedAnswer({ title, lines, pageSizeDefault: 12 });
    return { ok: true, answer: paged.answer, meta: { routed: "genericQuery", intent: "by_county", continuation: paged.continuation } };
  }

  // -----------------------------
  // 6) TILLABLE/HEL/CRP BY FARM
  // -----------------------------
  if (wantsByFarm(q) && (wantsAcres(q) || wantsHEL(q) || wantsCRP(q) || mentionsFields(q))) {
    const metric = wantsHEL(q) ? "hel" : wantsCRP(q) ? "crp" : wantsAcres(q) ? "tillable" : "fields";
    const map = new Map();

    for (const [, f] of Object.entries(cols.fields || {})) {
      const active = isActiveStatus(f?.status);
      if (!includeArchived && !active) continue;

      const farmId = (f?.farmId || "").toString().trim();
      if (!farmId) continue;

      if (!map.has(farmId)) map.set(farmId, { farmId, name: farmNameFromId(cols, farmId), fields: 0, tillable: 0, hel: 0, crp: 0 });
      const rec = map.get(farmId);
      rec.fields += 1;
      rec.tillable += num(f?.tillable);
      rec.hel += num(f?.helAcres);
      rec.crp += num(f?.crpAcres);
    }

    const rows = Array.from(map.values());
    rows.sort((a, b) => (b.tillable - a.tillable) || a.name.localeCompare(b.name));

    const title =
      metric === "fields" ? `Fields by farm (${includeArchived ? "incl archived" : "active only"}):`
      : metric === "hel" ? `HEL acres by farm (${includeArchived ? "incl archived" : "active only"}):`
      : metric === "crp" ? `CRP acres by farm (${includeArchived ? "incl archived" : "active only"}):`
      : `Tillable acres by farm (${includeArchived ? "incl archived" : "active only"}):`;

    const lines = rows.map(r => {
      if (metric === "fields") return `• ${r.name}: ${fmtInt(r.fields)} fields`;
      if (metric === "hel") return `• ${r.name}: ${fmtAcre(r.hel)} HEL ac`;
      if (metric === "crp") return `• ${r.name}: ${fmtAcre(r.crp)} CRP ac`;
      return `• ${r.name}: ${fmtAcre(r.tillable)} tillable ac`;
    });

    const paged = buildPagedAnswer({ title, lines, pageSizeDefault: 12 });
    return { ok: true, answer: paged.answer, meta: { routed: "genericQuery", intent: "by_farm", continuation: paged.continuation } };
  }

  return null;
}