// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-min1
//
// Beginner-core chat handler:
// - No features/tools registry.
// - Strong follow-up questions when unclear.
// - Uses OpenAI if OPENAI_API_KEY is set; otherwise falls back to local responder.
// - Returns { answer, meta }.
//
// Expected by index.js:
//   import { handleChat } from "./chat/handleChat.js";

'use strict';

/**
 * @param {Object} args
 * @param {string} args.question
 * @param {Object} [args.snapshot]
 * @param {Array<{role:string,text:string,ts?:any,intent?:string,meta?:any}>} [args.history]
 * @param {Object} [args.state]
 * @returns {Promise<{answer:string, meta?:Object}>}
 */
export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || '').toString().trim();
  const hist = Array.isArray(history) ? history : [];

  // 1) If unclear, ask follow-ups (beginner-friendly)
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

  // 2) If OpenAI key present, use it (simple, stable)
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
      // Fall back to local responder, but keep user-facing text clean
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

  // 3) Local responder (no OpenAI key)
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
   Follow-up logic (this is the “stop guessing” part)
======================================================================= */

function buildFollowUpIfNeeded(question, history) {
  const q = (question || '').trim();
  const low = q.toLowerCase();

  // If extremely short, ask what they mean
  if (q.length < 6) {
    return `I can help — what are you trying to do?\n\nTell me:\n1) what you’re looking at (page / screen / thing)\n2) what you want to happen\n3) what’s going wrong (if anything)`;
  }

  // If it’s mostly pronouns without context, ask for context
  const pronouny = /\b(it|this|that|those|they|he|she|there|here)\b/i.test(q);
  const hasConcreteNouns = /\b(error|file|page|endpoint|report|pdf|farm|field|equipment|login|firebase|firestore|copilot)\b/i.test(low);
  const hasPriorContext = hasRecentHistory(history);

  if (pronouny && !hasConcreteNouns && !hasPriorContext) {
    return `I’m not sure what “that/it/this” refers to yet.\n\nWhat are we talking about (file name, page name, or screenshot), and what do you want it to do?`;
  }

  // If they ask for a change but don’t specify where, ask for the file
  const changeWords = /\b(fix|change|update|remove|add|build|rewrite|refactor|make it|make this)\b/i.test(low);
  const mentionsFile = /\b(index\.js|server\.js|handlechat\.js|\.html|\.css|\.js)\b/i.test(low);
  if (changeWords && !mentionsFile && !hasPriorContext) {
    return `Which file or page should I change?\n\nIf it’s code, paste the full file you want to work on first.`;
  }

  return null;
}

function hasRecentHistory(history) {
  if (!Array.isArray(history) || !history.length) return false;
  // Consider last 4 turns as “context”
  const recent = history.slice(-4);
  return recent.some(h => ((h?.text || '').toString().trim().length > 0));
}

/* =======================================================================
   OpenAI call (simple + clean)
   - Uses Responses API to avoid extra SDK dependencies.
   - Requires Node 18+ (global fetch).
======================================================================= */

async function callOpenAIChat({ apiKey, model, question, history }) {
  const messages = buildMessages(question, history);

  const body = {
    model,
    input: messages,
    // Keep it concise and beginner-friendly
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

  // Responses API returns output in various shapes; this is the safest extraction:
  const text = extractResponseText(json);
  return text || '';
}

function buildMessages(question, history) {
  // Minimal system guidance: do NOT dump internal dev info, ask follow-ups if uncertain.
  const system = [
    'You are FarmVista Copilot.',
    'Be helpful, concise, and beginner-friendly.',
    'If the user request is ambiguous, ask up to 3 clarifying questions instead of guessing.',
    'Do not mention internal snapshots, revisions, code logs, or debugging instructions unless the user explicitly asks for developer help.',
    'When you need a file to proceed, ask for that file.'
  ].join(' ');

  const msgs = [{ role: 'system', content: system }];

  // Include a small amount of recent chat context (keep it tight)
  const recent = Array.isArray(history) ? history.slice(-8) : [];
  for (const h of recent) {
    const role = (h?.role || '').toString().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const content = (h?.text || '').toString().trim();
    if (!content) continue;
    // Avoid feeding report markers back in
    if (content.toLowerCase().startsWith('[[fv_pdf]]:')) continue;
    msgs.push({ role, content });
  }

  msgs.push({ role: 'user', content: question });
  return msgs;
}

function extractResponseText(json) {
  // Typical: json.output[0].content[].text
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

  // Fallbacks:
  try {
    if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  } catch {}

  return '';
}

async function safeReadText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

/* =======================================================================
   Local fallback responder (no OpenAI key)
======================================================================= */

function localAnswer(question, history) {
  const q = (question || '').trim();
  const low = q.toLowerCase();

  // If they’re clearly trying to work on Copilot / FarmVista dev
  if (/\b(copilot|farmvista|firestore|firebase|cloud run|endpoint|express|node)\b/.test(low)) {
    return [
      `I can help, but this Copilot server doesn’t have an AI model connected right now (OPENAI_API_KEY is not set).`,
      ``,
      `Tell me what you want Copilot to do in one sentence, and paste the next file you want to work on.`,
      ``,
      `Example: “When the user asks for equipment, search equipment and return 5 results.”`
    ].join('\n');
  }

  // Generic helpful fallback
  return [
    `I can help with that.`,
    ``,
    `To keep answers accurate, tell me:`,
    `1) what you’re working on`,
    `2) what you want the outcome to be`,
    `3) anything specific you want me to use/avoid`
  ].join('\n');
}

