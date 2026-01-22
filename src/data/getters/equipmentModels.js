// ======================================================================
// /src/data/getters/equipmentModels.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-equipment-models-esm
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns ONLY active models
// - includeArchived=true returns archived separately
//
// Firefoo notes:
// - equipment-models docs: { makeId, name, nameLower, categories[], archived, status, createdAt, updatedAt }
//
// Output goals:
// - list + count
// - group by make (makeName if we can resolve from equipment makes table)
// - filter by makeId OR category OR q
// ======================================================================

import { db } from '../sqlite.js';

function getDb(){
  return (typeof db === 'function') ? db() : db;
}

function normStr(v){ return (v == null) ? "" : String(v); }
function normLower(v){ return normStr(v).trim().toLowerCase(); }

function truthy(v){
  if(v === true) return true;
  if(v === false) return false;
  const s = normLower(v);
  return (s === "true" || s === "1" || s === "yes");
}

function hasTable(database, name){
  try{
    const row = database.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
    ).get(name);
    return !!row;
  }catch(_e){
    return false;
  }
}

function firstExistingTable(database, candidates){
  for(const t of candidates){
    if(hasTable(database, t)) return t;
  }
  return null;
}

function hasColumn(database, table, col){
  try{
    const rows = database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(_e){
    return false;
  }
}

function pickCols(database, table, desired){
  return desired.filter(c => hasColumn(database, table, c));
}

function asArray(v){
  if(Array.isArray(v)) return v;
  if(v == null) return [];
  if(typeof v === "string"){
    const s = v.trim();
    if(!s) return [];
    try{
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    }catch(_e){
      return [];
    }
  }
  return [];
}

function normStatus(v){
  const s = normLower(v);
  if(!s) return "";
  if(s === "active") return "active";
  if(s === "archived") return "archived";
  if(s === "inactive") return "inactive";
  return s;
}

function summarizeModel(r, makeName){
  const name = normStr(r.name) || "(Unnamed model)";
  const st = normStatus(r.status);
  const archivedFlag = (r.archived == null) ? false : truthy(r.archived);
  const categories = asArray(r.categories).map(normStr).filter(Boolean);

  const bits = [];
  if(makeName) bits.push(makeName);
  bits.push(name);
  if(categories.length) bits.push(`categories: ${categories.join(", ")}`);
  if(st) bits.push(`status: ${st}`);
  if(archivedFlag) bits.push("archived: true");

  return {
    id: r.id,
    makeId: normStr(r.makeId),
    makeName: makeName || "",
    name,
    categories,
    status: st,
    archived: archivedFlag,
    headline: bits.join(" • ")
  };
}

function sortByMakeThenName(a,b){
  const am = (a.makeName || a.makeId || "").toLowerCase();
  const bm = (b.makeName || b.makeId || "").toLowerCase();
  if(am !== bm) return am.localeCompare(bm);
  return (a.name || "").localeCompare(b.name || "");
}

/**
 * getEquipmentModels(opts)
 * opts:
 *  - includeArchived (boolean) default false
 *  - makeId (string) optional exact filter
 *  - category (string) optional filter by category
 *  - q (string) optional search on model name (and make name if resolved)
 */
export function getEquipmentModels(opts = {}){
  const database = getDb();

  const tableModels = firstExistingTable(database, [
    "equipment_models",
    "equipment-models",
    "equipmentModels",
    "equipmentmodels"
  ]);

  if(!tableModels){
    return {
      ok: true,
      intent: "equipmentModels",
      filter: { includeArchived: false },
      counts: { models: 0, makes: 0 },
      makes: [],
      models: [],
      note: `No equipment models table found (tried: equipment_models, equipment-models, equipmentModels, equipmentmodels)`
    };
  }

  // Optional makes table to resolve makeName
  const tableMakes = firstExistingTable(database, [
    "equipment_makes",
    "equipment-makes",
    "equipmentMakes",
    "equipmentmakes"
  ]);

  const includeArchived = truthy(opts.includeArchived);
  const wantMakeId = normStr(opts.makeId);
  const wantCategory = normLower(opts.category);
  const q = normLower(opts.q);

  // Load make map if available
  const makeNameById = new Map();
  if(tableMakes){
    const wantedMakes = pickCols(database, tableMakes, ["id","name","status","archived"]);
    const sel = wantedMakes.length ? wantedMakes.map(c => `"${c}"`).join(", ") : "*";
    const rows = database.prepare(`SELECT ${sel} FROM "${tableMakes}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      makeNameById.set(id, normStr(r.name));
    }
  }

  const wantedModels = [
    "id",
    "makeId",
    "name",
    "nameLower",
    "categories",
    "archived",
    "status",
    "createdAtISO",
    "updatedAtISO",
    "createdAt",
    "updatedAt"
  ];

  const cols = pickCols(database, tableModels, wantedModels);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = database.prepare(`SELECT ${selectCols} FROM "${tableModels}"`).all() || [];

  const hasArchivedCol = hasColumn(database, tableModels, "archived");
  const hasStatusCol = hasColumn(database, tableModels, "status");

  const activeRows = [];
  const archivedRows = [];

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    if(wantMakeId && normStr(r.makeId) !== wantMakeId) continue;

    const cats = asArray(r.categories).map(normLower);
    if(wantCategory){
      // Old behavior: if categories[] is empty/missing => treat as visible everywhere.
      // For filtering by category, empty categories should be INCLUDED (visible everywhere).
      const hasCats = cats.length > 0;
      if(hasCats && !cats.includes(wantCategory)) continue;
    }

    const mkName = makeNameById.get(normStr(r.makeId)) || "";
    if(q){
      const hay = `${normLower(mkName)} | ${normLower(r.name)} | ${normLower(r.nameLower)}`;
      if(!hay.includes(q)) continue;
    }

    const st = hasStatusCol ? normStatus(r.status) : "";
    const archFlag = hasArchivedCol ? truthy(r.archived) : false;

    const isActiveStatus = !hasStatusCol ? true : (st === "" || st === "active");
    const isActiveArchived = !hasArchivedCol ? true : !archFlag;

    if(isActiveStatus && isActiveArchived){
      activeRows.push(r);
    }else{
      archivedRows.push(r);
    }
  }

  const activeModels = activeRows.map(r => summarizeModel(r, makeNameById.get(normStr(r.makeId)) || ""));
  const archivedModels = archivedRows.map(r => summarizeModel(r, makeNameById.get(normStr(r.makeId)) || ""));

  // Group by make (for presentation)
  function groupByMake(items){
    const map = new Map();
    for(const it of items){
      const key = `${it.makeId}||${it.makeName}`.toLowerCase();
      if(!map.has(key)){
        map.set(key, {
          makeId: it.makeId,
          makeName: it.makeName || "(Unknown make)",
          count: 0,
          models: []
        });
      }
      const m = map.get(key);
      m.count++;
      m.models.push(it);
    }
    const out = Array.from(map.values());
    for(const m of out){
      m.models.sort((a,b) => (a.name || "").localeCompare(b.name || ""));
    }
    out.sort((a,b) => b.count - a.count || a.makeName.localeCompare(b.makeName));
    return out;
  }

  const out = {
    ok: true,
    intent: "equipmentModels",
    tableUsed: tableModels,
    filter: {
      includeArchived,
      makeId: wantMakeId || null,
      category: wantCategory || null,
      q: q || null
    },
    counts: {
      models: activeModels.length,
      makes: groupByMake(activeModels).length
    },
    makes: groupByMake(activeModels),
    models: activeModels.sort(sortByMakeThenName)
  };

  if(includeArchived){
    out.archived = {
      counts: {
        models: archivedModels.length,
        makes: groupByMake(archivedModels).length
      },
      makes: groupByMake(archivedModels),
      models: archivedModels.sort(sortByMakeThenName)
    };
  }

  return out;
}
