// /data/fieldData.js  (FULL FILE)
// Rev: 2026-01-02-fieldData-snapshot1
//
// Snapshot-only data access for:
// - farms
// - fields
// - rtkTowers
//
// IMPORTANT:
// - Reads from snapshot.json (loaded from Firebase Storage by context/snapshot.js)
// - No Firestore queries here.
// - Designed for fast lookups + suggestions at scale.

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  if (d.data && typeof d.data === "object" && d.data.farms && d.data.fields) return d.data;
  if (typeof d === "object" && d.farms && d.fields) return d;
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
    return {
      ok: false,
      farms: {},
      fields: {},
      rtkTowers: {},
      reason: "snapshot_missing_collections"
    };
  }

  const farms = getCollectionMap(root, "farms") || {};
  const fields = getCollectionMap(root, "fields") || {};
  const rtkTowers = getCollectionMap(root, "rtkTowers") || {};

  return { ok: true, farms, fields, rtkTowers };
}

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true; // treat missing as active
  return v !== "archived" && v !== "inactive";
}

export function buildFieldBundle({ snapshot, fieldId }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason };

  const field = cols.fields?.[fieldId] || null;
  if (!field) return { ok: false, reason: "field_not_found" };

  const farm = field.farmId ? (cols.farms?.[field.farmId] || null) : null;
  const tower = field.rtkTowerId ? (cols.rtkTowers?.[field.rtkTowerId] || null) : null;

  return {
    ok: true,
    fieldId,
    field: { id: fieldId, ...field },
    farm: farm ? { id: field.farmId, ...farm } : null,
    tower: tower ? { id: field.rtkTowerId, ...tower } : null
  };
}

function scoreFieldName(fieldName, q) {
  const n = norm(fieldName);
  const needle = norm(q);
  if (!n || !needle) return 0;

  if (n === needle) return 100;
  if (n.startsWith(needle)) return 90;
  if (n.includes(needle)) return 80;

  // numeric hint support: "801" should match "0801-..."
  const digits = needle.replace(/\D/g, "");
  if (digits && n.includes(digits)) return 75;

  // token overlap
  const toks = needle.split(/\s+/).filter(Boolean);
  if (!toks.length) return 0;
  let hit = 0;
  for (const t of toks) if (t.length >= 2 && n.includes(t)) hit++;
  if (hit) return Math.min(74, 50 + hit * 8);

  return 0;
}

export function suggestFields({ snapshot, query, includeArchived = false, limit = 3 }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason, matches: [] };

  const q = (query || "").toString().trim();
  if (!q) return { ok: false, reason: "missing_query", matches: [] };

  const out = [];

  for (const [id, f] of Object.entries(cols.fields || {})) {
    if (!includeArchived && !isActiveStatus(f?.status)) continue;
    const sc = scoreFieldName(f?.name || "", q);
    if (sc <= 0) continue;

    const farm = f?.farmId ? (cols.farms?.[f.farmId] || null) : null;

    out.push({
      fieldId: id,
      score: sc,
      name: (f?.name || "").toString(),
      status: (f?.status || "").toString() || "active",
      tillable: (typeof f?.tillable === "number" ? f.tillable : null),
      farmId: (f?.farmId || null),
      farmName: (farm?.name || "").toString(),
      rtkTowerId: (f?.rtkTowerId || null)
    });
  }

  out.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return { ok: true, matches: out.slice(0, Math.max(1, Math.min(10, limit))) };
}

export function tryResolveField({ snapshot, query, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason };

  const q = (query || "").toString().trim();
  if (!q) return { ok: false, reason: "missing_query" };

  // 1) direct ID hit
  if (cols.fields?.[q]) {
    return { ok: true, resolved: true, fieldId: q, confidence: 100 };
  }

  // 2) exact name match
  const qn = norm(q);
  let exactId = null;
  for (const [id, f] of Object.entries(cols.fields || {})) {
    if (!includeArchived && !isActiveStatus(f?.status)) continue;
    if (norm(f?.name) === qn) {
      exactId = id;
      break;
    }
  }
  if (exactId) return { ok: true, resolved: true, fieldId: exactId, confidence: 100 };

  // 3) best-match suggestions
  const sug = suggestFields({ snapshot, query: q, includeArchived, limit: 5 });
  if (!sug.ok) return { ok: false, reason: sug.reason };

  if (!sug.matches.length) return { ok: true, resolved: false, candidates: [] };

  // if top match is clearly ahead, auto-resolve
  const top = sug.matches[0];
  const second = sug.matches[1] || null;

  const strong = top.score >= 90;
  const separated = !second || (top.score - second.score >= 12);

  if (strong && separated) {
    return { ok: true, resolved: true, fieldId: top.fieldId, confidence: top.score };
  }

  return { ok: true, resolved: false, candidates: sug.matches.slice(0, 3) };
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
