// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-03-handler-autopick-debug2
//
// FINAL CHANGE:
// ❌ REMOVED all category menus and "Quick check" prompts
// ✅ ALWAYS answer if possible
// ✅ If not answerable, explicitly say which FILE blocked it
// ✅ Never asks the user to classify intent

'use strict';

import {
  getSnapshotCollections,
  tryResolveField,
  buildFieldBundle,
  formatFieldOptionLine
} from "../data/fieldData.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true;
  return v !== "archived" && v !== "inactive";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function fmtAcre(n) {
  return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export async function handleFarmsFields({ question, snapshot, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);

  if (!cols.ok) {
    return {
      ok: false,
      answer: "Please check /data/fieldData.js — snapshot collections failed to load.",
      meta: { debugFile: "/data/fieldData.js", reason: cols.reason }
    };
  }

  const q = norm(question);

  // ======================
  // FIELD LOOKUP (PRIMARY)
  // ======================
  const res = tryResolveField({ snapshot, query: question, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });

    if (!b.ok) {
      return {
        ok: false,
        answer: "Please check /handlers/farmsFields.handler.js — buildFieldBundle failed.",
        meta: { debugFile: "/handlers/farmsFields.handler.js", reason: b.reason }
      };
    }

    const f = b.field || {};
    const farm = b.farm || {};

    const out = [];
    out.push(`Field: ${f.name || b.fieldId}`);
    if (farm.name) out.push(`Farm: ${farm.name}`);
    if (f.county) out.push(`County: ${f.county}${f.state ? ", " + f.state : ""}`);
    out.push(`Status: ${f.status || "active"}`);
    if (typeof f.tillable === "number") out.push(`Tillable: ${fmtAcre(f.tillable)} acres`);
    if (num(f.helAcres) > 0) out.push(`HEL acres: ${fmtAcre(f.helAcres)}`);
    if (num(f.crpAcres) > 0) out.push(`CRP acres: ${fmtAcre(f.crpAcres)}`);

    if (res.ambiguous) {
      out.push(`(Auto-selected best match — check /data/fieldData.js scoring if wrong.)`);
    }

    return {
      ok: true,
      answer: out.join("\n"),
      meta: { debugFile: "/data/fieldData.js", confidence: res.confidence || null }
    };
  }

  // ======================
  // TOTAL FAILURE PATH
  // ======================
  return {
    ok: false,
    answer: "Please check /data/fieldData.js — resolver could not match this query.",
    meta: {
      debugFile: "/data/fieldData.js",
      resolverDebug: res?.debug || null
    }
  };
}