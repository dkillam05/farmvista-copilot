// ======================================================================
// /src/data/getters/equipmentMakes.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-equipment-makes-esm
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns ONLY active makes (status="active") AND archived=false (if column exists)
// - includeArchived=true returns archived separately
//
// Firefoo notes:
// - equipment-makes docs: { name, nameLower, categories[], archived, status, createdAt, updatedAt }
//
// Output goals:
// - list + count
// - counts by category
// - per-make summary line
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

function summarizeMake(r){
  const name = normStr(r.name) || "(Unnamed make)";
  const status = normStatus(r.status);
  const archivedFlag = (r.archived == null) ? false : truthy(r.archived);
  const categories = asArray(r.categories).map(normStr).filter(Boolean);

  const bits = [];
  bits.push(name);
  if(categories.length) bits.push(`categories: ${categories.join(", ")}`);
  if(status) bits.push(`status: ${status}`);
  if(archivedFlag) bits.push("archived: true");

  return {
    id: r.id,
    name,
    categories,
    status,
    archived: archivedFlag,
    headline: bits.join(" • ")
  };
}

function groupCountsByCategory(items){
  const map = new Map();
  for(const it of items){
    const cats = Array.isArray(it.categories) ? it.categories : [];
    if(!cats.length){
      map.set("(none)", (map.get("(none)") || 0) + 1);
      continue;
    }
    for(const c of cats){
      const k = normStr(c) || "(none)";
      map.set(k, (map.get(k) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a,b) => b.count - a.count || a.category.localeCompare(b.category));
}

function sortByName(a,b){
  return (a.name || "").localeCompare(b.name || "");
}

/**
 * getEquipmentMakes(opts)
 * opts:
 *  - includeArchived (boolean) default false
 *  - category (string) optional: filter by category
 *  - q (string) optional search by name
 */
export function getEquipmentMakes(opts = {}){
  const database = getDb();

  const table = firstExistingTable(database, [
    "equipment_makes",
    "equipment-makes",
    "equipmentMakes",
    "equipmentmakes"
  ]);

  if(!table){
    return {
      ok: true,
      intent: "equipmentMakes",
      filter: { includeArchived: false },
      counts: { makes: 0 },
      byCategory: [],
      makes: [],
      note: `No equipment makes table found (tried: equipment_makes, equipment-makes, equipmentMakes, equipmentmakes)`
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const wantCategory = normLower(opts.category);
  const q = normLower(opts.q);

  const wanted = [
    "id",
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

  const cols = pickCols(database, table, wanted);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = database.prepare(`SELECT ${selectCols} FROM "${table}"`).all() || [];

  const active = [];
  const archived = [];

  const hasArchivedCol = hasColumn(database, table, "archived");
  const hasStatusCol = hasColumn(database, table, "status");

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    const name = normLower(r.name);
    if(q && !name.includes(q)) continue;

    const cats = asArray(r.categories).map(normLower);
    if(wantCategory){
      if(!cats.includes(wantCategory)) continue;
    }

    const st = hasStatusCol ? normStatus(r.status) : "";
    const archFlag = hasArchivedCol ? truthy(r.archived) : false;

    // ACTIVE RULE:
    // - if status exists: status must be active (or missing)
    // - if archived exists: archived must be false
    const isActiveStatus = !hasStatusCol ? true : (st === "" || st === "active");
    const isActiveArchived = !hasArchivedCol ? true : !archFlag;

    if(isActiveStatus && isActiveArchived){
      active.push(r);
    }else{
      archived.push(r);
    }
  }

  const activeSumm = active.map(summarizeMake).sort(sortByName);

  const out = {
    ok: true,
    intent: "equipmentMakes",
    tableUsed: table,
    filter: {
      includeArchived,
      category: wantCategory || null,
      q: q || null
    },
    counts: { makes: activeSumm.length },
    byCategory: groupCountsByCategory(activeSumm),
    makes: activeSumm
  };

  if(includeArchived){
    const archSumm = archived.map(summarizeMake).sort(sortByName);
    out.archived = {
      counts: { makes: archSumm.length },
      byCategory: groupCountsByCategory(archSumm),
      makes: archSumm
    };
  }

  return out;
}
