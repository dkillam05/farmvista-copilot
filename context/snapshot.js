// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-02-min-core2
//
// Loads snapshot JSON from one of:
// 1) SNAPSHOT_FILE=/path/to/snapshot.json
// 2) SNAPSHOT_URL=https://.../snapshot.json
// 3) SNAPSHOT_GCS_PATH=gs://bucket/path/to/snapshot.json   (AUTHENTICATED download via GCS client)
// 4) SNAPSHOT_META_FILE=./copilot_snapshots.json           (expects { active: { activeSnapshotId, gcsPath } })
//
// In-memory cache + reload endpoint support.

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

async function readMetaFile(metaFile) {
  const meta = await readJsonFile(metaFile);
  const active = meta?.active || null;
  const gcsPath = (active?.gcsPath || "").toString().trim();
  const activeSnapshotId = (active?.activeSnapshotId || "").toString().trim() || null;
  if (!gcsPath) return { ok: false, gcsPath: null, activeSnapshotId, error: "meta_missing_gcsPath" };
  return { ok: true, gcsPath, activeSnapshotId, error: null };
}

async function downloadGsJson(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) throw new Error("Invalid gs path (expected gs://bucket/object.json)");

  const storage = new Storage(); // uses Cloud Run service account automatically
  const file = storage.bucket(parsed.bucket).file(parsed.objectPath);

  const [buf] = await file.download(); // Buffer
  const txt = buf.toString("utf8");
  return JSON.parse(txt);
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

    if (file) {
      json = await readJsonFile(file);
      source = file;
      activeSnapshotId = guessSnapshotIdFromPathLike(file);
    } else if (url) {
      json = await fetchJson(url);
      source = url;
      activeSnapshotId = guessSnapshotIdFromPathLike(url);
    } else if (gs) {
      json = await downloadGsJson(gs);
      source = gs;
      activeSnapshotId = guessSnapshotIdFromPathLike(gs);
    } else if (metaFile) {
      const meta = await readMetaFile(metaFile);
      if (!meta.ok) throw new Error(`SNAPSHOT_META_FILE invalid: ${meta.error}`);
      json = await downloadGsJson(meta.gcsPath);
      source = meta.gcsPath;
      activeSnapshotId = meta.activeSnapshotId || guessSnapshotIdFromPathLike(meta.gcsPath);
    } else {
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
