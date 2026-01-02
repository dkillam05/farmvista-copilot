// /index.js  (FULL FILE)
// Rev: 2026-01-02-min-core2
//
// Adds:
// ✅ /context/summary  (counts + top keys + preview lists)
// ✅ /context/raw      (FULL snapshot dump - debug only)

import express from "express";
import { corsMiddleware } from "./utils/cors.js";
import { getSnapshotStatus, reloadSnapshot, loadSnapshot } from "./context/snapshot.js";
import { handleChat } from "./chat/handleChat.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(corsMiddleware());

function getRevision() {
  return process.env.K_REVISION || process.env.K_SERVICE || "local";
}

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "farmvista-copilot-min",
    ts: new Date().toISOString(),
    revision: getRevision()
  });
});

// --------------------
// Snapshot status / reload
// --------------------
app.get("/context/status", async (req, res) => {
  const s = await getSnapshotStatus();
  res.json({ ...s, revision: getRevision() });
});

app.post("/context/reload", async (req, res) => {
  const r = await reloadSnapshot();
  res.json({ ...r, revision: getRevision() });
});

// --------------------
// Snapshot summary (safe-ish)
// --------------------
// GET /context/summary
// - counts farms/fields/rtkTowers
// - shows top-level keys
// - shows first few names for sanity (no full dump)
app.get("/context/summary", async (req, res) => {
  const snap = await loadSnapshot({ force: false });

  if (!snap?.ok) {
    return res.status(200).json({
      ok: false,
      error: snap?.error || "snapshot_not_loaded",
      source: snap?.source || null,
      activeSnapshotId: snap?.activeSnapshotId || null,
      gcsPath: snap?.gcsPath || null,
      loadedAt: snap?.loadedAt || null,
      revision: getRevision()
    });
  }

  const root = snap.json || {};

  // Common snapshot layouts
  const cols =
    root?.data?.__collections__ ||
    root?.__collections__ ||
    (root?.data && root.data.farms && root.data.fields ? root.data : null) ||
    (root?.farms && root?.fields ? root : null);

  const farms = cols?.farms || {};
  const fields = cols?.fields || {};
  const rtkTowers = cols?.rtkTowers || {};

  const firstFarmNames = Object.values(farms).slice(0, 10).map(x => (x?.name || "").toString()).filter(Boolean);
  const firstFieldNames = Object.values(fields).slice(0, 10).map(x => (x?.name || "").toString()).filter(Boolean);
  const firstTowerNames = Object.values(rtkTowers).slice(0, 10).map(x => (x?.name || "").toString()).filter(Boolean);

  return res.status(200).json({
    ok: true,
    activeSnapshotId: snap.activeSnapshotId || null,
    source: snap.source || null,
    gcsPath: snap.gcsPath || null,
    loadedAt: snap.loadedAt || null,
    counts: {
      farms: Object.keys(farms).length,
      fields: Object.keys(fields).length,
      rtkTowers: Object.keys(rtkTowers).length
    },
    preview: {
      farms: firstFarmNames,
      fields: firstFieldNames,
      rtkTowers: firstTowerNames
    },
    topKeys: Object.keys(root).slice(0, 50),
    revision: getRevision()
  });
});

// --------------------
// Snapshot raw (DEBUG ONLY)
// --------------------
// GET /context/raw
// Returns the entire snapshot JSON as loaded in memory.
// WARNING: exposes all data. Remove/lock down later.
app.get("/context/raw", async (req, res) => {
  const snap = await loadSnapshot({ force: false });
  if (!snap?.ok) {
    return res.status(500).json({
      ok: false,
      error: snap?.error || "snapshot_not_loaded",
      source: snap?.source || null,
      activeSnapshotId: snap?.activeSnapshotId || null,
      gcsPath: snap?.gcsPath || null,
      loadedAt: snap?.loadedAt || null,
      revision: getRevision()
    });
  }
  res.json(snap.json);
});

// --------------------
// Chat
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ ok: false, error: "Missing question", revision: getRevision() });

  const snap = await loadSnapshot({ force: false });
  const out = await handleChat({ question, snapshot: snap });

  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      snapshotId: snap.activeSnapshotId || null,
      source: snap.source || null,
      gcsPath: snap.gcsPath || null,
      loadedAt: snap.loadedAt || null,
      revision: getRevision()
    }
  });
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT} (rev: ${getRevision()})`);
});
