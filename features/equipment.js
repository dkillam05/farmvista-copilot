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

function fmtDate(ms){
  if (!ms) return null;
  try{
    return new Date(ms).toLocaleString(undefined, { month:"short", day:"numeric", year:"numeric" });
  }catch{ return null; }
}

function safeStr(v){ return (v == null) ? "" : String(v); }

function normalizeStatus(v){
  return safeStr(v).trim().replace(/\.+$/,"").toLowerCase();
}

function summarizeOne(e){
  const name = safeStr(e.name).trim() || `${safeStr(e.makeName).trim()} ${safeStr(e.modelName).trim()}`.trim() || "Equipment";
  const type = safeStr(e.type).trim() || "unknown";
  const status = safeStr(e.status).trim() || "unknown";
  const year = (e.year != null) ? String(e.year) : "";
  const serial = safeStr(e.serial).trim();
  const hrs = (e.engineHours != null) ? `eng ${e.engineHours}h` : (e.totalHours != null ? `hrs ${e.totalHours}` : "");

  const bits = [];
  if (year) bits.push(year);
  bits.push(type);
  bits.push(status);
  if (hrs) bits.push(hrs);
  if (serial) bits.push(`SN ${serial}`);

  return `• ${name} (${e.id}) — ${bits.join(" • ")}`;
}

function groupCount(list, getter){
  const m = new Map();
  for (const x of list) {
    const k = safeStr(getter(x) || "Unknown").trim() || "Unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a,b)=> b[1]-a[1]);
}

function topPairs(pairs, n=6){
  return pairs.slice(0,n).map(([k,c]) => `${k}: ${c}`).join(", ");
}

export function canHandleEquipment(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "equipment" || q === "equipment summary") return true;
  if (q.startsWith("equipment ")) return true;
  return false;
}

export function answerEquipment({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const items = colAsArray(colsRoot, "equipment").map(e => ({
    ...e,
    __createdMs: parseTime(e.createdAt) || null,
    __updatedMs: parseTime(e.updatedAt) || null,
    __status: normalizeStatus(e.status)
  }));

  if (!items.length) return { answer: "No equipment records found in the snapshot.", meta: { snapshotId } };

  // equipment summary
  if (qn === "equipment" || qn === "equipment summary") {
    const byType = groupCount(items, x => x.type);
    const byMake = groupCount(items, x => x.makeName);
    const byStatus = groupCount(items, x => x.status);

    return {
      answer:
        `Equipment summary (snapshot ${snapshotId}):\n` +
        `• Total: ${items.length}\n` +
        `• By type: ${topPairs(byType)}\n` +
        `• By make: ${topPairs(byMake)}\n` +
        `• By status: ${topPairs(byStatus)}\n\n` +
        `Try:\n` +
        `• equipment type starfire\n` +
        `• equipment make John Deere\n` +
        `• equipment search SF6000\n` +
        `• equipment <id>\n` +
        `• equipment qr <id>`,
      meta: { snapshotId, total: items.length }
    };
  }

  // equipment type <type>
  let m = /^equipment\s+type\s+(.+)\s*$/i.exec(q);
  if (m) {
    const type = m[1].trim();
    const list = items.filter(x => norm(x.type) === norm(type));
    const show = list.slice(0, 40).map(summarizeOne);

    return {
      answer: `Equipment type "${type}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, type, count: list.length }
    };
  }

  // equipment make <make>
  m = /^equipment\s+make\s+(.+)\s*$/i.exec(q);
  if (m) {
    const make = m[1].trim();
    const list = items.filter(x => norm(x.makeName).includes(norm(make)));
    const show = list.slice(0, 40).map(summarizeOne);

    return {
      answer: `Equipment make "${make}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, make, count: list.length }
    };
  }

  // equipment search <text>
  m = /^equipment\s+search\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = m[1].trim();
    const nn = norm(needle);

    const list = items.filter(x => {
      const blob = [
        x.name, x.makeName, x.modelName, x.serial, x.type,
        x.firmwareVersion, x.activationLevel
      ].map(safeStr).join(" ").toLowerCase();
      return blob.includes(nn);
    });

    const show = list.slice(0, 40).map(summarizeOne);

    return {
      answer: `Equipment search "${needle}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, needle, count: list.length }
    };
  }

  // equipment qr <id>
  m = /^equipment\s+qr\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const id = m[1].trim();
    const found = items.find(x => x.id === id) || null;
    if (!found) return { answer: `No equipment found with id ${id}.`, meta: { snapshotId } };

    const qr = found.qr || {};
    const img = qr.image || {};
    const lines = [];
    lines.push(`Equipment: ${safeStr(found.name).trim() || found.id}`);
    lines.push(`• id: ${found.id}`);
    if (qr.token) lines.push(`• qr token: ${qr.token}`);
    if (img.url) lines.push(`• qr url: ${img.url}`);

    return { answer: lines.join("\n"), meta: { snapshotId, id } };
  }

  // equipment <id>
  m = /^equipment\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const id = m[1].trim();
    const found = items.find(x => x.id === id) || null;

    if (!found) {
      return {
        answer: `No equipment found with id ${id}. Try "equipment search <text>" instead.`,
        meta: { snapshotId }
      };
    }

    const created = fmtDate(found.__createdMs);
    const updated = fmtDate(found.__updatedMs);

    const lines = [];
    lines.push(`Equipment: ${safeStr(found.name).trim() || "(No name)"} (${found.id})`);
    if (found.type) lines.push(`• type: ${found.type}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.makeName || found.modelName) lines.push(`• make/model: ${[found.makeName, found.modelName].filter(Boolean).join(" ")}`);
    if (found.year != null) lines.push(`• year: ${found.year}`);
    if (found.serial) lines.push(`• serial: ${found.serial}`);

    if (found.engineHours != null) lines.push(`• engineHours: ${found.engineHours}`);
    if (found.separatorHours != null) lines.push(`• separatorHours: ${found.separatorHours}`);
    if (found.odometerMiles != null) lines.push(`• odometerMiles: ${found.odometerMiles}`);
    if (found.totalHours != null) lines.push(`• totalHours: ${found.totalHours}`);
    if (found.totalAcres != null) lines.push(`• totalAcres: ${found.totalAcres}`);

    if (found.activationLevel) lines.push(`• activationLevel: ${found.activationLevel}`);
    if (found.firmwareVersion) lines.push(`• firmwareVersion: ${found.firmwareVersion}`);
    if (found.starfireCapable != null) lines.push(`• starfireCapable: ${String(found.starfireCapable)}`);

    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    return { answer: lines.join("\n"), meta: { snapshotId, id } };
  }

  return {
    answer:
      `Try:\n` +
      `• equipment summary\n` +
      `• equipment type starfire\n` +
      `• equipment make John Deere\n` +
      `• equipment search SF6000\n` +
      `• equipment <id>\n` +
      `• equipment qr <id>`,
    meta: { snapshotId }
  };
}
