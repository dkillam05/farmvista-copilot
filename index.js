// /index.js  (FULL FILE)
// Rev: 2026-01-03a-min-core3-router2-snapshotbuild-summaryall
//
// Adds (unchanged):
// ✅ /context/summary   (UPDATED: now reports ALL snapshot collections + counts)
// ✅ /context/raw
// ✅ /openai/health
//
// Chat:
// ✅ passes Authorization header through to handleChat
// ✅ handleChat uses router/handlers
//
// Snapshot builder:
// ✅ /snapshot/build

import express from "express";
import { corsMiddleware } from "./utils/cors.js";
import { getSnapshotStatus, reloadSnapshot, loadSnapshot } from "./context/snapshot.js";
import { buildSnapshotHttp } from "./context/snapshot-build.js";
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
// Snapshot builder (scheduler target)
// --------------------
app.post("/snapshot/build", buildSnapshotHttp);

// --------------------
// Snapshot summary (UPDATED: all collections)
// --------------------
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

  const cols =
    root?.data?.__collections__ ||
    root?.__collections__ ||
    (root?.data && root.data.farms && root.data.fields ? root.data : null) ||
    (root?.farms && root?.fields ? root : null) ||
    {};

  // Build counts for ALL collections present in snapshot
  const counts = {};
  const preview = {};

  const colNames = Object.keys(cols || {}).sort((a, b) => a.localeCompare(b));
  const PREVIEW_LIMIT = 10;

  function firstValues(obj, limit) {
    try {
      return Object.values(obj || {}).slice(0, limit);
    } catch {
      return [];
    }
  }

  function firstKeys(obj, limit) {
    try {
      return Object.keys(obj || {}).slice(0, limit);
    } catch {
      return [];
    }
  }

  for (const name of colNames) {
    const map = cols?.[name] || {};
    counts[name] = Object.keys(map).length;

    // Collection-specific preview: show human-friendly names when common
    if (name === "farms") {
      preview[name] = firstValues(map, PREVIEW_LIMIT).map(x => (x?.name || "").toString()).filter(Boolean);
      continue;
    }
    if (name === "fields") {
      preview[name] = firstValues(map, PREVIEW_LIMIT).map(x => (x?.name || "").toString()).filter(Boolean);
      continue;
    }
    if (name === "rtkTowers") {
      preview[name] = firstValues(map, PREVIEW_LIMIT).map(x => (x?.name || "").toString()).filter(Boolean);
      continue;
    }
    if (name === "employees") {
      // often { name, displayName, email }
      preview[name] = firstValues(map, PREVIEW_LIMIT)
        .map(x => (x?.name || x?.displayName || x?.email || "").toString())
        .filter(Boolean);
      continue;
    }
    if (name === "equipment") {
      // common fields: name, unit, assetTag, makeModel
      preview[name] = firstValues(map, PREVIEW_LIMIT)
        .map(x => (x?.name || x?.unit || x?.assetTag || x?.makeModel || x?.model || "").toString())
        .filter(Boolean);
      continue;
    }
    if (name === "binSites") {
      preview[name] = firstValues(map, PREVIEW_LIMIT)
        .map(x => (x?.name || x?.siteName || "").toString())
        .filter(Boolean);
      continue;
    }

    // Default preview: doc IDs (always available)
    preview[name] = firstKeys(map, PREVIEW_LIMIT);
  }

  return res.status(200).json({
    ok: true,
    activeSnapshotId: snap.activeSnapshotId || null,
    source: snap.source || null,
    gcsPath: snap.gcsPath || null,
    loadedAt: snap.loadedAt || null,
    counts,
    preview,
    topKeys: Object.keys(root).slice(0, 50),
    revision: getRevision()
  });
});

// --------------------
// Snapshot raw (DEBUG ONLY)
// --------------------
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
// OpenAI health (proves OpenAI is reachable)
// --------------------
app.get("/openai/health", async (req, res) => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  if (!apiKey) return res.status(200).json({ ok: false, error: "OPENAI_API_KEY not set", revision: getRevision() });

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: "ping" }],
        max_output_tokens: 20
      })
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(200).json({
        ok: false,
        error: `OpenAI HTTP ${r.status}`,
        detail: (t || r.statusText).slice(0, 300),
        revision: getRevision()
      });
    }

    const j = await r.json();
    return res.status(200).json({
      ok: true,
      model,
      sample: (j.output_text || "").slice(0, 80),
      revision: getRevision()
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e), revision: getRevision() });
  }
});

// --------------------
// Chat
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ ok: false, error: "Missing question", revision: getRevision() });

  const authHeader = (req.headers.authorization || "").toString();

  const snap = await loadSnapshot({ force: false });
  const out = await handleChat({ question, snapshot: snap, authHeader });

  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      snapshotId: snap?.activeSnapshotId || null,
      source: snap?.source || null,
      gcsPath: snap?.gcsPath || null,
      loadedAt: snap?.loadedAt || null,
      authPresent: !!authHeader,
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
