// /context/snapshot-build.js  (FULL FILE)
// Rev: 2026-01-12-snapshotBuild-firestore2sqlite14-grainBags-status-partialFeetSum
//
// Fix:
// ✅ Add grainBagEvents.status column (prevents "no such column: status" SQL crashes)
// ✅ Add grainBagEvents.partialFeetSum REAL (avoids JSON1 dependence for partials math)
//
// Keeps:
// ✅ productsGrainBags (bushelsCorn baseline, lengthFt, diameterFt)
// ✅ binSites + binSiteBins (onHand)
// ✅ farms/fields/rtkTowers
//
// NOTE:
// - This makes bag-bushel math match the app and makes SQL reliable.

'use strict';

import fs from "fs";
import path from "path";
import os from "os";

import { Storage } from "@google-cloud/storage";
import Database from "better-sqlite3";
import admin from "firebase-admin";
import { FieldPath } from "firebase-admin/firestore";

const storage = new Storage();

const GCS_BUCKET = (process.env.FV_GCS_BUCKET || "dowsonfarms-illinois.firebasestorage.app").toString();
const GCS_OBJECT = (process.env.FV_GCS_OBJECT || "copilot-snapshots/live.sqlite").toString();

const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "").toString() || undefined;

function ensureFirebase() {
  if (admin.apps?.length) return;
  admin.initializeApp(PROJECT_ID ? { projectId: PROJECT_ID } : {});
}

function norm(s) { return (s || "").toString().trim(); }
function lower(s) { return norm(s).toLowerCase(); }

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool01(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function farmArchivedFromStatus(statusRaw) {
  const s = lower(statusRaw);
  if (!s) return null;
  if (s === "active") return 0;
  return 1;
}

function toISO(ts) {
  try {
    if (!ts) return "";
    if (typeof ts === "string") return ts;
    if (typeof ts === "object") {
      if (typeof ts.__time__ === "string") return ts.__time__;
      if (typeof ts.toDate === "function") return ts.toDate().toISOString();
      if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000).toISOString();
    }
  } catch {}
  return "";
}

