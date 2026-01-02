// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-min-core0
//
// Deterministic chat handler (NO OpenAI).
// Answers ONLY from snapshot data.
// If ambiguous, asks one short clarify question with real options only.

'use strict';

import {
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine,
  lookupTowerByName,
  summarizeTowers
} from "../data/fieldData.js";

export async function handleChat({ question, snapshot }) {
  const q = (question || "").toString().trim();
  if (!q) return { answer: "Missing question.", meta: { intent: "chat", error: true } };

  if (!snapshot?.ok) {
    return {
      answer: "Snapshot data isn’t available right now. Try /context/reload, then retry.",
      meta: { intent: "chat", error: true, snapshotOk: false }
    };
  }

  // 1) Tower summary
  if (looksLikeTowerSummaryQuestion(q)) {
    const sum = summarizeTowers({ snapshot, includeArchived: false });
    if (!sum.ok) return { answer: "Snapshot is missing towers/fields.", meta: { intent: "tower_summary", error: true } };

    const lines = [];
    lines.push(`RTK towers used: ${sum.towersUsedCount}`);
    for (const t of sum.towers) {
      const farms = (t.farms || []).slice(0, 8);
      const more = (t.farms || []).length > farms.length ? ` (+${(t.farms || []).length - farms.length} more)` : "";
      lines.push(`• ${t.name}: ${t.fieldCount} fields — ${farms.join(", ")}${more}`);
    }
    return { answer: lines.join("\n"), meta: { intent: "tower_summary", usedAI: false } };
  }

  // 2) Tower info (name-based)
  if (looksLikeTowerInfoQuestion(q) || asksTowerDetails(q)) {
    const towerName = extractTowerNameFromQuestion(q);
    if (!towerName) {
      return { answer: "Which RTK tower name are you asking about? (Example: “Girard”)", meta: { intent: "tower_info_clarify" } };
    }

    const hit = lookupTowerByName({ snapshot, towerName });
    if (hit.ok && hit.tower) {
      return { answer: formatTower(hit.tower, snapshot), meta: { intent: "tower_info", usedAI: false } };
    }

    // Suggest real towers
    const sum = summarizeTowers({ snapshot, includeArchived: false });
    if (!sum.ok) return { answer: `I can’t find RTK tower "${towerName}".`, meta: { intent: "tower_info", usedAI: false } };

    const choices = suggestTopTowerNames(sum.towers, towerName).slice(0, 3);
    if (!choices.length) return { answer: `I can’t find RTK tower "${towerName}".`, meta: { intent: "tower_info", usedAI: false } };

    const lines = choices.map((name, i) => `${i + 1}) ${name}`);
    return { answer: buildClarify(lines), meta: { intent: "clarify_tower", usedAI: false } };
  }

  // 3) Field question (resolve field)
  const fieldQuery = extractFieldQuery(q) || q;

  const resolved = tryResolveField({ snapshot, query: fieldQuery, includeArchived: true });
  if (!resolved.ok) {
    return { answer: "Snapshot data problem (fields missing).", meta: { intent: "chat", error: true } };
  }

  if (resolved.resolved) {
    return answerWithFieldId(snapshot, resolved.fieldId, q);
  }

  const cands = Array.isArray(resolved.candidates) ? resolved.candidates : [];
  if (!cands.length) {
    return {
      answer: "I couldn’t find that field in the snapshot. Try a field number or full name (example: “0500” or “0801-Lloyd N340”).",
      meta: { intent: "field_not_found", usedAI: false }
    };
  }

  // If only one candidate, auto-answer it.
  if (cands.length === 1 && cands[0]?.fieldId) {
    return answerWithFieldId(snapshot, cands[0].fieldId, q);
  }

  const lines = cands.slice(0, 3).map((c, i) => `${i + 1}) ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`);
  return { answer: buildClarify(lines), meta: { intent: "clarify_field", usedAI: false } };
}

/* ===================== formatting ===================== */

