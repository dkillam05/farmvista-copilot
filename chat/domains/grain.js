// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16i  domain:grain
//
// Goal: Grain domain ALWAYS answers grain-bag questions correctly.
// - cropType omitted: return totals across crops; ask only if multiple cropYears have non-zero bags.
// - cropType provided, cropYear omitted: auto-use only non-zero year; ask only if 2+ non-zero years.
// - NEVER say "none in any crop year" unless actually true.
//
// HARD RULES (kept):
// - PUTDOWN ONLY / VIEW ONLY: v_grainBag_open_remaining is truth.
// - PartialZeroGuard.
// - Capacity chain correct.

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }
function num(v){ const x = Number(v); return Number.isFinite(x)?x:0; }
function round0(v){ return Math.round(Number(v)||0); }

const CROP_FACTOR = { corn:1.00, soybeans:0.93, wheat:1.07, milo:1.02, oats:0.78 };
const KNOWN_CROPS = ["corn","soybeans","wheat","milo","oats"];
const CURRENT_CROP_YEAR = (new Date()).getFullYear();

function normalizeCrop(c){
  const t = norm(c);
  if (!t) return "";
  if (t === "soy" || t === "beans" || t === "sb") return "soybeans";
  if (t === "sorghum") return "milo";
  if (t === "maize" || t === "kern") return "corn";
  return t;
}

function cropFactorFor(c){
  const k = norm(c);
  return Object.prototype.hasOwnProperty.call(CROP_FACTOR,k) ? CROP_FACTOR[k] : null;
}

/* ---------------- basic discovery ---------------- */

