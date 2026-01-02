// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-router-min2
//
// Chat stays small:
// - Handles follow-ups
// - Routes a couple beginner intents
// - Calls /data/* modules for Firestore lookups
//
// Currently supported:
// - RTK tower for a field (multi-turn)
// - Generic follow-up behavior
// - OpenAI optional (if OPENAI_API_KEY set)

'use strict';

import admin from "firebase-admin";
import { lookupFieldBundleByName } from "../data/fieldLookup.js";

export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || "").toString().trim();
  const low = q.toLowerCase();
  const hist = Array.isArray(history) ? history : [];
  const lastIntent = (state && state.lastIntent) ? String(state.lastIntent) : null;

  // Firestore (read-only)
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  // =========================
  // RTK tower for field (v1)
  // =========================
  if (lastIntent === "field_rtk_followup") {
    const fieldName = q;
    const out = await answerFieldRtk({ db, fieldName });
    return out;
  }

  if (isRtkTowerQuestion(low)) {
    const fieldName = extractLikelyFieldName(q);

    if (!fieldName) {
      return {
        answer: `Which field? Type the field name (example: "0801-Lloyd N340").`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    const out = await answerFieldRtk({ db, fieldName });
    if (out?.meta?.intent === "field_not_found") {
      return {
        answer: `I couldn’t find "${fieldName}". What field do you mean? (type the exact field name)`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }
    return out;
  }

  // =========================
  // Generic follow-up (stop guessing)
  // =========================
  const followUp = buildFollowUpIfNeeded(q, hist);
  if (followUp) {
    return { answer: followUp, meta: { intent: "followup", usedOpenAI: false, model: "builtin" } };
  }

  // =========================
  // OpenAI (optional)
  // =========================
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  if (apiKey) {
    try {
      const answer = await callOpenAIChat({ apiKey, model, question: q, history: hist });
      return { answer: (answer || "").trim() || "Can you rephrase that?", meta: { intent: "chat", usedOpenAI: true, model } };
    } catch {
      // fall through to local
    }
  }

  return { answer: localAnswer(q), meta: { intent: "chat", usedOpenAI: false, model: "builtin" } };
}

/* =======================================================================
   Intent: RTK tower for field
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  const hasTower = /\b(rtk|tower)\b/.test(low);
  const hasField = /\bfield\b/.test(low) || /\d{3,4}-/.test(low);
  const hasAsk = /\b(what|which|show|find|assigned|on)\b/.test(low);
  return hasTower && (hasAsk || hasField);
}

function extractLikelyFieldName(original) {
  const s = (original || "").trim();
  if (!s) return null;

  // pull "0801-Lloyd N340" style strings
  const m = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (m && m[1]) return m[1].trim();

  // if message looks like it IS the field name
  if (s.includes("-") && s.length <= 48 && !/\b(rtk|tower|assigned|what|which)\b/i.test(s)) {
    return s;
  }
  return null;
}

async function answerFieldRtk({ db, fieldName }) {
  const bundle = await lookupFieldBundleByName(db, fieldName);

  if (!bundle.ok) {
    return {
      answer: `I couldn’t find that field. Type the full field name.`,
      meta: { intent: "field_not_found", usedOpenAI: false, model: "builtin" }
    };
  }

  const field = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  if (!field.rtkTowerId) {
    return {
      answer: `Field **${field.name || fieldName}** (${field.status || "active"}) is not assigned to an RTK tower.`,
      meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null }
    };
  }

  const lines = [];
  lines.push(`Field: **${field.name || fieldName}** (${field.status || "active"})`);
  if (farm?.name) lines.push(`Farm: **${farm.name}**${farm.status ? ` (${farm.status})` : ""}`);
  lines.push(`RTK Tower: **${tower?.name || field.rtkTowerId}**${tower?.frequencyMHz ? ` (${tower.frequencyMHz} MHz)` : ""}`);

  // If it was a scan match, note it (short)
  if (bundle.matchType === "scan") {
    lines.push(`(Best match found)`);
  }

  return {
    answer: lines.join("\n"),
    meta: { intent: "field_rtk_result", usedOpenAI: false, model: "builtin", fieldId: field.id || null, farmId: field.farmId || null, rtkTowerId: field.rtkTowerId || null }
  };
}

/* =======================================================================
   Generic follow-up logic (short)
======================================================================= */

function buildFollowUpIfNeeded(question, history) {
  const q = (question || "").trim();
  const low = q.toLowerCase();

  if (q.length < 6) return `What are you trying to do?`;

  const pronouny = /\b(it|this|that|those|they|he|she)\b/i.test(q);
  const hasConcrete = /\b(error|file|page|report|pdf|farm|field|equipment|firebase|firestore|copilot|rtk|tower)\b/i.test(low);
  const hasPrior = Array.isArray(history) && history.slice(-4).some(h => ((h?.text || "").toString().trim().length > 0));

  if (pronouny && !hasConcrete && !hasPrior) {
    return `What does “that/it” refer to (page/file), and what do you want it to do?`;
  }

  return null;
}

/* =======================================================================
   OpenAI (optional)
======================================================================= */

async function callOpenAIChat({ apiKey, model, question, history }) {
  const msgs = buildMessages(question, history);

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: msgs, max_output_tokens: 600 })
  });

  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}`);
  const json = await resp.json();
  return extractResponseText(json);
}

function buildMessages(question, history) {
  const system = [
    "You are FarmVista Copilot.",
    "Be concise and beginner-friendly.",
    "Ask clarifying questions instead of guessing when needed."
  ].join(" ");

  const msgs = [{ role: "system", content: system }];
  const recent = Array.isArray(history) ? history.slice(-8) : [];
  for (const h of recent) {
    const role = (h?.role || "").toString().toLowerCase() === "assistant" ? "assistant" : "user";
    const content = (h?.text || "").toString().trim();
    if (!content) continue;
    msgs.push({ role, content });
  }
  msgs.push({ role: "user", content: question });
  return msgs;
}

function extractResponseText(json) {
  try {
    if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
    const out = json?.output;
    if (Array.isArray(out)) {
      let acc = "";
      for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") acc += c.text;
        }
      }
      return acc.trim();
    }
  } catch {}
  return "";
}

/* =======================================================================
   Local fallback
======================================================================= */

function localAnswer() {
  return `Tell me what you want to look up (field, farm, equipment).`;
}
