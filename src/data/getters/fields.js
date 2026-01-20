// /src/data/getters/fields.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-fields-emptystring-fix2
//
// Fix:
// - Treat empty strings as NULL for farmName and rtkTowerName
// - Use explicit SQL statements (no string replace)
// - Prevents "near LIMIT" syntax error

import { db } from '../sqlite.js';

function normKey(x) {
  return (x ?? '').toString().trim();
}

const SQL_BY_ID = `
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
  LIMIT 1
`;

const SQL_BY_NAME = `
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
  ORDER BY f.archived ASC, f.name ASC
  LIMIT 1
`;

export function getFieldFullByKey(key) {
  const k = normKey(key);
  if (!k) throw new Error('Missing field key');

  const sqlite = db();

  const row = sqlite.prepare(SQL_BY_ID).get(k);
  if (row) return row;

  const row2 = sqlite.prepare(SQL_BY_NAME).get(`%${k}%`);
  if (!row2) throw new Error(`Field not found: ${k}`);

  return row2;
}
