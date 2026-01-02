// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-acres-v1
//
// Adds beginner feature:
// - "How many acres do we have this year?"
// - Follow-up: Active only vs All (active+archived)
// - Computes from Firestore fields.tillable (read-only)
//
// Keeps:
// - Simple follow-up behavior
// - OpenAI optional (if OPENAI_API_KEY set)
// - Clean { answer, meta } response

'use strict';

import admin from "firebase-admin";

/**
 * @param {Object} args
 * @param {string} args.question
 * @param {Object} [args.snapshot]
 * @param {Array<{role:string,text:string,ts?:any,intent?:string,meta?:any}>} [args.history]
 * @param {Object} [args.state]  // expects { lastIntent }
 * @returns {Promise<{answer:string, meta?:Object}>}
 */
export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || '').toString().trim();
  const low = q.toLowerCase();
  const hist = Array.isArray(history) ? history : [];
  const lastIntent = (state && state.lastIntent) ? String(state.lastIntent) : null;

  // Ensure admin initialized (safe)
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  // ------------------------------
  // ACRES FEATURE (v1)
  // ------------------------------
  // If user is replying to our follow-up
  if (lastIntent === "acres_followup") {
    const choice = parseActiveAllChoice(low);
    if (!choice) {
      return {
        answer: `Reply with: "active" (active fields only) or "all" (active + archived).`,
        meta: { intent: "acres_followup", usedOpenAI: false, model: "builtin" }
      };
    }

    const out = await computeAcres({ db, mode: choice });
    return {
      answer: out,
      meta: { intent: "acres_result", usedOpenAI: false, model: "builtin", acresMode: choice }
    };
  }

  // If user is asking the acres question
  if (isAcresQuestion(low)) {
    // If they already specified active/all in the question, answer immediately.
    const choice = parseActiveAllChoice(low);
    if (choice) {
      const out = await computeAcres({ db, mode: choice });
      return {
        answer: out,
        meta: { intent: "acres_result", usedOpenAI: false, model: "builtin", acresMode: choice }
      };
    }

    // Otherwise ask a solid follow-up (short + clear)
    return {
      answer: `Do you want acres for **active fields only**, or **all fields** (active + archived)?\nReply: "active" or "all".`,
      meta: { intent: "acres_followup", usedOpenAI: false, model: "builtin" }
    };
  }

  // ------------------------------
  // Generic follow-up logic (stop guessing)
  // ------------------------------
  const followUp = buildFollowUpIfNeeded(q, hist);
  if (followUp) {
    return {
      answer: followUp,
      meta: {
        intent: 'followup',
        model: 'builtin',
        usedOpenAI: false
      }
    };
  }

  // ------------------------------
  // OpenAI (optional)
  // ------------------------------
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const model = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
  const useOpenAI = !!apiKey;

  if (useOpenAI) {
    try {
      const answer = await callOpenAIChat({
        apiKey,
        model,
        question: q,
        history: hist
      });

      return {
        answer: (answer || '').trim() || "I didn’t get any text back. Can you rephrase your question?",
        meta: {
          intent: 'chat',
          model,
          usedOpenAI: true
        }
      };
    } catch (e) {
      const fallback = localAnswer(q, hist);
      return {
        answer: fallback,
        meta: {
          intent: 'chat',
          model: 'builtin_fallback',
          usedOpenAI: false,
          error: true,
          errorMessage: e?.message || String(e)
        }
      };
    }
  }

  return {
    answer: localAnswer(q, hist),
    meta: {
      intent: 'chat',
      model: 'builtin',
      usedOpenAI: false,
      note: 'OPENAI_API_KEY not set'
    }
  };
}

/* =======================================================================
   ACRES helpers
======================================================================= */

function isAcresQuestion(low) {
  // intentionally broad + beginner language
  return (
    /\bhow many acres\b/.test(low) ||
    /\btotal acres\b/.test(low) ||
    /\bacres do we have\b/.test(low) ||
    (/\bacres\b/.test(low) && /\bthis year\b/.test(low))
  );
}

function parseActiveAllChoice(low) {
  // Accept: active / all / inactive wording
  if (!low) return null;

  // If they explicitly say "all" or "active and inactive" etc
  if (/\ball\b/.test(low)) return "all";
  if (/\bactive\b/.test(low) && /\binactive\b/.test(low)) return "all";
  if (/\bactive\b/.test(low) && /\barchived\b/.test(low)) return "all";

  // If they say "active only"
  if (/\bactive\b/.test(low)) return "active";

  // Interpret yes/no only if they use it as a direct reply (we handle in follow-up path)
  if (low === "yes" || low === "y") return "active";
  if (low === "no" || low === "n") return "all";

  return null;
}

