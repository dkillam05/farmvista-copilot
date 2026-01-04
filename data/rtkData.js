// /data/rtkData.js  (FULL FILE)
// Rev: 2026-01-04-rtkData2-tillable
//
// CHANGE:
// ✅ getTowerUsage() now includes per-field tillable and totals.tillable
// ✅ getFieldTowerSummary unchanged

'use strict';

import {
  getSnapshotCollections,
  lookupTowerByName as lookupTowerByNameFromFieldData,
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

export function lookupTowerByName({ snapshot, towerName }) {
  return lookupTowerByNameFromFieldData({ snapshot, towerName });
}

export function summarizeTowersUsed({ snapshot, includeArchived = false }) {
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