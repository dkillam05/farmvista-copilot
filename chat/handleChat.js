// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-router-min3
//
// Improvements:
// ✅ RTK tower field questions accept partial input ("field 801", "lloyd n340")
// ✅ If lookup is a "scan" (best-match), ask confirmation: "Did you mean ____? yes/no"
// ✅ Multi-turn confirm uses history (no new state storage needed)
// ✅ Chat stays small; Firestore logic remains in /data/fieldLookup.js

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

  // Follow-up: user types a field name / partial
  if (lastIntent === "field_rtk_followup") {
    return await answerFieldRtk({ db, fieldQuery: q, originalQuery: q, history: hist });
  }

  // Confirm: "Did you mean ____ ?" -> user replies yes/no
  if (lastIntent === "field_rtk_confirm") {
    const yn = parseYesNo(low);
    const suggested = extractSuggestedFieldFromLastAssistant(hist);

    if (!suggested) {
      // If we can’t recover it, just ask again
      return {
        answer: `Which field? (example: "0801-Lloyd N340" or "field 801")`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    if (yn === "yes") {
      return await answerFieldRtk({ db, fieldQuery: suggested, originalQuery: suggested, history: hist, forceExact: true });
    }

    if (yn === "no") {
      return {
        answer: `Ok — what field do you mean? (example: "lloyd n340" or "field 801")`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    // Not yes/no -> treat whatever they typed as the new field query
    return await answerFieldRtk({ db, fieldQuery: q, originalQuery: q, history: hist });
  }

  // Initial RTK question
  if (isRtkTowerQuestion(low)) {
    const fieldQuery = extractFieldQueryFromQuestion(q);

    if (!fieldQuery) {
      return {
        answer: `Which field? (example: "0801-Lloyd N340" or "field 801")`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    return await answerFieldRtk({ db, fieldQuery, originalQuery: q, history: hist });
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
      // fall through
    }
  }

  return { answer: localAnswer(), meta: { intent: "chat", usedOpenAI: false, model: "builtin" } };
}

/* =======================================================================
   RTK tower intent helpers
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  const hasTower = /\b(rtk|tower)\b/.test(low);
  const hasAsk = /\b(what|which|show|find|assigned|on)\b/.test(low);
  const hasFieldish = /\bfield\b/.test(low) || /\d{2,4}\b/.test(low) || /-\w/.test(low);
  return hasTower && (hasAsk || hasFieldish);
}

// Extract a usable "field query" from the question.
// Works for:
// - "What RTK tower is 0801-Lloyd N340 assigned to?"
// - "What tower is field 801 on?"
// - "RTK tower for lloyd n340"
function extractFieldQueryFromQuestion(original) {
  const s = (original || "").trim();
  if (!s) return null;

  // If it contains your typical "0801-Name ..." style, grab that chunk
  const dash = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (dash && dash[1]) return dash[1].trim();

  // If it says "field 801 ..." capture after "field"
  const fm = s.match(/\bfield\b\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\s-]{1,40})/i);
  if (fm && fm[1]) return fm[1].trim();

  // Otherwise, remove common question words and return the remainder if it’s not empty
  const cleaned = s
    .replace(/\bwhat\b|\bwhich\b|\brtk\b|\btower\b|\bassigned\b|\bto\b|\bis\b|\bon\b|\bfor\b|\bthe\b|\bof\b|\bplease\b|\bshow\b|\bfind\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // If they just typed "801" or "lloyd n340", this will keep it
  if (cleaned && cleaned.length >= 2) return cleaned;

  return null;
}

async function answerFieldRtk({ db, fieldQuery, originalQuery, history, forceExact = false }) {
  const query = (fieldQuery || "").toString().trim();
  if (!query) {
    return {
      answer: `Which field? (example: "0801-Lloyd N340" or "field 801")`,
      meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
    };
  }

  // Uses /data/fieldLookup.js (exact first, then best-match scan)
  const bundle = await lookupFieldBundleByName(db, query);

  if (!bundle.ok) {
    return {
      answer: `I couldn’t find a field for "${query}". Try: "field 801" or "lloyd n340".`,
      meta: { intent: "field_not_found", usedOpenAI: false, model: "builtin" }
    };
  }

  const field = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  // If this was a scan match and the user didn't already supply an exact-style name,
  // ask confirmation first (prevents wrong-field answers).
  if (!forceExact && bundle.matchType === "scan" && !looksExactFieldName(originalQuery)) {
    return {
      answer: `Did you mean **${field.name || query}**?\nReply: "yes" or "no".`,
      meta: { intent: "field_rtk_confirm", usedOpenAI: false, model: "builtin" }
    };
  }

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

function looksExactFieldName(s) {
  const t = (s || "").toString();
  // treat "0801-Name ..." as exact enough
  return /\b[0-9]{3,4}-[A-Za-z]/.test(t);
}

function parseYesNo(low) {
  const t = (low || "").trim();
  if (t === "yes" || t === "y" || t === "yep" || t === "yeah") return "yes";
  if (t === "no" || t === "n" || t === "nope") return "no";
  return null;
}

// Pull the suggested field name out of our last assistant message:
// "Did you mean **0801-Lloyd N340**?"
function extractSuggestedFieldFromLastAssistant(history) {
  if (!Array.isArray(history) || !history.length) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if ((h?.role || "") !== "assistant") continue;
    const text = (h?.text || "").toString();

    const m = text.match(/\*\*([^*]+)\*\*/); // first bold segment
    if (m && m[1]) return m[1].trim();
    break;
  }
  return null;
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
