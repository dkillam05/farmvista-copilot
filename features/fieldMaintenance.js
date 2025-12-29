// /features/fieldMaintenance.js  (FULL FILE)

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

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function pickNeedle(q) {
  // "field maintenance <needle>" (id or text search)
  let m =
    /^field\s+maintenance\s+(.+)$/i.exec(q) ||
    /^maintenance\s+(.+)$/i.exec(q) ||
    /^fieldmaint\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function normalizeStatus(s) {
  const t = norm(s);
  if (!t) return "";
  // keep your actual status strings, but allow flexible matching
  return t.replace(/\s+/g, " ").trim();
}

function topicName(t) {
  return safeStr(t.label).trim() || safeStr(t.name).trim() || t.id || "Topic";
}

function buildTopicIndex(topics) {
  const byId = new Map();
  const byName = new Map(); // nameLower -> topic
  for (const t of topics) {
    byId.set(t.id, t);
    const key = norm(t.nameLower || t.name || t.label);
    if (key) byName.set(key, t);
  }
  return { byId, byName };
}

function resolveTopic(needle, topicIndex) {
  const nn = norm(needle);
  if (!nn) return null;

  if (topicIndex.byId.has(needle)) return topicIndex.byId.get(needle);

  // exact match on nameLower/name/label
  if (topicIndex.byName.has(nn)) return topicIndex.byName.get(nn);

  // contains match
  for (const [k, t] of topicIndex.byName.entries()) {
    if (k.includes(nn)) return t;
  }
  return null;
}

function lineForItem(it, topicIndex) {
  const status = normalizeStatus(it.status) || "unknown";
  const pri = it.priority != null ? Number(it.priority) : null;

  const when = parseTime(it.dateSubmitted) || parseTime(it.createdAt) || parseTime(it.updatedAt);
  const whenTxt = fmtDateTime(when) || "";

  const topic =
    (it.topicId && topicIndex.byId.get(it.topicId)) ? topicIndex.byId.get(it.topicId) : null;
  const topicTxt = topic ? topicName(topic) : safeStr(it.topicLabel).trim() || "—";

  const farmTxt = safeStr(it.farmName).trim();
  const fieldTxt = safeStr(it.fieldName).trim();

  const photos = Number(it.photoCount) || 0;

  const bits = [];
  if (whenTxt) bits.push(whenTxt);
  bits.push(`status: ${status}`);
  if (pri != null && Number.isFinite(pri)) bits.push(`priority: ${pri}`);
  if (topicTxt) bits.push(`topic: ${topicTxt}`);
  if (photos) bits.push(`${photos} photo${photos === 1 ? "" : "s"}`);

  const head = `${farmTxt || "Farm?"} • ${fieldTxt || "Field?"}`;
  return `• ${head} (${it.id}) — ${bits.join(" • ")}`;
}

export function canHandleFieldMaintenance(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "fieldmaintenance" || q === "field maintenance" || q === "maintenance") return true;

  if (q.startsWith("field maintenance")) return true;
  if (q.startsWith("fieldmaintenance")) return true;
  if (q.startsWith("maintenance ")) return true;

  // common filters
  if (q.includes("maintenance")) return true;

  return false;
}

