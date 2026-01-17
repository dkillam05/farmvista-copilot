// /chat/domains/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-16d  domain:rtkTowers
//
// Owns RTK tools.
//
// Tools:
// - rtk_tower_profile(query)                     => tower details
// - rtk_tower_fields(query, limit)               => list fields using that tower (by tower query)
// - rtk_tower_fields_from_field(fieldQuery,limit)=> list fields on the same tower as a given field (best for follow-ups)
//
// Design goals:
// ✅ Never claim a tower "doesn't exist" if we can find it by LIKE.
// ✅ Make "list all fields on that tower" work reliably.
// ✅ Keep everything domain-owned; handleChat stays boring.

'use strict';

import { runSql } from "../sqlRunner.js";
import { resolveRtkTower } from "../resolve-rtkTowers.js";
import { resolveField } from "../resolve-fields.js";

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

function pickFirstRow(r) {
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.length ? rows[0] : null;
}

function clampLimit(n, dflt, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.max(1, Math.min(max, Math.floor(x)));
}

export function rtkTowersToolDefs() {
  return [
    {
      type: "function",
      name: "rtk_tower_profile",
      description: "Return RTK tower information (network id, frequency, etc.) Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tower name or tower id." }
        },
        required: ["query"]
      }
    },
    {
      type: "function",
      name: "rtk_tower_fields",
      description: "List fields that use a specific RTK tower (by tower name or id). Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tower name or tower id." },
          limit: { type: "number", description: "Max fields to list (default 200, max 500)." }
        },
        required: ["query"]
      }
    },
    {
      type: "function",
      name: "rtk_tower_fields_from_field",
      description: "Given a field (name/code/id), find its RTK tower and list all fields on that tower. Best for follow-ups like 'fields on that tower'. Read-only.",
      parameters: {
        type: "object",
        properties: {
          fieldQuery: { type: "string", description: "Field name/code/id." },
          limit: { type: "number", description: "Max fields to list (default 200, max 500)." }
        },
        required: ["fieldQuery"]
      }
    }
  ];
}

export function userAsksTowerDetails(text) {
  const t = norm(text);
  return (t.includes("network") || t.includes("frequency") || t.includes("freq") || t.includes("net id") || t.includes("network id"));
}

/* =====================================================================
   Tower resolution (robust)
===================================================================== */
function resolveTowerIdBestEffort(query) {
  const q = safeStr(query).trim();
  if (!q) return { ok: false, error: "missing_query" };

  // 1) Resolver (best)
  try {
    const rt = resolveRtkTower(q);
    if (rt?.match?.id) return { ok: true, id: safeStr(rt.match.id), name: safeStr(rt.match.name || rt.match.label || "") };
  } catch {}

  // 2) Direct DB exact match by id
  try {
    const r0 = runSql({ sql: `SELECT id, name FROM rtkTowers WHERE id = ? LIMIT 1`, params: [q], limit: 1 });
    const row0 = pickFirstRow(r0);
    if (row0?.id) return { ok: true, id: safeStr(row0.id), name: safeStr(row0.name) };
  } catch {}

  // 3) Direct DB lookup by name (case-insensitive, LIKE)
  try {
    const like = `%${q}%`;
    const r1 = runSql({
      sql: `SELECT id, name FROM rtkTowers WHERE lower(name) LIKE lower(?) ORDER BY name LIMIT 8`,
      params: [like],
      limit: 8
    });
    const rows = Array.isArray(r1?.rows) ? r1.rows : [];

    if (rows.length === 1) return { ok: true, id: safeStr(rows[0].id), name: safeStr(rows[0].name) };

    if (rows.length > 1) {
      return {
        ok: false,
        error: "ambiguous_tower_name",
        candidates: rows.map(x => ({ id: safeStr(x.id), name: safeStr(x.name) }))
      };
    }
  } catch {}

  return { ok: false, error: "tower_not_found" };
}

