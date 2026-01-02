// /index.js  (FULL FILE)
// Rev: 2026-01-02-min-core0
//
// Minimal, deterministic Copilot core (NO LLM):
// ✅ /health
// ✅ /context/status + /context/reload
// ✅ /chat  (snapshot-backed field + RTK tower answers only)

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
// Chat (deterministic)
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ ok: false, error: "Missing question", revision: getRevision() });

  const snap = await loadSnapshot({ force: false });

  const out = await handleChat({
    question,
    snapshot: snap
  });

  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      snapshotId: snap.activeSnapshotId || null,
      source: snap.source || null,
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
  console.log(`🚜 FarmVista Copilot (minimal) running on port ${PORT} (rev: ${getRevision()})`);
});
