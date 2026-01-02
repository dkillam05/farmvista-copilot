// /data/fieldData.js  (FULL FILE)
// Rev: 2026-01-02-fields-only1-esm
//
// FIELDS ONLY.
// Snapshot-only access for fields (+ farm name lookup for display).
// ❌ Removed ALL RTK tower logic and outputs.
// ✅ Deterministic + forgiving field matching (no exact-only traps).
//
// ESM build (for Node ESM import).
//
// Exports kept for chat:
// - getSnapshotCollections(snapshot)
// - buildFieldBundle({ snapshot, fieldId })   // returns field + (optional) farm
// - tryResolveField({ snapshot, query, includeArchived })
// - formatFieldOptionLine({ snapshot, fieldId })

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};

  // Common snapshot wrapper shapes we’ve seen:
  // 1) { data: { __collections__: { farms:{}, fields:{} } } }
  // 2) { __collections__: { farms:{}, fields:{} } }
  // 3) { data: { farms:{}, fields:{} } }   (already flattened)
  // 4) { farms:{}, fields:{} }             (already flattened)

  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") {
    return d.data.__collections__;
  }

  if (d.__collections__ && typeof d.__collections__ === "object") {
    return d.__collections__;
  }

  if (d.data && typeof d.data === "object" && d.data.farms && d.data.fields) {
    return d.data;
  }

  if (typeof d === "object" && d.farms && d.fields) {
    return d;
  }

  return null;
}

function getCollectionMap(colsRoot, name) {
  if (!colsRoot) return null;
  const v = colsRoot[name];
  if (v && typeof v === "object") return v;
  return null;
}

export function getSnapshotCollections(snapshot) {
  const snapJson = snapshot?.json || null;
  const root = getCollectionsRoot(snapJson);

  if (!root) {
    return { ok: false, farms: {}, fields: {}, reason: "snapshot_missing_collections" };
  }

  return {
    ok: true,
    farms: getCollectionMap(root, "farms") || {},
    fields: getCollectionMap(root, "fields") || {}
  };
}

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true;
  return v !== "archived" && v !== "inactive";
}

function scoreName(hay, needle) {
  const h = norm(hay);
  const n = norm(needle);
  if (!h || !n) return 0;

  if (h === n) return 100;
  if (h.startsWith(n)) return 90;
  if (h.includes(n)) return 75;

  // token overlap
  const nt = n.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const t of nt) if (t.length >= 2 && h.includes(t)) hits++;
  return hits ? Math.min(74, 50 + hits * 8) : 0;
}

export function buildFieldBundle({ snapshot, fieldId }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason };

  const field = cols.fields?.[fieldId] || null;
  if (!field) return { ok: false, reason: "field_not_found" };

  const farm = field.farmId ? (cols.farms?.[field.farmId] || null) : null;

  return {
    ok: true,
    fieldId,
    field: { id: fieldId, ...field },
    farm: farm ? { id: field.farmId, ...farm } : null
  };
}

export function tryResolveField({ snapshot, query, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason };

  const q = (query || "").toString().trim();
  if (!q) return { ok: false, reason: "missing_query" };

  // direct id
  if (cols.fields?.[q]) return { ok: true, resolved: true, fieldId: q, confidence: 100 };

  // exact name
  const qn = norm(q);
  for (const [id, f] of Object.entries(cols.fields || {})) {
    if (!includeArchived && !isActiveStatus(f?.status)) continue;
    if (norm(f?.name) === qn) return { ok: true, resolved: true, fieldId: id, confidence: 100 };
  }

  // scored suggestions
  const matches = [];
  for (const [id, f] of Object.entries(cols.fields || {})) {
    if (!includeArchived && !isActiveStatus(f?.status)) continue;
    const sc = scoreName(f?.name || "", q);
    if (sc <= 0) continue;
    matches.push({ fieldId: id, score: sc, name: (f?.name || "").toString() });
  }
  matches.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

  if (!matches.length) return { ok: true, resolved: false, candidates: [] };

  const top = matches[0];
  const second = matches[1] || null;
  const strong = top.score >= 90;
  const separated = !second || (top.score - second.score >= 12);

  if (strong && separated) return { ok: true, resolved: true, fieldId: top.fieldId, confidence: top.score };
  return { ok: true, resolved: false, candidates: matches.slice(0, 3) };
}

export function formatFieldOptionLine({ snapshot, fieldId }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return "";
  const f = cols.fields?.[fieldId] || null;
  if (!f) return "";
  const farm = f?.farmId ? (cols.farms?.[f.farmId] || null) : null;
  const farmName = (farm?.name || "").toString().trim();
  const label = (f?.name || "").toString().trim();
  return farmName ? `${label} (${farmName})` : label;
}

// Optional convenience default export
export default {
  getSnapshotCollections,
  buildFieldBundle,
  tryResolveField,
  formatFieldOptionLine
};
