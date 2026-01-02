// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-fields-only1
//
// Only supports snapshot-backed answers for:
// - farms
// - fields
// - rtkTowers
//
// Uses OpenAI for:
// - interpreting the user's question into an action
// - wording the final answer
//
// Uses snapshot for:
// - actual data facts (field/farm/tower)
//
// Clarifying format (yours):
// Quick question so I pull the right data:
// 1) <option>
// 2) <option>
// 3) <option>
//
// Reply with 1, 2, or 3.

'use strict';

import { tryResolveField, buildFieldBundle, formatFieldOptionLine } from "../data/fieldData.js";

export async function handleChat({ question, snapshot, history, state }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  const q = (question || "").toString().trim();
  if (!q) return { answer: "Missing question.", meta: { intent: "chat", error: true } };

  if (!apiKey) {
    return {
      answer: "OPENAI_API_KEY is not set on the Cloud Run service.",
      meta: { intent: "chat", error: true, usedOpenAI: false }
    };
  }

  // 1) Handle numeric reply to our last clarify (1/2/3)
  const picked = pickChoice(q);
  if (picked) {
    const last = extractLastClarifyOptions(history);
    if (last && last.options.length >= picked) {
      const chosen = last.options[picked - 1];
      // Re-run the original action using chosen fieldId
      return await answerWithFieldId({ apiKey, model, snapshot, fieldId: chosen.fieldId, originalUserQuestion: last.origin || "field question" });
    }
    // If we can't recover options, just fall through to OpenAI normal routing.
  }

  // 2) Ask OpenAI to classify + extract a field hint (no "features", no tools)
  const plan = await openaiPlan({ apiKey, model, userText: q });

  // If OpenAI says it's not a field/tower question, answer generically (no snapshot)
  if (plan.action === "general") {
    const answer = await openaiAnswer({ apiKey, model, userText: q });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  // 3) Field lookup flow
  // plan.fieldQuery is a hint like "0801-Lloyd N340" or "801" or "lloyd n340"
  const fieldQuery = (plan.fieldQuery || "").toString().trim();

  const resolved = tryResolveField({
    snapshot,
    query: fieldQuery || q,      // fallback to original question if model didn't provide a hint
    includeArchived: true        // allow asking about archived too; we can tighten later
  });

  if (!resolved.ok) {
    // If snapshot isn't available, let OpenAI respond with a short apology + ask user to retry.
    const answer = await openaiAnswer({
      apiKey,
      model,
      userText: `User asked: ${q}\nBut snapshot data is not available. Ask the user to retry in a moment.`
    });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model, snapshotOk: false } };
  }

  if (resolved.resolved) {
    return await answerWithFieldId({ apiKey, model, snapshot, fieldId: resolved.fieldId, originalUserQuestion: q });
  }

  // Not resolved: ask your 1/2/3 clarify with best candidates
  const candidates = (resolved.candidates || []).slice(0, 3);
  if (!candidates.length) {
    const answer = await openaiAnswer({
      apiKey,
      model,
      userText: `User asked: ${q}\nNo matching fields found in snapshot. Ask one short question: "Which field?"`
    });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  const lines = candidates.map((c, i) => `${i + 1}) ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`);
  const clarify = buildClarify(lines);

  return {
    answer: clarify,
    meta: {
      intent: "clarify_field",
      usedOpenAI: false,
      model: "builtin",
      // we embed origin in text so we can recover it, and also keep it in meta
      origin: q
    }
  };
}

/* =======================================================================
   Clarify format helpers
======================================================================= */

function buildClarify(lines) {
  return (
    "Quick question so I pull the right data:\n" +
    lines.join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
}

function pickChoice(txt) {
  const t = (txt || "").toString().trim().toLowerCase();
  if (t === "1" || t === "one") return 1;
  if (t === "2" || t === "two") return 2;
  if (t === "3" || t === "three") return 3;
  return null;
}

// Parse previous assistant message for "1) ..." lines so we can map reply 1/2/3.
// We also try to recover the fieldId by re-resolving the displayed line back into snapshot.
function extractLastClarifyOptions(history) {
  if (!Array.isArray(history) || !history.length) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if ((h?.role || "") !== "assistant") continue;
    const text = (h?.text || "").toString();
    if (!text.includes("Quick question so I pull the right data:")) continue;

    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const opts = lines.filter(l => /^\d\)\s+/.test(l)).slice(0, 3);
    if (!opts.length) return null;

    // origin isn't stored reliably; keep best-effort
    const origin = null;

    // Convert option strings back to a fieldId by using the option label as a query.
    // Example option: "0801-Lloyd N340 (Girard-Sville-Grnfld)"
    const options = opts.map(o => {
      const label = o.replace(/^\d\)\s+/, "").trim();
      const nameOnly = label.replace(/\s*\([^)]*\)\s*$/, "").trim();
      return { label, nameOnly };
    });

    // fieldId resolution is done later when user picks (using answerWithFieldId).
    // For now, store nameOnly and resolve on pick.
    return {
      origin,
      options: options.map(o => ({ fieldId: null, nameOnly: o.nameOnly }))
    };
  }

  return null;
}

