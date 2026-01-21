// /src/data/getters/counties.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-counties
//
// Source of truth: fields.county (and fields.state if present)
// Answers: how many counties we farm in + list/count by county

import { db } from "../sqlite.js";

function norm(s) {
  return (s ?? "").toString().trim();
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

  const counties = rows.map(r => ({
    county: norm(r.county),
    state: norm(r.state),
    fieldCount: Number(r.fieldCount || 0),
    tillableAcres: (r.tillableAcres === null || r.tillableAcres === undefined) ? 0 : Number(r.tillableAcres)
  })).filter(x => x.county);

  return {
    count: counties.length,
    counties
  };
}
