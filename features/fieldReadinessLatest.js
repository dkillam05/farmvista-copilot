// /features/fieldReadinessLatest.js  (FULL FILE)
// Rev: 2025-12-29r+debug  (Adds "readiness debug snapshot" to prove routing + snapshot contents)
//
// Fixes kept:
// ✅ Enrich missing farmName using farms + fields collections
// ✅ Better defaults: show readiness bands + actionable counts
// ✅ Better query support
//
// NEW:
// ✅ Debug command: "readiness debug snapshot" shows snapshot + collection presence

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
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "";
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

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

function parseLimit(q) {
  const m = /\b(top|bottom|last)\s+(\d{1,3})\b/i.exec(q);
  if (!m) return 10;
  const n = Number(m[2]) || 10;
  return Math.max(1, Math.min(50, n));
}

function extractAfter(q, label) {
  const re = new RegExp(`\\b${label}\\b\\s+(.+)$`, "i");
  const m = re.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function parseBetween(q) {
  let m = /\bbetween\s+(\d{1,3})\s*(?:%|percent)?\s+and\s+(\d{1,3})/i.exec(q);
  if (m) {
    const a = Math.max(0, Math.min(100, Number(m[1]) || 0));
    const b = Math.max(0, Math.min(100, Number(m[2]) || 0));
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  m = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/.exec(q);
  if (m) {
    const a = Math.max(0, Math.min(100, Number(m[1]) || 0));
    const b = Math.max(0, Math.min(100, Number(m[2]) || 0));
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return { min: null, max: null };
}

function parseMinMax(q) {
  let m = /(\d{1,3})\s*%?\s*(and\s*up|\+|or\s*more)/i.exec(q);
  const min = m ? Math.max(0, Math.min(100, Number(m[1]) || 0)) : null;

  m = /(under|below|less\s+than)\s+(\d{1,3})\s*%?/i.exec(q);
  const max = m ? Math.max(0, Math.min(100, Number(m[2]) || 100)) : null;

  return { min, max };
}

function pickNeedle(q) {
  let m =
    /^readiness\s+(.+)$/i.exec(q) ||
    /^field\s+readiness\s+(.+)$/i.exec(q) ||
    /^readinesslatest\s+(.+)$/i.exec(q) ||
    /^field\s+readiness\s+latest\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function readinessBand(pct) {
  const r = clampPct(pct);
  if (r >= 90) return "90-100";
  if (r >= 70) return "70-89";
  if (r >= 50) return "50-69";
  return "0-49";
}

function fieldLabel(r) {
  return safeStr(r.fieldName).trim() || r.fieldId || r.id || "Field";
}

function farmLabel(r) {
  return safeStr(r.farmName).trim() || "";
}

export function canHandleFieldReadinessLatest(question) {
  const q = norm(question);
  if (!q) return false;

  // Debug trigger (always)
  if (q === "readiness debug snapshot" || q === "readiness debug" || q === "debug readiness") return true;

  // direct triggers
  if (q === "readiness" || q === "field readiness" || q === "readiness latest" || q === "field readiness latest") return true;
  if (q.startsWith("readiness")) return true;
  if (q.startsWith("field readiness")) return true;

  // natural phrasing
  if (q.includes("how ready") && q.includes("field")) return true;
  if (q.includes("which fields") && (q.includes("plant") || q.includes("spray") || q.includes("work"))) return true;
  if (q.includes("planting readiness") || q.includes("spraying readiness") || q.includes("tillage readiness")) return true;

  return false;
}

export function answerFieldReadinessLatest({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  // ✅ DEBUG: tells us immediately if snapshot + collection exist
  if (qn === "readiness debug snapshot" || qn === "readiness debug" || qn === "debug readiness") {
    const lines = [];
    lines.push(`Readiness debug`);
    lines.push(`• snapshotId: ${snapshotId}`);
    lines.push(`• snapshot.json: ${json ? "YES" : "NO"}`);

    const colsRoot = json ? getCollectionsRoot(json) : null;
    lines.push(`• collectionsRoot: ${colsRoot ? "YES" : "NO"}`);

    if (colsRoot) {
      const keys = Object.keys(colsRoot || {});
      lines.push(`• collections keys (first 30): ${keys.slice(0, 30).join(", ")}${keys.length > 30 ? " …" : ""}`);

      const rowsTest = colAsArray(colsRoot, "field_readiness_latest");
      lines.push(`• field_readiness_latest docs: ${rowsTest.length}`);

      const sample = rowsTest.slice(0, 3).map(r => {
        const name = safeStr(r.fieldName).trim() || safeStr(r.fieldId).trim() || r.id;
        const pct = clampPct(r.readiness);
        return `${name}=${pct}%`;
      });
      if (sample.length) lines.push(`• sample: ${sample.join(" | ")}`);
    }

    return { answer: lines.join("\n"), meta: { snapshotId, intent: "readiness_debug" } };
  }

  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const rowsRaw = colAsArray(colsRoot, "field_readiness_latest");
  if (!rowsRaw.length) {
    const keys = Object.keys(colsRoot || {});
    return {
      answer:
        `I don’t see "field_readiness_latest" in the active snapshot (snapshotId: ${snapshotId}).\n` +
        `Collections present (first 25): ${keys.slice(0, 25).join(", ")}${keys.length > 25 ? " …" : ""}\n\n` +
        `Run: "readiness debug snapshot"`,
      meta: { snapshotId, intent: "readiness_missing_collection" }
    };
  }

  // enrichment maps
  const farms = colAsArray(colsRoot, "farms");
  const fields = colAsArray(colsRoot, "fields");

  const farmById = new Map();
  for (const f of farms) {
    const name = safeStr(f.name).trim();
    if (f.id) farmById.set(f.id, name || f.id);
  }

  const fieldById = new Map();
  for (const f of fields) fieldById.set(f.id, f);

  const rows = rowsRaw.map((r) => {
    const fieldDoc = fieldById.get(r.fieldId || r.id) || null;

    const farmId =
      safeStr(r.farmId).trim() ||
      safeStr(fieldDoc?.farmId).trim() ||
      "";

    const farmName =
      safeStr(r.farmName).trim() ||
      safeStr(fieldDoc?.farmName).trim() ||
      safeStr(farmById.get(farmId)).trim() ||
      "";

    const fieldName =
      safeStr(r.fieldName).trim() ||
      safeStr(fieldDoc?.name).trim() ||
      safeStr(fieldDoc?.fieldName).trim() ||
      "";

    return {
      ...r,
      farmId: farmId || r.farmId || "",
      farmName: farmName || r.farmName || "",
      fieldName: fieldName || r.fieldName || "",
      __computedMs: parseTime(r.computedAt) || null,
      __wxMs: parseTime(r.weatherFetchedAt) || null,
      __readiness: clampPct(r.readiness),
      __band: readinessBand(r.readiness)
    };
  });

  const maxComputed = Math.max(...rows.map((r) => r.__computedMs || 0));
  const computedTxt = maxComputed ? fmtDateTime(maxComputed) : "";

  const farmNeedle = extractAfter(q, "farm");
  const fieldNeedle = extractAfter(q, "field");
  const fn = norm(farmNeedle);
  const fldn = norm(fieldNeedle);

  let list = rows.slice();
  if (fn) list = list.filter((r) => norm(r.farmName).includes(fn) || norm(r.farmId) === fn);
  if (fldn) list = list.filter((r) => norm(r.fieldName).includes(fldn) || norm(r.fieldId) === fldn);

  const between = parseBetween(q);
  let { min, max } = parseMinMax(q);
  if (between.min != null) min = between.min;
  if (between.max != null) max = between.max;
  if (min != null) list = list.filter((r) => r.__readiness >= min);
  if (max != null) list = list.filter((r) => r.__readiness < max);

  const needle = pickNeedle(q);
  const wantsTop = includesAny(qn, ["top", "highest", "best"]);
  const wantsBottom = includesAny(qn, ["bottom", "lowest", "worst"]);
  const wantsActionable = includesAny(qn, ["which fields", "can we plant", "can we spray", "can we work", "how ready"]) || qn.includes("plant right now");

  // Lookup
  if (needle && !includesAny(qn, ["top", "bottom", "highest", "lowest", "all", "summary", "overview"])) {
    const nn = norm(needle);
    const byId = rows.find((r) => r.fieldId === needle || r.id === needle) || null;
    const byName = rows.find((r) => norm(fieldLabel(r)).includes(nn)) || null;
    const r = byId || byName;

    if (!r) {
      return { answer: `No readiness record found for "${needle}". Try "readiness top 10" or "readiness latest".`, meta: { snapshotId } };
    }

    const lines = [];
    lines.push(`Field readiness: ${fieldLabel(r)} (${r.fieldId || r.id || "?"})`);
    if (farmLabel(r)) lines.push(`• farm: ${farmLabel(r)}${r.farmId ? ` (${r.farmId})` : ""}`);
    lines.push(`• readiness: ${fmtInt(r.__readiness)}%`);
    if (r.wetBiasApplied != null) lines.push(`• wetBiasApplied: ${safeStr(r.wetBiasApplied)}`);
    if (r.runKey) lines.push(`• runKey: ${r.runKey}`);
    if (r.timezone) lines.push(`• timezone: ${r.timezone}`);

    const w = r.__wxMs ? fmtDateTime(r.__wxMs) : "";
    const c = r.__computedMs ? fmtDateTime(r.__computedMs) : "";
    if (w) lines.push(`• weather fetched: ${w}`);
    if (c) lines.push(`• computed: ${c}`);

    return { answer: lines.join("\n"), meta: { snapshotId, intent: "readiness_lookup", fieldId: r.fieldId || null, readiness: r.__readiness } };
  }

  // Top/Bottom
  if (wantsTop || wantsBottom) {
    const n = parseLimit(q);
    const sorted = list.slice().sort((a, b) => wantsBottom ? (a.__readiness - b.__readiness) : (b.__readiness - a.__readiness));
    const shown = sorted.slice(0, n);

    const lines = shown.map((r) => {
      const nm = fieldLabel(r);
      const fm = farmLabel(r);
      return `• ${fmtInt(r.__readiness)}% — ${nm}${fm ? ` • ${fm}` : ""} (${r.fieldId || r.id || "?"})`;
    });

    return {
      answer:
        `Field readiness latest (snapshot ${snapshotId}):\n` +
        (computedTxt ? `• computedAt: ${computedTxt}\n` : "") +
        `• matching fields: ${fmtInt(list.length)}\n\n` +
        `${wantsBottom ? "Bottom" : "Top"} ${shown.length}:\n` +
        (lines.length ? lines.join("\n") : "No matches."),
      meta: { snapshotId, intent: wantsBottom ? "readiness_bottom" : "readiness_top", matching: list.length, shown: shown.length }
    };
  }

  // Summary + actionable list
  const total = list.length;
  const avg = total ? (list.reduce((s, r) => s + r.__readiness, 0) / total) : 0;
  const hi = total ? Math.max(...list.map((r) => r.__readiness)) : 0;
  const lo = total ? Math.min(...list.map((r) => r.__readiness)) : 0;

  const bands = new Map([["90-100", 0], ["70-89", 0], ["50-69", 0], ["0-49", 0]]);
  for (const r of list) bands.set(r.__band, (bands.get(r.__band) || 0) + 1);

  const readyNowThreshold = 85;
  const readyNow = list.filter((r) => r.__readiness >= readyNowThreshold);
  const notReady = list.filter((r) => r.__readiness < readyNowThreshold);

  const candidates = list.slice().sort((a, b) => b.__readiness - a.__readiness).slice(0, wantsActionable ? 10 : 15);
  const lines = candidates.map((r) => `• ${fmtInt(r.__readiness)}% — ${fieldLabel(r)}${farmLabel(r) ? ` • ${farmLabel(r)}` : ""}`);

  return {
    answer:
      `Field readiness latest (snapshot ${snapshotId}):\n` +
      (computedTxt ? `• computedAt: ${computedTxt}\n` : "") +
      `• fields: ${fmtInt(total)} • avg: ${fmtInt(avg)}% • high: ${fmtInt(hi)}% • low: ${fmtInt(lo)}%\n` +
      `• 90–100: ${fmtInt(bands.get("90-100"))} • 70–89: ${fmtInt(bands.get("70-89"))} • 50–69: ${fmtInt(bands.get("50-69"))} • <50: ${fmtInt(bands.get("0-49"))}\n` +
      `• Ready-now (>=${readyNowThreshold}%): ${fmtInt(readyNow.length)} • Not-ready: ${fmtInt(notReady.length)}\n\n` +
      `${wantsActionable ? "Best candidates:" : "Top fields:"}\n` +
      lines.join("\n") +
      `\n\nTry:\n` +
      `• readiness debug snapshot\n` +
      `• readiness top 10\n` +
      `• readiness under 60\n` +
      `• readiness farm "Assumption-Tville"`,
    meta: { snapshotId, intent: "readiness_summary", total, readyNow: readyNow.length }
  };
}
