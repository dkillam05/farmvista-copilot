// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16g  domain:grain
//
// FIX (critical):
// ✅ NEVER default cropYear silently for bag counts/locations.
// ✅ If cropYear omitted:
//    - If current year has 0 but another year has >0 -> say that and ask which year.
//    - If multiple years have >0 -> show a short by-year summary and ask.
//    - Only say "0" when ALL years are 0 OR no years exist.
//
// Adds tools (keeps existing bushels tool intact):
// - grain_bags_count_now
// - grain_bags_where_now
// - grain_bags_priority_pickup_now
// - grain_bags_years
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

const CROP_FACTOR = { corn:1.00, soybeans:0.93, wheat:1.07, milo:1.02, oats:0.78 };
const CURRENT_CROP_YEAR = (new Date()).getFullYear();

function normalizeCrop(c){
  const t = norm(c);
  if (!t) return "";
  if (t === "soy" || t === "beans" || t === "sb") return "soybeans";
  if (t === "sorghum") return "milo";
  return t;
}

function cropFactorFor(c){
  const k = norm(c);
  return Object.prototype.hasOwnProperty.call(CROP_FACTOR, k) ? CROP_FACTOR[k] : null;
}

function round0(n){ return Math.round(Number(n)||0); }

function pragmaCols(tableOrViewName){
  const name = safeStr(tableOrViewName).trim();
  if (!name) return [];
  try {
    const r = runSql({
      sql: `SELECT name, type FROM pragma_table_info('${name.replace(/'/g,"''")}') ORDER BY cid`,
      params: [],
      limit: 500
    });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    return rows.map(x => ({ name: safeStr(x.name), type: safeStr(x.type) }));
  } catch {
    return [];
  }
}

function findPriorityColumn(cols){
  const map = new Map((cols||[]).map(c => [norm(c.name), c.name]));
  const candidates = [
    "pickuppriority","pickup_priority","pickupPriority",
    "prioritypickup","priority_pickup","priorityPickup",
    "priority_for_pickup","priorityForPickup",
    "priority","ispriority","is_priority","isPriority",
    "highpriority","high_priority","highPriority"
  ];
  for (const k of candidates){
    const real = map.get(norm(k));
    if (real) return real;
  }
  const hits = (cols||[]).map(c => c.name).filter(nm => norm(nm).includes("priority"));
  return hits.length ? hits[0] : "";
}

function buildPrioritySpec(){
  const viewCols = pragmaCols("v_grainBag_open_remaining");
  const viewCol = findPriorityColumn(viewCols);
  if (viewCol) return { source:"view", col:viewCol };

  const invCols = pragmaCols("inventoryGrainBagMovements");
  const invCol = findPriorityColumn(invCols);
  if (invCol) return { source:"inv", col:invCol };

  return null;
}

function truthyExpr(alias, col){
  return `(${alias}.${col} = 1 OR lower(CAST(${alias}.${col} AS TEXT)) IN ('true','t','yes','y','1'))`;
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
  return rows.map(x => Number(x.cropYear)).filter(y => Number.isFinite(y));
}

function bagCountForYear(cropType, cropYear){
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
  return num(row.fullBags) + num(row.partialBags);
}

function summarizeYearsForCrop(cropType){
  const c = normalizeCrop(cropType);
  const years = listYearsForCrop(c);
  if (!years.length) return { years: [], nonZero: [], summary: [] };

  const summary = years.slice(0, 6).map(y => ({ cropYear: y, bags: bagCountForYear(c, y) }));
  const nonZero = summary.filter(x => x.bags > 0);

  return { years, nonZero, summary };
}

