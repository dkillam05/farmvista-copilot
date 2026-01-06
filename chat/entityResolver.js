// /chat/entityResolver.js  (FULL FILE)
// Rev: 2026-01-06-entityResolver1-auto
//
// Automatic shorthand / alias resolver for snapshot collections.
// - Builds alias index from the snapshot at runtime (no hardcoding every farm/field).
// - Works for farms/fields/rtkTowers now, and will index any other collections present.
//
// Exports:
// - resolveEntity({ snapshot, collection, query, includeArchived, limit })
// - resolveAny({ snapshot, query, includeArchived, limit })  // returns best matches across collections
//
// Notes:
// - This is deterministic. No OpenAI required.
// - If you want manual aliases later, we can layer them on top.

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  if (d.data && typeof d.data === "object") return d.data;
  if (typeof d === "object") return d;
  return null;
}

function getCollectionMap(colsRoot, name) {
  if (!colsRoot) return null;
  const v = colsRoot[name];
  if (v && typeof v === "object") return v;
  return null;
}

function isActiveStatus(s) {
  const v = norm(s);
  if (!v) return true;
  return v !== "archived" && v !== "inactive";
}

function stripPunct(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[_.,/\\|()[\]{}]+/g, " ")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function squish(s) {
  return stripPunct(s).replace(/\s+/g, "");
}

function tokens(s) {
  const t = stripPunct(s).split(" ").filter(Boolean);
  return t;
}

function acronymFromTokens(toks) {
  const a = toks.map(t => (t[0] || "")).join("");
  return a.length >= 2 ? a : "";
}

function numericPrefix(s) {
  // fields often start with 3-4 digit id like "0515-Grandma ..."
  const m = (s || "").toString().trim().match(/^(\d{3,4})\b/);
  if (!m) return "";
  return m[1];
}

function numericShort(n) {
  // "0515" -> "515"
  const s = String(n || "");
  if (!/^\d{3,4}$/.test(s)) return "";
  return String(parseInt(s, 10));
}

