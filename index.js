// index.js  (FULL FILE)
// Rev: 2025-12-30-chat-guard  (Hard try/catch around /chat to avoid 503s and expose real errors)

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

function getRevision() {
  return process.env.K_REVISION || process.env.K_SERVICE || null;
}

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
// Chat  (GUARDED)
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const question = (req.body?.question || "").toString().trim();
    if (!question) return res.status(400).json({ error: "Missing question", revision: getRevision() });

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
      console.warn("[copilot_logs] logging failed:", e?.message || e);
    }

    return res.json({
      ...out,
      meta: {
        ...(out?.meta || {}),
        threadId,
        snapshotId: snap.activeSnapshotId || null,
        gcsPath: snap.gcsPath || null,
        revision: getRevision()
      }
    });
  } catch (e) {
    // ✅ This is the key: no more mysterious 503s.
    console.error("[/chat] crash:", e?.stack || e);
    return res.status(200).json({
      answer: `Backend error in /chat: ${e?.message || String(e)}`,
      meta: {
        error: true,
        revision: getRevision()
      }
    });
  }
});

// --------------------
// Report (PDF)  (unchanged)
// --------------------
app.get("/report", async (req, res) => {
  const mode = (req.query?.mode || "recent").toString().trim().toLowerCase();
  const threadId = (req.query?.threadId || "").toString().trim() || getThreadId(req);

  try {
    const pdf = await buildReportPdf({ threadId, mode });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="FarmVista-Report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("[report] failed:", e?.message || e);
    return res.status(500).json({ error: "Report generation failed", detail: e?.message || String(e), revision: getRevision() });
  }
});

app.post("/report", async (req, res) => {
  const mode = (req.body?.mode || "recent").toString().trim().toLowerCase();
  const threadId = (req.body?.threadId || "").toString().trim() || getThreadId(req);

  try {
    const pdf = await buildReportPdf({ threadId, mode });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="FarmVista-Report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("[report] failed:", e?.message || e);
    return res.status(500).json({ error: "Report generation failed", detail: e?.message || String(e), revision: getRevision() });
  }
});

// --------------------
// Start server
// --------------------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`🚜 FarmVista Copilot running on port ${PORT} (rev: ${getRevision() || "unknown"})`);
});

// --------------------
// Report builder (same as your current)
// --------------------
async function buildReportPdf({ threadId, mode }) {
  if (!threadId) throw new Error("Missing threadId");

  const history = await loadRecentHistory(threadId);
  const assistants = history.filter(h => h.role === "assistant" && (h.text || "").trim());

  if (!assistants.length) throw new Error("No assistant answers found for this thread.");

  const selected = (mode === "conversation") ? assistants : assistants.slice(-3);

  const snap = await loadSnapshot({ force: false });
  const snapshotId = snap.activeSnapshotId || selected[selected.length - 1]?.meta?.snapshotId || "unknown";
  const generatedAt = new Date().toLocaleString();

  const html = buildReportHtml({
    title: inferReportTitle(history, selected),
    snapshotId,
    generatedAt,
    revision: getRevision() || "unknown",
    sections: selected.map((a, idx) => ({
      heading: `Section ${idx + 1}`,
      text: a.text
    }))
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
    const t = await safeReadText(pdfResp);
    throw new Error(`PDF service failed (${pdfResp.status}): ${t || pdfResp.statusText}`);
  }

  return Buffer.from(await pdfResp.arrayBuffer());
}

function inferReportTitle(history, selected) {
  const firstAssistant = selected[0];
  const idx = history.indexOf(firstAssistant);
  for (let i = idx - 1; i >= 0; i--) {
    if (history[i].role === "user" && (history[i].text || "").trim()) {
      return String(history[i].text).trim().slice(0, 72);
    }
  }
  return "FarmVista Copilot Report";
}

function buildReportHtml({ title, snapshotId, generatedAt, revision, sections }) {
  const safeTitle = esc(title);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    :root{--fv-green:#3B7E46;--border:#D1D5DB;--muted:#6B7280;--bg:#F3F4F6;}
    *{box-sizing:border-box;}
    body{margin:0;padding:22px;background:var(--bg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#111827;display:flex;justify-content:center;}
    .page{width:100%;max-width:980px;background:#fff;border-radius:14px;box-shadow:0 10px 30px rgba(15,23,42,.12);padding:20px 22px 22px;}
    .hdr{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:flex-start;border-bottom:2px solid var(--fv-green);padding-bottom:12px;margin-bottom:14px;}
    .title{margin:0;font-size:18px;font-weight:950;letter-spacing:.06em;text-transform:uppercase;}
    .meta{font-size:11px;color:var(--muted);line-height:1.35;text-align:right;white-space:nowrap;}
    .summary{margin-top:10px;padding:8px 10px;border-radius:12px;background:linear-gradient(90deg, rgba(59,126,70,.10), transparent);border:1px solid rgba(59,126,70,.22);font-size:11px;display:flex;gap:14px;flex-wrap:wrap;}
    .section{margin-top:16px;padding-top:14px;border-top:1px solid #EEF2F7;break-inside:avoid;page-break-inside:avoid;}
    .section h2{margin:0 0 8px;font-size:12px;font-weight:950;letter-spacing:.10em;text-transform:uppercase;color:#111827;}
    .card{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:#fff;white-space:pre-wrap;line-height:1.45;font-size:13px;}
    .footer{margin-top:18px;padding-top:10px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;font-size:10px;color:var(--muted);}
    @media print{body{padding:0;background:#fff;}.page{max-width:none;border-radius:0;box-shadow:none;padding:9mm 10mm;}.meta{white-space:normal;}}
  </style>
</head>
<body>
  <div class="page">
    <header class="hdr">
      <h1 class="title">${safeTitle}</h1>
      <div class="meta">
        Snapshot: ${esc(snapshotId)}<br>
        Generated: ${esc(generatedAt)}<br>
        Revision: ${esc(revision)}
      </div>
    </header>

    <div class="summary">
      <strong>FarmVista Copilot Report</strong>
      <span>Sections: ${sections.length}</span>
      <span>Mode: ${esc(String(sections.length > 3 ? "conversation" : "recent"))}</span>
    </div>

    ${sections.map(s => `
      <section class="section">
        <h2>${esc(s.heading)}</h2>
        <div class="card">${esc(s.text)}</div>
      </section>
    `).join("")}

    <footer class="footer">
      <div>Prepared via FarmVista Copilot</div>
      <div>View / Share / Save</div>
    </footer>
  </div>
</body>
</html>`;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ""; }
}
