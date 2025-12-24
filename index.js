import express from "express";

import { corsMiddleware } from "./utils/cors.js";
import { getSnapshotStatus, reloadSnapshot, loadSnapshot } from "./context/snapshot.js";
import { handleChat } from "./chat/handleChat.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(corsMiddleware());

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "farmvista-copilot",
    ts: new Date().toISOString()
  });
});

// --------------------
// Snapshot status / reload
// --------------------
app.get("/context/status", async (req, res) => {
  res.json(await getSnapshotStatus());
});

app.post("/context/reload", async (req, res) => {
  res.json(await reloadSnapshot());
});

// --------------------
// Chat
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing question" });

  // Ensure snapshot is loaded (cached internally)
  const snap = await loadSnapshot({ force: false });

  // Chat router decides which feature answers
  const out = await handleChat({ question, snapshot: snap });

  res.json(out);
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
});
