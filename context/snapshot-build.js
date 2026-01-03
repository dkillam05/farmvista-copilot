// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-03-snapshot-build2-cloudrun
//
// Snapshot Builder (EXPORTER)
// --------------------------
// Builds a single, current snapshot from Firestore and overwrites ONE fixed GCS object.
//
// Writes:
//   gs://<bucket>/<objectPath>   (default: copilot/snapshot.json)
//
// Env vars (recommended):
//   SNAPSHOT_BUCKET="dowsonfarms-illinois.firebasestorage.app"   (your actual bucket)
//   SNAPSHOT_OBJECT="copilot/snapshot.json"
//   SNAPSHOT_TMP_OBJECT="copilot/snapshot.tmp.json"
//   SNAPSHOT_COLLECTIONS="farms,fields,rtkTowers"
//   SNAPSHOT_LIMIT_PER_COLLECTION="0"

'use strict';

import admin from "firebase-admin";
import "firebase-admin/storage";   // ✅ ensure Storage is registered (Cloud Run-safe)

// Lazy-init Admin SDK (works in Cloud Run / Functions with ADC)
function ensureAdmin() {
  if (admin.apps && admin.apps.length) return;
  // If you set FIREBASE_STORAGE_BUCKET or SNAPSHOT_BUCKET, we can set storageBucket here too.
  const storageBucket =
    (process.env.FIREBASE_STORAGE_BUCKET || "").toString().trim() ||
    (process.env.SNAPSHOT_BUCKET || "").toString().trim() ||
    undefined;

  admin.initializeApp(storageBucket ? { storageBucket } : undefined);
}

/* ---------------------------
   JSON-safe Firestore types
---------------------------- */

function isTimestampLike(v) {
  return v && typeof v === "object" && typeof v.toDate === "function" &&
    (typeof v.seconds === "number" || typeof v._seconds === "number");
}

function isGeoPointLike(v) {
  return v && typeof v === "object" &&
    typeof v.latitude === "number" && typeof v.longitude === "number";
}

function isDocumentRefLike(v) {
  return v && typeof v === "object" && typeof v.path === "string" && typeof v.id === "string";
}

function toJsonSafe(value) {
  if (value == null) return value;

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;

  if (Array.isArray(value)) return value.map(toJsonSafe);

  if (isTimestampLike(value)) {
    let sec = value.seconds;
    let nsec = value.nanoseconds;
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

  if (t === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }

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
      map[docSnap.id] = toJsonSafe(docSnap.data() || {});
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
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").toString().trim();
  return projectId ? `${projectId}.appspot.com` : "";
}

function getBucketName() {
  // Prefer explicit values
  const snapBucket = (process.env.SNAPSHOT_BUCKET || "").toString().trim();
  const fbBucket = (process.env.FIREBASE_STORAGE_BUCKET || "").toString().trim();

  if (snapBucket) return snapBucket;
  if (fbBucket) return fbBucket;

  // Fallback to admin app option if present
  const opt = admin.app().options || {};
  if (opt.storageBucket) return String(opt.storageBucket);

  // Final fallback guess
  return guessDefaultBucket();
}

export async function writeSnapshotToGcs({ snapshot, counts }) {
  ensureAdmin();

  const bucketName = getBucketName();

  if (!bucketName) {
    return {
      ok: false,
      error: "missing_bucket",
      detail: "Set SNAPSHOT_BUCKET (recommended) or FIREBASE_STORAGE_BUCKET."
    };
  }

  const objectPath = (process.env.SNAPSHOT_OBJECT || "copilot/snapshot.json").toString().trim();
  const tmpPath = (process.env.SNAPSHOT_TMP_OBJECT || "copilot/snapshot.tmp.json").toString().trim();

  const bucket = admin.storage().bucket(bucketName);
  const body = JSON.stringify(snapshot);

  try {
    // 1) write tmp
    const tmpFile = bucket.file(tmpPath);
    await tmpFile.save(body, {
      resumable: false,
      contentType: "application/json",
      metadata: { cacheControl: "no-store, max-age=0" }
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
  } catch (e) {
    return {
      ok: false,
      error: "gcs_write_failed",
      detail: (e?.message || String(e)).slice(0, 500),
      bucket: bucketName,
      objectPath,
      tmpPath
    };
  }
}

/* ---------------------------
   HTTP handler
---------------------------- */

export async function buildSnapshotHttp(req, res) {
  try {
    const { snapshot, counts } = await buildSnapshotObject();
    const w = await writeSnapshotToGcs({ snapshot, counts });

    if (!w.ok) {
      return res.status(500).json({
        ok: false,
        error: w.error || "snapshot_write_failed",
        detail: w.detail || null,
        bucket: w.bucket || null,
        objectPath: w.objectPath || null,
        tmpPath: w.tmpPath || null
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
      detail: (e?.message || String(e)).slice(0, 500)
    });
  }
}
