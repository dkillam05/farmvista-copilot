// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-clean1
//
// GOAL:
// - Remove dumb canned responses.
// - For data questions: answer if possible; otherwise ask ONE short follow-up.
// - No echoing the user's whole sentence.
// - No "Try: ..." suggestions.
// - Keep chat handler small (calls /data/*).

'use strict';

import admin from "firebase-admin";
import { lookupFieldBundleByName } from "../data/fieldLookup.js";

export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || "").toString().trim();
  const low = q.toLowerCase();

  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  // =========================
  // RTK tower for field
  // =========================
  if (isRtkTowerQuestion(low)) {
    const fieldQuery = extractFieldQuery(q);

    // If we can't extract anything usable, ask once.
    if (!fieldQuery) {
      return {
        answer: "Which field?",
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    // Look up field + farm + tower
    const bundle = await lookupFieldBundleByName(db, fieldQuery);

    // If not found, ask once (no dumb text).
    if (!bundle?.ok || !bundle?.field) {
      return {
        answer: "Which field?",
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    const field = bundle.field || {};
    const farm = bundle.farm || null;
    const tower = bundle.tower || null;

    // If no tower assigned, say it cleanly.
    if (!field.rtkTowerId) {
      return {
        answer: `Field ${field.name || fieldQuery}: No RTK tower assigned.`,
        meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null }
      };
    }

    // Clean, direct answer.
    // (No extra fluff. No "best match" notes. No confidence talk.)
    const towerLabel = tower?.name || field.rtkTowerId;
    const freq = (tower?.frequencyMHz || "").toString().trim();

    let answer = `Field ${field.name || fieldQuery}\nRTK Tower: ${towerLabel}`;
    if (farm?.name) answer = `Field ${field.name || fieldQuery} (${farm.name})\nRTK Tower: ${towerLabel}`;
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

  // =========================
  // Default: keep it short
  // =========================
  // You can expand later, but for now: no dumb filler.
  return {
    answer: "What do you want to look up?",
    meta: { intent: "followup", usedOpenAI: false, model: "builtin" }
  };
}

/* =======================================================================
   Parsing helpers (NO dumb behavior)
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  // Simple and safe: only enter RTK path if they mention rtk/tower.
  return /\b(rtk|tower)\b/.test(low);
}

// Extract something usable from:
// - "What RTK tower is 0801-Lloyd N340 assigned to?"
// - "What RTK tower is field 801 on?"
// - "rtk tower lloyd n340"
function extractFieldQuery(input) {
  const s = (input || "").toString().trim();
  if (!s) return null;

  // 1) Exact style like "0801-Lloyd N340"
  const dash = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (dash && dash[1]) return cleanFieldQuery(dash[1]);

  // 2) "field 801 ..." -> grab after "field" but stop junk words
  const fm = s.match(/\bfield\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\s-]{0,40})/i);
  if (fm && fm[1]) return cleanFieldQuery(fm[1]);

  // 3) If they gave a short hint (like "801" or "lloyd n340")
  // Avoid swallowing full sentences.
  if (s.length <= 32 && !/[?]/.test(s) && !/^\s*(what|which)\b/i.test(s)) {
    return cleanFieldQuery(s);
  }

  return null;
}

// Strip junk so "801 on" -> "801", "lloyd n340 on" -> "lloyd n340"
function cleanFieldQuery(raw) {
  let t = (raw || "").toString().trim();

  // remove trailing punctuation
  t = t.replace(/[?.,;:]+$/g, "").trim();

  // remove common trailing words from questions
  t = t.replace(/\b(on|for|to|is|the|a|an|assigned|rtk|tower)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();

  // if it includes a 2-4 digit token and it's mostly numeric-ish, return that token
  const num = t.match(/\b(\d{2,4})\b/);
  if (num) {
    const digits = t.replace(/\D/g, "");
    const mostlyDigits = (digits.length / Math.max(1, t.length)) > 0.35;
    if (mostlyDigits) return num[1];
  }

  return t || null;
}
