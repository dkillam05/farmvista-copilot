import admin from "firebase-admin";
import { Storage } from "@google-cloud/storage";

// Firestore doc pointer to active snapshot
const SNAP_DOC_PATH = "copilot_snapshots/active";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Init Firebase Admin + GCS once
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

// In-memory cache
let SNAP_CACHE = {
  loadedAtMs: 0,
  activeSnapshotId: null,
  gcsPath: null,
  uploadedAt: null,
  bytes: 0,
  json: null,
  lastError: null
};

function parseGsPath(gsPath) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec((gsPath || "").trim());
  if (!m) return null;
  return { bucket: m[1], object: m[2] };
}

async function readActivePointer() {
  const ref = db.doc(SNAP_DOC_PATH);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Missing Firestore doc: ${SNAP_DOC_PATH}`);

  const d = snap.data() || {};
  const activeSnapshotId = (d.activeSnapshotId || "").toString().trim() || null;
  const gcsPath = (d.gcsPath || "").toString().trim() || null;
  const uploadedAt = (d.uploadedAt || "").toString().trim() || null;

  if (!gcsPath) throw new Error(`copilot_snapshots/active is missing gcsPath`);
  return { activeSnapshotId, gcsPath, uploadedAt };
}

async function downloadJsonFromGcs(gsPath) {
  const parsed = parseGsPath(gsPath);
  if (!parsed) throw new Error(`Invalid gcsPath (expected gs://bucket/object): ${gsPath}`);

  const file = storage.bucket(parsed.bucket).file(parsed.object);
  const [buf] = await file.download();

  const json = JSON.parse(buf.toString("utf8"));
  return { json, bytes: buf.length };
}

export async function loadSnapshot({ force = false } = {}) {
  const now = Date.now();
  const fresh = SNAP_CACHE.json && (now - SNAP_CACHE.loadedAtMs) < CACHE_TTL_MS;

  if (!force && fresh) return SNAP_CACHE;

  try {
    const pointer = await readActivePointer();
    const dl = await downloadJsonFromGcs(pointer.gcsPath);

    SNAP_CACHE = {
      loadedAtMs: now,
      activeSnapshotId: pointer.activeSnapshotId,
      gcsPath: pointer.gcsPath,
      uploadedAt: pointer.uploadedAt,
      bytes: dl.bytes,
      json: dl.json,
      lastError: null
    };
    return SNAP_CACHE;
  } catch (err) {
    SNAP_CACHE = {
      ...SNAP_CACHE,
      loadedAtMs: now,
      lastError: (err && err.message) ? err.message : String(err)
    };
    return SNAP_CACHE;
  }
}

export async function getSnapshotStatus() {
  const cache = await loadSnapshot({ force: false });
  return {
    ok: true,
    activeSnapshotId: cache.activeSnapshotId,
    gcsPath: cache.gcsPath,
    uploadedAt: cache.uploadedAt,
    cacheAgeSec: cache.loadedAtMs ? Math.round((Date.now() - cache.loadedAtMs) / 1000) : null,
    bytes: cache.bytes || 0,
    hasJson: !!cache.json,
    lastError: cache.lastError
  };
}

export async function reloadSnapshot() {
  const cache = await loadSnapshot({ force: true });
  return {
    ok: true,
    reloaded: true,
    activeSnapshotId: cache.activeSnapshotId,
    gcsPath: cache.gcsPath,
    uploadedAt: cache.uploadedAt,
    bytes: cache.bytes || 0,
    hasJson: !!cache.json,
    lastError: cache.lastError
  };
}
