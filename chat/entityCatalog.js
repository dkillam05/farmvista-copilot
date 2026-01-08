// /chat/entityCatalog.js  (FULL FILE)
// Rev: 2026-01-06-entityCatalog1
//
// Pulls candidate names from SQLite for global "did you mean" resolution.
// Generic and scalable: add more entity types later.

'use strict';

import { runSql } from "./sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export function getCandidates({ db, entityType, limit = 250 }) {
  const t = safeStr(entityType).toLowerCase();
  const lim = Math.max(25, Math.min(2000, Number(limit) || 250));

  // IMPORTANT: keep queries cheap + predictable.
  let sql = "";
  if (t === "tower" || t === "rtk_tower" || t === "rtk") {
    sql = `
      SELECT rtkTowers.name AS name
      FROM rtkTowers
      WHERE rtkTowers.name IS NOT NULL AND rtkTowers.name <> ''
      ORDER BY rtkTowers.name_norm ASC
      LIMIT ${lim}
    `.trim();
  } else if (t === "farm") {
    sql = `
      SELECT farms.name AS name
      FROM farms
      WHERE farms.name IS NOT NULL AND farms.name <> ''
      ORDER BY farms.name_norm ASC
      LIMIT ${lim}
    `.trim();
  } else if (t === "county") {
    // distinct counties from fields (fast enough on snapshot DB)
    sql = `
      SELECT DISTINCT
        CASE
          WHEN fields.state IS NOT NULL AND fields.state <> '' THEN (fields.county || ', ' || fields.state)
          ELSE fields.county
        END AS name
      FROM fields
      WHERE fields.county IS NOT NULL AND fields.county <> ''
      ORDER BY LOWER(name) ASC
      LIMIT ${lim}
    `.trim();
  } else if (t === "field") {
    // fields can be large; keep limit reasonable
    const L = Math.max(100, Math.min(2000, lim));
    sql = `
      SELECT fields.name AS name
      FROM fields
      WHERE fields.name IS NOT NULL AND fields.name <> ''
      ORDER BY fields.field_num ASC, fields.name_norm ASC
      LIMIT ${L}
    `.trim();
  } else {
    return { ok: false, reason: "unknown_entityType", names: [] };
  }

  const r = runSql({ db, sql, limitDefault: lim });
  if (!r.ok) return { ok: false, reason: r.error || "sql_failed", names: [] };

  const names = (r.rows || []).map(x => safeStr(x?.name)).filter(Boolean);
  return { ok: true, names };
}