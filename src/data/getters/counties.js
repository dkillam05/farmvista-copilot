// /src/data/getters/counties.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-counties-active-default-archived-separate
//
// Default behavior: ACTIVE ONLY.
// If includeArchived=true, we return active + archived sections separately.
// Counties with zero active fields never appear in normal results.

import { db } from "../sqlite.js";

function norm(s) { return (s ?? "").toString().trim(); }

function hasColumn(sqlite, table, col) {
  try {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === col);
  } catch {
    return false;
  }
}

function activeWhere(sqlite, alias, includeArchived) {
  if (includeArchived) return "";
  // If archived column exists, filter to active
  if (hasColumn(sqlite, "fields", "archived")) {
    return ` AND COALESCE(${alias}.archived,0)=0 `;
  }
  return "";
}

function archivedWhere(sqlite, alias) {
  if (hasColumn(sqlite, "fields", "archived")) {
    return ` AND COALESCE(${alias}.archived,0)=1 `;
  }
  // If no archived column, there is no concept of archived
  return " AND 1=0 ";
}

export function getCountySummary(opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const sqlite = db();

  const act = sqlite.prepare(`
    SELECT
      f.county AS county,
      COALESCE(f.state,'') AS state,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(f.acresTillable, 0)), 2) AS tillableAcres
    FROM fields f
    WHERE f.county IS NOT NULL AND TRIM(f.county) <> ''
    ${activeWhere(sqlite, "f", false)}
    GROUP BY f.county, state
    HAVING COUNT(1) > 0
    ORDER BY lower(f.county) ASC
  `).all();

  const active = act.map(r => ({
    county: norm(r.county),
    state: norm(r.state),
    fieldCount: Number(r.fieldCount || 0),
    tillableAcres: Number(r.tillableAcres || 0)
  })).filter(x => x.county);

  if (!includeArchived) return { active };

  // Archived-only counties = counties that appear in archived fields but not in active fields
  const arch = sqlite.prepare(`
    SELECT
      f.county AS county,
      COALESCE(f.state,'') AS state,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(f.acresTillable, 0)), 2) AS tillableAcres
    FROM fields f
    WHERE f.county IS NOT NULL AND TRIM(f.county) <> ''
    ${archivedWhere(sqlite, "f")}
    GROUP BY f.county, state
    HAVING COUNT(1) > 0
    ORDER BY lower(f.county) ASC
  `).all();

  const activeSet = new Set(active.map(x => `${x.county}|${x.state}`));
  const archivedOnly = arch
    .map(r => ({
      county: norm(r.county),
      state: norm(r.state),
      fieldCount: Number(r.fieldCount || 0),
      tillableAcres: Number(r.tillableAcres || 0)
    }))
    .filter(x => x.county && !activeSet.has(`${x.county}|${x.state}`));

  return { active, archivedOnly };
}

export function getCountyStatsByKey(countyKey, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const sqlite = db();
  const key = norm(countyKey);
  if (!key) throw new Error("Missing county");

  function bestCounty(whereExtra) {
    return sqlite.prepare(`
      SELECT f.county AS county, COALESCE(f.state,'') AS state, COUNT(1) AS n
      FROM fields f
      WHERE f.county IS NOT NULL AND TRIM(f.county) <> '' AND lower(f.county) LIKE lower(?)
      ${whereExtra}
      GROUP BY f.county, state
      ORDER BY n DESC
      LIMIT 1
    `).get(`%${key}%`);
  }

  const bestActive = bestCounty(activeWhere(sqlite, "f", false));
  if (!bestActive && !includeArchived) throw new Error(`County not found (active): ${key}`);

  const best = bestActive || bestCounty(""); // any if includeArchived=true

  const compute = (whereExtra) => sqlite.prepare(`
    SELECT
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(f.acresTillable,0)), 2) AS tillableAcres,
      SUM(CASE WHEN COALESCE(f.hasHEL,0)=1 THEN 1 ELSE 0 END) AS helFieldCount,
      ROUND(SUM(COALESCE(f.helAcres,0)), 2) AS helAcres,
      SUM(CASE WHEN COALESCE(f.hasCRP,0)=1 THEN 1 ELSE 0 END) AS crpFieldCount,
      ROUND(SUM(COALESCE(f.crpAcres,0)), 2) AS crpAcres
    FROM fields f
    WHERE f.county = ? AND COALESCE(f.state,'') = ?
    ${whereExtra}
  `).get(best.county, best.state);

  const active = compute(activeWhere(sqlite, "f", false));
  if (!includeArchived) {
    return { county: norm(best.county), state: norm(best.state), active };
  }

  const archived = compute(archivedWhere(sqlite, "f"));
  return { county: norm(best.county), state: norm(best.state), active, archived };
}

