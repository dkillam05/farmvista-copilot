// /src/data/getters/grainBags.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-grainbags-soycol-autodetect
//
// Fix:
// - Soybeans were returning 0 bushels even with non-zero counts.
// - Root cause is typically a schema mismatch: productsGrainBags soy capacity column name differs.
// - This version auto-detects the soy capacity column from PRAGMA table_info(productsGrainBags)
//   and uses it in the SQL.
// - Also relaxes brand matching so capacity join doesn't silently fail on soy bags.
//
// Truth source remains: v_grainBag_open_remaining

import { db } from "../sqlite.js";

function pickCapacityCols(sqlite) {
  const cols = sqlite.prepare(`PRAGMA table_info(productsGrainBags)`).all().map(r => r.name);

  const has = (c) => cols.includes(c);

  // Corn is usually stable
  const corn = has("bushelsCorn") ? "bushelsCorn" : null;

  // Soy is commonly named a few ways
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

  if (!corn) {
    throw new Error("productsGrainBags is missing bushelsCorn (required for v2)");
  }
  if (!soy) {
    // We can still run, but soy will be 0; better to fail loudly so you fix schema once.
    throw new Error("productsGrainBags has no recognized soy capacity column (expected bushelsSoy or bushelsSoybeans etc.)");
  }
  // wheat is optional

  return { corn, soy, wheat };
}

export function getGrainBagsDownSummary() {
  const sqlite = db();
  const { corn, soy, wheat } = pickCapacityCols(sqlite);

  // Build SQL with chosen column names (safe because they come from PRAGMA)
  const wheatExpr = wheat ? `COALESCE(cap.${wheat}, 0)` : `0`;

  const sql = `
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
          WHEN lower(open.cropType) LIKE '%wheat%' THEN ${wheat ? "COALESCE(cap.bushelsWheat, 0)" : "0"}
          ELSE COALESCE(cap.bushelsCorn, 0)
        END AS bagCapacityBu

      FROM open
      LEFT JOIN cap
        ON cap.diameterFt = open.bagDiameterFt
       AND cap.lengthFt   = open.bagSizeFeet
       -- Brand matching is optional; do not fail join just because brand differs/missing.
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
