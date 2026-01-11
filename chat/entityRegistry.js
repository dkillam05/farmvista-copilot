// /chat/entityRegistry.js  (FULL FILE)
// Rev: 2026-01-11-entityRegistry1
//
// Central registry: one entry per collection/table.
// This is the "big-company" approach:
// - Add a collection once here + in snapshot builder.
// - No per-question code.
// - Follow-up behavior uses this registry (type-aware but generic).

'use strict';

export const ENTITY = {
  farms: {
    type: "farms",
    table: "farms",
    idCol: "id",
    nameCol: "name",
    // Active-by-default filter
    activeWhere: "(archived IS NULL OR archived = 0)",
    // List base SQL (includes id for internal memory; UI must not show it)
    listSql: `
      SELECT id, name
      FROM farms
      WHERE (archived IS NULL OR archived = 0)
      ORDER BY name
      LIMIT 500
    `,
    // Supported refinements for "include ..." follow-ups
    refinements: {
      // "include acres" => totals per farm using fields join
      include_tillable_acres: {
        keywords: ["include acres", "with acres", "include tillable", "include tillable acres", "add acres", "add tillable"],
        sql: `
          SELECT f.id AS id,
                 f.name AS name,
                 COALESCE(SUM(CASE WHEN (fl.archived IS NULL OR fl.archived = 0) THEN fl.acresTillable ELSE 0 END), 0) AS totalTillable
          FROM farms f
          LEFT JOIN fields fl ON fl.farmId = f.id
          WHERE (f.archived IS NULL OR f.archived = 0)
          GROUP BY f.id, f.name
          ORDER BY f.name
          LIMIT 500
        `,
        formatRow: (r) => `${r.name} — ${Number(r.totalTillable || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} acres`
      },
      include_field_count: {
        keywords: ["field count", "how many fields", "include field count", "add field count"],
        sql: `
          SELECT f.id AS id,
                 f.name AS name,
                 COALESCE(SUM(CASE WHEN (fl.archived IS NULL OR fl.archived = 0) THEN 1 ELSE 0 END), 0) AS fieldCount
          FROM farms f
          LEFT JOIN fields fl ON fl.farmId = f.id
          WHERE (f.archived IS NULL OR f.archived = 0)
          GROUP BY f.id, f.name
          ORDER BY f.name
          LIMIT 500
        `,
        formatRow: (r) => `${r.name} — ${Number(r.fieldCount || 0)} fields`
      }
    }
  },

  fields: {
    type: "fields",
    table: "fields",
    idCol: "id",
    nameCol: "name",
    activeWhere: "(archived IS NULL OR archived = 0)",
    listSql: `
      SELECT id, name
      FROM fields
      WHERE (archived IS NULL OR archived = 0)
      ORDER BY name
      LIMIT 500
    `,
    refinements: {}
  },

  rtkTowers: {
    type: "rtkTowers",
    table: "rtkTowers",
    idCol: "id",
    nameCol: "name",
    // No archived column currently; treat all as active
    activeWhere: "1=1",
    listSql: `
      SELECT id, name
      FROM rtkTowers
      ORDER BY name
      LIMIT 500
    `,
    refinements: {}
  }
};

export function listEntityTypes() {
  return Object.keys(ENTITY);
}

export function getEntity(type) {
  const key = (type || "").toString().trim();
  return ENTITY[key] || null;
}

export function detectRefinement(entityType, userText) {
  const ent = getEntity(entityType);
  if (!ent || !ent.refinements) return null;

  const t = (userText || "").toString().trim().toLowerCase();
  for (const [refKey, ref] of Object.entries(ent.refinements)) {
    const kws = ref.keywords || [];
    if (kws.some(k => t.includes(k))) return refKey;
  }
  return null;
}