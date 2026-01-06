// /chat/handlerKit.js  (FULL FILE)
// Rev: 2026-01-05-handlerKit1
//
// Shared rules for ALL handlers:
// ✅ sorting (A→Z default, largest/smallest override)
// ✅ field label numeric sort (0504-..., 0801-...)
// ✅ paging (meta.continuation + display)
// ✅ standard tips for users

'use strict';

const norm = (s) => (s || "").toString().trim().toLowerCase();

export function alphaKey(s) {
  return (s || "").toString().trim().toLowerCase();
}

// For labels like "0504-Bierman (FarmName)" or "0504-Bierman"
export function fieldSortKey(label) {
  const s = (label || "").toString().trim();
  const m = s.match(/^\s*(\d{3,4})\s*[-–—]\s*(.*)$/);
  const n = m ? parseInt(m[1], 10) : 999999;
  const rest = alphaKey(m ? m[2] : s);
  return { n, rest, full: alphaKey(s) };
}

export function sortFieldsByNumberThenName(a, b) {
  const A = fieldSortKey(a);
  const B = fieldSortKey(b);
  if (A.n !== B.n) return A.n - B.n;
  if (A.rest !== B.rest) return A.rest.localeCompare(B.rest);
  return A.full.localeCompare(B.full);
}

// default A→Z, allow override
export function detectSortMode(qRaw) {
  const q = norm(qRaw);

  const largest = (
    q.includes("largest first") ||
    q.includes("biggest first") ||
    q.includes("descending") ||
    q.includes("high to low") ||
    q.includes("most first") ||
    q.includes("top first")
  );

  const smallest = (
    q.includes("smallest first") ||
    q.includes("ascending") ||
    q.includes("low to high") ||
    q.includes("least first") ||
    q.includes("bottom first")
  );

  // explicit alphabetical phrases
  if (q.includes("a-z") || q.includes("alphabetical") || q.includes("abc")) return "az";

  if (largest) return "largest";
  if (smallest) return "smallest";
  return "az";
}

// rows: { name, value, raw }
export function sortRows(rows, mode = "az") {
  const m = mode || "az";
  rows.sort((a, b) => {
    const an = alphaKey(a?.name);
    const bn = alphaKey(b?.name);
    const av = Number(a?.value) || 0;
    const bv = Number(b?.value) || 0;

    if (m === "largest") {
      const d = bv - av;
      if (d !== 0) return d;
      return an.localeCompare(bn);
    }
    if (m === "smallest") {
      const d = av - bv;
      if (d !== 0) return d;
      return an.localeCompare(bn);
    }
    return an.localeCompare(bn);
  });
  return rows;
}

export function sortHintLine(mode) {
  if (mode === "largest" || mode === "smallest") {
    return `Tip: say "A-Z" to sort alphabetically.`;
  }
  return `Tip: say "largest first" to sort by size.`;
}

// Build paged answer + continuation
export function buildPaged({ title, lines, pageSize = 25, showTip = false, tipMode = "az" }) {
  const ps = Math.max(10, Math.min(80, Number(pageSize) || 25));
  const first = lines.slice(0, ps);
  const remaining = lines.length - first.length;

  const out = [];
  out.push(title);
  out.push("");
  out.push(...first);
  if (remaining > 0) out.push(`\n…plus ${remaining} more.`);
  if (showTip) out.push(`\n${sortHintLine(tipMode)}`);

  const continuation = (remaining > 0)
    ? { kind: "page", title, lines, offset: ps, pageSize: ps }
    : null;

  return { answer: out.join("\n"), continuation };
}