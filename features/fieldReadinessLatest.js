// /features/fieldReadinessLatest.js  (FULL FILE)
// Rev: 2025-12-30-human-readiness (Keep debug command, but normal output is clean: no FV tags, no snapshotId, no Try: menu)

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

function readinessBand(pct) {
  const r = clampPct(pct);
  if (r >= 90) return "90-100";
  if (r >= 70) return "70-89";
  if (r >= 50) return "50-69";
  return "0-49";
}

export function canHandleFieldReadinessLatest(question) {
  const q = norm(question);
  if (!q) return false;
  return q.includes("readiness") || q.includes("how ready") || (q.includes("which fields") && q.includes("plant"));
}

export function answerFieldReadinessLatest({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  const json = snapshot?.json || null;

  // ✅ DEBUG COMMANDS (explicit only)
  if (qn === "readiness debug snapshot" || qn === "readiness debug" || qn === "debug readiness") {
    const lines = [];
    lines.push(`[FV-READINESS-LATEST] Readiness debug`);
    lines.push(`• snapshotId: ${snapshotId}`);
    lines.push(`• snapshot.json: ${json ? "YES" : "NO"}`);

    const colsRoot = json ? getCollectionsRoot(json) : null;
    lines.push(`• collectionsRoot: ${colsRoot ? "YES" : "NO"}`);

    if (colsRoot) {
      const keys = Object.keys(colsRoot);
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

  // Normal user-facing errors (clean)
  if (!json) {
    return {
      answer: `Field readiness isn’t available right now.`,
      meta: { snapshotId, intent: "readiness_error_no_snapshot" }
    };
  }

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) {
    return {
      answer: `Field readiness isn’t available right now.`,
      meta: { snapshotId, intent: "readiness_error_no_collections" }
    };
  }

  const rowsRaw = colAsArray(colsRoot, "field_readiness_latest");
  if (!rowsRaw.length) {
    return {
      answer: `Field readiness data wasn’t found in the snapshot.`,
      meta: { snapshotId, intent: "readiness_error_missing_collection" }
    };
  }

  // Normalize
  const rows = rowsRaw.map(r => ({
    ...r,
    __computedMs: parseTime(r.computedAt) || null,
    __readiness: clampPct(r.readiness),
    __band: readinessBand(r.readiness)
  }));

  const maxComputed = Math.max(...rows.map(r => r.__computedMs || 0));
  const computedTxt = maxComputed ? fmtDateTime(maxComputed) : "";

  const readyNowThreshold = 85;

  // buckets
  const bands = new Map([["90-100", 0], ["70-89", 0], ["50-69", 0], ["0-49", 0]]);
  for (const r of rows) bands.set(r.__band, (bands.get(r.__band) || 0) + 1);

  const readyNow = rows.filter(r => r.__readiness >= readyNowThreshold);
  const notReady = rows.filter(r => r.__readiness < readyNowThreshold);

  const actionable =
    qn.includes("which fields") ||
    qn.includes("can we plant") ||
    qn.includes("plant right now") ||
    qn.includes("how ready");

  const sorted = rows.slice().sort((a,b)=> b.__readiness - a.__readiness);
  const shown = sorted.slice(0, actionable ? 10 : 15);

  const lines = shown.map(r => {
    const name = safeStr(r.fieldName).trim() || r.fieldId || r.id;
    const farm = safeStr(r.farmName).trim();
    return `• ${fmtInt(r.__readiness)}% — ${name}${farm ? ` • ${farm}` : ""}`;
  });

  return {
    answer:
      `Field readiness (latest):\n` +
      (computedTxt ? `• Updated: ${computedTxt}\n` : "") +
      `• Fields: ${fmtInt(rows.length)}\n` +
      `• 90–100: ${fmtInt(bands.get("90-100"))} • 70–89: ${fmtInt(bands.get("70-89"))} • 50–69: ${fmtInt(bands.get("50-69"))} • <50: ${fmtInt(bands.get("0-49"))}\n` +
      `• Ready now (≥${readyNowThreshold}%): ${fmtInt(readyNow.length)} • Not ready: ${fmtInt(notReady.length)}\n\n` +
      `${actionable ? "Best candidates:" : "Top fields:"}\n` +
      lines.join("\n"),
    meta: { snapshotId, intent: "readiness_latest", total: rows.length, readyNow: readyNow.length, computedAt: maxComputed || null }
  };
}
