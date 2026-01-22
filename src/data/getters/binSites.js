// ======================================================================
// src/data/getters/binSites.js
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns ONLY active bin sites (status="active") AND used=false (if column exists)
// - If includeArchived=true: returns archived/used separately
//
// Firefoo notes:
// - binSites docs: { name, status, used, totalBushels, bins: [{num,bushels,onHand,lastCropType,lastCropMoisture,...}], createdAt, updatedAt }
//
// Output goals:
// - list + count
// - totals (site count, total capacity, total onHand if available)
// - per-site summary + per-bin quick summary
// ======================================================================

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

function hasTable(db, name){
  try{
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name);
    return !!row;
  }catch(e){
    return false;
  }
}
function firstExistingTable(db, candidates){
  for(const t of candidates){
    if(hasTable(db, t)) return t;
  }
  return null;
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

function asArray(v){
  if(Array.isArray(v)) return v;
  if(v == null) return [];
  try{
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){
    return [];
  }
}

function normStatus(v){
  const s = normLower(v);
  if(!s) return "";
  if(s === "active") return "active";
  if(s === "archived") return "archived";
  if(s === "inactive") return "inactive";
  return s;
}

function sumBinsOnHand(bins){
  let total = 0;
  let any = false;
  for(const b of bins){
    const oh = safeNum(b.onHand);
    if(oh != null){
      total += oh;
      any = true;
    }
  }
  return any ? total : null;
}

function summarizeSite(site){
  const name = normStr(site.name) || "(Unnamed bin site)";
  const status = normStatus(site.status);
  const used = truthy(site.used);

  const totalBushels = safeNum(site.totalBushels);
  const bins = asArray(site.bins);

  const binCount = bins.length;
  const onHand = sumBinsOnHand(bins);

  // bin summary lines (keep short)
  const binLines = bins
    .slice()
    .sort((a,b) => (safeNum(a.num) ?? 0) - (safeNum(b.num) ?? 0))
    .map(b => {
      const num = safeNum(b.num);
      const cap = safeNum(b.bushels);
      const oh = safeNum(b.onHand);
      const crop = normStr(b.lastCropType);
      const moist = safeNum(b.lastCropMoisture);

      const bits = [];
      bits.push(`Bin ${num ?? "?"}`);
      if(cap != null) bits.push(`cap ${cap}`);
      if(oh != null) bits.push(`onHand ${oh}`);
      if(crop) bits.push(crop);
      if(moist != null) bits.push(`${moist}%`);
      return bits.join(" • ");
    });

  const headlineBits = [];
  headlineBits.push(name);
  if(totalBushels != null) headlineBits.push(`cap ${totalBushels}`);
  headlineBits.push(`${binCount} bin${binCount === 1 ? "" : "s"}`);
  if(onHand != null) headlineBits.push(`onHand ${onHand}`);
  if(status) headlineBits.push(`status: ${status}`);
  if(used) headlineBits.push(`used: true`);

  return {
    id: site.id,
    name,
    status,
    used,
    totalBushels,
    binCount,
    onHand,
    headline: headlineBits.join(" • "),
    bins: binLines
  };
}

function sortByName(a,b){
  return (a.name || "").localeCompare(b.name || "");
}

function rollupTotals(items){
  let totalCap = 0;
  let capAny = false;
  let totalOnHand = 0;
  let onHandAny = false;

  for(const it of items){
    if(it.totalBushels != null){
      totalCap += it.totalBushels;
      capAny = true;
    }
    if(it.onHand != null){
      totalOnHand += it.onHand;
      onHandAny = true;
    }
  }

  return {
    totalCapacityBushels: capAny ? totalCap : null,
    totalOnHandBushels: onHandAny ? totalOnHand : null
  };
}

/**
 * getBinSites(db, opts)
 * opts:
 *  - includeArchived (boolean) default false
 *  - q (string) optional search by site name
 */
function getBinSites(db, opts={}){
  const table = firstExistingTable(db, [
    "bin_sites",
    "binSites",
    "binsites"
  ]);

  if(!table){
    return {
      ok: true,
      intent: "binSites",
      filter: { includeArchived: false },
      counts: { sites: 0 },
      totals: { totalCapacityBushels: null, totalOnHandBushels: null },
      sites: [],
      note: `No bin sites table found in snapshot (tried: bin_sites, binSites, binsites)`
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const q = normLower(opts.q);

  const wanted = [
    "id",
    "name",
    "status",
    "used",
    "totalBushels",
    "bins",
    "createdAtISO",
    "updatedAtISO",
    "createdAt",
    "updatedAt"
  ];

  const cols = pickCols(db, table, wanted);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = db.prepare(`SELECT ${selectCols} FROM ${table}`).all() || [];

  const active = [];
  const archived = [];

  for(const r of rows){
    r.id = r.id || r.docId || null;
    if(!r.id) continue;

    const status = normStatus(r.status);
    const used = truthy(r.used);

    if(q){
      const hay = normLower(r.name);
      if(!hay.includes(q)) continue;
    }

    // ACTIVE RULE:
    // - status must be "active" (or missing but treat missing as active)
    // - AND used must be false (if used is present), because used=true implies "not in rotation"
    const isActiveStatus = (status === "" || status === "active");
    const isActiveUsed = (r.used == null) ? true : !used;

    if(isActiveStatus && isActiveUsed){
      active.push(r);
    }else{
      archived.push(r);
    }
  }

  const activeSumm = active.map(summarizeSite).sort(sortByName);
  const out = {
    ok: true,
    intent: "binSites",
    tableUsed: table,
    filter: { includeArchived, q: q || null },
    counts: { sites: activeSumm.length },
    totals: rollupTotals(activeSumm),
    sites: activeSumm
  };

  if(includeArchived){
    const archSumm = archived.map(summarizeSite).sort(sortByName);
    out.archived = {
      counts: { sites: archSumm.length },
      totals: rollupTotals(archSumm),
      sites: archSumm
    };
  }

  return out;
}

module.exports = {
  getBinSites
};
