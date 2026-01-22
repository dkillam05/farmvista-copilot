// ======================================================================
// /src/data/getters/fieldMaintenance.js  (FULL FILE - ESM)
// Rev: 2026-01-22-v1-ESM
//
// ACTIVE-ONLY DEFAULT (per Dane):
// - Default returns active-only (everything NOT completed/archived)
// - includeArchived=true returns archived separately
//
// Firefoo fields observed:
//  - status: "needs approved", "pending", etc.
//  - priority (number), priorityReason (string|null)
//  - topicId, topicLabel
//  - farmId, farmName, fieldId, fieldName
//  - notes, photoCount, photoUrls[]
//  - location {lat,lng} (sometimes present)
//  - submittedBy {name,email,uid}
//  - createdAt, updatedAt, dateSubmitted
//
// Output goals:
// - list + count
// - grouped counts by status / topic / farm
// - consistent summary line per request
// ======================================================================

import { db } from '../sqlite.js';

function getDb(){
  return (typeof db === 'function') ? db() : db;
}

function normStr(v){
  return (v == null) ? "" : String(v);
}
function normLower(v){
  return normStr(v).trim().toLowerCase();
}
function truthy(v){
  if(v === true) return true;
  if(v === false) return false;
  const s = normLower(v);
  return (s === "true" || s === "1" || s === "yes");
}
function safeNum(v){
  if(v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasTable(database, name){
  try{
    const row = database.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
    ).get(name);
    return !!row;
  }catch(e){
    return false;
  }
}

function firstExistingTable(database, candidates){
  for(const t of candidates){
    if(hasTable(database, t)) return t;
  }
  return null;
}

function hasColumn(database, table, col){
  try{
    const rows = database.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => String(r.name).toLowerCase() === String(col).toLowerCase());
  }catch(e){
    return false;
  }
}

function pickCols(database, table, desired){
  return desired.filter(c => hasColumn(database, table, c));
}

function asArray(v){
  if(Array.isArray(v)) return v;
  if(v == null) return [];
  try{
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  }catch(e){
    return [];
  }
}

function asObj(v){
  if(v && typeof v === "object") return v;
  if(v == null) return null;
  try{
    const parsed = JSON.parse(v);
    return (parsed && typeof parsed === "object") ? parsed : null;
  }catch(e){
    return null;
  }
}

function normStatus(v){
  const s = normLower(v);
  if(!s) return "";
  if(s === "needs approved" || s === "needs_approved") return "needs approved";
  if(s === "in progress" || s === "in_progress") return "in progress";
  if(s === "complete" || s === "completed") return "completed";
  if(s === "archived") return "archived";
  return s;
}

function isArchivedStatus(status){
  const s = normStatus(status);
  return (s === "completed" || s === "archived" || s === "done" || s === "closed");
}

function isoOrEmpty(v){
  if(v == null) return "";
  return String(v);
}

function shortText(s, max=120){
  const t = normStr(s).trim().replace(/\s+/g, " ");
  if(!t) return "";
  return t.length <= max ? t : (t.slice(0, max - 1) + "…");
}

function sortNewestFirst(a,b){
  const aa = normStr(a.updatedAtISO || a.updatedAt || a.dateSubmittedISO || a.dateSubmitted || a.createdAtISO || a.createdAt || "");
  const bb = normStr(b.updatedAtISO || b.updatedAt || b.dateSubmittedISO || b.dateSubmitted || b.createdAtISO || b.createdAt || "");
  return bb.localeCompare(aa);
}

