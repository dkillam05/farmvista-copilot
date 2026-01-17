// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16k  domain:grain
//
// Contract:
// - OpenAI chooses tools.
// - Domain does the work.
// - Exports MUST match handleChat imports (no runtime import failures).
//
// Tools:
// - grain_bags_entry (broad catch-all; always answers)
// - grain_bags_count_now (optional cropType/cropYear)
// - grain_bags_where_now (optional cropType/cropYear)

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }
function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
function round0(v){ return Math.round(Number(v)||0); }

const CURRENT_YEAR = new Date().getFullYear();

/* ---------------- crop normalize ---------------- */

function normalizeCrop(c){
  const t = norm(c);
  if (!t) return "";
  if (t === "soy" || t === "beans" || t === "sb") return "soybeans";
  if (t === "sorghum") return "milo";
  if (t === "maize" || t === "kern") return "corn";
  return t;
}

/* ---------------- discovery helpers ---------------- */

function yearsWithBagsAll(){
  const r = runSql({
    sql: `
      SELECT cropYear,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      GROUP BY cropYear
      ORDER BY cropYear DESC
    `,
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows
    .map(x => ({ year: num(x.cropYear), bags: num(x.bags) }))
    .filter(x => Number.isFinite(x.year));
}

function yearsWithBagsForCrop(cropType){
  const c = normalizeCrop(cropType);
  if (!c) return [];
  const r = runSql({
    sql: `
      SELECT cropYear,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE lower(cropType)=lower(?)
      GROUP BY cropYear
      ORDER BY cropYear DESC
    `,
    params: [c],
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows
    .map(x => ({ year: num(x.cropYear), bags: num(x.bags) }))
    .filter(x => Number.isFinite(x.year));
}

function totalBagsAllForYear(year){
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

function totalBagsCropForYear(cropType, year){
  const c = normalizeCrop(cropType);
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

/* ---------------- year decision (never lie “none” when 2025 exists) ---------------- */

function decideYearAllOrAsk(){
  const yrs = yearsWithBagsAll();
  if (!yrs.length) return { kind:"none", text:"You have 0 grain bags." };

  const nonZero = yrs.filter(x => x.bags > 0);
  if (!nonZero.length) return { kind:"none", text:"You have 0 grain bags." };

  if (nonZero.length === 1) {
    const y = nonZero[0].year;
    const note = (y !== CURRENT_YEAR)
      ? `Note: ${CURRENT_YEAR} has 0 grain bags; using ${y}.`
      : "";
    return { kind:"use", year:y, note };
  }

  const lines = [];
  lines.push("Which crop year for grain bags? I see:");
  for (const x of nonZero.slice(0, 8)) lines.push(`- ${x.year}: ${round0(x.bags)} bags`);
  lines.push(`Reply with the year.`);
  return { kind:"ask", text: lines.join("\n") };
}

function decideYearCropOrAsk(cropType){
  const c = normalizeCrop(cropType);
  const yrs = yearsWithBagsForCrop(c);
  if (!yrs.length) return { kind:"none", text:`You have 0 ${c} grain bags.` };

  const nonZero = yrs.filter(x => x.bags > 0);
  if (!nonZero.length) return { kind:"none", text:`You have 0 ${c} grain bags.` };

  if (nonZero.length === 1) {
    const y = nonZero[0].year;
    const note = (y !== CURRENT_YEAR)
      ? `Note: ${CURRENT_YEAR} has 0 ${c} grain bags; using ${y}.`
      : "";
    return { kind:"use", year:y, note };
  }

  const lines = [];
  lines.push(`Which crop year for ${c} grain bags? I see:`);
  for (const x of nonZero.slice(0, 8)) lines.push(`- ${x.year}: ${round0(x.bags)} bags`);
  lines.push(`Reply with the year.`);
  return { kind:"ask", text: lines.join("\n") };
}

/* ---------------- where (by field) ---------------- */

function listWhereAll(year){
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
    limit: 1000
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  if (!rows.length) return `No grain bags found for ${year}.`;

  const lines = [];
  lines.push(`Where grain bags are ${year}:`);
  for (const x of rows) lines.push(`- ${safeStr(x.fieldName) || "(Unknown Field)"}: ${round0(x.bags)} bags`);
  return lines.join("\n");
}

function listWhereCrop(cropType, year){
  const c = normalizeCrop(cropType);
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
    limit: 1000
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  if (!rows.length) return `No ${c} grain bags found for ${year}.`;

  const lines = [];
  lines.push(`Where ${c} grain bags are ${year}:`);
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
      description: "ENTRY: answer any grain bag question (count). Returns a real answer or a year question.",
      parameters: { type: "object", properties: { cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type: "function",
      name: "grain_bags_count_now",
      description: "Count grain bags. cropType optional. cropYear optional.",
      parameters: { type: "object", properties: { cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type: "function",
      name: "grain_bags_where_now",
      description: "Where are grain bags (by field). cropType optional. cropYear optional.",
      parameters: { type: "object", properties: { cropType:{type:"string"}, cropYear:{type:"number"} } }
    }
  ];
}

/* =====================================================================
   TOOL HANDLER
===================================================================== */
export function grainHandleToolCall(name, args){
  const cropType = normalizeCrop(args?.cropType);
  const cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

  if (name === "grain_bags_entry") {
    return grainHandleToolCall("grain_bags_count_now", args || {});
  }

  if (name === "grain_bags_count_now") {
    if (!cropType) {
      if (cropYear != null) {
        const total = totalBagsAllForYear(cropYear);
        return { ok:true, text:`You have ${round0(total)} grain bags for ${cropYear}.` };
      }
      const d = decideYearAllOrAsk();
      if (d.kind === "use") {
        const total = totalBagsAllForYear(d.year);
        const msg = `You have ${round0(total)} grain bags for ${d.year}.`;
        return { ok:true, text: d.note ? `${d.note}\n\n${msg}` : msg };
      }
      return { ok:true, text: d.text };
    }

    if (cropYear != null) {
      const total = totalBagsCropForYear(cropType, cropYear);
      return { ok:true, text:`You have ${round0(total)} ${cropType} grain bags for ${cropYear}.` };
    }

    const d = decideYearCropOrAsk(cropType);
    if (d.kind === "use") {
      const total = totalBagsCropForYear(cropType, d.year);
      const msg = `You have ${round0(total)} ${cropType} grain bags for ${d.year}.`;
      return { ok:true, text: d.note ? `${d.note}\n\n${msg}` : msg };
    }
    return { ok:true, text: d.text };
  }

  if (name === "grain_bags_where_now") {
    if (!cropType) {
      if (cropYear != null) return { ok:true, text: listWhereAll(cropYear) };
      const d = decideYearAllOrAsk();
      if (d.kind === "use") return { ok:true, text: (d.note ? `${d.note}\n\n` : "") + listWhereAll(d.year) };
      return { ok:true, text: d.text };
    }

    if (cropYear != null) return { ok:true, text: listWhereCrop(cropType, cropYear) };

    const d = decideYearCropOrAsk(cropType);
    if (d.kind === "use") return { ok:true, text: (d.note ? `${d.note}\n\n` : "") + listWhereCrop(cropType, d.year) };
    return { ok:true, text: d.text };
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
export function userAsksBagBushels(text) {
  const t = (text || "").toString().toLowerCase();
  return /\b(bushels?|bu)\b/.test(t) && t.includes("bag");
}
export function userAsksGroupedByField(text) {
  const t = (text || "").toString().toLowerCase();
  return t.includes("by field") || t.includes("grouped by field") || t.includes("per field") || t.includes("each field");
}
export function assistantHasBushelNumber(text) {
  const s = safeStr(text);
  return /\b\d[\d,]*\.?\d*\s*(bu|bushels?)\b/i.test(s);
}
export function sqlLooksLikeBagRows(sqlLower) { return !!sqlLower && sqlLower.includes("v_grainbag_open_remaining"); }
export function sqlLooksLikeCapacityChain(sqlLower) { return !!sqlLower; } // kept for compatibility; not used here