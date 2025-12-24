const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colObj(colsRoot, name){
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return null;
  return colsRoot[name]; // object map
}

function colAsArray(colsRoot, name){
  const objMap = colObj(colsRoot, name);
  if (!objMap) return [];
  const out = [];
  for (const [id, v] of Object.entries(objMap)) {
    if (v && typeof v === "object") out.push({ id, ...v });
  }
  return out;
}

function parseTime(v){
  // Firefoo exports timestamps like { "__time__": "2025-12-04T16:06:57.714Z" }
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

function safeStr(v){
  return (v == null) ? "" : String(v);
}

function matchContains(hay, needle){
  return norm(hay).includes(norm(needle));
}

function groupCount(list, keyFn){
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x) || "Unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  // return sorted array of [k,count]
  return Array.from(m.entries()).sort((a,b)=> b[1]-a[1]);
}

function topN(arr, n){
  return arr.slice(0, n);
}

function buildFieldIndex(fieldsArr){
  // index by id + lowercased name
  const byId = new Map();
  const byName = new Map();
  for (const f of fieldsArr) {
    const id = safeStr(f.id || f.fieldId || f.docId);
    if (id) byId.set(id, f);

    const nm = safeStr(f.name || f.fieldName || f.label || f.title);
    if (nm) byName.set(norm(nm), f);
  }
  return { byId, byName };
}

function buildFarmIndex(farmsArr){
  const byId = new Map();
  const byName = new Map();
  for (const f of farmsArr) {
    const id = safeStr(f.id || f.farmId || f.docId);
    if (id) byId.set(id, f);

    const nm = safeStr(f.name || f.farmName || f.label || f.title);
    if (nm) byName.set(norm(nm), f);
  }
  return { byId, byName };
}

function labelField(fieldDoc){
  if (!fieldDoc) return null;
  const name = safeStr(fieldDoc.name || fieldDoc.fieldName || fieldDoc.label || fieldDoc.title).trim();
  const farm = safeStr(fieldDoc.farmName || fieldDoc.farm || fieldDoc.farmLabel).trim();
  if (name && farm) return `${name} (${farm})`;
  return name || farm || null;
}

function labelFarm(farmDoc){
  if (!farmDoc) return null;
  const name = safeStr(farmDoc.name || farmDoc.farmName || farmDoc.label || farmDoc.title).trim();
  return name || null;
}

function detectNestedKeys(trial){
  // You mentioned: field, yieldBlocks, attachments, checks, trials, etc.
  // We’ll report presence/counts without dumping content.
  const keys = ["yieldBlocks", "attachments", "checks", "trials", "trialRuns", "events", "photos", "maps", "notesLog"];
  const out = {};
  for (const k of keys) {
    const v = trial[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (v && typeof v === "object") out[k] = Object.keys(v).length;
  }
  return out;
}

// ----------------------------
// Public API
// ----------------------------
export function canHandleFieldTrials(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "trials" || q === "field trials" || q === "trial" || q === "trials summary") return true;
  if (q.startsWith("trials ")) return true;      // trials pending / trials year 2025 / trials crop corn
  if (q.startsWith("trial ")) return true;       // trial <id> / trial "name"
  return false;
}

