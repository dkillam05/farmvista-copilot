// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16p  domain:grain
//
// Phone-safe hotfix (no SQL debugging needed):
// ✅ Reject invalid cropYear (0, null, junk) — treat as unspecified
// ✅ Pick BEST year with bags > 0 (never pick a 0-bag year)
// ✅ Always return a useful answer (no “tell me what you meant”)
// ✅ Provide by-crop breakdown so “How many are soybeans?” works
//
// Exports match handleChat imports.

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }
function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
function round0(v){ return Math.round(Number(v)||0); }

const CURRENT_YEAR = new Date().getFullYear();
const CROPS = ["corn","soybeans","wheat","milo","oats"];

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

/* ---------- core totals ---------- */

function yearTotalsAll(){
  // IMPORTANT: we only care about years with bags > 0
  const r = runSql({
    sql: `
      SELECT cropYear,
             SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      GROUP BY cropYear
      ORDER BY cropYear DESC
    `,
    limit: 200
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows
    .map(x => ({ year: Number(x.cropYear), bags: num(x.bags) }))
    .filter(x => Number.isFinite(x.year));
}

function bestYearWithBags(){
  const totals = yearTotalsAll();
  const nonZero = totals.filter(x => x.bags > 0);
  if (!nonZero.length) return null;
  return nonZero[0].year; // most recent with bags > 0
}

function totalBagsAll(year){
  const r = runSql({
    sql: `SELECT SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
          FROM v_grainBag_open_remaining
          WHERE cropYear=?`,
    params: [year],
    limit: 1
  });
  return num(r?.rows?.[0]?.bags);
}

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

/* ---------- where by field ---------- */

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

/* =====================================================================
   TOOL DEFS
   Keep names handleChat expects, plus a single entry tool that OpenAI can always pick.
===================================================================== */
export function grainToolDefs(){
  return [
    {
      type: "function",
      name: "grain_bags_entry",
      description: "ENTRY: grain bag summary (count + crop breakdown). Always returns an answer.",
      parameters: {
        type: "object",
        properties: {
          cropYear: { type: "number" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_count_now",
      description: "Count grain bags (all crops). Optional cropYear.",
      parameters: {
        type: "object",
        properties: {
          cropYear: { type: "number" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_where_now",
      description: "Where are grain bags (by field). Optional cropYear.",
      parameters: {
        type: "object",
        properties: {
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
  const cropYear = normalizeYear(args?.cropYear);

  // Decide year safely
  let year = cropYear;
  let note = "";

  if (year == null) {
    const best = bestYearWithBags();
    if (best == null) {
      const noneText = "You have 0 grain bags.";
      if (name === "grain_bags_where_now") return { ok:true, text:noneText };
      return { ok:true, text:noneText };
    }
    year = best;
    if (year !== CURRENT_YEAR) note = `Note: using ${year} (most recent crop year with grain bags).`;
  } else {
    // If user/LLM supplied a valid year but it’s 0-bag, fall back to best >0 year
    const tot = totalBagsAll(year);
    if (tot <= 0) {
      const best = bestYearWithBags();
      if (best != null && best !== year) {
        note = `Note: ${year} has 0 grain bags; using ${best}.`;
        year = best;
      }
    }
  }

  if (name === "grain_bags_entry") {
    const total = totalBagsAll(year);
    const byCrop = breakdownByCrop(year);

    const nonZeroCrops = [...byCrop.entries()].filter(([,n]) => n > 0);

    const lines = [];
    if (note) lines.push(note, "");
    lines.push(`You have ${round0(total)} grain bags (crop year ${year}).`);

    if (nonZeroCrops.length === 1) {
      lines.push(`All bags are ${nonZeroCrops[0][0]}.`);
    } else if (nonZeroCrops.length > 1) {
      lines.push("Breakdown by crop:");
      for (const c of CROPS) {
        const v = byCrop.get(c) || 0;
        if (v > 0) lines.push(`- ${c}: ${round0(v)} bags`);
      }
    }

    return { ok:true, text: lines.join("\n").trim() };
  }

  if (name === "grain_bags_count_now") {
    const total = totalBagsAll(year);
    const msg = `You have ${round0(total)} grain bags (crop year ${year}).`;
    return { ok:true, text: note ? `${note}\n\n${msg}` : msg };
  }

  if (name === "grain_bags_where_now") {
    const msg = whereByFieldAll(year);
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