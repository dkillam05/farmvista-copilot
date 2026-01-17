// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16j  domain:grain
//
// FIX (critical):
// ✅ SINGLE ENTRY TOOL so grain is NEVER skipped by the LLM.
// ✅ cropType optional, cropYear optional.
// ✅ Auto-use only valid year; ask ONLY when 2+ real choices.
// ✅ NEVER say "none in any crop year" unless truly true.
//
// HARD RULES (kept):
// - PUTDOWN ONLY / VIEW ONLY: v_grainBag_open_remaining
// - PartialZeroGuard
// - Capacity chain correct

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }
function num(v){ const x = Number(v); return Number.isFinite(x)?x:0; }
function round0(v){ return Math.round(Number(v)||0); }

const CROP_FACTOR = { corn:1.00, soybeans:0.93, wheat:1.07, milo:1.02, oats:0.78 };
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

/* ---------------- discovery ---------------- */

function listYearsAll(){
  const r = runSql({
    sql:`SELECT DISTINCT cropYear FROM v_grainBag_open_remaining ORDER BY cropYear DESC`,
    params:[], limit:50
  });
  const rows = Array.isArray(r?.rows)?r.rows:[];
  return rows.map(x=>Number(x.cropYear)).filter(Number.isFinite);
}

function listYearsForCrop(crop){
  const c = normalizeCrop(crop);
  if (!c) return [];
  const r = runSql({
    sql:`SELECT DISTINCT cropYear FROM v_grainBag_open_remaining WHERE lower(cropType)=lower(?) ORDER BY cropYear DESC`,
    params:[c], limit:50
  });
  const rows = Array.isArray(r?.rows)?r.rows:[];
  return rows.map(x=>Number(x.cropYear)).filter(Number.isFinite);
}

function bagCountAllCropsForYear(y){
  const r = runSql({
    sql:`SELECT SUM(COALESCE(remainingFull,0))+SUM(COALESCE(remainingPartial,0)) AS n FROM v_grainBag_open_remaining WHERE cropYear=?`,
    params:[y], limit:1
  });
  return num(r?.rows?.[0]?.n);
}

function bagCountForCropYear(crop,y){
  const c = normalizeCrop(crop);
  const r = runSql({
    sql:`SELECT SUM(COALESCE(remainingFull,0))+SUM(COALESCE(remainingPartial,0)) AS n FROM v_grainBag_open_remaining WHERE lower(cropType)=lower(?) AND cropYear=?`,
    params:[c,y], limit:1
  });
  return num(r?.rows?.[0]?.n);
}

/* ---------------- year decision ---------------- */

function decideYearAll(){
  const years = listYearsAll();
  if (!years.length) return { kind:"none", text:"You have no grain bags in any crop year." };

  const nz = years.map(y=>({y,n:bagCountAllCropsForYear(y)})).filter(x=>x.n>0);
  if (!nz.length) return { kind:"none", text:"You have 0 grain bags in all crop years." };

  if (nz.length===1){
    const y=nz[0].y;
    const note = y!==CURRENT_CROP_YEAR ? `Note: ${CURRENT_CROP_YEAR} has 0 grain bags; using ${y}.` : "";
    return { kind:"use", year:y, note };
  }

  const lines=["Which crop year for grain bags?"];
  nz.forEach(x=>lines.push(`- ${x.y}: ${round0(x.n)} bags`));
  return { kind:"ask", text:lines.join("\n") };
}

function decideYearForCrop(crop){
  const c = normalizeCrop(crop);
  const years = listYearsForCrop(c);
  if (!years.length) return { kind:"none", text:`You have no ${c} grain bags.` };

  const nz = years.map(y=>({y,n:bagCountForCropYear(c,y)})).filter(x=>x.n>0);
  if (!nz.length) return { kind:"none", text:`You have 0 ${c} grain bags in all crop years.` };

  if (nz.length===1){
    const y=nz[0].y;
    const note = y!==CURRENT_CROP_YEAR ? `Note: ${CURRENT_CROP_YEAR} has 0 ${c} bags; using ${y}.` : "";
    return { kind:"use", year:y, note };
  }

  const lines=[`Which crop year for ${c}?`];
  nz.forEach(x=>lines.push(`- ${x.y}: ${round0(x.n)} bags`));
  return { kind:"ask", text:lines.join("\n") };
}

/* ---------------- SQL core ---------------- */

