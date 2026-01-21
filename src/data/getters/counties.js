// /src/data/getters/counties.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-counties-reports
//
// County reporting from fields (truth):
// - getCountySummary()                     => how many counties + per-county fieldCount/tillable
// - getCountyStatsByKey(countyKey)         => HEL/CRP/tillable + counts for a specific county
// - getFieldsInCounty(countyKey)           => list fields in a county (with farm + acres + HEL/CRP)
// - getFarmsInCounty(countyKey)            => list farms that have fields in a county (with counts)
//
// Tables used:
// - fields (county/state/acresTillable/hasHEL/helAcres/hasCRP/crpAcres/farmId/farmName)
// - farms  (name)

import { db } from "../sqlite.js";

function norm(s) {
  return (s ?? "").toString().trim();
}

function requireKey(key, label) {
  const k = norm(key);
  if (!k) throw new Error(`Missing ${label}`);
  return k;
}

export function getCountySummary() {
  const sqlite = db();

  const rows = sqlite.prepare(`
    SELECT
      county,
      COALESCE(state, '') AS state,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(acresTillable, 0)), 2) AS tillableAcres
    FROM fields
    WHERE county IS NOT NULL AND TRIM(county) <> ''
    GROUP BY county, state
    ORDER BY lower(county) ASC
  `).all();

  const counties = rows
    .map(r => ({
      county: norm(r.county),
      state: norm(r.state),
      fieldCount: Number(r.fieldCount || 0),
      tillableAcres: Number(r.tillableAcres || 0)
    }))
    .filter(x => x.county);

  return { count: counties.length, counties };
}

export function getCountyStatsByKey(countyKey) {
  const k = requireKey(countyKey, "county");
  const sqlite = db();

  // Resolve county by "contains" match (case-insensitive) so user can say "macoup" etc.
  // Pick the best match with most fields.
  const best = sqlite.prepare(`
    SELECT county, COALESCE(state,'') AS state, COUNT(1) AS n
    FROM fields
    WHERE county IS NOT NULL AND TRIM(county) <> '' AND lower(county) LIKE lower(?)
    GROUP BY county, state
    ORDER BY n DESC
    LIMIT 1
  `).get(`%${k}%`);

  if (!best) throw new Error(`County not found: ${k}`);

  const stats = sqlite.prepare(`
    SELECT
      county,
      COALESCE(state,'') AS state,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(acresTillable, 0)), 2) AS tillableAcres,

      SUM(CASE WHEN COALESCE(hasHEL,0) = 1 THEN 1 ELSE 0 END) AS helFieldCount,
      ROUND(SUM(COALESCE(helAcres, 0)), 2) AS helAcres,

      SUM(CASE WHEN COALESCE(hasCRP,0) = 1 THEN 1 ELSE 0 END) AS crpFieldCount,
      ROUND(SUM(COALESCE(crpAcres, 0)), 2) AS crpAcres
    FROM fields
    WHERE county = ? AND COALESCE(state,'') = ?
  `).get(best.county, best.state);

  return {
    county: norm(stats.county),
    state: norm(stats.state),
    fieldCount: Number(stats.fieldCount || 0),
    tillableAcres: Number(stats.tillableAcres || 0),
    helFieldCount: Number(stats.helFieldCount || 0),
    helAcres: Number(stats.helAcres || 0),
    crpFieldCount: Number(stats.crpFieldCount || 0),
    crpAcres: Number(stats.crpAcres || 0)
  };
}

export function getFieldsInCounty(countyKey) {
  const k = requireKey(countyKey, "county");
  const sqlite = db();

  const best = sqlite.prepare(`
    SELECT county, COALESCE(state,'') AS state, COUNT(1) AS n
    FROM fields
    WHERE county IS NOT NULL AND TRIM(county) <> '' AND lower(county) LIKE lower(?)
    GROUP BY county, state
    ORDER BY n DESC
    LIMIT 1
  `).get(`%${k}%`);

  if (!best) throw new Error(`County not found: ${k}`);

  const fields = sqlite.prepare(`
    SELECT
      f.id AS fieldId,
      f.name AS fieldName,
      COALESCE(NULLIF(f.farmName,''), fm.name) AS farmName,
      f.county AS county,
      COALESCE(f.state,'') AS state,
      f.acresTillable AS acresTillable,
      COALESCE(f.hasHEL,0) AS hasHEL,
      COALESCE(f.helAcres,0) AS helAcres,
      COALESCE(f.hasCRP,0) AS hasCRP,
      COALESCE(f.crpAcres,0) AS crpAcres
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.county = ? AND COALESCE(f.state,'') = ?
    ORDER BY lower(f.name) ASC
  `).all(best.county, best.state);

  return {
    county: norm(best.county),
    state: norm(best.state),
    fieldCount: fields.length,
    fields: fields.map(r => ({
      fieldId: r.fieldId,
      fieldName: norm(r.fieldName) || "(Unnamed)",
      farmName: norm(r.farmName) || "",
      acresTillable: (r.acresTillable === null || r.acresTillable === undefined) ? "" : r.acresTillable,
      hasHEL: Number(r.hasHEL || 0) === 1,
      helAcres: Number(r.helAcres || 0),
      hasCRP: Number(r.hasCRP || 0) === 1,
      crpAcres: Number(r.crpAcres || 0)
    }))
  };
}

export function getFarmsInCounty(countyKey) {
  const k = requireKey(countyKey, "county");
  const sqlite = db();

  const best = sqlite.prepare(`
    SELECT county, COALESCE(state,'') AS state, COUNT(1) AS n
    FROM fields
    WHERE county IS NOT NULL AND TRIM(county) <> '' AND lower(county) LIKE lower(?)
    GROUP BY county, state
    ORDER BY n DESC
    LIMIT 1
  `).get(`%${k}%`);

  if (!best) throw new Error(`County not found: ${k}`);

  const rows = sqlite.prepare(`
    SELECT
      COALESCE(NULLIF(f.farmName,''), fm.name, '(Unnamed)') AS farmName,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(f.acresTillable,0)), 2) AS tillableAcres
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.county = ? AND COALESCE(f.state,'') = ?
    GROUP BY farmName
    ORDER BY lower(farmName) ASC
  `).all(best.county, best.state);

  return {
    county: norm(best.county),
    state: norm(best.state),
    farmCount: rows.length,
    farms: rows.map(r => ({
      farmName: norm(r.farmName) || "(Unnamed)",
      fieldCount: Number(r.fieldCount || 0),
      tillableAcres: Number(r.tillableAcres || 0)
    }))
  };
}
