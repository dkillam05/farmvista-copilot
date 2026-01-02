// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-clean2
//
// FIXES:
// ✅ If user asks "network id", use last RTK Tower mentioned in history and fetch from rtkTowers.
// ✅ If lastIntent is field_rtk_followup, treat user's reply as the field hint (e.g., "801").
// ✅ No dumb "try this" text. Minimal follow-ups only.

'use strict';

import admin from "firebase-admin";
import { lookupFieldBundleByName } from "../data/fieldLookup.js";

export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || "").toString().trim();
  const low = q.toLowerCase();
  const hist = Array.isArray(history) ? history : [];
  const lastIntent = (state && state.lastIntent) ? String(state.lastIntent) : null;

  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  // -------------------------
  // Follow-up: user replying with field hint (e.g. "801")
  // -------------------------
  if (lastIntent === "field_rtk_followup") {
    return await answerFieldRtk({ db, fieldQuery: q });
  }

  // -------------------------
  // Network ID follow-up (use last tower mentioned)
  // -------------------------
  if (asksNetworkId(low)) {
    const towerName = getLastTowerNameFromHistory(hist);
    if (!towerName) {
      // No context, ask minimal
      return { answer: "Which tower?", meta: { intent: "tower_network_followup", usedOpenAI: false, model: "builtin" } };
    }

    const net = await lookupTowerNetworkIdByName(db, towerName);
    if (net == null) {
      return { answer: "Which tower?", meta: { intent: "tower_network_followup", usedOpenAI: false, model: "builtin" } };
    }

    return {
      answer: `RTK Tower: ${towerName}\nNetwork ID: ${net}`,
      meta: { intent: "tower_network_result", usedOpenAI: false, model: "builtin", towerName, networkId: net }
    };
  }

  // -------------------------
  // RTK tower for field
  // -------------------------
  if (isRtkTowerQuestion(low)) {
    const fieldQuery = extractFieldQuery(q);

    if (!fieldQuery) {
      return {
        answer: "Which field?",
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    return await answerFieldRtk({ db, fieldQuery });
  }

  // -------------------------
  // Default (short)
  // -------------------------
  return {
    answer: "What do you want to look up?",
    meta: { intent: "followup", usedOpenAI: false, model: "builtin" }
  };
}

/* =======================================================================
   Network ID helpers
======================================================================= */

function asksNetworkId(low) {
  return /\bnetwork\s*id\b/.test(low) || /\bnetworkid\b/.test(low);
}

// Pulls "Girard" from a previous assistant line like:
// "RTK Tower: Girard (461.65000 MHz)"
function getLastTowerNameFromHistory(history) {
  if (!Array.isArray(history) || !history.length) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if ((h?.role || "") !== "assistant") continue;
    const text = (h?.text || "").toString();

    const m = text.match(/RTK Tower:\s*([^(\\n]+)\s*(\(|$)/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

async function lookupTowerNetworkIdByName(db, towerName) {
  const name = (towerName || "").toString().trim();
  if (!name) return null;

  try {
    const snap = await db.collection("rtkTowers")
      .where("name", "==", name)
      .limit(1)
      .get();

    let net = null;
    snap.forEach(d => {
      const data = d.data() || {};
      net = (typeof data.networkId === "number") ? data.networkId : (data.networkId ?? null);
    });

    return net;
  } catch {
    return null;
  }
}

/* =======================================================================
   RTK helpers (clean)
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  return /\b(rtk|tower)\b/.test(low);
}

function extractFieldQuery(input) {
  const s = (input || "").toString().trim();
  if (!s) return null;

  // "0801-Lloyd N340"
  const dash = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (dash && dash[1]) return cleanFieldQuery(dash[1]);

  // "field 801 on?" -> capture after field
  const fm = s.match(/\bfield\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\s-]{0,40})/i);
  if (fm && fm[1]) return cleanFieldQuery(fm[1]);

  // Short hint only (avoid swallowing full sentences)
  if (s.length <= 32 && !/[?]/.test(s) && !/^\s*(what|which)\b/i.test(s)) {
    return cleanFieldQuery(s);
  }

  return null;
}

function cleanFieldQuery(raw) {
  let t = (raw || "").toString().trim();

  t = t.replace(/[?.,;:]+$/g, "").trim();
  t = t.replace(/\b(on|for|to|is|the|a|an|assigned|rtk|tower)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  const num = t.match(/\b(\d{2,4})\b/);
  if (num) {
    const digits = t.replace(/\D/g, "");
    const mostlyDigits = (digits.length / Math.max(1, t.length)) > 0.35;
    if (mostlyDigits) return num[1];
  }

  return t || null;
}

async function answerFieldRtk({ db, fieldQuery }) {
  const query = (fieldQuery || "").toString().trim();
  if (!query) {
    return { answer: "Which field?", meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" } };
  }

  const bundle = await lookupFieldBundleByName(db, query);

  if (!bundle?.ok || !bundle?.field) {
    return { answer: "Which field?", meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" } };
  }

  const field = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  if (!field.rtkTowerId) {
    return {
      answer: `Field ${field.name || query}: No RTK tower assigned.`,
      meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null }
    };
  }

  const towerLabel = tower?.name || field.rtkTowerId;
  const freq = (tower?.frequencyMHz || "").toString().trim();

  let answer = `Field ${field.name || query}\nRTK Tower: ${towerLabel}`;
  if (farm?.name) answer = `Field ${field.name || query} (${farm.name})\nRTK Tower: ${towerLabel}`;
  if (freq) answer += ` (${freq} MHz)`;

  return {
    answer,
    meta: {
      intent: "field_rtk_result",
      usedOpenAI: false,
      model: "builtin",
      fieldId: field.id || null,
      farmId: field.farmId || null,
      rtkTowerId: field.rtkTowerId || null
    }
  };
}
