// /src/data/getters/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-rtk-allinone
//
// RTK getters (ALL in one file):
// - getRtkTowerCount()
// - getRtkTowerList()
// - getFieldsByRtkTowerKey(key)
//
// Snapshot tables used:
// - rtkTowers
// - fields
// - farms (for farm name join on fields)

import { db } from "../sqlite.js";

function normKey(x) {
  return (x ?? "").toString().trim();
}

function asStr(x) {
  return (x ?? "").toString();
}

function nonEmptyOrNull(x) {
  const s = asStr(x).trim();
  return s ? s : null;
}

export function getRtkTowerCount() {
  const sqlite = db();
  const row = sqlite.prepare(`SELECT COUNT(1) AS n FROM rtkTowers`).get();
  return { count: Number(row?.n || 0) };
}

export function getRtkTowerList() {
  const sqlite = db();

  // List towers with number of assigned fields
  const rows = sqlite.prepare(`
    SELECT
      t.id        AS towerId,
      t.name      AS towerName,
      t.networkId AS networkId,
      t.frequency AS frequency,
      COUNT(f.id) AS fieldCount
    FROM rtkTowers t
    LEFT JOIN fields f ON f.rtkTowerId = t.id
    GROUP BY t.id
    ORDER BY
      CASE WHEN t.name IS NULL OR t.name = '' THEN 1 ELSE 0 END,
      lower(t.name) ASC
  `).all();

  return rows.map(r => ({
    towerId: r.towerId,
    towerName: nonEmptyOrNull(r.towerName) || "(Unnamed)",
    networkId: nonEmptyOrNull(r.networkId) || "",
    frequency: nonEmptyOrNull(r.frequency) || "",
    fieldCount: Number(r.fieldCount || 0)
  }));
}

export function getFieldsByRtkTowerKey(key) {
  const k = normKey(key);
  if (!k) throw new Error("Missing tower key");

  const sqlite = db();

  // Resolve tower by exact id first, else name contains
  const tower =
    sqlite.prepare(`
      SELECT id AS towerId, name AS towerName, networkId, frequency
      FROM rtkTowers
      WHERE id = ?
      LIMIT 1
    `).get(k)
    ||
    sqlite.prepare(`
      SELECT id AS towerId, name AS towerName, networkId, frequency
      FROM rtkTowers
      WHERE lower(name) LIKE lower(?)
      ORDER BY lower(name) ASC
      LIMIT 1
    `).get(`%${k}%`);

  if (!tower) throw new Error(`RTK tower not found: ${k}`);

  const fields = sqlite.prepare(`
    SELECT
      f.id            AS fieldId,
      f.name          AS fieldName,

      -- fields.farmName is often "" so treat empty string as NULL and fall back to farms.name
      COALESCE(NULLIF(f.farmName, ''), fm.name) AS farmName,

      f.county        AS county,
      f.state         AS state,
      f.acresTillable AS acresTillable
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.rtkTowerId = ?
    ORDER BY
      CASE WHEN f.name IS NULL OR f.name = '' THEN 1 ELSE 0 END,
      lower(f.name) ASC
  `).all(tower.towerId);

  return {
    tower: {
      towerId: tower.towerId,
      towerName: nonEmptyOrNull(tower.towerName) || "(Unnamed)",
      networkId: nonEmptyOrNull(tower.networkId) || "",
      frequency: nonEmptyOrNull(tower.frequency) || ""
    },
    fields: fields.map(f => ({
      fieldId: f.fieldId,
      fieldName: nonEmptyOrNull(f.fieldName) || "(Unnamed)",
      farmName: nonEmptyOrNull(f.farmName) || "",
      county: nonEmptyOrNull(f.county) || "",
      state: nonEmptyOrNull(f.state) || "",
      acresTillable: (f.acresTillable === null || f.acresTillable === undefined) ? "" : f.acresTillable
    }))
  };
}