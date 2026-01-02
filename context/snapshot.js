// /context/snapshot.js  (FULL FILE)
// Rev: 2026-01-02-min-core0
//
// Loads snapshot JSON from one of:
// - SNAPSHOT_FILE=/path/to/snapshot.json
// - SNAPSHOT_URL=https://example.com/snapshot.json  (public or signed URL)
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

function guessSnapshotIdFromSource(source) {
  if (!source) return null;
  const s = String(source);
  const m = s.match(/([A-Za-z0-9_-]+)\.json(\?.*)?$/);
  return m ? m[1] : null;
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

export async function loadSnapshot({ force = false } = {}) {
  if (!force && _cache.ok && _cache.json) return _cache;

  const file = (process.env.SNAPSHOT_FILE || "").trim();
  const url = (process.env.SNAPSHOT_URL || "").trim();

  try {
    let json, source;
    if (file) {
      json = await readJsonFile(file);
      source = file;
    } else if (url) {
      json = await fetchJson(url);
      source = url;
    } else {
      throw new Error("Missing SNAPSHOT_FILE or SNAPSHOT_URL");
    }

    _cache = {
      ok: true,
      json,
      loadedAt: new Date().toISOString(),
      source,
      activeSnapshotId: guessSnapshotIdFromSource(source),
      error: null
    };
    return _cache;
  } catch (e) {
    _cache = {
      ok: false,
      json: null,
      loadedAt: new Date().toISOString(),
      source: file || url || null,
      activeSnapshotId: guessSnapshotIdFromSource(file || url || null),
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
  // ensure we have at least tried once
  if (!_cache.loadedAt) await loadSnapshot({ force: false });
  return {
    ok: !!_cache.ok,
    loadedAt: _cache.loadedAt,
    source: _cache.source,
    activeSnapshotId: _cache.activeSnapshotId,
    error: _cache.error || null
  };
}
