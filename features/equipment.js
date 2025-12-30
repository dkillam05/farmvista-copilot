// /features/equipment.js  (FULL FILE)
// Rev: 2025-12-30-human-equip (Human phrasing tolerant; no CLI "Try:" menus; no id=list failure)

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
function normalizeStatus(v){ return safeStr(v).trim().replace(/\.+$/,"").toLowerCase(); }

function buildMakeMap(makesArr){
  const byId = new Map();
  const byLower = new Map();
  for (const m of makesArr) {
    const id = safeStr(m.id).trim();
    const name = safeStr(m.name).trim();
    const lower = safeStr(m.nameLower).trim().toLowerCase() || norm(name);
    if (id) byId.set(id, name || id);
    if (lower) byLower.set(lower, { id, name: name || id });
  }
  return { byId, byLower };
}

function buildModelMap(modelsArr){
  const byId = new Map();
  const byLower = new Map();
  for (const m of modelsArr) {
    const id = safeStr(m.id).trim();
    const name = safeStr(m.name).trim();
    const lower = safeStr(m.nameLower).trim().toLowerCase() || norm(name);
    const makeId = safeStr(m.makeId).trim();

    if (id) byId.set(id, { id, name: name || id, makeId });
    if (lower) byLower.set(lower, { id, name: name || id, makeId });
  }
  return { byId, byLower };
}

function effectiveMakeName(e, makeMap){
  const mn = safeStr(e.makeName).trim();
  if (mn) return mn;
  const id = safeStr(e.makeId).trim();
  if (id && makeMap.byId.has(id)) return makeMap.byId.get(id);
  return "";
}

function effectiveModelName(e, modelMap){
  const mn = safeStr(e.modelName).trim();
  if (mn) return mn;
  const id = safeStr(e.modelId).trim();
  if (id && modelMap.byId.has(id)) return modelMap.byId.get(id).name;
  return "";
}

