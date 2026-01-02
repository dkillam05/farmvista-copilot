// index.js  (FULL FILE)
// Rev: 2026-01-02-clean-core1
//
// CLEAN CORE ONLY:
// ✅ /health
// ✅ /context/status  + /context/reload
// ✅ /search          (farms + fields)
// ✅ /chat            (calls chat/handleChat.js)
// ❌ removed ALL /report code + helpers

import express from "express";
import admin from "firebase-admin";

import { corsMiddleware } from "./utils/cors.js";
import { getSnapshotStatus, reloadSnapshot, loadSnapshot } from "./context/snapshot.js";
import { handleChat } from "./chat/handleChat.js";

import {
  getThreadId,
  loadRecentHistory,
  deriveStateFromHistory,
  appendLogTurn
} from "./context/copilotLogs.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(corsMiddleware());

function getRevision() {
  return process.env.K_REVISION || process.env.K_SERVICE || null;
}

// Ensure admin initialized (safe)
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "farmvista-copilot",
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
// Search (v1)
// --------------------
// GET /search?q=...&status=active|all&limit=20
//
// - Searches BOTH farms + fields by name (case-insensitive contains)
// - Joins fields -> farmName via field.farmId
// - Default: status=active
// - Predictable + testable (no AI)
// --------------------
app.get("/search", async (req, res) => {
  const q = (req.query?.q || "").toString().trim();
  const status = (req.query?.status || "active").toString().trim().toLowerCase(); // active|all
  const limit = clampInt(req.query?.limit, 20, 1, 50);

  if (!q || q.length < 2) {
    return res.status(400).json({
      ok: false,
      error: "Missing q (min 2 chars). Example: /search?q=pisgah",
      revision: getRevision()
    });
  }

  try {
    const result = await runFarmFieldSearch({ q, status, limit });
    return res.json({
      ok: true,
      q,
      status,
      limit,
      ...result,
      revision: getRevision()
    });
  } catch (e) {
    console.error("[/search] failed:", e?.stack || e);
    return res.status(500).json({
      ok: false,
      error: "Search failed",
      detail: e?.message || String(e),
      revision: getRevision()
    });
  }
});

// --------------------
// Chat
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) {
    return res.status(400).json({ ok: false, error: "Missing question", revision: getRevision() });
  }

  const threadId = getThreadId(req);

  let history = [];
  let state = {};
  try {
    history = await loadRecentHistory(threadId);
    state = deriveStateFromHistory(history);
  } catch (e) {
    console.warn("[copilot_logs] loadRecentHistory failed (continuing):", e?.message || e);
    history = [];
    state = {};
  }

  const snap = await loadSnapshot({ force: false });

  let out;
  try {
    out = await handleChat({
      question,
      snapshot: snap,
      history,
      state
    });
  } catch (e) {
    console.error("[/chat] handleChat crashed:", e?.stack || e);
    out = { answer: "Backend error", meta: { error: true } };
  }

  const intent =
    out?.meta?.intent ||
    (Array.isArray(out?.meta?.intents) ? out.meta.intents[0] : null) ||
    null;

  // Best-effort logging (never blocks chat)
  try {
    await appendLogTurn({
      threadId,
      role: "user",
      text: question,
      intent: null,
      meta: { snapshotId: snap.activeSnapshotId || null, revision: getRevision() }
    });

    await appendLogTurn({
      threadId,
      role: "assistant",
      text: out?.answer || "",
      intent,
      meta: { ...(out?.meta || null), revision: getRevision(), snapshotId: snap.activeSnapshotId || null }
    });
  } catch (e) {
    console.warn("[copilot_logs] appendLogTurn failed (continuing):", e?.message || e);
  }

  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      threadId,
      snapshotId: snap.activeSnapshotId || null,
      gcsPath: snap.gcsPath || null,
      revision: getRevision()
    }
  });
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT} (rev: ${getRevision() || "unknown"})`);
});

// =====================================================================
// SEARCH IMPLEMENTATION (v1)
// =====================================================================

async function runFarmFieldSearch({ q, status, limit }) {
  const needle = norm(q);
  const includeArchived = status === "all";

  // farms
  const farmRows = await readCollectionScan("farms", includeArchived ? null : "active", 2000);
  const farmsMatched = farmRows
    .filter(f => scoreName(f.name, needle) > 0)
    .map(f => ({
      id: f.id,
      name: f.name || "",
      status: f.status || "active"
    }))
    .sort((a, b) => scoreName(b.name, needle) - scoreName(a.name, needle))
    .slice(0, limit);

  const farmById = new Map();
  for (const f of farmRows) farmById.set(f.id, { name: f.name || "", status: f.status || "" });

  // fields
  const fieldRows = await readCollectionScan("fields", includeArchived ? null : "active", 5000);
  const fieldsMatched = fieldRows
    .filter(fl => scoreName(fl.name, needle) > 0)
    .map(fl => {
      const farm = farmById.get(fl.farmId) || null;
      return {
        id: fl.id,
        name: fl.name || "",
        status: fl.status || "active",
        county: fl.county || "",
        state: fl.state || "",
        tillable: (typeof fl.tillable === "number" ? fl.tillable : null),
        farmId: fl.farmId || null,
        farmName: farm?.name || "",
        farmStatus: farm?.status || ""
      };
    })
    .sort((a, b) => scoreName(b.name, needle) - scoreName(a.name, needle))
    .slice(0, limit);

  return { farms: farmsMatched, fields: fieldsMatched };
}

async function readCollectionScan(collectionName, statusFilterValue, hardLimit) {
  let qq = db.collection(collectionName);
  if (statusFilterValue) qq = qq.where("status", "==", statusFilterValue);

  // Keep reads bounded
  qq = qq.limit(clampInt(hardLimit, 2000, 1, 10000));

  const snap = await qq.get();
  const rows = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    rows.push({
      id: doc.id,
      name: (d.name || "").toString(),
      status: (d.status || "").toString(),
      ...d
    });
  });
  return rows;
}

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function scoreName(name, needle) {
  const n = norm(name);
  if (!needle) return 0;
  if (!n) return 0;
  if (n === needle) return 100;
  if (n.startsWith(needle)) return 75;
  if (n.includes(needle)) return 25;
  return 0;
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// --- END OF FILE ---
