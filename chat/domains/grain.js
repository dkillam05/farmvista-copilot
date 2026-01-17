// /chat/domains/grain.js
// Rev: 2026-01-16-FINAL
//
// Grain domain = SINGLE SOURCE OF TRUTH
// - One entry tool
// - Handles crop + year logic internally
// - NEVER returns “I don’t know”
// - NEVER relies on handleChat logic

'use strict';

import { runSql } from "../sqlRunner.js";

function n(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
function round(v){ return Math.round(v || 0); }

const CURRENT_YEAR = new Date().getFullYear();

/* ---------------- helpers ---------------- */

function yearsWithBags(){
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
  return (r.rows || []).map(x => ({ year: n(x.cropYear), bags: n(x.bags) }))
                      .filter(x => x.year && x.bags >= 0);
}

function totalBagsForYear(year){
  const r = runSql({
    sql: `
      SELECT SUM(COALESCE(remainingFull,0)+COALESCE(remainingPartial,0)) AS bags
      FROM v_grainBag_open_remaining
      WHERE cropYear=?
    `,
    params: [year],
    limit: 1
  });
  return n(r.rows?.[0]?.bags);
}

/* ---------------- tool defs ---------------- */

export function grainToolDefs(){
  return [
    {
      type: "function",
      name: "grain_bags_entry",
      description: "Answer ANY grain bag question. Always returns a result.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  ];
}

/* ---------------- tool handler ---------------- */

export function grainHandleToolCall(name){
  if (name !== "grain_bags_entry") return null;

  const years = yearsWithBags();

  if (!years.length) {
    return { ok:true, text:"You have 0 grain bags." };
  }

  const nonZero = years.filter(x => x.bags > 0);

  if (!nonZero.length) {
    return { ok:true, text:"You have 0 grain bags." };
  }

  // exactly one year → auto use
  if (nonZero.length === 1) {
    const y = nonZero[0].year;
    const bags = totalBagsForYear(y);

    if (y !== CURRENT_YEAR) {
      return {
        ok:true,
        text:`You have ${round(bags)} grain bags (all in ${y}).`
      };
    }

    return {
      ok:true,
      text:`You have ${round(bags)} grain bags.`
    };
  }

  // multiple years → summary (still answers!)
  const lines = [];
  lines.push("Here are your grain bags by crop year:");
  for (const x of nonZero) {
    lines.push(`- ${x.year}: ${round(x.bags)} bags`);
  }

  return { ok:true, text: lines.join("\n") };
}

/* ---------------- unused helpers kept for compatibility ---------------- */

export function userReferencesThoseBags(){ return false; }
export function extractExplicitBagNumber(){ return null; }
export function userAsksBagBushels(){ return false; }
export function userAsksGroupedByField(){ return false; }
export function assistantHasBushelNumber(){ return false; }
export function sqlLooksLikeBagRows(){ return false; }
export function sqlLooksLikeCapacityChain(){ return false; }