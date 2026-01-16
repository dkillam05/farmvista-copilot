// /chat/domains/fields.js  (FULL FILE)
// Rev: 2026-01-16d  domain:fields
//
// Owns field tools + field prefix guardrail.
// Tools:
// - field_profile(query) => full field info + farm + RTK tower details (best-effort).
// - fields_list_hel_gt0(limit) => list fields with HEL acres > 0 (schema-aware; never complains about missing columns).
//
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
    },
    {
      type: "function",
      name: "fields_list_hel_gt0",
      description: "List fields that have HEL acres > 0 (schema-aware). Read-only.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max number of fields to list (default 200, max 500)." }
        }
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

/* =====================================================================
   HEL (schema-aware; never complains about missing columns)
===================================================================== */
function getFieldsColumns() {
  const r = runSql({
    sql: `SELECT name, type FROM pragma_table_info('fields') ORDER BY cid`,
    params: [],
    limit: 500
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => ({ name: safeStr(x.name), type: safeStr(x.type) }));
}

function pickHelStrategy(cols) {
  // Return { kind: "numeric"|"bool"|"none", col: "<actual column name>" }
  const map = new Map(cols.map(c => [norm(c.name), c.name]));

  // Numeric HEL acres candidates (common variants)
  const numericCandidates = [
    "hel_acres", "helacres", "helAcres",
    "hel_tillable_acres", "heltillableacres", "helTillableAcres",
    "hel_acre", "helacre", "helAcre",
    "hel_area_acres", "helareaacres", "helAreaAcres"
  ];
  for (const c of numericCandidates) {
    const real = map.get(norm(c));
    if (real) return { kind: "numeric", col: real };
  }

  // Boolean HEL flag candidates
  const boolCandidates = [
    "hashel", "has_hel", "hasHel",
    "ishel", "is_hel", "isHel",
    "helflag", "hel_flag", "helFlag"
  ];
  for (const c of boolCandidates) {
    const real = map.get(norm(c));
    if (real) return { kind: "bool", col: real };
  }

  return { kind: "none", col: "" };
}

function fmtHelList(rows, strategy, colName) {
  const lines = [];
  lines.push(`Fields with HEL > 0:`);

  if (!rows.length) {
    lines.push(`- (none found)`);
    lines.push(``);
    lines.push(`Total: 0`);
    return lines.join("\n").trim();
  }

  for (const r of rows) {
    const nm = safeStr(r.name).trim();
    if (!nm) continue;

    if (strategy.kind === "numeric") {
      const a = r.helA;
      const aNum = (a == null ? null : Number(a));
      const show = Number.isFinite(aNum) ? aNum : a;
      lines.push(`- ${nm} — ${colName}: ${show}`);
    } else {
      lines.push(`- ${nm}`);
    }
  }

  lines.push(``);
  lines.push(`Total: ${rows.length}`);
  return lines.join("\n").trim();
}

function listHelFields(limit) {
  const lim = Number.isFinite(limit) ? Math.max(1, Math.min(500, Number(limit))) : 200;

  const cols = getFieldsColumns();
  const strat = pickHelStrategy(cols);

  if (strat.kind === "numeric") {
    const sql = `
      SELECT name, CAST(${strat.col} AS REAL) AS helA
      FROM fields
      WHERE ${strat.col} > 0
      ORDER BY name
      LIMIT ?
    `;
    const r = runSql({ sql, params: [lim], limit: lim });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    return fmtHelList(rows, strat, strat.col);
  }

  if (strat.kind === "bool") {
    // Accept 1/0 and common truthy text representations
    const sql = `
      SELECT name
      FROM fields
      WHERE ${strat.col} = 1
         OR lower(CAST(${strat.col} AS TEXT)) IN ('true','t','yes','y')
      ORDER BY name
      LIMIT ?
    `;
    const r = runSql({ sql, params: [lim], limit: lim });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    return fmtHelList(rows, strat, strat.col);
  }

  // No HEL columns found: return a helpful, DB-backed message (no refusal)
  const sample = runSql({ sql: `SELECT name FROM fields ORDER BY name LIMIT 10`, params: [], limit: 10 });
  const rows = Array.isArray(sample?.rows) ? sample.rows : [];

  const lines = [];
  lines.push(`I can’t find any HEL columns in this snapshot, so I can’t reliably filter HEL > 0 yet.`);
  lines.push(`Here are 10 field names from the snapshot as a sanity check:`);

  for (const r of rows) lines.push(`- ${safeStr(r.name)}`);

  lines.push(``);
  lines.push(`If you tell me what your HEL field is named in Firestore (or in the snapshot), I can wire it in cleanly.`);
  return lines.join("\n").trim();
}

export function fieldsHandleToolCall(name, args) {
  if (name === "fields_list_hel_gt0") {
    return { ok: true, text: listHelFields(args?.limit) };
  }

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