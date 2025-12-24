import express from "express";
import admin from "firebase-admin";
import { Storage } from "@google-cloud/storage";

const app = express();
app.use(express.json({ limit: "4mb" }));

// --------------------------------------------------
// CORS (required for FarmVista GitHub Pages frontend)
// --------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  "https://dkillam05.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// --------------------------------------------------
// Firebase Admin + GCS (uses Cloud Run service account)
// --------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp(); // Application Default Credentials in Cloud Run
}
const db = admin.firestore();
const storage = new Storage();

// --------------------------------------------------
// Snapshot cache (in-memory)
// --------------------------------------------------
const SNAP_DOC_PATH = "copilot_snapshots/active";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  // gs://bucket/path/to/file.json
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
  const text = buf.toString("utf8");
  const json = JSON.parse(text);
  return { json, bytes: buf.length, bucket: parsed.bucket, object: parsed.object };
}

async function loadSnapshot({ force = false } = {}) {
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

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "farmvista-copilot",
    ts: new Date().toISOString()
  });
});

// Check if snapshot is loading + basic metadata
app.get("/context/status", async (req, res) => {
  const cache = await loadSnapshot({ force: false });
  res.json({
    ok: true,
    activeSnapshotId: cache.activeSnapshotId,
    gcsPath: cache.gcsPath,
    uploadedAt: cache.uploadedAt,
    cacheAgeSec: cache.loadedAtMs ? Math.round((Date.now() - cache.loadedAtMs) / 1000) : null,
    bytes: cache.bytes || 0,
    hasJson: !!cache.json,
    lastError: cache.lastError
  });
});

// Force reload snapshot (manual)
app.post("/context/reload", async (req, res) => {
  const cache = await loadSnapshot({ force: true });
  res.json({
    ok: true,
    reloaded: true,
    activeSnapshotId: cache.activeSnapshotId,
    gcsPath: cache.gcsPath,
    uploadedAt: cache.uploadedAt,
    bytes: cache.bytes || 0,
    hasJson: !!cache.json,
    lastError: cache.lastError
  });
});

// Chat endpoint (still simple, but proves snapshot access)
app.post("/chat", async (req, res) => {
  const q = (req.body?.question || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing question" });

  const snap = await loadSnapshot({ force: false });

  // PROOF: list top-level keys + counts (no sensitive content)
  const topKeys = snap?.json && typeof snap.json === "object" ? Object.keys(snap.json).slice(0, 20) : [];
  const counts = {};
  for (const k of topKeys) {
    const v = snap.json[k];
    counts[k] = Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : (v == null ? 0 : 1));
  }

  res.json({
    answer: `Snapshot loaded ✅ (id: ${snap.activeSnapshotId || "unknown"}). Ask me something next.`,
    meta: {
      receivedAt: new Date().toISOString(),
      snapshotId: snap.activeSnapshotId,
      snapshotUploadedAt: snap.uploadedAt,
      snapshotBytes: snap.bytes || 0,
      topKeys,
      counts
    }
  });
});


// --------------------------------------------------
// Start server
// --------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
  console.log(`📦 Snapshot pointer doc: ${SNAP_DOC_PATH} (cache TTL ${Math.round(CACHE_TTL_MS/1000)}s)`);
});
