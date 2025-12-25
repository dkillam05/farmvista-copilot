import admin from "firebase-admin";

const COL = "copilot_logs";
const MAX_HISTORY = 12;

// Ensure Admin is initialized (safe if already initialized elsewhere)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

function nowTs() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function cleanStr(v) {
  return (v == null) ? "" : String(v);
}

// Simple, stable threadId without requiring frontend changes.
// You *can* override by sending req.body.threadId later.
export function getThreadId(req) {
  const bodyThread = cleanStr(req?.body?.threadId).trim();
  if (bodyThread) return bodyThread;

  const headerThread = cleanStr(req?.headers?.["x-fv-thread"]).trim();
  if (headerThread) return headerThread;

  const origin = cleanStr(req?.headers?.origin).trim() || "no-origin";
  const ua = cleanStr(req?.headers?.["user-agent"]).trim() || "no-ua";

  // Keep it short-ish and deterministic
  const raw = `${origin}::${ua}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return `anon-${Math.abs(hash)}`;
}

export async function appendLogTurn({ threadId, role, text, intent, meta }) {
  const doc = {
    threadId: cleanStr(threadId),
    role: cleanStr(role),          // "user" | "assistant"
    text: cleanStr(text),
    intent: intent ? cleanStr(intent) : null,
    meta: meta && typeof meta === "object" ? meta : null,
    createdAt: nowTs()
  };

  // Add-only (append log)
  await db.collection(COL).add(doc);
}

export async function loadRecentHistory(threadId) {
  const tid = cleanStr(threadId);
  if (!tid) return [];

  // newest first, then reverse for chronological
  const snap = await db.collection(COL)
    .where("threadId", "==", tid)
    .orderBy("createdAt", "desc")
    .limit(MAX_HISTORY)
    .get();

  const rows = [];
  snap.forEach(d => rows.push({ id: d.id, ...(d.data() || {}) }));
  rows.reverse();

  // Normalize history objects (what chat layer needs)
  return rows.map(r => ({
    role: cleanStr(r.role) || "user",
    text: cleanStr(r.text),
    intent: r.intent || null,
    createdAt: r.createdAt || null
  }));
}

export function deriveStateFromHistory(history) {
  // last assistant intent becomes the default for follow-ups
  let lastIntent = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === "assistant" && h.intent) {
      lastIntent = h.intent;
      break;
    }
  }

  return { lastIntent };
}