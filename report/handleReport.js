// report/handleReport.js  (FULL FILE)

import { handleChat } from "../chat/handleChat.js";
import { renderReportHtml } from "./renderHtml.js";

// Your existing farmvista-pdf Cloud Run endpoint (HTML -> PDF)
// You can override with env var on Cloud Run.
const PDF_SERVICE_URL =
  (process.env.PDF_SERVICE_URL || "").trim() ||
  "https://farmvista-pdf-300398089669.us-central1.run.app/pdf-html";

/**
 * Builds a PDF report (Buffer) from an existing “question” by:
 *  1) using the same chat router to generate the content
 *  2) rendering a consistent HTML report
 *  3) calling the PDF service to convert HTML -> PDF
 */
export async function handleReport({ question, title, paper, orientation, snapshot }) {
  const q = (question || "").toString().trim();
  if (!q) throw new Error("Missing question");

  // Re-use your existing feature routing output.
  // (No big refactors yet — this keeps it fast + consistent.)
  const out = await handleChat({ question: q, snapshot });

  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  const meta = out?.meta || {};

  const reportTitle =
    (title && title.trim()) ||
    autoTitleFromQuestion(q);

  const html = renderReportHtml({
    title: reportTitle,
    question: q,
    answerText: out?.answer || "",
    snapshotId,
    generatedAtIso: new Date().toISOString(),
    meta
  });

  const pdf = await htmlToPdf({ html, paper, orientation });
  return pdf;
}

function autoTitleFromQuestion(q) {
  const s = q.replace(/\s+/g, " ").trim();
  if (!s) return "FarmVista Report";
  // Keep title short
  const max = 64;
  return (s.length > max) ? (s.slice(0, max - 1) + "…") : s;
}

async function htmlToPdf({ html, paper, orientation }) {
  if (!PDF_SERVICE_URL) throw new Error("PDF_SERVICE_URL not configured");

  // IMPORTANT:
  // I don’t know your pdf service request schema with 100% certainty.
  // This payload is the most common pattern: { html, ...options }.
  // If your service expects a different shape, tell me the expected JSON and I’ll adjust.
  const payload = {
    html,
    paper: (paper || "letter"),
    orientation: (orientation || "portrait")
  };

  const resp = await fetch(PDF_SERVICE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const text = await safeReadText(resp);
    throw new Error(`PDF service error (${resp.status}): ${text || resp.statusText}`);
  }

  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
