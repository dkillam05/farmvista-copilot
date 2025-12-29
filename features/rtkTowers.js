// /features/rtkTowers.js  (FULL FILE)

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.data.__collections__ === "object") return d.__collections__;
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

function towerLabel(t) {
  return safeStr(t.name).trim() || t.id || "RTK Tower";
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtFreq(v) {
  const n = toNum(v);
  if (n == null) return safeStr(v).trim();
  // keep 5 decimals when present
  return n.toFixed(5);
}

function pickNeedle(q) {
  // rtk tower <name|id>
  // rtk network <id>
  // rtk freq <mhz>
  let m =
    /^rtk\s+tower\s+(.+)$/i.exec(q) ||
    /^tower\s+(.+)$/i.exec(q) ||
    /^rtk\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function parseNetwork(q) {
  const m = /\b(network)\s+(\d{1,6})\b/i.exec(q);
  return m ? Number(m[2]) : null;
}

function parseFreq(q) {
  const m = /\b(freq|frequency)\s+([0-9]+(?:\.[0-9]+)?)\b/i.exec(q);
  return m ? String(m[2]) : "";
}

export function canHandleRtkTowers(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "rtk" || q === "rtk towers" || q === "towers" || q === "rtk tower") return true;
  if (q.startsWith("rtk")) return true;
  if (q.startsWith("rtk tower")) return true;
  if (q.includes("rtk") && (q.includes("network") || q.includes("freq") || q.includes("frequency"))) return true;

  return false;
}

export function answerRtkTowers({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const towers = colAsArray(colsRoot, "rtkTowers").map((t) => ({
    ...t,
    __createdMs: parseTime(t.createdAt) || null,
    __updatedMs: parseTime(t.updatedAt) || null
  }));

  if (!towers.length) return { answer: "No rtkTowers records found in the snapshot.", meta: { snapshotId } };

  // list/summary
  if (qn === "rtk" || qn === "rtk towers" || qn === "towers" || qn === "rtk summary") {
    const byNet = new Map();
    for (const t of towers) {
      const nid = t.networkId != null ? String(t.networkId) : "unknown";
      byNet.set(nid, (byNet.get(nid) || 0) + 1);
    }
    const nets = Array.from(byNet.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const netLine = nets.map(([id, n]) => `${id}: ${n}`).join(" • ");

    const lines = towers
      .slice()
      .sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)))
      .slice(0, 30)
      .map((t) => {
        const bits = [];
        if (t.networkId != null) bits.push(`net ${t.networkId}`);
        if (t.frequencyMHz != null) bits.push(`${fmtFreq(t.frequencyMHz)} MHz`);
        return `• ${towerLabel(t)} (${t.id}) — ${bits.join(" • ")}`;
      });

    return {
      answer:
        `RTK Towers summary (snapshot ${snapshotId}):\n` +
        `• towers: ${towers.length}\n` +
        (netLine ? `• networks: ${netLine}\n` : "") +
        `\n` +
        lines.join("\n") +
        (towers.length > 30 ? `\n\n(Showing first 30)` : "") +
        `\n\nTry:\n• rtk tower Divernon\n• rtk network 4010\n• rtk freq 464.05`,
      meta: { snapshotId, towers: towers.length, networks: nets.length }
    };
  }

  // filter: network
  const networkId = parseNetwork(q);
  if (networkId != null) {
    const list = towers.filter((t) => Number(t.networkId) === networkId).sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)));
    const lines = list.map((t) => `• ${towerLabel(t)} (${t.id}) — ${fmtFreq(t.frequencyMHz)} MHz`);
    return {
      answer:
        `RTK Towers — network ${networkId} (snapshot ${snapshotId}): ${list.length}\n\n` +
        (lines.length ? lines.join("\n") : "No towers found for that network."),
      meta: { snapshotId, networkId, matching: list.length }
    };
  }

  // filter: frequency
  const freq = parseFreq(q);
  if (freq) {
    const fn = norm(freq);
    const list = towers.filter((t) => norm(safeStr(t.frequencyMHz)).includes(fn)).sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)));
    const lines = list.map((t) => `• ${towerLabel(t)} (${t.id}) — net ${t.networkId} • ${fmtFreq(t.frequencyMHz)} MHz`);
    return {
      answer:
        `RTK Towers — frequency ~${freq} (snapshot ${snapshotId}): ${list.length}\n\n` +
        (lines.length ? lines.join("\n") : "No towers found matching that frequency."),
      meta: { snapshotId, freq, matching: list.length }
    };
  }

  // detail lookup: "rtk tower <name>" or "rtk <name>"
  const needle = pickNeedle(q);
  if (needle && !includesAny(qn, ["network", "freq", "frequency", "towers"])) {
    const byId = towers.find((t) => t.id === needle) || null;
    const nn = norm(needle);
    const byName =
      towers.find((t) => norm(towerLabel(t)) === nn) ||
      towers.find((t) => norm(towerLabel(t)).includes(nn)) ||
      null;

    const t = byId || byName;
    if (!t) return { answer: `No RTK tower found for "${needle}". Try "rtk towers".`, meta: { snapshotId } };

    const lines = [];
    lines.push(`RTK Tower: ${towerLabel(t)} (${t.id})`);
    if (t.networkId != null) lines.push(`• networkId: ${t.networkId}`);
    if (t.frequencyMHz != null) lines.push(`• frequency: ${fmtFreq(t.frequencyMHz)} MHz`);
    if (t.uid) lines.push(`• uid: ${t.uid}`);
    if (t.t != null) lines.push(`• t: ${safeStr(t.t)}`);

    const created = fmtDateTime(t.__createdMs);
    const updated = fmtDateTime(t.__updatedMs);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    return { answer: lines.join("\n"), meta: { snapshotId, towerId: t.id, networkId: t.networkId } };
  }

  return {
    answer:
      `Try:\n` +
      `• rtk towers\n` +
      `• rtk tower Divernon\n` +
      `• rtk network 4010\n` +
      `• rtk freq 464.05`,
    meta: { snapshotId }
  };
}
