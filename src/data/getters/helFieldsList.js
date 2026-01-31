// ======================================================================
// /src/data/getters/helFieldsList.js  (NEW FILE)
// Rev: 2026-01-30-v1-hel-fields-list-active-only
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default reads ONLY active fields (if fields.archived exists -> archived=0)
// - includeArchived=true returns archived separately
//
// IMPORTANT RULE (per Dane):
// - Field inclusion uses hasHEL toggle FIRST (not acres)
// - But Dane request: "if they have zero don't even show them"
//   => filter: hasHEL=1 AND helAcres > 0
//
// Output goal:
// - list of fields that have HEL acres > 0:
//   [{ fieldId, fieldName, helAcres, farmId, farmName, county, state }]
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

function tableGuard(sqlite, table){
  try{
    sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return true;
  }catch(_e){
    return false;
  }
}

function activeWhere(sqlite, alias, includeArchived){
  if(includeArchived) return "";
  if(hasColumn(sqlite, "fields", "archived")) return ` AND COALESCE(${alias}.archived,0)=0 `;
  return "";
}

// Best-effort "field name" expression across common schemas.
// If none exist, fall back to the field id.
function fieldNameExpr(sqlite){
  const candidates = ["fieldName","name","displayName","label","title","nickname"];
  const present = candidates.filter(c => hasColumn(sqlite, "fields", c));
  if(present.length === 0) return `COALESCE(NULLIF(f.id,''), '(Unknown field)')`;
  // COALESCE(NULLIF(f.fieldName,''), NULLIF(f.name,''), ...)
  const parts = present.map(c => `NULLIF(f.${c},'')`);
  parts.push(`NULLIF(f.id,'')`);
  return `COALESCE(${parts.join(", ")}, '(Unknown field)')`;
}

function runList(sqlite, includeArchived, archivedOnly){
  const extraActive = activeWhere(sqlite, "f", includeArchived);
  const hasArchived = hasColumn(sqlite, "fields", "archived");

  let archClause = "";
  if(archivedOnly){
    archClause = hasArchived ? ` AND COALESCE(f.archived,0)=1 ` : ` AND 1=0 `;
  }

  const nameExpr = fieldNameExpr(sqlite);

  const sql = `
    SELECT
      f.id AS fieldId,
      ${nameExpr} AS fieldName,
      f.farmId AS farmId,
      COALESCE(NULLIF(f.farmName,''), fm.name, '(Unknown farm)') AS farmName,
      COALESCE(NULLIF(f.county,''), '(Unknown county)') AS county,
      COALESCE(NULLIF(f.state,''), '') AS state,
      COALESCE(f.hasHEL,0) AS hasHEL,
      COALESCE(f.helAcres,0) AS helAcres
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE 1=1
      ${extraActive}
      ${archClause}
      AND COALESCE(f.hasHEL,0)=1
      AND COALESCE(f.helAcres,0) > 0
    ORDER BY helAcres DESC, fieldName ASC
  `;

  return sqlite.prepare(sql).all() || [];
}

/**
 * getHelFieldsList(opts)
 * opts:
 *  - includeArchived boolean (default false)
 */
export function getHelFieldsList(opts = {}){
  const sqlite = getDb();

  if(!tableGuard(sqlite, "fields")){
    return {
      ok: true,
      intent: "helFieldsList",
      filter: { includeArchived: false },
      fields: [],
      archived: { fields: [] },
      note: "Table 'fields' not found in snapshot"
    };
  }

  const includeArchived = truthy(opts.includeArchived);

  // ACTIVE list (always)
  const activeRows = runList(sqlite, false, false);

  const out = {
    ok: true,
    intent: "helFieldsList",
    filter: { includeArchived },
    counts: { fieldsWithHEL: activeRows.length },
    totals: {
      helAcres: Math.round(activeRows.reduce((s,r)=> s + Number(r.helAcres || 0), 0) * 10) / 10
    },
    fields: activeRows.map(r => ({
      fieldId: normStr(r.fieldId),
      fieldName: r.fieldName,
      helAcres: Math.round(Number(r.helAcres || 0) * 10) / 10,
      farmId: normStr(r.farmId),
      farmName: r.farmName,
      county: r.county,
      state: r.state
    }))
  };

  if(includeArchived){
    const hasArchived = hasColumn(sqlite, "fields", "archived");
    if(hasArchived){
      const archRows = runList(sqlite, true, true);
      out.archived = {
        counts: { fieldsWithHEL: archRows.length },
        totals: {
          helAcres: Math.round(archRows.reduce((s,r)=> s + Number(r.helAcres || 0), 0) * 10) / 10
        },
        fields: archRows.map(r => ({
          fieldId: normStr(r.fieldId),
          fieldName: r.fieldName,
          helAcres: Math.round(Number(r.helAcres || 0) * 10) / 10,
          farmId: normStr(r.farmId),
          farmName: r.farmName,
          county: r.county,
          state: r.state
        }))
      };
    } else {
      out.archived = {
        counts: { fieldsWithHEL: 0 },
        totals: { helAcres: 0 },
        fields: [],
        note: "fields.archived column not present; cannot split archived vs active"
      };
    }
  }

  return out;
}