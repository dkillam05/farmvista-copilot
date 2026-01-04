// /handlers/rtk.handler.js  (FULL FILE)
// Rev: 2026-01-03-rtkHandler1
//
// RTK towers handler.
// Answers (examples):
// - "How many RTK towers do we use?"
// - "List RTK towers we use"
// - "What RTK tower is 0801-Lloyd N340 assigned to?"
// - "What farms use the Girard tower?"
// - "Show fields on the Girard tower"
//
// Supports:
// - paging via meta.continuation
// - contextDelta for global follow-ups (same thing / show all / etc.)
// No menus, no multi-choice.

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

function wantsAssigned(q) {
  return q.includes("assigned") || q.includes("assignment") || q.includes("on ") || q.includes("uses") || q.includes("using");
}

function extractTowerNameGuess(raw) {
  const s = (raw || "").toString().trim();

  // "use the Girard tower" / "on the Girard tower"
  let m = s.match(/\b(?:use|uses|using|on|for|from)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
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
  // naive: if it contains a 3–4 digit id or has a dash + letters, treat as field query string
  const s = (raw || "").toString().trim();
  if (!s) return "";

  // if question includes "field", strip leading words
  const m = s.match(/(?:field\s+)?(.+)$/i);
  return m ? (m[1] || "").trim() : s.trim();
}

export async function handleRTK({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const raw = (question || "").toString();
  const q = norm(raw);

  // 1) Towers used summary / count
  if ((q.includes("rtk") || q.includes("tower")) && (wantsCount(q) || wantsList(q) || q.includes("towers do we use"))) {
    const s = summarizeTowersUsed({ snapshot, includeArchived });
    if (!s.ok) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — summarizeTowersUsed failed.",
        meta: { routed: "rtk", intent: "rtk_summary_failed", reason: s.reason, debugFile: "/data/rtkData.js" }
      };
    }

    // Build lines
    const lines = (s.towers || []).map(t => {
      const name = (t.name || t.towerId || "").toString();
      const freq = (t.frequencyMHz || "").toString().trim();
      const net = (t.networkId != null ? String(t.networkId) : "").trim();
      const metaBits = [];
      if (freq) metaBits.push(`${freq} MHz`);
      if (net) metaBits.push(`Net ${net}`);
      const metaStr = metaBits.length ? ` • ${metaBits.join(" • ")}` : "";
      return `• ${name}: ${fmtInt(t.fieldCount)} fields${metaStr}`;
    });

    const title = `RTK towers used (${includeArchived ? "incl archived" : "active only"}): ${fmtInt(s.towersUsedCount || lines.length)}`;

    // Page
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
        continuation: (remaining > 0) ? {
          kind: "page",
          title,
          lines,
          offset: pageSize,
          pageSize
        } : null,
        contextDelta: { lastIntent: "rtk_towers_used", lastBy: "tower", lastScope: { includeArchived: !!includeArchived } }
      }
    };
  }

  // 2) Field -> tower (assignment)
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
    if (fs.towerName) lines.push(`RTK tower: ${fs.towerName}`);
    else lines.push(`RTK tower: (none assigned)`);

    // include tower details if available
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

  // 3) Tower -> farms/fields using it (by tower name)
  if (q.includes("tower") || q.includes("rtk")) {
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

      // If user asked farms: list farms
      if (wantsFarms(q)) {
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
            contextDelta: { lastIntent: "tower_farms", lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id }, lastScope: { includeArchived: !!includeArchived } }
          }
        };
      }

      // If user asked fields: list fields
      if (wantsFields(q) || q.includes("show fields")) {
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
            contextDelta: { lastIntent: "tower_fields", lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id }, lastScope: { includeArchived: !!includeArchived } }
          }
        };
      }

      // Default tower detail
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
          contextDelta: { lastIntent: "tower_detail", lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id }, lastScope: { includeArchived: !!includeArchived } }
        }
      };
    }
  }

  // fallback (no menus)
  return {
    ok: false,
    answer: "Please check /handlers/rtk.handler.js — RTK intent not recognized from this question.",
    meta: { routed: "rtk", intent: "rtk_unrecognized", debugFile: "/handlers/rtk.handler.js" }
  };
}