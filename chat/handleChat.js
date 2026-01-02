// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-fields-only2
//
// Snapshot-backed farms/fields/rtkTowers only.
// Fix: follow-up questions about tower details (network id / frequency) use snapshot, not guessing.

'use strict';

import {
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine,
  lookupTowerByName
} from "../data/fieldData.js";

export async function handleChat({ question, snapshot, history }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const q = (question || "").toString().trim();

  if (!q) return { answer: "Missing question.", meta: { intent: "chat", error: true } };
  if (!apiKey) return { answer: "OPENAI_API_KEY is not set on Cloud Run.", meta: { intent: "chat", error: true } };

  // 1) Tower-detail follow-up (network id / frequency)
  if (asksTowerDetails(q)) {
    const lastTowerName = extractLastTowerName(history);
    if (lastTowerName) {
      const hit = lookupTowerByName({ snapshot, towerName: lastTowerName });
      if (hit.ok && hit.tower) {
        const t = hit.tower;
        const freq = (t.frequencyMHz || "").toString().trim();
        const net = (t.networkId ?? "").toString().trim();

        // Direct factual answer (no guessing)
        const parts = [`RTK Tower: ${t.name}`];
        if (net) parts.push(`Network ID: ${net}`);
        if (freq) parts.push(`Frequency: ${freq} MHz`);
        return { answer: parts.join("\n"), meta: { intent: "tower_details", usedOpenAI: false } };
      }
    }

    // If we can’t find tower context, let OpenAI ask a clean clarifier
    const answer = await openaiAnswer({ apiKey, model, userText: `User asked: ${q}\nAsk: Which RTK tower name?` });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  // 2) Let OpenAI classify if this is a field/rtk question
  const plan = await openaiPlan({ apiKey, model, userText: q });

  if (plan.action !== "field") {
    const answer = await openaiAnswer({ apiKey, model, userText: q });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  const fieldQuery = (plan.fieldQuery || "").toString().trim();

  const resolved = tryResolveField({
    snapshot,
    query: fieldQuery || q,
    includeArchived: true
  });

  if (!resolved.ok) {
    const answer = await openaiAnswer({
      apiKey,
      model,
      userText: `Snapshot data isn't available right now. Ask the user to retry in a moment.`
    });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model, snapshotOk: false } };
  }

  if (resolved.resolved) {
    return await answerWithFieldId({ apiKey, model, snapshot, fieldId: resolved.fieldId, originalUserQuestion: q });
  }

  const candidates = (resolved.candidates || []).slice(0, 3);
  if (!candidates.length) {
    const answer = await openaiAnswer({ apiKey, model, userText: `Ask: Which field?` });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  const lines = candidates.map((c, i) => `${i + 1}) ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`);
  const clarify = buildClarify(lines);

  return { answer: clarify, meta: { intent: "clarify_field", usedOpenAI: false } };
}

/* ===================== helpers ===================== */

function buildClarify(lines) {
  return (
    "Quick question so I pull the right data:\n" +
    lines.join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
}

function asksTowerDetails(text) {
  const t = (text || "").toLowerCase();
  return t.includes("network") || t.includes("network id") || t.includes("frequency") || t.includes("freq");
}

// pull "Girard" from prior assistant answers like:
// "The RTK tower assigned to ... is the Girard tower."
// or "RTK Tower: Girard ..."
function extractLastTowerName(history) {
  const hist = Array.isArray(history) ? history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if ((h?.role || "") !== "assistant") continue;
    const txt = (h?.text || "").toString();

    let m = txt.match(/\bthe\s+([A-Za-z0-9/ ]+)\s+tower\b/i);
    if (m && m[1]) return m[1].trim();

    m = txt.match(/RTK Tower:\s*([^(\\n]+)/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

async function answerWithFieldId({ apiKey, model, snapshot, fieldId, originalUserQuestion }) {
  const bundle = buildFieldBundle({ snapshot, fieldId });
  if (!bundle.ok) {
    const answer = await openaiAnswer({ apiKey, model, userText: `Ask: Which field?` });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
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

  const answer = await openaiAnswerWithFacts({ apiKey, model, userText: originalUserQuestion, facts });
  return { answer, meta: { intent: "field_answer", usedOpenAI: true, model, fieldId } };
}

/* ===================== OpenAI helpers ===================== */

async function openaiPlan({ apiKey, model, userText }) {
  const system =
    "Return ONLY JSON: {\"action\":\"field\"|\"general\",\"fieldQuery\":\"...\"}. " +
    "Use action='field' if question is about a specific field/farm/rtk tower assignment. " +
    "fieldQuery should be a short hint like '0801-Lloyd N340' or '801' or 'lloyd n340'. " +
    "Otherwise action='general'.";

  const text = await callOpenAIText({
    apiKey,
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: userText }
    ],
    max_output_tokens: 120
  });

  try {
    const t = extractJson(text);
    const obj = JSON.parse(t);
    const action = (obj.action || "").toString().toLowerCase();
    const fieldQuery = (obj.fieldQuery || "").toString();
    if (action === "field") return { action: "field", fieldQuery };
  } catch {}

  return { action: "general", fieldQuery: "" };
}

async function openaiAnswer({ apiKey, model, userText }) {
  const system =
    "You are FarmVista Copilot. Be direct. If you need clarification, ask ONE short question with up to 3 numbered options; user replies 1/2/3.";
  return await callOpenAIText({
    apiKey,
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: userText }
    ],
    max_output_tokens: 400
  });
}

async function openaiAnswerWithFacts({ apiKey, model, userText, facts }) {
  const system =
    "Use ONLY the provided FACTS. If requested detail isn't in facts, say you don't have it and ask ONE short question (1–3 options).";
  return await callOpenAIText({
    apiKey,
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: `QUESTION:\n${userText}\n\nFACTS:\n${JSON.stringify(facts)}` }
    ],
    max_output_tokens: 500
  });
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

async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}

function extractJson(s) {
  const t = (s || "").toString().trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}
