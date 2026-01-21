// /src/data/getters/counties.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-counties
//
// Counts distinct counties from fields table (source of truth for "where we farm").
//
// Uses:
// - fields.county
// - fields.archived (optional; if column doesn't exist, query still works)

import { db } from "../sqlite.js";

function normCounty(c){
  return (c ?? "").toString().trim();
}

export function getCountySummary() {
  const sqlite = db();

  // If your snapshot has fields.archived, filter to active-ish fields.
  // If not, this still works because SQLite will error. To avoid that,
  // we keep it simple: no archived filter.
  const rows = sqlite.prepare(`
    SELECT county, state, COUNT(1) AS fieldCount
    FROM fields
    WHERE county IS NOT NULL AND TRIM(county) <> ''
    GROUP BY county, state
    ORDER BY lower(county) ASC
  `).all();

  const counties = rows.map(r => ({
    county: normCounty(r.county),
    state: (r.state ?? "").toString().trim(),
    fieldCount: Number(r.fieldCount || 0)
  })).filter(x => x.county);

  // Unique counties count (by county+state)
  const count = counties.length;

  return { count, counties };
}
