// index.js  (FULL FILE)
// Rev: 2026-01-02-search-v1 (Adds /search endpoint; default active; status=all supported)

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

import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(corsMiddleware());

function getRevision() {
  return process.env.K_REVISION || process.env.K_SERVICE || null;
}

// Ensure admin initialized (safe)
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Firestore company header doc (matches your predefined reports)
const COMPANY_DOC_PATH = ["company", "main"];

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
// - Beginner-simple + predictable (no AI, no tools)
// --------------------
app.get("/search", async (req, res) => {
  const q = (req.query?.q || "").toString().trim();
  const status = (req.query?.status || "active").toString().trim().toLowerCase(); // active|all
  const limit = clampInt(req.query?.limit, 20, 1, 50);

  if (!q || q.length < 2) {
    return res.status(400).json({
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
  if (!question) return res.status(400).json({ error: "Missing question", revision: getRevision() });

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
    out = { answer: `Backend error: ${e?.message || String(e)}`, meta: { error: true } };
  }

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
// Report (PDF)
// --------------------
// GET  /report?threadId=xxx&mode=recent|conversation&title=...
// POST /report { threadId, mode, title }
// --------------------
app.get("/report", async (req, res) => {
  const mode = (req.query?.mode || "recent").toString().trim().toLowerCase();
  const threadId = (req.query?.threadId || "").toString().trim() || getThreadId(req);
  const titleOverride = (req.query?.title || "").toString().trim();

  try {
    const pdf = await buildReportPdf({ threadId, mode, titleOverride });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="FarmVista-Report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("[report] failed:", e?.stack || e);
    return res.status(500).json({
      error: "Report generation failed",
      detail: e?.message || String(e),
      revision: getRevision()
    });
  }
});

app.post("/report", async (req, res) => {
  const mode = (req.body?.mode || "recent").toString().trim().toLowerCase();
  const threadId = (req.body?.threadId || "").toString().trim() || getThreadId(req);
  const titleOverride = (req.body?.title || "").toString().trim();

  try {
    const pdf = await buildReportPdf({ threadId, mode, titleOverride });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="FarmVista-Report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("[report] failed:", e?.stack || e);
    return res.status(500).json({
      error: "Report generation failed",
      detail: e?.message || String(e),
      revision: getRevision()
    });
  }
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

  // 1) Load farms (small collection; v1 uses simple scan)
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

  // Farm map for join
  const farmById = new Map();
  for (const f of farmRows) farmById.set(f.id, { name: f.name || "", status: f.status || "" });

  // 2) Load fields (scan + match)
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

  return {
    farms: farmsMatched,
    fields: fieldsMatched
  };
}

async function readCollectionScan(collectionName, statusFilterValue, hardLimit) {
  let q = db.collection(collectionName);
  if (statusFilterValue) q = q.where("status", "==", statusFilterValue);

  // Keep reads bounded
  q = q.limit(clampInt(hardLimit, 2000, 1, 10000));

  const snap = await q.get();
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

// scoring: startsWith > contains > none
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

// --------------------
// Report builder (unchanged)
// --------------------
async function buildReportPdf({ threadId, mode, titleOverride }) {
  if (!threadId) throw new Error("Missing threadId");

  const history = await loadRecentHistory(threadId);

  // Keep ONLY assistant answers that are meaningful
  const assistants = history
    .filter(h => h.role === "assistant" && (h.text || "").trim())
    .map(h => ({ ...h, text: String(h.text || "") }))
    .filter(h => !isJunkAssistantTurn(h.text));

  if (!assistants.length) throw new Error("No assistant answers found for this thread.");

  // Choose turns:
  // - recent: last meaningful answer ONLY (last topic only)
  // - conversation: keep all meaningful answers
  const selected = (mode === "conversation") ? assistants : assistants.slice(-1);

  const company = await loadCompanyHeaderSafe();

  const inferredTitle = inferReportTitle(history, selected);
  const title = titleOverride || inferredTitle || "FarmVista Report";

  const generatedAt = new Date();
  const generatedAtStr = generatedAt.toLocaleString(undefined, { year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
  const generatedDateOnly = generatedAt.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });

  const sections = selected.map((a, idx) => {
    const cleanText = sanitizeForReport(a.text);
    return {
      heading: makeSectionHeading(cleanText, idx),
      text: cleanText
    };
  }).filter(s => (s.text || "").trim());

  if (!sections.length) throw new Error("No reportable content found.");

  const html = buildFarmVistaStyleReportHtml({
    title,
    subtitle: "Generated from FarmVista Copilot responses (share / print ready).",
    company,
    generatedAtStr,
    generatedDateOnly,
    mode,
    sections
  });

  // Convert HTML -> PDF via your existing service
  const pdfResp = await fetch("https://farmvista-pdf-300398089669.us-central1.run.app/pdf-html", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html })
  });

  if (!pdfResp.ok) {
    const t = await safeReadText(pdfResp);
    throw new Error(`PDF service failed (${pdfResp.status}): ${t || pdfResp.statusText}`);
  }

  return Buffer.from(await pdfResp.arrayBuffer());
}

function isJunkAssistantTurn(text) {
  const t = String(text || "").trim();
  if (!t) return true;

  const low = t.toLowerCase();

  // PDF marker output
  if (low.startsWith("[[fv_pdf]]:")) return true;

  // Report trigger chatter
  if (low.includes("report ready") && low.includes("opening the pdf")) return true;

  // Old CLI-style help blocks
  if (low.startsWith("try:")) return true;

  return false;
}

function sanitizeForReport(text) {
  let t = String(text || "").trim();
  if (!t) return "";

  // Remove bracketed internal markers like [FV-READINESS-LATEST]
  t = t.replace(/^\[[^\]]+\]\s*/gm, "");

  // Remove "Snapshot ..." / "Revision ..." lines (user should not see internals)
  t = t.replace(/^\s*(snapshot|revision)\s*:\s*.*$/gmi, "");

  // Remove any leftover CLI menu blocks starting with "Try:"
  // (wipe from "Try:" to end)
  t = t.replace(/\n?^\s*Try:\s*[\s\S]*$/gmi, "");

  // Remove obvious "Rev: 2025-..." style tags if they appear in content
  t = t.replace(/^\s*Rev:\s*.*$/gmi, "");

  // Collapse excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return t;
}

function inferReportTitle(history, selected) {
  // Prefer the most recent user question before the first included assistant turn
  const first = selected[0];
  const idx = history.indexOf(first);
  for (let i = idx - 1; i >= 0; i--) {
    if (history[i].role === "user" && (history[i].text || "").trim()) {
      return String(history[i].text).trim().slice(0, 72);
    }
  }
  // Fallback: first non-empty line of first assistant answer
  const firstLine = String(first?.text || "").split("\n").find(s => s.trim());
  return (firstLine || "FarmVista Copilot Report").slice(0, 72);
}

function makeSectionHeading(text, idx) {
  const lines = String(text || "").split("\n").map(s => s.trim()).filter(Boolean);
  const first = lines[0] || `Section ${idx + 1}`;

  const cleaned = first
    .replace(/^field readiness latest\s*/i, "Field Readiness")
    .replace(/^equipment summary\s*/i, "Equipment Summary")
    .trim();

  return cleaned.slice(0, 64) || `Section ${idx + 1}`;
}

async function loadCompanyHeaderSafe() {
  try {
    const [col, id] = COMPANY_DOC_PATH;
    const snap = await db.doc(`${col}/${id}`).get();
    const d = snap.exists ? (snap.data() || {}) : {};

    const name = d.name || "";
    const address = [
      d.addressStreet || "",
      [d.addressCity, d.addressState].filter(Boolean).join(", "),
      d.addressZip || ""
    ].filter(Boolean).join(" · ");
    const phone = d.phone || "";
    const email = d.email || "";
    const logoUrl = d?.logo?.url || d?.logoUrl || "";

    return { name, address, phone, email, logoUrl };
  } catch (e) {
    console.warn("[report] company header load failed:", e?.message || e);
    return { name: "", address: "", phone: "", email: "", logoUrl: "" };
  }
}

function buildFarmVistaStyleReportHtml({ title, subtitle, company, generatedAtStr, generatedDateOnly, mode, sections }) {
  const co = company || {};
  const coName = esc(co.name || "Dowson Farms");
  const coLine = esc(co.address || "");
  const coPhone = esc(co.phone || "");
  const coEmail = esc(co.email || "");
  const logoUrl = (co.logoUrl || "").toString().trim();

  const safeTitle = esc(title || "FarmVista Report");
  const safeSubtitle = esc(subtitle || "");
  const safeMode = esc(mode || "recent");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <style>
    :root{
      --fv-green:#3B7E46;
      --fv-accent:#2F6C3C;
      --fv-border:#D1D5DB;
      --fv-text:#111827;
      --fv-muted:#6B7280;
      --fv-bg:#F3F4F6;
    }
    *{box-sizing:border-box;}
    html,body{ margin:0; padding:0; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fv-text); background:var(--fv-bg); }
    body{ display:flex; justify-content:center; padding:22px 12px; }
    .page{ width:100%; max-width:980px; background:#fff; border-radius:14px; box-shadow:0 10px 30px rgba(15,23,42,0.12); padding:20px 22px 22px; }

    .hdr{
      display:grid;
      grid-template-columns:auto 1fr auto;
      gap:14px;
      align-items:center;
      border-bottom:2px solid var(--fv-green);
      padding-bottom:12px;
      margin-bottom:14px;
    }
    .logo{
      width:60px;height:60px;border-radius:16px;
      border:1px solid var(--fv-border);
      display:flex;align-items:center;justify-content:center;
      overflow:hidden;
      background:#fff;
    }
    .logo img{ width:100%; height:100%; object-fit:cover; display:block; }
    .logo-fallback{
      width:60px;height:60px;border-radius:16px;
      border:1px solid var(--fv-border);
      display:flex;align-items:center;justify-content:center;
      font-size:20px;font-weight:950;color:#fff;
      background:radial-gradient(circle at 30% 0%, #4CAF50, var(--fv-green));
    }

    .co-name{font-size:16px;font-weight:950;margin:0 0 2px;}
    .co-line{font-size:11px;color:var(--fv-muted);margin:0;line-height:1.35;}
    .meta{ text-align:right; font-size:11px; color:var(--fv-muted); line-height:1.35; white-space:nowrap; }
    .meta strong{color:var(--fv-text);}

    .title{ margin:0; font-size:18px; font-weight:950; letter-spacing:0.06em; text-transform:uppercase; }
    .subtitle{ margin:4px 0 0; font-size:12px; color:var(--fv-muted); line-height:1.35; }

    .summary{
      margin-top:10px; padding:8px 10px; border-radius:12px;
      background:linear-gradient(90deg, rgba(59,126,70,0.10), transparent);
      border:1px solid rgba(59,126,70,0.22);
      display:flex; flex-wrap:wrap; gap:6px 14px; font-size:11px;
    }
    .pill{display:inline-flex; gap:6px; align-items:baseline; white-space:nowrap;}
    .k{font-size:10px; text-transform:uppercase; letter-spacing:0.10em; color:var(--fv-muted); font-weight:800;}
    .v{font-weight:900; color:var(--fv-text);}

    .section{ margin-top:16px; border-top:1px solid #EEF2F7; padding-top:14px; }
    .sec-title{
      margin:0 0 8px;
      font-size:12px;
      font-weight:950;
      letter-spacing:0.10em;
      text-transform:uppercase;
      color:#111827;
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:baseline;
    }
    .card{
      border:1px solid var(--fv-border);
      border-radius:12px;
      padding:12px 14px;
      background:#fff;
      white-space:pre-wrap;
      line-height:1.45;
      font-size:13px;
      break-inside:avoid;
      page-break-inside:avoid;
    }

    .footer{
      margin-top:16px; padding-top:10px; border-top:1px solid var(--fv-border);
      display:flex; justify-content:space-between; gap:12px;
      font-size:10px; color:var(--fv-muted); line-height:1.3;
    }

    @media print{
      html,body{background:#fff;padding:0;}
      body{box-shadow:none;}
      .page{ max-width:none; border-radius:0; box-shadow:none; padding:9mm 10mm; }
      .meta{white-space:normal;}
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="hdr">
      ${
        logoUrl
          ? `<div class="logo"><img src="${esc(logoUrl)}" alt="Company logo"></div>`
          : `<div class="logo-fallback"><span>FV</span></div>`
      }
      <div>
        <p class="co-name">${coName}</p>
        <p class="co-line">
          ${coLine ? `${coLine}<br>` : ""}
          ${coPhone ? `Phone: ${coPhone}` : ""}${coPhone && coEmail ? " · " : ""}${coEmail ? `Email: ${coEmail}` : ""}
        </p>
      </div>
      <div class="meta">
        <div><strong>FarmVista Report</strong></div>
        <div>Generated: ${esc(generatedAtStr)}</div>
        <div>Mode: ${safeMode}</div>
      </div>
    </header>

    <h1 class="title">${safeTitle}</h1>
    <p class="subtitle">${safeSubtitle}</p>

    <div class="summary">
      <div class="pill"><span class="k">Sections</span><span class="v">${sections.length}</span></div>
      <div class="pill"><span class="k">Prepared</span><span class="v">${esc(co.name || "FarmVista")}</span></div>
      <div class="pill"><span class="k">Date</span><span class="v">${esc(generatedDateOnly)}</span></div>
    </div>

    ${sections.map((s, idx) => `
      <section class="section">
        <div class="sec-title">
          <span>${esc(s.heading || `Section ${idx+1}`)}</span>
        </div>
        <div class="card">${esc(s.text || "")}</div>
      </section>
    `).join("")}

    <footer class="footer">
      <div class="l">Prepared for sharing and printing. Content reflects FarmVista Copilot responses.</div>
      <div class="r">FarmVista • ${esc(generatedDateOnly)}</div>
    </footer>
  </div>
</body>
</html>`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ""; }
}
