// /handlers/rtk.handler.js  (FULL FILE)
// Rev: 2026-01-04-rtkHandler2-specific-first
//
// CHANGE:
// ✅ Tower-specific requests (Carlinville tower, fields/farms on tower, tower details) are handled FIRST.
// ✅ "RTK towers used" summary is handled LAST (so "list fields for Carlinville tower" doesn't get hijacked).
// ✅ Accepts tower name from lines like: "Carlinville: 18 fields • 464.05000 MHz • Net 4010"
// ✅ Supports paging via meta.continuation and contextDelta.

'use strict';

import {
  summarizeTowersUsed,
  lookupTowerByName,
  getTowerUsage,
  getFieldTowerSummary
} from "../data/rtkData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function wantsCount(q) {
  return q.includes("how many") || q.includes("count") || q.includes("number of");
}

function wantsList(q) {
  return q.includes("list") || q.includes("show");
}

function wantsFarms(q) {
  return q.includes("farms");
}

function wantsFields(q) {
  return q.includes("fields");
}

// Extract tower name from:
// - "Carlinville tower"
// - "the Carlinville rtk tower"
// - "Carlinville: 18 fields • 464.05000 MHz • Net 4010"
function extractTowerNameGuess(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";

  // If it's a "Name: 18 fields • 464.05000 MHz • Net 4010" style line
  let m = s.match(/^\s*([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s*:\s*\d+\s*fields?\b/i);
  if (m && m[1]) return m[1].trim();

  // "for the Girard tower" / "on the Girard tower"
  m = s.match(/\b(?:use|uses|using|on|for|from|along\s+with)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  // "<name> tower"
  m = s.match(/\b([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  // "tower Girard"
  m = s.match(/\btower\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  return "";
}

function extractFieldGuess(raw) {
  const s = (raw || "").toString().trim();
  return s
    .replace(/^what\s+rtk\s+tower\s+is\s+/i, "")
    .replace(/^which\s+rtk\s+tower\s+is\s+/i, "")
    .replace(/^what\s+tower\s+is\s+/i, "")
    .replace(/^which\s+tower\s+is\s+/i, "")
    .replace(/^rtk\s+tower\s+for\s+/i, "")
    .trim();
}

export async function handleRTK({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const raw = (question || "").toString();
  const q = norm(raw);

  // -------------------------------------------------------------------
  // 1) Field -> tower assignment (specific)
  // -------------------------------------------------------------------
  if ((q.includes("rtk") || q.includes("tower")) && (q.includes("assigned") || q.includes("what tower") || q.includes("which tower"))) {
    const fieldGuess = extractFieldGuess(raw);
    const fs = getFieldTowerSummary({ snapshot, fieldQuery: fieldGuess, includeArchived });

    if (!fs.ok) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — could not resolve field -> tower assignment.",
        meta: { routed: "rtk", intent: "field_tower_failed", reason: fs.reason, debugFile: "/data/rtkData.js", debug: fs.debug || null }
      };
    }

    const lines = [];
    lines.push(`Field: ${fs.fieldName}`);
    if (fs.farmName) lines.push(`Farm: ${fs.farmName}`);
    lines.push(`RTK tower: ${fs.towerName ? fs.towerName : "(none assigned)"}`);

    if (fs.tower?.frequencyMHz) lines.push(`Frequency: ${String(fs.tower.frequencyMHz)} MHz`);
    if (fs.tower?.networkId != null) lines.push(`Network ID: ${String(fs.tower.networkId)}`);

    return {
      ok: true,
      answer: lines.join("\n"),
      meta: {
        routed: "rtk",
        intent: "field_tower",
        contextDelta: {
          lastIntent: "field_tower",
          lastEntity: fs.towerId ? { type: "tower", id: fs.towerId, name: fs.towerName } : null,
          lastScope: { includeArchived: !!includeArchived }
        }
      }
    };
  }

  // -------------------------------------------------------------------
  // 2) Tower-specific questions (fields/farms/details) — MUST COME BEFORE summary
  // -------------------------------------------------------------------
  const towerGuess = extractTowerNameGuess(raw);
  if (towerGuess) {
    const lt = lookupTowerByName({ snapshot, towerName: towerGuess });
    if (!lt.ok || !lt.tower?.id) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — tower lookup failed.",
        meta: { routed: "rtk", intent: "tower_lookup_failed", towerGuess, debugFile: "/data/rtkData.js" }
      };
    }

    const usage = getTowerUsage({ snapshot, towerId: lt.tower.id, includeArchived });
    if (!usage.ok) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — tower usage build failed.",
        meta: { routed: "rtk", intent: "tower_usage_failed", debugFile: "/data/rtkData.js", reason: usage.reason }
      };
    }

    // If user wants fields (or asked "list fields for ... tower")
    if (wantsFields(q) || q.includes("list of fields") || q.includes("fields for")) {
      const title = `Fields on ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const lines = (usage.fields || []).map(f => `• ${f.name}${f.farmName ? ` (${f.farmName})` : ""}`);

      const pageSize = 40;
      const first = lines.slice(0, pageSize);
      const remaining = lines.length - first.length;

      const out = [];
      out.push(title);
      out.push(...first);
      if (remaining > 0) out.push(`…plus ${remaining} more fields.`);

      return {
        ok: true,
        answer: out.join("\n"),
        meta: {
          routed: "rtk",
          intent: "tower_fields",
          continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null,
          contextDelta: {
            lastIntent: "tower_fields",
            lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    // If user wants farms
    if (wantsFarms(q) || q.includes("farms for") || q.includes("farms using")) {
      const title = `Farms using ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const lines = (usage.farms || []).map(f => `• ${f.name}`);

      const pageSize = 20;
      const first = lines.slice(0, pageSize);
      const remaining = lines.length - first.length;

      const out = [];
      out.push(title);
      out.push(...first);
      if (remaining > 0) out.push(`…plus ${remaining} more farms.`);

      return {
        ok: true,
        answer: out.join("\n"),
        meta: {
          routed: "rtk",
          intent: "tower_farms",
          continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null,
          contextDelta: {
            lastIntent: "tower_farms",
            lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    // Default: tower detail
    const lines = [];
    lines.push(`RTK tower: ${usage.tower.name || usage.tower.id}`);
    if (usage.tower.frequencyMHz) lines.push(`Frequency: ${String(usage.tower.frequencyMHz)} MHz`);
    if (usage.tower.networkId != null) lines.push(`Network ID: ${String(usage.tower.networkId)}`);
    lines.push(`Fields using tower: ${fmtInt(usage.counts?.fields || 0)}`);
    lines.push(`Farms using tower: ${fmtInt(usage.counts?.farms || 0)}`);

    return {
      ok: true,
      answer: lines.join("\n"),
      meta: {
        routed: "rtk",
        intent: "tower_detail",
        contextDelta: {
          lastIntent: "tower_detail",
          lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
          lastScope: { includeArchived: !!includeArchived }
        }
      }
    };
  }

  // -------------------------------------------------------------------
  // 3) Towers used summary / count (generic) — LAST
  // -------------------------------------------------------------------
  if ((q.includes("rtk") || q.includes("tower")) && (wantsCount(q) || (wantsList(q) && !wantsFields(q) && !wantsFarms(q)) || q.includes("towers do we use"))) {
    const s = summarizeTowersUsed({ snapshot, includeArchived });
    if (!s.ok) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — summarizeTowersUsed failed.",
        meta: { routed: "rtk", intent: "rtk_summary_failed", reason: s.reason, debugFile: "/data/rtkData.js" }
      };
    }

    const lines = (s.towers || []).map(t => {
      const name = (t.name || t.towerId || "").toString();
      const freq = (t.frequencyMHz || "").toString().trim();
      const net = (t.networkId != null ? String(t.networkId) : "").trim();
      const bits = [];
      if (freq) bits.push(`${freq} MHz`);
      if (net) bits.push(`Net ${net}`);
      const metaStr = bits.length ? ` • ${bits.join(" • ")}` : "";
      return `• ${name}: ${fmtInt(t.fieldCount)} fields${metaStr}`;
    });

    const title = `RTK towers used (${includeArchived ? "incl archived" : "active only"}): ${fmtInt(s.towersUsedCount || lines.length)}`;

    const pageSize = 12;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push(...first);
    if (remaining > 0) out.push(`…plus ${remaining} more towers.`);

    return {
      ok: true,
      answer: out.join("\n"),
      meta: {
        routed: "rtk",
        intent: "rtk_towers_used",
        continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null,
        contextDelta: { lastIntent: "rtk_towers_used", lastBy: "tower", lastScope: { includeArchived: !!includeArchived } }
      }
    };
  }

  return {
    ok: false,
    answer: "Please check /handlers/rtk.handler.js — RTK intent not recognized from this question.",
    meta: { routed: "rtk", intent: "rtk_unrecognized", debugFile: "/handlers/rtk.handler.js" }
  };
}