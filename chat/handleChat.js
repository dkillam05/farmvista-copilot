// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-fields-only4
//
// Fixes (per Dane):
// ✅ Stop “dumb clarify loops”:
//    - If only 1 plausible match => answer (no 1/2/3)
//    - If tower-name is present => resolve tower directly (don’t mis-route into field clarify)
//    - If user asks “tell me more about Raymond tower” => return tower detail fast-path
// ✅ Better tower follow-ups:
//    - Try to extract tower name from the CURRENT question first, then history
// ✅ No internal IDs in normal answers (facts omit ids)
//
// Supports snapshot-backed:
// - Field questions (RTK tower / farm / acres / county, etc via facts)
// - Tower summary: "how many rtk towers do we use" + "what farms go to each tower"
//
// Uses OpenAI to write the final phrasing, but facts come from snapshot.

'use strict';

import {
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine,
  lookupTowerByName,
  summarizeTowers
} from "../data/fieldData.js";

export async function handleChat({ question, snapshot, history }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const q = (question || "").toString().trim();

  if (!q) return { answer: "Missing question.", meta: { intent: "chat", error: true } };
  if (!apiKey) return { answer: "OPENAI_API_KEY is not set on Cloud Run.", meta: { intent: "chat", error: true } };

  // 0) Tower summary question (fast path, no guessing)
  if (looksLikeTowerSummaryQuestion(q)) {
    const sum = summarizeTowers({ snapshot, includeArchived: false });
    if (!sum.ok) {
      const answer = await openaiAnswer({ apiKey, model, userText: "Snapshot data unavailable. Ask user to retry." });
      return { answer, meta: { intent: "tower_summary", usedOpenAI: true, model, snapshotOk: false } };
    }

    const facts = {
      towersUsedCount: sum.towersUsedCount,
      towers: sum.towers.map(t => ({
        name: t.name,
        networkId: t.networkId ?? null,
        frequencyMHz: t.frequencyMHz || "",
        fieldCount: t.fieldCount,
        farms: t.farms
      }))
    };

    const answer = await openaiAnswerWithFacts({ apiKey, model, userText: q, facts });
    return { answer, meta: { intent: "tower_summary", usedOpenAI: true, model } };
  }

  // 1) Tower detail / tower info (fast path)
  // IMPORTANT: prefer extracting tower name from CURRENT question, then fall back to last tower in history.
  if (looksLikeTowerInfoQuestion(q) || asksTowerDetails(q)) {
    const towerNameFromQuestion = extractTowerNameFromQuestion(q);
    const towerName = towerNameFromQuestion || extractLastTowerName(history);

    if (towerName) {
      // Try direct tower lookup first
      const hit = lookupTowerByName({ snapshot, towerName });
      if (hit.ok && hit.tower) {
        const t = hit.tower;
        const freq = (t.frequencyMHz || "").toString().trim();
        const net = (t.networkId ?? "").toString().trim();

        // Enrich with farms/field counts if available via summarizeTowers
        let farms = [];
        let fieldCount = null;
        try {
          const sum = summarizeTowers({ snapshot, includeArchived: false });
          if (sum?.ok && Array.isArray(sum.towers)) {
            const found = sum.towers.find(x => norm(x?.name) === norm(t.name));
            if (found) {
              farms = Array.isArray(found.farms) ? found.farms : [];
              fieldCount = typeof found.fieldCount === "number" ? found.fieldCount : null;
            }
          }
        } catch {}

        const lines = [`RTK Tower: ${t.name}`];
        if (net) lines.push(`Network ID: ${net}`);
        if (freq) lines.push(`Frequency: ${freq} MHz`);
        if (fieldCount !== null) lines.push(`Fields assigned: ${fieldCount}`);
        if (farms.length) lines.push(`Farms: ${farms.join(", ")}`);

        return { answer: lines.join("\n"), meta: { intent: "tower_info", usedOpenAI: false } };
      }
    }

    // If tower name wasn't found or lookup failed, ask ONE direct clarification (A/B style)
    // (Avoid returning a random unrelated option list.)
    const answer = await openaiAnswer({
      apiKey,
      model,
      userText:
        "Which RTK tower name are you asking about? (Example: “Raymond”)."
    });
    return { answer, meta: { intent: "tower_info_clarify", usedOpenAI: true, model } };
  }

  // 2) OpenAI classify (only for field-ish vs general)
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
      userText: `Snapshot data isn't available right now. Retry in a moment.`
    });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model, snapshotOk: false } };
  }

  if (resolved.resolved) {
    return await answerWithFieldId({ apiKey, model, snapshot, fieldId: resolved.fieldId, originalUserQuestion: q });
  }

  // If resolver returns exactly one candidate, DO NOT clarify — answer it.
  const allCandidates = Array.isArray(resolved.candidates) ? resolved.candidates : [];
  if (allCandidates.length === 1 && allCandidates[0]?.fieldId) {
    return await answerWithFieldId({ apiKey, model, snapshot, fieldId: allCandidates[0].fieldId, originalUserQuestion: q });
  }

  const candidates = allCandidates.slice(0, 3);
  if (!candidates.length) {
    const answer = await openaiAnswer({ apiKey, model, userText: `Which field are you asking about?` });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  const lines = candidates.map((c, i) => `${i + 1}) ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`);
  const clarify = buildClarify(lines);
  return { answer: clarify, meta: { intent: "clarify_field", usedOpenAI: false } };
}

/* ===================== tower summary helpers ===================== */

