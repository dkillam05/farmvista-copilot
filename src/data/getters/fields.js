// /src/data/getters/fields.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-fields-emptystring-fix
//
// Fix:
// - fields.farmName and fields.rtkTowerName may be empty strings
// - Treat empty string as NULL so joins take precedence

import { db } from '../sqlite.js';

function normKey(x) {
  return (x ?? '').toString().trim();
}

export function getFieldFullByKey(key) {
  const k = normKey(key);
  if (!k) throw new Error('Missing field key');

  const sqlite = db();

  const sql = `
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

  const row = sqlite.prepare(sql).get(k);
  if (row) return row;

  const row2 = sqlite.prepare(sql.replace('WHERE f.id = ?', 'WHERE lower(f.name) LIKE lower(?) ORDER BY f.archived ASC, f.name ASC LIMIT 1'))
                     .get(`%${k}%`);

  if (!row2) throw new Error(`Field not found: ${k}`);
  return row2;
}
