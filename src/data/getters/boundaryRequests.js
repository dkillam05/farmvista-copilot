// ======================================================================
// /src/data/getters/boundaryRequests.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-ESM
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns ONLY status=Open
// - If includeArchived=true, returns archived (Completed/other) separately
//
// Output goals:
// - list + count
// - grouped summary by farm -> field -> requests
// ======================================================================

import { db } from '../sqlite.js';

function getDb(){
  // supports either `export const db = ...` or `export function db(){...}`
  return (typeof db === 'function') ? db() : db;
}

function normStr(v){
  return (v == null) ? "" : String(v);
}

function normStatus(v){
  const s = normStr(v).trim().toLowerCase();
  if(!s) return "";
  if(s === "open") return "open";
  if(s === "completed" || s === "complete") return "completed";
  // keep other statuses but normalize common shapes
  return s;
}

function safeBool(v){
  return !!v && v !== "false" && v !== 0 && v !== "0";
}

function hasColumn(database, table, col){
  try{
    const rows = database.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(e){
    return false;
  }
}

function pickCols(database, table, desired){
  return desired.filter(c => hasColumn(database, table, c));
}

function isoOrEmpty(v){
  if(v == null) return "";
  const s = String(v);
  if(s.includes("T") && s.includes("Z")) return s;
  return s;
}

function summarizeRow(r){
  const status = normStatus(r.status);
  const when = normStr(r.when) || (r.timestampISO ? isoOrEmpty(r.timestampISO).slice(0,10) : "");
  const scope = normStr(r.scope);
  const boundaryType = normStr(r.boundaryType);
  const notes = normStr(r.notes).trim();

  const updatedISO =
    r.updatedAtISO ||
    r.updatedAt ||
    r.updatedAtTime ||
    (r.updatedAt && r.updatedAt.__time__) ||
    "";

  const who = normStr(r.submittedBy);

  const bits = [];
  if(boundaryType) bits.push(boundaryType);
  if(scope) bits.push(scope);
  if(when) bits.push(when);
  if(who) bits.push(`by ${who}`);

  const headline = bits.filter(Boolean).join(" • ");

  return {
    id: r.id,
    status,
    farm: normStr(r.farm),
    farmId: normStr(r.farmId),
    field: normStr(r.field),
    fieldId: normStr(r.fieldId),
    rtkTowerId: normStr(r.rtkTowerId),
    when: when,
    timestampISO: isoOrEmpty(r.timestampISO),
    createdAtISO: isoOrEmpty(r.createdAtISO),
    updatedAtISO: isoOrEmpty(updatedISO),
    drivenAtISO: isoOrEmpty(r.drivenAtISO || r.drivenAt),
    completedAtISO: isoOrEmpty(r.completedAtISO || r.completedAt),
    submittedBy: who,
    submittedByEmail: normStr(r.submittedByEmail),
    notes: notes,
    headline
  };
}

function groupByFarmField(items){
  const farmMap = new Map();

  for(const it of items){
    const farmKey = `${it.farmId || ""}||${it.farm || ""}`.toLowerCase();
    if(!farmMap.has(farmKey)){
      farmMap.set(farmKey, {
        farm: it.farm || "(Unknown farm)",
        farmId: it.farmId || "",
        count: 0,
        fieldsCount: 0,
        fields: []
      });
    }
    const farm = farmMap.get(farmKey);
    farm.count++;

    if(!farm._fieldMap) farm._fieldMap = new Map();
    const fieldKey = `${it.fieldId || ""}||${it.field || ""}`.toLowerCase();

    if(!farm._fieldMap.has(fieldKey)){
      farm._fieldMap.set(fieldKey, {
        field: it.field || "(Unknown field)",
        fieldId: it.fieldId || "",
        count: 0,
        requests: []
      });
      farm.fieldsCount++;
    }

    const f = farm._fieldMap.get(fieldKey);
    f.count++;
    f.requests.push(it);
  }

  const farms = Array.from(farmMap.values()).map(f => {
    const fields = Array.from(f._fieldMap.values())
      .map(x => {
        x.requests.sort((a,b) => {
          const aa = a.timestampISO || a.createdAtISO || "";
          const bb = b.timestampISO || b.createdAtISO || "";
          return bb.localeCompare(aa);
        });
        return x;
      })
      .sort((a,b) => b.count - a.count || a.field.localeCompare(b.field));

    delete f._fieldMap;
    f.fields = fields;
    return f;
  }).sort((a,b) => b.count - a.count || a.farm.localeCompare(b.farm));

  const totalRequests = farms.reduce((s,f)=>s+f.count,0);
  const totalFarms = farms.length;
  const totalFields = farms.reduce((s,f)=>s+f.fieldsCount,0);

  return {
    counts: {
      requests: totalRequests,
      farms: totalFarms,
      fields: totalFields
    },
    farms
  };
}

/**
 * getBoundaryRequests(opts)
 *
 * opts:
 *  - includeArchived (boolean) default false
 *  - status: "open" | "completed" | "all" (optional)
 *
 * Golden rule behavior:
 *  - Default: active-only (Open)
 *  - includeArchived=true: return archived separately
 */
export function getBoundaryRequests(opts = {}){
  const database = getDb();
  const table = "boundary_requests";

  // If table doesn't exist, return empty (no throw)
  try{
    database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  }catch(e){
    return {
      ok: true,
      intent: "boundaryRequests",
      filter: {
        status: "open",
        includeArchived: false
      },
      counts: { requests: 0, farms: 0, fields: 0 },
      farms: [],
      note: `Table '${table}' not found in snapshot`
    };
  }

  const includeArchived = safeBool(opts.includeArchived);
  const status = normStatus(opts.status || "open"); // default open

  const wanted = [
    "id",
    "status",
    "farm",
    "farmId",
    "field",
    "fieldId",
    "rtkTowerId",
    "scope",
    "boundaryType",
    "notes",
    "submittedBy",
    "submittedByEmail",
    "when",
    "timestampISO",
    "t",
    "createdAtISO",
    "updatedAtISO",
    "drivenAtISO",
    "completedAtISO",
    "createdAt",
    "updatedAt",
    "drivenAt",
    "completedAt"
  ];

  const cols = pickCols(database, table, wanted);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";

  const rows = database.prepare(`SELECT ${selectCols} FROM ${table}`).all() || [];
  const items = rows.map(r => {
    if(!r.id && r.docId) r.id = r.docId;
    return summarizeRow(r);
  });

  const isActive = (it) => normStatus(it.status) === "open";
  const isArchived = (it) => !isActive(it);

  let activeItems = [];
  let archivedItems = [];

  if(status === "all"){
    activeItems = items.filter(isActive);
    archivedItems = items.filter(isArchived);
  }else if(status === "completed"){
    archivedItems = items.filter(it => normStatus(it.status) === "completed");
  }else{
    activeItems = items.filter(isActive);
  }

  const activeGrouped = groupByFarmField(activeItems);

  const out = {
    ok: true,
    intent: "boundaryRequests",
    filter: {
      status: status || "open",
      includeArchived: includeArchived
    },
    counts: activeGrouped.counts,
    farms: activeGrouped.farms
  };

  if(includeArchived || status === "all" || status === "completed"){
    const archivedGrouped = groupByFarmField(archivedItems);
    out.archived = {
      counts: archivedGrouped.counts,
      farms: archivedGrouped.farms
    };
  }

  return out;
}
