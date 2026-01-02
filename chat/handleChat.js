// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-chat-fields-only5
//
// Fixes (per Dane):
// ✅ Tower info requests NEVER use OpenAI to invent options.
//    - If tower lookup fails, we suggest top 3 REAL tower names from snapshot.
// ✅ Better tower-name extraction from question.
// ✅ If only 1 field candidate => answer (no 1/2/3 clarify).
// ✅ Tower summary fast path unchanged.
// ✅ No internal IDs in normal answers (facts omit ids).

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

  // 1) Tower info / details (fast path)
  if (looksLikeTowerInfoQuestion(q) || asksTowerDetails(q)) {
    const towerNameFromQuestion = extractTowerNameFromQuestion(q);
    const towerName = towerNameFromQuestion || extractLastTowerName(history);

    if (towerName) {
      // Try direct tower lookup first
      const hit = lookupTowerByName({ snapshot, towerName });
      if (hit.ok && hit.tower) {
        const answer = buildTowerInfoAnswer({ snapshot, tower: hit.tower });
        return { answer, meta: { intent: "tower_info", usedOpenAI: false } };
      }

      // If lookup failed, suggest REAL tower names from snapshot (NO OpenAI hallucinated list)
      const sug = suggestTowerChoicesFromSnapshot({ snapshot, query: towerName });
      if (sug.ok && sug.choices.length) {
        const lines = sug.choices.slice(0, 3).map((name, i) => `${i + 1}) ${name}`);
        const clarify =
          "Quick question so I pull the right data:\n" +
          lines.join("\n") +
          "\n\nReply with 1, 2, or 3.";
        return {
          answer: clarify,
          meta: { intent: "clarify_tower", usedOpenAI: false, note: "tower_lookup_failed" }
        };
      }

      // Still nothing available
      return {
        answer: `I can’t find RTK tower "${towerName}" in the snapshot right now.`,
        meta: { intent: "tower_info", usedOpenAI: false, snapshotOk: false }
      };
    }

    // No tower name available at all (ask user plainly — still no 1/2/3 list from OpenAI)
    return {
      answer: "Which RTK tower name are you asking about? (Example: “Girard”).",
      meta: { intent: "tower_info_clarify", usedOpenAI: false }
    };
  }

  // 2) OpenAI classify (field vs general)
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
    const answer = await openaiAnswer({ apiKey, model, userText: `Snapshot data isn't available right now. Retry in a moment.` });
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
  return hasTower && asksInfo;
}

function asksTowerDetails(text) {
  const t = (text || "").toLowerCase();
  return t.includes("network") || t.includes("network id") || t.includes("frequency") || t.includes("freq");
}

/* ===================== clarify helpers ===================== */

function buildClarify(lines) {
  return (
    "Quick question so I pull the right data:\n" +
    lines.join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
}

/* ===================== tower name parsing ===================== */

function extractLastTowerName(history) {
  const hist = Array.isArray(history) ? history : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if ((h?.role || "") !== "assistant") continue;
    const txt = (h?.text || "").toString();

    let m = txt.match(/\bRTK Tower:\s*([^\n(]+)/i);
    if (m && m[1]) return m[1].trim();

    m = txt.match(/\bthe\s+([A-Za-z0-9/ ]+)\s+tower\b/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractTowerNameFromQuestion(text) {
  const s = (text || "").toString().trim();
  if (!s) return null;

  let m = s.match(/\b(?:rtk\s+tower|tower)\s+([A-Za-z0-9/ -]{2,})\b/i);
  if (m && m[1]) return cleanupTowerName(m[1]);

  m = s.match(/\b([A-Za-z0-9/ -]{2,})\s+(?:rtk\s+tower|tower)\b/i);
  if (m && m[1]) return cleanupTowerName(m[1]);

  // single-word / short phrase tower name
  const plain = s.replace(/[?!.]+$/g, "").trim();
  if (plain.length >= 3 && plain.length <= 40) {
    if (!/^\d{3,6}$/.test(plain)) return cleanupTowerName(plain);
  }

  return null;
}

function cleanupTowerName(name) {
  const n = (name || "").toString().trim();
  if (!n) return null;
  return n
    .replace(/\b(rtk|tower|information|info|details|about)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

/* ===================== tower suggestion + answer ===================== */

function suggestTowerChoicesFromSnapshot({ snapshot, query }) {
  try {
    const sum = summarizeTowers({ snapshot, includeArchived: false });
    if (!sum?.ok || !Array.isArray(sum.towers)) return { ok: false, choices: [] };

    const q = norm(query);
    const names = sum.towers.map(t => (t?.name || "").toString().trim()).filter(Boolean);

    const scored = names
      .map(name => ({ name, score: scoreName(q, norm(name)) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    // If query is "girard", this will strongly prefer "Girard" if it exists.
    const choices = scored.slice(0, 3).map(x => x.name);

    // If nothing scored, still provide a few real options (top towers) rather than hallucinating.
    if (!choices.length) {
      return { ok: true, choices: names.slice(0, 3) };
    }

    return { ok: true, choices };
  } catch {
    return { ok: false, choices: [] };
  }
}

function scoreName(q, c) {
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.startsWith(q)) return 90;
  if (c.includes(q)) return 75;
  // simple token overlap
  const qt = q.split(/\s+/g).filter(Boolean);
  const ct = c.split(/\s+/g).filter(Boolean);
  let hits = 0;
  for (const t of qt) if (ct.includes(t)) hits++;
  return hits ? 60 + hits : 0;
}

function buildTowerInfoAnswer({ snapshot, tower }) {
  const t = tower || {};
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

  return lines.join("\n");
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

  // No internal IDs in facts (prevents OpenAI from printing them)
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
    "If user asks about RTK tower details (frequency/network/info about a named tower), use action='general'. " +
    "fieldQuery should be a short hint like '0801-Lloyd N340' or '801'.";

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
    "If clarification is required, ask ONE short question with up to 3 numbered options. " +
    "DO NOT invent options that are not in the provided data.";
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
