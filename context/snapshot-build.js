// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-10-snapshotBuild-firestore2sqlite3-fillFarmName-mapTillable-frequencyMHz
//
// Builds SQLite snapshot from Firestore and uploads to GCS.
// Changes from your current file:
// ✅ Populate fields.farmName by joining farmId -> farms.name during build (so "by farm" works)
// ✅ Map acresTillable from Firestore field.tillable (your real key), with fallbacks
// ✅ Map RTK frequency from frequencyMHz into the "frequency" column (keeps existing fallbacks)
// ✅ Keep your existing towerId -> rtkTowerName join fill

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

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
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

    DROP TABLE IF EXISTS farms;
    DROP TABLE IF EXISTS rtkTowers;
    DROP TABLE IF EXISTS fields;

    CREATE TABLE farms (
      id TEXT PRIMARY KEY,
      name TEXT,
      data TEXT
    );

    CREATE TABLE rtkTowers (
      id TEXT PRIMARY KEY,
      name TEXT,
      networkId TEXT,
      frequency TEXT,
      provider TEXT,
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
      archived INTEGER,
      data TEXT
    );

    CREATE INDEX idx_farms_name ON farms(name);
    CREATE INDEX idx_rtk_name ON rtkTowers(name);
    CREATE INDEX idx_fields_name ON fields(name);
    CREATE INDEX idx_fields_farmId ON fields(farmId);
    CREATE INDEX idx_fields_rtkTowerId ON fields(rtkTowerId);
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

  // Farms
  const farms = await fetchAllDocs(firestore, "farms", (id, d) => ({
    id,
    name: norm(d.name || d.farmName || ""),
    data: JSON.stringify(d)
  }));

  // ✅ Build farmId -> farmName map (for join fill into fields.farmName)
  const farmNameById = new Map();
  for (const f of farms) {
    if (f?.id) farmNameById.set(f.id, f.name || "");
  }

  // RTK towers
  const rtkTowers = await fetchAllDocs(firestore, "rtkTowers", (id, d) => ({
    id,
    name: norm(d.name || d.towerName || ""),
    networkId: norm(d.networkId ?? d.netId ?? ""),
    // ✅ Your data uses frequencyMHz; store it into "frequency" too
    frequency: norm(d.frequency ?? d.freq ?? d.frequencyMHz ?? ""),
    provider: norm(d.provider || d.networkProvider || ""),
    data: JSON.stringify(d)
  }));

  // Build towerId -> towerName map for join fill
  const towerNameById = new Map();
  for (const t of rtkTowers) {
    if (t?.id) towerNameById.set(t.id, t.name || "");
  }

  // Fields (fill rtkTowerName + farmName from maps; map acresTillable from "tillable")
  const fields = await fetchAllDocs(firestore, "fields", (id, d) => {
    const rtkTowerId = norm(d.rtkTowerId || d.rtkId || "");
    const existingTowerName = norm(d.rtkTowerName || d.rtkName || "");
    const joinedTowerName = existingTowerName || (rtkTowerId ? (towerNameById.get(rtkTowerId) || "") : "");

    const farmId = norm(d.farmId || "");
    const existingFarmName = norm(d.farmName || "");
    const joinedFarmName = existingFarmName || (farmId ? (farmNameById.get(farmId) || "") : "");

    // ✅ Your real key is "tillable"
    const acresTillable =
      numOrNull(d.tillable ?? d.acresTillable ?? d.tillableAcres ?? d.acres ?? null);

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
      archived: boolOrNull(d.archived ?? d.isArchived ?? d.inactive ?? null),
      data: JSON.stringify(d)
    };
  });

  insertRows(sqlite, "farms", farms);
  insertRows(sqlite, "rtkTowers", rtkTowers);
  insertRows(sqlite, "fields", fields);

  const counts = {
    farms: sqlite.prepare("SELECT COUNT(1) AS n FROM farms").get().n,
    rtkTowers: sqlite.prepare("SELECT COUNT(1) AS n FROM rtkTowers").get().n,
    fields: sqlite.prepare("SELECT COUNT(1) AS n FROM fields").get().n
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