export function answerFieldMaintenance({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const items = colAsArray(colsRoot, "fieldMaintenance").map((r) => ({
    ...r,
    __createdMs: parseTime(r.createdAt) || null,
    __updatedMs: parseTime(r.updatedAt) || null,
    __submittedMs: parseTime(r.dateSubmitted) || null
  }));

  const topics = colAsArray(colsRoot, "fieldMaintenanceTopics").map((t) => ({
    ...t,
    __createdMs: parseTime(t.createdAt) || null,
    __updatedMs: parseTime(t.updatedAt) || null
  }));

  const topicIndex = buildTopicIndex(topics);

  if (!items.length) {
    return { answer: "No fieldMaintenance records found in the snapshot.", meta: { snapshotId } };
  }

  // ---- parse filters from question ----
  // supported:
  //  - "field maintenance open|pending|needs approved|completed"
  //  - "field maintenance by farm <name>"
  //  - "field maintenance by field <name>"
  //  - "field maintenance topic <name>"
  //  - "field maintenance <id>" (details)
  const needle = pickNeedle(q);

  // details by exact id
  if (needle && items.some((x) => x.id === needle)) {
    const it = items.find((x) => x.id === needle);
    const lines = [];
    lines.push(`Field Maintenance: ${it.id}`);
    const farmTxt = safeStr(it.farmName).trim();
    const fieldTxt = safeStr(it.fieldName).trim();
    if (farmTxt) lines.push(`• farm: ${farmTxt} (${safeStr(it.farmId)})`);
    if (fieldTxt) lines.push(`• field: ${fieldTxt} (${safeStr(it.fieldId)})`);
    if (it.status) lines.push(`• status: ${it.status}`);
    if (it.priority != null) lines.push(`• priority: ${safeStr(it.priority)}`);
    if (it.topicLabel) lines.push(`• topic: ${it.topicLabel}`);
    if (it.topicId) {
      const t = topicIndex.byId.get(it.topicId) || null;
      if (t) lines.push(`• topicId: ${it.topicId} (${topicName(t)})`);
      else lines.push(`• topicId: ${it.topicId}`);
    }
    if (it.notes) lines.push(`• notes: ${it.notes}`);

    const submitted = fmtDateTime(it.__submittedMs);
    const created = fmtDateTime(it.__createdMs);
    const updated = fmtDateTime(it.__updatedMs);
    if (submitted) lines.push(`• submitted: ${submitted}`);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    const photos = Array.isArray(it.photoUrls) ? it.photoUrls : [];
    const photoCount = Number(it.photoCount) || photos.length || 0;
    lines.push(`• photos: ${photoCount}`);
    if (photos.length) {
      lines.push(`\nPhoto URLs (first ${Math.min(3, photos.length)}):`);
      photos.slice(0, 3).forEach((u) => lines.push(`• ${u}`));
      if (photos.length > 3) lines.push(`• …and ${photos.length - 3} more`);
    }

    const sb = it.submittedBy || {};
    const who = safeStr(sb.name).trim() || safeStr(sb.email).trim() || "";
    if (who) lines.push(`\nSubmitted by: ${who}`);

    return { answer: lines.join("\n"), meta: { snapshotId, id: it.id } };
  }

  // status filter
  let statusNeedle = "";
  if (needle) {
    // "field maintenance pending"
    if (needle === "open") statusNeedle = "pending"; // you can treat open as pending by default
    else statusNeedle = needle;
  }

  // by farm
  let farmNeedle = "";
  let m = /^field\s+maintenance\s+by\s+farm\s+(.+)$/i.exec(q) || /^maintenance\s+by\s+farm\s+(.+)$/i.exec(q);
  if (m) farmNeedle = stripQuotes(m[1]);

  // by field
  let fieldNeedle = "";
  m = /^field\s+maintenance\s+by\s+field\s+(.+)$/i.exec(q) || /^maintenance\s+by\s+field\s+(.+)$/i.exec(q);
  if (m) fieldNeedle = stripQuotes(m[1]);

  // by topic
  let topicNeedle = "";
  m = /^field\s+maintenance\s+topic\s+(.+)$/i.exec(q) || /^maintenance\s+topic\s+(.+)$/i.exec(q);
  if (m) topicNeedle = stripQuotes(m[1]);

  // apply filters
  let list = items.slice();

  if (statusNeedle) {
    const sn = normalizeStatus(statusNeedle);
    // allow "needs approved" / "needs-approved" / etc
    list = list.filter((it) => normalizeStatus(it.status).includes(sn));
  }

  if (farmNeedle) {
    const fn = norm(farmNeedle);
    list = list.filter((it) => norm(it.farmName).includes(fn) || safeStr(it.farmId) === farmNeedle);
  }

  if (fieldNeedle) {
    const fln = norm(fieldNeedle);
    list = list.filter((it) => norm(it.fieldName).includes(fln) || safeStr(it.fieldId) === fieldNeedle);
  }

  if (topicNeedle) {
    const resolved = resolveTopic(topicNeedle, topicIndex);
    if (resolved) {
      list = list.filter((it) => it.topicId === resolved.id || norm(it.topicLabel) === norm(topicName(resolved)));
    } else {
      const tn = norm(topicNeedle);
      list = list.filter((it) => norm(it.topicLabel).includes(tn));
    }
  }

  // summary counts (always helpful)
  const total = items.length;
  const byStatus = new Map();
  for (const it of items) {
    const s = normalizeStatus(it.status) || "unknown";
    byStatus.set(s, (byStatus.get(s) || 0) + 1);
  }

  // sort newest first by submitted -> created -> updated
  list.sort((a, b) => {
    const am = a.__submittedMs || a.__createdMs || a.__updatedMs || 0;
    const bm = b.__submittedMs || b.__createdMs || b.__updatedMs || 0;
    return bm - am;
  });

  const maxShow = 15;
  const shown = list.slice(0, maxShow);

  const lines = shown.map((it) => lineForItem(it, topicIndex));

  // build status summary line
  const statusBits = Array.from(byStatus.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s}: ${n}`);

  const filters = [];
  if (statusNeedle) filters.push(`status~"${statusNeedle}"`);
  if (farmNeedle) filters.push(`farm~"${farmNeedle}"`);
  if (fieldNeedle) filters.push(`field~"${fieldNeedle}"`);
  if (topicNeedle) filters.push(`topic~"${topicNeedle}"`);

  return {
    answer:
      `Field Maintenance (snapshot ${snapshotId}):\n` +
      `• total: ${fmtInt(total)}\n` +
      `• statuses: ${statusBits.join(" • ")}\n` +
      (filters.length ? `• filter: ${filters.join(" • ")}\n` : "") +
      `\n` +
      (list.length
        ? lines.join("\n") + (list.length > maxShow ? `\n\n(Showing newest ${maxShow} of ${list.length})` : "")
        : `No matches.\n`) +
      `\n\nTry:\n` +
      `• field maintenance pending\n` +
      `• field maintenance needs approved\n` +
      `• field maintenance by farm Pisgah\n` +
      `• field maintenance topic washout\n` +
      `• field maintenance <id>`,
    meta: { snapshotId, total, matching: list.length, shown: shown.length }
  };
}
