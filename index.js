// index.js  (FULL FILE)

import express from "express";

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

  const threadId = getThreadId(req);

  const history = await loadRecentHistory(threadId);
  const state = deriveStateFromHistory(history);

  const snap = await loadSnapshot({ force: false });

  const out = await handleChat({
    question,
    snapshot: snap,
    history,
    state
  });

  const intent =
    out?.meta?.intent ||
    (Array.isArray(out?.meta?.intents) ? out.meta.intents[0] : null) ||
    null;

  try {
    await appendLogTurn({
      threadId,
      role: "user",
      text: question,
      intent: null,
      meta: { snapshotId: snap.activeSnapshotId || null }
    });

    await appendLogTurn({
      threadId,
      role: "assistant",
      text: out?.answer || "",
      intent,
      meta: out?.meta || null
    });
  } catch (e) {
    console.warn("[copilot_logs] logging failed:", e?.message || e);
  }

  res.json({
    ...out,
    meta: {
      ...(out?.meta || {}),
      threadId
    }
  });
});

// --------------------
// Report (PDF from last assistant answer)
// --------------------
app.post("/report", async (req, res) => {
  const threadId = (req.body?.threadId || "").toString().trim();
  if (!threadId) {
    return res.status(400).json({ error: "Missing threadId" });
  }

  // Load chat history
  const history = await loadRecentHistory(threadId);

  // Find LAST assistant message
  const lastAssistant = [...history].reverse().find(h => h.role === "assistant");

  if (!lastAssistant || !lastAssistant.text) {
    return res.status(400).json({ error: "No assistant answer found" });
  }

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>FarmVista Report</title>
  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      padding: 32px;
      color: #111;
    }
    h1 {
      color: #3B7E46;
      margin-bottom: 6px;
    }
    .meta {
      color: #666;
      font-size: 12px;
      margin-bottom: 20px;
    }
    pre {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <h1>FarmVista Copilot Report</h1>
  <div class="meta">
    Snapshot: ${escapeHtml(lastAssistant.meta?.snapshotId || "unknown")}<br>
    Generated: ${new Date().toLocaleString()}
  </div>
  <pre>${escapeHtml(lastAssistant.text)}</pre>
</body>
</html>
`;

  // Call existing PDF service
  const pdfResp = await fetch(
    "https://farmvista-pdf-300398089669.us-central1.run.app/pdf-html",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html })
    }
  );

  if (!pdfResp.ok) {
    const t = await pdfResp.text();
    console.error("[pdf] failed:", t);
    return res.status(500).json({ error: "PDF generation failed" });
  }

  const buf = Buffer.from(await pdfResp.arrayBuffer());

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=FarmVista-Report.pdf");
  res.send(buf);
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT}`);
});

// --------------------
// helpers
// --------------------
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
