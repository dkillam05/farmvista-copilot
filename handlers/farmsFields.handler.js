// /handlers/farmsFields.handler.js  (FULL FILE)
// Rev: 2026-01-02-handler-fields-only1
//
// Farms + Fields handler only.
// Uses snapshot-only /data/fieldData.js helpers.
//
// Requires these exports from /data/fieldData.js:
// - getSnapshotCollections(snapshot)
// - tryResolveField({ snapshot, query, includeArchived })
// - buildFieldBundle({ snapshot, fieldId })
// - formatFieldOptionLine({ snapshot, fieldId })

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

function wantsCount(q) {
  return q.includes("how many") || q.includes("count") || q.includes("total") || q.includes("number of");
}

function extractFarmNameGuess(raw) {
  // heuristic: "... on <farm>" or "... in <farm>" at end
  const m = String(raw || "").match(/\b(?:on|in)\s+([a-z0-9][a-z0-9\s\-\._]{1,60})$/i);
  if (!m) return "";
  return (m[1] || "").toString().trim();
}

function findFarmByName(cols, farmName) {
  const needle = norm(farmName);
  if (!needle) return null;

  for (const [id, f] of Object.entries(cols.farms || {})) {
    if (norm(f?.name) === needle) return { id, ...f };
  }
  for (const [id, f] of Object.entries(cols.farms || {})) {
    const n = norm(f?.name);
    if (n && n.startsWith(needle)) return { id, ...f };
  }
  for (const [id, f] of Object.entries(cols.farms || {})) {
    const n = norm(f?.name);
    if (n && n.includes(needle)) return { id, ...f };
  }
  return null;
}

export async function handleFarmsFields({ question, snapshot, user, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) {
    return {
      ok: false,
      answer: "Snapshot not loaded (missing farms/fields).",
      meta: { routed: "farmsFields", reason: cols.reason }
    };
  }

  const q = norm(question);

  // 1) COUNT FIELDS
  if (wantsCount(q) && q.includes("field")) {
    const allFields = Object.entries(cols.fields || {});
    let activeCount = 0;
    for (const [, f] of allFields) {
      if (isActiveStatus(f?.status)) activeCount++;
    }

    const total = allFields.length;

    if (includeArchived) {
      const archived = total - activeCount;
      return {
        ok: true,
        answer: `Fields: ${activeCount.toLocaleString()} active, ${archived.toLocaleString()} archived/inactive (${total.toLocaleString()} total).`,
        meta: { routed: "farmsFields", intent: "count_fields", total, activeCount, archived }
      };
    }

    return {
      ok: true,
      answer: `Active fields: ${activeCount.toLocaleString()}. (Say “including archived” if you want the total.)`,
      meta: { routed: "farmsFields", intent: "count_fields", activeCount }
    };
  }

  // 2) LIST FIELDS ON A FARM
  if ((q.includes("list") || q.includes("show")) && q.includes("field") && (q.includes(" on ") || q.includes(" in "))) {
    const farmGuess = extractFarmNameGuess(question);
    const farm = findFarmByName(cols, farmGuess);

    if (!farm) {
      return {
        ok: true,
        answer: `I couldn’t find that farm name. Try: "List fields on Farm 02" or use the exact farm name.`,
        meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmGuess }
      };
    }

    const ids = [];
    for (const [fieldId, f] of Object.entries(cols.fields || {})) {
      if (!includeArchived && !isActiveStatus(f?.status)) continue;
      if ((f?.farmId || "") === farm.id) ids.push(fieldId);
    }

    ids.sort((a, b) => {
      const la = formatFieldOptionLine({ snapshot, fieldId: a }) || "";
      const lb = formatFieldOptionLine({ snapshot, fieldId: b }) || "";
      return la.localeCompare(lb);
    });

    if (!ids.length) {
      return {
        ok: true,
        answer: `No ${includeArchived ? "" : "active "}fields found on ${farm.name || farm.id}.`,
        meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmId: farm.id }
      };
    }

    const lines = ids.slice(0, 40).map(id => `• ${formatFieldOptionLine({ snapshot, fieldId: id })}`);
    const more = ids.length > 40 ? `\n…plus ${ids.length - 40} more.` : "";

    return {
      ok: true,
      answer: `Fields on ${farm.name || farm.id} (${ids.length}):\n${lines.join("\n")}${more}`,
      meta: { routed: "farmsFields", intent: "list_fields_on_farm", farmId: farm.id, count: ids.length }
    };
  }

  // 3) FIELD LOOKUP (default)
  const res = tryResolveField({ snapshot, query: question, includeArchived });

  if (res.ok && res.resolved && res.fieldId) {
    const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
    if (!b.ok) {
      return {
        ok: true,
        answer: "Found the field id but could not load details.",
        meta: { routed: "farmsFields", intent: "field_lookup", reason: b.reason }
      };
    }

    const fieldName = (b.field?.name || b.fieldId).toString();
    const farmName = (b.farm?.name || "").toString();
    const status = (b.field?.status || "active").toString() || "active";
    const tillable = (typeof b.field?.tillable === "number") ? b.field.tillable : null;

    const parts = [];
    parts.push(`Field: ${fieldName}`);
    if (farmName) parts.push(`Farm: ${farmName}`);
    parts.push(`Status: ${status}`);
    if (tillable != null) parts.push(`Tillable: ${tillable.toLocaleString()} acres`);

    return {
      ok: true,
      answer: parts.join("\n"),
      meta: { routed: "farmsFields", intent: "field_lookup", fieldId: b.fieldId, confidence: res.confidence || null }
    };
  }

  if (res.ok && res.resolved === false && Array.isArray(res.candidates) && res.candidates.length) {
    const lines = res.candidates
      .map(c => `• ${formatFieldOptionLine({ snapshot, fieldId: c.fieldId })}`)
      .join("\n");

    return {
      ok: true,
      answer: `I found a few close matches. Which one did you mean?\n${lines}`,
      meta: { routed: "farmsFields", intent: "field_disambiguation", candidates: res.candidates.map(c => c.fieldId) }
    };
  }

  return {
    ok: true,
    answer:
      `I can help with farms and fields. Try:\n` +
      `• "How many active fields do we have?"\n` +
      `• "Show me Brown 80"\n` +
      `• "List fields on Lov Shack"`,
    meta: { routed: "farmsFields", intent: "help" }
  };
}