// Critical: never answer "0" when another year has bags.
function decideYearOrAsk(cropType){
  const c = normalizeCrop(cropType);
  const { years, nonZero, summary } = summarizeYearsForCrop(c);

  if (!years.length) {
    return { kind: "none", text: `No open ${c} grain bag rows found in any crop year.` };
  }

  if (!nonZero.length) {
    return { kind: "none", text: `You have 0 ${c} grain bags in all crop years.` };
  }

  const curEntry = summary.find(x => x.cropYear === CURRENT_CROP_YEAR);
  const curBags = curEntry ? curEntry.bags : 0;
  const best = nonZero[0];

  // If current year exists and is 0, but older year has bags, prompt.
  if (curEntry && curBags <= 0 && best.cropYear !== CURRENT_CROP_YEAR) {
    return {
      kind: "ask",
      text: `You have 0 ${c} grain bags for ${CURRENT_CROP_YEAR}, but ${best.cropYear} has ${round0(best.bags).toLocaleString()}. Which year do you want?`
    };
  }

  // If multiple non-zero years, prompt with list.
  if (nonZero.length > 1) {
    const lines = [];
    lines.push(`Which crop year for ${c}? I see:`);
    for (const x of nonZero) lines.push(`- ${x.cropYear}: ${round0(x.bags).toLocaleString()} bags`);
    return { kind: "ask", text: lines.join("\n") };
  }

  // Single non-zero year: use it (no prompt).
  return { kind: "use", year: best.cropYear };
}

function whereSqlAndParams({ cropType, cropYear, fieldName }){
  const wh = [];
  const params = [];

  const c = normalizeCrop(cropType);
  if (c) { wh.push("lower(v.cropType)=lower(?)"); params.push(c); }

  if (cropYear != null && Number.isFinite(cropYear)) { wh.push("v.cropYear=?"); params.push(Number(cropYear)); }

  const fn = safeStr(fieldName).trim();
  if (fn) { wh.push("lower(v.fieldName) LIKE lower(?)"); params.push(`%${fn}%`); }

  return { whereSql: wh.length ? `WHERE ${wh.join(" AND ")}` : "", params };
}

