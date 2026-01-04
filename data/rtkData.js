// /data/rtkData.js  (FULL FILE)
// Rev: 2026-01-04-rtkData3-robust-lookup
//
// CHANGE:
// ✅ Robust tower lookup (normalizes punctuation/spaces, matches towerId too)
// ✅ getTowerUsage includes tillable totals/fields (kept)
// ✅ getFieldTowerSummary unchanged

'use strict';

import {
  getSnapshotCollections,
  summarizeTowers as summarizeTowersFromFieldData,
  tryResolveField,
  buildFieldBundle
} from "./fieldData.js";

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

function cleanName(s) {
  // Lowercase, remove the words rtk/tower, replace non-alphanum with spaces, collapse.
  return norm(s)
    .replace(/\b(rtk|tower|towers|base\s*station)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lookupTowerByName({ snapshot, towerName }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason, tower: null };

  const raw = (towerName || "").toString().trim();
  if (!raw) return { ok: false, reason: "missing_name", tower: null };

  const needle = cleanName(raw);
  if (!needle) return { ok: false, reason: "missing_name", tower: null };

  // 1) Direct id hit (allow user to paste towerId)
  for (const [id, t] of Object.entries(cols.rtkTowers || {})) {
    if (cleanName(id) === needle) return { ok: true, tower: { id, ...t } };
  }

  // 2) Exact normalized name match
  for (const [id, t] of Object.entries(cols.rtkTowers || {})) {
    const n = cleanName(t?.name || "");
    if (n && n === needle) return { ok: true, tower: { id, ...t } };
  }

  // 3) Starts-with / includes best match scoring
  let best = null;
  let bestScore = 0;

  for (const [id, t] of Object.entries(cols.rtkTowers || {})) {
    const name = (t?.name || "").toString();
    const n = cleanName(name);
    if (!n) continue;

    let score = 0;
    if (n.startsWith(needle)) score = 90;
    else if (n.includes(needle)) score = 75;
    else if (needle.includes(n) && n.length >= 4) score = 60;

    if (score > bestScore) {
      bestScore = score;
      best = { id, ...t };
    }
  }

  if (best) return { ok: true, tower: best };
  return { ok: false, reason: "not_found", tower: null };
}

export function summarizeTowersUsed({ snapshot, includeArchived = false }) {
  // keep using your already-correct summarize logic from fieldData.js
  return summarizeTowersFromFieldData({ snapshot, includeArchived });
}

export function getTowerUsage({ snapshot, towerId, includeArchived = false }) {
  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return { ok: false, reason: cols.reason };

  const id = (towerId || "").toString().trim();
  if (!id) return { ok: false, reason: "missing_tower_id" };

  const t = cols.rtkTowers?.[id] || null;
  const tower = t ? { id, ...t } : { id, name: id };

  const fields = [];
  const farmIds = new Set();

  let totalTillable = 0;

  for (const [fieldId, f] of Object.entries(cols.fields || {})) {
    const active = isActiveStatus(f?.status);
    if (!includeArchived && !active) continue;

    const tid = (f?.rtkTowerId || "").toString().trim();
    if (tid !== id) continue;

    const farmId = (f?.farmId || "").toString().trim();
    if (farmId) farmIds.add(farmId);

    const till = num(f?.tillable);
    totalTillable += till;

    fields.push({
      fieldId,
      name: (f?.name || fieldId).toString(),
      farmId: farmId || null,
      farmName: farmId ? (cols.farms?.[farmId]?.name || farmId).toString() : "",
      tillable: till
    });
  }

  fields.sort((a, b) => (a.farmName || "").localeCompare(b.farmName || "") || a.name.localeCompare(b.name));

  const farms = [];
  for (const farmId of farmIds) {
    const farm = cols.farms?.[farmId] || null;
    if (!farm) continue;
    if (!includeArchived && !isActiveStatus(farm?.status)) continue;
    farms.push({ farmId, name: (farm.name || farmId).toString() });
  }
  farms.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    tower,
    farms,
    fields,
    counts: { farms: farms.length, fields: fields.length },
    totals: { tillable: totalTillable }
  };
}

export function getFieldTowerSummary({ snapshot, fieldQuery, includeArchived = false }) {
  const res = tryResolveField({ snapshot, query: fieldQuery, includeArchived });
  if (!res.ok) return { ok: false, reason: res.reason || "resolve_failed", debug: res.debug || null };
  if (!res.resolved || !res.fieldId) return { ok: false, reason: "field_not_found", debug: res.debug || null };

  const b = buildFieldBundle({ snapshot, fieldId: res.fieldId });
  if (!b.ok) return { ok: false, reason: b.reason || "bundle_failed" };

  const field = b.field || {};
  const farm = b.farm || {};
  const tower = b.tower || null;

  return {
    ok: true,
    fieldId: b.fieldId,
    fieldName: (field.name || b.fieldId).toString(),
    farmName: (farm.name || "").toString(),
    towerId: tower ? (tower.id || "") : "",
    towerName: tower ? (tower.name || tower.id || "").toString() : "",
    tower: tower || null,
    confidence: res.confidence || null,
    ambiguous: !!res.ambiguous,
    debug: res.debug || null
  };
}