function candidateLabels(docId, doc, collection) {
  // heuristic label fields across arbitrary collections
  const d = doc || {};
  const labels = [];

  // common fields
  if (typeof d.name === "string" && d.name.trim()) labels.push(d.name.trim());
  if (typeof d.displayName === "string" && d.displayName.trim()) labels.push(d.displayName.trim());
  if (typeof d.title === "string" && d.title.trim()) labels.push(d.title.trim());
  if (typeof d.label === "string" && d.label.trim()) labels.push(d.label.trim());
  if (typeof d.unit === "string" && d.unit.trim()) labels.push(d.unit.trim());
  if (typeof d.assetTag === "string" && d.assetTag.trim()) labels.push(d.assetTag.trim());
  if (typeof d.makeModel === "string" && d.makeModel.trim()) labels.push(d.makeModel.trim());
  if (typeof d.model === "string" && d.model.trim()) labels.push(d.model.trim());
  if (typeof d.email === "string" && d.email.trim()) labels.push(d.email.trim());

  // Some collections use doc IDs as meaningful labels
  labels.push(String(docId || "").trim());

  // De-dupe
  const seen = new Set();
  const out = [];
  for (const x of labels) {
    const k = norm(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function buildAliasesForLabel(label, collection) {
  const a = new Set();
  const raw = (label || "").toString().trim();
  if (!raw) return a;

  const p = stripPunct(raw);
  const sq = squish(raw);
  const toks = tokens(raw);

  a.add(norm(raw));
  if (p) a.add(p);
  if (sq) a.add(sq);

  // token aliases
  for (const t of toks) {
    if (t.length >= 2) a.add(t);
  }

  // acronym
  const acr = acronymFromTokens(toks);
  if (acr) a.add(acr);

  // collection-specific: fields numeric prefix
  if (collection === "fields" || raw.match(/^\d{3,4}[-–—]/)) {
    const pref = numericPrefix(raw);
    if (pref) {
      a.add(pref);
      const short = numericShort(pref);
      if (short) a.add(short);
    }
  }

  return a;
}

function scoreMatch(queryNorm, alias) {
  // deterministic scoring
  if (!queryNorm || !alias) return 0;
  if (alias === queryNorm) return 100;

  // exact squish match
  if (squish(alias) === squish(queryNorm)) return 95;

  // starts with
  if (alias.startsWith(queryNorm)) return 90;

  // contains
  if (alias.includes(queryNorm)) return 80;

  // token overlap
  const qT = new Set(tokens(queryNorm));
  const aT = new Set(tokens(alias));
  let hit = 0;
  for (const t of qT) if (t.length >= 2 && aT.has(t)) hit++;
  if (hit) return Math.min(79, 55 + hit * 8);

  return 0;
}

function getSnapshotCollections(snapshot) {
  const snapJson = snapshot?.json || null;
  const root = getCollectionsRoot(snapJson);
  if (!root) return { ok: false, reason: "snapshot_missing_collections", root: null };
  return { ok: true, root };
}

// Cache per-process (Cloud Run instance). Safe.
const CACHE = new Map(); // key -> { builtAt, index }

function getCacheKey(snapshot) {
  // Prefer snapshotId if you have it; fallback to JSON top-level hash-ish
  const id = (snapshot?.activeSnapshotId || snapshot?.meta?.snapshotId || "").toString().trim();
  if (id) return `snap:${id}`;
  const loadedAt = (snapshot?.loadedAt || "").toString().trim();
  return loadedAt ? `loaded:${loadedAt}` : "snap:unknown";
}

function buildIndex(snapshot) {
  const key = getCacheKey(snapshot);
  const existing = CACHE.get(key);
  if (existing && existing.index) return existing.index;

  const cols = getSnapshotCollections(snapshot);
  if (!cols.ok) return null;

  const root = cols.root;

  const index = {
    key,
    builtAt: Date.now(),
    // collection -> array of records
    collections: {}
  };

  const colNames = Object.keys(root || {}).filter(k => typeof root[k] === "object");

  for (const colName of colNames) {
    const map = getCollectionMap(root, colName);
    if (!map) continue;

    const recs = [];

    for (const [docId, doc] of Object.entries(map)) {
      // respect active-only by default; resolver can re-check on output too
      const status = (doc && doc.status != null) ? String(doc.status) : "";
      const labels = candidateLabels(docId, doc, colName);

      const aliasSet = new Set();
      for (const lab of labels) {
        const a = buildAliasesForLabel(lab, colName);
        for (const x of a) aliasSet.add(x);
      }

      recs.push({
        id: docId,
        collection: colName,
        status: status || "",
        labels,
        aliases: Array.from(aliasSet.values())
      });
    }

    index.collections[colName] = recs;
  }

  CACHE.set(key, { builtAt: Date.now(), index });
  return index;
}

export function resolveEntity({ snapshot, collection, query, includeArchived = false, limit = 5 }) {
  const idx = buildIndex(snapshot);
  if (!idx) return { ok: false, reason: "index_build_failed", matches: [] };

  const qRaw = (query || "").toString().trim();
  const qn = norm(qRaw);
  if (!qn) return { ok: false, reason: "missing_query", matches: [] };

  const recs = idx.collections?.[collection] || null;
  if (!recs) return { ok: false, reason: "unknown_collection", matches: [] };

  const out = [];

  for (const r of recs) {
    if (!includeArchived && r.status && !isActiveStatus(r.status)) continue;

    let best = 0;
    let bestAlias = "";
    for (const a of r.aliases) {
      const s = scoreMatch(qn, a);
      if (s > best) {
        best = s;
        bestAlias = a;
        if (best >= 100) break;
      }
    }
    if (best <= 0) continue;

    out.push({
      id: r.id,
      collection,
      score: best,
      label: r.labels?.[0] || r.id,
      matched: bestAlias || null
    });
  }

  out.sort((a, b) => (b.score - a.score) || a.label.localeCompare(b.label));
  return { ok: true, matches: out.slice(0, Math.max(1, Math.min(20, limit))), indexKey: idx.key };
}

export function resolveAny({ snapshot, query, includeArchived = false, limit = 8 }) {
  const idx = buildIndex(snapshot);
  if (!idx) return { ok: false, reason: "index_build_failed", matches: [] };

  const qRaw = (query || "").toString().trim();
  const qn = norm(qRaw);
  if (!qn) return { ok: false, reason: "missing_query", matches: [] };

  const out = [];

  for (const [colName, recs] of Object.entries(idx.collections || {})) {
    for (const r of recs) {
      if (!includeArchived && r.status && !isActiveStatus(r.status)) continue;

      let best = 0;
      for (const a of r.aliases) {
        const s = scoreMatch(qn, a);
        if (s > best) best = s;
        if (best >= 100) break;
      }
      if (best <= 0) continue;

      out.push({
        id: r.id,
        collection: colName,
        score: best,
        label: r.labels?.[0] || r.id
      });
    }
  }

  out.sort((a, b) => (b.score - a.score) || a.collection.localeCompare(b.collection) || a.label.localeCompare(b.label));
  return { ok: true, matches: out.slice(0, Math.max(1, Math.min(30, limit))), indexKey: idx.key };
}