function baseSql({ whereSql, prioritySpec, requirePriority }){
  const prioritySelect = prioritySpec
    ? (prioritySpec.source === "view" ? `, v.${prioritySpec.col} AS priorityFlag` : `, inv.${prioritySpec.col} AS priorityFlag`)
    : "";

  const priorityWhere = (requirePriority && prioritySpec)
    ? (prioritySpec.source === "view"
        ? ` AND ${truthyExpr("v", prioritySpec.col)}`
        : ` AND ${truthyExpr("inv", prioritySpec.col)}`)
    : "";

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
      ${prioritySelect}
    FROM v_grainBag_open_remaining v
    JOIN inventoryGrainBagMovements inv ON inv.id = v.bagSkuId
    JOIN productsGrainBags pgb ON pgb.id = inv.productId
    ${whereSql}
    ${requirePriority ? priorityWhere : ""}
  `;
}

function computeCornBuRow(r){
  return (num(r.fullCornBu) + num(r.partialCornBu));
}

/* =====================================================================
   Tool defs
===================================================================== */
export function grainToolDefs(){
  return [
    {
      type:"function",
      name:"grain_bags_years",
      description:"List available cropYears for a cropType in grain bags (from v_grainBag_open_remaining).",
      parameters:{ type:"object", properties:{ cropType:{type:"string"} }, required:["cropType"] }
    },
    {
      type:"function",
      name:"grain_bags_count_now",
      description:"Count grain bags down now (full+partial). NEVER assumes cropYear; asks when needed.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type:"function",
      name:"grain_bags_where_now",
      description:"Where are the grain bags? Groups by fieldName; returns bags + bushels. NEVER assumes cropYear; asks when needed.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type:"function",
      name:"grain_bags_priority_pickup_now",
      description:"High priority bags to pick up (schema-aware priority flag), grouped by field with bags + bushels. NEVER assumes cropYear; asks when needed.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },

    // Keep existing bushels tool name/signature so handleChat + prompt stays compatible
    {
      type:"function",
      name:"grain_bags_bushels_now",
      description:"Compute bushels in grain bags now (PUTDOWN-only view). If cropYear omitted, asks (never assumes).",
      parameters:{
        type:"object",
        properties:{
          cropType:{type:"string"},
          cropYear:{type:"number"},
          fieldName:{type:"string"},
          groupedByField:{type:"boolean"}
        }
      }
    }
  ];
}

/* =====================================================================
   Tool handler
===================================================================== */
export function grainHandleToolCall(name, args){
  if (name === "grain_bags_years") {
    const c = normalizeCrop(args?.cropType);
    if (!c) return { ok:false, error:"missing_cropType" };
    const years = listYearsForCrop(c);
    if (!years.length) return { ok:true, text:`No open ${c} grain bag rows found in any crop year.` };
    return { ok:true, text:`${c} grain bags exist in crop years: ${years.join(", ")}.` };
  }

  if (name === "grain_bags_count_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;
    if (!cropType) return { ok:false, error:"missing_cropType" };

    if (cropYear == null) {
      const d = decideYearOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text:d.text };
    }

    const total = bagCountForYear(cropType, cropYear);
    return { ok:true, text:`You have ${round0(total).toLocaleString()} ${cropType} grain bags for ${cropYear}.` };
  }

  if (name === "grain_bags_where_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;
    if (!cropType) return { ok:false, error:"missing_cropType" };

    if (cropYear == null) {
      const d = decideYearOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text:d.text };
    }

    const factor = cropFactorFor(cropType) || 1.0;

    const { whereSql, params } = whereSqlAndParams({ cropType, cropYear, fieldName:"" });
    const sql = baseSql({ whereSql, prioritySpec:null, requirePriority:false });

    const r = runSql({ sql, params, limit: 5000 });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    if (!rows.length) return { ok:true, text:`No open ${cropType} grain bags found for ${cropYear}.` };

    const byField = new Map(); // field -> { full, partial, cornBu }
    for (const row of rows) {
      const f = safeStr(row.fieldName).trim() || "(Unknown Field)";
      const cur = byField.get(f) || { full:0, partial:0, cornBu:0 };
      cur.full += num(row.remainingFull);
      cur.partial += Math.max(0, num(row.remainingPartial));
      cur.cornBu += computeCornBuRow(row);
      byField.set(f, cur);
    }

    const lines = [];
    lines.push(`Where ${cropType} grain bags are ${cropYear} (by field):`);
    for (const f of [...byField.keys()].sort((a,b)=>a.localeCompare(b))) {
      const cur = byField.get(f);
      const bags = cur.full + cur.partial;
      const bu = cur.cornBu * factor;
      lines.push(`- ${f}: ${round0(bags).toLocaleString()} bags, ${round0(bu).toLocaleString()} bu`);
    }
    return { ok:true, text: lines.join("\n").trim() };
  }

  if (name === "grain_bags_priority_pickup_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;
    if (!cropType) return { ok:false, error:"missing_cropType" };

    if (cropYear == null) {
      const d = decideYearOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text:d.text };
    }

    const prioritySpec = buildPrioritySpec();
    if (!prioritySpec) {
      const vCols = pragmaCols("v_grainBag_open_remaining").map(c=>c.name).filter(nm=>norm(nm).includes("priority"));
      const iCols = pragmaCols("inventoryGrainBagMovements").map(c=>c.name).filter(nm=>norm(nm).includes("priority"));
      const lines = [];
      lines.push(`I can’t find a priority pickup flag column in this snapshot.`);
      if (vCols.length) lines.push(`v_grainBag_open_remaining priority-ish columns: ${vCols.join(", ")}`);
      if (iCols.length) lines.push(`inventoryGrainBagMovements priority-ish columns: ${iCols.join(", ")}`);
      lines.push(`Tell me the exact field name you use for pickup priority and I’ll wire it in.`);
      return { ok:true, text: lines.join("\n").trim() };
    }

    const factor = cropFactorFor(cropType) || 1.0;

    const { whereSql, params } = whereSqlAndParams({ cropType, cropYear, fieldName:"" });
    const sql = baseSql({ whereSql, prioritySpec, requirePriority:true });

    const r = runSql({ sql, params, limit: 5000 });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    if (!rows.length) return { ok:true, text:`No HIGH priority ${cropType} grain bags found for ${cropYear}.` };

    const byField = new Map();
    for (const row of rows) {
      const f = safeStr(row.fieldName).trim() || "(Unknown Field)";
      const cur = byField.get(f) || { full:0, partial:0, cornBu:0 };
      cur.full += num(row.remainingFull);
      cur.partial += Math.max(0, num(row.remainingPartial));
      cur.cornBu += computeCornBuRow(row);
      byField.set(f, cur);
    }

    const lines = [];
    lines.push(`HIGH priority ${cropType} grain bags to pick up ${cropYear} (by field):`);
    for (const f of [...byField.keys()].sort((a,b)=>a.localeCompare(b))) {
      const cur = byField.get(f);
      const bags = cur.full + cur.partial;
      const bu = cur.cornBu * factor;
      lines.push(`- ${f}: ${round0(bags).toLocaleString()} bags, ${round0(bu).toLocaleString()} bu`);
    }
    return { ok:true, text: lines.join("\n").trim() };
  }

  if (name === "grain_bags_bushels_now") {
    const cropType = normalizeCrop(args?.cropType);
    let cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;
    const fieldName = safeStr(args?.fieldName).trim();
    const groupedByField = !!args?.groupedByField;

    if (cropType && cropYear == null) {
      const d = decideYearOrAsk(cropType);
      if (d.kind === "use") cropYear = d.year;
      else return { ok:true, text:d.text };
    }

    // If cropType omitted, we do corn-rated and do not try to decide year.
    // (Caller can specify cropType for best behavior.)
    const cropFactor = cropType ? (cropFactorFor(cropType) || 1.0) : null;

    const { whereSql, params } = whereSqlAndParams({ cropType, cropYear, fieldName });
    const sql = baseSql({ whereSql, prioritySpec:null, requirePriority:false });

    const r = runSql({ sql, params, limit: 5000 });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    if (!rows.length) return { ok:true, rowCount:0, text:"0 bu (no qualifying grain bag rows)" };

    const perField = new Map();
    let totalCornBu = 0;
    for (const row of rows) {
      const cornBu = computeCornBuRow(row);
      totalCornBu += cornBu;
      const f = safeStr(row.fieldName).trim() || "(Unknown Field)";
      perField.set(f, (perField.get(f) || 0) + cornBu);
    }

    if (!cropFactor) {
      if (!groupedByField) return { ok:true, text:`${round0(totalCornBu).toLocaleString()} bu (corn-rated)` };

      const lines = [];
      lines.push(`Grain bags (corn-rated):`);
      for (const f of [...perField.keys()].sort((a,b)=>a.localeCompare(b))) {
        lines.push(`- ${f}: ${round0(perField.get(f)).toLocaleString()} bu (corn-rated)`);
      }
      lines.push("");
      lines.push(`Total: ${round0(totalCornBu).toLocaleString()} bu (corn-rated)`);
      return { ok:true, text: lines.join("\n").trim() };
    }

    const totalBu = totalCornBu * cropFactor;

    if (!groupedByField) return { ok:true, text:`${round0(totalBu).toLocaleString()} bu` };

    const lines = [];
    lines.push(`Grain bags (${cropType}${cropYear!=null?` ${cropYear}`:""}) — bushels now:`);
    for (const f of [...perField.keys()].sort((a,b)=>a.localeCompare(b))) {
      lines.push(`- ${f}: ${round0(perField.get(f) * cropFactor).toLocaleString()} bu`);
    }
    lines.push("");
    lines.push(`Total: ${round0(totalBu).toLocaleString()} bu`);
    return { ok:true, text: lines.join("\n").trim() };
  }

  return null;
}

/* =====================================================================
   Helpers used by handleChat for context carry (unchanged)
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