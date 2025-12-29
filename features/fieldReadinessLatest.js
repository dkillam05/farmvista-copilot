// /features/fieldReadinessLatest.js  (FULL FILE)
// Rev: 2025-12-29r  (Better answers + farm/field enrichment + more natural queries)
//
// Fixes (per Dane):
// ✅ Answers are more useful + “report-like”
// ✅ Enrich missing farmName using farms + fields collections
// ✅ Better defaults: show readiness bands + actionable counts
// ✅ Better query support:
//    - “how ready are fields”, “which fields can we plant”, “planting readiness”
//    - “readiness by farm Pisgah”, “readiness farm Assumption”
//    - “readiness between 60 and 80”, “readiness 90%+”, “readiness under 60”
//    - “readiness field 0100”, “readiness 0710-CodyWaggner”
// ✅ Top/bottom lists include farm + field and show computedAt/runKey
// ✅ Keeps snapshot-safe behavior (no external calls)

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
  // readiness between 60 and 80
  let m = /\bbetween\s+(\d{1,3})\s*(?:%|percent)?\s+and\s+(\d{1,3})/i.exec(q);
  if (m) {
    const a = Math.max(0, Math.min(100, Number(m[1]) || 0));
    const b = Math.max(0, Math.min(100, Number(m[2]) || 0));
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  // readiness 60-80
  m = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/.exec(q);
  if (m) {
    const a = Math.max(0, Math.min(100, Number(m[1]) || 0));
    const b = Math.max(0, Math.min(100, Number(m[2]) || 0));
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  return { min: null, max: null };
}

function parseMinMax(q) {
  // 90%+  OR  90+  OR  90 and up
  let m = /(\d{1,3})\s*%?\s*(and\s*up|\+|or\s*more)/i.exec(q);
  const min = m ? Math.max(0, Math.min(100, Number(m[1]) || 0)) : null;

  // under 60 / below 60
  m = /(under|below|less\s+than)\s+(\d{1,3})\s*%?/i.exec(q);
  const max = m ? Math.max(0, Math.min(100, Number(m[2]) || 100)) : null;

  return { min, max };
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

function readinessBand(pct) {
  const r = clampPct(pct);
  if (r >= 90) return "90-100";
  if (r >= 70) return "70-89";
  if (r >= 50) return "50-69";
  return "0-49";
}

function sortNewestFirst(a, b) {
  return (b.__computedMs || 0) - (a.__computedMs || 0);
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
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  // main readiness docs
  const rowsRaw = colAsArray(colsRoot, "field_readiness_latest");
  if (!rowsRaw.length) return { answer: "No field_readiness_latest records found in the snapshot.", meta: { snapshotId } };

  // enrichment maps
  const farms = colAsArray(colsRoot, "farms");
  const fields = colAsArray(colsRoot, "fields");

  const farmById = new Map();
  for (const f of farms) {
    const name = safeStr(f.name).trim();
    if (f.id) farmById.set(f.id, name || f.id);
  }

  const fieldById = new Map();
  for (const f of fields) {
    // typical fields doc has name + farmId/farmName
    fieldById.set(f.id, f);
  }

  // normalize/enrich rows
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

  // filters
  const farmNeedle = extractAfter(q, "farm");
  const fieldNeedle = extractAfter(q, "field");
  const cropNeedle = extractAfter(q, "crop"); // future-proof (not used in these docs)
  void cropNeedle;

  const fn = norm(farmNeedle);
  const fldn = norm(fieldNeedle);

  let list = rows.slice();

  if (fn) {
    list = list.filter((r) => norm(r.farmName).includes(fn) || norm(r.farmId) === fn);
  }
  if (fldn) {
    list = list.filter((r) => norm(r.fieldName).includes(fldn) || norm(r.fieldId) === fldn);
  }

  // numeric range filters
  const between = parseBetween(q);
  let { min, max } = parseMinMax(q);
  if (between.min != null) min = between.min;
  if (between.max != null) max = between.max;

  if (min != null) list = list.filter((r) => r.__readiness >= min);
  if (max != null) list = list.filter((r) => r.__readiness < max);

  // intent: detail lookup by “readiness <name/id>”
  const needle = pickNeedle(q);

  const wantsTop = includesAny(qn, ["top", "highest", "best"]);
  const wantsBottom = includesAny(qn, ["bottom", "lowest", "worst"]);
  const wantsSummary = includesAny(qn, ["summary", "overview"]) || qn === "readiness" || qn === "readiness latest" || qn === "field readiness" || qn === "field readiness latest";
  const wantsActionable = includesAny(qn, ["which fields", "can we plant", "can we spray", "can we work", "how ready"]);

  // If user typed “readiness <something>” and it’s not list commands, treat as lookup
  if (needle && !includesAny(qn, ["top", "bottom", "highest", "lowest", "all", "summary", "overview"])) {
    const nn = norm(needle);
    const byId = rows.find((r) => r.fieldId === needle || r.id === needle) || null;
    const byName = rows.find((r) => norm(fieldLabel(r)).includes(nn)) || null;
    const r = byId || byName;

    if (!r) {
      return {
        answer: `No readiness record found for "${needle}". Try "readiness top 10" or "readiness latest".`,
        meta: { snapshotId, intent: "readiness_lookup" }
      };
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

    return {
      answer: lines.join("\n"),
      meta: { snapshotId, intent: "readiness_lookup", fieldId: r.fieldId || null, readiness: r.__readiness }
    };
  }

  // Top/Bottom lists
  if (wantsTop || wantsBottom) {
    const n = parseLimit(q);
    const sorted = list.slice().sort((a, b) => wantsBottom ? (a.__readiness - b.__readiness) : (b.__readiness - a.__readiness));
    const shown = sorted.slice(0, n);

    const lines = shown.map((r) => {
      const nm = fieldLabel(r);
      const fm = farmLabel(r);
      const fmBit = fm ? ` • ${fm}` : "";
      return `• ${fmtInt(r.__readiness)}% — ${nm}${fmBit} (${r.fieldId || r.id || "?"})`;
    });

    const label = wantsBottom ? `Bottom ${shown.length}` : `Top ${shown.length}`;
    const filterBits = [];
    if (fn) filterBits.push(`farm~"${farmNeedle}"`);
    if (fldn) filterBits.push(`field~"${fieldNeedle}"`);
    if (min != null) filterBits.push(`${min}%+`);
    if (max != null) filterBits.push(`under ${max}%`);

    return {
      answer:
        `Field readiness latest (snapshot ${snapshotId}):\n` +
        (computedTxt ? `• computedAt: ${computedTxt}\n` : "") +
        (filterBits.length ? `• filter: ${filterBits.join(" • ")}\n` : "") +
        `• matching fields: ${fmtInt(list.length)}\n\n` +
        `${label}:\n` +
        (lines.length ? lines.join("\n") : "No matches."),
      meta: { snapshotId, intent: wantsBottom ? "readiness_bottom" : "readiness_top", matching: list.length, shown: shown.length }
    };
  }

  // Default summary (and “actionable” questions)
  const total = list.length;
  const avg = total ? (list.reduce((s, r) => s + r.__readiness, 0) / total) : 0;
  const hi = total ? Math.max(...list.map((r) => r.__readiness)) : 0;
  const lo = total ? Math.min(...list.map((r) => r.__readiness)) : 0;

  const bands = new Map([["90-100", 0], ["70-89", 0], ["50-69", 0], ["0-49", 0]]);
  for (const r of list) bands.set(r.__band, (bands.get(r.__band) || 0) + 1);

  // actionable recommendation: “ready now” = >= 85 by default (tweak later)
  const readyNowThreshold = 85;
  const readyNow = list.filter((r) => r.__readiness >= readyNowThreshold);
  const notReady = list.filter((r) => r.__readiness < readyNowThreshold);

  // show a short “best candidates” list (top 10) when user asks “which fields can we plant”
  const showCandidates = wantsActionable || qn.includes("plant") || qn.includes("spray") || qn.includes("tillage");
  let candidates = [];
  if (showCandidates) {
    candidates = list.slice().sort((a, b) => b.__readiness - a.__readiness).slice(0, Math.min(10, list.length));
  }

  const filterBits = [];
  if (fn) filterBits.push(`farm~"${farmNeedle}"`);
  if (fldn) filterBits.push(`field~"${fieldNeedle}"`);
  if (min != null) filterBits.push(`${min}%+`);
  if (max != null) filterBits.push(`under ${max}%`);
  if (between.min != null || between.max != null) filterBits.push(`between ${between.min}-${between.max}`);

  const bandLine =
    `• 90–100: ${fmtInt(bands.get("90-100") || 0)} • 70–89: ${fmtInt(bands.get("70-89") || 0)} • 50–69: ${fmtInt(bands.get("50-69") || 0)} • <50: ${fmtInt(bands.get("0-49") || 0)}`;

  const candidatesLines = candidates.map((r) => {
    const nm = fieldLabel(r);
    const fm = farmLabel(r);
    return `• ${fmtInt(r.__readiness)}% — ${nm}${fm ? ` • ${fm}` : ""}`;
  });

  return {
    answer:
      `Field readiness latest (snapshot ${snapshotId}):\n` +
      (computedTxt ? `• computedAt: ${computedTxt}\n` : "") +
      (filterBits.length ? `• filter: ${filterBits.join(" • ")}\n` : "") +
      `• fields: ${fmtInt(total)} • avg: ${fmtInt(avg)}% • high: ${fmtInt(hi)}% • low: ${fmtInt(lo)}%\n` +
      bandLine +
      `\n\n` +
      `Ready-now (>=${readyNowThreshold}%): ${fmtInt(readyNow.length)} • Not-ready: ${fmtInt(notReady.length)}` +
      (showCandidates
        ? `\n\nBest candidates:\n${candidatesLines.join("\n")}`
        : "") +
      `\n\nTry:\n` +
      `• readiness top 10\n` +
      `• readiness bottom 10\n` +
      `• readiness under 60\n` +
      `• readiness 90%+\n` +
      `• readiness between 60 and 80\n` +
      `• readiness farm "Assumption-Tville"\n` +
      `• readiness "0710-CodyWaggner"`,
    meta: {
      snapshotId,
      intent: wantsSummary ? "readiness_summary" : "readiness",
      total,
      avg,
      hi,
      lo,
      bands: Object.fromEntries(bands),
      computedAtMs: maxComputed || null,
      readyNowThreshold,
      readyNow: readyNow.length,
      notReady: notReady.length,
      matching: list.length
    }
  };
}
