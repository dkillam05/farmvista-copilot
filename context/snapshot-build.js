// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-11-snapshotBuild-firestore2sqlite9-binMovements-normalize-cropType
//
// Change:
// ✅ Adds v_bin_movements_norm that auto-fills missing cropType:
//    - For rows where cropType is blank, use the most recent prior non-blank cropType
//      for the same siteId + binNum (based on dateISO order).
// ✅ Inventory views now use cropTypeNorm, eliminating "(unknown)" for typical workflows.
//
// Keeps:
// ✅ binSites table
// ✅ binMovements table (raw preserved)
// ✅ v_bin_inventory / v_site_inventory / v_total_inventory still exist
// ✅ farms/fields/rtkTowers unchanged

'use strict';

import fs from "fs";
import path from "path";
import os from "os";

import { Storage } from "@google-cloud/storage";
import Database from "better-sqlite3";
import admin from "firebase-admin";
import { FieldPath } from "firebase-admin/firestore";

const storage = new Storage();

const GCS_BUCKET = (process.env.FV_GCS_BUCKET || "dowsonfarms-illinois.firebasestorage.app").toString();
const GCS_OBJECT = (process.env.FV_GCS_OBJECT || "copilot-snapshots/live.sqlite").toString();

const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "").toString() || undefined;

function ensureFirebase() {
  if (admin.apps?.length) return;
  admin.initializeApp(PROJECT_ID ? { projectId: PROJECT_ID } : {});
}

