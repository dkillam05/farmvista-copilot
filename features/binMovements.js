const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colAsArray(colsRoot, name){
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return [];
  const objMap = colsRoot[name];
  const out = [];
  for (const [id, v] of Object.entries(objMap)) {
    if (v && typeof v === "object") out.push({ id, ...v });
  }
  return out;
}

function parseTime(v){
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

function fmtInt(n){
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function isISODate(s){
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test((s || "").trim());
}

function daysAgoISO(n){
  const d = new Date(Date.now() - n * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const da = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}

function sumBushels(list){
  let totalIn = 0;
  let totalOut = 0;

  for (const x of list) {
    const bu = Number(x.bushels) || 0;
    const dir = norm(x.direction);
    if (dir === "in") totalIn += bu;
    else if (dir === "out") totalOut += bu;
  }

  return { totalIn, totalOut, net: totalIn - totalOut };
}

function groupByBin(list){
  const m = new Map(); // key: binNum, value: {in,out,net}
  for (const x of list) {
    const bin = (x.binNum != null) ? String(x.binNum) : String(x.binIndex ?? "?");
    if (!m.has(bin)) m.set(bin, { totalIn: 0, totalOut: 0, net: 0 });
    const v = m.get(bin);

    const bu = Number(x.bushels) || 0;
    const dir = norm(x.direction);
    if (dir === "in") v.totalIn += bu;
    else if (dir === "out") v.totalOut += bu;
    v.net = v.totalIn - v.totalOut;
  }
  return [...m.entries()].sort((a,b)=> Number(a[0]) - Number(b[0]));
}

export function canHandleBinMovements(question){
  const q = norm(question);
  if (!q) return false;
  if (q.startsWith("bins")) return true;
  if (q.startsWith("bin ")) return true;
  if (q.includes("bin movements")) return true;
  return false;
}

export function answerBinMovements({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const moves = colAsArray(colsRoot, "binMovements").map(m => ({
    ...m,
    __ms: parseTime(m.createdAt) || (m.dateISO ? Date.parse(m.dateISO) : null)
  }));

  if (!moves.length) {
    return { answer: "No binMovements records found in the snapshot.", meta: { snapshotId } };
  }

  // ---- parsing ----
  // bins summary
  if (qn === "bins" || qn === "bins summary" || qn === "bin movements") {
    const s = sumBushels(moves);
    return {
      answer:
        `Bin movements summary (snapshot ${snapshotId}):\n` +
        `• Records: ${moves.length}\n` +
        `• IN: ${fmtInt(s.totalIn)} bu\n` +
        `• OUT: ${fmtInt(s.totalOut)} bu\n` +
        `• NET: ${fmtInt(s.net)} bu\n\n` +
        `Try:\n` +
        `• bins site "FPI Macomb"\n` +
        `• bins on 2025-11-22\n` +
        `• bins in last 7 days\n` +
        `• bins out last 7 days\n` +
        `• bins net last 7 days`,
      meta: { snapshotId }
    };
  }

  // bins on YYYY-MM-DD
  let m = /^bins\s+on\s+([0-9]{4}-[0-9]{2}-[0-9]{2})$/i.exec(q);
  if (m) {
    const day = m[1];
    const list = moves.filter(x => String(x.dateISO || "").trim() === day);
    const s = sumBushels(list);
    const bins = groupByBin(list);
    const lines = bins.map(([bin, v]) => `• Bin ${bin}: IN ${fmtInt(v.totalIn)} • OUT ${fmtInt(v.totalOut)} • NET ${fmtInt(v.net)}`);

    return {
      answer:
        `Bin movements on ${day} (${list.length} records):\n` +
        `• IN: ${fmtInt(s.totalIn)} bu\n` +
        `• OUT: ${fmtInt(s.totalOut)} bu\n` +
        `• NET: ${fmtInt(s.net)} bu\n` +
        (lines.length ? `\nBy bin:\n${lines.join("\n")}` : ""),
      meta: { snapshotId, day }
    };
  }

  // bins site "name"
  m = /^bins\s+site\s+(.+)$/i.exec(q);
  if (m) {
    let needle = m[1].trim();
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }
    const nn = norm(needle);
    const list = moves.filter(x => norm(x.siteName).includes(nn));
    const s = sumBushels(list);
    return {
      answer:
        `Bin movements for site "${needle}" (${list.length} records):\n` +
        `• IN: ${fmtInt(s.totalIn)} bu\n` +
        `• OUT: ${fmtInt(s.totalOut)} bu\n` +
        `• NET: ${fmtInt(s.net)} bu`,
      meta: { snapshotId, siteName: needle }
    };
  }

  // bins siteId <id>
  m = /^bins\s+siteid\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const siteId = m[1].trim();
    const list = moves.filter(x => String(x.siteId || "").trim() === siteId);
    const s = sumBushels(list);
    const anyName = list.find(x => x.siteName)?.siteName || "";
    return {
      answer:
        `Bin movements for siteId ${siteId}${anyName ? ` (${anyName})` : ""} (${list.length} records):\n` +
        `• IN: ${fmtInt(s.totalIn)} bu\n` +
        `• OUT: ${fmtInt(s.totalOut)} bu\n` +
        `• NET: ${fmtInt(s.net)} bu`,
      meta: { snapshotId, siteId }
    };
  }

  // bins (in|out|net) last N days
  m = /^bins\s+(in|out|net)\s+last\s+([0-9]+)\s+days$/i.exec(q);
  if (m) {
    const mode = norm(m[1]);
    const days = Math.max(1, Math.min(30, Number(m[2]) || 7)); // cap at 30
    const startISO = daysAgoISO(days - 1);

    const list = moves.filter(x => {
      const d = String(x.dateISO || "").trim();
      return isISODate(d) && d >= startISO;
    });

    const s = sumBushels(list);
    const val = (mode === "in") ? s.totalIn : (mode === "out") ? s.totalOut : s.net;

    return {
      answer:
        `Bins ${mode.toUpperCase()} last ${days} days (${startISO} → today): ${fmtInt(val)} bu\n` +
        `• IN: ${fmtInt(s.totalIn)} bu\n` +
        `• OUT: ${fmtInt(s.totalOut)} bu\n` +
        `• NET: ${fmtInt(s.net)} bu`,
      meta: { snapshotId, days, mode }
    };
  }

  return {
    answer:
      `Try:\n` +
      `• bins summary\n` +
      `• bins site "FPI Macomb"\n` +
      `• bins on 2025-11-22\n` +
      `• bins net last 7 days`,
    meta: { snapshotId }
  };
}