function looksLikeTowerSummaryQuestion(text) {
  const t = (text || "").toLowerCase();
  const hasTower = t.includes("rtk") || t.includes("tower") || t.includes("towers");
  const hasHowMany = t.includes("how many") || t.includes("count");
  const hasFarmsPer = t.includes("what farms") || t.includes("farms go") || t.includes("each tower") || t.includes("per tower");
  return hasTower && (hasHowMany || hasFarmsPer);
}

function looksLikeTowerInfoQuestion(text) {
  const t = (text || "").toLowerCase();
  const hasTower = t.includes("rtk") || t.includes("tower");
  const asksInfo =
    t.includes("tell me more") ||
    t.includes("more info") ||
    t.includes("information") ||
    t.includes("details") ||
    t.includes("about");
  // Examples:
  // "Raymond rtk tower"
  // "what is the rtk tower information for the raymond rtk tower"
  // "tell me more info on the raymond tower"
  return hasTower && asksInfo;
}

/* ===================== clarify helpers ===================== */

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

function extractLastTowerName(history) {
  const hist = Array.isArray(history) ? history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if ((h?.role || "") !== "assistant") continue;
    const txt = (h?.text || "").toString();

    let m = txt.match(/\bthe\s+([A-Za-z0-9/ ]+)\s+tower\b/i);
    if (m && m[1]) return m[1].trim();

    m = txt.match(/RTK Tower:\s*([^\n(]+)/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// Pull tower name directly from question when user types it (prevents unrelated field-clarify loops)
function extractTowerNameFromQuestion(text) {
  const s = (text || "").toString().trim();
  if (!s) return null;

  // Common patterns:
  // "Raymond rtk tower"
  // "rtk tower raymond"
  // "info on raymond tower"
  // "what is the rtk tower information for the raymond rtk tower"
  let m = s.match(/\b(?:rtk\s+tower|tower)\s+([A-Za-z0-9/ -]{2,})\b/i);
  if (m && m[1]) {
    const name = cleanupTowerName(m[1]);
    if (name) return name;
  }

  m = s.match(/\b([A-Za-z0-9/ -]{2,})\s+(?:rtk\s+tower|tower)\b/i);
  if (m && m[1]) {
    const name = cleanupTowerName(m[1]);
    if (name) return name;
  }

  // If user just types a short phrase like "Raymond rtk tower" or even "Raymond"
  // and it isn't clearly a field number, treat it as possible tower name.
  const plain = s.replace(/[?!.]+$/g, "").trim();
  if (plain.length >= 3 && plain.length <= 40) {
    // Avoid pure numeric field IDs like "0500"
    if (!/^\d{3,6}$/.test(plain)) return cleanupTowerName(plain);
  }

  return null;
}

function cleanupTowerName(name) {
  const n = (name || "").toString().trim();
  if (!n) return null;
  // strip trailing filler words
  return n
    .replace(/\b(rt k|rtk|tower|information|info|details|about)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

/* ===================== field answer ===================== */

async function answerWithFieldId({ apiKey, model, snapshot, fieldId, originalUserQuestion }) {
  const bundle = buildFieldBundle({ snapshot, fieldId });
  if (!bundle.ok) {
    const answer = await openaiAnswer({ apiKey, model, userText: `Which field are you asking about?` });
    return { answer, meta: { intent: "chat", usedOpenAI: true, model } };
  }

  const f = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  // IMPORTANT: no internal IDs in facts (prevents OpenAI from printing them)
  const facts = {
    field: {
      name: f.name,
      status: f.status || "active",
      county: f.county || "",
      state: f.state || "",
      tillable: typeof f.tillable === "number" ? f.tillable : null,
      farmName: farm?.name || ""
    },
    rtkTower: tower
      ? { name: tower.name || "", frequencyMHz: tower.frequencyMHz || "", networkId: tower.networkId ?? null }
      : null
  };

  const answer = await openaiAnswerWithFacts({ apiKey, model, userText: originalUserQuestion, facts });
  return { answer, meta: { intent: "field_answer", usedOpenAI: true, model, fieldId } };
}

/* ===================== OpenAI helpers ===================== */

async function openaiPlan({ apiKey, model, userText }) {
  const system =
    "Return ONLY JSON: {\"action\":\"field\"|\"general\",\"fieldQuery\":\"...\"}. " +
    "Use action='field' if user asks about a specific field (rtk tower assignment, acres, farm, county, status). " +
    "fieldQuery should be a short hint like '0801-Lloyd N340' or '801' or 'lloyd n340'. " +
    "If user is asking about RTK tower details (network id/frequency/info about a named tower), use action='general'.";

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
    const obj = JSON.parse(extractJson(text));
    const action = (obj.action || "").toString().toLowerCase();
    const fieldQuery = (obj.fieldQuery || "").toString();
    if (action === "field") return { action: "field", fieldQuery };
  } catch {}

  return { action: "general", fieldQuery: "" };
}

async function openaiAnswer({ apiKey, model, userText }) {
  const system =
    "You are FarmVista Copilot. Be direct and helpful. " +
    "Do not show internal IDs, dev tags, or debug text. " +
    "If clarification is required, ask ONE short question with up to 3 numbered options.";
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
    "Use ONLY the provided FACTS. Do not invent. " +
    "Do not show internal IDs or debug text. " +
    "If requested detail isn't in facts, say you don't have it and ask ONE short question (1–3 options).";
  return await callOpenAIText({
    apiKey,
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: `QUESTION:\n${userText}\n\nFACTS:\n${JSON.stringify(facts)}` }
    ],
    max_output_tokens: 650
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
