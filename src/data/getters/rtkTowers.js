// /src/data/getters/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-21-v2-getters-rtk-active-default
//
// Default: ACTIVE ONLY for field assignment counts/lists.
// includeArchived=true will include archived fields (separated).

import { db } from "../sqlite.js";

function normKey(x) { return (x ?? "").toString().trim(); }
function asStr(x) { return (x ?? "").toString(); }
function nonEmptyOrNull(x) { const s = asStr(x).trim(); return s ? s : null; }

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

function archivedWhere(sqlite, alias) {
  if (hasColumn(sqlite, "fields", "archived")) return ` AND COALESCE(${alias}.archived,0)=1 `;
  return " AND 1=0 ";
}

export function getRtkTowerCount() {
  const sqlite = db();
  const row = sqlite.prepare(`SELECT COUNT(1) AS n FROM rtkTowers`).get();
  return { count: Number(row?.n || 0) };
}

export function getRtkTowerList(opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const sqlite = db();

  const rows = sqlite.prepare(`
    SELECT
      t.id        AS towerId,
      t.name      AS towerName,
      t.networkId AS networkId,
      t.frequency AS frequency,
      (
        SELECT COUNT(1)
        FROM fields f
        WHERE f.rtkTowerId = t.id
        ${activeWhere(sqlite, "f", includeArchived)}
      ) AS fieldCount
    FROM rtkTowers t
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

export function getFieldsByRtkTowerKey(key, opts = {}) {
  const includeArchived = opts.includeArchived === true;
  const k = normKey(key);
  if (!k) throw new Error("Missing tower key");

  const sqlite = db();

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

  const fetch = (whereExtra) => sqlite.prepare(`
    SELECT
      f.id AS fieldId,
      f.name AS fieldName,
      COALESCE(NULLIF(f.farmName,''), fm.name) AS farmName,
      f.county AS county,
      COALESCE(f.state,'') AS state,
      f.acresTillable AS acresTillable
    FROM fields f
    LEFT JOIN farms fm ON fm.id = f.farmId
    WHERE f.rtkTowerId = ?
    ${whereExtra}
    ORDER BY lower(f.name) ASC
  `).all(tower.towerId);

  const active = fetch(activeWhere(sqlite, "f", includeArchived)).map(r => ({
    fieldId: r.fieldId,
    fieldName: nonEmptyOrNull(r.fieldName) || "(Unnamed)",
    farmName: nonEmptyOrNull(r.farmName) || "",
    county: nonEmptyOrNull(r.county) || "",
    state: nonEmptyOrNull(r.state) || "",
    acresTillable: (r.acresTillable === null || r.acresTillable === undefined) ? "" : r.acresTillable
  }));

  if (!includeArchived) {
    return {
      tower: {
        towerId: tower.towerId,
        towerName: nonEmptyOrNull(tower.towerName) || "(Unnamed)",
        networkId: nonEmptyOrNull(tower.networkId) || "",
        frequency: nonEmptyOrNull(tower.frequency) || ""
      },
      active
    };
  }

  const archived = fetch(archivedWhere(sqlite, "f")).map(r => ({
    fieldId: r.fieldId,
    fieldName: nonEmptyOrNull(r.fieldName) || "(Unnamed)",
    farmName: nonEmptyOrNull(r.farmName) || "",
    county: nonEmptyOrNull(r.county) || "",
    state: nonEmptyOrNull(r.state) || "",
    acresTillable: (r.acresTillable === null || r.acresTillable === undefined) ? "" : r.acresTillable
  }));

  return {
    tower: {
      towerId: tower.towerId,
      towerName: nonEmptyOrNull(tower.towerName) || "(Unnamed)",
      networkId: nonEmptyOrNull(tower.networkId) || "",
      frequency: nonEmptyOrNull(tower.frequency) || ""
    },
    active,
    archived
  };
}
