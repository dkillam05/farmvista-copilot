// /src/data/getters/grainBags.js  (FULL FILE)
// Rev: 2026-01-24-v7-grainbags-use-corn-rated-capacity-factors
//
// Based on: 2026-01-23-v6-grainbags-support-snapshot-schema-appliedTo-table
//
// Fix (per Dane):
// ✅ Support current SQLite snapshot schema from /context/snapshot-build.js:
//    - events table = grainBagEvents (or grain_bag_events variants)
//    - putDown counts are stored as countFull/countPartial + partialFeetJson/partialFeetSum
//    - bagSku fields stored as bagSkuId/bagBrand/bagDiameterFt/bagSizeFeet
//    - field stored as fieldId/fieldName
//    - pickUp reductions stored in grainBagAppliedTo table (refPutDownId + takeFull/takePartial)
// ✅ Still supports Firestore-shaped JSON rows (counts/bagSku/field/appliedTo) if present
//
// NEW (per Dane):
// ✅ productsGrainBags.bushels is CORN-RATED capacity
// ✅ Convert bushels by crop using FarmVista factors (same as FVGrainCapacity):
//    corn: 1.00
//    soybeans: 0.93
//    wheat: 1.07
//    milo: 1.02
//    oats: 0.78
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - "out in fields" means remainingFull>0 OR remainingPartial>0 OR remainingPartialFeetSum>0

import { db } from "../sqlite.js";

/* ----------------------------- helpers ----------------------------- */
function getDb(){
  return (typeof db === "function") ? db() : db;
}

function normStr(v){ return (v == null) ? "" : String(v); }
function normLower(v){ return normStr(v).trim().toLowerCase(); }

function safeNum(v){
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asObj(v){
  if(v && typeof v === "object") return v;
  if(v == null) return null;
  if(typeof v === "string"){
    const s = v.trim();
    if(!s) return null;
    try{
      const p = JSON.parse(s);
      return (p && typeof p === "object") ? p : null;
    }catch(_e){
      return null;
    }
  }
  return null;
}

function asArray(v){
  if(Array.isArray(v)) return v;
  if(v == null) return [];
  if(typeof v === "string"){
    const s = v.trim();
    if(!s) return [];
    try{
      const p = JSON.parse(s);
      return Array.isArray(p) ? p : [];
    }catch(_e){
      return [];
    }
  }
  return [];
}

function hasTable(sqlite, name){
  try{
    const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name);
    return !!row;
  }catch(_e){
    return false;
  }
}

function firstExistingTable(sqlite, candidates){
  for(const t of candidates){
    if(hasTable(sqlite, t)) return t;
  }
  return null;
}

