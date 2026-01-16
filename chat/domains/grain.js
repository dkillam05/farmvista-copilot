// /chat/domains/grain.js  (FULL FILE)
// Rev: 2026-01-16c  domain:grain
//
// Owns grain logic (tools + math).
// HARD RULES (kept):
// - PUTDOWN ONLY / VIEW ONLY: use v_grainBag_open_remaining only
// - NO STATUS
// - Partial picked-up bug guard:
//    if remainingPartial <= 0 => effectiveFeet = 0 (even if remainingPartialFeetSum > 0)
//    else effectiveFeet = MIN(remainingPartialFeetSum, remainingPartial * lengthFt)
// - Correct capacity chain:
//    v.bagSkuId -> inventoryGrainBagMovements.id -> productsGrainBags.id
//
// Output is DB-backed and numeric when rows exist.

'use strict';

import { runSql } from "../sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

const CROP_FACTOR = {
  corn: 1.00,
  soybeans: 0.93,
  wheat: 1.07,
  milo: 1.02,
  oats: 0.78
};

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
          fieldName: { type: "string", description: "Optional field name filter (substring match)"},
          groupedByField: { type: "boolean", description: "If true, return per-field totals + grand total" }
        }
      }
    }
  ];
}

function cropFactorFor(cropType) {
  const c = norm(cropType);
  return (c && Object.prototype.hasOwnProperty.call(CROP_FACTOR, c)) ? CROP_FACTOR[c] : null;
}

function moneyFmt(n) {
  // not used; placeholder if you later want $ formatting
  return String(n);
}

function round0(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function round1(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

export function grainHandleToolCall(name, args) {
  if (name !== "grain_bags_bushels_now") return null;

  const cropTypeRaw = safeStr(args?.cropType).trim();
  const cropType = cropTypeRaw ? norm(cropTypeRaw) : "";
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

  // Build SQL
  // NOTE: We ALWAYS compute from the view, and ALWAYS JOIN the capacity chain.
  // PartialZeroGuard applied in SQL via CASE + MIN.
  const where = [];
  const params = [];

  if (cropType) {
    where.push(`lower(v.cropType) = lower(?)`);
    params.push(cropType);
  }
  if (cropYear != null) {
    where.push(`v.cropYear = ?`);
    params.push(cropYear);
  }
  if (fieldName) {
    where.push(`lower(v.fieldName) LIKE lower(?)`);
    params.push(`%${fieldName}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // If cropType not provided, we still can compute corn-rated totals, but cropFactor is unknown.
  // For this tool we REQUIRE cropType if user wants crop-adjusted bushels.
  // However, to keep UX smooth, if cropType missing, we compute corn-rated only and label it.
  const hasCropFactor = cropFactor != null;

  const baseSql = `
    SELECT
      v.fieldName AS fieldName,
      v.cropType  AS cropType,
      v.cropYear  AS cropYear,

      -- capacity
      pgb.bushelsCorn AS bushelsCorn,
      pgb.lengthFt    AS lengthFt,

      -- remaining
      v.remainingFull            AS remainingFull,
      v.remainingPartial         AS remainingPartial,
      v.remainingPartialFeetSum  AS remainingPartialFeetSum,

      -- computed CORN-rated bu (full)
      (v.remainingFull * pgb.bushelsCorn) AS fullCornBu,

      -- PARTIALS (HARD: partialZeroGuard + cap)
      (
        CASE
          WHEN v.remainingPartial <= 0 THEN 0.0
          ELSE
            (MIN(v.remainingPartialFeetSum, (v.remainingPartial * pgb.lengthFt)) / pgb.lengthFt) * pgb.bushelsCorn
        END
      ) AS partialCornBu

    FROM v_grainBag_open_remaining v
    JOIN inventoryGrainBagMovements inv ON inv.id = v.bagSkuId
    JOIN productsGrainBags pgb ON pgb.id = inv.productId
    ${whereSql}
  `;

  const r = runSql({ sql: baseSql, params, limit: 5000 });
  const rows = Array.isArray(r?.rows) ? r.rows : [];

  if (!rows.length) {
    return { ok: true, rowCount: 0, text: "0 bu (no qualifying grain bag rows)" };
  }

  // Aggregate
  const perField = new Map(); // fieldName -> {cornBu, cropBu, cropType,cropYear}
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

  // Determine crop factor if not provided (mixed crops possible)
  // If user didn't specify cropType, we return CORN-rated.
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
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
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