// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16d  domain:grain
//
// Owns grain logic (tools + math).
//
// HARD RULES (kept):
// - PUTDOWN ONLY / VIEW ONLY: use v_grainBag_open_remaining only
// - NO STATUS
// - Partial picked-up bug guard:
//    if remainingPartial <= 0 => effectiveFeet = 0 (even if remainingPartialFeetSum > 0)
//    else effectiveFeet = MIN(remainingPartialFeetSum, remainingPartial * lengthFt)
// - Correct capacity chain:
//    v.bagSkuId -> inventoryGrainBagMovements.id -> productsGrainBags.id
//
// Improvements:
// ✅ Adds "how many bags" tool (bags, not bushels)
// ✅ Adds "where are the bags" tool (group by fieldName)
// ✅ Adds "priority pickup" tool (schema-aware; never guesses columns)
// ✅ Adds "available years" tool to avoid guessing cropYear defaults

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

const CROP_FACTOR = {
  corn: 1.00,
  soybeans: 0.93,
  wheat: 1.07,
  milo: 1.02,
  oats: 0.78
};

function cropFactorFor(cropType) {
  const c = norm(cropType);
  return (c && Object.prototype.hasOwnProperty.call(CROP_FACTOR, c)) ? CROP_FACTOR[c] : null;
}

function normalizeCrop(cropTypeRaw) {
  const c = norm(cropTypeRaw);
  if (!c) return "";
  if (c === "soy" || c === "beans" || c === "sb") return "soybeans";
  if (c === "sorghum") return "milo";
  return c;
}

function round0(x) { return Math.round(Number(x) || 0); }

function pragmaCols(tableOrViewName) {
  try {
    const r = runSql({
      sql: `SELECT name, type FROM pragma_table_info(?) ORDER BY cid`,
      params: [tableOrViewName],
      limit: 500
    });
    const rows = Array.isArray(r?.rows) ? r.rows : [];
    return rows.map(x => ({ name: safeStr(x.name), type: safeStr(x.type) }));
  } catch {
    return [];
  }
}

function findPriorityColumn(cols) {
  // Try to locate a "priority pickup" indicator column
  // We do NOT guess: we only use what exists.
  const map = new Map(cols.map(c => [norm(c.name), c.name]));

  const candidates = [
    "pickuppriority", "pickup_priority", "pickupPriority",
    "prioritypickup", "priority_pickup", "priorityPickup",
    "priority", "ispriority", "is_priority", "isPriority",
    "highpriority", "high_priority", "highPriority"
  ];

  for (const k of candidates) {
    const real = map.get(norm(k));
    if (real) return real;
  }

  // fallback: any column containing both "priority" and ("pickup" optional)
  const hits = cols
    .map(c => c.name)
    .filter(nm => {
      const t = norm(nm);
      return t.includes("priority");
    });

  return hits.length ? hits[0] : "";
}