function hasColumn(sqlite, table, col){
  try{
    const rows = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(_e){
    return false;
  }
}

function pickCols(sqlite, table, desired){
  return desired.filter(c => hasColumn(sqlite, table, c));
}

function normCrop(v){
  const s = normLower(v);
  if(!s) return "Other";
  if(s.includes("corn")) return "Corn";
  if(s.includes("soy") || s.includes("bean")) return "Soybeans";
  if(s.includes("wheat")) return "Wheat";
  if(s.includes("milo") || s.includes("sorghum")) return "Milo";
  if(s.includes("oat")) return "Oats";
  return "Other";
}

function parseProductRef(ref){
  // Firefoo: { "__ref__": "productsGrainBags/OvJJ..." } OR string "productsGrainBags/OvJJ..."
  const o = asObj(ref);
  const s = o?.__ref__ ? String(o.__ref__) : (typeof ref === "string" ? ref : "");
  const parts = s.split("/");
  return parts.length === 2 ? parts[1] : "";
}

/* ----------------------------- crop factors (FVGrainCapacity) ----------------------------- */
// All "bushels" in productsGrainBags are CORN-RATED capacity.
// Convert to effective bushels for the target crop using these factors.
const CROP_FACTORS = {
  Corn: 1.00,
  Soybeans: 0.93,
  Wheat: 1.07,
  Milo: 1.02,
  Oats: 0.78,
  Other: 1.00
};

function cropFactor(cropTypeNorm){
  const f = CROP_FACTORS[cropTypeNorm];
  return (typeof f === "number" && Number.isFinite(f)) ? f : 1.0;
}

/* ----------------------------- capacity ----------------------------- */
function pickCapacityColumns(sqlite, tableProducts){
  const cols = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(tableProducts)})`).all().map(r => r.name);
  const has = (c) => cols.includes(c);

  return {
    any: has("bushels") ? "bushels" : null, // CORN-RATED in FarmVista
    corn: has("bushelsCorn") ? "bushelsCorn" : null,
    soy:
      has("bushelsSoy") ? "bushelsSoy" :
      has("bushelsSoybeans") ? "bushelsSoybeans" :
      has("bushelsBeans") ? "bushelsBeans" :
      has("bushelsBean") ? "bushelsBean" :
      null,
    wheat:
      has("bushelsWheat") ? "bushelsWheat" :
      has("bushelsWh") ? "bushelsWh" :
      null
  };
}

function capacityForCrop(productRow, cropTypeNorm, capCols){
  if(!productRow) return null;

  const f = cropFactor(cropTypeNorm);

  // ✅ Preferred: CORN-RATED capacity stored in bushels
  if(capCols.any && productRow[capCols.any] != null){
    const cornRated = safeNum(productRow[capCols.any]);
    return (cornRated == null) ? null : (cornRated * f);
  }

  // ✅ If bushelsCorn exists, treat it as corn-rated and apply factor
  if(capCols.corn && productRow[capCols.corn] != null){
    const cornRated = safeNum(productRow[capCols.corn]);
    return (cornRated == null) ? null : (cornRated * f);
  }

  // Legacy: If crop-specific exists, treat as already-correct capacity for that crop
  if(cropTypeNorm === "Soybeans" && capCols.soy) return safeNum(productRow[capCols.soy]);
  if(cropTypeNorm === "Wheat" && capCols.wheat) return safeNum(productRow[capCols.wheat]);

  return null;
}

/* ----------------------------- public: down summary ----------------------------- */
export function getGrainBagsDownSummary(){
  const sqlite = getDb();

  if(hasTable(sqlite, "v_grainBag_open_remaining") && hasTable(sqlite, "productsGrainBags")){
    const capCols = pickCapacityColumns(sqlite, "productsGrainBags");

    // CORN-RATED base capacity
    const anyCol = capCols.any ? `p.${capCols.any} AS cornRatedBu` : `NULL AS cornRatedBu`;
    const cornCol = capCols.corn ? `p.${capCols.corn} AS cornRatedBu2` : `NULL AS cornRatedBu2`;

    // keep legacy columns (optional)
    const soyCol  = capCols.soy  ? `p.${capCols.soy}  AS bushelsSoyLegacy`  : `NULL AS bushelsSoyLegacy`;
    const wheatCol= capCols.wheat? `p.${capCols.wheat} AS bushelsWheatLegacy`: `NULL AS bushelsWheatLegacy`;

    // Apply FV factors in SQL so bushels are not zero
    const sql = `
      WITH cap AS (
        SELECT
          p.id,
          p.brand,
          p.diameterFt,
          p.lengthFt,
          ${anyCol},
          ${cornCol},
          ${soyCol},
          ${wheatCol}
        FROM productsGrainBags p
      ),
      open AS (
        SELECT
          o.putDownId,
          o.cropType,
          o.bagBrand,
          o.bagDiameterFt,
          o.bagSizeFeet,
          o.remainingFull,
          o.remainingPartial,
          o.remainingPartialFeetSum
        FROM v_grainBag_open_remaining o
      ),
      joined AS (
        SELECT
          open.cropType AS cropType,
          open.putDownId AS putDownId,
          open.remainingFull AS remainingFull,
          open.remainingPartial AS remainingPartial,
          open.remainingPartialFeetSum AS remainingPartialFeetSum,
          open.bagSizeFeet AS bagSizeFeet,

          -- CORN-RATED base (prefer bushels, then bushelsCorn)
          COALESCE(cap.cornRatedBu, cap.cornRatedBu2, 0) AS cornRatedCapacityBu,

          -- legacy direct crop capacity (only used if cornRated missing)
          COALESCE(cap.bushelsSoyLegacy, 0) AS soyLegacyBu,
          COALESCE(cap.bushelsWheatLegacy, 0) AS wheatLegacyBu

        FROM open
        LEFT JOIN cap
          ON cap.diameterFt = open.bagDiameterFt
         AND cap.lengthFt   = open.bagSizeFeet
      ),
      cap2 AS (
        SELECT
          *,
          CASE
            WHEN lower(cropType) LIKE '%corn%' THEN
              cornRatedCapacityBu * 1.00

            WHEN lower(cropType) LIKE '%soy%' OR lower(cropType) LIKE '%bean%' THEN
              CASE
                WHEN cornRatedCapacityBu > 0 THEN cornRatedCapacityBu * 0.93
                ELSE soyLegacyBu
              END

            WHEN lower(cropType) LIKE '%wheat%' THEN
              CASE
                WHEN cornRatedCapacityBu > 0 THEN cornRatedCapacityBu * 1.07
                ELSE wheatLegacyBu
              END

            WHEN lower(cropType) LIKE '%milo%' OR lower(cropType) LIKE '%sorghum%' THEN
              cornRatedCapacityBu * 1.02

            WHEN lower(cropType) LIKE '%oat%' THEN
              cornRatedCapacityBu * 0.78

            ELSE
              cornRatedCapacityBu * 1.00
          END AS bagCapacityBu
        FROM joined
      )
      SELECT
        cropType,
        COUNT(1) AS putDownRows,
        SUM(COALESCE(remainingFull,0)) AS remainingFull,
        SUM(COALESCE(remainingPartial,0)) AS remainingPartial,
        ROUND(SUM(COALESCE(remainingFull,0) * COALESCE(bagCapacityBu,0)), 1) AS bushelsFull,
        ROUND(SUM(
          CASE
            WHEN COALESCE(bagSizeFeet,0) <= 0 THEN 0
            ELSE (COALESCE(remainingPartialFeetSum,0) / bagSizeFeet) * COALESCE(bagCapacityBu,0)
          END
        ), 1) AS bushelsPartial,
        ROUND(
          SUM(COALESCE(remainingFull,0) * COALESCE(bagCapacityBu,0)) +
          SUM(
            CASE
              WHEN COALESCE(bagSizeFeet,0) <= 0 THEN 0
              ELSE (COALESCE(remainingPartialFeetSum,0) / bagSizeFeet) * COALESCE(bagCapacityBu,0)
            END
          )
        , 1) AS bushelsTotal
      FROM cap2
      GROUP BY cropType
      ORDER BY cropType ASC
    `;

    return sqlite.prepare(sql).all();
  }

  const rep = getGrainBagsReport({});
  return rep.totals.byCrop.map(x => ({
    cropType: x.crop,
    remainingFull: x.remainingFull,
    remainingPartial: x.remainingPartial,
    bushelsFull: x.bushelsFull,
    bushelsPartial: x.bushelsPartial,
    bushelsTotal: x.bushelsTotal
  }));
}

/* ----------------------------- public: full report ----------------------------- */
export function getGrainBagsReport(opts = {}){
  const sqlite = getDb();

  const tEvents = firstExistingTable(sqlite, [
    "grain_bag_events",
    "grainBagEvents",
    "grain_bag_event",
    "grainBagEvent"
  ]);

  if(!tEvents){
    return {
      ok: true,
      intent: "grainBagsReport",
      counts: { putDowns: 0, outPutDowns: 0 },
      totals: { byCrop: [], bushelsTotal: 0, bagsOutFull: 0, bagsOutPartial: 0 },
      byCounty: [],
      byFarm: [],
      putDowns: [],
      note: `No grain bag events table found in snapshot (tried: grain_bag_events, grainBagEvents, ...)`
    };
  }

  // NEW: pickUp reductions table used by current snapshot schema
  const tApplied = firstExistingTable(sqlite, [
    "grainBagAppliedTo",
    "grain_bag_applied_to",
    "grainbagappliedto"
  ]);

  const tInv = firstExistingTable(sqlite, [
    "inventoryGrainBagMovements",
    "inventory_grain_bag_movements",
    "inventory_grainbag_movements"
  ]);

  const tProd = firstExistingTable(sqlite, [
    "productsGrainBags",
    "products_grain_bags",
    "productsgrainbags"
  ]);

  const tFields = firstExistingTable(sqlite, [
    "fields",
    "v_fields",
    "fields_full",
    "fieldsFull",
    "farms_fields",
    "farmsFields"
  ]);

  const tFarms = firstExistingTable(sqlite, [
    "farms",
    "v_farms",
    "farms_full",
    "farmsFull"
  ]);

  // ----- load products + inventory map -----
  const productById = new Map();
  let capCols = null;

  if(tProd){
    capCols = pickCapacityColumns(sqlite, tProd);
    const wantedProd = pickCols(sqlite, tProd, [
      "id","brand","diameterFt","lengthFt","status",
      ...(capCols.any?[capCols.any]:[]),
      ...(capCols.corn?[capCols.corn]:[]),
      ...(capCols.soy?[capCols.soy]:[]),
      ...(capCols.wheat?[capCols.wheat]:[])
    ]);
    const sel = wantedProd.length ? wantedProd.map(c => `"${c}"`).join(", ") : "*";
    const rows = sqlite.prepare(`SELECT ${sel} FROM "${tProd}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      r.id = id;
      productById.set(id, r);
    }
  }

  const bagSkuToProductId = new Map();
  if(tInv){
    const wantedInv = pickCols(sqlite, tInv, ["id","productRef","brand","diameterFt","lengthFt","status"]);
    const sel = wantedInv.length ? wantedInv.map(c => `"${c}"`).join(", ") : "*";
    const rows = sqlite.prepare(`SELECT ${sel} FROM "${tInv}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      const productId = parseProductRef(r.productRef);
      if(productId) bagSkuToProductId.set(id, productId);
    }
  }

  // ----- fields + farms lookup -----
  const fieldById = new Map();
  if(tFields){
    const wantedFields = pickCols(sqlite, tFields, [
      "id","name",
      "farmId","farmName",
      "county","countyName","state","stateName"
    ]);
    const sel = wantedFields.length ? wantedFields.map(c => `"${c}"`).join(", ") : "*";
    const rows = sqlite.prepare(`SELECT ${sel} FROM "${tFields}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      r.id = id;
      fieldById.set(id, r);
    }
  }

  const farmById = new Map();
  if(tFarms){
    const wantedFarms = pickCols(sqlite, tFarms, ["id","name","county","countyName","state"]);
    const sel = wantedFarms.length ? wantedFarms.map(c => `"${c}"`).join(", ") : "*";
    const rows = sqlite.prepare(`SELECT ${sel} FROM "${tFarms}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      r.id = id;
      farmById.set(id, r);
    }
  }

  // ----- load events -----
  const wantedEv = pickCols(sqlite, tEvents, [
    // common
    "id","type","cropType","crop","cropYear","datePlaced","pickedUpDate","notes",
    "createdAtISO","updatedAtISO","createdAt","updatedAt",
    // firestore-json style
    "bagSku","counts","countsPicked","appliedTo","field",
    // snapshot-extracted style
    "fieldId","fieldName",
    "bagSkuId","bagBrand","bagDiameterFt","bagSizeFeet",
    "countFull","countPartial",
    "partialFeetJson","partialFeetSum","partialUsageJson"
  ]);
  const selEv = wantedEv.length ? wantedEv.map(c => `"${c}"`).join(", ") : "*";
  const rows = sqlite.prepare(`SELECT ${selEv} FROM "${tEvents}"`).all() || [];

  const putDowns = [];
  const pickUps = [];

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;

    const type = normLower(r.type);
    if(type === "putdown"){
      putDowns.push({ id, raw: r });
    }else if(type === "pickup"){
      pickUps.push({ id, raw: r });
    }
  }

  // ----- index pickUps by refPutDownId -----
  const pickedByPutDown = new Map();

  // Preferred path: grainBagAppliedTo table (current snapshot schema)
  if(tApplied){
    const wantedAp = pickCols(sqlite, tApplied, ["refPutDownId","takeFull","takePartial"]);
    const selAp = wantedAp.length ? wantedAp.map(c => `"${c}"`).join(", ") : "*";
    const apRows = sqlite.prepare(`SELECT ${selAp} FROM "${tApplied}"`).all() || [];
    for(const r of apRows){
      const ref = normStr(r.refPutDownId);
      if(!ref) continue;
      if(!pickedByPutDown.has(ref)) pickedByPutDown.set(ref, []);
      pickedByPutDown.get(ref).push({
        takeFull: safeNum(r.takeFull) ?? 0,
        takePartial: safeNum(r.takePartial) ?? 0
      });
    }
  } else {
    // Fallback: Firestore-json appliedTo inside pickUp event
    for(const pu of pickUps){
      const appliedTo = asArray(pu.raw.appliedTo);
      for(const a of appliedTo){
        const o = asObj(a) || a;
        const ref = normStr(o?.refPutDownId);
        if(!ref) continue;
        if(!pickedByPutDown.has(ref)) pickedByPutDown.set(ref, []);
        pickedByPutDown.get(ref).push({
          takeFull: safeNum(o?.takeFull) ?? 0,
          takePartial: safeNum(o?.takePartial) ?? 0
        });
      }
    }
  }

  // ----- build output rows -----
  const cropFilter = normLower(opts.crop);
  const items = [];

  for(const pd of putDowns){
    const raw = pd.raw;

    const cropRaw = normStr(raw.cropType || raw.crop);
    const crop = normCrop(cropRaw);
    if(cropFilter){
      const want = normCrop(cropFilter);
      if(crop !== want) continue;
    }

    // counts: firestore-json OR snapshot-extracted
    const counts = asObj(raw.counts) || null;
    const full =
      (counts ? (safeNum(counts.full) ?? 0) : (safeNum(raw.countFull) ?? 0));
    const partial =
      (counts ? (safeNum(counts.partial) ?? 0) : (safeNum(raw.countPartial) ?? 0));

    // partial feet: firestore-json OR snapshot-extracted
    const partialFeetArr =
      (counts && counts.partialFeet != null)
        ? asArray(counts.partialFeet).map(safeNum).filter(n => n != null)
        : asArray(raw.partialFeetJson).map(safeNum).filter(n => n != null);

    const partialFeetSumFromArr = partialFeetArr.reduce((s,n)=>s+n,0);
    const partialFeetSum =
      (partialFeetSumFromArr > 0)
        ? partialFeetSumFromArr
        : (safeNum(raw.partialFeetSum) ?? 0);

    // subtract pickUps
    const picks = pickedByPutDown.get(pd.id) || [];
    const takeFull = picks.reduce((s,x)=>s+(safeNum(x.takeFull) ?? 0),0);
    const takePartial = picks.reduce((s,x)=>s+(safeNum(x.takePartial) ?? 0),0);

    const remainingFull = Math.max(0, full - takeFull);
    const remainingPartial = Math.max(0, partial - takePartial);

    // bagSku: firestore-json OR snapshot-extracted
    const bagSkuObj = asObj(raw.bagSku) || {
      id: raw.bagSkuId,
      brand: raw.bagBrand,
      diameterFt: raw.bagDiameterFt,
      sizeFeet: raw.bagSizeFeet
    };

    const bagSizeFeet = safeNum(bagSkuObj.sizeFeet) ?? safeNum(bagSkuObj.bagSizeFeet) ?? safeNum(raw.bagSizeFeet) ?? null;

    let remainingPartialFeetSum = partialFeetSum;
    if(remainingPartialFeetSum === 0 && remainingPartial > 0 && bagSizeFeet != null){
      remainingPartialFeetSum = remainingPartial * bagSizeFeet;
    }

    const isOut = (remainingFull > 0) || (remainingPartial > 0) || (remainingPartialFeetSum > 0);

    // field: firestore-json OR snapshot-extracted
    const fieldObj = asObj(raw.field) || { id: raw.fieldId, name: raw.fieldName };
    const fieldId = normStr(fieldObj.id) || normStr(raw.fieldId);
    const fieldName = normStr(fieldObj.name) || normStr(raw.fieldName);

    const fieldRow = fieldById.get(fieldId) || null;
    const farmId = normStr(fieldRow?.farmId) || normStr(raw.farmId);
    const farmName = normStr(fieldRow?.farmName) || normStr(raw.farmName);
    const farmRow = farmById.get(farmId) || null;

    const county =
      normStr(fieldRow?.countyName || fieldRow?.county) ||
      normStr(farmRow?.countyName || farmRow?.county) ||
      "(Unknown county)";

    const farmDisplay = farmName || farmRow?.name || "(Unknown farm)";
    const fieldDisplay = fieldName || fieldRow?.name || "(Unknown field)";

    // Resolve capacity (now applies crop factors when using corn-rated columns)
    let capacityBu = null;
    let capacitySource = "";

    const bagSkuId = normStr(bagSkuObj.id) || normStr(raw.bagSkuId);
    const productId = bagSkuId ? (bagSkuToProductId.get(bagSkuId) || "") : "";
    const product = productId ? productById.get(productId) : null;

    if(product && capCols){
      capacityBu = capacityForCrop(product, crop, capCols);
      capacitySource = productId ? `productsGrainBags/${productId}` : "";
    }

    if(capacityBu == null && tProd && capCols){
      const diam = safeNum(bagSkuObj.diameterFt) ?? safeNum(raw.bagDiameterFt);
      const len = safeNum(bagSkuObj.sizeFeet) ?? safeNum(raw.bagSizeFeet);
      const brand = normLower(bagSkuObj.brand) || normLower(raw.bagBrand);
      if(diam != null && len != null){
        for(const p of productById.values()){
          const pdm = safeNum(p.diameterFt);
          const pln = safeNum(p.lengthFt);
          const pbr = normLower(p.brand);
          if(pdm === diam && pln === len && (!brand || !pbr || brand === pbr)){
            capacityBu = capacityForCrop(p, crop, capCols);
            capacitySource = `productsGrainBags/${p.id} (matched by size)`;
            break;
          }
        }
      }
    }

    const bushelsFull = (capacityBu != null) ? (remainingFull * capacityBu) : 0;
    const bushelsPartial =
      (capacityBu != null && bagSizeFeet != null && bagSizeFeet > 0)
        ? ((remainingPartialFeetSum / bagSizeFeet) * capacityBu)
        : 0;

    const bushelsTotal = bushelsFull + bushelsPartial;

    items.push({
      putDownId: pd.id,
      crop,
      cropRaw,
      cropYear: safeNum(raw.cropYear) ?? null,
      datePlaced: normStr(raw.datePlaced) || "",
      farmId,
      farmName: farmDisplay,
      county,
      fieldId,
      fieldName: fieldDisplay,

      bagSkuId,
      bagBrand: normStr(bagSkuObj.brand) || normStr(raw.bagBrand),
      bagDiameterFt: safeNum(bagSkuObj.diameterFt) ?? safeNum(raw.bagDiameterFt) ?? null,
      bagSizeFeet: bagSizeFeet,

      remainingFull,
      remainingPartial,
      remainingPartialFeetSum,

      capacityBu: capacityBu ?? null,
      capacitySource,

      bushelsFull: Math.round(bushelsFull * 10) / 10,
      bushelsPartial: Math.round(bushelsPartial * 10) / 10,
      bushelsTotal: Math.round(bushelsTotal * 10) / 10,

      isOut
    });
  }

  const outItems = items.filter(x => x.isOut);

  // totals by crop (include bag counts too)
  const cropMap = new Map();
  for(const it of outItems){
    if(!cropMap.has(it.crop)){
      cropMap.set(it.crop, {
        crop: it.crop,
        remainingFull: 0,
        remainingPartial: 0,
        bushelsFull: 0,
        bushelsPartial: 0,
        bushelsTotal: 0,
        putDownsOut: 0
      });
    }
    const c = cropMap.get(it.crop);
    c.putDownsOut++;
    c.remainingFull += it.remainingFull;
    c.remainingPartial += it.remainingPartial;
    c.bushelsFull += it.bushelsFull;
    c.bushelsPartial += it.bushelsPartial;
    c.bushelsTotal += it.bushelsTotal;
  }

  const byCrop = Array.from(cropMap.values()).sort((a,b) => b.bushelsTotal - a.bushelsTotal);

  function rollupByCounty(list){
    const map = new Map();
    for(const it of list){
      const key = normLower(it.county || "(unknown county)");
      if(!map.has(key)){
        map.set(key, {
          county: it.county || "(Unknown county)",
          totalsByCrop: new Map(),
          bushelsTotal: 0
        });
      }
      const c = map.get(key);
      if(!c.totalsByCrop.has(it.crop)){
        c.totalsByCrop.set(it.crop, { crop: it.crop, bushelsTotal: 0 });
      }
      c.totalsByCrop.get(it.crop).bushelsTotal += it.bushelsTotal;
      c.bushelsTotal += it.bushelsTotal;
    }
    return Array.from(map.values()).map(c => ({
      county: c.county,
      bushelsTotal: Math.round(c.bushelsTotal * 10) / 10,
      crops: Array.from(c.totalsByCrop.values())
        .map(x => ({ crop: x.crop, bushelsTotal: Math.round(x.bushelsTotal * 10) / 10 }))
        .sort((a,b) => b.bushelsTotal - a.bushelsTotal)
    })).sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.county.localeCompare(b.county));
  }

  function rollupByFarm(list){
    const map = new Map();
    for(const it of list){
      const key = `${normLower(it.county)}||${normLower(it.farmId || it.farmName)}`;
      if(!map.has(key)){
        map.set(key, {
          county: it.county || "(Unknown county)",
          farmId: it.farmId || "",
          farmName: it.farmName || "(Unknown farm)",
          totalsByCrop: new Map(),
          bushelsTotal: 0
        });
      }
      const f = map.get(key);
      if(!f.totalsByCrop.has(it.crop)){
        f.totalsByCrop.set(it.crop, { crop: it.crop, bushelsTotal: 0 });
      }
      f.totalsByCrop.get(it.crop).bushelsTotal += it.bushelsTotal;
      f.bushelsTotal += it.bushelsTotal;
    }
    return Array.from(map.values()).map(f => ({
      county: f.county,
      farmId: f.farmId,
      farmName: f.farmName,
      bushelsTotal: Math.round(f.bushelsTotal * 10) / 10,
      crops: Array.from(f.totalsByCrop.values())
        .map(x => ({ crop: x.crop, bushelsTotal: Math.round(x.bushelsTotal * 10) / 10 }))
        .sort((a,b) => b.bushelsTotal - a.bushelsTotal)
    })).sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.farmName.localeCompare(b.farmName));
  }

  const totalBushelsAll = byCrop.reduce((s,x)=>s+x.bushelsTotal,0);
  const totalFullBags = byCrop.reduce((s,x)=>s+x.remainingFull,0);
  const totalPartialBags = byCrop.reduce((s,x)=>s+x.remainingPartial,0);

  outItems.sort((a,b) => (b.bushelsTotal - a.bushelsTotal) || (b.remainingFull - a.remainingFull));

  return {
    ok: true,
    intent: "grainBagsReport",
    tableUsed: tEvents,
    appliedToTableUsed: tApplied || "",
    counts: {
      putDowns: putDowns.length,
      outPutDowns: outItems.length
    },
    totals: {
      byCrop,
      bushelsTotal: Math.round(totalBushelsAll * 10) / 10,
      bagsOutFull: totalFullBags,
      bagsOutPartial: totalPartialBags
    },
    byCounty: rollupByCounty(outItems),
    byFarm: rollupByFarm(outItems),
    putDowns: outItems
  };
}