function listYearsAll() {
  const r = runSql({
    sql: `SELECT DISTINCT cropYear FROM v_grainBag_open_remaining ORDER BY cropYear DESC`,
    params: [],
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => Number(x.cropYear)).filter(Number.isFinite);
}

function listYearsForCrop(cropType){
  const c = normalizeCrop(cropType);
  if (!c) return [];
  const r = runSql({
    sql: `
      SELECT DISTINCT v.cropYear AS cropYear
      FROM v_grainBag_open_remaining v
      WHERE lower(v.cropType)=lower(?)
      ORDER BY v.cropYear DESC
    `,
    params: [c],
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => Number(x.cropYear)).filter(Number.isFinite);
}

function bagCountForCropYear(cropType, cropYear){
  const c = normalizeCrop(cropType);
  if (!c || !Number.isFinite(cropYear)) return 0;
  const r = runSql({
    sql: `
      SELECT
        SUM(COALESCE(v.remainingFull,0)) AS fullBags,
        SUM(COALESCE(v.remainingPartial,0)) AS partialBags
      FROM v_grainBag_open_remaining v
      WHERE lower(v.cropType)=lower(?) AND v.cropYear=?
    `,
    params: [c, Number(cropYear)],
    limit: 1
  });
  const row = Array.isArray(r?.rows) && r.rows.length ? r.rows[0] : {};
  return num(row.fullBags)+num(row.partialBags);
}

function bagCountAllCropsForYear(cropYear){
  if (!Number.isFinite(cropYear)) return 0;
  const r = runSql({
    sql: `
      SELECT
        SUM(COALESCE(v.remainingFull,0)) AS fullBags,
        SUM(COALESCE(v.remainingPartial,0)) AS partialBags
      FROM v_grainBag_open_remaining v
      WHERE v.cropYear=?
    `,
    params: [Number(cropYear)],
    limit: 1
  });
  const row = Array.isArray(r?.rows) && r.rows.length ? r.rows[0] : {};
  return num(row.fullBags)+num(row.partialBags);
}

/* ---------------- year decision helpers ---------------- */

function decideYearForCropOrAsk(cropType){
  const c = normalizeCrop(cropType);
  const years = listYearsForCrop(c);
  if (!years.length) return { kind:"none", text:`No open ${c} grain bag rows found in any crop year.` };

  const summary = years.slice(0, 8).map(y => ({ y, bags: bagCountForCropYear(c,y) }));
  const nonZero = summary.filter(x => x.bags > 0);

  if (!nonZero.length) return { kind:"none", text:`You have 0 ${c} grain bags in all crop years.` };

  if (nonZero.length === 1) {
    const y = nonZero[0].y;
    const note = (y !== CURRENT_CROP_YEAR)
      ? `Note: you have 0 ${c} grain bags for ${CURRENT_CROP_YEAR}; using ${y} because that’s the only year with ${c} grain bags.`
      : "";
    return { kind:"use", year:y, note };
  }

  const lines = [];
  lines.push(`Which crop year for ${c}? I see:`);
  for (const x of nonZero) lines.push(`- ${x.y}: ${round0(x.bags).toLocaleString()} bags`);
  lines.push(`Reply with the year, or say "all".`);
  return { kind:"ask", text: lines.join("\n") };
}

function decideYearAllCropsOrAsk(){
  const years = listYearsAll();
  if (!years.length) return { kind:"none", text:`No open grain bag rows found in any crop year.` };

  const summary = years.slice(0, 8).map(y => ({ y, bags: bagCountAllCropsForYear(y) }));
  const nonZero = summary.filter(x => x.bags > 0);

  if (!nonZero.length) return { kind:"none", text:`You have 0 grain bags in all crop years.` };

  if (nonZero.length === 1) {
    const y = nonZero[0].y;
    const note = (y !== CURRENT_CROP_YEAR)
      ? `Note: you have 0 grain bags for ${CURRENT_CROP_YEAR}; using ${y} because that’s the only year with grain bags.`
      : "";
    return { kind:"use", year:y, note };
  }

  const lines = [];
  lines.push(`Which crop year for grain bags? I see:`);
  for (const x of nonZero) lines.push(`- ${x.y}: ${round0(x.bags).toLocaleString()} bags`);
  lines.push(`Reply with the year, or say "all".`);
  return { kind:"ask", text: lines.join("\n") };
}

/* ---------------- shared SQL for where/bushels ---------------- */

function whereSqlAndParams({ cropType, cropYear }){
  const wh = [];
  const params = [];

  const c = normalizeCrop(cropType);
  if (c) { wh.push("lower(v.cropType)=lower(?)"); params.push(c); }
  if (cropYear != null && Number.isFinite(cropYear)) { wh.push("v.cropYear=?"); params.push(Number(cropYear)); }

  return { whereSql: wh.length ? `WHERE ${wh.join(" AND ")}` : "", params };
}

function baseSql(whereSql){
  return `
    SELECT
      v.fieldName AS fieldName,
      v.cropType  AS cropType,
      v.cropYear  AS cropYear,
      pgb.bushelsCorn AS bushelsCorn,
      pgb.lengthFt    AS lengthFt,
      v.remainingFull            AS remainingFull,
      v.remainingPartial         AS remainingPartial,
      v.remainingPartialFeetSum  AS remainingPartialFeetSum,
      (v.remainingFull * pgb.bushelsCorn) AS fullCornBu,
      (
        CASE
          WHEN v.remainingPartial <= 0 THEN 0.0
          ELSE
            (MIN(v.remainingPartialFeetSum, (v.remainingPartial * pgb.lengthFt)) / pgb.lengthFt) * pgb.bushelsCorn
        END
      ) AS partialCornBu
    FROM v_grainBag_open_remaining v
    JOIN inventoryGrainBagMovements inv ON inv.id = v.bagSkuId
    JOIN productsGrainBags pgb ON pgb.id = inv.productId
    ${whereSql}
  `;
}

function cornBu(row){ return num(row.fullCornBu)+num(row.partialCornBu); }

/* =====================================================================
   Tool defs
===================================================================== */
export function grainToolDefs(){
  return [
    {
      type:"function",
      name:"grain_bags_count_now",
      description:"Count grain bags. cropType optional. cropYear optional. Asks ONLY if multiple real choices.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type:"function",
      name:"grain_bags_where_now",
      description:"Where are grain bags (by field). cropType optional. cropYear optional. Asks ONLY if multiple real choices.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    }
  ];
}

/* =====================================================================
   Tool handler
===================================================================== */
export function grainHandleToolCall(name, args){
  if (name === "grain_bags_count_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

    // If cropType omitted, treat as "all crops"
    if (!cropType) {
      if (cropYear == null) {
        const d = decideYearAllCropsOrAsk();
        if (d.kind === "use") cropYear = d.year;
        else return { ok:true, text: d.text };
        const total = bagCountAllCropsForYear(cropYear);
        const msg = `You have ${round0(total).toLocaleString()} grain bags for ${cropYear} (all crops).`;
        return { ok:true, text: d.note ? `${d.note}\n\n${msg}` : msg };
      }

      const total = bagCountAllCropsForYear(cropYear);
      return { ok:true, text:`You have ${round0(total).toLocaleString()} grain bags for ${cropYear} (all crops).` };
    }

    // cropType provided
    if (cropYear == null) {
      const d = decideYearForCropOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text: d.text };

      const total = bagCountForCropYear(cropType, cropYear);
      const msg = `You have ${round0(total).toLocaleString()} ${cropType} grain bags for ${cropYear}.`;
      return { ok:true, text: d.note ? `${d.note}\n\n${msg}` : msg };
    }

    const total = bagCountForCropYear(cropType, cropYear);
    return { ok:true, text:`You have ${round0(total).toLocaleString()} ${cropType} grain bags for ${cropYear}.` };
  }

  if (name === "grain_bags_where_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

    // If cropType omitted, treat as "all crops"
    if (!cropType) {
      if (cropYear == null) {
        const d = decideYearAllCropsOrAsk();
        if (d.kind === "use") cropYear = d.year;
        else return { ok:true, text: d.text };
      }

      const { whereSql, params } = whereSqlAndParams({ cropType:"", cropYear });
      const r = runSql({ sql: baseSql(whereSql), params, limit: 5000 });
      const rows = Array.isArray(r?.rows) ? r.rows : [];

      if (!rows.length) return { ok:true, text:`No open grain bags found for ${cropYear}.` };

      // group by field and crop
      const byField = new Map(); // field -> { bags, cornBu, byCrop:Map }
      for (const row of rows) {
        const field = safeStr(row.fieldName).trim() || "(Unknown Field)";
        const crop = normalizeCrop(row.cropType);
        const bags = num(row.remainingFull) + Math.max(0,num(row.remainingPartial));
        const cb = cornBu(row);

        const cur = byField.get(field) || { bags:0, byCrop:new Map() };
        cur.bags += bags;

        const cc = cur.byCrop.get(crop) || { bags:0, cornBu:0 };
        cc.bags += bags;
        cc.cornBu += cb;
        cur.byCrop.set(crop, cc);

        byField.set(field, cur);
      }

      const lines = [];
      lines.push(`Where grain bags are ${cropYear} (all crops):`);
      for (const field of [...byField.keys()].sort((a,b)=>a.localeCompare(b))) {
        const cur = byField.get(field);
        lines.push(`- ${field}: ${round0(cur.bags)} bags`);
        for (const crop of [...cur.byCrop.keys()].sort((a,b)=>a.localeCompare(b))) {
          const cc = cur.byCrop.get(crop);
          const factor = cropFactorFor(crop) || 1.0;
          const bu = cc.cornBu * factor;
          lines.push(`  • ${crop}: ${round0(cc.bags)} bags, ${round0(bu).toLocaleString()} bu`);
        }
      }
      return { ok:true, text: lines.join("\n").trim() };
    }

    // cropType provided
    if (cropYear == null) {
      const d = decideYearForCropOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text: d.text };
    }

    const factor = cropFactorFor(cropType) || 1.0;
    const { whereSql, params } = whereSqlAndParams({ cropType, cropYear });

    const r = runSql({ sql: baseSql(whereSql), params, limit: 5000 });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    if (!rows.length) return { ok:true, text:`No open ${cropType} grain bags found for ${cropYear}.` };

    const byField = new Map(); // field -> { bags, cornBu }
    for (const row of rows) {
      const field = safeStr(row.fieldName).trim() || "(Unknown Field)";
      const bags = num(row.remainingFull) + Math.max(0,num(row.remainingPartial));
      const cb = cornBu(row);
      const cur = byField.get(field) || { bags:0, cornBu:0 };
      cur.bags += bags;
      cur.cornBu += cb;
      byField.set(field, cur);
    }

    const lines = [];
    lines.push(`Where ${cropType} grain bags are ${cropYear} (by field):`);
    for (const field of [...byField.keys()].sort((a,b)=>a.localeCompare(b))) {
      const cur = byField.get(field);
      lines.push(`- ${field}: ${round0(cur.bags)} bags, ${round0(cur.cornBu*factor).toLocaleString()} bu`);
    }
    return { ok:true, text: lines.join("\n").trim() };
  }

  return null;
}

/* =====================================================================
   Helpers used by handleChat (kept)
===================================================================== */
export function userReferencesThoseBags(text) {
  const t = (text || "").toString().toLowerCase();
  return !!t && t.includes("those") && t.includes("bag");
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
  if (!t) return false;
  const hasBushelWord = /\bbushels?\b/.test(t);
  const hasBu = /\bbu\b/.test(t) || /\bbu\.\b/.test(t);
  if (!(hasBushelWord || hasBu)) return false;
  return t.includes("bag") && (t.includes("grain") || t.includes("field") || t.includes("bags") || t.includes("those"));
}

export function userAsksGroupedByField(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return (
    t.includes("by field") ||
    t.includes("grouped by field") ||
    t.includes("per field") ||
    t.includes("each field") ||
    (t.includes("fields") && (t.includes("bushel") || /\bbu\b/.test(t)))
  );
}

export function assistantHasBushelNumber(text) {
  const s = safeStr(text);
  if (!s) return false;
  return /\b\d[\d,]*\.?\d*\s*(bu|bushels?)\b/i.test(s);
}

export function sqlLooksLikeBagRows(sqlLower) {
  return !!sqlLower && sqlLower.includes("v_grainbag_open_remaining");
}

export function sqlLooksLikeCapacityChain(sqlLower) {
  if (!sqlLower) return false;
  return (
    sqlLower.includes("inventorygrainbagmovements") ||
    sqlLower.includes("productsgrainbags") ||
    sqlLower.includes("bushelscorn") ||
    sqlLower.includes("lengthft") ||
    sqlLower.includes("productid") ||
    sqlLower.includes("remainingpartial")
  );
}