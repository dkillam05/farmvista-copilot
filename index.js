// index.js  (FULL FILE)

import express from "express";

import { corsMiddleware } from "./utils/cors.js";
import { getSnapshotStatus, reloadSnapshot, loadSnapshot } from "./context/snapshot.js";
import { handleChat } from "./chat/handleChat.js";

import { getThreadId, loadRecentHistory, deriveStateFromHistory, appendLogTurn } from "./context/copilotLogs.js";

// NEW (reports)
import { handleReport } from "./report/handleReport.js";

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
// Chat (now conversational)
// --------------------
app.post("/chat", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing question" });

  const threadId = getThreadId(req);

  // Load recent conversation history (from copilot_logs)
  const history = await loadRecentHistory(threadId);
  const state = deriveStateFromHistory(history);

  // Ensure snapshot is loaded (cached internally)
  const snap = await loadSnapshot({ force: false });

  // Ask the router (now with history + state)
  const out = await handleChat({
    question,
    snapshot: snap,
    history,
    state
  });

  // Try to capture a single “intent” for follow-ups
  const intent =
    (out && out.meta && out.meta.intent) ? out.meta.intent :
    (out && out.meta && Array.isArray(out.meta.intents) && out.meta.intents[0]) ? out.meta.intents[0] :
    null;

  // Log both sides
  try {
    await appendLogTurn({ threadId, role: "user", text: question, intent: null, meta: { snapshotId: snap.activeSnapshotId || null } });
    await appendLogTurn({ threadId, role: "assistant", text: out?.answer || "", intent, meta: out?.meta || null });
  } catch (e) {
    // Don’t break chat if logging fails
    console.warn("[copilot_logs] logging failed:", e?.message || e);
  }

  // Return threadId so you can persist it in the browser later (optional)
  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      threadId
    }
  });
});

// --------------------
// Report (PDF) — NO SAVING, just view/share
// --------------------
// POST /report  { question, title?, paper?, orientation? }
app.post("/report", async (req, res) => {
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing question" });

  // Optional presentation knobs (safe defaults)
  const title = (req.body?.title || "").toString().trim();
  const paper = (req.body?.paper || "letter").toString().trim();         // letter|a4 (depends on pdf service)
  const orientation = (req.body?.orientation || "portrait").toString().trim(); // portrait|landscape

  // Ensure snapshot is loaded
  const snap = await loadSnapshot({ force: false });

  try {
    const pdfBuf = await handleReport({
      question,
      title,
      paper,
      orientation,
      snapshot: snap
    });

    const safeName = (title || "FarmVista-Report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName || "FarmVista-Report"}.pdf"`);
    res.status(200).send(pdfBuf);
  } catch (e) {
    console.error("[report] failed:", e?.message || e);
    res.status(500).json({ error: "Report generation failed", detail: e?.message || String(e) });
  }
});

// GET /report?question=... (handy for testing / “open in new tab”)
app.get("/report", async (req, res) => {
  const question = (req.query?.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "Missing question" });

  const title = (req.query?.title || "").toString().trim();
  const paper = (req.query?.paper || "letter").toString().trim();
  const orientation = (req.query?.orientation || "portrait").toString().trim();

  const snap = await loadSnapshot({ force: false });

  try {
    const pdfBuf = await handleReport({
      question,
      title,
      paper,
      orientation,
      snapshot: snap
    });

    const safeName = (title || "FarmVista-Report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName || "FarmVista-Report"}.pdf"`);
    res.status(200).send(pdfBuf);
  } catch (e) {
    console.error("[report] failed:", e?.message || e);
    res.status(500).json({ error: "Report generation failed", detail: e?.message || String(e) });
  }
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
});
