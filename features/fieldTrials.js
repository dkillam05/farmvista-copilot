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

function buildSearchKey(t){
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

function countBy(list, getter){
  const m = new Map();
  for (const x of list) {
    const k = (getter(x) || "Unknown").toString().trim() || "Unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a,b)=> b[1]-a[1]);
}

function topPairs(mEntries, n=5){
  return mEntries.slice(0,n).map(([k,c]) => `${k}: ${c}`).join(", ");
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
    __search: buildSearchKey(t)
  }));

  // ----------------------------
  // NEW: TRIALS COMPARE
  // ----------------------------
  // Commands:
  //  - trials compare <text>
  //  - trial compare <text>
  //  - compare trials <text>
  let mCompare =
    /^trials\s+compare\s+(.+)$/i.exec(q) ||
    /^trial\s+compare\s+(.+)$/i.exec(q) ||
    /^compare\s+trials\s+(.+)$/i.exec(q);

  if (mCompare) {
    let needle = (mCompare[1] || "").trim();
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }
    const n = norm(needle);

    // match by trialName contains first; fallback to full search blob
    let matched = trials.filter(t => norm(t.trialName).includes(n));
    if (!matched.length) matched = trials.filter(t => t.__search.includes(n));

    if (!matched.length) {
      return {
        answer:
          `No trials matched "${needle}".\n\nTry:\n• trials compare fungicide\n• trials compare "Soybean Fungicide"\n• trials name ${needle}`,
        meta: { snapshotId }
      };
    }

    // Group by trialName (this is the “program” bucket)
    const byName = new Map();
    for (const t of matched) {
      const name = safeStr(t.trialName).trim() || "(No name)";
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(t);
    }

    // Sort groups by size desc
    const groups = [...byName.entries()].sort((a,b)=> b[1].length - a[1].length);

    // Keep output tight: top 8 groups
    const showGroups = groups.slice(0, 8);

    const lines = [];
    lines.push(`Trials compare for "${needle}" (matched ${matched.length}):`);

    for (const [name, list] of showGroups) {
      const crops = countBy(list, t => t.crop || "Unknown");
      const years = countBy(list, t => (t.cropYear != null ? String(t.cropYear) : "Unknown"));
      const types = countBy(list, t => t.trialType || "Unknown");
      const status = countBy(list, t => t.status || "Unknown");

      const checks = countBy(list, t => t.check || "Unknown").slice(0, 6);
      const treatments = countBy(list, t => t.treatmentProduct || "Unknown").slice(0, 6);

      lines.push(`\n• ${name}`);
      lines.push(`  - count: ${list.length}`);
      lines.push(`  - crop: ${topPairs(crops, 3)}`);
      lines.push(`  - year: ${topPairs(years, 3)}`);
      lines.push(`  - type: ${topPairs(types, 3)}`);
      lines.push(`  - status: ${topPairs(status, 5)}`);
      lines.push(`  - check options: ${checks.map(([k,c])=>`${k} (${c})`).join(", ")}`);
      lines.push(`  - treatment options: ${treatments.map(([k,c])=>`${k} (${c})`).join(", ")}`);
    }

    if (groups.length > 8) {
      lines.push(`\n(Showing 8 of ${groups.length} trialName groups. Be more specific to narrow it down.)`);
    }

    lines.push(`\nNext: ask "trial \\"<exact trial name>\\"" to see the details for one program.`);
    return { answer: lines.join("\n"), meta: { snapshotId, matched: matched.length, groups: groups.length } };
  }

  // ----------------------------
  // SUMMARY
  // ----------------------------
  if (qn === "trials" || qn === "field trials" || qn === "trials summary") {
    const total = trials.length;

    const byStatus = countBy(trials, t => (t.status || "unknown"));
    const byYear   = countBy(trials, t => (t.cropYear != null ? String(t.cropYear) : "unknown"));
    const byCrop   = countBy(trials, t => (t.crop || "unknown"));
    const byType   = countBy(trials, t => (t.trialType || "unknown"));

    return {
      answer:
        `Field Trials summary (snapshot ${snapshotId}):\n` +
        `• Total trials: ${total}\n` +
        `• By status: ${topPairs(byStatus)}\n` +
        `• By year: ${topPairs(byYear)}\n` +
        `• By crop: ${topPairs(byCrop)}\n` +
        `• By type: ${topPairs(byType)}\n\n` +
        `Try:\n` +
        `• trials compare fungicide\n` +
        `• trials status completed\n` +
        `• trials year 2025\n` +
        `• trials crop soybeans\n` +
        `• trials type fungicides\n` +
        `• trials product Butler Mix\n` +
        `• trial "Soybean Fungicide $50 Program"`,
      meta: { snapshotId, trialsCount: total }
    };
  }

  // ----------------------------
  // FILTERS
  // ----------------------------
  let m =
    /^trials\s+status\s+(.+)$/i.exec(q) ||
    /^trials\s+year\s+([0-9]{4})$/i.exec(q) ||
    /^trials\s+crop\s+(.+)$/i.exec(q) ||
    /^trials\s+type\s+(.+)$/i.exec(q) ||
    /^trials\s+product\s+(.+)$/i.exec(q) ||
    /^trials\s+name\s+(.+)$/i.exec(q);

  if (m) {
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

  // ----------------------------
  // TRIAL lookup by ID or name-ish
  // ----------------------------
  m = /^trial\s+(.+)\s*$/i.exec(q);
  if (m) {
    let needle = (m[1] || "").trim();
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }
    const needleN = norm(needle);

    let found = trials.find(t => t.id === needle) || null;
    if (!found) found = trials.find(t => norm(t.trialName) === needleN) || null;
    if (!found) found = trials.find(t => t.__search.includes(needleN)) || null;

    if (!found) {
      return {
        answer:
          `I couldn’t find a trial matching "${needle}".\n\nTry:\n• trial "<full trial name>"\n• trials name ${needle}\n• trials product ${needle}\n• trials compare ${needle}`,
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
    if (nk.length) lines.push(`• nested: ${nk.map(k => `${k}(${nested[k]})`).join(", ")}`);

    return { answer: lines.join("\n"), meta: { snapshotId, trialId: found.id } };
  }

  return {
    answer:
      `Try:\n` +
      `• trials compare fungicide\n` +
      `• trials summary\n` +
      `• trials status completed\n` +
      `• trials year 2025\n` +
      `• trials crop soybeans\n` +
      `• trials product Butler Mix\n` +
      `• trial "Soybean Fungicide $50 Program"`,
    meta: { snapshotId }
  };
}