function baseSql(where){
  return `
    SELECT v.fieldName,v.cropType,v.cropYear,
           v.remainingFull,v.remainingPartial,
           pgb.bushelsCorn,pgb.lengthFt,
           (v.remainingFull*pgb.bushelsCorn) AS fullCornBu,
           CASE WHEN v.remainingPartial<=0 THEN 0
                ELSE (MIN(v.remainingPartialFeetSum,v.remainingPartial*pgb.lengthFt)/pgb.lengthFt)*pgb.bushelsCorn END AS partialCornBu
    FROM v_grainBag_open_remaining v
    JOIN inventoryGrainBagMovements inv ON inv.id=v.bagSkuId
    JOIN productsGrainBags pgb ON pgb.id=inv.productId
    ${where}
  `;
}

function cornBu(r){ return num(r.fullCornBu)+num(r.partialCornBu); }

/* =====================================================================
   TOOL DEFS  (ENTRY TOOL FIRST)
===================================================================== */
export function grainToolDefs(){
  return [
    {
      type:"function",
      name:"grain_bags_entry",
      description:"ENTRY POINT for ANY grain bag question (count, where, crop, year).",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type:"function",
      name:"grain_bags_count_now",
      description:"Count grain bags. cropType optional. cropYear optional.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    },
    {
      type:"function",
      name:"grain_bags_where_now",
      description:"Where are grain bags (by field). cropType optional. cropYear optional.",
      parameters:{ type:"object", properties:{ cropType:{type:"string"}, cropYear:{type:"number"} } }
    }
  ];
}

/* =====================================================================
   TOOL HANDLER
===================================================================== */
export function grainHandleToolCall(name,args){

  // 🔒 ENTRY TOOL — NEVER SKIPPED
  if (name==="grain_bags_entry"){
    return grainHandleToolCall("grain_bags_count_now", args||{});
  }

  if (name==="grain_bags_count_now"){
    const crop=normalizeCrop(args?.cropType);
    let year=Number.isFinite(args?.cropYear)?Number(args.cropYear):null;

    if (!crop){
      if (!year){
        const d=decideYearAll();
        if (d.kind==="use") year=d.year;
        else return {ok:true,text:d.text};
      }
      return {ok:true,text:`You have ${round0(bagCountAllCropsForYear(year))} grain bags for ${year}.`};
    }

    if (!year){
      const d=decideYearForCrop(crop);
      if (d.kind==="use") year=d.year;
      else return {ok:true,text:d.text};
      return {ok:true,text:`${d.note?d.note+"\n\n":""}You have ${round0(bagCountForCropYear(crop,year))} ${crop} grain bags for ${year}.`};
    }

    return {ok:true,text:`You have ${round0(bagCountForCropYear(crop,year))} ${crop} grain bags for ${year}.`};
  }

  if (name==="grain_bags_where_now"){
    const crop=normalizeCrop(args?.cropType);
    let year=Number.isFinite(args?.cropYear)?Number(args.cropYear):null;

    if (!crop){
      if (!year){
        const d=decideYearAll();
        if (d.kind==="use") year=d.year;
        else return {ok:true,text:d.text};
      }
      const r=runSql({sql:baseSql(`WHERE cropYear=${year}`),params:[],limit:5000});
      const rows=Array.isArray(r?.rows)?r.rows:[];
      if (!rows.length) return {ok:true,text:`No grain bags found for ${year}.`};

      const byField=new Map();
      rows.forEach(x=>{
        const f=x.fieldName||"(Unknown Field)";
        const cur=byField.get(f)||0;
        byField.set(f,cur+num(x.remainingFull)+num(x.remainingPartial));
      });

      const lines=[`Where grain bags are ${year}:`];
      [...byField.entries()].sort().forEach(([f,n])=>lines.push(`- ${f}: ${round0(n)} bags`));
      return {ok:true,text:lines.join("\n")};
    }

    if (!year){
      const d=decideYearForCrop(crop);
      if (d.kind==="use") year=d.year;
      else return {ok:true,text:d.text};
    }

    const r=runSql({sql:baseSql(`WHERE lower(cropType)=lower('${crop}') AND cropYear=${year}`),params:[],limit:5000});
    const rows=Array.isArray(r?.rows)?r.rows:[];
    if (!rows.length) return {ok:true,text:`No ${crop} grain bags found for ${year}.`};

    const byField=new Map();
    rows.forEach(x=>{
      const f=x.fieldName||"(Unknown Field)";
      const cur=byField.get(f)||0;
      byField.set(f,cur+num(x.remainingFull)+num(x.remainingPartial));
    });

    const lines=[`Where ${crop} grain bags are ${year}:`];
    [...byField.entries()].sort().forEach(([f,n])=>lines.push(`- ${f}: ${round0(n)} bags`));
    return {ok:true,text:lines.join("\n")};
  }

  return null;
}