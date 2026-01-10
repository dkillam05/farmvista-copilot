// /context/snapshot-db.js  (FULL FILE)
// Rev: 2026-01-10-snapshotDb-gcs1
//
// Loads FarmVista SQLite snapshot from GCS into /tmp and opens read-only.
// ✅ ensureDbReady()
// ✅ reloadDbFromGcs()
// ✅ getDb(), getDbStatus()

'use strict';

import fs from "fs";
import path from "path";
import { Storage } from "@google-cloud/storage";
import Database from "better-sqlite3";

const storage = new Storage();

const TMP_DIR = process.env.FV_SQLITE_TMP_DIR || "/tmp/fv-copilot";
const LOCAL_DB_PATH = path.join(TMP_DIR, "live.sqlite");

// Prefer explicit bucket+object (easiest to manage)
const GCS_BUCKET = (process.env.FV_GCS_BUCKET || "dowsonfarms-illinois.firebasestorage.app").toString();
const GCS_OBJECT = (process.env.FV_GCS_OBJECT || "copilot-snapshots/live.sqlite").toString();

let db = null;
let dbMeta = {
  loadedAt: null,
  gcs: { bucket: GCS_BUCKET, object: GCS_OBJECT, generation: null, updated: null },
  snapshot: { id: null, loadedAt: null },
  counts: {}
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function statRemote() {
  const file = storage.bucket(GCS_BUCKET).file(GCS_OBJECT);
  const [meta] = await file.getMetadata();
  return meta;
}

async function downloadRemoteToLocal() {
  ensureDir(TMP_DIR);

  const file = storage.bucket(GCS_BUCKET).file(GCS_OBJECT);
  await file.download({ destination: LOCAL_DB_PATH });

  const remoteMeta = await statRemote();
  dbMeta.gcs.generation = remoteMeta?.generation || null;
  dbMeta.gcs.updated = remoteMeta?.updated || null;

  // If you set customMetadata.snapshotId during upload, we’ll capture it:
  const snapId = remoteMeta?.metadata?.snapshotId || null;
  dbMeta.snapshot.id = snapId || (remoteMeta?.generation ? `gcsgen:${remoteMeta.generation}` : null);
  dbMeta.snapshot.loadedAt = new Date().toISOString();
}

function closeDb() {
  try { if (db) db.close(); } catch {}
  db = null;
}

function openDbReadOnly() {
  closeDb();
  db = new Database(LOCAL_DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
}

function getCounts() {
  const out = {};
  const tables = ["farms", "fields", "rtkTowers"];

  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(1) AS n FROM ${t}`).get();
      out[t] = Number(r?.n || 0);
    } catch {
      out[t] = null;
    }
  }
  return out;
}

export function getDb() {
  if (!db) throw new Error("DB not loaded");
  return db;
}

export async function ensureDbReady({ force = false } = {}) {
  // If already loaded and not forced, we’re good
  if (db && !force) return true;

  // If local file missing, must download
  const localExists = fs.existsSync(LOCAL_DB_PATH);
  if (!localExists || force) {
    await downloadRemoteToLocal();
  } else {
    // still refresh meta best-effort
    try {
      const remoteMeta = await statRemote();
      dbMeta.gcs.generation = remoteMeta?.generation || dbMeta.gcs.generation;
      dbMeta.gcs.updated = remoteMeta?.updated || dbMeta.gcs.updated;
      const snapId = remoteMeta?.metadata?.snapshotId || null;
      dbMeta.snapshot.id = snapId || dbMeta.snapshot.id;
    } catch {}
  }

  openDbReadOnly();
  dbMeta.loadedAt = new Date().toISOString();
  dbMeta.counts = getCounts();

  return true;
}

export async function reloadDbFromGcs() {
  await ensureDbReady({ force: true });
  return true;
}

export async function getDbStatus() {
  const status = {
    localPath: LOCAL_DB_PATH,
    exists: fs.existsSync(LOCAL_DB_PATH),
    loaded: !!db,
    loadedAt: dbMeta.loadedAt,
    gcs: dbMeta.gcs,
    snapshot: dbMeta.snapshot,
    counts: dbMeta.counts
  };

  // If loaded, refresh counts quickly
  if (db) {
    try { status.counts = getCounts(); } catch {}
  }

  return status;
}