async function computeAcres({ db, mode }) {
  // mode: "active" or "all"
  const includeArchived = mode === "all";

  // Farms (for names, optional)
  const farmsSnap = await db.collection("farms").get();
  const farmById = new Map();
  farmsSnap.forEach(doc => {
    const d = doc.data() || {};
    farmById.set(doc.id, {
      name: (d.name || "").toString(),
      status: (d.status || "").toString()
    });
  });

  // Fields
  let q = db.collection("fields");
  if (!includeArchived) q = q.where("status", "==", "active");

  const fieldsSnap = await q.get();

  let total = 0;
  let cnt = 0;

  // If includeArchived, also split active/archived totals
  let totalActive = 0, cntActive = 0;
  let totalArchived = 0, cntArchived = 0;

  // Optional: group by farm (top few)
  const farmTotals = new Map(); // farmId -> acres

  fieldsSnap.forEach(doc => {
    const d = doc.data() || {};
    const tillable = (typeof d.tillable === "number" && Number.isFinite(d.tillable)) ? d.tillable : 0;
    const st = (d.status || "active").toString();

    cnt += 1;
    total += tillable;

    if (includeArchived) {
      if (st === "archived") {
        cntArchived += 1;
        totalArchived += tillable;
      } else {
        cntActive += 1;
        totalActive += tillable;
      }
    }

    const farmId = (d.farmId || "").toString().trim();
    if (farmId) {
      farmTotals.set(farmId, (farmTotals.get(farmId) || 0) + tillable);
    }
  });

  const fmt1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // Build a short answer
  if (!includeArchived) {
    return `Total acres (active fields): **${fmt1.format(total)}** acres across **${cnt}** fields.`;
  }

  // includeArchived view
  // show combined + split
  const lines = [];
  lines.push(`Total acres (all fields): **${fmt1.format(total)}** acres across **${cnt}** fields.`);
  lines.push(`Active: **${fmt1.format(totalActive)}** acres (${cntActive} fields) · Archived: **${fmt1.format(totalArchived)}** acres (${cntArchived} fields)`);

  // Top 5 farms by acres (kept short)
  const top = Array.from(farmTotals.entries())
    .map(([farmId, acres]) => {
      const f = farmById.get(farmId) || {};
      return { farmId, name: f.name || farmId, acres };
    })
    .sort((a, b) => b.acres - a.acres)
    .slice(0, 5);

  if (top.length) {
    lines.push(`Top farms:`);
    for (const t of top) {
      lines.push(`- ${t.name}: ${fmt1.format(t.acres)} acres`);
    }
  }

  return lines.join("\n");
}

/* =======================================================================
   Follow-up logic (generic)
======================================================================= */

function buildFollowUpIfNeeded(question, history) {
  const q = (question || '').trim();
  const low = q.toLowerCase();

  if (q.length < 6) {
    return `What are you trying to do, and where?`;
  }

  const pronouny = /\b(it|this|that|those|they|he|she|there|here)\b/i.test(q);
  const hasConcreteNouns = /\b(error|file|page|endpoint|report|pdf|farm|field|equipment|login|firebase|firestore|copilot)\b/i.test(low);
  const hasPriorContext = hasRecentHistory(history);

  if (pronouny && !hasConcreteNouns && !hasPriorContext) {
    return `What does “that/it” refer to (page/file/screenshot), and what do you want it to do?`;
  }

  const changeWords = /\b(fix|change|update|remove|add|build|rewrite|refactor|make it|make this)\b/i.test(low);
  const mentionsFile = /\b(index\.js|server\.js|handlechat\.js|\.html|\.css|\.js)\b/i.test(low);
  if (changeWords && !mentionsFile && !hasPriorContext) {
    return `Which file or page should I change? Paste the full file.`;
  }

  return null;
}

function hasRecentHistory(history) {
  if (!Array.isArray(history) || !history.length) return false;
  const recent = history.slice(-4);
  return recent.some(h => ((h?.text || '').toString().trim().length > 0));
}

/* =======================================================================
   OpenAI call (optional)
======================================================================= */

async function callOpenAIChat({ apiKey, model, question, history }) {
  const messages = buildMessages(question, history);

  const body = {
    model,
    input: messages,
    max_output_tokens: 700
  };

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await safeReadText(resp);
    throw new Error(`OpenAI error (${resp.status}): ${t || resp.statusText}`);
  }

  const json = await resp.json();
  return extractResponseText(json) || '';
}

function buildMessages(question, history) {
  const system = [
    'You are FarmVista Copilot.',
    'Be helpful, concise, and beginner-friendly.',
    'If the user request is ambiguous, ask up to 3 clarifying questions instead of guessing.',
    'Do not mention internal snapshots, revisions, code logs, or debugging unless asked.',
    'When you need a file to proceed, ask for that file.'
  ].join(' ');

  const msgs = [{ role: 'system', content: system }];

  const recent = Array.isArray(history) ? history.slice(-8) : [];
  for (const h of recent) {
    const role = (h?.role || '').toString().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const content = (h?.text || '').toString().trim();
    if (!content) continue;
    if (content.toLowerCase().startsWith('[[fv_pdf]]:')) continue;
    msgs.push({ role, content });
  }

  msgs.push({ role: 'user', content: question });
  return msgs;
}

function extractResponseText(json) {
  try {
    const out = json?.output;
    if (Array.isArray(out)) {
      let acc = '';
      for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === 'output_text' && typeof c?.text === 'string') acc += c.text;
          if (c?.type === 'text' && typeof c?.text === 'string') acc += c.text;
        }
      }
      if (acc.trim()) return acc.trim();
    }
  } catch {}
  try {
    if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  } catch {}
  return '';
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

/* =======================================================================
   Local fallback responder
======================================================================= */

function localAnswer(question, history) {
  const q = (question || '').trim();
  const low = q.toLowerCase();

  if (/\b(copilot|farmvista|firestore|firebase|cloud run|endpoint|express|node)\b/.test(low)) {
    return `Tell me what you want Copilot to do, and paste the file you want to work on.`;
  }

  return `Tell me what you’re trying to do.`;
}