function summarizeRequest(r){
  const status = normStatus(r.status);
  const pri = safeNum(r.priority);
  const topic = normStr(r.topicLabel) || "(No topic)";
  const farm = normStr(r.farmName) || "(Unknown farm)";
  const field = normStr(r.fieldName) || "(Unknown field)";
  const notes = shortText(r.notes, 140);
  const photoCount = safeNum(r.photoCount);

  const submittedByObj = asObj(r.submittedBy);
  const submittedByName =
    normStr(r.submittedByName) ||
    (submittedByObj ? normStr(submittedByObj.name) : "") ||
    "";

  const submittedISO =
    normStr(r.dateSubmittedISO) ||
    normStr(r.dateSubmitted) ||
    normStr(r.createdAtISO) ||
    normStr(r.createdAt) ||
    "";

  const locObj = asObj(r.location);
  const lat = safeNum(r.locationLat ?? (locObj ? locObj.lat : null));
  const lng = safeNum(r.locationLng ?? (locObj ? locObj.lng : null));

  const bits = [];
  bits.push(`${topic}`);
  bits.push(`${farm} • ${field}`);
  if(pri != null) bits.push(`P${pri}`);
  if(status) bits.push(`status: ${status}`);
  if(photoCount != null) bits.push(`${photoCount} photo${photoCount === 1 ? "" : "s"}`);
  if(submittedByName) bits.push(`by ${submittedByName}`);
  if(submittedISO) bits.push(submittedISO);
  if(notes) bits.push(notes);
  if(lat != null && lng != null) bits.push(`loc: ${lat},${lng}`);

  return {
    id: r.id,
    status,
    priority: pri,
    topicId: normStr(r.topicId),
    topicLabel: topic,
    farmId: normStr(r.farmId),
    farmName: farm,
    fieldId: normStr(r.fieldId),
    fieldName: field,
    headline: bits.join(" • ")
  };
}

function countByKey(items, keyFn, labelName){
  const map = new Map();
  for(const it of items){
    const k = keyFn(it);
    if(!k) continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([k,count]) => ({ [labelName]: k, count }))
    .sort((a,b) => b.count - a.count || String(a[labelName]).localeCompare(String(b[labelName])));
}

function groupByFarm(items){
  const farmMap = new Map();

  for(const it of items){
    const farmKey = `${it.farmId || ""}||${it.farmName || ""}`.toLowerCase();
    if(!farmMap.has(farmKey)){
      farmMap.set(farmKey, {
        farmId: it.farmId || "",
        farmName: it.farmName || "(Unknown farm)",
        count: 0,
        fieldsCount: 0,
        fields: []
      });
    }
    const farm = farmMap.get(farmKey);
    farm.count++;

    if(!farm._fieldMap) farm._fieldMap = new Map();
    const fieldKey = `${it.fieldId || ""}||${it.fieldName || ""}`.toLowerCase();
    if(!farm._fieldMap.has(fieldKey)){
      farm._fieldMap.set(fieldKey, {
        fieldId: it.fieldId || "",
        fieldName: it.fieldName || "(Unknown field)",
        count: 0,
        items: []
      });
      farm.fieldsCount++;
    }

    const f = farm._fieldMap.get(fieldKey);
    f.count++;
    f.items.push(it);
  }

  const farms = Array.from(farmMap.values()).map(f => {
    const fields = Array.from(f._fieldMap.values())
      .map(x => {
        x.items.sort((a,b) => (b.headline || "").localeCompare(a.headline || ""));
        return x;
      })
      .sort((a,b) => b.count - a.count || a.fieldName.localeCompare(b.fieldName));
    delete f._fieldMap;
    f.fields = fields;
    return f;
  }).sort((a,b) => b.count - a.count || a.farmName.localeCompare(b.farmName));

  return farms;
}

/**
 * getFieldMaintenance(opts)
 *
 * opts:
 *  - includeArchived (boolean) default false
 *  - status (string) optional (e.g. "needs approved", "pending", "all")
 *  - farmId, fieldId, topicId optional filters
 *  - q (string) search: topic/farm/field/notes/submittedBy
 */
