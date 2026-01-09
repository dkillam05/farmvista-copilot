'use strict';

import { ensureDbFromSnapshot } from '../context/snapshot-db.js';

/**
 * Minimal, deploy-safe chat handler.
 * - No OpenAI SDK
 * - Uses global fetch (Node 20)
 * - Always returns meta.aiUsed for UI debug
 */

export async function handleChat({
  question,
  snapshot,
  threadId = '',
  debugAI = false
}) {
  if (!question || !question.trim()) {
    return {
      ok: false,
      answer: 'Missing question.',
      meta: { aiUsed: false }
    };
  }

  if (!snapshot?.ok) {
    return {
      ok: false,
      answer: 'Snapshot not loaded.',
      meta: { aiUsed: false }
    };
  }

  // Ensure DB is ready (even if not used yet)
  try {
    ensureDbFromSnapshot(snapshot);
  } catch (e) {
    return {
      ok: false,
      answer: 'Database build failed.',
      meta: { aiUsed: false }
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      answer: 'OPENAI_API_KEY not set.',
      meta: { aiUsed: false }
    };
  }

  const t0 = Date.now();

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: question
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return {
        ok: false,
        answer: 'OpenAI request failed.',
        meta: {
          aiUsed: true,
          error: res.status,
          detail: debugAI ? txt.slice(0, 500) : undefined
        }
      };
    }

    const json = await res.json();

    // Extract text safely
    let text = '';
    try {
      text =
        json.output_text ||
        json.output?.[0]?.content?.[0]?.text ||
        '(No response)';
    } catch {
      text = '(No response)';
    }

    return {
      ok: true,
      answer: String(text),
      meta: {
        aiUsed: true,
        model: 'gpt-4.1-mini',
        ms: Date.now() - t0,
        threadId
      }
    };

  } catch (err) {
    return {
      ok: false,
      answer: 'Unexpected server error.',
      meta: {
        aiUsed: false,
        error: err?.message || String(err)
      }
    };
  }
}
