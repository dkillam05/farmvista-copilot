// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-02-min-core1
//
// Loads snapshot JSON from one of:
// 1) SNAPSHOT_FILE=/path/to/snapshot.json
// 2) SNAPSHOT_URL=https://.../snapshot.json
// 3) SNAPSHOT_GCS_PATH=gs://bucket/path/to/snapshot.json   (auto converts to HTTPS download URL)
// 4) SNAPSHOT_META_FILE=./copilot_snapshots.json           (expects { active: { activeSnapshotId, gcsPath } })
//
// In-memory cache + reload endpoint support.

'use strict';

import fs from "fs/promises";

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

// Firebase Storage “alt=media” download URL (works if object is readable)
function gsToFirebaseDownloadUrl(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) return null;
  const { bucket, objectPath } = parsed;
  const enc = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${enc}?alt=media`;
}

async function fetchJson(url) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`SNAPSHOT_URL HTTP ${resp.status}: ${t || resp.statusText}`);
  }
  return await resp.json();
}

async function readJsonFile(filepath) {
  const buf = await fs.readFile(filepath);
  return JSON.parse(buf.toString("utf8"));
}

async function readMetaFileAndGetGsPath(metaFile) {
  const meta = await readJsonFile(metaFile);
  const active = meta?.active || null;
  const gcsPath = (active?.gcsPath || "").toString().trim();
  const activeSnapshotId = (active?.activeSnapshotId || "").toString().trim() || null;
  if (!gcsPath) return { ok: false, gcsPath: null, activeSnapshotId, error: "meta_missing_gcsPath" };
  return { ok: true, gcsPath, activeSnapshotId, error: null };
}

export async function loadSnapshot({ force = false } = {}) {
  if (!force && _cache.ok && _cache.json) return _cache;

  const file = (process.env.SNAPSHOT_FILE || "").trim();
  const url = (process.env.SNAPSHOT_URL || "").trim();
  const gs = (process.env.SNAPSHOT_GCS_PATH || "").trim();
  const metaFile = (process.env.SNAPSHOT_META_FILE || "").trim();

  try {
    let json = null;
    let source = null;
    let activeSnapshotId = null;

    // 1) SNAPSHOT_FILE
    if (file) {
      json = await readJsonFile(file);
      source = file;
      activeSnapshotId = guessSnapshotIdFromPathLike(file);
    }
    // 2) SNAPSHOT_URL
    else if (url) {
      json = await fetchJson(url);
      source = url;
      activeSnapshotId = guessSnapshotIdFromPathLike(url);
    }
    // 3) SNAPSHOT_GCS_PATH
    else if (gs) {
      const dl = gsToFirebaseDownloadUrl(gs);
      if (!dl) throw new Error("Invalid SNAPSHOT_GCS_PATH (expected gs://bucket/path.json)");
      json = await fetchJson(dl);
      source = gs; // keep original gs:// as source
      activeSnapshotId = guessSnapshotIdFromPathLike(gs);
    }
    // 4) SNAPSHOT_META_FILE (your copilot_snapshots JSON)
    else if (metaFile) {
      const meta = await readMetaFileAndGetGsPath(metaFile);
      if (!meta.ok) throw new Error(`SNAPSHOT_META_FILE invalid: ${meta.error}`);
      const dl = gsToFirebaseDownloadUrl(meta.gcsPath);
      if (!dl) throw new Error("Meta gcsPath invalid (expected gs://bucket/path.json)");
      json = await fetchJson(dl);
      source = meta.gcsPath;
      activeSnapshotId = meta.activeSnapshotId || guessSnapshotIdFromPathLike(meta.gcsPath);
    }
    else {
      throw new Error("Missing SNAPSHOT_FILE, SNAPSHOT_URL, SNAPSHOT_GCS_PATH, or SNAPSHOT_META_FILE");
    }

    _cache = {
      ok: true,
      json,
      loadedAt: new Date().toISOString(),
      source,
      activeSnapshotId,
      error: null
    };
    return _cache;
  } catch (e) {
    _cache = {
      ok: false,
      json: null,
      loadedAt: new Date().toISOString(),
      source: file || url || gs || metaFile || null,
      activeSnapshotId: guessSnapshotIdFromPathLike(file || url || gs || null),
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