function answerWithFieldId(snapshot, fieldId, originalQuestion) {
  const bundle = buildFieldBundle({ snapshot, fieldId });
  if (!bundle.ok) return { answer: "Field not found in snapshot.", meta: { intent: "field_not_found", usedAI: false } };

  const f = bundle.field || {};
  const farm = bundle.farm || null;
  const tower = bundle.tower || null;

  // Decide what to answer based on the question wording
  const q = (originalQuestion || "").toLowerCase();

  if (q.includes("rtk") || q.includes("tower")) {
    if (!tower) return { answer: `${f.name}: no RTK tower assigned in snapshot.`, meta: { intent: "field_tower", usedAI: false } };
    return { answer: `${f.name} uses the ${tower.name} RTK tower.`, meta: { intent: "field_tower", usedAI: false } };
  }

  // default: short field summary
  const lines = [];
  lines.push(`Field: ${f.name}`);
  if (farm?.name) lines.push(`Farm: ${farm.name}`);
  if (f.county) lines.push(`County: ${f.county}${f.state ? ", " + f.state : ""}`);
  if (typeof f.tillable === "number") lines.push(`Tillable acres: ${f.tillable}`);
  if (tower?.name) lines.push(`RTK tower: ${tower.name}`);

  return { answer: lines.join("\n"), meta: { intent: "field_summary", usedAI: false } };
}

function formatTower(tower, snapshot) {
  const t = tower || {};
  const lines = [];
  lines.push(`RTK Tower: ${t.name}`);
  if (t.networkId) lines.push(`Network ID: ${t.networkId}`);
  if (t.frequencyMHz) lines.push(`Frequency: ${t.frequencyMHz} MHz`);

  // enrich with farms/field count (from summarize)
  try {
    const sum = summarizeTowers({ snapshot, includeArchived: false });
    if (sum?.ok) {
      const found = sum.towers.find(x => (x?.name || "").toLowerCase() === (t.name || "").toLowerCase());
      if (found) {
        lines.push(`Fields assigned: ${found.fieldCount}`);
        if (found.farms?.length) lines.push(`Farms: ${found.farms.join(", ")}`);
      }
    }
  } catch {}

  return lines.join("\n");
}

/* ===================== question detection ===================== */

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

function extractTowerNameFromQuestion(text) {
  const s = (text || "").toString().trim();
  if (!s) return null;

  let m = s.match(/\b(?:rtk\s+tower|tower)\s+([A-Za-z0-9/ -]{2,})\b/i);
  if (m && m[1]) return cleanupTowerName(m[1]);

  m = s.match(/\b([A-Za-z0-9/ -]{2,})\s+(?:rtk\s+tower|tower)\b/i);
  if (m && m[1]) return cleanupTowerName(m[1]);

  // "Tell me more about Girard" (without saying tower)
  m = s.match(/\babout\s+([A-Za-z0-9/ -]{2,})\b/i);
  if (m && m[1]) return cleanupTowerName(m[1]);

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

function extractFieldQuery(text) {
  const s = (text || "").toString();

  // explicit "field 0500"
  let m = s.match(/\bfield\s+(\d{3,6})\b/i);
  if (m && m[1]) return m[1].trim();

  // leading digits like "0500"
  m = s.match(/^\s*(\d{3,6})\s*$/);
  if (m && m[1]) return m[1].trim();

  return null;
}

/* ===================== clarify helpers ===================== */

function buildClarify(lines) {
  if (!Array.isArray(lines) || !lines.length) return "Which one?";

  if (lines.length === 1) {
    return (
      "Quick question so I pull the right data:\n" +
      lines[0] +
      "\n\nReply with 1."
    );
  }

  return (
    "Quick question so I pull the right data:\n" +
    lines.join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
}

function suggestTopTowerNames(towers, query) {
  const q = (query || "").toLowerCase().replace(/\b(rtk|tower)\b/g, "").trim();
  const names = (towers || []).map(t => (t?.name || "").toString()).filter(Boolean);

  const scored = names
    .map(name => ({
      name,
      score: scoreName(name.toLowerCase(), q)
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(x => x.name);
}

function scoreName(hay, needle) {
  if (!hay || !needle) return 0;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 90;
  if (hay.includes(needle)) return 75;
  return 0;
}
