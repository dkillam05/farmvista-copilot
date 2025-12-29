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
// GET /report?threadId=xxx&mode=recent|conversation
// --------------------
app.get("/report", async (req, res) => {
  const threadId = (req.query?.threadId || "").toString().trim();
  const mode = (req.query?.mode || "recent").toString();

  if (!threadId) {
    return res.status(400).json({ error: "Missing threadId" });
  }

  const history = await loadRecentHistory(threadId);
  const assistants = history.filter(h => h.role === "assistant");

  if (!assistants.length) {
    return res.status(400).json({ error: "No assistant content to report" });
  }

  const selected =
    mode === "conversation"
      ? assistants
      : assistants.slice(-3);

  const title = inferTitle(history, selected);
  const bodySections = selected.map((a, i) => ({
    heading: `Section ${i + 1}`,
    text: a.text
  }));

  const html = buildReportHtml({
    title,
    sections: bodySections,
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
function inferTitle(history, sections) {
  const first = history.find(h => h.role === "user");
  if (first?.text) return first.text.slice(0, 64);
  return "FarmVista Report";
}

function buildReportHtml({ title, sections, snapshotId }) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    :root{
      --fv-green:#3B7E46;
      --border:#D1D5DB;
      --muted:#6B7280;
      --bg:#F3F4F6;
    }
    *{box-sizing:border-box;}
    body{
      margin:0;
      padding:22px;
      background:var(--bg);
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
      color:#111827;
      display:flex;
      justify-content:center;
    }
    .page{
      width:100%;
      max-width:980px;
      background:#fff;
      border-radius:14px;
      box-shadow:0 10px 30px rgba(15,23,42,.12);
      padding:20px 22px 22px;
    }
    .hdr{
      display:grid;
      grid-template-columns:1fr auto;
      gap:12px;
      align-items:flex-start;
      border-bottom:2px solid var(--fv-green);
      padding-bottom:12px;
      margin-bottom:14px;
    }
    .title{
      margin:0;
      font-size:20px;
      font-weight:950;
      letter-spacing:.06em;
      text-transform:uppercase;
    }
    .meta{
      font-size:11px;
      color:var(--muted);
      line-height:1.35;
      text-align:right;
    }
    .summary{
      margin-top:10px;
      padding:8px 10px;
      border-radius:12px;
      background:linear-gradient(90deg, rgba(59,126,70,.10), transparent);
      border:1px solid rgba(59,126,70,.22);
      font-size:11px;
      display:flex;
      gap:14px;
      flex-wrap:wrap;
    }
    .section{
      margin-top:16px;
      padding-top:14px;
      border-top:1px solid #EEF2F7;
    }
    .section h2{
      margin:0 0 8px;
      font-size:13px;
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      color:#111827;
    }
    .card{
      border:1px solid var(--border);
      border-radius:12px;
      padding:12px 14px;
      background:#fff;
      white-space:pre-wrap;
      line-height:1.45;
      font-size:13px;
    }
    .footer{
      margin-top:18px;
      padding-top:10px;
      border-top:1px solid var(--border);
      display:flex;
      justify-content:space-between;
      gap:12px;
      font-size:10px;
      color:var(--muted);
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="hdr">
      <h1 class="title">${esc(title)}</h1>
      <div class="meta">
        Snapshot: ${esc(snapshotId)}<br>
        Generated: ${new Date().toLocaleString()}
      </div>
    </header>

    <div class="summary">
      <strong>FarmVista Copilot Report</strong>
      <span>Sections: ${sections.length}</span>
    </div>

    ${sections.map(s => `
      <section class="section">
        <h2>${esc(s.heading)}</h2>
        <div class="card">${esc(s.text)}</div>
      </section>
    `).join('')}

    <footer class="footer">
      <div>Prepared via FarmVista Copilot</div>
      <div>For sharing & printing</div>
    </footer>
  </div>
</body>
</html>`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
