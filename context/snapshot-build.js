// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-10-snapshotBuild-firestore2sqlite1
//
// Builds a fresh SQLite snapshot from Firestore and uploads to GCS.
// Intended to run daily via Cloud Scheduler -> Cloud Run -> POST /snapshot/build
//
// Collections expected (minimum):
// - farms
// - fields
// - rtkTowers
//
// Output to GCS:
// bucket: FV_GCS_BUCKET
// object: FV_GCS_OBJECT  (default copilot-snapshots/live.sqlite)
//
// Requires IAM:
// - Cloud Run service account can read Firestore
// - and write to the GCS bucket

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

function norm(s) {
  return (s || "").toString().trim();
}

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

  // Page by doc ID (stable)
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
  // Farms
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
    for (const r of batch) {
      stmt.run(cols.map((c) => r[c]));
    }
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
      metadata: {
        snapshotId: snapshotId
      }
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

  // Create temp db
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fv-sqlite-"));
  const localPath = path.join(tmpDir, "live.sqlite");

  const sqlite = new Database(localPath);
  createSchema(sqlite);

  // Load collections
  const farms = await fetchAllDocs(firestore, "farms", (id, d) => ({
    id,
    name: norm(d.name || d.farmName || ""),
    data: JSON.stringify(d)
  }));

  const rtkTowers = await fetchAllDocs(firestore, "rtkTowers", (id, d) => ({
    id,
    name: norm(d.name || d.towerName || ""),
    networkId: norm(d.networkId || d.netId || ""),
    frequency: norm(d.frequency || d.freq || ""),
    provider: norm(d.provider || d.networkProvider || ""),
    data: JSON.stringify(d)
  }));

  const fields = await fetchAllDocs(firestore, "fields", (id, d) => ({
    id,
    name: norm(d.name || d.fieldName || ""),
    farmId: norm(d.farmId || ""),
    farmName: norm(d.farmName || ""),
    rtkTowerId: norm(d.rtkTowerId || d.rtkId || ""),
    rtkTowerName: norm(d.rtkTowerName || d.rtkName || ""),
    county: norm(d.county || ""),
    state: norm(d.state || ""),
    acresTillable: numOrNull(d.acresTillable ?? d.tillableAcres ?? d.acres ?? null),
    archived: boolOrNull(d.archived ?? d.isArchived ?? d.inactive ?? null),
    data: JSON.stringify(d)
  }));

  // Insert
  insertRows(sqlite, "farms", farms);
  insertRows(sqlite, "rtkTowers", rtkTowers);
  insertRows(sqlite, "fields", fields);

  // Quick counts
  const counts = {
    farms: sqlite.prepare("SELECT COUNT(1) AS n FROM farms").get().n,
    rtkTowers: sqlite.prepare("SELECT COUNT(1) AS n FROM rtkTowers").get().n,
    fields: sqlite.prepare("SELECT COUNT(1) AS n FROM fields").get().n
  };

  sqlite.close();

  const remote = await uploadToGcs(localPath, snapshotId);

  return {
    ok: true,
    snapshotId,
    counts,
    localPath,
    gcs: remote
  };
}

export async function buildSnapshotHttp(req, res) {
  try {
    // Optional simple auth
    const want = (process.env.FV_BUILD_TOKEN || "").toString().trim();
    if (want) {
      const got = (req.get("x-build-token") || "").toString().trim();
      if (got !== want) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const result = await buildSnapshotToSqlite();
    res.json(result);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
