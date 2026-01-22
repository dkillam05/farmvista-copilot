// ======================================================================
// src/data/getters/equipment.js
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

function hasColumn(db, table, col){
  try{
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(e){
    return false;
  }
}

function pickCols(db, table, desired){
  return desired.filter(c => hasColumn(db, table, c));
}

function safeNum(v){
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n){
  if(n == null) return "";
  // keep simple; no locale formatting in server
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

  // useful extras by type
  const engineHours = safeNum(e.engineHours ?? e.totalHours);
  const totalHours = safeNum(e.totalHours);
  const totalAcres = safeNum(e.totalAcres);
  const workingWidthFt = safeNum(e.workingWidthFt);
  const boomWidthFt = safeNum(e.boomWidthFt);
  const odometer = safeNum(e.odometerMiles);
  const plate = normStr(e.licensePlate);
  const starfireLoc = normStr(e.starfireCurrentLocationName);

  const bits = [];

  // name is usually already "Make Model (Year)" but keep it first
  const name = normStr(e.name) || [make, model, year ? `(${year})` : ""].filter(Boolean).join(" ").trim();
  bits.push(name || "(Unnamed equipment)");

  if(unitId) bits.push(`Unit ${unitId}`);

  // per-type highlights
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
  const byType = Array.from(map.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a,b) => b.count - a.count || a.type.localeCompare(b.type));
  return byType;
}

function sortNewestFirst(a,b){
  // prefer updatedAtISO or updatedAt / createdAt if present
  const aa = normStr(a.updatedAtISO || a.updatedAt || a.createdAtISO || a.createdAt || "");
  const bb = normStr(b.updatedAtISO || b.updatedAt || b.createdAtISO || b.createdAt || "");
  return bb.localeCompare(aa);
}

/**
 * getEquipment(db, opts)
 *
 * opts:
 *  - includeArchived (boolean) default false
 *  - type (string) optional: "tractor" | "implement" | "starfire" | ...
 *  - q (string) optional: search on name/make/model/unitId/serial
 *
 * Golden rule:
 *  - Default active-only
 *  - includeArchived=true => archived returned separately
 */
function getEquipment(db, opts={}){
  const table = "equipment";

  // table guard
  try{
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
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

  // choose likely columns (snapshot schema may vary)
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

  const cols = pickCols(db, table, wanted);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = db.prepare(`SELECT ${selectCols} FROM ${table}`).all() || [];

  // normalize + filter
  const activeRows = [];
  const archivedRows = [];

  for(const r of rows){
    // ensure id
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    const status = normStatus(r.status);
    const isActive = (status === "active" || status === "open"); // "open" here just in case future usage
    const isArchived = (status === "archived" || status === "inactive" || status === "completed");

    // type filter
    if(wantType && normLower(r.type) !== wantType) continue;

    // search filter
    if(q){
      const hay = [
        r.name, r.makeName, r.modelName, r.unitId, r.serial, r.licensePlate,
        r.starfireCurrentLocationName
      ].map(normLower).join(" | ");
      if(!hay.includes(q)) continue;
    }

    if(isActive) activeRows.push(r);
    else if(isArchived) archivedRows.push(r);
    else {
      // unknown status: treat as archived unless includeArchived is false (safer to hide by default)
      archivedRows.push(r);
    }
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
    counts: {
      items: activeItems.length
    },
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

module.exports = {
  getEquipment
};