export function answerFieldTrials({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) {
    return { answer: "Snapshot is not available right now.", meta: { snapshotId } };
  }

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) {
    return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };
  }

  const trialsArr = colAsArray(colsRoot, "fieldTrials");
  const fieldsArr = colAsArray(colsRoot, "fields");
  const farmsArr  = colAsArray(colsRoot, "farms");

  if (!trialsArr.length) {
    return { answer: "No fieldTrials records found in the snapshot.", meta: { snapshotId } };
  }

  const fieldIdx = buildFieldIndex(fieldsArr);
  const farmIdx  = buildFarmIndex(farmsArr);

  // enrich a trial with optional field/farm label if ids exist
  function enrich(t){
    const fieldId = safeStr(t.fieldId || t.field || t.fieldDocId || t.fieldKey).trim() || null;
    const farmId  = safeStr(t.farmId || t.farm || t.farmDocId || t.farmKey).trim() || null;

    const fieldDoc = fieldId ? fieldIdx.byId.get(fieldId) : null;
    const farmDoc  = farmId ? farmIdx.byId.get(farmId) : null;

    const createdMs = parseTime(t.createdAt);
    const updatedMs = parseTime(t.updatedAt);

    return {
      ...t,
      __fieldLabel: labelField(fieldDoc),
      __farmLabel: labelFarm(farmDoc),
      __createdMs: createdMs,
      __updatedMs: updatedMs
    };
  }

  const trials = trialsArr.map(enrich);

  // ----------------------------
  // Helpers for filtering
  // ----------------------------
  function filterByStatus(status){
    const s = norm(status);
    return trials.filter(t => norm(t.status) === s);
  }

  function filterByYear(year){
    const y = Number(year);
    return trials.filter(t => Number(t.cropYear) === y);
  }

  function filterByCrop(crop){
    const c = norm(crop);
    return trials.filter(t => norm(t.crop) === c);
  }

  function summarizeList(list, limit = 25){
    const sorted = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0));
    const show = sorted.slice(0, limit);

    const lines = show.map(t => {
      const name = safeStr(t.trialName).trim() || "(No name)";
      const type = safeStr(t.trialType).trim();
      const crop = safeStr(t.crop).trim();
      const year = t.cropYear != null ? String(t.cropYear) : "";
      const status = safeStr(t.status).trim() || "";
      const upd = fmtDate(t.__updatedMs) || fmtDate(t.__createdMs) || "";
      const check = safeStr(t.check).trim();

      const loc = t.__fieldLabel || t.__farmLabel || "";
      const bits = [];
      if (type) bits.push(type);
      if (crop || year) bits.push([crop, year].filter(Boolean).join(" "));
      if (status) bits.push(status);
      if (check) bits.push(`check: ${check}`);
      if (loc) bits.push(loc);
      if (upd) bits.push(`updated ${upd}`);

      return `• ${name}  (${t.id})${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
    });

    return lines.join("\n") + (list.length > limit ? `\n\n(Showing ${limit} of ${list.length})` : "");
  }

  // ----------------------------
  // Commands
  // ----------------------------
  if (qn === "trials" || qn === "field trials" || qn === "trials summary") {
    const byStatus = groupCount(trials, t => (t.status ? String(t.status) : "unknown"));
    const byYear   = groupCount(trials, t => (t.cropYear != null ? String(t.cropYear) : "unknown"));
    const byCrop   = groupCount(trials, t => (t.crop ? String(t.crop) : "unknown"));
    const byType   = groupCount(trials, t => (t.trialType ? String(t.trialType) : "unknown"));

    const lines = [];
    lines.push(`Field Trials summary (snapshot ${snapshotId}):`);
    lines.push(`• Total trials: ${trials.length}`);

    const fmtTop = (pairs) => topN(pairs, 5).map(([k,c]) => `${k}: ${c}`).join(", ");

    lines.push(`• By status: ${fmtTop(byStatus)}`);
    lines.push(`• By year: ${fmtTop(byYear)}`);
    lines.push(`• By crop: ${fmtTop(byCrop)}`);
    lines.push(`• By type: ${fmtTop(byType)}`);

    lines.push(`\nTry:`);
    lines.push(`• "trials pending" / "trials active" / "trials completed"`);
    lines.push(`• "trials year 2025"`);
    lines.push(`• "trials crop corn"`);
    lines.push(`• "trial <id>"`);

    return { answer: lines.join("\n"), meta: { snapshotId, trialsCount: trials.length } };
  }

  // trials pending/active/completed
  let m = /^trials\s+(pending|active|completed)\s*$/i.exec(q);
  if (m) {
    const status = m[1];
    const list = filterByStatus(status);
    return {
      answer: `Trials ${status} (${list.length}):\n\n` + (list.length ? summarizeList(list, 30) : "• none"),
      meta: { snapshotId, status }
    };
  }

  // trials year 2025
  m = /^trials\s+year\s+([0-9]{4})\s*$/i.exec(q);
  if (m) {
    const year = m[1];
    const list = filterByYear(year);
    return {
      answer: `Trials for cropYear ${year} (${list.length}):\n\n` + (list.length ? summarizeList(list, 30) : "• none"),
      meta: { snapshotId, year }
    };
  }

  // trials crop corn/soybeans
  m = /^trials\s+crop\s+(.+)\s*$/i.exec(q);
  if (m) {
    const crop = m[1].trim();
    const list = filterByCrop(crop);
    return {
      answer: `Trials for crop "${crop}" (${list.length}):\n\n` + (list.length ? summarizeList(list, 30) : "• none"),
      meta: { snapshotId, crop }
    };
  }

  // trial <id> OR trial "name"
  m = /^trial\s+(.+)\s*$/i.exec(q);
  if (m) {
    let needle = m[1].trim();
    // allow quotes
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }

    let found =
      trials.find(t => t.id === needle) ||
      trials.find(t => matchContains(t.trialName, needle)) ||
      trials.find(t => matchContains(t.trialType, needle)) ||
      null;

    if (!found) {
      return {
        answer: `I couldn’t find a trial matching "${needle}". Try "trials summary" or "trials pending".`,
        meta: { snapshotId }
      };
    }

    const nested = detectNestedKeys(found);
    const created = fmtDate(found.__createdMs);
    const updated = fmtDate(found.__updatedMs);

    const lines = [];
    lines.push(`Trial: ${safeStr(found.trialName).trim() || "(No name)"} (${found.id})`);
    if (found.trialType) lines.push(`• type: ${found.trialType}`);
    if (found.crop || found.cropYear) lines.push(`• crop: ${[found.crop, found.cropYear].filter(Boolean).join(" ")}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.operationTask) lines.push(`• task: ${found.operationTask}`);
    if (found.treatmentProduct) lines.push(`• treatmentProduct: ${found.treatmentProduct}`);
    if (found.check) lines.push(`• check: ${found.check}`);
    if (found.__fieldLabel) lines.push(`• field: ${found.__fieldLabel}`);
    if (found.__farmLabel) lines.push(`• farm: ${found.__farmLabel}`);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);
    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    const nestedKeys = Object.keys(nested);
    if (nestedKeys.length) {
      lines.push(`• nested: ` + nestedKeys.map(k => `${k}(${nested[k]})`).join(", "));
      lines.push(`(Ask: "trial ${found.id} yieldBlocks" etc. — we’ll add deep views next)`);
    }

    return { answer: lines.join("\n"), meta: { snapshotId, trialId: found.id } };
  }

  return {
    answer:
      `Try:\n` +
      `• "trials summary"\n` +
      `• "trials pending"\n` +
      `• "trials year 2025"\n` +
      `• "trials crop corn"\n` +
      `• "trial <id>"`,
    meta: { snapshotId }
  };
}
