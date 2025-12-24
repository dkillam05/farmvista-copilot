const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colObj(colsRoot, name){
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return null;
  return colsRoot[name];
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

function includesAny(hay, needles){
  const h = norm(hay);
  return needles.some(n => h.includes(norm(n)));
}

function buildSimpleSearchKey(t){
  // A single searchable blob
  return [
    t.trialName,
    t.trialType,
    t.crop,
    t.cropYear,
    t.operationTask,
    t.status,
    t.treatmentProduct,
    t.check,
    t.notes
  ].map(safeStr).join(" • ").toLowerCase();
}

function detectNestedKeys(trial){
  const keys = ["yieldBlocks", "attachments", "checks", "trials", "trialRuns", "events", "photos", "maps", "notesLog"];
  const out = {};
  for (const k of keys) {
    const v = trial[k];
    if (Array.isArray(v)) out[k] = v.length;
    else if (v && typeof v === "object") out[k] = Object.keys(v).length;
  }
  return out;
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
    const prod = safeStr(t.treatmentProduct).trim();

    const bits = [];
    if (type) bits.push(type);
    if (crop || year) bits.push([crop, year].filter(Boolean).join(" "));
    if (status) bits.push(status);
    if (prod) bits.push(prod);
    if (upd) bits.push(`updated ${upd}`);

    return `• ${name}${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
  });

  return lines.join("\n") + (list.length > limit ? `\n\n(Showing ${limit} of ${list.length})` : "");
}

// ----------------------------
// Public API
// ----------------------------
export function canHandleFieldTrials(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "trials" || q === "field trials" || q === "trial" || q === "trials summary") return true;
  if (q.startsWith("trials ")) return true;
  if (q.startsWith("trial ")) return true;
  return false;
}

export function answerFieldTrials({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const trialsArr = colAsArray(colsRoot, "fieldTrials");
  if (!trialsArr.length) return { answer: "No fieldTrials records found in the snapshot.", meta: { snapshotId } };

  const trials = trialsArr.map(t => ({
    ...t,
    __createdMs: parseTime(t.createdAt),
    __updatedMs: parseTime(t.updatedAt),
    __search: buildSimpleSearchKey(t)
  }));

  // SUMMARY
  if (qn === "trials" || qn === "field trials" || qn === "trials summary") {
    const total = trials.length;
    const byStatus = new Map();
    const byYear = new Map();
    const byCrop = new Map();
    const byType = new Map();

    for (const t of trials) {
      const s = (t.status || "unknown").toString();
      const y = (t.cropYear != null ? String(t.cropYear) : "unknown");
      const c = (t.crop || "unknown").toString();
      const tp = (t.trialType || "unknown").toString();

      byStatus.set(s, (byStatus.get(s) || 0) + 1);
      byYear.set(y, (byYear.get(y) || 0) + 1);
      byCrop.set(c, (byCrop.get(c) || 0) + 1);
      byType.set(tp, (byType.get(tp) || 0) + 1);
    }

    const top5 = (m) => [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}: ${v}`).join(", ");

    return {
      answer:
        `Field Trials summary (snapshot ${snapshotId}):\n` +
        `• Total trials: ${total}\n` +
        `• By status: ${top5(byStatus)}\n` +
        `• By year: ${top5(byYear)}\n` +
        `• By crop: ${top5(byCrop)}\n` +
        `• By type: ${top5(byType)}\n\n` +
        `Try:\n` +
        `• "trials status completed"\n` +
        `• "trials year 2025"\n` +
        `• "trials crop soybeans"\n` +
        `• "trials type fungicides"\n` +
        `• "trials product Butler Mix"\n` +
        `• "trial soybean fungicide $50"`,
      meta: { snapshotId, trialsCount: total }
    };
  }

  // FILTERS: trials status / year / crop / type / product / name
  let m =
    /^trials\s+status\s+(.+)$/i.exec(q) ||
    /^trials\s+year\s+([0-9]{4})$/i.exec(q) ||
    /^trials\s+crop\s+(.+)$/i.exec(q) ||
    /^trials\s+type\s+(.+)$/i.exec(q) ||
    /^trials\s+product\s+(.+)$/i.exec(q) ||
    /^trials\s+name\s+(.+)$/i.exec(q);

  if (m) {
    // determine which matched by checking prefix
    const lower = qn;

    let list = trials;
    let label = "";

    if (lower.startsWith("trials status ")) {
      const val = q.slice("trials status ".length).trim();
      label = `status "${val}"`;
      list = trials.filter(t => norm(t.status) === norm(val));
    } else if (lower.startsWith("trials year ")) {
      const val = q.slice("trials year ".length).trim();
      label = `year ${val}`;
      list = trials.filter(t => String(t.cropYear) === val);
    } else if (lower.startsWith("trials crop ")) {
      const val = q.slice("trials crop ".length).trim();
      label = `crop "${val}"`;
      list = trials.filter(t => norm(t.crop) === norm(val));
    } else if (lower.startsWith("trials type ")) {
      const val = q.slice("trials type ".length).trim();
      label = `type "${val}"`;
      list = trials.filter(t => norm(t.trialType).includes(norm(val)));
    } else if (lower.startsWith("trials product ")) {
      const val = q.slice("trials product ".length).trim();
      label = `product "${val}"`;
      list = trials.filter(t => norm(t.treatmentProduct).includes(norm(val)));
    } else if (lower.startsWith("trials name ")) {
      const val = q.slice("trials name ".length).trim();
      label = `name contains "${val}"`;
      list = trials.filter(t => norm(t.trialName).includes(norm(val)));
    }

    return {
      answer: `Trials for ${label} (${list.length}):\n\n` + (list.length ? summarizeList(list, 40) : "• none"),
      meta: { snapshotId, filter: label, count: list.length }
    };
  }

  // TRIAL lookup by: ID OR name-ish search
  m = /^trial\s+(.+)\s*$/i.exec(q);
  if (m) {
    let needle = (m[1] || "").trim();
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }
    const needleN = norm(needle);

    // 1) exact id
    let found = trials.find(t => t.id === needle) || null;

    // 2) exact trialName
    if (!found) found = trials.find(t => norm(t.trialName) === needleN) || null;

    // 3) contains in name/type/product/notes
    if (!found) found = trials.find(t => t.__search.includes(needleN)) || null;

    if (!found) {
      return {
        answer:
          `I couldn’t find a trial matching "${needle}".\n\n` +
          `Try:\n• trial "<full trial name>"\n• trials name ${needle}\n• trials product ${needle}\n• trials type ${needle}`,
        meta: { snapshotId }
      };
    }

    const created = fmtDate(found.__createdMs);
    const updated = fmtDate(found.__updatedMs);
    const nested = detectNestedKeys(found);

    const lines = [];
    lines.push(`Trial: ${safeStr(found.trialName).trim() || "(No name)"}`);
    lines.push(`• id: ${found.id}`);
    if (found.trialType) lines.push(`• type: ${found.trialType}`);
    if (found.crop || found.cropYear) lines.push(`• crop: ${[found.crop, found.cropYear].filter(Boolean).join(" ")}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.operationTask) lines.push(`• task: ${found.operationTask}`);
    if (found.treatmentProduct) lines.push(`• treatmentProduct: ${found.treatmentProduct}`);
    if (found.check) lines.push(`• check: ${found.check}`);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);
    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    const nk = Object.keys(nested);
    if (nk.length) {
      lines.push(`• nested: ${nk.map(k => `${k}(${nested[k]})`).join(", ")}`);
    }

    return { answer: lines.join("\n"), meta: { snapshotId, trialId: found.id } };
  }

  return {
    answer:
      `Try:\n` +
      `• "trials summary"\n` +
      `• "trials status completed"\n` +
      `• "trials year 2025"\n` +
      `• "trials crop soybeans"\n` +
      `• "trials type fungicides"\n` +
      `• "trials product Butler Mix"\n` +
      `• trial "Soybean Fungicide $50 Program"`,
    meta: { snapshotId }
  };
}