function summarizeOne(e, makeMap, modelMap){
  const make = effectiveMakeName(e, makeMap);
  const model = effectiveModelName(e, modelMap);
  const name = safeStr(e.name).trim() || `${make} ${model}`.trim() || "Equipment";

  const type = safeStr(e.type).trim() || "unknown";
  const status = safeStr(e.status).trim() || "unknown";
  const year = (e.year != null) ? String(e.year) : "";

  const hrs =
    (e.engineHours != null) ? `eng ${e.engineHours}h` :
    (e.separatorHours != null) ? `sep ${e.separatorHours}h` :
    (e.odometerMiles != null) ? `odo ${e.odometerMiles}mi` :
    (e.totalHours != null) ? `hrs ${e.totalHours}` :
    "";

  const bits = [];
  if (year) bits.push(year);
  bits.push(type);
  bits.push(status);
  if (hrs) bits.push(hrs);

  return `• ${name} — ${bits.join(" • ")}`;
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

export function answerEquipment({ question, snapshot, intent }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const makesArr = colAsArray(colsRoot, "equipment-makes");
  const modelsArr = colAsArray(colsRoot, "equipment-models");
  const makeMap = buildMakeMap(makesArr);
  const modelMap = buildModelMap(modelsArr);

  const items = colAsArray(colsRoot, "equipment").map(e => ({
    ...e,
    __createdMs: parseTime(e.createdAt) || null,
    __updatedMs: parseTime(e.updatedAt) || null,
    __status: normalizeStatus(e.status),
    __makeResolved: effectiveMakeName(e, makeMap),
    __modelResolved: effectiveModelName(e, modelMap)
  }));

  if (!items.length) return { answer: "No equipment records found in the snapshot.", meta: { snapshotId } };

  // If normalizeIntent provided a mode, honor it (prevents "equipment list" => id=list failures)
  const mode = (intent && intent.mode) ? String(intent.mode) : null;

  // SUMMARY
  if (qn === "equipment" || qn === "equipment summary" || mode === "summary") {
    const byType = groupCount(items, x => x.type);
    const byMake = groupCount(items, x => x.__makeResolved || x.makeName || x.makeId);
    const byModel = groupCount(items, x => x.__modelResolved || x.modelName || x.modelId);
    const byStatus = groupCount(items, x => x.status);

    return {
      answer:
        `Equipment summary:\n` +
        `• Total: ${items.length}\n` +
        `• By type: ${topPairs(byType)}\n` +
        `• By make: ${topPairs(byMake)}\n` +
        `• By model: ${topPairs(byModel)}\n` +
        `• By status: ${topPairs(byStatus)}`,
      meta: { snapshotId, total: items.length, makesKnown: makesArr.length, modelsKnown: modelsArr.length }
    };
  }

  // equipment type <type>
  let m = /^equipment\s+type\s+(.+)\s*$/i.exec(q);
  if (m) {
    const type = m[1].trim();
    const list = items.filter(x => norm(x.type) === norm(type));
    const show = list.slice(0, 40).map(e => summarizeOne(e, makeMap, modelMap));

    return {
      answer: `Equipment type "${type}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, type, count: list.length }
    };
  }

  // equipment make <makeName>
  m = /^equipment\s+make\s+(.+)\s*$/i.exec(q);
  if (m) {
    const makeNeedle = m[1].trim();
    const nn = norm(makeNeedle);

    const list = items.filter(x => {
      const resolved = norm(x.__makeResolved);
      const raw = norm(x.makeName);
      const id = safeStr(x.makeId).trim();
      const byIdName = id && makeMap.byId.has(id) ? norm(makeMap.byId.get(id)) : "";
      return resolved.includes(nn) || raw.includes(nn) || byIdName.includes(nn);
    });

    const show = list.slice(0, 40).map(e => summarizeOne(e, makeMap, modelMap));

    return {
      answer: `Equipment make "${makeNeedle}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, make: makeNeedle, count: list.length }
    };
  }

  // equipment model <modelName>
  m = /^equipment\s+model\s+(.+)\s*$/i.exec(q);
  if (m) {
    const modelNeedle = m[1].trim();
    const nn = norm(modelNeedle);

    const list = items.filter(x => {
      const resolved = norm(x.__modelResolved);
      const raw = norm(x.modelName);
      const id = safeStr(x.modelId).trim();
      const byIdName = id && modelMap.byId.has(id) ? norm(modelMap.byId.get(id).name) : "";
      return resolved.includes(nn) || raw.includes(nn) || byIdName.includes(nn) || norm(id) === nn;
    });

    const show = list.slice(0, 40).map(e => summarizeOne(e, makeMap, modelMap));

    return {
      answer: `Equipment model "${modelNeedle}" (${list.length}):\n\n` + (show.length ? show.join("\n") : "• none"),
      meta: { snapshotId, model: modelNeedle, count: list.length }
    };
  }

  // equipment search <text>
  m = /^equipment\s+search\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = m[1].trim();
    const nn = norm(needle);

    const list = items.filter(x => {
      const blob = [
        x.name,
        x.__makeResolved,
        x.makeName,
        x.__modelResolved,
        x.modelName,
        x.serial,
        x.type,
        x.firmwareVersion,
        x.activationLevel
      ].map(safeStr).join(" ").toLowerCase();

      return blob.includes(nn);
    });

    const show = list.slice(0, 40).map(e => summarizeOne(e, makeMap, modelMap));

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
    if (!found) return { answer: `I couldn't find an equipment item with that QR id.`, meta: { snapshotId } };

    const qr = found.qr || {};
    const img = qr.image || {};
    const lines = [];
    lines.push(`Equipment: ${safeStr(found.name).trim() || found.id}`);
    if (qr.token) lines.push(`• qr token: ${qr.token}`);
    if (img.url) lines.push(`• qr url: ${img.url}`);

    return { answer: lines.join("\n"), meta: { snapshotId, id } };
  }

  // equipment <id> (explicit id lookups only)
  // If normalizeIntent decided "search", we avoid this path entirely.
  m = /^equipment\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const id = m[1].trim();
    const found = items.find(x => x.id === id) || null;

    if (!found) {
      // Human fallback: treat as search, not "you did it wrong"
      const nn = norm(id);
      const list = items.filter(x => {
        const blob = [
          x.name,
          x.__makeResolved,
          x.makeName,
          x.__modelResolved,
          x.modelName,
          x.serial,
          x.type
        ].map(safeStr).join(" ").toLowerCase();
        return blob.includes(nn);
      });

      const show = list.slice(0, 40).map(e => summarizeOne(e, makeMap, modelMap));
      if (list.length) {
        return {
          answer: `Here’s what I found for "${id}" (${list.length}):\n\n` + show.join("\n"),
          meta: { snapshotId, needle: id, count: list.length }
        };
      }

      return {
        answer: `I didn’t find any equipment that matches "${id}".`,
        meta: { snapshotId }
      };
    }

    const created = fmtDate(found.__createdMs);
    const updated = fmtDate(found.__updatedMs);

    const make = effectiveMakeName(found, makeMap);
    const model = effectiveModelName(found, modelMap);

    const lines = [];
    lines.push(`Equipment: ${safeStr(found.name).trim() || "(No name)"}`);
    if (found.type) lines.push(`• type: ${found.type}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (make || model) lines.push(`• make/model: ${[make, model].filter(Boolean).join(" ")}`);
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

  // Final fallback (no CLI menu)
  return {
    answer:
      `I can summarize equipment, filter by type/make/model, or search by a keyword.\n` +
      `If you tell me what you’re looking for (ex: “John Deere”, “StarFire”, “sprayer”, “8R410”), I’ll narrow it down.`,
    meta: { snapshotId }
  };
}
