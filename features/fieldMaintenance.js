// /features/fieldMaintenance.js  (FULL FILE)
// Rev: 2025-12-30-human-maint (Human phrasing tolerant; no CLI "Try:" menus; no snapshotId in user text)

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

function normalizeStatus(s) {
  const t = norm(s);
  if (!t) return "";
  return t.replace(/\s+/g, " ").trim().replace(/\.+$/,"");
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

  if (topicIndex.byName.has(nn)) return topicIndex.byName.get(nn);

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

// ---- Human-ish query parsing ----
function pickNeedle(q) {
  // "field maintenance <needle>" (id or text search)
  let m =
    /^field\s+maintenance\s+(.+)$/i.exec(q) ||
    /^maintenance\s+(.+)$/i.exec(q) ||
    /^fieldmaint\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function parseHumanFilters(qRaw) {
  const q = (qRaw || "").toString().trim();
  const qn = norm(q);

  const out = {
    // optional filters
    statusNeedle: "",
    farmNeedle: "",
    fieldNeedle: "",
    topicNeedle: "",
    // detail id candidate (exact match handled later)
    needle: pickNeedle(q)
  };

  // status words anywhere in sentence
  // Examples:
  // "pending maintenance", "maintenance needs approved", "open maintenance"
  if (/\bneeds\s+approved\b/i.test(q)) out.statusNeedle = "needs approved";
  else if (/\bpending\b/i.test(q)) out.statusNeedle = "pending";
  else if (/\bcomplete(d)?\b/i.test(q)) out.statusNeedle = "completed";
  else if (/\bopen\b/i.test(q)) out.statusNeedle = "pending"; // your default mapping

  // explicit patterns:
  // "maintenance by farm Pisgah" OR "maintenance for farm Pisgah"
  let m =
    /^field\s+maintenance\s+(by|for)\s+farm\s+(.+)$/i.exec(q) ||
    /^maintenance\s+(by|for)\s+farm\s+(.+)$/i.exec(q);
  if (m) out.farmNeedle = stripQuotes(m[2]);

  // "maintenance by field North 80" OR "maintenance for field North 80"
  m =
    /^field\s+maintenance\s+(by|for)\s+field\s+(.+)$/i.exec(q) ||
    /^maintenance\s+(by|for)\s+field\s+(.+)$/i.exec(q);
  if (m) out.fieldNeedle = stripQuotes(m[2]);

  // "maintenance topic washout"
  m =
    /^field\s+maintenance\s+topic\s+(.+)$/i.exec(q) ||
    /^maintenance\s+topic\s+(.+)$/i.exec(q);
  if (m) out.topicNeedle = stripQuotes(m[1]);

  // softer:
  // "maintenance for Pisgah" => assume farm if no explicit field/topic
  if (!out.farmNeedle && !out.fieldNeedle && !out.topicNeedle) {
    const softFarm = /^maintenance\s+(for|at|in)\s+(.+)$/i.exec(q);
    if (softFarm && softFarm[2]) out.farmNeedle = stripQuotes(softFarm[2]);
  }

  // softer:
  // "maintenance on field North 80"
  if (!out.fieldNeedle) {
    const softField = /\b(on|for)\s+field\s+(.+)$/i.exec(q);
    if (softField && softField[2]) out.fieldNeedle = stripQuotes(softField[2]);
  }

  // if the only needle is a known status word, treat it as status
  if (!out.statusNeedle && out.needle) {
    const n = normalizeStatus(out.needle);
    if (["pending", "needs approved", "needsapproved", "approved", "completed", "complete", "open"].some(x => n === x)) {
      out.statusNeedle = (n === "open") ? "pending" : out.needle;
      out.needle = "";
    }
  }

  // normalize empties
  out.statusNeedle = out.statusNeedle ? String(out.statusNeedle) : "";
  out.farmNeedle = out.farmNeedle ? String(out.farmNeedle) : "";
  out.fieldNeedle = out.fieldNeedle ? String(out.fieldNeedle) : "";
  out.topicNeedle = out.topicNeedle ? String(out.topicNeedle) : "";

  return out;
}

export function canHandleFieldMaintenance(question) {
  const q = norm(question);
  if (!q) return false;

  // direct mentions
  if (q === "fieldmaintenance" || q === "field maintenance" || q === "maintenance") return true;

  // common words people will use
  if (q.includes("maintenance")) return true;
  if (q.includes("work order") || q.includes("work orders")) return true;

  return false;
}

export function answerFieldMaintenance({ question, snapshot, intent }) {
  const q = (question || "").toString().trim();

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find maintenance collections in this snapshot right now.", meta: { snapshotId } };

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
    return { answer: "No field maintenance records were found in the snapshot.", meta: { snapshotId } };
  }

  // parse filters from question (human-friendly)
  const f = parseHumanFilters(q);

  // details by exact id
  if (f.needle && items.some((x) => x.id === f.needle)) {
    const it = items.find((x) => x.id === f.needle);
    const lines = [];
    lines.push(`Field Maintenance: ${it.id}`);

    const farmTxt = safeStr(it.farmName).trim();
    const fieldTxt = safeStr(it.fieldName).trim();
    if (farmTxt) lines.push(`• farm: ${farmTxt}${it.farmId ? ` (${safeStr(it.farmId)})` : ""}`);
    if (fieldTxt) lines.push(`• field: ${fieldTxt}${it.fieldId ? ` (${safeStr(it.fieldId)})` : ""}`);
    if (it.status) lines.push(`• status: ${it.status}`);
    if (it.priority != null) lines.push(`• priority: ${safeStr(it.priority)}`);

    const t = it.topicId ? (topicIndex.byId.get(it.topicId) || null) : null;
    const topicTxt = safeStr(it.topicLabel).trim() || (t ? topicName(t) : "");
    if (topicTxt) lines.push(`• topic: ${topicTxt}`);

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

  // apply filters
  let list = items.slice();

  if (f.statusNeedle) {
    const sn = normalizeStatus(f.statusNeedle);
    list = list.filter((it) => normalizeStatus(it.status).includes(sn));
  }

  if (f.farmNeedle) {
    const fn = norm(f.farmNeedle);
    list = list.filter((it) => norm(it.farmName).includes(fn) || safeStr(it.farmId) === f.farmNeedle);
  }

  if (f.fieldNeedle) {
    const fln = norm(f.fieldNeedle);
    list = list.filter((it) => norm(it.fieldName).includes(fln) || safeStr(it.fieldId) === f.fieldNeedle);
  }

  if (f.topicNeedle) {
    const resolved = resolveTopic(f.topicNeedle, topicIndex);
    if (resolved) {
      list = list.filter((it) => it.topicId === resolved.id || norm(it.topicLabel) === norm(topicName(resolved)));
    } else {
      const tn = norm(f.topicNeedle);
      list = list.filter((it) => norm(it.topicLabel).includes(tn));
    }
  }

  // summary counts
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

  const statusBits = Array.from(byStatus.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s}: ${n}`);

  const filters = [];
  if (f.statusNeedle) filters.push(`status~"${f.statusNeedle}"`);
  if (f.farmNeedle) filters.push(`farm~"${f.farmNeedle}"`);
  if (f.fieldNeedle) filters.push(`field~"${f.fieldNeedle}"`);
  if (f.topicNeedle) filters.push(`topic~"${f.topicNeedle}"`);

  if (!list.length) {
    return {
      answer:
        `No field maintenance items matched that request.\n\n` +
        `Summary: ${fmtInt(total)} total • ${statusBits.join(" • ")}`,
      meta: { snapshotId, total, matching: 0, shown: 0, filters }
    };
  }

  return {
    answer:
      `Field Maintenance:\n` +
      `• total: ${fmtInt(total)}\n` +
      `• statuses: ${statusBits.join(" • ")}\n` +
      (filters.length ? `• filter: ${filters.join(" • ")}\n` : "") +
      `\n` +
      lines.join("\n") +
      (list.length > maxShow ? `\n\n(Showing newest ${maxShow} of ${list.length})` : ""),
    meta: { snapshotId, total, matching: list.length, shown: shown.length, filters }
  };
}
