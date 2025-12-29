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

function summarizeOne(r){
  const status = safeStr(r.status).trim() || "Unknown";
  const when = safeStr(r.when).trim() || safeStr(r.timestampISO).trim() || "";
  const farm = safeStr(r.farm).trim();
  const field = safeStr(r.field).trim();
  const who = safeStr(r.submittedBy).trim() || safeStr(r.submittedByEmail).trim();
  const photos = Array.isArray(r.photos) ? r.photos.length : 0;

  const bits = [];
  if (farm) bits.push(farm);
  if (field) bits.push(field);
  if (when) bits.push(when);
  if (who) bits.push(who);
  if (photos) bits.push(`${photos} photo${photos === 1 ? "" : "s"}`);

  return `• ${r.id} — ${status}${bits.length ? ` • ${bits.join(" • ")}` : ""}`;
}

export function canHandleBoundaryRequests(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "boundaries" || q === "boundary" || q === "boundary requests" || q === "boundaries summary") return true;
  if (q.startsWith("boundaries")) return true;
  if (q.startsWith("boundary ")) return true;
  return false;
}

export function answerBoundaryRequests({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const reqs = colAsArray(colsRoot, "boundary_requests").map(r => ({
    ...r,
    __createdMs: parseTime(r.createdAt) || parseTime(r.timestampISO) || null,
    __updatedMs: parseTime(r.updatedAt) || null,
    __status: normalizeStatus(r.status)
  }));

  if (!reqs.length) return { answer: "No boundary_requests found in the snapshot.", meta: { snapshotId } };

  // summary
  if (qn === "boundaries" || qn === "boundary requests" || qn === "boundaries summary") {
    const total = reqs.length;
    const open = reqs.filter(r => r.__status === "open").length;
    const closed = reqs.filter(r => r.__status === "closed").length;

    return {
      answer:
        `Boundary requests summary (snapshot ${snapshotId}):\n` +
        `• Total: ${total}\n` +
        `• Open: ${open}\n` +
        `• Closed: ${closed}\n\n` +
        `Try:\n` +
        `• "boundaries open"\n` +
        `• "boundaries closed"\n` +
        `• "boundaries farm Lowder"\n` +
        `• "boundaries field 1323-Masonic N"\n` +
        `• "boundary <id>"`,
      meta: { snapshotId, total, open, closed }
    };
  }

  // boundaries open/closed
  let m = /^boundaries\s+(open|closed)\s*$/i.exec(q);
  if (m) {
    const st = norm(m[1]);
    const list = reqs.filter(r => r.__status === st);
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests ${st} (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, status: st, count: list.length }
    };
  }

  // boundaries farm <name>
  m = /^boundaries\s+farm\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = m[1].trim();
    const nn = norm(needle);
    const list = reqs.filter(r => norm(r.farm).includes(nn));
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests for farm "${needle}" (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, farm: needle, count: list.length }
    };
  }

  // boundaries field <name>
  m = /^boundaries\s+field\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = m[1].trim();
    const nn = norm(needle);
    const list = reqs.filter(r => norm(r.field).includes(nn));
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests for field "${needle}" (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, field: needle, count: list.length }
    };
  }

  // boundary <id>
  m = /^boundary\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const id = m[1].trim();
    const found = reqs.find(r => r.id === id) || null;

    if (!found) {
      return { answer: `No boundary request found with id ${id}.`, meta: { snapshotId } };
    }

    const lines = [];
    lines.push(`Boundary request: ${found.id}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.when) lines.push(`• when: ${found.when}`);
    if (found.boundaryType) lines.push(`• boundaryType: ${found.boundaryType}`);
    if (found.scope) lines.push(`• scope: ${found.scope}`);
    if (found.farm) lines.push(`• farm: ${found.farm}${found.farmId ? ` (${found.farmId})` : ""}`);
    if (found.field) lines.push(`• field: ${found.field}${found.fieldId ? ` (${found.fieldId})` : ""}`);
    if (found.rtkTowerId) lines.push(`• rtkTowerId: ${found.rtkTowerId}`);
    if (found.submittedBy) lines.push(`• submittedBy: ${found.submittedBy}`);
    if (found.submittedByEmail) lines.push(`• submittedByEmail: ${found.submittedByEmail}`);
    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    const photos = Array.isArray(found.photos) ? found.photos : [];
    lines.push(`• photos: ${photos.length}`);

    lines.push(`\nTip: ask "boundary ${found.id} photos" to list photo URLs (we can add that next).`);

    return { answer: lines.join("\n"), meta: { snapshotId, boundaryId: found.id } };
  }

  return {
    answer:
      `Try:\n` +
      `• boundaries summary\n` +
      `• boundaries open\n` +
      `• boundaries farm Lowder\n` +
      `• boundaries field 1323-Masonic N\n` +
      `• boundary <id>`,
    meta: { snapshotId }
  };
}
