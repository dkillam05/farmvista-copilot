// /context/copilotLogs.js  (FULL FILE)
// Rev: 2025-12-30a
//
// Fix (per Dane):
// ✅ NO MORE 503s when Firestore index is missing.
//    - loadRecentHistory() gracefully falls back to a threadId-only query (no orderBy),
//      and if that still fails, returns [].
//    - appendLogTurn() never throws (best-effort logging).
// ✅ Keeps your threadId logic EXACTLY.
// ✅ Keeps deriveStateFromHistory EXACTLY.
//
// NOTE:
// - Best fix is still to CREATE the composite index Google links you to.
// - This file makes the system resilient even before the index finishes building.

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

  // Best-effort logging: never throw (prevents chat failures)
  try {
    await db.collection(COL).add(doc);
  } catch (e) {
    console.warn("[copilot_logs] appendLogTurn failed:", e?.message || e);
  }
}

function isMissingIndexError(e) {
  const msg = (e?.message || "").toString();
  // Firestore index missing typically shows FAILED_PRECONDITION and "requires an index"
  return msg.includes("FAILED_PRECONDITION") && msg.toLowerCase().includes("requires an index");
}

export async function loadRecentHistory(threadId) {
  const tid = cleanStr(threadId).trim();
  if (!tid) return [];

  // 1) Preferred query (chronological via createdAt) — requires composite index
  try {
    const snap = await db.collection(COL)
      .where("threadId", "==", tid)
      .orderBy("createdAt", "desc")
      .limit(MAX_HISTORY)
      .get();

    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...(d.data() || {}) }));
    rows.reverse();

    return rows.map(r => ({
      role: cleanStr(r.role) || "user",
      text: cleanStr(r.text),
      intent: r.intent || null,
      createdAt: r.createdAt || null
    }));
  } catch (e) {
    // If missing index, fall back. Otherwise still fall back, but log.
    if (isMissingIndexError(e)) {
      console.warn("[copilot_logs] missing index for history query — using fallback (no orderBy)");
    } else {
      console.warn("[copilot_logs] history query failed — using fallback:", e?.message || e);
    }
  }

  // 2) Fallback query (no orderBy) — avoids composite index
  //    NOTE: Firestore will return in unspecified order; we sort client-side when possible.
  try {
    const snap = await db.collection(COL)
      .where("threadId", "==", tid)
      .limit(MAX_HISTORY)
      .get();

    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...(d.data() || {}) }));

    // Try to sort by createdAt client-side (if timestamps present)
    rows.sort((a, b) => {
      const at = a?.createdAt?.toMillis ? a.createdAt.toMillis() :
                 (typeof a?.createdAt?.seconds === "number" ? a.createdAt.seconds * 1000 : 0);
      const bt = b?.createdAt?.toMillis ? b.createdAt.toMillis() :
                 (typeof b?.createdAt?.seconds === "number" ? b.createdAt.seconds * 1000 : 0);
      return at - bt;
    });

    return rows.map(r => ({
      role: cleanStr(r.role) || "user",
      text: cleanStr(r.text),
      intent: r.intent || null,
      createdAt: r.createdAt || null
    }));
  } catch (e) {
    console.warn("[copilot_logs] fallback history query failed — returning empty history:", e?.message || e);
    return [];
  }
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
