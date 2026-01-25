// ======================================================================
// /src/data/getters/helCrpTotals.js  (NEW FILE)
// Rev: 2026-01-23-v1-hel-crp-totals-toggle-first
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default reads ONLY active fields (if fields.archived exists -> archived=0)
// - includeArchived=true returns archived separately
//
// IMPORTANT RULE (per Dane):
// - Field counts use hasHEL / hasCRP toggle FIRST (not acres).
// - Acres are summed ONLY when the corresponding toggle is true.
//
// Source columns (from your live fields.js):
// - fields.hasHEL, fields.helAcres
// - fields.hasCRP, fields.crpAcres
// - fields.farmId, fields.farmName, farms.name
// - fields.county, fields.state
//
// Output goals:
// - totals: helAcres, crpAcres
// - counts: fieldsWithHEL, fieldsWithCRP
// - optional rollups by county + farm
// ======================================================================

import { db } from "../sqlite.js";

function getDb(){
  return (typeof db === "function") ? db() : db;
}

function normStr(v){ return (v == null) ? "" : String(v); }
function normLower(v){ return normStr(v).trim().toLowerCase(); }

function truthy(v){
  if(v === true) return true;
  if(v === false) return false;
  const s = normLower(v);
  return (s === "true" || s === "1" || s === "yes");
}

function hasColumn(sqlite, table, col){
  try{
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name) === String(col));
  }catch(_e){
    return false;
  }
}

function activeWhere(sqlite, alias, includeArchived){
  if(includeArchived) return "";
  if(hasColumn(sqlite, "fields", "archived")) return ` AND COALESCE(${alias}.archived,0)=0 `;
  return "";
}

function tableGuard(sqlite, table){
  try{
    sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return true;
  }catch(_e){
    return false;
  }
}

function runTotals(sqlite, includeArchived){
  const extra = activeWhere(sqlite, "f", includeArchived);

  const sql = `
    SELECT
      SUM(CASE WHEN COALESCE(f.hasHEL,0) = 1 THEN 1 ELSE 0 END) AS fieldsWithHEL,
      SUM(CASE WHEN COALESCE(f.hasCRP,0) = 1 THEN 1 ELSE 0 END) AS fieldsWithCRP,
      SUM(CASE WHEN COALESCE(f.hasHEL,0) = 1 THEN COALESCE(f.helAcres,0) ELSE 0 END) AS helAcres,
      SUM(CASE WHEN COALESCE(f.hasCRP,0) = 1 THEN COALESCE(f.crpAcres,0) ELSE 0 END) AS crpAcres
    FROM fields f
    WHERE 1=1
    ${extra}
  `;
  return sqlite.prepare(sql).get() || {
    fieldsWithHEL: 0,
    fieldsWithCRP: 0,
    helAcres: 0,
    crpAcres: 0
  };
}

function runRollups(sqlite, includeArchived){
  const extra = activeWhere(sqlite, "f", includeArchived);

  const sqlCounty = `
    SELECT
      COALESCE(NULLIF(f.county,''), '(Unknown county)') AS county,
      SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN 1 ELSE 0 END) AS fieldsWithHEL,
      SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN 1 ELSE 0 END) AS fieldsWithCRP,
      SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN COALESCE(f.helAcres,0) ELSE 0 END) AS helAcres,
      SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN COALESCE(f.crpAcres,0) ELSE 0 END) AS crpAcres
    FROM fields f
    WHERE 1=1
    ${extra}
    GROUP BY county
    ORDER BY (helAcres + crpAcres) DESC, county ASC
  `;

  const sqlFarm = `
    SELECT
      f.farmId AS farmId,
      COALESCE(NULLIF(f.farmName,''), fm.name, '(Unknown farm)') AS farmName,
      COALESCE(NULLIF(f.county,''), '(Unknown county)') AS county,
      SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN 1 ELSE 0 END) AS fieldsWithHEL,
      SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN 1 ELSE 0 END) AS fieldsWithCRP,
      SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN COALESCE(f.helAcres,0) ELSE 0 END) AS helAcres,
      SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN COALESCE(f.crpAcres,0) ELSE 0 END) AS crpAcres
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE 1=1
    ${extra}
    GROUP BY f.farmId, farmName, county
    ORDER BY (helAcres + crpAcres) DESC, farmName ASC
  `;

  const byCounty = sqlite.prepare(sqlCounty).all() || [];
  const byFarm = sqlite.prepare(sqlFarm).all() || [];

  return { byCounty, byFarm };
}

