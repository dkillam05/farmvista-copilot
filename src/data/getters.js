// /src/data/getters.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-real-schema
//
// Uses your ACTUAL snapshot schema:
// tables: fields, farms, rtkTowers, productsGrainBags
// view:   v_grainBag_open_remaining
//
// Guarantees:
// - Field "full" includes farm + RTK network/frequency when available.
// - Grain "bags down now" uses v_grainBag_open_remaining (putDown-adjusted truth)
//   and computes bushels (full + partial feet fraction).

import { db } from "./sqlite.js";

function normKey(x) {
  return (x ?? "").toString().trim();
}

export function getFieldFullByKey(key) {
  const k = normKey(key);
  if (!k) throw new Error("Missing field key");

  const sqlite = db();

  // Try exact id first, then name contains.
  // Fields table already carries farmName/rtkTowerName, but we also join to pull tower network/frequency.
  const row =
    sqlite
      .prepare(
        `
        SELECT
          f.id            AS fieldId,
          f.name          AS fieldName,
          f.county        AS county,
          f.state         AS state,
          f.acresTillable AS acresTillable,

          f.hasHEL        AS hasHEL,
          f.helAcres      AS helAcres,
          f.hasCRP        AS hasCRP,
          f.crpAcres      AS crpAcres,

          f.farmId        AS farmId,
          COALESCE(f.farmName, fm.name) AS farmName,

          f.rtkTowerId    AS rtkTowerId,
          COALESCE(f.rtkTowerName, rt.name) AS rtkTowerName,
          rt.networkId    AS rtkNetworkId,
          rt.frequency    AS rtkFrequency

        FROM fields f
        LEFT JOIN farms fm     ON fm.id = f.farmId
        LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
        WHERE f.id = ?
        LIMIT 1
      `
      )
      .get(k);

  if (row) return row;

  const row2 =
    sqlite
      .prepare(
        `
        SELECT
          f.id            AS fieldId,
          f.name          AS fieldName,
          f.county        AS county,
          f.state         AS state,
          f.acresTillable AS acresTillable,

          f.hasHEL        AS hasHEL,
          f.helAcres      AS helAcres,
          f.hasCRP        AS hasCRP,
          f.crpAcres      AS crpAcres,

          f.farmId        AS farmId,
          COALESCE(f.farmName, fm.name) AS farmName,

          f.rtkTowerId    AS rtkTowerId,
          COALESCE(f.rtkTowerName, rt.name) AS rtkTowerName,
          rt.networkId    AS rtkNetworkId,
          rt.frequency    AS rtkFrequency

        FROM fields f
        LEFT JOIN farms fm     ON fm.id = f.farmId
        LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
        WHERE lower(f.name) LIKE lower(?)
        ORDER BY f.archived ASC, f.name ASC
        LIMIT 1
      `
      )
      .get(`%${k}%`);

  if (!row2) throw new Error(`Field not found: ${k}`);
  return row2;
}

export function getGrainBagsDownSummary() {
  const sqlite = db();

  // Capacity per bag is derived from productsGrainBags using diameter+length
  // (this matches how your system stores product capacities).
  //
  // Bushels logic:
  // - Full: remainingFull * bagCapacity
  // - Partial: (remainingPartialFeetSum / bagSizeFeet) * bagCapacity
  //
  // Crop capacity selection:
  // - corn  -> bushelsCorn
  // - soy   -> bushelsSoy
  // - wheat -> bushelsWheat
  //
  // If a matching product row isn't found, capacity falls back to 0 (we still return counts).

  const rows = sqlite.prepare(`
    WITH cap AS (
      SELECT
        p.id,
        p.brand,
        p.diameterFt,
        p.lengthFt,
        p.bushelsCorn,
        p.bushelsSoy,
        p.bushelsWheat
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
          WHEN lower(open.cropType) LIKE '%wheat%' THEN COALESCE(cap.bushelsWheat, 0)
          ELSE COALESCE(cap.bushelsCorn, 0)
        END AS bagCapacityBu
      FROM open
      LEFT JOIN cap
        ON cap.diameterFt = open.bagDiameterFt
       AND cap.lengthFt   = open.bagSizeFeet
       AND (cap.brand IS NULL OR open.bagBrand IS NULL OR lower(cap.brand)=lower(open.bagBrand))
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
  `).all();

  return rows;
}
