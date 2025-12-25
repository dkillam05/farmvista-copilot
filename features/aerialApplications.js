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

function fmtAcres(v){
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function safeStr(v){ return (v == null) ? "" : String(v); }

function summarizeOne(a){
  const job = (a.jobNumber != null) ? `Job ${a.jobNumber}` : `Job (unknown)`;
  const status = safeStr(a.status).trim() || "Unknown";
  const crop = safeStr(a.crop).trim();
  const year = a.year ?? a.cropYear ?? a.cropYear;
  const releaseDate = safeStr(a.releaseDate).trim();
  const relAc = fmtAcres(a.releaseAcres);
  const totalAc = fmtAcres(a.totalTillableAcres);

  const fields = Array.isArray(a.fields) ? a.fields : [];
  const fieldNames = fields
    .map(f => safeStr(f.field || f.fieldName || f.name).trim())
    .filter(Boolean);

  const trialId = a.trialLink && a.trialLink.enabled ? safeStr(a.trialLink.trialId).trim() : "";

  const bits = [];
  if (crop || year) bits.push([crop, year].filter(Boolean).join(" "));
  if (releaseDate) bits.push(`release ${releaseDate}`);
  if (relAc) bits.push(`${relAc} rel ac`);
  if (totalAc) bits.push(`${totalAc} tillable ac`);
  if (trialId) bits.push(`trial ${trialId}`);

  const fieldBit = fieldNames.length
    ? `fields: ${fieldNames.slice(0, 3).join(", ")}${fieldNames.length > 3 ? ` (+${fieldNames.length - 3})` : ""}`
    : "";

  return `• ${job} — ${status}${bits.length ? ` • ${bits.join(" • ")}` : ""}${fieldBit ? ` • ${fieldBit}` : ""}`;
}

function filterByStatus(list, status){
  const s = norm(status);
  return list.filter(a => norm(a.status) === s);
}

export function canHandleAerialApplications(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "aerial" || q === "aerial summary" || q === "aerial applications") return true;
  if (q.startsWith("aerial ")) return true;
  if (q.startsWith("aerial_app")) return true;
  if (q.includes("aerial application")) return true;
  return false;
}

