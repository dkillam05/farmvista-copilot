// /handlers/rtk.handler.js  (FULL FILE)
// Rev: 2026-01-04-rtkHandler5-fields-with
//
// CHANGE:
// ✅ Accept "fields with <tower> tower" / "fields with <tower>" phrasing
// ✅ Uses robust lookup in /data/rtkData.js

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
  return s.includes("how many") || s.includes("how man") || s.includes("count") || s.includes("number of");
}
function wantsList(q) { const s = norm(q); return s.includes("list") || s.includes("show"); }
function wantsFarms(q) { return norm(q).includes("farms"); }
function wantsFields(q) { return norm(q).includes("fields"); }
function wantsTillable(q) { const s = norm(q); return s.includes("tillable") || s.includes("acres"); }

function towerBullet(t) {
  const name = (t.name || t.towerId || "").toString();
  const freq = (t.frequencyMHz || "").toString().trim();
  const net  = (t.networkId != null ? String(t.networkId) : "").trim();
  const fc   = fmtInt(t.fieldCount || 0);

  const line1 = `• ${name} — ${fc} fields`;
  const bits = [];
  if (freq) bits.push(`${freq} MHz`);
  if (net) bits.push(`Net ${net}`);
  const line2 = bits.length ? `  ${bits.join(" • ")}` : "";
  return line2 ? `${line1}\n${line2}` : line1;
}

function extractTowerNameGuess(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";

  // "Name: 18 fields ..."
  let m = s.match(/^\s*([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s*:\s*\d+\s*fields?\b/i);
  if (m && m[1]) return m[1].trim();

  // "fields with Carlinville"
  m = s.match(/\bfields\s+(?:for|on|with)\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
  if (m && m[1]) return m[1].trim();

  // "for the Carlinville tower"
  m = s.match(/\b(?:use|uses|using|on|for|from|with|along\s+with)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  // "<name> tower"
  m = s.match(/\b([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\s+(?:rtk\s+)?tower\b/i);
  if (m && m[1]) return m[1].trim();

  // "tower Carlinville"
  m = s.match(/\btower\s+([A-Za-z0-9][A-Za-z0-9\s\-\._]{1,60})\b/i);
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
  if (m && m[1]) {
    return m[1].replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "").trim();
  }

  s = s.replace(/\b(use|uses|using|assigned|on|for)\b.*$/i, "").trim();
  return s;
}

export async function handleRTK({ question, snapshot, user, includeArchived = false, meta = {} }) {
  const raw = (question || "").toString();
  const q = norm(raw);

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

    return { ok: true, answer: lines.join("\n"), meta: { routed: "rtk", intent: "field_tower" } };
  }

  // Tower-specific
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

    // fields list
    if (wantsFields(q) || q.includes("fields for") || q.includes("fields with") || q.includes("fields that use")) {
      const includeTillable = wantsTillable(q);
      const title = `Fields on ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;

      const lines = (usage.fields || []).map(f => {
        const base = `• ${f.name}${f.farmName ? ` (${f.farmName})` : ""}`;
        return includeTillable ? `${base}\n  ${fmtAcre(f.tillable || 0)} ac` : base;
      });

      const pageSize = 35;
      const first = lines.slice(0, pageSize);
      const remaining = lines.length - first.length;

      const out = [];
      out.push(title);
      out.push("");
      out.push(...first);
      if (remaining > 0) out.push(`\n…plus ${remaining} more fields.`);

      return {
        ok: true,
        answer: out.join("\n"),
        meta: { routed: "rtk", intent: "tower_fields", continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null }
      };
    }

    // farms list
    if (wantsFarms(q)) {
      const title = `Farms using ${usage.tower.name || usage.tower.id} (${includeArchived ? "incl archived" : "active only"}):`;
      const lines = (usage.farms || []).map(f => `• ${f.name}`);

      const pageSize = 20;
      const first = lines.slice(0, pageSize);
      const remaining = lines.length - first.length;

      const out = [];
      out.push(title);
      out.push("");
      out.push(...first);
      if (remaining > 0) out.push(`\n…plus ${remaining} more farms.`);

      return { ok: true, answer: out.join("\n"), meta: { routed: "rtk", intent: "tower_farms", continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null } };
    }

    // default detail
    const lines = [];
    lines.push(`RTK tower: ${usage.tower.name || usage.tower.id}`);
    if (usage.tower.frequencyMHz) lines.push(`Frequency: ${String(usage.tower.frequencyMHz)} MHz`);
    if (usage.tower.networkId != null) lines.push(`Network ID: ${String(usage.tower.networkId)}`);
    lines.push(`Fields using tower: ${fmtInt(usage.counts?.fields || 0)}`);
    lines.push(`Farms using tower: ${fmtInt(usage.counts?.farms || 0)}`);

    return { ok: true, answer: lines.join("\n"), meta: { routed: "rtk", intent: "tower_detail" } };
  }

  // Summary list
  if ((q.includes("rtk") || q.includes("tower")) && (wantsCount(q) || wantsList(q) || q.includes("towers do we use"))) {
    const s = summarizeTowersUsed({ snapshot, includeArchived });
    if (!s.ok) {
      return { ok: false, answer: "Please check /data/rtkData.js — summarizeTowersUsed failed.", meta: { routed: "rtk", intent: "rtk_summary_failed", reason: s.reason, debugFile: "/data/rtkData.js" } };
    }

    const title = `RTK towers used (${includeArchived ? "incl archived" : "active only"}): ${fmtInt(s.towersUsedCount || 0)}`;
    const lines = (s.towers || []).map(towerBullet);

    const pageSize = 10;
    const first = lines.slice(0, pageSize);
    const remaining = lines.length - first.length;

    const out = [];
    out.push(title);
    out.push("");
    out.push(...first);
    if (remaining > 0) out.push(`\n…plus ${remaining} more towers.`);

    return { ok: true, answer: out.join("\n"), meta: { routed: "rtk", intent: "rtk_towers_used", continuation: (remaining > 0) ? { kind: "page", title, lines, offset: pageSize, pageSize } : null } };
  }

  return { ok: false, answer: "Please check /handlers/rtk.handler.js — RTK intent not recognized from this question.", meta: { routed: "rtk", intent: "rtk_unrecognized", debugFile: "/handlers/rtk.handler.js" } };
}