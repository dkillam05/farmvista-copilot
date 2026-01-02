// /data/fieldLookup.js  (FULL FILE)
// Rev: 2026-01-02-fieldLookup-v1
//
// Read-only Firestore lookups for fields + joins:
// - fields (by exact name; fallback to best-match scan)
// - farms (by field.farmId)
// - rtkTowers (by field.rtkTowerId)
//
// Returns a clean object for chat/UI layers to format.

'use strict';

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function scoreName(nameLower, needleLower) {
  if (!nameLower || !needleLower) return 0;
  if (nameLower === needleLower) return 100;
  if (nameLower.startsWith(needleLower)) return 80;
  if (nameLower.includes(needleLower)) return 55;
  return 0;
}

/**
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} fieldName
 * @returns {Promise<{
 *  ok: boolean,
 *  reason?: string,
 *  matchType?: 'exact'|'scan',
 *  field?: any, farm?: any, tower?: any
 * }>}
 */
export async function lookupFieldBundleByName(db, fieldName) {
  const name = (fieldName || "").toString().trim();
  if (!name) return { ok: false, reason: "missing_field_name" };

  // 1) exact match
  const exact = await findFieldByExactName(db, name);
  if (exact) {
    const bundle = await joinBundle(db, exact.id, exact.data);
    return { ok: true, matchType: "exact", ...bundle };
  }

  // 2) scan fallback (bounded)
  const scan = await findFieldByScanName(db, name);
  if (!scan) return { ok: false, reason: "not_found" };

  const bundle = await joinBundle(db, scan.id, scan.data);
  return { ok: true, matchType: "scan", ...bundle };
}

async function findFieldByExactName(db, name) {
  try {
    const snap = await db.collection("fields")
      .where("name", "==", name)
      .limit(1)
      .get();

    let hit = null;
    snap.forEach(d => { if (!hit) hit = { id: d.id, data: d.data() || {} }; });
    return hit;
  } catch {
    return null;
  }
}

async function findFieldByScanName(db, name) {
  const needle = norm(name);
  if (!needle) return null;

  // bounded scan — safe for now; later we can add better indexing/search
  const snap = await db.collection("fields").limit(5000).get();

  let best = null;
  let bestScore = 0;

  snap.forEach(d => {
    const data = d.data() || {};
    const n = norm(data.name || "");
    const sc = scoreName(n, needle);
    if (sc > bestScore) {
      bestScore = sc;
      best = { id: d.id, data };
    }
  });

  // require a decent match
  if (bestScore >= 55) return best;
  return null;
}

async function joinBundle(db, fieldId, fieldData) {
  const f = fieldData || {};
  const farmId = (f.farmId || "").toString().trim() || null;
  const rtkTowerId = (f.rtkTowerId || "").toString().trim() || null;

  let farm = null;
  if (farmId) {
    try {
      const s = await db.collection("farms").doc(farmId).get();
      if (s.exists) {
        const d = s.data() || {};
        farm = { id: s.id, name: (d.name || "").toString(), status: (d.status || "").toString() };
      }
    } catch {}
  }

  let tower = null;
  if (rtkTowerId) {
    try {
      const s = await db.collection("rtkTowers").doc(rtkTowerId).get();
      if (s.exists) {
        const d = s.data() || {};
        tower = {
          id: s.id,
          name: (d.name || "").toString(),
          frequencyMHz: (d.frequencyMHz || "").toString(),
          networkId: (typeof d.networkId === "number" ? d.networkId : d.networkId || null)
        };
      }
    } catch {}
  }

  const field = {
    id: fieldId,
    name: (f.name || "").toString(),
    status: (f.status || "").toString(),
    county: (f.county || "").toString(),
    state: (f.state || "").toString(),
    tillable: (typeof f.tillable === "number" ? f.tillable : null),
    farmId,
    rtkTowerId
  };

  return { field, farm, tower };
}
