// /context/snapshot-db.js  (FULL FILE)
// Rev: 2026-01-06-snapshotdb2
//
// Builds an in-memory SQLite DB from the currently loaded snapshot.json.
// - Safe in Cloud Run (no external DB).
// - Rebuild only when snapshotId changes.
// - Exposes getDb() for query execution.
//
// Requires: npm i better-sqlite3

'use strict';

import Database from "better-sqlite3";

let DB = null;
let DB_META = { snapshotId: "", loadedAt: "" };

function normText(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[_.,/\\|()[\]{}]+/g, " ")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function squish(s) {
  return normText(s).replace(/\s+/g, "");
}

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  if (d.data && typeof d.data === "object") return d.data;
  if (typeof d === "object") return d;
  return null;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fieldNumPrefix(nameOrId) {
  const m = (nameOrId || "").toString().trim().match(/^(\d{3,4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.pragma("temp_store = MEMORY");
  return db;
}

function resetDb(db) {
  db.exec(`
    DROP TABLE IF EXISTS farms;
    DROP TABLE IF EXISTS fields;
    DROP TABLE IF EXISTS rtkTowers;

    CREATE TABLE farms (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      name_norm TEXT,
      name_sq TEXT
    );

    CREATE TABLE rtkTowers (
      id TEXT PRIMARY KEY,
      name TEXT,
      frequencyMHz TEXT,
      networkId TEXT,
      name_norm TEXT,
      name_sq TEXT
    );

    CREATE TABLE fields (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      farmId TEXT,
      county TEXT,
      state TEXT,
      tillable REAL,
      helAcres REAL,
      crpAcres REAL,
      rtkTowerId TEXT,
      name_norm TEXT,
      name_sq TEXT,
      county_norm TEXT,
      state_norm TEXT,
      field_num INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_fields_farmId ON fields(farmId);
    CREATE INDEX IF NOT EXISTS idx_fields_county_norm ON fields(county_norm);
    CREATE INDEX IF NOT EXISTS idx_fields_state_norm ON fields(state_norm);
    CREATE INDEX IF NOT EXISTS idx_fields_rtkTowerId ON fields(rtkTowerId);
    CREATE INDEX IF NOT EXISTS idx_fields_name_norm ON fields(name_norm);

    CREATE INDEX IF NOT EXISTS idx_farms_name_norm ON farms(name_norm);
    CREATE INDEX IF NOT EXISTS idx_towers_name_norm ON rtkTowers(name_norm);
  `);
}

export function rebuildDbFromSnapshot({ snapshotJson, snapshotId = "", loadedAt = "" }) {
  if (!snapshotJson) throw new Error("missing_snapshotJson");

  const root = getCollectionsRoot(snapshotJson);
  if (!root) throw new Error("snapshot_missing_collections_root");

  const farms = root.farms || {};
  const fields = root.fields || {};
  const rtkTowers = root.rtkTowers || {};

  const db = makeDb();
  resetDb(db);

  const insFarm = db.prepare(`INSERT INTO farms (id,name,status,name_norm,name_sq) VALUES (?,?,?,?,?)`);
  const insTower = db.prepare(`INSERT INTO rtkTowers (id,name,frequencyMHz,networkId,name_norm,name_sq) VALUES (?,?,?,?,?,?)`);
  const insField = db.prepare(`
    INSERT INTO fields (id,name,status,farmId,county,state,tillable,helAcres,crpAcres,rtkTowerId,name_norm,name_sq,county_norm,state_norm,field_num)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const tx = db.transaction(() => {
    for (const [id, f] of Object.entries(farms)) {
      const name = (f?.name || id).toString();
      const status = (f?.status || "").toString();
      insFarm.run(id, name, status, normText(name), squish(name));
    }

    for (const [id, t] of Object.entries(rtkTowers)) {
      const name = (t?.name || id).toString();
      const freq = (t?.frequencyMHz ?? "").toString();
      const net = (t?.networkId ?? "").toString();
      insTower.run(id, name, freq, net, normText(name), squish(name));
    }

    for (const [id, f] of Object.entries(fields)) {
      const name = (f?.name || id).toString();
      const status = (f?.status || "").toString();
      const farmId = (f?.farmId || "").toString();
      const county = (f?.county || "").toString();
      const state = (f?.state || "").toString();
      const tillable = safeNum(f?.tillable);
      const helAcres = safeNum(f?.helAcres);
      const crpAcres = safeNum(f?.crpAcres);
      const rtkTowerId = (f?.rtkTowerId || "").toString();

      const fn = fieldNumPrefix(name) ?? fieldNumPrefix(id);

      insField.run(
        id,
        name,
        status,
        farmId,
        county,
        state,
        tillable,
        helAcres,
        crpAcres,
        rtkTowerId,
        normText(name),
        squish(name),
        normText(county),
        normText(state),
        fn
      );
    }
  });

  tx();

  if (DB) {
    try { DB.close(); } catch {}
  }
  DB = db;
  DB_META = { snapshotId: String(snapshotId || ""), loadedAt: String(loadedAt || "") };

  return {
    ok: true,
    snapshotId: DB_META.snapshotId,
    loadedAt: DB_META.loadedAt,
    counts: {
      farms: Object.keys(farms).length,
      fields: Object.keys(fields).length,
      rtkTowers: Object.keys(rtkTowers).length
    }
  };
}

export function ensureDbFromSnapshot(snap) {
  const snapshotId = (snap?.activeSnapshotId || "").toString();
  const loadedAt = (snap?.loadedAt || "").toString();

  if (!snap?.ok || !snap?.json) return { ok: false, reason: "snapshot_not_loaded" };

  if (DB && DB_META.snapshotId === snapshotId) {
    return { ok: true, reused: true, snapshotId, loadedAt: DB_META.loadedAt };
  }

  return rebuildDbFromSnapshot({ snapshotJson: snap.json, snapshotId, loadedAt });
}

export function getDb() {
  return DB;
}

export function getDbMeta() {
  return { ...DB_META };
}