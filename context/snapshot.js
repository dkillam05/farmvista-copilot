// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-02-firestore-pointer1
//
// NO SNAPSHOT_* env vars required.
// Loads active snapshot pointer from Firestore:
//   collection: copilot_snapshots
//   doc: active
// Fields expected on doc:
//   activeSnapshotId (string)
//   gcsPath (string gs://bucket/path.json)
//   uploadedAt (timestamp-ish)
//
// Then downloads the JSON from Cloud Storage using Cloud Run service account.

'use strict';

import admin from "firebase-admin";
import { Storage } from "@google-cloud/storage";

let _cache = {
  ok: false,
  json: null,
  loadedAt: null,
  source: null,
  activeSnapshotId: null,
  gcsPath: null,
  error: null
};

function ensureAdmin() {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

function parseGsPath(gsPath) {
  const s = (gsPath || "").toString().trim();
  const m = s.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return { bucket: m[1], objectPath: m[2] };
}

async function readActivePointerFromFirestore() {
  const db = ensureAdmin();

  // Default: copilot_snapshots/active (matches what you showed)
  const col = (process.env.SNAPSHOT_POINTER_COLLECTION || "copilot_snapshots").trim();
  const docId = (process.env.SNAPSHOT_POINTER_DOC || "active").trim();

  const ref = db.collection(col).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Missing Firestore doc: ${col}/${docId}`);

  const d = snap.data() || {};
  const activeSnapshotId = (d.activeSnapshotId || d.activeSnapshotID || "").toString().trim() || null;
  const gcsPath = (d.gcsPath || "").toString().trim();

  if (!gcsPath) throw new Error(`Firestore doc ${col}/${docId} missing gcsPath`);

  return { activeSnapshotId, gcsPath };
}

async function downloadGsJson(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) throw new Error("Invalid gcsPath (expected gs://bucket/path.json)");

  const storage = new Storage(); // uses Cloud Run service account
  const file = storage.bucket(parsed.bucket).file(parsed.objectPath);

  const [buf] = await file.download();
  const txt = buf.toString("utf8");
  return JSON.parse(txt);
}

export async function loadSnapshot({ force = false } = {}) {
  if (!force && _cache.ok && _cache.json) return _cache;

  try {
    const ptr = await readActivePointerFromFirestore();
    const json = await downloadGsJson(ptr.gcsPath);

    _cache = {
      ok: true,
      json,
      loadedAt: new Date().toISOString(),
      source: "firestore:pointer->gcs",
      activeSnapshotId: ptr.activeSnapshotId || null,
      gcsPath: ptr.gcsPath,
      error: null
    };
    return _cache;
  } catch (e) {
    _cache = {
      ok: false,
      json: null,
      loadedAt: new Date().toISOString(),
      source: "firestore:pointer->gcs",
      activeSnapshotId: null,
      gcsPath: null,
      error: e?.message || String(e)
    };
    return _cache;
  }
}

export async function reloadSnapshot() {
  const snap = await loadSnapshot({ force: true });
  return {
    ok: !!snap.ok,
    loadedAt: snap.loadedAt,
    source: snap.source,
    activeSnapshotId: snap.activeSnapshotId,
    gcsPath: snap.gcsPath,
    error: snap.error || null
  };
}

export async function getSnapshotStatus() {
  if (!_cache.loadedAt) await loadSnapshot({ force: false });
  return {
    ok: !!_cache.ok,
    loadedAt: _cache.loadedAt,
    source: _cache.source,
    activeSnapshotId: _cache.activeSnapshotId,
    gcsPath: _cache.gcsPath,
    error: _cache.error || null
  };
}
