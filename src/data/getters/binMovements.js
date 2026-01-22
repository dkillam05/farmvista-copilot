// ======================================================================
// /src/data/getters/binMovements.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-bin-movements-esm
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns movements for ACTIVE bin sites only
// - includeArchived=true returns other/archived sites separately
//
// Firefoo notes:
// - binSites docs: { id, name, status, used, bins:[{num,bushels,onHand,...}] }
// - binMovements docs: { siteId, siteName, binNum, binIndex, direction(in/out), bushels, cropType, cropMoisture, dateISO, createdAt }
//
// Output goals:
// - totals IN/OUT/NET
// - grouped by site -> bin -> movements newest first
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
function safeNum(v){
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasTable(database, name){
  try{
    const row = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name);
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

function normStatus(v){
  const s = normLower(v);
  if(!s) return "";
  if(s === "active") return "active";
  if(s === "archived") return "archived";
  if(s === "inactive") return "inactive";
  return s;
}

function normDir(v){
  const s = normLower(v);
  if(s === "in") return "in";
  if(s === "out") return "out";
  return s;
}

function looksLikeId(s){
  const t = normStr(s);
  return t.length >= 18 && t.length <= 40 && /^[A-Za-z0-9_-]+$/.test(t);
}

function movementTimeKey(m){
  // prefer dateISO; else createdAtISO; else createdAt
  const d = normStr(m.dateISO);
  if(d) return d;
  const c1 = normStr(m.createdAtISO);
  if(c1) return c1;
  const c2 = normStr(m.createdAt);
  return c2;
}

function rollTotals(movs){
  let ins = 0;
  let outs = 0;
  for(const m of movs){
    const bu = safeNum(m.bushels) ?? 0;
    const dir = normDir(m.direction);
    if(dir === "in") ins += bu;
    else if(dir === "out") outs += bu;
  }
  const net = ins - outs;
  return {
    inBushels: ins,
    outBushels: outs,
    netBushels: net
  };
}

function groupBySiteBin(movs){
  const siteMap = new Map();

  for(const m of movs){
    const siteId = normStr(m.siteId);
    const siteName = normStr(m.siteName) || "(Unknown site)";
    const siteKey = `${siteId}||${siteName}`.toLowerCase();

    if(!siteMap.has(siteKey)){
      siteMap.set(siteKey, {
        siteId,
        siteName,
        count: 0,
        totals: { inBushels: 0, outBushels: 0, netBushels: 0 },
        bins: []
      });
    }
    const site = siteMap.get(siteKey);
    site.count++;

    if(!site._binMap) site._binMap = new Map();
    const binNum = safeNum(m.binNum) ?? safeNum(m.binIndex) ?? null;
    const binKey = `bin:${binNum == null ? "?" : binNum}`;

    if(!site._binMap.has(binKey)){
      site._binMap.set(binKey, {
        binNum: binNum,
        count: 0,
        totals: { inBushels: 0, outBushels: 0, netBushels: 0 },
        movements: []
      });
    }

    const b = site._binMap.get(binKey);
    b.count++;
    b.movements.push(m);
  }

  const sites = Array.from(siteMap.values()).map(s => {
    const bins = Array.from(s._binMap.values()).map(b => {
      // newest first
      b.movements.sort((a,b2) => movementTimeKey(b2).localeCompare(movementTimeKey(a)));
      b.totals = rollTotals(b.movements);
      return b;
    }).sort((a,b) => (a.binNum ?? 999999) - (b.binNum ?? 999999));

    delete s._binMap;
    s.bins = bins;

    // site totals
    const all = [];
    for(const b of bins) all.push(...b.movements);
    s.totals = rollTotals(all);

    return s;
  }).sort((a,b) => b.totals.netBushels - a.totals.netBushels || a.siteName.localeCompare(b.siteName));

  return sites;
}

/**
 * getBinMovements(opts)
 * opts:
 *  - includeArchived (boolean) default false
 *  - siteId (string) optional exact
 *  - q (string) optional search by siteName
 */
export function getBinMovements(opts = {}){
  const database = getDb();

  const tSites = firstExistingTable(database, [
    "bin_sites",
    "binSites",
    "binsites"
  ]);

  const tMov = firstExistingTable(database, [
    "bin_movements",
    "binMovements",
    "binmovements"
  ]);

  if(!tMov){
    return {
      ok: true,
      intent: "binMovements",
      filter: { includeArchived: false },
      totals: { inBushels: 0, outBushels: 0, netBushels: 0 },
      sites: [],
      note: `No bin movements table found (tried: bin_movements, binMovements, binmovements)`
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const wantSiteId = normStr(opts.siteId);
  const q = normLower(opts.q);

  // Build active site set (default filter)
  const activeSiteIds = new Set();
  const archivedSiteIds = new Set();

  if(tSites){
    const wantedSites = pickCols(database, tSites, ["id","name","status","used"]);
    const sel = wantedSites.length ? wantedSites.map(c => `"${c}"`).join(", ") : "*";
    const rows = database.prepare(`SELECT ${sel} FROM "${tSites}"`).all() || [];

    const hasUsed = hasColumn(database, tSites, "used");
    const hasStatus = hasColumn(database, tSites, "status");

    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;

      const used = hasUsed ? truthy(r.used) : false;
      const st = hasStatus ? normStatus(r.status) : "active";

      const isActive = (st === "" || st === "active") && (!hasUsed || used === false);
      if(isActive) activeSiteIds.add(id);
      else archivedSiteIds.add(id);
    }
  }

  const wantedMov = [
    "id",
    "siteId",
    "siteName",
    "binNum",
    "binIndex",
    "direction",
    "bushels",
    "cropType",
    "cropMoisture",
    "dateISO",
    "note",
    "submittedBy",
    "submittedByUid",
    "createdAtISO",
    "createdAt"
  ];

  const cols = pickCols(database, tMov, wantedMov);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = database.prepare(`SELECT ${selectCols} FROM "${tMov}"`).all() || [];

  const active = [];
  const archived = [];

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    const siteId = normStr(r.siteId);
    const siteName = normStr(r.siteName);

    if(wantSiteId){
      if(siteId !== wantSiteId) continue;
    }else if(q){
      const hay = normLower(siteName);
      if(!hay.includes(q)) continue;
    }

    // Default rule: only movements for active sites.
    // If we can't resolve sites table, treat everything as active.
    const canFilterSites = tSites && (activeSiteIds.size || archivedSiteIds.size);

    const isActiveSite = !canFilterSites ? true : activeSiteIds.has(siteId);
    if(isActiveSite) active.push(r);
    else archived.push(r);
  }

  // normalize movement objects a bit
  function normMovement(m){
    return {
      id: m.id,
      siteId: normStr(m.siteId),
      siteName: normStr(m.siteName) || "(Unknown site)",
      binNum: safeNum(m.binNum) ?? null,
      binIndex: safeNum(m.binIndex) ?? null,
      direction: normDir(m.direction),
      bushels: safeNum(m.bushels) ?? 0,
      cropType: normStr(m.cropType),
      cropMoisture: safeNum(m.cropMoisture),
      dateISO: normStr(m.dateISO),
      createdAtISO: normStr(m.createdAtISO),
      createdAt: normStr(m.createdAt),
      note: normStr(m.note),
      submittedBy: normStr(m.submittedBy),
      submittedByUid: normStr(m.submittedByUid)
    };
  }

  const activeMovs = active.map(normMovement);
  const out = {
    ok: true,
    intent: "binMovements",
    tableUsed: tMov,
    filter: {
      includeArchived,
      siteId: wantSiteId || null,
      q: q || null
    },
    totals: rollTotals(activeMovs),
    sites: groupBySiteBin(activeMovs)
  };

  if(includeArchived){
    const archMovs = archived.map(normMovement);
    out.archived = {
      totals: rollTotals(archMovs),
      sites: groupBySiteBin(archMovs)
    };
  }

  return out;
}