function buildWhere({ cropType, cropYear, fieldName }) {
  const where = [];
  const params = [];

  const c = normalizeCrop(cropType);
  if (c) {
    where.push(`lower(v.cropType)=lower(?)`);
    params.push(c);
  }
  if (cropYear != null && Number.isFinite(cropYear)) {
    where.push(`v.cropYear=?`);
    params.push(Number(cropYear));
  }
  const fn = safeStr(fieldName).trim();
  if (fn) {
    where.push(`lower(v.fieldName) LIKE lower(?)`);
    params.push(`%${fn}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

function listYearsForCrop(cropType) {
  const c = normalizeCrop(cropType);
  if (!c) return [];
  const r = runSql({
    sql: `
      SELECT DISTINCT v.cropYear AS cropYear
      FROM v_grainBag_open_remaining v
      WHERE lower(v.cropType)=lower(?)
      ORDER BY v.cropYear DESC
    `,
    params: [c],
    limit: 50
  });
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return rows.map(x => Number(x.cropYear)).filter(x => Number.isFinite(x));
}

/* =====================================================================
   TOOL DEFS
===================================================================== */
export function grainToolDefs() {
  return [
    {
      type: "function",
      name: "grain_bags_bushels_now",
      description: "Compute current bushels in grain bags using PUTDOWN-adjusted truth view v_grainBag_open_remaining. Applies partialZeroGuard and crop factor. Read-only.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string", description: "corn|soybeans|wheat|milo|oats (optional)" },
          cropYear: { type: "number", description: "Crop year (optional if user didn't specify)" },
          fieldName: { type: "string", description: "Optional field name filter (substring match)" },
          groupedByField: { type: "boolean", description: "If true, return per-field totals + grand total" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_count_now",
      description: "Count grain bags down now (full+partial) from v_grainBag_open_remaining. Read-only.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string", description: "corn|soybeans|wheat|milo|oats (optional)" },
          cropYear: { type: "number", description: "Crop year (optional)" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_where_now",
      description: "Where are the grain bags? Groups by fieldName and returns bags + bushels. Read-only.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string", description: "corn|soybeans|wheat|milo|oats (optional)" },
          cropYear: { type: "number", description: "Crop year (optional)" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_priority_pickup",
      description: "Show HIGH priority grain bags to pick up (schema-aware priority flag), grouped by field with bags + bushels. Read-only.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string", description: "corn|soybeans|wheat|milo|oats (optional)" },
          cropYear: { type: "number", description: "Crop year (optional)" }
        }
      }
    },
    {
      type: "function",
      name: "grain_bags_years",
      description: "List available cropYears for a cropType in grain bags (from v_grainBag_open_remaining). Read-only.",
      parameters: {
        type: "object",
        properties: {
          cropType: { type: "string", description: "corn|soybeans|wheat|milo|oats" }
        },
        required: ["cropType"]
      }
    }
  ];
}

/* =====================================================================
   CORE QUERY (shared)
===================================================================== */
function queryBagRows({ cropType, cropYear, fieldName, requirePriority, prioritySpec }) {
  const { whereSql, params } = buildWhere({ cropType, cropYear, fieldName });

  // prioritySpec = { source:"view"|"inv", col:"colName" }
  // If requirePriority and no prioritySpec => caller handles.
  let joinInv = `JOIN inventoryGrainBagMovements inv ON inv.id = v.bagSkuId`;
  let joinPgb = `JOIN productsGrainBags pgb ON pgb.id = inv.productId`;

  let prioritySelect = ``;
  let priorityWhere = ``;

  if (prioritySpec?.source === "view" && prioritySpec.col) {
    prioritySelect = `, v.${prioritySpec.col} AS priorityFlag`;
    // treat truthy values: 1, true, yes
    priorityWhere = ` AND (v.${prioritySpec.col} = 1 OR lower(CAST(v.${prioritySpec.col} AS TEXT)) IN ('true','t','yes','y','1'))`;
  } else if (prioritySpec?.source === "inv" && prioritySpec.col) {
    prioritySelect = `, inv.${prioritySpec.col} AS priorityFlag`;
    priorityWhere = ` AND (inv.${prioritySpec.col} = 1 OR lower(CAST(inv.${prioritySpec.col} AS TEXT)) IN ('true','t','yes','y','1'))`;
  }

  // Build SQL. Keep your CORN-rated + partialZeroGuard calculations unchanged.
  const sql = `
    SELECT
      v.fieldName AS fieldName,
      v.cropType  AS cropType,
      v.cropYear  AS cropYear,

      pgb.bushelsCorn AS bushelsCorn,
      pgb.lengthFt    AS lengthFt,

      v.remainingFull            AS remainingFull,
      v.remainingPartial         AS remainingPartial,
      v.remainingPartialFeetSum  AS remainingPartialFeetSum,

      (v.remainingFull * pgb.bushelsCorn) AS fullCornBu,

      (
        CASE
          WHEN v.remainingPartial <= 0 THEN 0.0
          ELSE
            (MIN(v.remainingPartialFeetSum, (v.remainingPartial * pgb.lengthFt)) / pgb.lengthFt) * pgb.bushelsCorn
        END
      ) AS partialCornBu
      ${prioritySelect}

    FROM v_grainBag_open_remaining v
    ${joinInv}
    ${joinPgb}
    ${whereSql}
    ${requirePriority ? priorityWhere : ""}
  `;

  return runSql({ sql, params, limit: 5000 });
}

/* =====================================================================
   TOOLS
===================================================================== */
export function grainHandleToolCall(name, args) {
  // --- years ---
  if (name === "grain_bags_years") {
    const cropType = normalizeCrop(args?.cropType);
    if (!cropType) return { ok: false, error: "missing_cropType" };

    const years = listYearsForCrop(cropType);
    if (!years.length) return { ok: true, text: `No open ${cropType} grain bag rows found.` };
    return { ok: true, text: `${cropType} grain bags exist in crop years: ${years.join(", ")}.` };
  }

  // --- count (bags, not bushels) ---
  if (name === "grain_bags_count_now") {
    const cropType = normalizeCrop(args?.cropType);
    const cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

    // If cropYear omitted but cropType provided and multiple years exist, ask rather than guessing.
    if (cropType && cropYear == null) {
      const years = listYearsForCrop(cropType);
      if (years.length > 1) {
        return { ok: true, text: `Which crop year for ${cropType} grain bags? I see: ${years.join(", ")}` };
      }
    }

    const r = runSql({
      sql: `
        SELECT
          SUM(COALESCE(v.remainingFull,0)) AS fullBags,
          SUM(COALESCE(v.remainingPartial,0)) AS partialBags
        FROM v_grainBag_open_remaining v
        ${(() => {
          const wh = [];
          const params = [];
          if (cropType) { wh.push("lower(v.cropType)=lower(?)"); params.push(cropType); }
          if (cropYear != null) { wh.push("v.cropYear=?"); params.push(cropYear); }
          const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
          // embed params using runSql directly below (safer to build fully):
          // but we need to return both sql+params; easiest is do it twice:
          return { whereSql, params };
        })().whereSql}
      `,
      params: (() => {
        const wh = [];
        const params = [];
        if (cropType) params.push(cropType);
        if (cropYear != null) params.push(cropYear);
        return params;
      })(),
      limit: 1
    });

    const row = Array.isArray(r?.rows) && r.rows.length ? r.rows[0] : {};
    const fullBags = n(row.fullBags);
    const partialBags = n(row.partialBags);
    const total = fullBags + partialBags;

    const label = cropType ? `${cropType} ` : "";
    const yr = cropYear != null ? ` ${cropYear}` : "";
    return { ok: true, text: `${round0(total).toLocaleString()} ${label}grain bags down now${yr} (full ${round0(fullBags)} + partial ${round0(partialBags)}).` };
  }

  // --- bushels now (your existing tool, unchanged behavior) ---
  if (name === "grain_bags_bushels_now") {
    const cropTypeRaw = safeStr(args?.cropType).trim();
    const cropType = cropTypeRaw ? normalizeCrop(cropTypeRaw) : "";
    const cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;
    const fieldName = safeStr(args?.fieldName).trim();
    const groupedByField = !!args?.groupedByField;

    // If cropType provided, enforce known factors
    let cropFactor = null;
    if (cropType) {
      cropFactor = cropFactorFor(cropType);
      if (cropFactor == null) {
        return { ok: false, error: `unknown_cropType:${cropType}` };
      }
    }

    // If cropYear omitted but cropType provided and multiple years exist, ask rather than guessing.
    if (cropType && cropYear == null) {
      const years = listYearsForCrop(cropType);
      if (years.length > 1) {
        return { ok: true, text: `Which crop year for ${cropType} grain bag bushels? I see: ${years.join(", ")}` };
      }
    }

    const hasCropFactor = cropFactor != null;

    const q = queryBagRows({
      cropType,
      cropYear,
      fieldName,
      requirePriority: false,
      prioritySpec: null
    });

    const rows = Array.isArray(q?.rows) ? q.rows : [];
    if (!rows.length) {
      return { ok: true, rowCount: 0, text: "0 bu (no qualifying grain bag rows)" };
    }

    const perField = new Map();
    let totalCornBu = 0;

    for (const row of rows) {
      const fullCornBu = Number(row.fullCornBu) || 0;
      const partialCornBu = Number(row.partialCornBu) || 0;
      const cornBu = fullCornBu + partialCornBu;

      totalCornBu += cornBu;

      const f = safeStr(row.fieldName).trim() || "(Unknown Field)";
      const cur = perField.get(f) || { cornBu: 0, cropType: safeStr(row.cropType), cropYear: row.cropYear };
      cur.cornBu += cornBu;
      perField.set(f, cur);
    }

    if (!hasCropFactor) {
      if (!groupedByField) {
        const text = `${round0(totalCornBu).toLocaleString()} bu (corn-rated)`;
        return { ok: true, rowCount: rows.length, cornRated: true, totalCornBu: totalCornBu, text };
      }

      const lines = [];
      lines.push(`Grain bags (corn-rated):`);
      const items = Array.from(perField.entries()).sort((a,b) => a[0].localeCompare(b[0]));
      for (const [field, agg] of items) {
        lines.push(`- ${field}: ${round0(agg.cornBu).toLocaleString()} bu (corn-rated)`);
      }
      lines.push(``);
      lines.push(`Total: ${round0(totalCornBu).toLocaleString()} bu (corn-rated)`);
      return { ok: true, rowCount: rows.length, cornRated: true, totalCornBu, text: lines.join("\n") };
    }

    const totalBu = totalCornBu * cropFactor;

    if (!groupedByField) {
      const text = `${round0(totalBu).toLocaleString()} bu`;
      return { ok: true, rowCount: rows.length, cropType, cropYear, totalBu, totalCornBu, text };
    }

    const lines = [];
    lines.push(`Grain bags (${cropType}${cropYear != null ? ` ${cropYear}` : ""}) — bushels now:`);
    const items = Array.from(perField.entries()).sort((a,b) => a[0].localeCompare(b[0]));
    for (const [field, agg] of items) {
      const bu = agg.cornBu * cropFactor;
      lines.push(`- ${field}: ${round0(bu).toLocaleString()} bu`);
    }
    lines.push(``);
    lines.push(`Total: ${round0(totalBu).toLocaleString()} bu`);
    return { ok: true, rowCount: rows.length, cropType, cropYear, totalBu, totalCornBu, text: lines.join("\n") };
  }

  // --- where are the bags? (group by fieldName) ---
  if (name === "grain_bags_where_now") {
    const cropType = normalizeCrop(args?.cropType);
    const cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

    if (cropType && cropYear == null) {
      const years = listYearsForCrop(cropType);
      if (years.length > 1) {
        return { ok: true, text: `Which crop year for ${cropType} grain bag locations? I see: ${years.join(", ")}` };
      }
    }

    const q = queryBagRows({
      cropType,
      cropYear,
      fieldName: "",
      requirePriority: false,
      prioritySpec: null
    });

    const rows = Array.isArray(q?.rows) ? q.rows : [];
    if (!rows.length) {
      const label = cropType ? `${cropType} ` : "";
      const yr = cropYear != null ? ` ${cropYear}` : "";
      return { ok: true, text: `No open ${label}grain bags found${yr}.` };
    }

    // If cropType provided, apply factor for that crop; else corn-rated.
    const factor = cropType ? (cropFactorFor(cropType) || 1.0) : null;

    const byField = new Map(); // field -> { full, partial, cornBu }
    for (const r of rows) {
      const f = safeStr(r.fieldName).trim() || "(Unknown Field)";
      const cur = byField.get(f) || { full: 0, partial: 0, cornBu: 0 };

      cur.full += n(r.remainingFull);
      cur.partial += Math.max(0, n(r.remainingPartial));
      cur.cornBu += (n(r.fullCornBu) + n(r.partialCornBu));

      byField.set(f, cur);
    }

    const fields = Array.from(byField.keys()).sort((a,b)=>a.localeCompare(b));
    const lines = [];
    const label = cropType ? `${cropType} ` : "";
    const yr = cropYear != null ? ` ${cropYear}` : "";

    lines.push(`Where ${label}grain bags are${yr} (by field):`);
    for (const f of fields) {
      const cur = byField.get(f);
      const bags = cur.full + cur.partial;
      const bu = factor == null ? cur.cornBu : (cur.cornBu * factor);
      const buLabel = factor == null ? "bu (corn-rated)" : "bu";
      lines.push(`- ${f}: ${round0(bags).toLocaleString()} bags, ${round0(bu).toLocaleString()} ${buLabel}`);
    }

    return { ok: true, text: lines.join("\n").trim() };
  }

  // --- priority pickup ---
  if (name === "grain_bags_priority_pickup") {
    const cropType = normalizeCrop(args?.cropType);
    const cropYear = Number.isFinite(args?.cropYear) ? Number(args.cropYear) : null;

    if (cropType && cropYear == null) {
      const years = listYearsForCrop(cropType);
      if (years.length > 1) {
        return { ok: true, text: `Which crop year for ${cropType} priority pickup bags? I see: ${years.join(", ")}` };
      }
    }

    // Try priority column in the VIEW first
    const viewCols = pragmaCols("v_grainBag_open_remaining");
    const viewPriority = findPriorityColumn(viewCols);

    // If not in view, try inventoryGrainBagMovements
    const invCols = pragmaCols("inventoryGrainBagMovements");
    const invPriority = viewPriority ? "" : findPriorityColumn(invCols);

    const prioritySpec =
      viewPriority ? { source: "view", col: viewPriority } :
      invPriority ? { source: "inv", col: invPriority } :
      null;

    if (!prioritySpec) {
      // No priority flag found anywhere: return helpful info, no guessing.
      const vHits = viewCols.map(c => c.name).filter(nm => norm(nm).includes("priority"));
      const iHits = invCols.map(c => c.name).filter(nm => norm(nm).includes("priority"));

      const lines = [];
      lines.push(`I can’t find a "priority pickup" flag in the SQLite snapshot tables I can see.`);
      if (vHits.length) lines.push(`View columns containing "priority": ${vHits.join(", ")}`);
      if (iHits.length) lines.push(`Inventory columns containing "priority": ${iHits.join(", ")}`);
      lines.push(`If you tell me the exact field name you use for priority in Firestore/snapshot, I’ll wire it in here.`);
      return { ok: true, text: lines.join("\n").trim() };
    }

    const q = queryBagRows({
      cropType,
      cropYear,
      fieldName: "",
      requirePriority: true,
      prioritySpec
    });

    const rows = Array.isArray(q?.rows) ? q.rows : [];
    if (!rows.length) {
      const label = cropType ? `${cropType} ` : "";
      const yr = cropYear != null ? ` ${cropYear}` : "";
      return { ok: true, text: `No HIGH priority ${label}grain bags found${yr}.` };
    }

    const factor = cropType ? (cropFactorFor(cropType) || 1.0) : null;

    const byField = new Map();
    for (const r of rows) {
      const f = safeStr(r.fieldName).trim() || "(Unknown Field)";
      const cur = byField.get(f) || { full: 0, partial: 0, cornBu: 0 };
      cur.full += n(r.remainingFull);
      cur.partial += Math.max(0, n(r.remainingPartial));
      cur.cornBu += (n(r.fullCornBu) + n(r.partialCornBu));
      byField.set(f, cur);
    }

    const fields = Array.from(byField.keys()).sort((a,b)=>a.localeCompare(b));
    const lines = [];
    const label = cropType ? `${cropType} ` : "";
    const yr = cropYear != null ? ` ${cropYear}` : "";

    lines.push(`HIGH priority ${label}grain bags to pick up${yr} (by field):`);
    for (const f of fields) {
      const cur = byField.get(f);
      const bags = cur.full + cur.partial;
      const bu = factor == null ? cur.cornBu : (cur.cornBu * factor);
      const buLabel = factor == null ? "bu (corn-rated)" : "bu";
      lines.push(`- ${f}: ${round0(bags).toLocaleString()} bags, ${round0(bu).toLocaleString()} ${buLabel}`);
    }

    return { ok: true, text: lines.join("\n").trim() };
  }

  return null;
}

/* =====================================================================
   Helpers used by handleChat for context carry (kept here so grain edits
   don’t touch handleChat)
===================================================================== */
export function userReferencesThoseBags(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return t.includes("those") && t.includes("bag");
}

export function extractExplicitBagNumber(text) {
  const t = (text || "").toString().toLowerCase();
  const m = t.match(/\bthose\s+(\d{1,6})\s+bags?\b/);
  if (!m) return null;
  const n2 = parseInt(m[1], 10);
  return Number.isFinite(n2) ? n2 : null;
}

export function userAsksBagBushels(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;

  const hasBushelWord = /\bbushels?\b/.test(t);
  const hasBu = /\bbu\b/.test(t) || /\bbu\.\b/.test(t);
  if (!(hasBushelWord || hasBu)) return false;

  const bagContext = t.includes("bag") && (t.includes("grain") || t.includes("field") || t.includes("bags") || t.includes("those"));
  return !!bagContext;
}

export function userAsksGroupedByField(text) {
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;
  return (
    t.includes("by field") ||
    t.includes("grouped by field") ||
    t.includes("per field") ||
    t.includes("each field") ||
    (t.includes("fields") && (t.includes("bushel") || /\bbu\b/.test(t)))
  );
}

export function assistantHasBushelNumber(text) {
  const s = safeStr(text);
  if (!s) return false;
  const re = /\b\d[\d,]*\.?\d*\s*(bu|bushels?)\b/i;
  return re.test(s);
}

export function sqlLooksLikeBagRows(sqlLower) {
  if (!sqlLower) return false;
  return sqlLower.includes("v_grainbag_open_remaining");
}

export function sqlLooksLikeCapacityChain(sqlLower) {
  if (!sqlLower) return false;
  return (
    sqlLower.includes("inventorygrainbagmovements") ||
    sqlLower.includes("productsgrainbags") ||
    sqlLower.includes("bushelscorn") ||
    sqlLower.includes("lengthft") ||
    sqlLower.includes("productid") ||
    sqlLower.includes("remainingpartial")
  );
}