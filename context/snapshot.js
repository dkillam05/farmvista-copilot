// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-03-fixed-gcs-snapshot1
//
// FIXED SINGLE-FILE SNAPSHOT LOADER (no Firestore pointer)
// --------------------------------------------------------
// Reads snapshot JSON from ONE fixed Cloud Storage object (overwritten by scheduler).
//
// Default target:
//   gs://dowsonfarms-illinois.firebasestorage.app/copilot/snapshot.json
//
// You can override with env vars:
//   SNAPSHOT_GCS_PATH="gs://bucket/path.json"   (recommended single setting)
//   or:
//   SNAPSHOT_BUCKET="bucket-name"
//   SNAPSHOT_OBJECT="copilot/snapshot.json"
//
// This replaces the old Firestore pointer mechanism entirely.
// /context/reload simply forces a re-download of the fixed snapshot.
//
// NOTE:
// - Chat stays deterministic.
// - Freshness is controlled by the snapshot builder schedule (every 15 mins).
// - We still download via Cloud Run service account.

'use strict';

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

function parseGsPath(gsPath) {
  const s = (gsPath || "").toString().trim();
  const m = s.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return { bucket: m[1], objectPath: m[2] };
}

function resolveFixedGsPath() {
  // 1) Single env override
  const direct = (process.env.SNAPSHOT_GCS_PATH || "").toString().trim();
  if (direct) return direct;

  // 2) Bucket + object env override
  const b = (process.env.SNAPSHOT_BUCKET || "").toString().trim();
  const o = (process.env.SNAPSHOT_OBJECT || "").toString().trim();
  if (b && o) return `gs://${b}/${o}`;

  // 3) Default (matches your Firebase Storage bucket & desired fixed filename)
  return "gs://dowsonfarms-illinois.firebasestorage.app/copilot/snapshot.json";
}

async function downloadGsJson(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) throw new Error("Invalid gcsPath (expected gs://bucket/path.json)");

  const storage = new Storage(); // uses Cloud Run service account
  const file = storage.bucket(parsed.bucket).file(parsed.objectPath);

  const [buf] = await file.download();
  const txt = buf.toString("utf8");

  // Helpful guard against accidentally writing an empty file
  if (!txt || !txt.trim()) throw new Error("Snapshot file is empty");

  return JSON.parse(txt);
}

export async function loadSnapshot({ force = false } = {}) {
  if (!force && _cache.ok && _cache.json) return _cache;

  const gcsPath = resolveFixedGsPath();

  try {
    const json = await downloadGsJson(gcsPath);

    // If builder writes meta.builtAt, expose it as activeSnapshotId for visibility.
    const builtAt = (json?.meta?.builtAt || "").toString().trim();

    _cache = {
      ok: true,
      json,
      loadedAt: new Date().toISOString(),
      source: "gcs:fixed",
      activeSnapshotId: builtAt ? `live@${builtAt}` : "live",
      gcsPath,
      error: null
    };
    return _cache;
  } catch (e) {
    _cache = {
      ok: false,
      json: null,
      loadedAt: new Date().toISOString(),
      source: "gcs:fixed",
      activeSnapshotId: null,
      gcsPath,
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
