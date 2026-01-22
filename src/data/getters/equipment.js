// ======================================================================
// /src/data/getters/equipment.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-ESM
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns ONLY active items
// - If includeArchived=true, returns archived separately
//
// Notes from Firefoo:
// - equipment.status values include: "active", "Active", "Archived"
// - equipment.type values include: tractor, implement, starfire, sprayer, truck, etc.
// - Some docs include unitId, licensePlate, odometerMiles, engineHours, totalHours, totalAcres,
//   workingWidthFt, boomWidthFt, starfireCurrentLocationName, etc.
//
// Output goals:
// - list + count
// - grouped counts by type
// - consistent summary line per item
// ======================================================================

import { db } from '../sqlite.js';

function getDb(){
  return (typeof db === 'function') ? db() : db;
}

function normStr(v){
  return (v == null) ? "" : String(v);
}

function normLower(v){
  return normStr(v).trim().toLowerCase();
}

function normStatus(v){
  const s = normLower(v);
  if(!s) return "";
  if(s === "active") return "active";
  if(s === "archived") return "archived";
  if(s === "inactive") return "inactive";
  if(s === "completed") return "completed";
  return s;
}

function truthy(v){
  if(v === true) return true;
  if(v === false) return false;
  const s = normLower(v);
  if(!s) return false;
  return (s === "true" || s === "1" || s === "yes");
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

function safeNum(v){
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n){
  if(n == null) return "";
  return String(n);
}

function summarizeEquipment(e){
  const type = normLower(e.type) || "(unknown type)";
  const make = normStr(e.makeName);
  const model = normStr(e.modelName);
  const year = e.year != null ? String(e.year) : "";
  const unitId = normStr(e.unitId);
  const serial = normStr(e.serial);
  const status = normStatus(e.status);

  const engineHours = safeNum(e.engineHours ?? e.totalHours);
  const totalAcres = safeNum(e.totalAcres);
  const workingWidthFt = safeNum(e.workingWidthFt);
  const boomWidthFt = safeNum(e.boomWidthFt);
  const odometer = safeNum(e.odometerMiles);
  const plate = normStr(e.licensePlate);
  const starfireLoc = normStr(e.starfireCurrentLocationName);

  const bits = [];

  const name = normStr(e.name) || [make, model, year ? `(${year})` : ""].filter(Boolean).join(" ").trim();
  bits.push(name || "(Unnamed equipment)");

  if(unitId) bits.push(`Unit ${unitId}`);

  if(type === "tractor" || type === "combine" || type === "sprayer" || type === "construction" || type === "fertilizer"){
    if(engineHours != null) bits.push(`${fmtNum(engineHours)} hrs`);
  }
  if(type === "implement"){
    if(totalAcres != null) bits.push(`${fmtNum(totalAcres)} acres`);
    if(workingWidthFt != null) bits.push(`${fmtNum(workingWidthFt)} ft`);
  }
  if(type === "sprayer"){
    if(boomWidthFt != null) bits.push(`${fmtNum(boomWidthFt)} ft boom`);
  }
  if(type === "truck"){
    if(odometer != null) bits.push(`${fmtNum(odometer)} mi`);
    if(plate) bits.push(`Plate ${plate}`);
  }
  if(type === "starfire"){
    if(starfireLoc) bits.push(`On ${starfireLoc}`);
    const act = normStr(e.activationLevel);
    if(act) bits.push(act.toUpperCase());
  }

  if(serial) bits.push(`SN ${serial}`);
  if(status) bits.push(`status: ${status}`);

  return {
    id: e.id,
    type,
    makeName: make,
    modelName: model,
    year: e.year ?? null,
    unitId: unitId,
    status,
    headline: bits.join(" • ")
  };
}

function groupCountsByType(items){
  const map = new Map();
  for(const it of items){
    const t = it.type || "(unknown)";
    map.set(t, (map.get(t) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a,b) => b.count - a.count || a.type.localeCompare(b.type));
}

function sortNewestFirst(a,b){
  const aa = normStr(a.updatedAtISO || a.updatedAt || a.createdAtISO || a.createdAt || "");
  const bb = normStr(b.updatedAtISO || b.updatedAt || b.createdAtISO || b.createdAt || "");
  return bb.localeCompare(aa);
}

/**
 * getEquipment(opts)
 *
 * opts:
 *  - includeArchived (boolean) default false
 *  - type (string) optional: "tractor" | "implement" | "starfire" | ...
 *  - q (string) optional: search on name/make/model/unitId/serial
 */
export function getEquipment(opts = {}){
  const database = getDb();
  const table = "equipment";

  try{
    database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  }catch(e){
    return {
      ok: true,
      intent: "equipment",
      filter: { includeArchived: false },
      counts: { items: 0 },
      byType: [],
      items: [],
      note: `Table '${table}' not found in snapshot`
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const wantType = normLower(opts.type);
  const q = normLower(opts.q);

  const wanted = [
    "id",
    "type",
    "status",
    "name",
    "year",
    "makeId",
    "makeName",
    "modelId",
    "modelName",
    "unitId",
    "serial",
    "notes",
    "engineHours",
    "totalHours",
    "totalAcres",
    "workingWidthFt",
    "boomWidthFt",
    "licensePlate",
    "odometerMiles",
    "activationLevel",
    "firmwareVersion",
    "starfireCurrentLocationId",
    "starfireCurrentLocationName",
    "starfireCurrentLocationSince",
    "starfireCurrentLocationType",
    "createdAtISO",
    "updatedAtISO",
    "createdAt",
    "updatedAt"
  ];

  const cols = pickCols(database, table, wanted);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = database.prepare(`SELECT ${selectCols} FROM ${table}`).all() || [];

  const activeRows = [];
  const archivedRows = [];

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    const status = normStatus(r.status);
    const isActive = (status === "active" || status === "open");
    const isArchived = (status === "archived" || status === "inactive" || status === "completed");

    if(wantType && normLower(r.type) !== wantType) continue;

    if(q){
      const hay = [
        r.name, r.makeName, r.modelName, r.unitId, r.serial, r.licensePlate,
        r.starfireCurrentLocationName
      ].map(normLower).join(" | ");
      if(!hay.includes(q)) continue;
    }

    if(isActive) activeRows.push(r);
    else if(isArchived) archivedRows.push(r);
    else archivedRows.push(r); // unknown status hidden by default
  }

  activeRows.sort(sortNewestFirst);
  archivedRows.sort(sortNewestFirst);

  const activeItems = activeRows.map(summarizeEquipment);

  const out = {
    ok: true,
    intent: "equipment",
    filter: {
      includeArchived,
      type: wantType || null,
      q: q || null
    },
    counts: { items: activeItems.length },
    byType: groupCountsByType(activeItems),
    items: activeItems
  };

  if(includeArchived){
    const archItems = archivedRows.map(summarizeEquipment);
    out.archived = {
      counts: { items: archItems.length },
      byType: groupCountsByType(archItems),
      items: archItems
    };
  }

  return out;
}