/* =======================================================================
   Answer with a resolved fieldId (snapshot-backed facts + OpenAI wording)
======================================================================= */

async function answerWithFieldId({ apiKey, model, snapshot, fieldId, originalUserQuestion }) {
  // If extractLastClarifyOptions couldn't supply fieldId, fieldId may be null.
  // In that case, treat fieldId as a name query and resolve again.
  if (!fieldId) {
    const res = tryResolveField({ snapshot, query: originalUserQuestion, includeArchived: true });
    if (res?.resolved) fieldId = res.fieldId;
  }

  // If still no id, attempt resolve by interpreting question as the name
  if (!fieldId) {
    const res2 = tryResolveField({ snapshot, query: originalUserQuestion, includeArchived: true });
    if (res2?.resolved) fieldId = res2.fieldId;
  }

  if (!fieldId) {
    // final fallback: ask which field (short)
    return { answer: "Which field?", meta: { intent: "clarify_field", usedOpenAI: false, model: "builtin" } };
  }

  const bundle = buildFieldBundle({ snapshot, fieldId });
  if (!bundle.ok) {
    return { answer: "Which field?", meta: { intent: "clarify_field", usedOpenAI: false, model: "builtin" } };
  }

  const f = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  const facts = {
    field: {
      id: f.id,
      name: f.name,
      status: f.status || "active",
      county: f.county || "",
      state: f.state || "",
      tillable: typeof f.tillable === "number" ? f.tillable : null,
      farmId: f.farmId || null,
      rtkTowerId: f.rtkTowerId || null
    },
    farm: farm ? { id: farm.id, name: farm.name || "", status: farm.status || "" } : null,
    rtkTower: tower
      ? { id: tower.id, name: tower.name || "", frequencyMHz: tower.frequencyMHz || "", networkId: tower.networkId ?? null }
      : null
  };

  // Ask OpenAI to answer the user's question using ONLY these facts.
  const answer = await openaiAnswerWithFacts({
    apiKey,
    model,
    userText: originalUserQuestion,
    facts
  });

  return { answer, meta: { intent: "field_answer", usedOpenAI: true, model, fieldId } };
}

/* =======================================================================
   OpenAI helpers
======================================================================= */

async function openaiPlan({ apiKey, model, userText }) {
  const system =
    "You are a classifier for FarmVista Copilot. " +
    "Return ONLY valid JSON with keys: action, fieldQuery. " +
    "action must be one of: 'field' or 'general'. " +
    "If the user is asking about a field/farm/RTK tower assignment, set action='field' and set fieldQuery to the best field hint (like '0801-Lloyd N340' or '801' or 'lloyd n340'). " +
    "Otherwise set action='general' and fieldQuery=''.";

  const json = await callOpenAI({ apiKey, model, input: [
    { role: "system", content: system },
    { role: "user", content: userText }
  ], max_output_tokens: 120 });

  try {
    const parsed = JSON.parse(extractJson(json));
    const action = (parsed.action || "").toString().trim().toLowerCase();
    const fieldQuery = (parsed.fieldQuery || "").toString();
    if (action === "field") return { action: "field", fieldQuery };
  } catch {}

  return { action: "general", fieldQuery: "" };
}

async function openaiAnswer({ apiKey, model, userText }) {
  const system =
    "You are FarmVista Copilot. Be direct. If you truly need clarification, ask ONE short question with up to 3 numbered options and ask the user to reply 1/2/3.";

  return await callOpenAIText({ apiKey, model, input: [
    { role: "system", content: system },
    { role: "user", content: userText }
  ], max_output_tokens: 400 });
}

async function openaiAnswerWithFacts({ apiKey, model, userText, facts }) {
  const system =
    "You are FarmVista Copilot. Use ONLY the provided FACTS. " +
    "If the facts do not contain the requested detail, say you don't have it and ask ONE short question with up to 3 options. " +
    "Be concise and accurate. No internal IDs unless asked.";

  const payload = [
    { role: "system", content: system },
    { role: "user", content: `QUESTION:\n${userText}\n\nFACTS (json):\n${JSON.stringify(facts)}` }
  ];

  return await callOpenAIText({ apiKey, model, input: payload, max_output_tokens: 500 });
}

async function callOpenAIText({ apiKey, model, input, max_output_tokens }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, max_output_tokens })
  });

  if (!resp.ok) {
    const t = await safeText(resp);
    throw new Error(`OpenAI HTTP ${resp.status}: ${t || resp.statusText}`);
  }

  const json = await resp.json();
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();

  // fallback
  try {
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

async function callOpenAI({ apiKey, model, input, max_output_tokens }) {
  return await callOpenAIText({ apiKey, model, input, max_output_tokens });
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

// Extract JSON from a response that might have extra whitespace (we told it JSON-only, but be safe)
function extractJson(s) {
  const t = (s || "").toString().trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}
