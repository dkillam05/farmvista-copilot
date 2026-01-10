// /chat/resolve-core.js  (FULL FILE)
// Rev: 2026-01-10-resolve-core1
//
// Generic fuzzy resolver core for SQLite-backed entities.
// - Broad candidate pull via LIKE + tokenized patterns
// - Fuzzy scoring: token overlap + normalized Levenshtein
// - Returns either a confident match or a "did you mean" candidate list

'use strict';

import { runSql } from "./sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)); }

function norm(s) {
  return safeStr(s)
    .toLowerCase()
    .replace(/[_–—]/g, "-")
    .replace(/[^a-z0-9\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  const n = norm(s);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function levenshtein(a, b) {
  // classic DP, optimized space
  a = safeStr(a); b = safeStr(b);
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  if (a === b) return 0;

  let prev = new Array(m + 1);
  let cur = new Array(m + 1);

  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = (ca === cb) ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1,      // delete
        cur[j - 1] + 1,   // insert
        prev[j - 1] + cost // substitute
      );
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[m];
}

function normLevScore(a, b) {
  a = norm(a); b = norm(b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(a, b);
  return clamp01(1 - (d / maxLen));
}

function tokenOverlapScore(query, candidate) {
  const qt = new Set(tokens(query));
  const ct = new Set(tokens(candidate));
  if (qt.size === 0 || ct.size === 0) return 0;

  let hit = 0;
  for (const t of qt) if (ct.has(t)) hit++;

  return hit / Math.max(qt.size, ct.size);
}

function combinedScore(query, candidate) {
  // weighted blend: spelling similarity + token overlap
  const a = normLevScore(query, candidate);
  const b = tokenOverlapScore(query, candidate);
  // If tokens match well, reward; if query is short, lean more on lev
  const qlen = norm(query).length;
  const wLev = qlen < 10 ? 0.75 : 0.60;
  const wTok = 1 - wLev;
  return clamp01((a * wLev) + (b * wTok));
}

function buildLikeClauses(nameCol, query) {
  const t = tokens(query);

  // patterns: whole query, then chunks, then tokens
  const patterns = [];
  const qn = norm(query);
  if (qn) patterns.push(`%${qn.replace(/\s+/g, "%")}%`);

  // include the first 2 tokens concatenated if present
  if (t.length >= 2) patterns.push(`%${t[0]}%${t[1]}%`);

  // each token
  for (const tok of t.slice(0, 6)) {
    if (tok.length >= 2) patterns.push(`%${tok}%`);
  }

  // de-dupe
  const uniq = [];
  const seen = new Set();
  for (const p of patterns) {
    if (!seen.has(p)) { seen.add(p); uniq.push(p); }
  }

  // create OR chain (lower(nameCol) LIKE ?)
  const clauses = uniq.map(() => `lower(${nameCol}) LIKE ?`).join(" OR ");
  const params = uniq.map(p => p.toLowerCase());

  return { clauses, params };
}

export function resolveEntity({
  table,
  idCol = "id",
  nameCol = "name",
  extraCols = [],
  query,
  limitCandidates = 60,
  returnTop = 10
}) {
  const q = safeStr(query).trim();
  if (!q) {
    return { ok: true, query: q, match: null, candidates: [] };
  }

  // Candidate pull using LIKE against name column
  const { clauses, params } = buildLikeClauses(nameCol, q);

  const cols = [idCol, nameCol, ...extraCols]
    .filter(Boolean)
    .map(c => `${c} AS ${c}`)
    .join(", ");

  // If clauses is empty (weird), pull a small set
  const sql = clauses
    ? `SELECT ${cols} FROM ${table} WHERE ${clauses} LIMIT ${Math.max(10, Math.min(limitCandidates, 200))}`
    : `SELECT ${cols} FROM ${table} LIMIT ${Math.max(10, Math.min(limitCandidates, 200))}`;

  let rows = [];
  try {
    const r = runSql({ sql, params, limit: Math.max(10, Math.min(limitCandidates, 200)) });
    rows = Array.isArray(r?.rows) ? r.rows : [];
  } catch {
    rows = [];
  }

  // Score + rank
  const scored = rows
    .map(r => {
      const name = safeStr(r?.[nameCol]);
      const score = combinedScore(q, name);
      return { ...r, _score: score };
    })
    .sort((a, b) => (b._score - a._score));

  const top = scored.slice(0, returnTop).map(r => ({
    id: safeStr(r?.[idCol]),
    name: safeStr(r?.[nameCol]),
    score: Number((r?._score ?? 0).toFixed(3))
  }));

  const best = top[0] || null;
  const second = top[1] || null;

  // Confidence rules (tuned for your “random shit” requirement):
  // - accept if >= 0.92 always
  // - accept if >= 0.85 and clearly ahead of #2 by >= 0.08
  let match = null;
  if (best) {
    const s1 = best.score || 0;
    const s2 = second?.score || 0;
    if (s1 >= 0.92 || (s1 >= 0.85 && (s1 - s2) >= 0.08)) {
      match = best;
    }
  }

  return {
    ok: true,
    query: q,
    match,
    candidates: match ? [] : top
  };
}
