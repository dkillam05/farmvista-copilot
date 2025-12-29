// /features/fieldReadinessLatest.js  (FULL FILE)

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colAsArray(colsRoot, name) {
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return [];
  const objMap = colsRoot[name];
  const out = [];
  for (const [id, v] of Object.entries(objMap)) {
    if (v && typeof v === "object") out.push({ id, ...v });
  }
  return out;
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === "object" && typeof v.__time__ === "string") {
    const ms = Date.parse(v.__time__);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function fmtDateTime(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return null;
  }
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function pickNeedle(q) {
  // readiness <needle>
  let m =
    /^readiness\s+(.+)$/i.exec(q) ||
    /^field\s+readiness\s+(.+)$/i.exec(q) ||
    /^readinesslatest\s+(.+)$/i.exec(q) ||
    /^field\s+readiness\s+latest\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

export function canHandleFieldReadinessLatest(question) {
  const q = norm(question);
  if (!q) return false;

  // broad triggers
  if (q === "readiness" || q === "field readiness" || q === "readiness latest" || q === "field readiness latest") return true;
  if (q.startsWith("readiness")) return true;
  if (q.startsWith("field readiness")) return true;

  // common alt phrasing
  if (q.includes("readiness") && (q.includes("top") || q.includes("bottom") || q.includes("highest") || q.includes("lowest"))) return true;

  return false;
}

export function answerFieldReadinessLatest({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const rows = colAsArray(colsRoot, "field_readiness_latest").map((r) => ({
    ...r,
    __computedMs: parseTime(r.computedAt) || null,
    __wxMs: parseTime(r.weatherFetchedAt) || null,
    __readiness: clamp01(r.readiness)
  }));

  if (!rows.length) return { answer: "No field_readiness_latest records found in the snapshot.", meta: { snapshotId } };

  // overall snapshot freshness (most common computedAt)
  const maxComputed = Math.max(...rows.map((r) => r.__computedMs || 0));
  const computedTxt = fmtDateTime(maxComputed);

  // detail lookup?  "readiness <field name/id>"
  const needle = pickNeedle(q);
  if (needle && !includesAny(qn, ["top", "bottom", "highest", "lowest", "all", "summary"])) {
    const byId = rows.find((r) => r.fieldId === needle || r.id === needle) || null;
    const nn = norm(needle);

    const byName =
      rows.find((r) => norm(r.fieldName).includes(nn)) ||
      null;

    const r = byId || byName;
    if (!r) {
      return { answer: `No readiness record found for "${needle}". Try "readiness top 10" or "readiness latest".`, meta: { snapshotId } };
    }

    const lines = [];
    lines.push(`Field readiness: ${safeStr(r.fieldName).trim() || r.fieldId} (${r.fieldId})`);
    lines.push(`• readiness: ${fmtInt(r.__readiness)}%`);
    if (r.farmId) lines.push(`• farmId: ${r.farmId}`);
    if (r.farmName) lines.push(`• farm: ${r.farmName}`);
    if (r.runKey) lines.push(`• runKey: ${r.runKey}`);
    if (r.timezone) lines.push(`• timezone: ${r.timezone}`);

    const c = fmtDateTime(r.__computedMs);
    const w = fmtDateTime(r.__wxMs);
    if (w) lines.push(`• weather fetched: ${w}`);
    if (c) lines.push(`• computed: ${c}`);

    if (r.wetBiasApplied != null) lines.push(`• wetBiasApplied: ${safeStr(r.wetBiasApplied)}`);

    return { answer: lines.join("\n"), meta: { snapshotId, fieldId: r.fieldId, readiness: r.__readiness } };
  }

  // top/bottom
  let n = 10;
  let m = /(top|bottom)\s+(\d{1,3})/i.exec(q);
  if (m) n = Math.max(1, Math.min(50, Number(m[2]) || 10));
  const wantsTop = qn.includes("top") || qn.includes("highest") || qn.includes("best");
  const wantsBottom = qn.includes("bottom") || qn.includes("lowest") || qn.includes("worst");

  // filters
  let min = null, max = null;
  m = /(\d{1,3})\s*%?\s*(and\s*up|\+|or\s*more)/i.exec(q);
  if (m) min = Math.max(0, Math.min(100, Number(m[1]) || 0));
  m = /(under|below)\s+(\d{1,3})\s*%?/i.exec(q);
  if (m) max = Math.max(0, Math.min(100, Number(m[2]) || 100));

  let list = rows.slice();
  if (min != null) list = list.filter((r) => r.__readiness >= min);
  if (max != null) list = list.filter((r) => r.__readiness < max);

  // sort for output
  if (wantsBottom) list.sort((a, b) => a.__readiness - b.__readiness);
  else list.sort((a, b) => b.__readiness - a.__readiness); // default/top-ish

  // summary mode (default)
  const total = rows.length;
  const avg = rows.reduce((s, r) => s + r.__readiness, 0) / (total || 1);
  const hi = Math.max(...rows.map((r) => r.__readiness));
  const lo = Math.min(...rows.map((r) => r.__readiness));

  // pick shown
  const showCount = (wantsTop || wantsBottom) ? n : Math.min(15, list.length);
  const shown = list.slice(0, showCount);

  const lines = shown.map((r) => {
    const nm = safeStr(r.fieldName).trim() || r.fieldId;
    const farm = safeStr(r.farmName).trim();
    const farmBit = farm ? ` • ${farm}` : "";
    return `• ${fmtInt(r.__readiness)}% — ${nm}${farmBit} (${r.fieldId})`;
  });

  const modeLabel = wantsBottom ? `Bottom ${showCount}` : (wantsTop ? `Top ${showCount}` : `Latest snapshot`);

  return {
    answer:
      `Field readiness latest (snapshot ${snapshotId}):\n` +
      (computedTxt ? `• computedAt: ${computedTxt}\n` : "") +
      `• fields: ${fmtInt(total)} • avg: ${fmtInt(avg)}% • high: ${fmtInt(hi)}% • low: ${fmtInt(lo)}%\n` +
      ((min != null || max != null) ? `• filter: ${min != null ? `${min}%+` : ""}${(min != null && max != null) ? " " : ""}${max != null ? `under ${max}%` : ""}\n` : "") +
      `\n${modeLabel}:\n` +
      lines.join("\n") +
      `\n\nTry:\n` +
      `• readiness top 10\n` +
      `• readiness bottom 10\n` +
      `• readiness under 60\n` +
      `• readiness 90%+\n` +
      `• readiness "0710-CodyWaggner"`,
    meta: { snapshotId, total, avg, hi, lo, shown: shown.length, matching: list.length, computedAtMs: maxComputed || null }
  };
}
