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

function fmtInt(n){
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function safeStr(v){ return (v == null) ? "" : String(v); }

function siteLabel(s){
  return safeStr(s.name).trim() || s.id || "Bin Site";
}

function sumOnHand(site){
  const bins = Array.isArray(site.bins) ? site.bins : [];
  let onHand = 0;
  for (const b of bins) onHand += Number(b.onHand) || 0;
  return onHand;
}

function summarizeSiteLine(s){
  const name = siteLabel(s);
  const total = Number(s.totalBushels) || 0;
  const bins = Array.isArray(s.bins) ? s.bins : [];
  const onHand = sumOnHand(s);

  const bits = [];
  bits.push(`${bins.length} bins`);
  if (total) bits.push(`${fmtInt(total)} bu cap`);
  if (onHand) bits.push(`${fmtInt(onHand)} bu onHand`);

  return `• ${name} (${s.id}) — ${bits.join(" • ")}`;
}

export function canHandleBinSites(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "binsites" || q === "bin sites" || q === "bin site" || q === "binsites summary") return true;
  if (q.startsWith("binsites")) return true;
  if (q.startsWith("bin site")) return true;
  if (q.startsWith("bins site")) return true; // allow shorthand
  return false;
}

export function answerBinSites({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const sites = colAsArray(colsRoot, "binSites").map(s => ({
    ...s,
    __createdMs: parseTime(s.createdAt) || null,
    __updatedMs: parseTime(s.updatedAt) || null
  }));

  if (!sites.length) return { answer: "No binSites records found in the snapshot.", meta: { snapshotId } };

  // binsites summary
  if (qn === "binsites" || qn === "bin sites" || qn === "binsites summary") {
    let totalCap = 0;
    let totalOnHand = 0;
    let totalBins = 0;

    for (const s of sites) {
      totalCap += Number(s.totalBushels) || 0;
      totalOnHand += sumOnHand(s);
      totalBins += Array.isArray(s.bins) ? s.bins.length : 0;
    }

    const lines = sites
      .slice()
      .sort((a,b)=> siteLabel(a).localeCompare(siteLabel(b)))
      .slice(0, 30)
      .map(summarizeSiteLine);

    return {
      answer:
        `Bin Sites summary (snapshot ${snapshotId}):\n` +
        `• Sites: ${sites.length}\n` +
        `• Total bins: ${totalBins}\n` +
        `• Total capacity: ${fmtInt(totalCap)} bu\n` +
        `• Total onHand (from binSites): ${fmtInt(totalOnHand)} bu\n\n` +
        lines.join("\n") +
        (sites.length > 30 ? `\n\n(Showing first 30)` : "") +
        `\n\nTry:\n• binsite "FPI Macomb"\n• binsite xbVeuJVFKjOHznnnlfVR`,
      meta: { snapshotId, sites: sites.length, totalBins, totalCap, totalOnHand }
    };
  }

  // binsite <id>  OR  binsite "name"
  let m =
    /^binsite\s+(.+)$/i.exec(q) ||
    /^bin\s+site\s+(.+)$/i.exec(q) ||
    /^bins\s+site\s+(.+)$/i.exec(q);

  if (m) {
    let needle = (m[1] || "").trim();
    if ((needle.startsWith('"') && needle.endsWith('"')) || (needle.startsWith("'") && needle.endsWith("'"))) {
      needle = needle.slice(1, -1).trim();
    }

    const byId = sites.find(s => s.id === needle) || null;
    const nn = norm(needle);
    const byName = sites.find(s => norm(siteLabel(s)).includes(nn)) || null;

    const site = byId || byName;
    if (!site) {
      return { answer: `No bin site found for "${needle}". Try "binsites summary".`, meta: { snapshotId } };
    }

    const bins = Array.isArray(site.bins) ? site.bins : [];
    const created = fmtDate(site.__createdMs);
    const updated = fmtDate(site.__updatedMs);

    const totalCap = Number(site.totalBushels) || 0;
    const onHand = sumOnHand(site);

    const lines = [];
    lines.push(`Bin Site: ${siteLabel(site)} (${site.id})`);
    if (site.status) lines.push(`• status: ${site.status}`);
    if (typeof site.used === "boolean") lines.push(`• used: ${site.used}`);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);
    if (totalCap) lines.push(`• total capacity: ${fmtInt(totalCap)} bu`);
    lines.push(`• bins: ${bins.length}`);
    lines.push(`• onHand (from bins): ${fmtInt(onHand)} bu`);

    if (bins.length) {
      lines.push(`\nBins:`);
      const sorted = bins.slice().sort((a,b)=> (Number(a.num)||0) - (Number(b.num)||0));
      for (const b of sorted) {
        const num = b.num != null ? b.num : "?";
        const cap = Number(b.bushels) || 0;
        const oh = (b.onHand != null) ? Number(b.onHand) : null;

        const crop = safeStr(b.lastCropType).trim();
        const moist = (b.lastCropMoisture != null) ? String(b.lastCropMoisture) : "";
        const who = safeStr(b.lastUpdatedBy).trim();
        const when = (b.lastUpdatedMs != null) ? fmtDate(Number(b.lastUpdatedMs)) : null;

        const bits = [];
        if (cap) bits.push(`${fmtInt(cap)} cap`);
        if (oh != null) bits.push(`${fmtInt(oh)} onHand`);
        if (crop) bits.push(crop + (moist ? ` ${moist}%` : ""));
        if (who) bits.push(who);
        if (when) bits.push(`updated ${when}`);

        lines.push(`• Bin ${num}: ${bits.join(" • ")}`);
      }
    }

    return { answer: lines.join("\n"), meta: { snapshotId, siteId: site.id } };
  }

  return {
    answer:
      `Try:\n` +
      `• binsites summary\n` +
      `• binsite "FPI Macomb"\n` +
      `• binsite xbVeuJVFKjOHznnnlfVR`,
    meta: { snapshotId }
  };
}
