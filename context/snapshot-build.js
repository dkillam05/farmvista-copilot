// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-02-snapshot-build1
//
// Snapshot Builder (EXPORTER)
// --------------------------
// Purpose:
//   Build a single, current snapshot JSON directly from Firestore and write it to
//   ONE fixed Cloud Storage object path (overwrite-in-place).
//
// This is the “Option 3” hourly refresh piece.
// It is NOT used by chat directly — chat continues to read snapshot.json via /context/snapshot.js.
//
// What it does:
//   1) Reads selected Firestore collections (default: farms, fields, rtkTowers)
//   2) Produces JSON shaped like: { meta, data: { __collections__: { <col>: {id: doc} } } }
//   3) Writes to GCS at a fixed path (default: copilot/snapshot.json)
//   4) Uses a temp object + copy to reduce risk of partial writes
//
// How you’ll use it later:
//   - Add a route in index.js: app.post("/snapshot/build", buildSnapshotHttp)
//   - Trigger it hourly with Cloud Scheduler: POST /snapshot/build
//
// Env vars (optional):
//   SNAPSHOT_COLLECTIONS="farms,fields,rtkTowers"
//   SNAPSHOT_BUCKET="dowsonfarms-illinois.appspot.com"   (or your bucket name)
//   SNAPSHOT_OBJECT="copilot/snapshot.json"
//   SNAPSHOT_TMP_OBJECT="copilot/snapshot.tmp.json"
//   SNAPSHOT_LIMIT_PER_COLLECTION="0"   (0 = no limit; otherwise max docs read per collection)

'use strict';

import admin from "firebase-admin";

// Lazy-init Admin SDK (works in Cloud Run / Functions with ADC)
function ensureAdmin() {
  if (admin.apps && admin.apps.length) return;
  admin.initializeApp();
}

/* ---------------------------
   JSON-safe Firestore types
---------------------------- */

function isTimestampLike(v) {
  // Firestore Timestamp has toDate(), seconds, nanoseconds
  return v && typeof v === "object" && typeof v.toDate === "function" &&
    (typeof v.seconds === "number" || typeof v._seconds === "number");
}

function isGeoPointLike(v) {
  // Firestore GeoPoint has latitude/longitude numbers
  return v && typeof v === "object" &&
    typeof v.latitude === "number" && typeof v.longitude === "number";
}

function isDocumentRefLike(v) {
  // Firestore DocumentReference has path string
  return v && typeof v === "object" && typeof v.path === "string" && typeof v.id === "string";
}

function toJsonSafe(value) {
  if (value == null) return value;

  // primitives
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;

  // arrays
  if (Array.isArray(value)) return value.map(toJsonSafe);

  // Firestore special types
  if (isTimestampLike(value)) {
    let sec = value.seconds;
    let nsec = value.nanoseconds;
    // some builds expose _seconds/_nanoseconds
    if (typeof sec !== "number") sec = value._seconds;
    if (typeof nsec !== "number") nsec = value._nanoseconds;

    let iso = null;
    try { iso = value.toDate().toISOString(); } catch { iso = null; }

    return { __type: "timestamp", seconds: sec ?? null, nanoseconds: nsec ?? null, iso };
  }

  if (isGeoPointLike(value)) {
    return { __type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  }

  if (isDocumentRefLike(value)) {
    return { __type: "docref", path: value.path, id: value.id };
  }

  // plain objects
  if (t === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }

  // fallback
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

/* ---------------------------
   Build snapshot object
---------------------------- */

function getEnvCsv(name, fallbackCsv) {
  const raw = (process.env[name] || "").toString().trim();
  if (!raw) return fallbackCsv.split(",").map(s => s.trim()).filter(Boolean);
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function getEnvInt(name, fallback) {
  const raw = (process.env[name] || "").toString().trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function buildSnapshotObject() {
  ensureAdmin();

  const db = admin.firestore();

  const collections = getEnvCsv("SNAPSHOT_COLLECTIONS", "farms,fields,rtkTowers");
  const limitPer = getEnvInt("SNAPSHOT_LIMIT_PER_COLLECTION", 0); // 0 = unlimited

  const root = {
    meta: {
      builtAt: new Date().toISOString(),
      source: "firestore",
      collections,
      note: "Overwritten in-place. Use builtAt to understand freshness."
    },
    data: {
      __collections__: {}
    }
  };

  const counts = {};

  for (const colName of collections) {
    const colRef = db.collection(colName);
    const q = limitPer > 0 ? colRef.limit(limitPer) : colRef;
    const snap = await q.get();

    const map = {};
    snap.forEach(docSnap => {
      const data = docSnap.data() || {};
      map[docSnap.id] = toJsonSafe(data);
    });

    root.data.__collections__[colName] = map;
    counts[colName] = Object.keys(map).length;
  }

  return { snapshot: root, counts };
}

/* ---------------------------
   Write snapshot to GCS
---------------------------- */

function guessDefaultBucket() {
  // Common default patterns:
  // - <project-id>.appspot.com  (classic)
  // - Firebase Storage uses storage bucket, but Admin SDK default bucket is usually appspot unless configured.
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").toString().trim();
  return projectId ? `${projectId}.appspot.com` : "";
}

export async function writeSnapshotToGcs({ snapshot, counts }) {
  ensureAdmin();

  // Admin SDK storage
  const bucketName =
    (process.env.SNAPSHOT_BUCKET || "").toString().trim() ||
    (admin.app().options && admin.app().options.storageBucket ? String(admin.app().options.storageBucket) : "") ||
    guessDefaultBucket();

  if (!bucketName) {
    return {
      ok: false,
      error: "missing_bucket",
      detail: "Set SNAPSHOT_BUCKET or configure storageBucket in firebase-admin initializeApp()."
    };
  }

  const objectPath = (process.env.SNAPSHOT_OBJECT || "copilot/snapshot.json").toString().trim();
  const tmpPath = (process.env.SNAPSHOT_TMP_OBJECT || "copilot/snapshot.tmp.json").toString().trim();

  const bucket = admin.storage().bucket(bucketName);

  const body = JSON.stringify(snapshot);

  // 1) write tmp
  const tmpFile = bucket.file(tmpPath);
  await tmpFile.save(body, {
    resumable: false,
    contentType: "application/json",
    metadata: {
      cacheControl: "no-store, max-age=0"
    }
  });

  // 2) copy tmp -> final (overwrite)
  const finalFile = bucket.file(objectPath);
  await tmpFile.copy(finalFile);

  // 3) delete tmp (best effort)
  try { await tmpFile.delete({ ignoreNotFound: true }); } catch {}

  return {
    ok: true,
    bucket: bucketName,
    objectPath,
    builtAt: snapshot?.meta?.builtAt || null,
    counts: counts || {}
  };
}

/* ---------------------------
   HTTP handler (optional for later)
---------------------------- */

export async function buildSnapshotHttp(req, res) {
  try {
    const { snapshot, counts } = await buildSnapshotObject();
    const w = await writeSnapshotToGcs({ snapshot, counts });

    if (!w.ok) {
      return res.status(500).json({
        ok: false,
        error: w.error || "snapshot_write_failed",
        detail: w.detail || null
      });
    }

    return res.status(200).json({
      ok: true,
      builtAt: w.builtAt,
      bucket: w.bucket,
      objectPath: w.objectPath,
      counts: w.counts
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "snapshot_build_failed",
      detail: (e?.message || String(e)).slice(0, 300)
    });
  }
}