/* =====================================================================
   Field list helpers
===================================================================== */
function listFieldsOnTower(towerId, towerName, limit) {
  const lim = clampLimit(limit, 200, 500);

  const r = runSql({
    sql: `
      SELECT name
      FROM fields
      WHERE rtkTowerId = ?
      ORDER BY name
      LIMIT ?
    `,
    params: [towerId, lim],
    limit: lim
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];

  if (!rows.length) {
    return { ok: true, text: `I found RTK tower "${towerName}", but I don't see any fields linked to it in the snapshot.` };
  }

  const lines = [];
  lines.push(`Fields on RTK tower "${towerName}" (${rows.length}${rows.length === lim ? "+" : ""}):`);
  for (const row of rows) lines.push(`- ${safeStr(row.name)}`);
  return { ok: true, text: lines.join("\n").trim() };
}

function resolveFieldRowBestEffort(fieldQuery) {
  const q = safeStr(fieldQuery).trim();
  if (!q) return null;

  // Try resolveField (best)
  try {
    const rf = resolveField(q);
    if (rf?.match?.id) {
      const r = runSql({ sql: `SELECT * FROM fields WHERE id = ? LIMIT 1`, params: [safeStr(rf.match.id)], limit: 1 });
      const row = pickFirstRow(r);
      if (row) return row;
    }
  } catch {}

  // Try exact name
  try {
    const r = runSql({ sql: `SELECT * FROM fields WHERE name = ? LIMIT 1`, params: [q], limit: 1 });
    const row = pickFirstRow(r);
    if (row) return row;
  } catch {}

  // Try prefix code like 0514 -> findFieldsByPrefix-style
  const m = q.match(/^\d{3,5}$/);
  if (m) {
    try {
      const like = `${q}-%`;
      const r = runSql({ sql: `SELECT * FROM fields WHERE name LIKE ? ORDER BY name LIMIT 2`, params: [like], limit: 2 });
      const rows = Array.isArray(r?.rows) ? r.rows : [];
      if (rows.length === 1) return rows[0];
    } catch {}
  }

  return null;
}

/* =====================================================================
   Main tool handler
===================================================================== */
export function rtkTowersHandleToolCall(name, args) {
  if (name === "rtk_tower_profile") {
    const query = safeStr(args?.query).trim();
    if (!query) return { ok: false, error: "missing_query" };

    const resolved = resolveTowerIdBestEffort(query);
    if (!resolved.ok) {
      if (resolved.candidates?.length) return { ok: false, error: resolved.error, candidates: resolved.candidates };
      return { ok: false, error: resolved.error };
    }

    const tid = safeStr(resolved.id);
    const r = runSql({ sql: `SELECT * FROM rtkTowers WHERE id = ? LIMIT 1`, params: [tid], limit: 1 });
    const row = pickFirstRow(r);
    if (!row) return { ok: false, error: "tower_not_found" };

    const lines = [];
    lines.push(`RTK Tower: ${safeStr(row.name || row.towerName || row.rtkTowerName).trim() || "(unknown)"}`);

    const net = safeStr(row.networkId || row.netId).trim();
    if (net) lines.push(`- Network ID: ${net}`);

    const freq = safeStr(row.frequency || row.freq).trim();
    if (freq) lines.push(`- Frequency: ${freq}`);

    for (const [k, v] of Object.entries(row)) {
      const lk = k.toLowerCase();
      if (lk === "id" || lk.endsWith("id")) continue;
      if (["name", "towername", "rtktowername", "networkid", "netid", "frequency", "freq"].includes(lk)) continue;
      if (v == null) continue;
      if (typeof v === "string" && !v.trim()) continue;
      lines.push(`- ${k}: ${safeStr(v)}`);
    }

    return { ok: true, text: lines.join("\n").trim() };
  }

  if (name === "rtk_tower_fields") {
    const query = safeStr(args?.query).trim();
    const limit = args?.limit;

    if (!query) return { ok: false, error: "missing_query" };

    const resolved = resolveTowerIdBestEffort(query);
    if (!resolved.ok) {
      if (resolved.candidates?.length) return { ok: false, error: resolved.error, candidates: resolved.candidates };
      return { ok: false, error: resolved.error };
    }

    return listFieldsOnTower(safeStr(resolved.id), safeStr(resolved.name || query), limit);
  }

  if (name === "rtk_tower_fields_from_field") {
    const fieldQuery = safeStr(args?.fieldQuery).trim();
    const limit = args?.limit;

    if (!fieldQuery) return { ok: false, error: "missing_fieldQuery" };

    const fieldRow = resolveFieldRowBestEffort(fieldQuery);
    if (!fieldRow) return { ok: false, error: "field_not_found" };

    const towerId = safeStr(fieldRow.rtkTowerId).trim();
    const towerName = safeStr(fieldRow.rtkTowerName).trim();

    if (!towerId && !towerName) {
      return { ok: true, text: `Field "${safeStr(fieldRow.name)}" does not have an RTK tower assigned in the snapshot.` };
    }

    // Prefer id; fall back to name lookup
    if (towerId) {
      const r = runSql({ sql: `SELECT id, name FROM rtkTowers WHERE id = ? LIMIT 1`, params: [towerId], limit: 1 });
      const tr = pickFirstRow(r);
      const useName = safeStr(tr?.name || towerName || towerId);
      return listFieldsOnTower(towerId, useName, limit);
    }

    const resolved = resolveTowerIdBestEffort(towerName);
    if (!resolved.ok) {
      if (resolved.candidates?.length) return { ok: false, error: resolved.error, candidates: resolved.candidates };
      return { ok: false, error: resolved.error };
    }

    return listFieldsOnTower(safeStr(resolved.id), safeStr(resolved.name || towerName), limit);
  }

  return null;
}