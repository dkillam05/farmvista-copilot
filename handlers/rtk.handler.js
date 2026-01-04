// /handlers/rtk.handler.js  (FULL FILE)
// Rev: 2026-01-04-rtkHandler3-typos-acres-fieldid
//
// Fixes:
// ✅ "how mans/how man" treated like "how many"
// ✅ Better fieldId extraction: "what rtk tower does field 1915 use"
// ✅ Tower fields list can include tillable acres (when query mentions tillable/acres)
// ✅ Tower can report total tillable acres across its fields (when asked)
//
// Keeps:
// ✅ tower-specific questions handled before summary
// ✅ paging via meta.continuation
// ✅ contextDelta so follow-ups can work

'use strict';

import {
  summarizeTowersUsed,
  lookupTowerByName,
  getTowerUsage,
  getFieldTowerSummary
} from "../data/rtkData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
function fmtAcre(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function wantsCount(q) {
  const s = norm(q);
  // accept typos like "how man", "how mans"
  if (s.includes("how many") || s.includes("how man")) return true;
  if (s.includes("count") || s.includes("number of")) return true;
  return false;
}

function wantsList(q) {
  const s = norm(q);
  return s.includes("list") || s.includes("show");
}

function wantsFarms(q) { return norm(q).includes("farms"); }
function wantsFields(q) { return norm(q).includes("fields"); }

function wantsTillable(q) {
  const s = norm(q);
  return s.includes("tillable") || s.includes("tillable acres");
}

function wantsTotalTillable(q) {
  const s = norm(q);
  // "tillable acres for the carlinville tower" should mean total, not per-field
  if (!wantsTillable(s)) return false;
  if (s.includes("total") || s.includes("sum")) return true;
  if (s.includes("tillable acres for")) return true;
  if (s.includes("acres for")) return true;
  return false;
}

// Extract tower name from:
// - "Carlinville tower"
// - "the Carlinville rtk tower"
// - "Carlinville: 18 fields • 464.05000 MHz • Net 4010"
function extractTowerNameGuess(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";

  let m = s.match(/^\s*([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s*:\s*\d+\s*fields?\b/i);
  if (m && m[1]) return m[1].trim();

  m = s.match(/\b(?:use|uses|using|on|for|from|along\s+with)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  m = s.match(/\b([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  m = s.match(/\btower\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  // "fields for Carlinville"
  m = s.match(/\bfields\s+(?:for|on)\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  return "";
}

// Extract a field query from phrases like:
// - "what rtk tower does field 1915 use"
// - "rtk tower for 0801-Lloyd N340"
function extractFieldGuess(raw) {
  const s0 = (raw || "").toString().trim();
  if (!s0) return "";

  let s = s0;

  // normalize common prefixes
  s = s.replace(/^what\s+rtk\s+tower\s+does\s+/i, "");
  s = s.replace(/^what\s+rtk\s+tower\s+is\s+/i, "");
  s = s.replace(/^which\s+rtk\s+tower\s+does\s+/i, "");
  s = s.replace(/^which\s+rtk\s+tower\s+is\s+/i, "");
  s = s.replace(/^rtk\s+tower\s+for\s+/i, "");
  s = s.replace(/^tower\s+for\s+/i, "");

  // If it contains "field <something>", capture the <something>
  const m = s.match(/\bfield\s+([A-Za-z0-9][A-Za-z0-9\-\s\._]{0,80})/i);
  if (m && m[1]) {
    return m[1]
      .replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "")
      .trim();
  }

  // Strip trailing verbs
  s = s.replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "").trim();
  return s;
}

export async function handleRTK({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const raw = (question || "").toString();
  const q = norm(raw);

  // -------------------------------------------------------------------
  // 1) Field -> tower assignment (specific)
  // -------------------------------------------------------------------
  if ((q.includes("rtk") || q.includes("tower")) && (q.includes("assigned") || q.includes("what tower") || q.includes("which tower") || q.includes("does field"))) {
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
  // 2) Tower-specific questions (fields/farms/details) — BEFORE summary
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

    // Total tillable acres on tower (sum)
    if (wantsTotalTillable(q)) {
      const totalTill = Number(usage.totals?.tillable || 0);
      return {
        ok: true,
        answer:
          `RTK tower: ${usage.tower.name || usage.tower.id}\n` +
          `Total tillable acres (fields on tower): ${fmtAcre(totalTill)}\n` +
          `Fields using tower: ${fmtInt(usage.counts?.fields || 0)}`,
        meta: {
          routed: "rtk",
          intent: "tower_tillable_total",
          contextDelta: {
            lastIntent: "tower_tillable_total",
            lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    // Fields list (optionally include tillable per field)
    if (wantsFields(q) || q.includes("list of fields") || q.includes("fields for") || q.includes("fields that use")) {
      const includeTillable = wantsTillable(q) || q.includes("include tillable") || q.includes("with acres");

      const title = `Fields on ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const lines = (usage.fields || []).map(f => {
        const base = `• ${f.name}${f.farmName ? ` (${f.farmName})` : ""}`;
        if (!includeTillable) return base;
        return `${base} — ${fmtAcre(f.tillable || 0)} ac`;
      });

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

    // Farms list
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

    // Default tower detail (include totals)
    const lines = [];
    lines.push(`RTK tower: ${usage.tower.name || usage.tower.id}`);
    if (usage.tower.frequencyMHz) lines.push(`Frequency: ${String(usage.tower.frequencyMHz)} MHz`);
    if (usage.tower.networkId != null) lines.push(`Network ID: ${String(usage.tower.networkId)}`);
    lines.push(`Fields using tower: ${fmtInt(usage.counts?.fields || 0)}`);
    lines.push(`Farms using tower: ${fmtInt(usage.counts?.farms || 0)}`);
    if (usage.totals && typeof usage.totals.tillable === "number") {
      lines.push(`Total tillable acres (fields on tower): ${fmtAcre(usage.totals.tillable)}`);
    }

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