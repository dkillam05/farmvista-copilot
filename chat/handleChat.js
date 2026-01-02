// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-field-lookup-v1
//
// Adds beginner "field lookup" capability for RTK tower questions:
// - User asks: "What RTK tower is <field> assigned to?"
// - If field name is unclear -> ask for field name (follow-up intent)
// - Then query Firestore: fields -> farms -> rtkTowers
//
// Keeps:
// - generic follow-ups (stop guessing)
// - OpenAI optional (if OPENAI_API_KEY set)
// - returns { answer, meta }

'use strict';

import admin from "firebase-admin";

export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || '').toString().trim();
  const low = q.toLowerCase();
  const hist = Array.isArray(history) ? history : [];
  const lastIntent = (state && state.lastIntent) ? String(state.lastIntent) : null;

  // Firestore
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  // ============================================================
  // FEATURE: RTK tower for a field (multi-turn)
  // ============================================================

  // If we're in the follow-up turn, the user reply should just be the field name.
  if (lastIntent === "field_rtk_followup") {
    const fieldName = q;
    if (!fieldName || fieldName.length < 3) {
      return {
        answer: `Type the full field name (example: "0801-Lloyd N340").`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    const out = await lookupFieldWithFarmAndTower({ db, fieldName });
    return {
      answer: out.answer,
      meta: { intent: out.intent, usedOpenAI: false, model: "builtin", ...(out.meta || {}) }
    };
  }

  // If the user is asking about RTK tower assignment
  if (isRtkTowerQuestion(low)) {
    const guess = extractLikelyFieldName(q);

    // If we can't confidently extract a field name, ask a solid follow-up.
    if (!guess) {
      return {
        answer: `Which field? Type the field name exactly (example: "0801-Lloyd N340").`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    const out = await lookupFieldWithFarmAndTower({ db, fieldName: guess });
    // If not found, ask follow-up (maybe the extraction was wrong)
    if (out.intent === "field_not_found") {
      return {
        answer: `I couldn’t find a field named "${guess}". What field are you referring to? (type the exact field name)`,
        meta: { intent: "field_rtk_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    return {
      answer: out.answer,
      meta: { intent: out.intent, usedOpenAI: false, model: "builtin", ...(out.meta || {}) }
    };
  }

  // ============================================================
  // Generic follow-up logic (stop guessing)
  // ============================================================
  const followUp = buildFollowUpIfNeeded(q, hist);
  if (followUp) {
    return {
      answer: followUp,
      meta: { intent: 'followup', model: 'builtin', usedOpenAI: false }
    };
  }

  // ============================================================
  // OpenAI (optional)
  // ============================================================
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const model = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

  if (apiKey) {
    try {
      const answer = await callOpenAIChat({ apiKey, model, question: q, history: hist });
      return {
        answer: (answer || '').trim() || "Can you rephrase that?",
        meta: { intent: 'chat', model, usedOpenAI: true }
      };
    } catch {
      // fall through to local
    }
  }

  return {
    answer: localAnswer(q),
    meta: { intent: 'chat', model: 'builtin', usedOpenAI: false }
  };
}

/* =======================================================================
   RTK tower field lookup helpers
======================================================================= */

function isRtkTowerQuestion(low) {
  if (!low) return false;
  // examples:
  // "what rtk tower is 0801-lloyd n340 assigned to"
  // "rtk tower for 0801-lloyd n340"
  // "which tower is this field on"
  const hasTower = /\b(tower|rtk)\b/.test(low);
  const hasAsk = /\b(what|which|show|find|assigned|on)\b/.test(low);
  const hasFieldish = /\b(field)\b/.test(low) || /-\w/.test(low) || /\d{3,4}/.test(low);
  return hasTower && (hasAsk || hasFieldish);
}

function extractLikelyFieldName(original) {
  const s = (original || '').trim();
  if (!s) return null;

  // Heuristic: your field names almost always contain a dash like "0801-Lloyd N340"
  // Try to pull a substring that looks like that.
  const m = s.match(/([0-9]{3,4}-[A-Za-z][^?.,;]*)/);
  if (m && m[1]) return m[1].trim();

  // Another common style: user might paste exact field name without prompt words
  // If message contains a dash and is not too long, treat whole message as name
  if (s.includes("-") && s.length <= 48) return s;

  return null;
}

async function lookupFieldWithFarmAndTower({ db, fieldName }) {
  const name = (fieldName || '').toString().trim();
  if (!name) return { intent: "field_not_found", answer: "Missing field name." };

  // 1) Try direct equality (fast path)
  let fieldDoc = await findFieldByExactName(db, name);

  // 2) If not found, do a small scan match (case-insensitive)
  if (!fieldDoc) {
    fieldDoc = await findFieldByScanName(db, name);
  }

  if (!fieldDoc) {
    return { intent: "field_not_found", answer: `No field found for "${name}".` };
  }

  const f = fieldDoc.data || {};
  const farmId = (f.farmId || '').toString().trim() || null;
  const rtkTowerId = (f.rtkTowerId || '').toString().trim() || null;

  // Join farm (optional)
  let farmName = "";
  let farmStatus = "";
  if (farmId) {
    const farmSnap = await db.collection("farms").doc(farmId).get();
    if (farmSnap.exists) {
      const d = farmSnap.data() || {};
      farmName = (d.name || '').toString();
      farmStatus = (d.status || '').toString();
    }
  }

  // Join tower (optional)
  let towerName = "";
  let towerFreq = "";
  if (rtkTowerId) {
    const tSnap = await db.collection("rtkTowers").doc(rtkTowerId).get();
    if (tSnap.exists) {
      const d = tSnap.data() || {};
      towerName = (d.name || '').toString();
      towerFreq = (d.frequencyMHz || '').toString();
    }
  }

  const fieldDisplay = (f.name || fieldName || '').toString();
  const fieldStatus = (f.status || '').toString() || "active";

  if (!rtkTowerId) {
    return {
      intent: "field_rtk_result",
      answer: `Field **${fieldDisplay}** (${fieldStatus}) is not assigned to an RTK tower.`,
      meta: { fieldId: fieldDoc.id, farmId, rtkTowerId: null }
    };
  }

  // Clean beginner answer
  const parts = [];
  parts.push(`Field: **${fieldDisplay}** (${fieldStatus})`);
  if (farmName) parts.push(`Farm: **${farmName}**${farmStatus ? ` (${farmStatus})` : ""}`);
  parts.push(`RTK Tower: **${towerName || rtkTowerId}**${towerFreq ? ` (Freq: ${towerFreq} MHz)` : ""}`);

  return {
    intent: "field_rtk_result",
    answer: parts.join("\n"),
    meta: { fieldId: fieldDoc.id, farmId, rtkTowerId }
  };
}

async function findFieldByExactName(db, name) {
  try {
    const snap = await db.collection("fields")
      .where("name", "==", name)
      .limit(1)
      .get();

    let hit = null;
    snap.forEach(d => {
      if (!hit) hit = { id: d.id, data: d.data() || {} };
    });
    return hit;
  } catch {
    return null;
  }
}

async function findFieldByScanName(db, name) {
  const needle = norm(name);
  if (!needle) return null;

  // Bounded scan (beginner-safe). This is fine for now; later we can add indexes/search fields.
  const snap = await db.collection("fields").limit(5000).get();

  let best = null;
  let bestScore = 0;

  snap.forEach(d => {
    const data = d.data() || {};
    const n = norm(data.name || "");
    const sc = scoreName(n, needle);
    if (sc > bestScore) {
      bestScore = sc;
      best = { id: d.id, data };
    }
  });

  // require a decent match
  if (bestScore >= 50) return best;
  return null;
}

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function scoreName(nameLower, needleLower) {
  if (!nameLower || !needleLower) return 0;
  if (nameLower === needleLower) return 100;
  if (nameLower.startsWith(needleLower)) return 80;
  if (nameLower.includes(needleLower)) return 55;
  return 0;
}

/* =======================================================================
   Generic follow-up logic
======================================================================= */

function buildFollowUpIfNeeded(question, history) {
  const q = (question || '').trim();
  const low = q.toLowerCase();

  if (q.length < 6) return `What are you trying to do, and where?`;

  const pronouny = /\b(it|this|that|those|they|he|she)\b/i.test(q);
  const hasConcrete = /\b(error|file|page|report|pdf|farm|field|equipment|firebase|firestore|copilot|rtk|tower)\b/i.test(low);
  const hasPrior = Array.isArray(history) && history.slice(-4).some(h => ((h?.text || '').toString().trim().length > 0));

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
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
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
    "Ask clarifying questions instead of guessing when needed.",
    "Do not mention internal snapshots/revisions/logs unless asked."
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

function localAnswer(q) {
  return `Tell me what you’re trying to do.`;
}
