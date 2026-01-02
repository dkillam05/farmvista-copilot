// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-02-firestore-storage-auth1
//
// Loads snapshot JSON from:
// - SNAPSHOT_GCS_PATH=gs://bucket/path/to/file.json   (AUTHENTICATED via Cloud Run service account)
// Optional fallback:
// - SNAPSHOT_FILE=./local.json
// - SNAPSHOT_URL=https://.../file.json

'use strict';

import fs from "fs/promises";
import { Storage } from "@google-cloud/storage";

let _cache = {
  ok: false,
  json: null,
  loadedAt: null,
  source: null,
  activeSnapshotId: null,
  error: null
};

function guessSnapshotIdFromPathLike(source) {
  if (!source) return null;
  const s = String(source);
  const m = s.match(/([A-Za-z0-9_-]+)\.json(\?.*)?$/);
  return m ? m[1] : null;
}

function parseGsPath(gsPath) {
  const s = (gsPath || "").toString().trim();
  const m = s.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return { bucket: m[1], objectPath: m[2] };
}

async function readJsonFile(filepath) {
  const buf = await fs.readFile(filepath);
  return JSON.parse(buf.toString("utf8"));
}

async function fetchJson(url) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`SNAPSHOT_URL HTTP ${resp.status}: ${t || resp.statusText}`);
  }
  return await resp.json();
}

async function downloadGsJson(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) throw new Error("Invalid SNAPSHOT_GCS_PATH (expected gs://bucket/object.json)");

  // Uses Cloud Run service account automatically
  const storage = new Storage();
  const file = storage.bucket(parsed.bucket).file(parsed.objectPath);

  const [buf] = await file.download();
  return JSON.parse(buf.toString("utf8"));
}

export async function loadSnapshot({ force = false } = {}) {
  if (!force && _cache.ok && _cache.json) return _cache;

  const gs = (process.env.SNAPSHOT_GCS_PATH || "").trim();
  const file = (process.env.SNAPSHOT_FILE || "").trim();
  const url = (process.env.SNAPSHOT_URL || "").trim();

  try {
    let json = null;
    let source = null;

    if (gs) {
      json = await downloadGsJson(gs);
      source = gs;
    } else if (file) {
      json = await readJsonFile(file);
      source = file;
    } else if (url) {
      json = await fetchJson(url);
      source = url;
    } else {
      throw new Error("Missing SNAPSHOT_GCS_PATH (or SNAPSHOT_FILE / SNAPSHOT_URL)");
    }

    _cache = {
      ok: true,
      json,
      loadedAt: new Date().toISOString(),
      source,
      activeSnapshotId: guessSnapshotIdFromPathLike(source),
      error: null
    };
    return _cache;
  } catch (e) {
    _cache = {
      ok: false,
      json: null,
      loadedAt: new Date().toISOString(),
      source: gs || file || url || null,
      activeSnapshotId: guessSnapshotIdFromPathLike(gs || file || url || null),
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
    error: _cache.error || null
  };
}
