// /chat/domains/binSites.js  (FULL FILE)
// Rev: 2026-01-17a  domain:binSites
//
// Tools:
// - bin_sites_count()
// - bin_sites_list(limit)
//
// Schema-safe: finds the correct table name from sqlite_master and counts/lists it.

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }

function listTables(){
  const r = runSql({
    sql: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    params: [],
    limit: 2000
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => safeStr(x.name));
}

function pickExistingTable(candidates){
  const set = new Set(listTables());
  for (const c of candidates){
    if (set.has(c)) return c;
  }
  return "";
}

function tryCount(sql){
  try {
    const r = runSql({ sql, params: [], limit: 1 });
    const n = Number(r?.rows?.[0]?.n || 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return null;
  }
}

function tryList(sql, params, limit){
  try {
    const r = runSql({ sql, params, limit });
    return Array.isArray(r?.rows) ? r.rows : [];
  } catch {
    return [];
  }
}

export function binSitesToolDefs(){
  return [
    {
      type:"function",
      name:"bin_sites_count",
      description:"Count grain bin sites in the system. Read-only.",
      parameters:{ type:"object", properties:{} }
    },
    {
      type:"function",
      name:"bin_sites_list",
      description:"List grain bin sites A–Z. Read-only.",
      parameters:{
        type:"object",
        properties:{
          limit:{ type:"number", description:"Max to list (default 200, max 500)." }
        }
      }
    }
  ];
}

export function binSitesHandleToolCall(name, args){
  if (name !== "bin_sites_count" && name !== "bin_sites_list") return null;

  // Try common real-world names; you can extend if needed.
  const siteTable = pickExistingTable([
    "binSites",
    "bin_sites",
    "grainBinSites",
    "grain_bin_sites",
    "binSite",
    "bin_sites_master"
  ]);

  if (!siteTable) {
    const tables = listTables().filter(t => norm(t).includes("bin") || norm(t).includes("site"));
    const lines = [];
    lines.push("I can’t find a bin sites table in this snapshot.");
    if (tables.length) {
      lines.push("Bin/site related tables I do see:");
      for (const t of tables.slice(0, 30)) lines.push(`- ${t}`);
    }
    return { ok:true, text: lines.join("\n") };
  }

  if (name === "bin_sites_count") {
    // If archived column exists, prefer active filter, else plain count.
    const n1 = tryCount(`SELECT COUNT(*) AS n FROM ${siteTable} WHERE archived IS NULL OR archived=0`);
    const n = (n1 != null) ? n1 : (tryCount(`SELECT COUNT(*) AS n FROM ${siteTable}`) || 0);
    return { ok:true, text:`There are ${Number(n)} grain bin sites in the system.` };
  }

  const lim = Math.max(1, Math.min(500, Number(args?.limit || 200)));

  // Prefer name if it exists
  let rows = tryList(`SELECT name FROM ${siteTable} ORDER BY name LIMIT ?`, [lim], lim);
  let key = "name";

  if (!rows.length) {
    // fallback to id
    rows = tryList(`SELECT id FROM ${siteTable} ORDER BY id LIMIT ?`, [lim], lim);
    key = "id";
  }

  if (!rows.length) return { ok:true, text:`No bin sites found in table ${siteTable}.` };

  const lines = [];
  lines.push(`Grain bin sites (${rows.length}${rows.length === lim ? "+" : ""}):`);
  for (const r of rows) lines.push(`- ${safeStr(r[key])}`);
  return { ok:true, text: lines.join("\n") };
}