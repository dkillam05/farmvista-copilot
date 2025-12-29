// /features/combineMetrics.js  (FULL FILE)

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

function parseISODate(s) {
  const t = (s || "").toString().trim();
  if (!t) return null;
  const ms = Date.parse(`${t}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
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

function fmtDate(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function fmt1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(1) : "";
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function parseLimit(q) {
  const m = /\b(last|top)\s+(\d{1,3})\b/i.exec(q);
  if (!m) return 10;
  const n = Number(m[2]) || 10;
  return Math.max(1, Math.min(50, n));
}

function detectMode(qn) {
  // defaults to “summary”
  if (qn.includes("loss") || qn.includes("grain loss")) return "loss";
  if (qn.includes("calibration") || qn.includes("calibrate")) return "cal";
  if (qn.includes("yield")) return "yield";
  return "summary";
}

function extractAfter(q, label) {
  const re = new RegExp(`\\b${label}\\b\\s+(.+)$`, "i");
  const m = re.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

export function canHandleCombineMetrics(question) {
  const q = norm(question);
  if (!q) return false;

  // explicit collection names
  if (q.includes("combine_grain_loss") || q.includes("combine_yield") || q.includes("combine_yield_calibration")) return true;

  // user phrasing
  if (q.includes("combine") && (q.includes("yield") || q.includes("loss") || q.includes("calibration") || q.includes("calibrate"))) return true;
  if (q.startsWith("yield ") || q.startsWith("grain loss") || q.startsWith("combine yield") || q.startsWith("combine loss") || q.startsWith("yield calibration")) return true;

  return false;
}

export function answerCombineMetrics({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const loss = colAsArray(colsRoot, "combine_grain_loss").map((r) => ({
    ...r,
    __ms: parseTime(r.createdAt) || parseISODate(r.submittedAtLocal?.slice?.(0, 10)) || parseISODate(r.submittedDate) || null
  }));

  const yields = colAsArray(colsRoot, "combine_yield").map((r) => ({
    ...r,
    __ms: parseTime(r.createdAt) || parseISODate(r.submittedDate) || null
  }));

  const cal = colAsArray(colsRoot, "combine_yield_calibration").map((r) => ({
    ...r,
    __ms: parseTime(r.createdAt) || parseISODate(r.submittedDate) || null
  }));

  const totalAny = loss.length + yields.length + cal.length;
  if (!totalAny) {
    return { answer: "No combine metrics found in the snapshot.", meta: { snapshotId } };
  }

  // filters (work across all three)
  const farmNeedle = extractAfter(q, "farm");
  const fieldNeedle = extractAfter(q, "field");
  const combineNeedle = extractAfter(q, "combine");
  const cropNeedle = extractAfter(q, "crop");
  const dateNeedle = (() => {
    const m = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(q);
    return m ? m[1] : "";
  })();

  const fn = norm(farmNeedle);
  const fldn = norm(fieldNeedle);
  const cn = norm(combineNeedle);
  const crn = norm(cropNeedle);
  const dn = dateNeedle;

  const applyCommonFilters = (arr) => {
    let out = arr.slice();
    if (fn) out = out.filter((r) => norm(r.farmName).includes(fn) || norm(r.farmId) === fn);
    if (fldn) out = out.filter((r) => norm(r.fieldName).includes(fldn) || norm(r.fieldId) === fldn);
    if (cn) out = out.filter((r) => norm(r.combineName).includes(cn) || norm(r.combineId) === cn);
    if (crn) out = out.filter((r) => norm(r.crop).includes(crn));
    if (dn) out = out.filter((r) => safeStr(r.submittedDate).trim() === dn || safeStr(r.submittedAtLocal).startsWith(dn));
    return out;
  };

  const mode = detectMode(qn);
  const limit = parseLimit(q);

  // SUMMARY
  if (mode === "summary" || qn === "combine" || qn === "combine summary" || qn === "combine metrics") {
    const lossF = applyCommonFilters(loss);
    const yF = applyCommonFilters(yields);
    const cF = applyCommonFilters(cal);

    const lastMs = Math.max(
      ...[...lossF, ...yF, ...cF].map((r) => r.__ms || 0)
    );
    const lastTxt = lastMs ? fmtDateTime(lastMs) : "";

    return {
      answer:
        `Combine metrics summary (snapshot ${snapshotId}):\n` +
        (lastTxt ? `• last record: ${lastTxt}\n` : "") +
        `• grain loss: ${lossF.length}\n` +
        `• yield checks: ${yF.length}\n` +
        `• yield calibration: ${cF.length}\n\n` +
        `Try:\n` +
        `• combine loss last 10\n` +
        `• combine yield last 10\n` +
        `• yield calibration last 10\n` +
        `• combine yield field 1027\n` +
        `• combine loss farm Assumption`,
      meta: { snapshotId, loss: lossF.length, yields: yF.length, calibration: cF.length }
    };
  }

  // LOSS
  if (mode === "loss") {
    let list = applyCommonFilters(loss);
    list.sort((a, b) => (b.__ms || 0) - (a.__ms || 0));
    const shown = list.slice(0, limit);

    const lines = shown.map((r) => {
      const dt = r.submittedAtLocal ? r.submittedAtLocal.replace("T", " ") : fmtDateTime(r.__ms);
      const field = safeStr(r.fieldName).trim() || r.fieldId || "Field";
      const farm = safeStr(r.farmName).trim();
      const comb = safeStr(r.combineName).trim();
      const bu = r.lossBuAc != null ? fmt1(r.lossBuAc) : "";
      const pct = r.lossPct != null ? fmt1(Number(r.lossPct) * 100) : "";
      const k = r.kernels != null ? fmtInt(r.kernels) : "";
      const bits = [];
      if (bu) bits.push(`${bu} bu/ac`);
      if (pct) bits.push(`${pct}%`);
      if (k) bits.push(`${k} kernels`);
      if (r.method) bits.push(r.method);
      return `• ${dt} — ${field}${farm ? ` • ${farm}` : ""}${comb ? ` • ${comb}` : ""} — ${bits.join(" • ")}`.trim();
    });

    const avgBu = list.length ? (list.reduce((s, r) => s + (Number(r.lossBuAc) || 0), 0) / list.length) : 0;

    return {
      answer:
        `Combine grain loss (snapshot ${snapshotId}):\n` +
        `• matching: ${list.length}` +
        (list.length ? ` • avg loss: ${fmt1(avgBu)} bu/ac` : "") +
        `\n\n` +
        (lines.length ? lines.join("\n") : "No matching grain loss records.") +
        (list.length > limit ? `\n\n(Showing last ${limit})` : "") +
        `\n\nTry:\n• combine loss field 0107\n• combine loss combine X9\n• combine loss 2025-12-29`,
      meta: { snapshotId, matching: list.length, shown: shown.length, avgLossBuAc: avgBu }
    };
  }

  // YIELD
  if (mode === "yield") {
    let list = applyCommonFilters(yields);
    list.sort((a, b) => (b.__ms || 0) - (a.__ms || 0));
    const shown = list.slice(0, limit);

    const lines = shown.map((r) => {
      const dt = safeStr(r.submittedDate).trim() || fmtDate(r.__ms);
      const field = safeStr(r.fieldName).trim() || r.fieldId || "Field";
      const farm = safeStr(r.farmName).trim();
      const comb = safeStr(r.combineName).trim();
      const moist = r.moisturePct != null ? `${fmt1(r.moisturePct)}%` : "";
      const trueY = r.trueYieldBuAc != null ? fmt1(r.trueYieldBuAc) : "";
      const elevY = r.elevatorYieldBuAc != null ? fmt1(r.elevatorYieldBuAc) : "";
      const bits = [];
      if (trueY) bits.push(`true ${trueY} bu/ac`);
      if (elevY) bits.push(`elev ${elevY} bu/ac`);
      if (moist) bits.push(moist);
      if (r.mode) bits.push(r.mode);
      return `• ${dt} — ${field}${farm ? ` • ${farm}` : ""}${comb ? ` • ${comb}` : ""} — ${bits.join(" • ")}`.trim();
    });

    const avgTrue = list.length ? (list.reduce((s, r) => s + (Number(r.trueYieldBuAc) || 0), 0) / list.length) : 0;

    return {
      answer:
        `Combine yield checks (snapshot ${snapshotId}):\n` +
        `• matching: ${list.length}` +
        (list.length ? ` • avg true yield: ${fmt1(avgTrue)} bu/ac` : "") +
        `\n\n` +
        (lines.length ? lines.join("\n") : "No matching yield records.") +
        (list.length > limit ? `\n\n(Showing last ${limit})` : "") +
        `\n\nTry:\n• combine yield field 1027\n• combine yield farm Kansas\n• combine yield crop corn`,
      meta: { snapshotId, matching: list.length, shown: shown.length, avgTrueYieldBuAc: avgTrue }
    };
  }

  // CALIBRATION
  if (mode === "cal") {
    let list = applyCommonFilters(cal);
    list.sort((a, b) => (b.__ms || 0) - (a.__ms || 0));
    const shown = list.slice(0, limit);

    const lines = shown.map((r) => {
      const dt = safeStr(r.submittedDate).trim() || fmtDate(r.__ms);
      const field = safeStr(r.fieldName).trim() || r.fieldId || "Field";
      const farm = safeStr(r.farmName).trim();
      const comb = safeStr(r.combineName).trim();
      const off = r.percentOff != null ? fmt1(r.percentOff) : "";
      const st = safeStr(r.status).trim();
      const bits = [];
      if (st) bits.push(st);
      if (off) bits.push(`${off}% off`);
      if (r.combineWeight != null) bits.push(`combine ${fmtInt(r.combineWeight)}`);
      if (r.grainCartWeight != null) bits.push(`cart ${fmtInt(r.grainCartWeight)}`);
      return `• ${dt} — ${field}${farm ? ` • ${farm}` : ""}${comb ? ` • ${comb}` : ""} — ${bits.join(" • ")}`.trim();
    });

    const avgOff = list.length ? (list.reduce((s, r) => s + (Number(r.percentOff) || 0), 0) / list.length) : 0;

    return {
      answer:
        `Combine yield calibration (snapshot ${snapshotId}):\n` +
        `• matching: ${list.length}` +
        (list.length ? ` • avg off: ${fmt1(avgOff)}%` : "") +
        `\n\n` +
        (lines.length ? lines.join("\n") : "No matching calibration records.") +
        (list.length > limit ? `\n\n(Showing last ${limit})` : "") +
        `\n\nTry:\n• yield calibration last 10\n• yield calibration status HIGH\n• yield calibration farm Chatham`,
      meta: { snapshotId, matching: list.length, shown: shown.length, avgPercentOff: avgOff }
    };
  }

  return {
    answer:
      `Try:\n` +
      `• combine loss last 10\n` +
      `• combine yield last 10\n` +
      `• yield calibration last 10\n` +
      `• combine yield field 1027\n` +
      `• combine loss farm Assumption`,
    meta: { snapshotId }
  };
}