export function answerAerialApplications({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  // Collection name per your request: aerial_applications
  const apps = colAsArray(colsRoot, "aerial_applications").map(a => ({
    ...a,
    __createdMs: parseTime(a.createdAt) || parseTime(a.timestampISO) || null,
    __updatedMs: parseTime(a.updatedAt) || null
  }));

  if (!apps.length) {
    return { answer: "No aerial_applications records found in the snapshot.", meta: { snapshotId } };
  }

  // SUMMARY
  if (qn === "aerial" || qn === "aerial summary" || qn === "aerial applications") {
    const total = apps.length;
    const open = filterByStatus(apps, "open").length;
    const closed = filterByStatus(apps, "closed").length;

    const years = new Map();
    for (const a of apps) {
      const y = (a.year ?? a.cropYear ?? "Unknown").toString();
      years.set(y, (years.get(y) || 0) + 1);
    }
    const topYears = [...years.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 6).map(([y,c])=>`${y}: ${c}`).join(", ");

    return {
      answer:
        `Aerial Applications summary (snapshot ${snapshotId}):\n` +
        `• Total: ${total}\n` +
        `• Open: ${open}\n` +
        `• Closed: ${closed}\n` +
        `• By year: ${topYears}\n\n` +
        `Try:\n` +
        `• "aerial open"\n` +
        `• "aerial year 2026"\n` +
        `• "aerial job 1515"\n` +
        `• "aerial for 0324-Calvary W"\n` +
        `• "aerial trial <trialId>"`,
      meta: { snapshotId, total, open, closed }
    };
  }

  // aerial open / closed
  let m = /^aerial\s+(open|closed)\s*$/i.exec(q);
  if (m) {
    const st = m[1];
    const list = filterByStatus(apps, st);
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);
    return {
      answer: `Aerial ${st} (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, status: st, count: list.length }
    };
  }

  // aerial year 2026
  m = /^aerial\s+year\s+([0-9]{4})\s*$/i.exec(q);
  if (m) {
    const year = m[1];
    const list = apps.filter(a => String(a.year ?? a.cropYear ?? "") === year);
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);
    return {
      answer: `Aerial applications for year ${year} (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, year, count: list.length }
    };
  }

  // aerial job 1515
  m = /^aerial\s+job\s+([0-9]+)\s*$/i.exec(q);
  if (m) {
    const job = Number(m[1]);
    const found = apps.find(a => Number(a.jobNumber) === job) || null;
    if (!found) return { answer: `No aerial job found for ${job}.`, meta: { snapshotId } };

    const lines = [];
    lines.push(`Aerial Job ${found.jobNumber} (${found.id})`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.crop || found.year || found.cropYear) lines.push(`• crop: ${[found.crop, (found.year ?? found.cropYear)].filter(Boolean).join(" ")}`);
    if (found.releaseDate) lines.push(`• releaseDate: ${found.releaseDate}`);
    if (found.releaseAcres != null) lines.push(`• releaseAcres: ${fmtAcres(found.releaseAcres)}`);
    if (found.totalTillableAcres != null) lines.push(`• totalTillableAcres: ${fmtAcres(found.totalTillableAcres)}`);
    if (found.submittedBy) lines.push(`• submittedBy: ${found.submittedBy}`);
    if (found.submittedByEmail) lines.push(`• submittedByEmail: ${found.submittedByEmail}`);
    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    if (found.trialLink && found.trialLink.enabled) {
      lines.push(`• trialLink: enabled`);
      if (found.trialLink.trialId) lines.push(`  - trialId: ${found.trialLink.trialId}`);
      if (Array.isArray(found.trialLink.assignFieldIds) && found.trialLink.assignFieldIds.length) {
        lines.push(`  - assignFieldIds: ${found.trialLink.assignFieldIds.join(", ")}`);
      }
    }

    const fields = Array.isArray(found.fields) ? found.fields : [];
    if (fields.length) {
      lines.push(`• fields (${fields.length}):`);
      for (const f of fields) {
        const nm = safeStr(f.field).trim() || safeStr(f.fieldId).trim() || "(field)";
        const ac = fmtAcres(f.tillableAcres);
        lines.push(`  - ${nm}${ac ? ` — ${ac} ac` : ""}${f.fieldId ? ` (${f.fieldId})` : ""}`);
      }
    }

    return { answer: lines.join("\n"), meta: { snapshotId, jobNumber: job } };
  }

  // aerial trial <trialId>
  m = /^aerial\s+trial\s+(.+)\s*$/i.exec(q);
  if (m) {
    const trialId = m[1].trim();
    const list = apps.filter(a => a.trialLink && a.trialLink.enabled && safeStr(a.trialLink.trialId).trim() === trialId);
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);
    return {
      answer: `Aerial applications linked to trial ${trialId} (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, trialId, count: list.length }
    };
  }

  // aerial for <fieldName>
  m = /^aerial\s+for\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = m[1].trim().toLowerCase();
    const list = apps.filter(a => Array.isArray(a.fields) && a.fields.some(f => safeStr(f.field).toLowerCase().includes(needle)));
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Aerial applications for field matching "${m[1].trim()}" (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, fieldMatch: m[1].trim(), count: list.length }
    };
  }

  return {
    answer:
      `Try:\n` +
      `• "aerial summary"\n` +
      `• "aerial open"\n` +
      `• "aerial year 2026"\n` +
      `• "aerial job 1515"\n` +
      `• "aerial for 0324-Calvary W"\n` +
      `• "aerial trial <trialId>"`,
    meta: { snapshotId }
  };
}