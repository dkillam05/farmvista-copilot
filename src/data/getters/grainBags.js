// /src/data/getters/grainBags.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-grainbags
//
// Uses canonical truth view: v_grainBag_open_remaining
// Uses productsGrainBags for capacities (if join matches)

import { db } from '../sqlite.js';

export function getGrainBagsDownSummary() {
  const sqlite = db();

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
