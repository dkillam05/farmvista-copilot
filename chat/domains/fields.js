// /chat/domains/fields.js  (FULL FILE)
// Rev: 2026-01-16c  domain:fields
//
// Owns field tools + field prefix guardrail.
// Tool: field_profile(query) => full field info + farm + RTK tower details (best-effort).
// No grain logic here.

'use strict';

import { runSql } from "../sqlRunner.js";
import { resolveField } from "../resolve-fields.js";
import { resolveFarm } from "../resolve-farms.js";
import { resolveRtkTower } from "../resolve-rtkTowers.js";

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

export function fieldsToolDefs() {
  return [
    {
      type: "function",
      name: "field_profile",
      description: "Return full field information including farm name and RTK tower details (best-effort). Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Field name, short code (e.g., 0513), or field id." }
        },
        required: ["query"]
      }
    }
  ];
}

/* =====================================================================
   Prefix guardrail helpers (used by handleChat)
===================================================================== */
export function looksLikeRtkFieldPrefix(text) {
  const t = norm(text);
  if (!t.includes("rtk")) return null;
  if (!t.includes("field")) return null;
  const m = t.match(/\bfield\s*[:#]?\s*(\d{3,5})\b/);
  if (!m) return null;
  const prefix = m[1];
  if (t.includes(`${prefix}-`)) return null;
  return prefix;
}

export function findFieldsByPrefix(prefix) {
  const sql = `
    SELECT id, name, rtkTowerId, rtkTowerName
    FROM fields
    WHERE name LIKE ?
    ORDER BY name
    LIMIT 8
  `;
  return runSql({ sql, params: [`${safeStr(prefix)}-%`], limit: 8 });
}

function stripInternalIds(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const lk = norm(k);
    if (lk === "id") continue;
    if (lk.endsWith("id")) continue; // farmId, rtkTowerId, etc.
    out[k] = v;
  }
  return out;
}

function fmtRowPairs(row, skipKeysLower = []) {
  const skip = new Set(skipKeysLower.map(s => norm(s)));
  const pairs = [];
  for (const [k, v] of Object.entries(row || {})) {
    const lk = norm(k);
    if (skip.has(lk)) continue;
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    pairs.push([k, v]);
  }
  return pairs;
}

function formatFieldProfile(fieldRow, farmRow, towerRow) {
  const fName = safeStr(fieldRow?.name).trim() || "(unknown)";
  const lines = [];
  lines.push(`Field: ${fName}`);

  // Field attributes
  const fClean = stripInternalIds(fieldRow || {});
  const fPairs = fmtRowPairs(fClean, ["name"]);
  for (const [k, v] of fPairs) lines.push(`- ${k}: ${safeStr(v)}`);

  // RTK tower
  const towerName = safeStr(towerRow?.name || towerRow?.towerName || towerRow?.rtkTowerName || fieldRow?.rtkTowerName).trim();
  const hasTower =
    !!towerName ||
    safeStr(towerRow?.networkId || towerRow?.netId || towerRow?.frequency || towerRow?.freq || towerRow?.notes).trim();

  if (hasTower) {
    lines.push("");
    lines.push("RTK Tower:");
    if (towerName) lines.push(`- Name: ${towerName}`);

    const net = safeStr(towerRow?.networkId || towerRow?.netId).trim();
    if (net) lines.push(`- Network ID: ${net}`);

    const freq = safeStr(towerRow?.frequency || towerRow?.freq).trim();
    if (freq) lines.push(`- Frequency: ${freq}`);

    const tClean = stripInternalIds(towerRow || {});
    const tPairs = fmtRowPairs(tClean, ["name", "towerName", "rtkTowerName", "networkId", "netId", "frequency", "freq", "notes"]);
    for (const [k, v] of tPairs) lines.push(`- ${k}: ${safeStr(v)}`);
  }

  // Farm
  const farmName = safeStr(farmRow?.name || farmRow?.farmName).trim();
  if (farmName) {
    lines.push("");
    lines.push(`Farm: ${farmName}`);

    const fClean2 = stripInternalIds(farmRow || {});
    const farmPairs = fmtRowPairs(fClean2, ["name", "farmName"]);
    for (const [k, v] of farmPairs) lines.push(`- ${k}: ${safeStr(v)}`);
  }

  return lines.join("\n").trim();
}

export function fieldsHandleToolCall(name, args) {
  if (name !== "field_profile") return null;

  const query = safeStr(args?.query).trim();
  if (!query) return { ok: false, error: "missing_query" };

  // If user gives a short numeric code like "0513", try LIKE first.
  const isCode = /^\d{3,5}$/.test(query);
  if (isCode) {
    const r = findFieldsByPrefix(query);
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    if (rows.length === 1) {
      // resolve via id
      const fieldId = safeStr(rows[0].id);
      const rf = resolveField(fieldId);
      if (rf?.match?.id) {
        return fieldsHandleToolCall("field_profile", { query: safeStr(rf.match.id) });
      }
    }
    if (rows.length > 1) {
      return { ok: false, error: "ambiguous_field_prefix", candidates: rows.map(x => ({ id: safeStr(x.id), name: safeStr(x.name) })) };
    }
    // fall through to normal resolve attempt
  }

  const rf = resolveField(query);
  if (!rf?.match?.id) {
    return { ok: false, error: "no_match", candidates: rf?.candidates || [] };
  }

  const fieldId = safeStr(rf.match.id);

  const fieldRes = runSql({ sql: `SELECT * FROM fields WHERE id = ? LIMIT 1`, params: [fieldId], limit: 1 });
  const fieldRow = Array.isArray(fieldRes?.rows) && fieldRes.rows.length ? fieldRes.rows[0] : null;
  if (!fieldRow) return { ok: false, error: "field_not_found" };

  // farm best-effort
  let farmRow = null;
  try {
    const farmId = safeStr(fieldRow.farmId).trim();
    if (farmId) {
      const rfarm = resolveFarm(farmId);
      const fid = safeStr(rfarm?.match?.id || farmId).trim();
      const fr = runSql({ sql: `SELECT * FROM farms WHERE id = ? LIMIT 1`, params: [fid], limit: 1 });
      farmRow = Array.isArray(fr?.rows) && fr.rows.length ? fr.rows[0] : null;
    }
  } catch {}

  // tower best-effort
  let towerRow = null;
  try {
    const towerId = safeStr(fieldRow.rtkTowerId).trim();
    const towerName = safeStr(fieldRow.rtkTowerName).trim();
    let tid = "";

    if (towerId) {
      const rt = resolveRtkTower(towerId);
      tid = safeStr(rt?.match?.id || towerId).trim();
    } else if (towerName) {
      const rt = resolveRtkTower(towerName);
      tid = safeStr(rt?.match?.id || "").trim();
    }

    if (tid) {
      const tr = runSql({ sql: `SELECT * FROM rtkTowers WHERE id = ? LIMIT 1`, params: [tid], limit: 1 });
      towerRow = Array.isArray(tr?.rows) && tr.rows.length ? tr.rows[0] : null;
    }
  } catch {}

  const text = formatFieldProfile(fieldRow, farmRow, towerRow);
  return { ok: true, text };
}