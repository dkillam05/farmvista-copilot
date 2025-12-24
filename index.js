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
// Helpers (fields)
// --------------------------------------------------
const norm = (s) => (s || "").toString().trim().toLowerCase();
const isNum = (s) => /^[0-9]+$/.test((s || "").toString().trim());

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") {
      return obj[k];
    }
  }
  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtAcres(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function findFieldsRoot(snapshotJson) {
  const d = snapshotJson || {};
  const candidates = [
    "fields",
    "fieldList",
    "fv_fields",
    "Fields",
    "FIELDs"
  ];
  for (const k of candidates) {
    if (Array.isArray(d[k])) return { key: k, arr: d[k] };
  }

  // If snapshot groups by collection name, try common Firestore-ish exports:
  // e.g. { collections: { fields: [...] } } or { data: { fields: [...] } }
  const nestedCandidates = [
    ["collections", "fields"],
    ["collections", "fieldList"],
    ["data", "fields"],
    ["export", "fields"]
  ];
  for (const [a, b] of nestedCandidates) {
    if (d[a] && Array.isArray(d[a][b])) return { key: `${a}.${b}`, arr: d[a][b] };
  }

  return { key: null, arr: [] };
}

function fieldDisplayName(f) {
  const name = pick(f, ["name", "fieldName", "label", "title"]) || "";
  const farm = pick(f, ["farmName", "farm", "farmLabel"]) || "";
  const id = pick(f, ["id", "fieldId", "docId", "key"]) || "";
  const num = pick(f, ["fieldNumber", "number"]) || "";
  const base = name || (num ? `Field ${num}` : id ? String(id) : "Field");
  return farm ? `${base} (${farm})` : base;
}

function summarizeFieldDetailed(f) {
  // Core identity
  const out = {};
  out.id = pick(f, ["id", "fieldId", "docId", "key"]);
  out.name = pick(f, ["name", "fieldName", "label", "title"]);
  out.farm = pick(f, ["farmName", "farm", "farmLabel"]);
  out.acres = fmtAcres(pick(f, ["acres", "areaAcres", "acresTillable", "tillableAcres", "area"]));
  out.county = pick(f, ["county"]);
  out.state = pick(f, ["state"]);

  // Location-ish
  out.lat = pick(f, ["lat", "latitude", "centerLat"]);
  out.lon = pick(f, ["lon", "lng", "longitude", "centerLon", "centerLng"]);

  // USDA / FSA identifiers (often present in farm apps)
  out.fsaFarm = pick(f, ["fsaFarm", "fsaFarmNumber", "farmNumber"]);
  out.tract = pick(f, ["tract", "tractNumber"]);
  out.fsaField = pick(f, ["fsaField", "fieldNumber", "fsaFieldNumber"]);

  // Operational hints
  out.soil = pick(f, ["soilType", "soil", "soilClass"]);
  out.notes = pick(f, ["notes", "note"]);
  out.boundaryId = pick(f, ["boundaryId", "boundary", "shapeId", "polygonId"]);

  // Clean null/empty
  for (const k of Object.keys(out)) {
    if (out[k] == null || out[k] === "") delete out[k];
  }
  return out;
}

function findField(fields, needleRaw) {
  const needle = needleRaw.trim();
  const n = norm(needle);
  if (!n) return null;

  // Numeric match: id, number, fieldNumber
  if (isNum(needle)) {
    const foundNum =
      fields.find(f => String(pick(f, ["fieldNumber", "number"]) || "").trim() === needle) ||
      fields.find(f => String(pick(f, ["id", "fieldId", "docId"]) || "").trim() === needle) ||
      null;
    if (foundNum) return foundNum;
  }

  // Exact name match
  let found =
    fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])) === n) ||
    null;

  // Contains name match
  if (!found) {
    found =
      fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])).includes(n)) ||
      fields.find(f => norm(fieldDisplayName(f)).includes(n)) ||
      null;
  }
  return found;
}

function formatBullets(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj || {})) {
    lines.push(`• ${k}: ${v}`);
  }
  return lines.join("\n");
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

// --------------------------------------------------
// Chat endpoint (FIELDS v1)
// --------------------------------------------------
app.post("/chat", async (req, res) => {
  const qRaw = (req.body?.question || "").toString();
  const q = qRaw.trim();
  if (!q) return res.status(400).json({ error: "Missing question" });

  const snap = await loadSnapshot({ force: false });
  const snapshotId = snap.activeSnapshotId || "unknown";

  if (!snap.json) {
    return res.json({
      answer: "Snapshot is not available right now.",
      meta: { snapshotId, snapshotError: snap.lastError || "unknown" }
    });
  }

  const { key: fieldsKey, arr: fields } = findFieldsRoot(snap.json);

  // DEBUG: tell us what key we’re using
  if (norm(q) === "debug fields") {
    return res.json({
      answer: `Fields source: ${fieldsKey || "(not found)"} — count: ${fields.length}`,
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
    });
  }

  // LIST FIELDS
  if (["fields", "list fields", "show fields", "field list"].includes(norm(q))) {
    if (!fields.length) {
      return res.json({
        answer: "I can’t find a fields list in the current snapshot. Try “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0 }
      });
    }

    const lines = fields.slice(0, 50).map((f, i) => {
      const name = fieldDisplayName(f);
      const acres = fmtAcres(pick(f, ["acres", "areaAcres", "tillableAcres", "acresTillable", "area"]));
      const county = pick(f, ["county"]);
      const bits = [];
      if (acres) bits.push(`${acres} ac`);
      if (county) bits.push(county);
      return `${i + 1}. ${name}${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
    });

    return res.json({
      answer:
        `You have ${fields.length} fields.\n\n` +
        lines.join("\n") +
        (fields.length > 50 ? `\n\n(Showing first 50. Ask “field <name>” for details.)` : ""),
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
    });
  }

  // FIELD LOOKUP: "field X" / "show field X"
  const m =
    /^field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^show\s+field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^open\s+field\s*[:#]?\s*(.+)$/i.exec(q);

  if (m) {
    if (!fields.length) {
      return res.json({
        answer: "I can’t find a fields list in the current snapshot. Try “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0 }
      });
    }

    const needle = (m[1] || "").trim();
    const found = findField(fields, needle);

    if (!found) {
      return res.json({
        answer: `I couldn’t find a field matching “${needle}”. Try “list fields”.`,
        meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
      });
    }

    const detail = summarizeFieldDetailed(found);

    return res.json({
      answer:
        `Field details:\n` +
        formatBullets(detail),
      meta: { snapshotId, fieldsKey }
    });
  }

  // Fallback help
  return res.json({
    answer:
      `I’m connected to snapshot ${snapshotId}.\n\n` +
      `Try:\n• "list fields"\n• "field North 80"\n• "field 12"\n• "debug fields"`,
    meta: { snapshotId }
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
  console.log(`📦 Snapshot pointer doc: ${SNAP_DOC_PATH} (cache TTL ${Math.round(CACHE_TTL_MS / 1000)}s)`);
});
