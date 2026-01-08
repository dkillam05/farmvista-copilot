// /chat/entityCatalog.js  (FULL FILE)
// Rev: 2026-01-06-entityCatalog2-sqlite
//
// Canonical candidate lists from SQLite (truth sets).
// Used only for "did you mean..." resolution.
// No fuzzy logic here; no OpenAI here.

'use strict';

import { runSql } from "./sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of (arr || [])) {
    const s = safeStr(x);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function getCandidates({ db, type, limit = 200 }) {
  const t = safeStr(type).toLowerCase();
  const lim = Math.max(20, Math.min(500, Number(limit) || 200));

  let sql = "";
  let key = "name";

  if (t === "tower" || t === "rtk" || t === "rtk_tower") {
    sql = `
      SELECT rtkTowers.name AS name
      FROM rtkTowers
      WHERE rtkTowers.name IS NOT NULL AND rtkTowers.name <> ''
      ORDER BY rtkTowers.name_norm ASC
      LIMIT ${lim}
    `.trim();
    key = "name";
  } else if (t === "farm") {
    sql = `
      SELECT farms.name AS name
      FROM farms
      WHERE farms.name IS NOT NULL AND farms.name <> ''
      ORDER BY farms.name_norm ASC
      LIMIT ${lim}
    `.trim();
    key = "name";
  } else if (t === "county") {
    sql = `
      SELECT DISTINCT
        CASE
          WHEN TRIM(COALESCE(fields.state,'')) <> '' THEN TRIM(fields.county) || ', ' || TRIM(fields.state)
          ELSE TRIM(fields.county)
        END AS name
      FROM fields
      WHERE TRIM(COALESCE(fields.county,'')) <> ''
      ORDER BY LOWER(name) ASC
      LIMIT ${lim}
    `.trim();
    key = "name";
  } else if (t === "field") {
    // large list; keep bounded
    const L = Math.max(100, Math.min(800, lim));
    sql = `
      SELECT fields.name AS name
      FROM fields
      WHERE fields.name IS NOT NULL AND fields.name <> ''
      ORDER BY COALESCE(fields.field_num, 999999) ASC, fields.name_norm ASC
      LIMIT ${L}
    `.trim();
    key = "name";
  } else {
    return { ok: false, error: "unknown_type", candidates: [] };
  }

  const ex = runSql({ db, sql, limitDefault: lim });
  if (!ex.ok) return { ok: false, error: ex.error || "sql_failed", candidates: [] };

  const vals = (ex.rows || []).map(r => safeStr(r?.[key])).filter(Boolean);
  return { ok: true, candidates: uniq(vals) };
}