export function getFieldsInCounty(countyKey, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const sqlite = db();
  const key = norm(countyKey);
  if (!key) throw new Error("Missing county");

  const best = sqlite.prepare(`
    SELECT f.county AS county, COALESCE(f.state,'') AS state, COUNT(1) AS n
    FROM fields f
    WHERE f.county IS NOT NULL AND TRIM(f.county) <> '' AND lower(f.county) LIKE lower(?)
    GROUP BY f.county, state
    ORDER BY n DESC
    LIMIT 1
  `).get(`%${key}%`);

  if (!best) throw new Error(`County not found: ${key}`);

  const fetchFields = (whereExtra) => sqlite.prepare(`
    SELECT
      f.id AS fieldId,
      f.name AS fieldName,
      COALESCE(NULLIF(f.farmName,''), fm.name) AS farmName,
      f.acresTillable AS acresTillable,
      COALESCE(f.hasHEL,0) AS hasHEL,
      COALESCE(f.helAcres,0) AS helAcres,
      COALESCE(f.hasCRP,0) AS hasCRP,
      COALESCE(f.crpAcres,0) AS crpAcres,
      ${hasColumn(sqlite,"fields","archived") ? "COALESCE(f.archived,0) AS archived" : "0 AS archived"}
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.county = ? AND COALESCE(f.state,'') = ?
    ${whereExtra}
    ORDER BY lower(f.name) ASC
  `).all(best.county, best.state);

  const active = fetchFields(activeWhere(sqlite, "f", false)).map(r => ({
    fieldId: r.fieldId,
    fieldName: norm(r.fieldName) || "(Unnamed)",
    farmName: norm(r.farmName) || "",
    acresTillable: r.acresTillable ?? "",
    hasHEL: Number(r.hasHEL || 0) === 1,
    helAcres: Number(r.helAcres || 0),
    hasCRP: Number(r.hasCRP || 0) === 1,
    crpAcres: Number(r.crpAcres || 0)
  }));

  if (!includeArchived) return { county: norm(best.county), state: norm(best.state), active };

  const archived = fetchFields(archivedWhere(sqlite, "f")).map(r => ({
    fieldId: r.fieldId,
    fieldName: norm(r.fieldName) || "(Unnamed)",
    farmName: norm(r.farmName) || "",
    acresTillable: r.acresTillable ?? "",
    hasHEL: Number(r.hasHEL || 0) === 1,
    helAcres: Number(r.helAcres || 0),
    hasCRP: Number(r.hasCRP || 0) === 1,
    crpAcres: Number(r.crpAcres || 0)
  }));

  return { county: norm(best.county), state: norm(best.state), active, archived };
}

export function getFarmsInCounty(countyKey, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const sqlite = db();
  const key = norm(countyKey);
  if (!key) throw new Error("Missing county");

  const best = sqlite.prepare(`
    SELECT f.county AS county, COALESCE(f.state,'') AS state, COUNT(1) AS n
    FROM fields f
    WHERE f.county IS NOT NULL AND TRIM(f.county) <> '' AND lower(f.county) LIKE lower(?)
    GROUP BY f.county, state
    ORDER BY n DESC
    LIMIT 1
  `).get(`%${key}%`);

  if (!best) throw new Error(`County not found: ${key}`);

  const fetchFarms = (whereExtra) => sqlite.prepare(`
    SELECT
      COALESCE(NULLIF(f.farmName,''), fm.name, '(Unnamed)') AS farmName,
      COUNT(1) AS fieldCount,
      ROUND(SUM(COALESCE(f.acresTillable,0)), 2) AS tillableAcres
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.county = ? AND COALESCE(f.state,'') = ?
    ${whereExtra}
    GROUP BY farmName
    HAVING COUNT(1) > 0
    ORDER BY lower(farmName) ASC
  `).all(best.county, best.state);

  const active = fetchFarms(activeWhere(sqlite, "f", false)).map(r => ({
    farmName: norm(r.farmName) || "(Unnamed)",
    fieldCount: Number(r.fieldCount || 0),
    tillableAcres: Number(r.tillableAcres || 0)
  }));

  if (!includeArchived) return { county: norm(best.county), state: norm(best.state), active };

  const archived = fetchFarms(archivedWhere(sqlite, "f")).map(r => ({
    farmName: norm(r.farmName) || "(Unnamed)",
    fieldCount: Number(r.fieldCount || 0),
    tillableAcres: Number(r.tillableAcres || 0)
  }));

  return { county: norm(best.county), state: norm(best.state), active, archived };
}
