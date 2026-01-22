// /src/data/getters/grainBags.js  (FULL FILE)
// Rev: 2026-01-22-v3-grainbags-report-putdown-pickup-productlink
//
// Keeps:
// - getGrainBagsDownSummary() (existing summary query, array return)
//
// Adds:
// - getGrainBagsReport(opts)
//   -> bushels by crop (MOST IMPORTANT)
//   -> links putDown -> field -> farm -> county
//   -> links bagSku.id -> inventoryGrainBagMovements -> productRef -> productsGrainBags -> bushels capacity
//   -> computes remainingFull/remainingPartial/remainingPartialFeet from putDown - pickUp
//
// ACTIVE-ONLY DEFAULT:
/// - This is operational data, not “archived”; we keep all events but report on “remaining”.
// - No archived toggle here; chat controls archived for other domains.

import { db } from "../sqlite.js";

function sqlite(){
  return db();
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
  try{
    const parsed = JSON.parse(v);
    return (parsed && typeof parsed === "object") ? parsed : null;
  }catch(e){
    return null;
  }
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

function hasTable(sqliteDb, name){
  try{
    const row = sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name);
    return !!row;
  }catch(_e){
    return false;
  }
}
function firstExistingTable(sqliteDb, candidates){
  for(const t of candidates){
    if(hasTable(sqliteDb, t)) return t;
  }
  return null;
}
function hasColumn(sqliteDb, table, col){
  try{
    const rows = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(_e){
    return false;
  }
}
function pickCols(sqliteDb, table, desired){
  return desired.filter(c => hasColumn(sqliteDb, table, c));
}

// -------------------------
// Capacity column detection
// -------------------------
function pickCapacityCols(sqliteDb) {
  // supports both schemas:
  // - legacy: bushelsCorn, bushelsSoy...
  // - simplified: bushels (single capacity)
  const cols = sqliteDb.prepare(`PRAGMA table_info(productsGrainBags)`).all().map(r => r.name);

  const has = (c) => cols.includes(c);

  const universal = has("bushels") ? "bushels" : null;

  const corn = has("bushelsCorn") ? "bushelsCorn" : null;

  const soy =
    has("bushelsSoy") ? "bushelsSoy" :
    has("bushelsSoybeans") ? "bushelsSoybeans" :
    has("bushelsBeans") ? "bushelsBeans" :
    has("bushelsBean") ? "bushelsBean" :
    null;

  const wheat =
    has("bushelsWheat") ? "bushelsWheat" :
    has("bushelsWh") ? "bushelsWh" :
    null;

  // If schema only has `bushels`, use it for all crops.
  if(!corn && universal) return { mode: "universal", universal };
  if(!corn && !universal){
    throw new Error("productsGrainBags is missing bushelsCorn or bushels (required)");
  }

  // If we have corn but no soy, we can still run but soy will be 0; fail loudly to fix schema.
  if(corn && !soy && !universal){
    throw new Error("productsGrainBags has no recognized soy capacity column (expected bushelsSoy or bushelsSoybeans etc.)");
  }

  return { mode: "perCrop", corn, soy, wheat, universal };
}

// -------------------------
// Existing function (keep)
// -------------------------
export function getGrainBagsDownSummary() {
  const s = sqlite();
  const capCols = pickCapacityCols(s);

  let sql;

  if(capCols.mode === "universal"){
    const u = capCols.universal;

    sql = `
      WITH cap AS (
        SELECT
          p.id,
          p.brand,
          p.diameterFt,
          p.lengthFt,
          COALESCE(p.${u}, 0) AS bushelsAny
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
          COALESCE(cap.bushelsAny, 0) AS bagCapacityBu
        FROM open
        LEFT JOIN cap
          ON cap.diameterFt = open.bagDiameterFt
         AND cap.lengthFt   = open.bagSizeFeet
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
      FROM joined
      GROUP BY cropType
      ORDER BY cropType ASC
    `;
  } else {
    const { corn, soy, wheat } = capCols;

    sql = `
      WITH cap AS (
        SELECT
          p.id,
          p.brand,
          p.diameterFt,
          p.lengthFt,
          p.${corn}  AS bushelsCorn,
          p.${soy}   AS bushelsSoy,
          ${wheat ? `p.${wheat} AS bushelsWheat` : `0 AS bushelsWheat`}
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

          CASE
            WHEN lower(open.cropType) LIKE '%corn%'  THEN COALESCE(cap.bushelsCorn, 0)
            WHEN lower(open.cropType) LIKE '%soy%'   THEN COALESCE(cap.bushelsSoy, 0)
            WHEN lower(open.cropType) LIKE '%bean%'  THEN COALESCE(cap.bushelsSoy, 0)
            WHEN lower(open.cropType) LIKE '%wheat%' THEN COALESCE(cap.bushelsWheat, 0)
            ELSE COALESCE(cap.bushelsCorn, 0)
          END AS bagCapacityBu

        FROM open
        LEFT JOIN cap
          ON cap.diameterFt = open.bagDiameterFt
         AND cap.lengthFt   = open.bagSizeFeet
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
      FROM joined
      GROUP BY cropType
      ORDER BY cropType ASC
    `;
  }

  return s.prepare(sql).all();
}

// -------------------------
// New: Rich grain bag report
// -------------------------

function parseFirestoreRefId(ref){
  // Firefoo example: { "__ref__": "productsGrainBags/OvJJ2bME..." }
  // Snapshots may store as string or object; return the last path segment.
  if(!ref) return "";
  if(typeof ref === "string"){
    const s = ref;
    const parts = s.split("/");
    return parts[parts.length - 1] || "";
  }
  if(typeof ref === "object"){
    const r = ref.__ref__ || ref.path || ref.ref || "";
    if(typeof r === "string"){
      const parts = r.split("/");
      return parts[parts.length - 1] || "";
    }
  }
  return "";
}

function cropKey(cropType){
  const c = normLower(cropType);
  if(c.includes("corn")) return "corn";
  if(c.includes("soy")) return "soybeans";
  if(c.includes("bean")) return "soybeans";
  if(c.includes("wheat")) return "wheat";
  return normStr(cropType) || "unknown";
}

function sum(arr){
  let t = 0;
  for(const x of arr) t += (safeNum(x) ?? 0);
  return t;
}

function computeRemainingPartialFeet(partialFeetArr, takePartialCount){
  // Heuristic: takePartial consumes partial bags; we remove that many entries from the end.
  const feet = partialFeetArr.slice();
  let take = takePartialCount;
  while(take > 0 && feet.length > 0){
    feet.pop();
    take--;
  }
  return {
    remainingFeetArr: feet,
    remainingFeetSum: sum(feet)
  };
}

function rollupBy(items, keyFn){
  const map = new Map();
  for(const it of items){
    const k = keyFn(it);
    if(!map.has(k)){
      map.set(k, { key: k, items: [] });
    }
    map.get(k).items.push(it);
  }
  return map;
}

function computeBushels(capacityBu, remainingFull, remainingPartialFeetSum, bagSizeFeet){
  const cap = safeNum(capacityBu) ?? 0;
  const full = safeNum(remainingFull) ?? 0;
  const size = safeNum(bagSizeFeet) ?? 0;
  const partialFeet = safeNum(remainingPartialFeetSum) ?? 0;

  const bushelsFull = full * cap;
  const bushelsPartial = (size > 0) ? (partialFeet / size) * cap : 0;
  const bushelsTotal = bushelsFull + bushelsPartial;

  return {
    bushelsFull: Math.round(bushelsFull * 10) / 10,
    bushelsPartial: Math.round(bushelsPartial * 10) / 10,
    bushelsTotal: Math.round(bushelsTotal * 10) / 10
  };
}

/**
 * getGrainBagsReport(opts)
 *
 * opts (optional):
 *  - crop (string) filter (e.g. "corn", "soybeans")
 *  - farmId, fieldId filters (if you want later)
 *
 * Returns:
 *  {
 *    ok, intent,
 *    byCrop: [{ cropType, remainingFull, remainingPartialBags, remainingPartialFeet, bushelsFull, bushelsPartial, bushelsTotal }],
 *    byCounty: [...],
 *    byFarm: [...],
 *    putDowns: [...detailed rows...],
 *    note
 *  }
 */
export function getGrainBagsReport(opts = {}){
  const s = sqlite();

  const tEvents = firstExistingTable(s, ["grain_bag_events", "grainBagEvents", "grainbagevents"]);
  const tInv   = firstExistingTable(s, ["inventoryGrainBagMovements", "inventory_grain_bag_movements", "inventorygrainbagmovements"]);
  const tProd  = firstExistingTable(s, ["productsGrainBags", "products_grain_bags", "productsgrainbags"]);
  const tFields = firstExistingTable(s, ["fields", "farm_fields", "farmFields"]);

  if(!tEvents || !tInv || !tProd){
    return {
      ok: true,
      intent: "grainBagsReport",
      byCrop: [],
      byCounty: [],
      byFarm: [],
      putDowns: [],
      note: `Missing required tables. Need: grain_bag_events + inventoryGrainBagMovements + productsGrainBags. Found: events=${tEvents||"no"}, inv=${tInv||"no"}, prod=${tProd||"no"}`
    };
  }

  const capCols = pickCapacityCols(s);

  // --- Load products (capacity) ---
  const prodColsWanted = ["id","brand","diameterFt","lengthFt","bushels","bushelsCorn","bushelsSoy","bushelsSoybeans","bushelsBeans","bushelsBean","bushelsWheat","bushelsWh","status"];
  const prodCols = pickCols(s, tProd, prodColsWanted);
  const prodSelect = prodCols.length ? prodCols.map(c => `"${c}"`).join(", ") : "*";
  const prodRows = s.prepare(`SELECT ${prodSelect} FROM ${tProd}`).all() || [];

  const productById = new Map();
  const productByDim = new Map(); // brand|diam|len (fallback)
  for(const p of prodRows){
    const id = p.id || p.docId || null;
    if(!id) continue;
    p.id = id;

    productById.set(id, p);

    const brand = normLower(p.brand);
    const dia = safeNum(p.diameterFt) ?? null;
    const len = safeNum(p.lengthFt) ?? null;
    const key = `${brand}||${dia ?? ""}||${len ?? ""}`;
    productByDim.set(key, p);
  }

  function capacityForCrop(productRow, crop){
    if(!productRow) return 0;

    if(capCols.mode === "universal"){
      return safeNum(productRow[capCols.universal]) ?? 0;
    }

    const c = normLower(crop);
    if(c.includes("corn")) return safeNum(productRow[capCols.corn]) ?? 0;
    if(c.includes("soy") || c.includes("bean")) return safeNum(productRow[capCols.soy]) ?? 0;
    if(c.includes("wheat") && capCols.wheat) return safeNum(productRow[capCols.wheat]) ?? 0;

    // fallback: universal if exists
    if(capCols.universal) return safeNum(productRow[capCols.universal]) ?? 0;

    return safeNum(productRow[capCols.corn]) ?? 0;
  }

  // --- Load inventory bag movement rows to map inventorySkuId -> productId ---
  const invColsWanted = ["id","brand","diameterFt","lengthFt","productRef","productRefId","status"];
  const invCols = pickCols(s, tInv, invColsWanted);
  const invSelect = invCols.length ? invCols.map(c => `"${c}"`).join(", ") : "*";
  const invRows = s.prepare(`SELECT ${invSelect} FROM ${tInv}`).all() || [];

  const invToProductId = new Map();
  for(const r of invRows){
    const invId = r.id || r.docId || null;
    if(!invId) continue;
    r.id = invId;

    const prodId =
      parseFirestoreRefId(r.productRef) ||
      parseFirestoreRefId(asObj(r.productRef)) ||
      normStr(r.productRefId);

    if(prodId) invToProductId.set(invId, prodId);
  }

  // --- Load fields for farm/county linking (best-effort) ---
  const fieldMap = new Map();
  if(tFields){
    const wanted = ["id","name","farmId","farmName","county","countyName","state","stateCode","status"];
    const cols = pickCols(s, tFields, wanted);
    const select = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
    const rows = s.prepare(`SELECT ${select} FROM ${tFields}`).all() || [];
    for(const f of rows){
      const id = f.id || f.docId || null;
      if(!id) continue;
      f.id = id;
      fieldMap.set(id, f);
    }
  }

  function fieldInfo(fieldId){
    const f = fieldMap.get(fieldId);
    if(!f) return { farmName:"", farmId:"", county:"" };
    const county = normStr(f.countyName || f.county);
    return {
      farmId: normStr(f.farmId),
      farmName: normStr(f.farmName),
      county: county
    };
  }

  // --- Load grain bag events ---
  const evColsWanted = ["id","type","cropType","crop","cropYear","datePlaced","pickedUpDate","bagSku","counts","countsPicked","appliedTo","field","createdAtISO","updatedAtISO","createdAt","updatedAt"];
  const evCols = pickCols(s, tEvents, evColsWanted);
  const evSelect = evCols.length ? evCols.map(c => `"${c}"`).join(", ") : "*";
  const evRows = s.prepare(`SELECT ${evSelect} FROM ${tEvents}`).all() || [];

  const putDowns = [];
  const pickUps = [];

  for(const r of evRows){
    const id = r.id || r.docId || null;
    if(!id) continue;
    r.id = id;

    const type = normLower(r.type);
    if(type === "putdown" || type === "put down" || type === "put_down"){
      putDowns.push(r);
    }else if(type === "pickup" || type === "pick up" || type === "pick_up"){
      pickUps.push(r);
    }
  }

  // --- Index pickups by refPutDownId ---
  const takenByPutDown = new Map(); // putDownId -> { takeFull, takePartial }
  for(const p of pickUps){
    const applied = asArray(p.appliedTo);
    for(const a of applied){
      const ref = normStr(a.refPutDownId);
      if(!ref) continue;
      const takeFull = safeNum(a.takeFull) ?? 0;
      const takePartial = safeNum(a.takePartial) ?? 0;
      if(!takenByPutDown.has(ref)) takenByPutDown.set(ref, { takeFull: 0, takePartial: 0 });
      const agg = takenByPutDown.get(ref);
      agg.takeFull += takeFull;
      agg.takePartial += takePartial;
    }
  }

  const wantCrop = normLower(opts.crop);

  // --- Build detailed putDown rows with capacity + remaining ---
  const details = [];

  for(const pd of putDowns){
    const pdId = pd.id;

    const cropType = normStr(pd.cropType || pd.crop);
    if(wantCrop){
      if(!normLower(cropType).includes(wantCrop) && !normLower(cropKey(cropType)).includes(wantCrop)) continue;
    }

    const bagSku = asObj(pd.bagSku) || {};
    const invSkuId = normStr(bagSku.id); // inventoryGrainBagMovements doc id
    const dia = safeNum(bagSku.diameterFt);
    const len = safeNum(bagSku.sizeFeet);
    const brand = normStr(bagSku.brand);

    // product id via inventory -> productRef
    const productId = invToProductId.get(invSkuId) || "";
    let product = productId ? productById.get(productId) : null;

    // fallback by dimensions + brand if needed
    if(!product){
      const key = `${normLower(brand)}||${dia ?? ""}||${len ?? ""}`;
      product = productByDim.get(key) || null;
    }

    const capacityBu = capacityForCrop(product, cropType);

    const counts = asObj(pd.counts) || {};
    const fullPut = safeNum(counts.full) ?? 0;
    const partialPut = safeNum(counts.partial) ?? 0;
    const partialFeetArr = asArray(counts.partialFeet).map(x => safeNum(x) ?? 0);

    const taken = takenByPutDown.get(pdId) || { takeFull: 0, takePartial: 0 };

    const remainingFull = Math.max(0, fullPut - (taken.takeFull || 0));
    const remainingPartialBags = Math.max(0, partialPut - (taken.takePartial || 0));

    // remaining partial feet: remove as many partials as takenPartial, then sum
    const { remainingFeetArr, remainingFeetSum } = computeRemainingPartialFeet(partialFeetArr, taken.takePartial || 0);

    const bus = computeBushels(capacityBu, remainingFull, remainingFeetSum, len);

    const fieldObj = asObj(pd.field) || {};
    const fieldId = normStr(fieldObj.id);
    const fieldName = normStr(fieldObj.name);

    const fi = fieldInfo(fieldId);

    details.push({
      putDownId: pdId,
      cropType: cropType || "Unknown",
      cropKey: cropKey(cropType),
      cropYear: safeNum(pd.cropYear) ?? null,
      datePlaced: normStr(pd.datePlaced),
      bag: {
        inventorySkuId: invSkuId,
        productId: productId || (product ? product.id : ""),
        brand: brand,
        diameterFt: dia,
        lengthFt: len,
        capacityBu: capacityBu
      },
      location: {
        county: fi.county,
        farmId: fi.farmId,
        farmName: fi.farmName,
        fieldId,
        fieldName
      },
      remaining: {
        full: remainingFull,
        partialBags: remainingPartialBags,
        partialFeetSum: remainingFeetSum
      },
      bushels: bus
    });
  }

  // Rollups by crop
  const byCropMap = new Map();
  for(const d of details){
    const k = d.cropKey;
    if(!byCropMap.has(k)){
      byCropMap.set(k, {
        cropType: d.cropType,
        cropKey: k,
        remainingFull: 0,
        remainingPartialBags: 0,
        remainingPartialFeet: 0,
        bushelsFull: 0,
        bushelsPartial: 0,
        bushelsTotal: 0
      });
    }
    const o = byCropMap.get(k);
    o.remainingFull += d.remaining.full;
    o.remainingPartialBags += d.remaining.partialBags;
    o.remainingPartialFeet += d.remaining.partialFeetSum;
    o.bushelsFull += d.bushels.bushelsFull;
    o.bushelsPartial += d.bushels.bushelsPartial;
    o.bushelsTotal += d.bushels.bushelsTotal;
  }

  const byCrop = Array.from(byCropMap.values())
    .map(x => ({
      ...x,
      bushelsFull: Math.round(x.bushelsFull * 10) / 10,
      bushelsPartial: Math.round(x.bushelsPartial * 10) / 10,
      bushelsTotal: Math.round(x.bushelsTotal * 10) / 10
    }))
    .sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.cropKey.localeCompare(b.cropKey));

  // Rollups by county and by farm
  const byCountyMap = new Map();
  const byFarmMap = new Map();

  for(const d of details){
    const county = normStr(d.location.county) || "(Unknown county)";
    const farmName = normStr(d.location.farmName) || "(Unknown farm)";
    const farmId = normStr(d.location.farmId);

    const cKey = county.toLowerCase();
    if(!byCountyMap.has(cKey)){
      byCountyMap.set(cKey, { county, bushelsTotal: 0, byCrop: new Map() });
    }
    const c = byCountyMap.get(cKey);
    c.bushelsTotal += d.bushels.bushelsTotal;
    c.byCrop.set(d.cropKey, (c.byCrop.get(d.cropKey) || 0) + d.bushels.bushelsTotal);

    const fKey = `${farmId}||${farmName}`.toLowerCase();
    if(!byFarmMap.has(fKey)){
      byFarmMap.set(fKey, { farmId, farmName, county, bushelsTotal: 0, byCrop: new Map() });
    }
    const f = byFarmMap.get(fKey);
    f.bushelsTotal += d.bushels.bushelsTotal;
    f.byCrop.set(d.cropKey, (f.byCrop.get(d.cropKey) || 0) + d.bushels.bushelsTotal);
  }

  const byCounty = Array.from(byCountyMap.values()).map(c => ({
    county: c.county,
    bushelsTotal: Math.round(c.bushelsTotal * 10) / 10,
    byCrop: Array.from(c.byCrop.entries())
      .map(([cropKey, bushelsTotal]) => ({ cropKey, bushelsTotal: Math.round(bushelsTotal * 10) / 10 }))
      .sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.cropKey.localeCompare(b.cropKey))
  })).sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.county.localeCompare(b.county));

  const byFarm = Array.from(byFarmMap.values()).map(f => ({
    farmId: f.farmId,
    farmName: f.farmName,
    county: f.county,
    bushelsTotal: Math.round(f.bushelsTotal * 10) / 10,
    byCrop: Array.from(f.byCrop.entries())
      .map(([cropKey, bushelsTotal]) => ({ cropKey, bushelsTotal: Math.round(bushelsTotal * 10) / 10 }))
      .sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.cropKey.localeCompare(b.cropKey))
  })).sort((a,b) => b.bushelsTotal - a.bushelsTotal || a.farmName.localeCompare(b.farmName));

  return {
    ok: true,
    intent: "grainBagsReport",
    note: "Bushels computed from putDown - pickUp and capacity resolved via inventoryGrainBagMovements.productRef -> productsGrainBags.",
    byCrop,
    byCounty,
    byFarm,
    putDowns: details
  };
}