export function getFieldMaintenance(opts = {}){
  const database = getDb();

  const table = firstExistingTable(database, [
    "field_maintenance",
    "fieldMaintenance",
    "fieldmaintenance"
  ]);

  if(!table){
    return {
      ok: true,
      intent: "fieldMaintenance",
      filter: { includeArchived: false },
      counts: { items: 0 },
      byStatus: [],
      byTopic: [],
      byFarm: [],
      items: [],
      note: `No field maintenance table found in snapshot (tried: field_maintenance, fieldMaintenance, fieldmaintenance)`
    };
  }

  const includeArchived = truthy(opts.includeArchived);
  const wantStatus = normStatus(opts.status);
  const wantFarmId = normStr(opts.farmId);
  const wantFieldId = normStr(opts.fieldId);
  const wantTopicId = normStr(opts.topicId);
  const q = normLower(opts.q);

  const wantedCols = [
    "id",
    "status",
    "priority",
    "priorityReason",
    "topicId",
    "topicLabel",
    "farmId",
    "farmName",
    "fieldId",
    "fieldName",
    "notes",
    "photoCount",
    "photoUrls",
    "location",
    "locationLat",
    "locationLng",
    "submittedBy",
    "submittedByName",
    "submittedByEmail",
    "submittedByUid",
    "dateSubmittedISO",
    "updatedAtISO",
    "createdAtISO",
    "dateSubmitted",
    "updatedAt",
    "createdAt"
  ];

  const cols = pickCols(database, table, wantedCols);
  const selectCols = cols.length ? cols.map(c => `"${c}"`).join(", ") : "*";
  const rows = database.prepare(`SELECT ${selectCols} FROM ${table}`).all() || [];

  const activeRows = [];
  const archivedRows = [];

  for(const r of rows){
    r.id = r.id || r.docId || null;
    if(!r.id) continue;

    if(wantFarmId && normStr(r.farmId) !== wantFarmId) continue;
    if(wantFieldId && normStr(r.fieldId) !== wantFieldId) continue;
    if(wantTopicId && normStr(r.topicId) !== wantTopicId) continue;

    const st = normStatus(r.status);
    if(wantStatus && wantStatus !== "all" && st !== wantStatus) continue;

    if(q){
      const submittedByObj = asObj(r.submittedBy);
      const submittedByName =
        normStr(r.submittedByName) ||
        (submittedByObj ? normStr(submittedByObj.name) : "");
      const hay = [
        r.topicLabel, r.farmName, r.fieldName, r.notes, submittedByName
      ].map(normLower).join(" | ");
      if(!hay.includes(q)) continue;
    }

    if(isArchivedStatus(st)) archivedRows.push(r);
    else activeRows.push(r);
  }

  activeRows.sort(sortNewestFirst);
  archivedRows.sort(sortNewestFirst);

  const activeItems = activeRows.map(summarizeRequest);

  const out = {
    ok: true,
    intent: "fieldMaintenance",
    tableUsed: table,
    filter: {
      includeArchived,
      status: wantStatus || null,
      farmId: wantFarmId || null,
      fieldId: wantFieldId || null,
      topicId: wantTopicId || null,
      q: q || null
    },
    counts: { items: activeItems.length },
    byStatus: countByKey(activeItems, it => it.status || "(none)", "status"),
    byTopic: countByKey(activeItems, it => it.topicLabel || "(none)", "topic"),
    byFarm: countByKey(activeItems, it => it.farmName || "(none)", "farm"),
    farms: groupByFarm(activeItems),
    items: activeItems
  };

  if(includeArchived){
    const archItems = archivedRows.map(summarizeRequest);
    out.archived = {
      counts: { items: archItems.length },
      byStatus: countByKey(archItems, it => it.status || "(none)", "status"),
      byTopic: countByKey(archItems, it => it.topicLabel || "(none)", "topic"),
      byFarm: countByKey(archItems, it => it.farmName || "(none)", "farm"),
      farms: groupByFarm(archItems),
      items: archItems
    };
  }

  return out;
}
