// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16m  domain:grain
//
// Fixes:
// ✅ Reject invalid cropYear (e.g., 0) -> treated as "unspecified"
// ✅ One ENTRY tool that can answer totals + by-crop breakdown for a chosen year
// ✅ Count tool supports cropType optional
// ✅ Where tool supports cropType optional
//
// Contract:
// - OpenAI calls tools.
// - Domain returns deterministic answers.
// - Exports MUST match handleChat imports.

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }
function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
function round0(v){ return Math.round(Number(v)||0); }

const CURRENT_YEAR = new Date().getFullYear();
const KNOWN_CROPS = ["corn","soybeans","wheat","milo","oats"];

function normalizeCrop(c){
  const t = norm(c);
  if (!t) return "";
  if (t === "soy" || t === "beans" || t === "sb") return "soybeans";
  if (t === "sorghum") return "milo";
  if (t === "maize" || t === "kern") return "corn";
  return t;
}

function normalizeYear(y){
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  const yi = Math.floor(n);
  if (yi < 2000 || yi > 2100) return null;
  return yi;
}

/* ---------------- discovery ---------------- */

function listYearsAll(){
  const r = runSql({
    sql: `SELECT DISTINCT cropYear FROM v_grainBag_open_remaining ORDER BY cropYear DESC`,
    params: [],
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => Number(x.cropYear)).filter(Number.isFinite);
}

function bagCountAllForYear(year){
  const r = runSql({
    sql: `
      SELECT SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE cropYear=?
    `,
    params: [year],
    limit: 1
  });
  return num(r?.rows?.[0]?.bags);
}

function bagCountForCropYear(crop, year){
  const c = normalizeCrop(crop);
  const r = runSql({
    sql: `
      SELECT SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE lower(cropType)=lower(?) AND cropYear=?
    `,
    params: [c, year],
    limit: 1
  });
  return num(r?.rows?.[0]?.bags);
}

function decideYearAllOrAsk(){
  const years = listYearsAll();
  if (!years.length) return { kind:"none", text:"You have 0 grain bags." };

  const nonZero = years
    .map(y => ({ y, n: bagCountAllForYear(y) }))
    .filter(x => x.n > 0);

  if (!nonZero.length) return { kind:"none", text:"You have 0 grain bags." };

  if (nonZero.length === 1) {
    const y = nonZero[0].y;
    const note = (y !== CURRENT_YEAR) ? `Note: ${CURRENT_YEAR} has 0 grain bags; using ${y}.` : "";
    return { kind:"use", year:y, note };
  }

  const lines = [];
  lines.push("Which crop year for grain bags?");
  for (const x of nonZero.slice(0, 8)) lines.push(`- ${x.y}: ${round0(x.n)} bags`);
  lines.push("Reply with the year.");
  return { kind:"ask", text: lines.join("\n") };
}

/* ---------------- by-crop breakdown (solves: “How many are soybeans?”) ---------------- */

function breakdownByCrop(year){
  const r = runSql({
    sql: `
      SELECT lower(cropType) AS cropType,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE cropYear=?
      GROUP BY lower(cropType)
      ORDER BY lower(cropType)
    `,
    params: [year],
    limit: 200
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  const map = new Map();
  for (const row of rows) {
    const c = normalizeCrop(row.cropType);
    if (!c) continue;
    map.set(c, num(row.bags));
  }
  return map;
}

/* ---------------- where (by field) ---------------- */

function whereByFieldAll(year){
  const r = runSql({
    sql: `
      SELECT fieldName,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE cropYear=?
      GROUP BY fieldName
      ORDER BY fieldName
    `,
    params: [year],
    limit: 2000
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  if (!rows.length) return `No grain bags found for ${year}.`;
  const lines = [`Where grain bags are ${year}:`];
  for (const x of rows) lines.push(`- ${safeStr(x.fieldName) || "(Unknown Field)"}: ${round0(x.bags)} bags`);
  return lines.join("\n");
}

function whereByFieldCrop(crop, year){
  const c = normalizeCrop(crop);
  const r = runSql({
    sql: `
      SELECT fieldName,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE lower(cropType)=lower(?) AND cropYear=?
      GROUP BY fieldName
      ORDER BY fieldName
    `,
    params: [c, year],
    limit: 2000
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  if (!rows.length) return `No ${c} grain bags found for ${year}.`;
  const lines = [`Where ${c} grain bags are ${year}:`];
  for (const x of rows) lines.push(`- ${safeStr(x.fieldName) || "(Unknown Field)"}: ${round0(x.bags)} bags`);
  return lines.join("\n");
}

/* =====================================================================
   TOOL DEFS (ENTRY FIRST)
===================================================================== */
export function grainToolDefs(){
  return [
    {
      type: "function",
      name: "grain_bags_entry",
      description: "ENTRY: answer grain bag questions. Returns totals and by-crop breakdown for the chosen year.",
      parameters: {
        type: "object",
        properties: {
          cropYear: { type: "number", description: "Optional crop year (YYYY)" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_count_now",
      description: "Count grain bags. cropType optional. cropYear optional.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string" },
          cropYear: { type: "number" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_where_now",
      description: "Where are grain bags (by field). cropType optional. cropYear optional.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string" },
          cropYear: { type: "number" }
        }
      }
    }
  ];
}

/* =====================================================================
   TOOL HANDLER
===================================================================== */
export function grainHandleToolCall(name, args){
  const cropType = normalizeCrop(args?.cropType);
  const cropYear = normalizeYear(args?.cropYear);

  if (name === "grain_bags_entry") {
    // Choose year deterministically; ask only if truly multiple choices.
    let y = cropYear;
    let note = "";
    if (y == null) {
      const d = decideYearAllOrAsk();
      if (d.kind === "use") { y = d.year; note = d.note || ""; }
      else return { ok:true, text:d.text };
    }

    const total = bagCountAllForYear(y);
    const byCrop = breakdownByCrop(y);

    // If only one crop exists, say it; else list breakdown.
    const nonZeroCrops = [...byCrop.entries()].filter(([,n]) => n > 0);
    const lines = [];
    if (note) lines.push(note, "");
    lines.push(`You have ${round0(total)} grain bags (crop year ${y}).`);

    if (nonZeroCrops.length === 1) {
      lines.push(`All bags are ${nonZeroCrops[0][0]}.`);
    } else if (nonZeroCrops.length > 1) {
      lines.push(`Breakdown by crop:`);
      for (const c of KNOWN_CROPS) {
        const nB = byCrop.get(c) || 0;
        if (nB > 0) lines.push(`- ${c}: ${round0(nB)} bags`);
      }
    }
    return { ok:true, text: lines.join("\n").trim() };
  }

  if (name === "grain_bags_count_now") {
    let y = cropYear;
    let note = "";

    if (y == null) {
      const d = decideYearAllOrAsk();
      if (d.kind === "use") { y = d.year; note = d.note || ""; }
      else return { ok:true, text:d.text };
    }

    if (!cropType) {
      const total = bagCountAllForYear(y);
      const msg = `You have ${round0(total)} grain bags for ${y}.`;
      return { ok:true, text: note ? `${note}\n\n${msg}` : msg };
    }

    const total = bagCountForCropYear(cropType, y);
    const msg = `You have ${round0(total)} ${cropType} grain bags for ${y}.`;
    return { ok:true, text: note ? `${note}\n\n${msg}` : msg };
  }

  if (name === "grain_bags_where_now") {
    let y = cropYear;
    let note = "";

    if (y == null) {
      const d = decideYearAllOrAsk();
      if (d.kind === "use") { y = d.year; note = d.note || ""; }
      else return { ok:true, text:d.text };
    }

    const msg = cropType ? whereByFieldCrop(cropType, y) : whereByFieldAll(y);
    return { ok:true, text: note ? `${note}\n\n${msg}` : msg };
  }

  return null;
}

/* =====================================================================
   REQUIRED EXPORTS (handleChat imports these; keep them)
===================================================================== */
export function userReferencesThoseBags(text) {
  const t = (text || "").toString().toLowerCase();
  return t.includes("those") && t.includes("bag");
}
export function extractExplicitBagNumber(text) {
  const t = (text || "").toString().toLowerCase();
  const m = t.match(/\bthose\s+(\d{1,6})\s+bags?\b/);
  if (!m) return null;
  const x = parseInt(m[1], 10);
  return Number.isFinite(x) ? x : null;
}
export function userAsksBagBushels(text) { return /\b(bushels?|bu)\b/i.test(String(text||"")); }
export function userAsksGroupedByField(text) { return /\bby field\b/i.test(String(text||"")); }
export function assistantHasBushelNumber(text) { return /\b\d[\d,]*\s*(bu|bushels?)\b/i.test(String(text||"")); }
export function sqlLooksLikeBagRows(sqlLower) { return !!sqlLower && String(sqlLower).includes("v_grainbag_open_remaining"); }
export function sqlLooksLikeCapacityChain(sqlLower) { return !!sqlLower; }