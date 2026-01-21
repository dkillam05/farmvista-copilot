// /src/data/getters/fields.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-fields-active-default
//
// Default: ACTIVE ONLY (if fields.archived exists).
// includeArchived=true allows archived results.

import { db } from '../sqlite.js';

function normKey(x) { return (x ?? '').toString().trim(); }

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
  if (hasColumn(sqlite, "fields", "archived")) return ` AND COALESCE(${alias}.archived,0)=0 `;
  return "";
}

const SQL_BY_ID = (extraWhere) => `
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
    COALESCE(NULLIF(f.farmName, ''), fm.name) AS farmName,

    f.rtkTowerId    AS rtkTowerId,
    COALESCE(NULLIF(f.rtkTowerName, ''), rt.name) AS rtkTowerName,
    rt.networkId    AS rtkNetworkId,
    rt.frequency    AS rtkFrequency

  FROM fields f
  LEFT JOIN farms fm     ON fm.id = f.farmId
  LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
  WHERE f.id = ?
  ${extraWhere}
  LIMIT 1
`;

const SQL_BY_NAME = (extraWhere) => `
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
    COALESCE(NULLIF(f.farmName, ''), fm.name) AS farmName,

    f.rtkTowerId    AS rtkTowerId,
    COALESCE(NULLIF(f.rtkTowerName, ''), rt.name) AS rtkTowerName,
    rt.networkId    AS rtkNetworkId,
    rt.frequency    AS rtkFrequency

  FROM fields f
  LEFT JOIN farms fm     ON fm.id = f.farmId
  LEFT JOIN rtkTowers rt ON rt.id = f.rtkTowerId
  WHERE lower(f.name) LIKE lower(?)
  ${extraWhere}
  ORDER BY
    ${hasColumn(db(), "fields", "archived") ? "COALESCE(f.archived,0) ASC," : ""}
    lower(f.name) ASC
  LIMIT 1
`;

export function getFieldFullByKey(key, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const k = normKey(key);
  if (!k) throw new Error('Missing field key');

  const sqlite = db();
  const extra = activeWhere(sqlite, "f", includeArchived);

  const row = sqlite.prepare(SQL_BY_ID(extra)).get(k);
  if (row) return row;

  const row2 = sqlite.prepare(SQL_BY_NAME(extra)).get(`%${k}%`);
  if (!row2) throw new Error(`Field not found: ${k}`);

  return row2;
}