/**
 * getHelCrpTotals(opts)
 * opts:
 *  - includeArchived boolean (default false)
 *  - mode: "hel" | "crp" | "both" (optional; only affects returned "focus" field)
 */
export function getHelCrpTotals(opts = {}){
  const sqlite = getDb();

  if(!tableGuard(sqlite, "fields")){
    return {
      ok: true,
      intent: "helCrpTotals",
      filter: { includeArchived: false, mode: "both" },
      totals: { helAcres: 0, crpAcres: 0 },
      counts: { fieldsWithHEL: 0, fieldsWithCRP: 0 },
      byCounty: [],
      byFarm: [],
      note: "Table 'fields' not found in snapshot"
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const mode = (normLower(opts.mode) === "hel" || normLower(opts.mode) === "crp") ? normLower(opts.mode) : "both";

  const activeTotals = runTotals(sqlite, false);
  const activeRollups = runRollups(sqlite, false);

  const out = {
    ok: true,
    intent: "helCrpTotals",
    filter: { includeArchived, mode },
    counts: {
      fieldsWithHEL: Number(activeTotals.fieldsWithHEL || 0),
      fieldsWithCRP: Number(activeTotals.fieldsWithCRP || 0)
    },
    totals: {
      helAcres: Math.round((Number(activeTotals.helAcres || 0)) * 10) / 10,
      crpAcres: Math.round((Number(activeTotals.crpAcres || 0)) * 10) / 10
    },
    byCounty: activeRollups.byCounty.map(r => ({
      county: r.county,
      fieldsWithHEL: Number(r.fieldsWithHEL || 0),
      fieldsWithCRP: Number(r.fieldsWithCRP || 0),
      helAcres: Math.round((Number(r.helAcres || 0)) * 10) / 10,
      crpAcres: Math.round((Number(r.crpAcres || 0)) * 10) / 10
    })),
    byFarm: activeRollups.byFarm.map(r => ({
      county: r.county,
      farmId: normStr(r.farmId),
      farmName: r.farmName,
      fieldsWithHEL: Number(r.fieldsWithHEL || 0),
      fieldsWithCRP: Number(r.fieldsWithCRP || 0),
      helAcres: Math.round((Number(r.helAcres || 0)) * 10) / 10,
      crpAcres: Math.round((Number(r.crpAcres || 0)) * 10) / 10
    }))
  };

  if(includeArchived){
    const archTotals = runTotals(sqlite, true);
    // archived = includeArchived results MINUS active results
    // We calculate archived by directly querying archived-only when possible.
    // If fields.archived does not exist, we cannot split; return empty archived.
    if(hasColumn(sqlite, "fields", "archived")){
      const sqlArch = `
        SELECT
          SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN 1 ELSE 0 END) AS fieldsWithHEL,
          SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN 1 ELSE 0 END) AS fieldsWithCRP,
          SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN COALESCE(f.helAcres,0) ELSE 0 END) AS helAcres,
          SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN COALESCE(f.crpAcres,0) ELSE 0 END) AS crpAcres
        FROM fields f
        WHERE COALESCE(f.archived,0)=1
      `;
      const arch = sqlite.prepare(sqlArch).get() || {};
      out.archived = {
        counts: {
          fieldsWithHEL: Number(arch.fieldsWithHEL || 0),
          fieldsWithCRP: Number(arch.fieldsWithCRP || 0)
        },
        totals: {
          helAcres: Math.round((Number(arch.helAcres || 0)) * 10) / 10,
          crpAcres: Math.round((Number(arch.crpAcres || 0)) * 10) / 10
        }
      };
    } else {
      out.archived = {
        counts: { fieldsWithHEL: 0, fieldsWithCRP: 0 },
        totals: { helAcres: 0, crpAcres: 0 },
        note: "fields.archived column not present; cannot split archived vs active"
      };
    }
  }

  return out;
}