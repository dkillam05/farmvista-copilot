// /features/starfireMoves.js  (FULL FILE)

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

function fmtDate(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
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

function parseLimit(q) {
  const m = /\b(last)\s+(\d{1,3})\b/i.exec(q);
  if (!m) return 10;
  const n = Number(m[2]) || 10;
  return Math.max(1, Math.min(50, n));
}

function receiverSerialFromLabel(lbl) {
  const s = safeStr(lbl);
  // "SF6000 (#456789)" => 456789
  const m = /#\s*([0-9]+)/.exec(s);
  return m ? m[1] : "";
}

function moveLine(mv) {
  const dt = safeStr(mv.moveDate).trim() || fmtDate(parseTime(mv.createdAt)) || "";
  const recLbl = safeStr(mv.receiverLabel).trim() || safeStr(mv.receiverId).trim() || "Receiver";
  const from = safeStr(mv.fromLocationName).trim() || "—";
  const to = safeStr(mv.toLocationName).trim() || "—";
  const who = safeStr(mv.movedBy?.name).trim() || safeStr(mv.movedBy?.email).trim() || "";
  const bits = [];
  if (dt) bits.push(dt);
  bits.push(`${from} → ${to}`);
  if (who) bits.push(who);
  return `• ${recLbl} (${mv.id}) — ${bits.join(" • ")}`;
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

export function canHandleStarfireMoves(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "starfiremoves" || q === "starfire moves" || q === "starfire move") return true;
  if (q.startsWith("starfire moves")) return true;
  if (q.startsWith("starfire")) {
    // allow "starfire receiver 456789"
    if (q.includes("move") || q.includes("moves") || q.includes("receiver") || q.includes("sf6000")) return true;
  }

  // explicit collection name typed
  if (q.includes("starfiremoves")) return true;

  return false;
}

export function answerStarfireMoves({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const moves = colAsArray(colsRoot, "starfireMoves").map((m) => ({
    ...m,
    __createdMs: parseTime(m.createdAt) || null,
    __updatedMs: parseTime(m.updatedAt) || null
  }));

  if (!moves.length) return { answer: "No starfireMoves records found in the snapshot.", meta: { snapshotId } };

  // filters:
  // - receiver <serial|id|label>
  // - from <location>
  // - to <location>
  // - date <yyyy-mm-dd>
  // - last N
  let list = moves.slice();

  // receiver filter
  let needle = "";
  let m = /^starfire\s+receiver\s+(.+)$/i.exec(q) || /^receiver\s+(.+)$/i.exec(q);
  if (m) needle = stripQuotes(m[1]);

  if (needle) {
    const nn = norm(needle);
    list = list.filter((x) => {
      const id = norm(x.receiverId);
      const lbl = norm(x.receiverLabel);
      const serial = norm(receiverSerialFromLabel(x.receiverLabel));
      return id === nn || lbl.includes(nn) || serial === nn || serial.includes(nn);
    });
  }

  // from filter
  let fromNeedle = "";
  m = /^starfire\s+moves?\s+from\s+(.+)$/i.exec(q) || /^moves?\s+from\s+(.+)$/i.exec(q);
  if (m) fromNeedle = stripQuotes(m[1]);
  if (fromNeedle) {
    const fn = norm(fromNeedle);
    list = list.filter((x) => norm(x.fromLocationName).includes(fn) || norm(x.fromLocationId) === fn);
  }

  // to filter
  let toNeedle = "";
  m = /^starfire\s+moves?\s+to\s+(.+)$/i.exec(q) || /^moves?\s+to\s+(.+)$/i.exec(q);
  if (m) toNeedle = stripQuotes(m[1]);
  if (toNeedle) {
    const tn = norm(toNeedle);
    list = list.filter((x) => norm(x.toLocationName).includes(tn) || norm(x.toLocationId) === tn);
  }

  // date filter (YYYY-MM-DD)
  const dm = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(q);
  if (dm) {
    const dt = dm[1];
    list = list.filter((x) => safeStr(x.moveDate).trim() === dt);
  }

  // sort newest first
  list.sort((a, b) => {
    const am = Date.parse(a.moveDate || "") || a.__createdMs || 0;
    const bm = Date.parse(b.moveDate || "") || b.__createdMs || 0;
    return bm - am;
  });

  const limit = parseLimit(q);
  const shown = list.slice(0, limit);

  const lastMs = Math.max(...moves.map((x) => x.__createdMs || 0));
  const lastTxt = fmtDateTime(lastMs);

  // if user asked "summary" or "starfire moves"
  if (qn === "starfire moves" || qn === "starfiremoves" || qn === "starfire summary" || qn === "starfire moves summary") {
    const byReceiver = new Map();
    for (const mv of moves) {
      const key = receiverSerialFromLabel(mv.receiverLabel) || safeStr(mv.receiverId).trim() || "unknown";
      byReceiver.set(key, (byReceiver.get(key) || 0) + 1);
    }
    const receivers = Array.from(byReceiver.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

    const recLines = receivers.map(([k, n]) => `• ${k}: ${n} moves`);

    const lines = shown.map(moveLine);

    return {
      answer:
        `StarFire moves summary (snapshot ${snapshotId}):\n` +
        `• moves: ${moves.length}\n` +
        (lastTxt ? `• last logged: ${lastTxt}\n` : "") +
        `\nTop receivers:\n` +
        (recLines.length ? recLines.join("\n") : "• (none)") +
        `\n\nRecent moves (last ${shown.length}):\n` +
        lines.join("\n") +
        `\n\nTry:\n` +
        `• starfire receiver 456789\n` +
        `• starfire moves from "8R370"\n` +
        `• starfire moves to "In Storage"\n` +
        `• starfire moves 2025-11-19\n` +
        `• starfire moves last 20`,
      meta: { snapshotId, total: moves.length, shown: shown.length }
    };
  }

  // If specific filters were used, return filtered list
  const filters = [];
  if (needle) filters.push(`receiver~"${needle}"`);
  if (fromNeedle) filters.push(`from~"${fromNeedle}"`);
  if (toNeedle) filters.push(`to~"${toNeedle}"`);
  if (dm) filters.push(`date=${dm[1]}`);

  const lines = shown.map(moveLine);

  return {
    answer:
      `StarFire moves (snapshot ${snapshotId}):\n` +
      (filters.length ? `• filter: ${filters.join(" • ")}\n` : "") +
      `• matching: ${list.length}\n\n` +
      (lines.length ? lines.join("\n") : "No matching moves.") +
      (list.length > limit ? `\n\n(Showing last ${limit})` : "") +
      `\n\nTry:\n` +
      `• starfire moves\n` +
      `• starfire receiver 445566\n` +
      `• starfire moves from 8R370\n` +
      `• starfire moves last 20`,
    meta: { snapshotId, matching: list.length, shown: shown.length }
  };
}
