// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-router-min4
//
// FIX:
// ✅ Never treat the entire user sentence as a field name.
// ✅ If we can’t extract a field query, ask “Which field?” (no fake Q&A).
// ✅ If lookup fails, do NOT echo the whole sentence back.
// ✅ Still uses /data/fieldLookup.js for actual data.

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
  // RTK tower for field
  // -------------------------
  if (lastIntent === "field_rtk_followup") {
    // In follow-up mode, user reply can be short like "801" or "lloyd n340"
    return await answerFieldRtk({ db, fieldQuery: q });
  }

  if (isRtkTowerQuestion(low)) {
    const fieldQuery = extractFieldQueryFromQuestion(q);

    if (!fieldQuery) {
      return {
        answer: `Which field? (example: "field 801" or "lloyd n340")`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    return await answerFieldRtk({ db, fieldQuery });
  }

  // -------------------------
  // Generic follow-up
  // -------------------------
  const followUp = buildFollowUpIfNeeded(q, hist);
  if (followUp) {
    return { answer: followUp, meta: { intent: "followup", usedOpenAI: false, model: "builtin" } };
  }

  // -------------------------
  // OpenAI (optional)
  // -------------------------
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  if (apiKey) {
    try {
      const answer = await callOpenAIChat({ apiKey, model, question: q, history: hist });
      return { answer: (answer || "").trim() || "Can you rephrase that?", meta: { intent: "chat", usedOpenAI: true, model } };
    } catch {
      // fall through
    }
  }

  return { answer: `Tell me what you want to look up (field, farm, equipment).`, meta: { intent: "chat", usedOpenAI: false, model: "builtin" } };
}

/* =======================================================================
   RTK helpers
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  const hasTower = /\b(rtk|tower)\b/.test(low);
  const hasAsk = /\b(what|which|show|find|assigned|on|for)\b/.test(low);
  const hasFieldish = /\bfield\b/.test(low) || /\d{2,4}\b/.test(low) || /-\w/.test(low);
  return hasTower && (hasAsk || hasFieldish);
}

// Extracts a "fieldQuery" like:
// - "0801-Lloyd N340"
// - "801"
// - "lloyd n340"
function extractFieldQueryFromQuestion(original) {
  const s = (original || "").trim();
  if (!s) return null;

  // 1) Your exact style: "0801-Lloyd N340"
  const dash = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (dash && dash[1]) return dash[1].trim();

  // 2) "field 801" or "field: 801"
  const fm = s.match(/\bfield\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\s-]{0,40})/i);
  if (fm && fm[1]) {
    const candidate = fm[1].trim();
    if (candidate) return candidate;
  }

  // 3) If they typed a short thing that’s NOT a full sentence, allow it
  // (avoid swallowing the entire question again)
  // If it contains a question mark or starts with "what/which", do NOT use it.
  if (/[?]/.test(s)) return null;
  if (/^\s*(what|which|show|find)\b/i.test(s)) return null;

  // 4) As a last resort, if it’s short, accept it (e.g. "801", "lloyd n340")
  if (s.length <= 32) return s;

  return null;
}

async function answerFieldRtk({ db, fieldQuery }) {
  const query = (fieldQuery || "").toString().trim();
  if (!query) {
    return {
      answer: `Which field? (example: "field 801" or "lloyd n340")`,
      meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
    };
  }

  const bundle = await lookupFieldBundleByName(db, query);

  if (!bundle.ok) {
    // IMPORTANT: no fake “searched your whole sentence”
    return {
      answer: `I couldn’t find that field. Try: "field 801" or "lloyd n340".`,
      meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
    };
  }

  const field = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  if (!field.rtkTowerId) {
    return {
      answer: `Field **${field.name || query}** (${field.status || "active"}) is not assigned to an RTK tower.`,
      meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null }
    };
  }

  const lines = [];
  lines.push(`Field: **${field.name || query}** (${field.status || "active"})`);
  if (farm?.name) lines.push(`Farm: **${farm.name}**${farm.status ? ` (${farm.status})` : ""}`);
  lines.push(`RTK Tower: **${tower?.name || field.rtkTowerId}**${tower?.frequencyMHz ? ` (${tower.frequencyMHz} MHz)` : ""}`);

  return {
    answer: lines.join("\n"),
    meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null }
  };
}

/* =======================================================================
   Generic follow-up logic
======================================================================= */

function buildFollowUpIfNeeded(question, history) {
  const q = (question || "").trim();
  if (q.length < 6) return `What are you trying to do?`;
  return null;
}

/* =======================================================================
   OpenAI (optional)
======================================================================= */

async function callOpenAIChat({ apiKey, model, question, history }) {
  const msgs = [{ role: "system", content: "You are FarmVista Copilot. Be concise." }, { role: "user", content: question }];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: msgs, max_output_tokens: 400 })
  });

  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}`);
  const json = await resp.json();
  return (json?.output_text || "").toString();
}