function norm(s) { return (s || "").toString().trim(); }
function lower(s) { return norm(s).toLowerCase(); }

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool01(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function farmArchivedFromStatus(statusRaw) {
  const s = lower(statusRaw);
  if (!s) return null;
  if (s === "active") return 0;
  return 1;
}

async function fetchAllDocs(db, collectionName, pickFn) {
  const col = db.collection(collectionName);

  const out = [];
  let last = null;

  while (true) {
    let q = col.orderBy(FieldPath.documentId()).limit(1000);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      out.push(pickFn(doc.id, data));
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  return out;
}

function createSchema(sqlite) {
  sqlite.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    DROP VIEW IF EXISTS v_total_inventory;
    DROP VIEW IF EXISTS v_site_inventory;
    DROP VIEW IF EXISTS v_bin_inventory;
    DROP VIEW IF EXISTS v_bin_movements_norm;

    DROP TABLE IF EXISTS farms;
    DROP TABLE IF EXISTS rtkTowers;
    DROP TABLE IF EXISTS fields;
    DROP TABLE IF EXISTS binSites;
    DROP TABLE IF EXISTS binMovements;

    CREATE TABLE farms (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      archived INTEGER,
      data TEXT
    );

    CREATE TABLE rtkTowers (
      id TEXT PRIMARY KEY,
      name TEXT,
      networkId TEXT,
      frequency TEXT,
      data TEXT
    );

    CREATE TABLE fields (
      id TEXT PRIMARY KEY,
      name TEXT,
      farmId TEXT,
      farmName TEXT,
      rtkTowerId TEXT,
      rtkTowerName TEXT,
      county TEXT,
      state TEXT,
      acresTillable REAL,
      hasHEL INTEGER,
      helAcres REAL,
      hasCRP INTEGER,
      crpAcres REAL,
      archived INTEGER,
      data TEXT
    );

    CREATE TABLE binSites (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      used INTEGER,
      totalBushels REAL,
      data TEXT
    );

    CREATE TABLE binMovements (
      id TEXT PRIMARY KEY,
      siteId TEXT,
      siteName TEXT,
      binIndex INTEGER,
      binNum INTEGER,
      dateISO TEXT,
      direction TEXT,        -- 'in' or 'out'
      bushels REAL,
      cropType TEXT,
      cropMoisture REAL,
      note TEXT,
      submittedBy TEXT,
      submittedByUid TEXT,
      data TEXT
    );

    CREATE INDEX idx_farms_name ON farms(name);
    CREATE INDEX idx_farms_status ON farms(status);
    CREATE INDEX idx_farms_archived ON farms(archived);

    CREATE INDEX idx_rtk_name ON rtkTowers(name);

    CREATE INDEX idx_fields_name ON fields(name);
    CREATE INDEX idx_fields_farmId ON fields(farmId);
    CREATE INDEX idx_fields_rtkTowerId ON fields(rtkTowerId);
    CREATE INDEX idx_fields_county ON fields(county);
    CREATE INDEX idx_fields_hasHEL ON fields(hasHEL);

    CREATE INDEX idx_binSites_name ON binSites(name);
    CREATE INDEX idx_binSites_status ON binSites(status);

    CREATE INDEX idx_binMoves_siteId ON binMovements(siteId);
    CREATE INDEX idx_binMoves_site_bin ON binMovements(siteId, binNum);
    CREATE INDEX idx_binMoves_site_bin_crop ON binMovements(siteId, binNum, cropType);
    CREATE INDEX idx_binMoves_date ON binMovements(dateISO);
    CREATE INDEX idx_binMoves_dir ON binMovements(direction);

    /*
      v_bin_movements_norm:
      - cropTypeNorm is:
        - the row's cropType if present
        - else the most recent prior non-empty cropType for same siteId+binNum (by dateISO, then id)
      This matches reality: corn in -> corn out, without editing old records.
    */
    CREATE VIEW v_bin_movements_norm AS
      SELECT
        m.*,
        COALESCE(
          NULLIF(TRIM(m.cropType), ''),
          (
            SELECT NULLIF(TRIM(m2.cropType), '')
            FROM binMovements m2
            WHERE m2.siteId = m.siteId
              AND m2.binNum = m.binNum
              AND NULLIF(TRIM(m2.cropType), '') IS NOT NULL
              AND (
                    m2.dateISO < m.dateISO
                 OR (m2.dateISO = m.dateISO AND m2.id <= m.id)
                  )
            ORDER BY m2.dateISO DESC, m2.id DESC
            LIMIT 1
          ),
          '(unknown)'
        ) AS cropTypeNorm
      FROM binMovements m;

    -- Inventory views built from normalized movements
    CREATE VIEW v_bin_inventory AS
      SELECT
        m.siteId AS siteId,
        COALESCE(s.name, m.siteName) AS siteName,
        m.binNum AS binNum,
        m.binIndex AS binIndex,
        COALESCE(NULLIF(TRIM(m.cropTypeNorm), ''), '(unknown)') AS cropType,

        SUM(CASE
              WHEN lower(m.direction) = 'in'  THEN COALESCE(m.bushels, 0)
              WHEN lower(m.direction) = 'out' THEN -COALESCE(m.bushels, 0)
              ELSE 0
            END) AS netBushels,

        SUM(CASE WHEN lower(m.direction) = 'in'  THEN COALESCE(m.bushels, 0) ELSE 0 END) AS totalIn,
        SUM(CASE WHEN lower(m.direction) = 'out' THEN COALESCE(m.bushels, 0) ELSE 0 END) AS totalOut,

        MAX(m.dateISO) AS lastDateISO,
        s.totalBushels AS siteCapacityBushels,
        s.status AS siteStatus,
        s.used AS siteUsed

      FROM v_bin_movements_norm m
      LEFT JOIN binSites s ON s.id = m.siteId
      GROUP BY m.siteId, COALESCE(s.name, m.siteName), m.binNum, m.binIndex, COALESCE(NULLIF(TRIM(m.cropTypeNorm), ''), '(unknown)');

    CREATE VIEW v_site_inventory AS
      SELECT
        siteId,
        siteName,
        cropType,
        SUM(netBushels) AS netBushels,
        SUM(totalIn) AS totalIn,
        SUM(totalOut) AS totalOut,
        MAX(lastDateISO) AS lastDateISO
      FROM v_bin_inventory
      GROUP BY siteId, siteName, cropType;

    CREATE VIEW v_total_inventory AS
      SELECT
        cropType,
        SUM(netBushels) AS netBushels
      FROM v_bin_inventory
      GROUP BY cropType;
  `);
}

function insertRows(sqlite, table, rows) {
  if (!rows.length) return 0;

  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => "?").join(",");
  const stmt = sqlite.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`);

  const tx = sqlite.transaction((batch) => {
    for (const r of batch) stmt.run(cols.map((c) => r[c]));
  });

  tx(rows);
  return rows.length;
}

async function uploadToGcs(localPath, snapshotId) {
  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(GCS_OBJECT);

  await bucket.upload(localPath, {
    destination: GCS_OBJECT,
    resumable: true,
    metadata: {
      contentType: "application/x-sqlite3",
      metadata: { snapshotId }
    }
  });

  const [meta] = await file.getMetadata();
  return {
    bucket: GCS_BUCKET,
    object: GCS_OBJECT,
    generation: meta?.generation || null,
    updated: meta?.updated || null,
    snapshotId
  };
}

export async function buildSnapshotToSqlite() {
  ensureFirebase();
  const firestore = admin.firestore();

  const snapshotId = `live@${new Date().toISOString()}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fv-sqlite-"));
  const localPath = path.join(tmpDir, "live.sqlite");

  const sqlite = new Database(localPath);
  createSchema(sqlite);

  // farms
  const farms = await fetchAllDocs(firestore, "farms", (id, d) => ({
    id,
    name: norm(d.name || d.farmName || ""),
    status: norm(d.status || ""),
    archived: farmArchivedFromStatus(d.status),
    data: JSON.stringify(d)
  }));

  const farmNameById = new Map();
  for (const f of farms) if (f?.id) farmNameById.set(f.id, f.name || "");

  // rtk towers
  const rtkTowers = await fetchAllDocs(firestore, "rtkTowers", (id, d) => ({
    id,
    name: norm(d.name || d.towerName || ""),
    networkId: norm(d.networkId ?? d.netId ?? ""),
    frequency: norm(d.frequency ?? d.freq ?? d.frequencyMHz ?? ""),
    data: JSON.stringify(d)
  }));

  const towerNameById = new Map();
  for (const t of rtkTowers) if (t?.id) towerNameById.set(t.id, t.name || "");

  // fields
  const fields = await fetchAllDocs(firestore, "fields", (id, d) => {
    const rtkTowerId = norm(d.rtkTowerId || d.rtkId || "");
    const existingTowerName = norm(d.rtkTowerName || d.rtkName || "");
    const joinedTowerName = existingTowerName || (rtkTowerId ? (towerNameById.get(rtkTowerId) || "") : "");

    const farmId = norm(d.farmId || "");
    const existingFarmName = norm(d.farmName || "");
    const joinedFarmName = existingFarmName || (farmId ? (farmNameById.get(farmId) || "") : "");

    const acresTillable = numOrNull(d.tillable ?? d.acresTillable ?? d.tillableAcres ?? d.acres ?? null);
    const hasHEL = bool01(d.hasHEL ?? null);
    const helAcres = numOrNull(d.helAcres ?? null);
    const hasCRP = bool01(d.hasCRP ?? null);
    const crpAcres = numOrNull(d.crpAcres ?? null);

    return {
      id,
      name: norm(d.name || d.fieldName || ""),
      farmId,
      farmName: joinedFarmName,
      rtkTowerId,
      rtkTowerName: joinedTowerName,
      county: norm(d.county || ""),
      state: norm(d.state || ""),
      acresTillable,
      hasHEL,
      helAcres,
      hasCRP,
      crpAcres,
      archived: bool01(d.archived ?? d.isArchived ?? d.inactive ?? null),
      data: JSON.stringify(d)
    };
  });

  // binSites
  const binSites = await fetchAllDocs(firestore, "binSites", (id, d) => ({
    id,
    name: norm(d.name || ""),
    status: norm(d.status || ""),
    used: bool01(d.used ?? null),
    totalBushels: numOrNull(d.totalBushels ?? null),
    data: JSON.stringify(d)
  }));

  // binMovements
  const binMovements = await fetchAllDocs(firestore, "binMovements", (id, d) => ({
    id,
    siteId: norm(d.siteId || ""),
    siteName: norm(d.siteName || ""),
    binIndex: numOrNull(d.binIndex ?? null),
    binNum: numOrNull(d.binNum ?? null),
    dateISO: norm(d.dateISO || ""),
    direction: lower(d.direction || ""),
    bushels: numOrNull(d.bushels ?? null),
    cropType: norm(d.cropType || ""),
    cropMoisture: numOrNull(d.cropMoisture ?? null),
    note: d.note == null ? null : String(d.note),
    submittedBy: norm(d.submittedBy || ""),
    submittedByUid: norm(d.submittedByUid || ""),
    data: JSON.stringify(d)
  }));

  insertRows(sqlite, "farms", farms);
  insertRows(sqlite, "rtkTowers", rtkTowers);
  insertRows(sqlite, "fields", fields);
  insertRows(sqlite, "binSites", binSites);
  insertRows(sqlite, "binMovements", binMovements);

  const counts = {
    farms: sqlite.prepare("SELECT COUNT(1) AS n FROM farms").get().n,
    rtkTowers: sqlite.prepare("SELECT COUNT(1) AS n FROM rtkTowers").get().n,
    fields: sqlite.prepare("SELECT COUNT(1) AS n FROM fields").get().n,
    binSites: sqlite.prepare("SELECT COUNT(1) AS n FROM binSites").get().n,
    binMovements: sqlite.prepare("SELECT COUNT(1) AS n FROM binMovements").get().n
  };

  sqlite.close();

  const remote = await uploadToGcs(localPath, snapshotId);
  return { ok: true, snapshotId, counts, localPath, gcs: remote };
}

export async function buildSnapshotHttp(req, res) {
  try {
    const want = (process.env.FV_BUILD_TOKEN || "").toString().trim();
    if (want) {
      const got = (req.get("x-build-token") || "").toString().trim();
      if (got !== want) return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const result = await buildSnapshotToSqlite();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}