function toMs(ts) {
  try {
    const iso = toISO(ts);
    if (iso) {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms : null;
    }
    if (ts && typeof ts.toMillis === "function") {
      const ms = ts.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
  } catch {}
  return null;
}

async function fetchAllDocs(db, collectionName, pickFn) {
  const col = db.collection(collectionName);

  const out = [];
  let last = null;

  while (true) {
    let q = col.orderBy(FieldPath.documentId()).limit(1000);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      out.push(pickFn(doc.id, data));
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  return out;
}

function createSchema(sqlite) {
  sqlite.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    DROP TABLE IF EXISTS farms;
    DROP TABLE IF EXISTS rtkTowers;
    DROP TABLE IF EXISTS fields;
    DROP TABLE IF EXISTS binSites;
    DROP TABLE IF EXISTS binSiteBins;
    DROP TABLE IF EXISTS grainBagEvents;
    DROP TABLE IF EXISTS productsGrainBags;

    CREATE TABLE farms (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      archived INTEGER,
      data TEXT
    );

    CREATE TABLE rtkTowers (
      id TEXT PRIMARY KEY,
      name TEXT,
      networkId TEXT,
      frequency TEXT,
      data TEXT
    );

    CREATE TABLE fields (
      id TEXT PRIMARY KEY,
      name TEXT,
      farmId TEXT,
      farmName TEXT,
      rtkTowerId TEXT,
      rtkTowerName TEXT,
      county TEXT,
      state TEXT,
      acresTillable REAL,
      hasHEL INTEGER,
      helAcres REAL,
      hasCRP INTEGER,
      crpAcres REAL,
      archived INTEGER,
      data TEXT
    );

    CREATE TABLE binSites (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      used INTEGER,
      totalBushels REAL,
      data TEXT
    );

    CREATE TABLE binSiteBins (
      siteId TEXT,
      siteName TEXT,
      binNum INTEGER,
      capacityBushels REAL,
      onHandBushels REAL,
      lastCropType TEXT,
      lastCropMoisture REAL,
      lastUpdatedMs INTEGER,
      lastUpdatedBy TEXT,
      lastUpdatedUid TEXT,
      PRIMARY KEY (siteId, binNum)
    );

    -- ✅ Fixed grain bag events schema (adds status + partialFeetSum)
    CREATE TABLE grainBagEvents (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      datePlaced TEXT,
      cropType TEXT,
      cropYear INTEGER,
      cropMoisture REAL,

      fieldId TEXT,
      fieldName TEXT,

      bagSkuId TEXT,
      bagBrand TEXT,
      bagDiameterFt REAL,
      bagSizeFeet REAL,

      countFull INTEGER,
      countPartial INTEGER,

      partialFeetJson TEXT,
      partialFeetSum REAL,
      partialUsageJson TEXT,

      priority INTEGER,
      priorityReason TEXT,

      submittedByEmail TEXT,
      submittedByName TEXT,

      createdAtISO TEXT,
      createdAtMs INTEGER,
      updatedAtISO TEXT,
      updatedAtMs INTEGER,

      data TEXT
    );

    CREATE TABLE productsGrainBags (
      id TEXT PRIMARY KEY,
      brand TEXT,
      diameterFt REAL,
      lengthFt REAL,
      thicknessMil REAL,
      status TEXT,
      notes TEXT,

      bushelsCorn REAL,
      soyPct REAL,
      wheatPct REAL,
      bushelsSoy REAL,
      bushelsWheat REAL,

      createdAtISO TEXT,
      createdAtMs INTEGER,
      updatedAtISO TEXT,
      updatedAtMs INTEGER,

      data TEXT
    );

    CREATE INDEX idx_farms_name ON farms(name);
    CREATE INDEX idx_farms_archived ON farms(archived);

    CREATE INDEX idx_rtk_name ON rtkTowers(name);

    CREATE INDEX idx_fields_name ON fields(name);
    CREATE INDEX idx_fields_farmId ON fields(farmId);
    CREATE INDEX idx_fields_county ON fields(county);
    CREATE INDEX idx_fields_archived ON fields(archived);

    CREATE INDEX idx_binSites_name ON binSites(name);
    CREATE INDEX idx_binSiteBins_crop ON binSiteBins(lastCropType);

    CREATE INDEX idx_gbe_type ON grainBagEvents(type);
    CREATE INDEX idx_gbe_status ON grainBagEvents(status);
    CREATE INDEX idx_gbe_crop ON grainBagEvents(cropType);
    CREATE INDEX idx_gbe_year ON grainBagEvents(cropYear);
    CREATE INDEX idx_gbe_field ON grainBagEvents(fieldId);

    CREATE INDEX idx_pgb_size ON productsGrainBags(diameterFt, lengthFt);
    CREATE INDEX idx_pgb_status ON productsGrainBags(status);
  `);
}

function insertRows(sqlite, table, rows) {
  if (!rows.length) return 0;

  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => "?").join(",");
  const stmt = sqlite.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`);

  const tx = sqlite.transaction((batch) => {
    for (const r of batch) stmt.run(cols.map((c) => r[c]));
  });

  tx(rows);
  return rows.length;
}

async function uploadToGcs(localPath, snapshotId) {
  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(GCS_OBJECT);

  await bucket.upload(localPath, {
    destination: GCS_OBJECT,
    resumable: true,
    metadata: {
      contentType: "application/x-sqlite3",
      metadata: { snapshotId }
    }
  });

  const [meta] = await file.getMetadata();
  return {
    bucket: GCS_BUCKET,
    object: GCS_OBJECT,
    generation: meta?.generation || null,
    updated: meta?.updated || null,
    snapshotId
  };
}

export async function buildSnapshotToSqlite() {
  ensureFirebase();
  const firestore = admin.firestore();

  const snapshotId = `live@${new Date().toISOString()}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fv-sqlite-"));
  const localPath = path.join(tmpDir, "live.sqlite");

  const sqlite = new Database(localPath);
  createSchema(sqlite);

  // farms
  const farms = await fetchAllDocs(firestore, "farms", (id, d) => ({
    id,
    name: norm(d.name || d.farmName || ""),
    status: norm(d.status || ""),
    archived: farmArchivedFromStatus(d.status),
    data: JSON.stringify(d)
  }));

  const farmNameById = new Map();
  for (const f of farms) if (f?.id) farmNameById.set(f.id, f.name || "");

  // rtk towers
  const rtkTowers = await fetchAllDocs(firestore, "rtkTowers", (id, d) => ({
    id,
    name: norm(d.name || d.towerName || ""),
    networkId: norm(d.networkId ?? d.netId ?? ""),
    frequency: norm(d.frequency ?? d.freq ?? d.frequencyMHz ?? ""),
    data: JSON.stringify(d)
  }));

  const towerNameById = new Map();
  for (const t of rtkTowers) if (t?.id) towerNameById.set(t.id, t.name || "");

  // fields
  const fields = await fetchAllDocs(firestore, "fields", (id, d) => {
    const rtkTowerId = norm(d.rtkTowerId || d.rtkId || "");
    const existingTowerName = norm(d.rtkTowerName || d.rtkName || "");
    const joinedTowerName = existingTowerName || (rtkTowerId ? (towerNameById.get(rtkTowerId) || "") : "");

    const farmId = norm(d.farmId || "");
    const existingFarmName = norm(d.farmName || "");
    const joinedFarmName = existingFarmName || (farmId ? (farmNameById.get(farmId) || "") : "");

    return {
      id,
      name: norm(d.name || d.fieldName || ""),
      farmId,
      farmName: joinedFarmName,
      rtkTowerId,
      rtkTowerName: joinedTowerName,
      county: norm(d.county || ""),
      state: norm(d.state || ""),
      acresTillable: numOrNull(d.tillable ?? d.acresTillable ?? d.tillableAcres ?? d.acres ?? null),
      hasHEL: bool01(d.hasHEL ?? null),
      helAcres: numOrNull(d.helAcres ?? null),
      hasCRP: bool01(d.hasCRP ?? null),
      crpAcres: numOrNull(d.crpAcres ?? null),
      archived: bool01(d.archived ?? d.isArchived ?? d.inactive ?? null),
      data: JSON.stringify(d)
    };
  });

  // binSites + expanded bins[]
  const binSitesRaw = await fetchAllDocs(firestore, "binSites", (id, d) => ({
    id,
    name: norm(d.name || ""),
    status: norm(d.status || ""),
    used: bool01(d.used ?? null),
    totalBushels: numOrNull(d.totalBushels ?? null),
    bins: Array.isArray(d.bins) ? d.bins : [],
    data: JSON.stringify(d)
  }));

  const binSites = binSitesRaw.map(s => ({
    id: s.id,
    name: s.name,
    status: s.status,
    used: s.used,
    totalBushels: s.totalBushels,
    data: s.data
  }));

  const binSiteBins = [];
  for (const s of binSitesRaw) {
    for (const b of (s.bins || [])) {
      const binNum = numOrNull(b.num ?? null);
      if (!binNum) continue;

      binSiteBins.push({
        siteId: s.id,
        siteName: s.name,
        binNum,
        capacityBushels: numOrNull(b.bushels ?? null),
        onHandBushels: numOrNull(b.onHand ?? null),
        lastCropType: norm(b.lastCropType || ""),
        lastCropMoisture: numOrNull(b.lastCropMoisture ?? null),
        lastUpdatedMs: numOrNull(b.lastUpdatedMs ?? null),
        lastUpdatedBy: norm(b.lastUpdatedBy || ""),
        lastUpdatedUid: norm(b.lastUpdatedUid || "")
      });
    }
  }

  // grain_bag_events (now includes status + partialFeetSum)
  const grainBagEvents = await fetchAllDocs(firestore, "grain_bag_events", (id, d) => {
    const bagSku = (d.bagSku && typeof d.bagSku === "object") ? d.bagSku : {};
    const counts = (d.counts && typeof d.counts === "object") ? d.counts : {};
    const field = (d.field && typeof d.field === "object") ? d.field : {};
    const submittedBy = (d.submittedBy && typeof d.submittedBy === "object") ? d.submittedBy : {};

    const pf = Array.isArray(d.partialFeet) ? d.partialFeet : [];
    let pfSum = 0;
    for (const v of pf) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) pfSum += n;
    }

    return {
      id,

      type: norm(d.type || ""),
      status: norm(d.status || ""), // ✅
      datePlaced: norm(d.datePlaced || d.dateISO || ""),
      cropType: norm(d.cropType || ""),
      cropYear: numOrNull(d.cropYear ?? null),
      cropMoisture: numOrNull(d.cropMoisture ?? null),

      fieldId: norm(field.id || ""),
      fieldName: norm(field.name || ""),

      bagSkuId: norm(bagSku.id || ""),
      bagBrand: norm(bagSku.brand || ""),
      bagDiameterFt: numOrNull(bagSku.diameterFt ?? null),
      bagSizeFeet: numOrNull(bagSku.sizeFeet ?? null),

      countFull: numOrNull(counts.full ?? null),
      countPartial: numOrNull(counts.partial ?? null),

      partialFeetJson: JSON.stringify(pf),
      partialFeetSum: numOrNull(pfSum), // ✅
      partialUsageJson: JSON.stringify(Array.isArray(d.partialUsage) ? d.partialUsage : []),

      priority: numOrNull(d.priority ?? field.priority ?? null),
      priorityReason: norm(d.priorityReason || field.priorityReason || ""),

      submittedByEmail: norm(submittedBy.email || d.submittedByUid || ""),
      submittedByName: norm(submittedBy.name || d.submittedBy || ""),

      createdAtISO: toISO(d.createdAt),
      createdAtMs: toMs(d.createdAt),
      updatedAtISO: toISO(d.updatedAt),
      updatedAtMs: toMs(d.updatedAt),

      data: JSON.stringify(d)
    };
  });

  // productsGrainBags
  const productsGrainBags = await fetchAllDocs(firestore, "productsGrainBags", (id, d) => ({
    id,
    brand: norm(d.brand || ""),
    diameterFt: numOrNull(d.diameterFt ?? null),
    lengthFt: numOrNull(d.lengthFt ?? null),
    thicknessMil: numOrNull(d.thicknessMil ?? null),
    status: norm(d.status || ""),
    notes: norm(d.notes || ""),

    bushelsCorn: numOrNull(d.bushels ?? null),

    soyPct: numOrNull(d.soyPct ?? d.soybeanPct ?? null),
    wheatPct: numOrNull(d.wheatPct ?? null),

    bushelsSoy: numOrNull(d.bushelsSoy ?? d.soyBushels ?? null),
    bushelsWheat: numOrNull(d.bushelsWheat ?? d.wheatBushels ?? null),

    createdAtISO: toISO(d.createdAt),
    createdAtMs: toMs(d.createdAt),
    updatedAtISO: toISO(d.updatedAt),
    updatedAtMs: toMs(d.updatedAt),

    data: JSON.stringify(d)
  }));

  insertRows(sqlite, "farms", farms);
  insertRows(sqlite, "rtkTowers", rtkTowers);
  insertRows(sqlite, "fields", fields);
  insertRows(sqlite, "binSites", binSites);
  if (binSiteBins.length) insertRows(sqlite, "binSiteBins", binSiteBins);
  if (grainBagEvents.length) insertRows(sqlite, "grainBagEvents", grainBagEvents);
  if (productsGrainBags.length) insertRows(sqlite, "productsGrainBags", productsGrainBags);

  const counts = {
    farms: sqlite.prepare("SELECT COUNT(1) AS n FROM farms").get().n,
    rtkTowers: sqlite.prepare("SELECT COUNT(1) AS n FROM rtkTowers").get().n,
    fields: sqlite.prepare("SELECT COUNT(1) AS n FROM fields").get().n,
    binSites: sqlite.prepare("SELECT COUNT(1) AS n FROM binSites").get().n,
    binSiteBins: sqlite.prepare("SELECT COUNT(1) AS n FROM binSiteBins").get().n,
    grainBagEvents: sqlite.prepare("SELECT COUNT(1) AS n FROM grainBagEvents").get().n,
    productsGrainBags: sqlite.prepare("SELECT COUNT(1) AS n FROM productsGrainBags").get().n
  };

  sqlite.close();

  const remote = await uploadToGcs(localPath, snapshotId);
  return { ok: true, snapshotId, counts, localPath, gcs: remote };
}

export async function buildSnapshotHttp(req, res) {
  try {
    const want = (process.env.FV_BUILD_TOKEN || "").toString().trim();
    if (want) {
      const got = (req.get("x-build-token") || "").toString().trim();
      if (got !== want) return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const result = await buildSnapshotToSqlite();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}