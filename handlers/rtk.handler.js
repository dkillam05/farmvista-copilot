// /handlers/rtk.handler.js  (FULL FILE)
// Rev: 2026-01-06-rtkHandler8-handlerKit-shorthand
//
// UPDATE (scalable shorthand):
// ✅ Uses /chat/entityResolver.js to resolve tower shorthand (carlin, cville tower, etc.)
// ✅ Still uses handlerKit for sorting + paging rules
// ✅ Fields lists sorted numeric by field prefix
//
// Keeps:
// ✅ meta.contextDelta for tower_fields and tower_fields_tillable
// ✅ meta.continuation paging

'use strict';

import {
  summarizeTowersUsed,
  getTowerUsage,
  getFieldTowerSummary
} from "../data/rtkData.js";

import {
  detectSortMode,
  sortRows,
  sortFieldsByNumberThenName,
  buildPaged
} from "../chat/handlerKit.js";

import { resolveEntity } from "../chat/entityResolver.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function fmtInt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
function fmtAcre(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function wantsCount(q) {
  const s = norm(q);
  return s.includes("how many") || s.includes("how man") || s.includes("count") || s.includes("number of");
}
function wantsList(q) { const s = norm(q); return s.includes("list") || s.includes("show"); }
function wantsFarms(q) { return norm(q).includes("farms"); }
function wantsFields(q) { return norm(q).includes("fields"); }
function wantsTillable(q) { const s = norm(q); return s.includes("tillable") || s.includes("acres"); }

function extractTowerPhrase(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";

  // "fields on carlinville tower"
  let m = s.match(/\bfields\s+(?:for|on|with)\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  // "... carlinville rtk tower"
  m = s.match(/\b([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  // "tower carlinville"
  m = s.match(/\btower\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  // fallback: try last token chunk
  m = s.match(/\b(?:on|for|with)\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b\s*$/i);
  if (m && m[1]) return m[1].trim();

  return "";
}

function extractFieldGuess(raw) {
  let s = (raw || "").toString().trim();
  if (!s) return "";

  s = s.replace(/^what\s+rtk\s+tower\s+does\s+/i, "");
  s = s.replace(/^what\s+rtk\s+tower\s+is\s+/i, "");
  s = s.replace(/^which\s+rtk\s+tower\s+does\s+/i, "");
  s = s.replace(/^which\s+rtk\s+tower\s+is\s+/i, "");
  s = s.replace(/^rtk\s+tower\s+for\s+/i, "");
  s = s.replace(/^tower\s+for\s+/i, "");

  const m = s.match(/\bfield\s+([A-Za-z0-9][A-Za-z0-9\-\s\._]{0,80})/i);
  if (m && m[1]) return m[1].replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "").trim();

  s = s.replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "").trim();
  return s;
}

function resolveTower({ snapshot, towerText, includeArchived }) {
  const guess = (towerText || "").toString().trim();
  if (!guess) return null;

  const r = resolveEntity({
    snapshot,
    collection: "rtkTowers",
    query: guess,
    includeArchived: !!includeArchived,
    limit: 1
  });

  if (!r.ok || !r.matches?.length) return null;
  const top = r.matches[0];
  return { id: top.id, name: top.label, score: top.score };
}

export async function handleRTK({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const raw = (question || "").toString();
  const q = norm(raw);
  const sortMode = detectSortMode(raw);

  // Field -> tower
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
          lastEntity: fs.towerName ? { type: "tower", id: fs.towerId || fs.towerName, name: fs.towerName } : null,
          lastScope: { includeArchived: !!includeArchived }
        }
      }
    };
  }

  // Tower-specific (shorthand)
  const towerPhrase = extractTowerPhrase(raw);
  const towerHit = resolveTower({ snapshot, towerText: towerPhrase, includeArchived });

  if (towerHit) {
    const usage = getTowerUsage({ snapshot, towerId: towerHit.id, includeArchived });
    if (!usage.ok) {
      return {
        ok: false,
        answer: "Please check /data/rtkData.js — tower usage build failed.",
        meta: { routed: "rtk", intent: "tower_usage_failed", debugFile: "/data/rtkData.js", reason: usage.reason }
      };
    }

    // Fields list
    if (wantsFields(q) || q.includes("fields for") || q.includes("fields with") || q.includes("fields that use")) {
      const includeTillable = wantsTillable(q);

      const items = (usage.fields || []).map(f => {
        const base = `${f.name}${f.farmName ? ` (${f.farmName})` : ""}`;
        return includeTillable ? `• ${base}\n  ${fmtAcre(f.tillable || 0)} ac` : `• ${base}`;
      });

      items.sort((a, b) => sortFieldsByNumberThenName(a.replace(/^•\s*/, ""), b.replace(/^•\s*/, "")));

      const title = `Fields on ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const paged = buildPaged({ title, lines: items, pageSize: 35, showTip: false });

      return {
        ok: true,
        answer: paged.answer,
        meta: {
          routed: "rtk",
          intent: includeTillable ? "tower_fields_tillable" : "tower_fields",
          continuation: paged.continuation,
          contextDelta: {
            lastIntent: includeTillable ? "tower_fields_tillable" : "tower_fields",
            lastMetric: includeTillable ? "tillable" : "fields",
            lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    // Farms list (A→Z only)
    if (wantsFarms(q)) {
      const title = `Farms using ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const lines = (usage.farms || []).map(f => `• ${f.name}`).sort((a, b) => a.localeCompare(b));

      const paged = buildPaged({ title, lines, pageSize: 20, showTip: false });

      return {
        ok: true,
        answer: paged.answer,
        meta: {
          routed: "rtk",
          intent: "tower_farms",
          continuation: paged.continuation,
          contextDelta: {
            lastIntent: "tower_farms",
            lastEntity: { type: "tower", id: usage.tower.id, name: usage.tower.name || usage.tower.id },
            lastScope: { includeArchived: !!includeArchived }
          }
        }
      };
    }

    // Default detail
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

  // Summary list: towers used
  if ((q.includes("rtk") || q.includes("tower")) && (wantsCount(q) || wantsList(q) || q.includes("towers do we use"))) {
    const s = summarizeTowersUsed({ snapshot, includeArchived });
    if (!s.ok) {
      return { ok: false, answer: "Please check /data/rtkData.js — summarizeTowersUsed failed.", meta: { routed: "rtk", intent: "rtk_summary_failed", reason: s.reason, debugFile: "/data/rtkData.js" } };
    }

    const title = `RTK towers used (${includeArchived ? "incl archived" : "active only"}): ${fmtInt(s.towersUsedCount || 0)} — ${sortMode === "largest" ? "largest first" : sortMode === "smallest" ? "smallest first" : "A-Z"}`;

    const rows = (s.towers || []).map(t => ({
      name: (t.name || t.towerId || "").toString(),
      value: Number(t.fieldCount) || 0,
      raw: t
    }));

    sortRows(rows, sortMode);

    const lines = rows.map(x => {
      const t = x.raw;
      const name = (t.name || t.towerId || "").toString();
      const fc = fmtInt(t.fieldCount || 0);
      const freq = (t.frequencyMHz || "").toString().trim();
      const net = (t.networkId != null ? String(t.networkId) : "").trim();

      const line1 = `• ${name} — ${fc} fields`;
      const bits = [];
      if (freq) bits.push(`${freq} MHz`);
      if (net) bits.push(`Net ${net}`);
      const line2 = bits.length ? `  ${bits.join(" • ")}` : "";
      return line2 ? `${line1}\n${line2}` : line1;
    });

    const paged = buildPaged({ title, lines, pageSize: 10, showTip: true, tipMode: sortMode });

    return {
      ok: true,
      answer: paged.answer,
      meta: {
        routed: "rtk",
        intent: "rtk_towers_used",
        continuation: paged.continuation,
        contextDelta: { lastIntent: "rtk_towers_used", lastBy: "tower", lastScope: { includeArchived: !!includeArchived } }
      }
    };
  }

  return { ok: false, answer: "Please check /handlers/rtk.handler.js — RTK intent not recognized from this question.", meta: { routed: "rtk", intent: "rtk_unrecognized", debugFile: "/handlers/rtk.handler.js" } };
}