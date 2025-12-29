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
// Report (PDF)
// --------------------
// Supports:
// - last 3 assistant answers (default)
// - entire conversation (?mode=conversation)
// - auto title inference
// - branded FarmVista layout
//
// GET  /report?threadId=xxx&mode=conversation
// POST /report { threadId, mode? }
// --------------------
app.get("/report", async (req, res) => {
  const threadId = (req.query?.threadId || "").toString().trim();
  const mode = (req.query?.mode || "recent").toString();

  if (!threadId) {
    return res.status(400).json({ error: "Missing threadId" });
  }

  const history = await loadRecentHistory(threadId);
  const assistantTurns = history.filter(h => h.role === "assistant");

  if (!assistantTurns.length) {
    return res.status(400).json({ error: "No assistant answers to report" });
  }

  const selected =
    mode === "conversation"
      ? assistantTurns
      : assistantTurns.slice(-3);

  const title = inferReportTitle(history, selected);
  const body = selected.map(a => a.text).join("\n\n— — —\n\n");

  const html = buildReportHtml({
    title,
    body,
    snapshotId: selected[selected.length - 1]?.meta?.snapshotId || "unknown"
  });

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
function inferReportTitle(history, assistants) {
  // Try last user question before first included assistant
  const firstAssistantIdx = history.indexOf(assistants[0]);
  for (let i = firstAssistantIdx - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      return history[i].text.slice(0, 60);
    }
  }
  return "FarmVista Report";
}

function buildReportHtml({ title, body, snapshotId }) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      padding: 36px;
      color: #111;
    }
    h1 {
      color: #3B7E46;
      margin-bottom: 4px;
    }
    .meta {
      font-size: 12px;
      color: #666;
      margin-bottom: 24px;
    }
    pre {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.45;
    }
    .footer {
      margin-top: 32px;
      font-size: 11px;
      color: #777;
      border-top: 1px solid #ddd;
      padding-top: 10px;
    }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">
    Snapshot: ${esc(snapshotId)}<br>
    Generated: ${new Date().toLocaleString()}
  </div>

  <pre>${esc(body)}</pre>

  <div class="footer">
    Generated by FarmVista Copilot
  </div>
</body>
</html>
`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
