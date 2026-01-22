// /src/data/getters/grainBags.js  (FULL FILE)
// Rev: 2026-01-22-v5-grainbags-report-from-events-productlink-county-rollups
//
// Goals:
// - Do NOT depend on v_grainBag_open_remaining (may not exist in snapshot)
// - Compute remaining from grain_bag_events: putDown minus pickUp.appliedTo
// - Link bagSku -> inventoryGrainBagMovements -> productsGrainBags for capacity
// - Link fieldId -> fields -> farms -> county for rollups
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Grain bag "out in fields" means remainingFull>0 OR remainingPartial>0 OR remainingPartialFeetSum>0
// - includeArchived not used here (events are not “archived”), but kept for signature compatibility.

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
  return "Other";
}

function parseProductRef(ref){
  // Firefoo: { "__ref__": "productsGrainBags/OvJJ..." } OR string "productsGrainBags/OvJJ..."
  const o = asObj(ref);
  const s = o?.__ref__ ? String(o.__ref__) : (typeof ref === "string" ? ref : "");
  const parts = s.split("/");
  return parts.length === 2 ? parts[1] : "";
}

/* ----------------------------- capacity ----------------------------- */
function pickCapacityColumns(sqlite, tableProducts){
  // We support:
  // - bushels (your Firefoo example)
  // - bushelsCorn/bushelsSoy/etc (older schema)
  const cols = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(tableProducts)})`).all().map(r => r.name);

  const has = (c) => cols.includes(c);

  return {
    any: has("bushels") ? "bushels" : null,
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

  // Prefer generic bushels if present (your current Firefoo has it)
  if(capCols.any && productRow[capCols.any] != null){
    return safeNum(productRow[capCols.any]);
  }

  if(cropTypeNorm === "Corn" && capCols.corn) return safeNum(productRow[capCols.corn]);
  if(cropTypeNorm === "Soybeans" && capCols.soy) return safeNum(productRow[capCols.soy]);
  if(cropTypeNorm === "Wheat" && capCols.wheat) return safeNum(productRow[capCols.wheat]);

  // fallback: corn if present
  if(capCols.corn) return safeNum(productRow[capCols.corn]);

  return null;
}

/* ----------------------------- public: down summary ----------------------------- */
/**
 * Backwards-compatible "bags down" summary.
 * If the old view exists, we still use it.
 * Otherwise we compute from events using getGrainBagsReport() and return crop totals.
 */
export function getGrainBagsDownSummary(){
  const sqlite = getDb();

  // If legacy view exists, keep it (fast path)
  if(hasTable(sqlite, "v_grainBag_open_remaining") && hasTable(sqlite, "productsGrainBags")){
    // Keep your v2 logic but tolerate "bushels" column
    const capCols = pickCapacityColumns(sqlite, "productsGrainBags");
    const anyCol = capCols.any ? `p.${capCols.any} AS bushelsAny` : `NULL AS bushelsAny`;
    const cornCol = capCols.corn ? `p.${capCols.corn} AS bushelsCorn` : `NULL AS bushelsCorn`;
    const soyCol  = capCols.soy  ? `p.${capCols.soy}  AS bushelsSoy`  : `NULL AS bushelsSoy`;
    const wheatCol= capCols.wheat? `p.${capCols.wheat} AS bushelsWheat`: `NULL AS bushelsWheat`;

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
          COALESCE(cap.bushelsAny, cap.bushelsCorn, cap.bushelsSoy, cap.bushelsWheat, 0) AS bagCapacityBu
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
    return sqlite.prepare(sql).all();
  }

  // Otherwise compute from the new report
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
/**
 * getGrainBagsReport(opts)
 * opts:
 *  - crop (optional): "corn" | "soybeans" | "wheat" | "" (all)
 */
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

  // Field lookup (best-effort)
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
    const wantedProd = pickCols(sqlite, tProd, ["id","brand","diameterFt","lengthFt","status", ...(capCols.any?[capCols.any]:[]), ...(capCols.corn?[capCols.corn]:[]), ...(capCols.soy?[capCols.soy]:[]), ...(capCols.wheat?[capCols.wheat]:[]) ]);
    const sel = wantedProd.length ? wantedProd.map(c => `"${c}"`).join(", ") : "*";
    const rows = sqlite.prepare(`SELECT ${sel} FROM "${tProd}"`).all() || [];
    for(const r of rows){
      const id = r.id || r.docId || null;
      if(!id) continue;
      r.id = id;
      productById.set(id, r);
    }
  }

  // bagSkuId -> productId map
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
    "id",
    "type",
    "cropType",
    "crop",
    "cropYear",
    "datePlaced",
    "pickedUpDate",
    "createdAtISO",
    "updatedAtISO",
    "createdAt",
    "updatedAt",
    "bagSku",
    "counts",
    "countsPicked",
    "appliedTo",
    "field",
    "notes"
  ]);
  const selEv = wantedEv.length ? wantedEv.map(c => `"${c}"`).join(", ") : "*";
  const rows = sqlite.prepare(`SELECT ${selEv} FROM "${tEvents}"`).all() || [];

  const putDowns = [];
  const pickUps = [];

  for(const r of rows){
    const id = r.id || r.docId || null;
    if(!id) continue;

    const type = normLower(r.type);
    if(type === "putdown" || type === "putDown".toLowerCase()){
      putDowns.push({ id, raw: r });
    }else if(type === "pickup" || type === "pickUp".toLowerCase()){
      pickUps.push({ id, raw: r });
    }
  }

  // ----- index pickUps by refPutDownId -----
  const pickedByPutDown = new Map();
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

    const counts = asObj(raw.counts) || {};
    const full = safeNum(counts.full) ?? 0;
    const partial = safeNum(counts.partial) ?? 0;
    const partialFeetArr = asArray(counts.partialFeet).map(safeNum).filter(n => n != null);
    const partialFeetSum = partialFeetArr.reduce((s,n)=>s+n,0);

    // subtract pickUps
    const picks = pickedByPutDown.get(pd.id) || [];
    const takeFull = picks.reduce((s,x)=>s+(safeNum(x.takeFull) ?? 0),0);
    const takePartial = picks.reduce((s,x)=>s+(safeNum(x.takePartial) ?? 0),0);

    const remainingFull = Math.max(0, full - takeFull);
    const remainingPartial = Math.max(0, partial - takePartial);

    // if we have explicit partialFeet, use it; otherwise assume each partial is a full-length partial bag
    const bagSkuObj = asObj(raw.bagSku) || {};
    const bagSizeFeet = safeNum(bagSkuObj.sizeFeet) ?? safeNum(bagSkuObj.bagSizeFeet) ?? null;

    let remainingPartialFeetSum = partialFeetSum;
    if(remainingPartialFeetSum === 0 && remainingPartial > 0 && bagSizeFeet != null){
      remainingPartialFeetSum = remainingPartial * bagSizeFeet;
    }

    // Determine if "out"
    const isOut = (remainingFull > 0) || (remainingPartial > 0) || (remainingPartialFeetSum > 0);

    // Resolve field/farm/county
    const fieldObj = asObj(raw.field) || {};
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

    // Resolve capacity
    let capacityBu = null;
    let capacitySource = "";

    const bagSkuId = normStr(bagSkuObj.id);
    const productId = bagSkuId ? (bagSkuToProductId.get(bagSkuId) || "") : "";
    const product = productId ? productById.get(productId) : null;

    if(product && capCols){
      capacityBu = capacityForCrop(product, crop, capCols);
      capacitySource = productId ? `productsGrainBags/${productId}` : "";
    }

    // Fallback: match by diameter+length+brand if productId missing
    if(capacityBu == null && tProd && capCols){
      const diam = safeNum(bagSkuObj.diameterFt);
      const len = safeNum(bagSkuObj.sizeFeet);
      const brand = normLower(bagSkuObj.brand);
      if(diam != null && len != null){
        for(const p of productById.values()){
          const pd = safeNum(p.diameterFt);
          const pl = safeNum(p.lengthFt);
          const pb = normLower(p.brand);
          if(pd === diam && pl === len && (!brand || !pb || brand === pb)){
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
      bagBrand: normStr(bagSkuObj.brand),
      bagDiameterFt: safeNum(bagSkuObj.diameterFt) ?? null,
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

  // Only “out in fields” by default
  const outItems = items.filter(x => x.isOut);

  // ----- totals by crop -----
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

  // ----- rollups by county -----
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

  // ----- rollups by farm -----
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

  // Sort putDowns by remaining bushels (most important operationally)
  outItems.sort((a,b) => (b.bushelsTotal - a.bushelsTotal) || (b.remainingFull - a.remainingFull));

  return {
    ok: true,
    intent: "grainBagsReport",
    tableUsed: tEvents,
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