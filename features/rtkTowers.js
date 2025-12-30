// /features/rtkTowers.js  (FULL FILE)
// Rev: 2025-12-30-rtk-fields-join (Adds: "what fields use <tower> rtk tower"; human output; no Try:)

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

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function towerLabel(t) {
  return safeStr(t.name).trim() || t.id || "RTK Tower";
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtFreq(v) {
  const n = toNum(v);
  if (n == null) return safeStr(v).trim();
  return n.toFixed(5);
}

function includesAny(hay, list) {
  const t = (hay || "").toString().toLowerCase();
  return (list || []).some(x => t.includes(String(x).toLowerCase()));
}

function pickNeedle(q) {
  // rtk tower <name|id>
  // tower <name|id>
  // rtk <name|id>
  let m =
    /^rtk\s+tower\s+(.+)$/i.exec(q) ||
    /^tower\s+(.+)$/i.exec(q) ||
    /^rtk\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function parseNetwork(q) {
  const m = /\b(network)\s+(\d{1,6})\b/i.exec(q);
  return m ? Number(m[2]) : null;
}

function parseFreq(q) {
  const m = /\b(freq|frequency)\s+([0-9]+(?:\.[0-9]+)?)\b/i.exec(q);
  return m ? String(m[2]) : "";
}

function buildFarmNameMap(colsRoot){
  const farms = colAsArray(colsRoot, "farms");
  const map = new Map();
  for (const f of farms) {
    const id = safeStr(f.id).trim();
    const name = safeStr(f.name).trim();
    if (id) map.set(id, name || id);
  }
  return map;
}

function fmtAcres(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n % 1 === 0) return String(n);
  return n.toFixed(2);
}

function fieldDisplayName(f, farmNameMap){
  const name = safeStr(f.name || f.fieldName || f.label || f.title).trim();
  const num  = safeStr(f.fieldNumber || f.number).trim();
  const id   = safeStr(f.id || f.fieldId || f.docId).trim();

  const farmId = safeStr(f.farmId).trim();
  const farmName = farmId && farmNameMap && farmNameMap.has(farmId) ? farmNameMap.get(farmId) : safeStr(f.farmName).trim();

  const base = name || (num ? `Field ${num}` : id ? id : "Field");
  return farmName ? `${base} (${farmName})` : base;
}

// --- NEW: parse tower name from natural question like:
// "what fields use the carlinville rtk tower"
function extractTowerNeedleFromFieldsQuery(raw){
  const q = (raw || "").toString().trim();
  const qn = norm(q);

  // Common exact forms
  let m =
    /rtk\s+tower\s+(.+)$/i.exec(q) ||                   // "... rtk tower Carlinville"
    /tower\s+(.+)\s+rtk\b/i.exec(q) ||                  // "... tower Carlinville rtk"
    /(?:the\s+)?(.+?)\s+rtk\s+tower\b/i.exec(q);        // "the Carlinville rtk tower"
  if (m && m[1]) return stripQuotes(m[1]);

  // Heuristic: remove filler words and keep the remaining as the tower name
  // Example: "what fields use the carlinville rtk tower" -> "carlinville"
  if (qn.includes("rtk") && qn.includes("tower") && (qn.includes("field") || qn.includes("fields"))) {
    let t = q
      .replace(/\?/g, " ")
      .replace(/\bwhat\b/ig, " ")
      .replace(/\bwhich\b/ig, " ")
      .replace(/\bfields?\b/ig, " ")
      .replace(/\buse\b/ig, " ")
      .replace(/\busing\b/ig, " ")
      .replace(/\bon\b/ig, " ")
      .replace(/\bthe\b/ig, " ")
      .replace(/\brtk\b/ig, " ")
      .replace(/\btower\b/ig, " ")
      .replace(/\s+/g, " ")
      .trim();
    t = stripQuotes(t);
    if (t.length >= 2) return t;
  }

  return "";
}

function resolveTower(towers, needle){
  const n = stripQuotes(needle || "");
  if (!n) return null;

  // id exact
  const byId = towers.find(t => t.id === n) || null;
  if (byId) return byId;

  const nn = norm(n);

  // name exact then contains
  const byNameExact = towers.find(t => norm(towerLabel(t)) === nn) || null;
  if (byNameExact) return byNameExact;

  const byNameContains = towers.find(t => norm(towerLabel(t)).includes(nn)) || null;
  if (byNameContains) return byNameContains;

  return null;
}

export function canHandleRtkTowers(question) {
  const q = norm(question);
  if (!q) return false;

  // Original commands
  if (q === "rtk" || q === "rtk towers" || q === "towers" || q === "rtk tower") return true;
  if (q.startsWith("rtk")) return true;
  if (q.startsWith("rtk tower")) return true;

  // ✅ IMPORTANT: allow natural sentences with "rtk" in the middle
  if (q.includes("rtk") && (q.includes("tower") || q.includes("towers") || q.includes("fields"))) return true;

  // network/frequency
  if (q.includes("rtk") && (q.includes("network") || q.includes("freq") || q.includes("frequency"))) return true;

  return false;
}

export function answerRtkTowers({ question, snapshot, intent }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const towers = colAsArray(colsRoot, "rtkTowers").map((t) => ({
    ...t,
    __createdMs: parseTime(t.createdAt) || null,
    __updatedMs: parseTime(t.updatedAt) || null
  }));

  if (!towers.length) return { answer: "No RTK towers were found in the snapshot.", meta: { snapshotId } };

  // -----------------------------
  // NEW: Fields using a tower
  // -----------------------------
  const askingFields =
    (qn.includes("field") || qn.includes("fields")) &&
    qn.includes("rtk") &&
    qn.includes("tower");

  if (askingFields || (intent && intent.mode === "fields")) {
    const towerNeedle =
      extractTowerNeedleFromFieldsQuery(q) ||
      (intent && intent.args && intent.args.tower ? String(intent.args.tower) : "");

    const tower = resolveTower(towers, towerNeedle);
    if (!tower) {
      return {
        answer: `I couldn’t find an RTK tower matching “${towerNeedle || "that"}”.`,
        meta: { snapshotId, towerNeedle: towerNeedle || "" }
      };
    }

    // fields are in Firefoo collections
    const fields = colAsArray(colsRoot, "fields");
    const farmNameMap = buildFarmNameMap(colsRoot);

    // Fields reference tower by rtkTowerId (common FarmVista pattern)
    const list = fields.filter(f => safeStr(f.rtkTowerId).trim() === safeStr(tower.id).trim());

    if (!list.length) {
      return {
        answer: `No fields are currently assigned to the ${towerLabel(tower)} RTK tower.`,
        meta: { snapshotId, towerId: tower.id, fields: 0 }
      };
    }

    // sort: farm then name
    list.sort((a,b)=> fieldDisplayName(a, farmNameMap).localeCompare(fieldDisplayName(b, farmNameMap)));

    const lines = list.slice(0, 60).map(f => {
      const label = fieldDisplayName(f, farmNameMap);
      const acres = fmtAcres(f.tillable ?? f.tillableAcres ?? f.acres ?? f.areaAcres ?? null);
      return `• ${label}${acres ? ` — ${acres} ac` : ""}`;
    });

    const extra = list.length > 60 ? `\n\n(Showing first 60 of ${list.length})` : "";

    return {
      answer:
        `Fields using ${towerLabel(tower)} RTK tower (${list.length}):\n\n` +
        lines.join("\n") +
        extra,
      meta: { snapshotId, towerId: tower.id, towerName: towerLabel(tower), fields: list.length }
    };
  }

  // -----------------------------
  // list/summary
  // -----------------------------
  if (qn === "rtk" || qn === "rtk towers" || qn === "towers" || qn === "rtk summary") {
    const byNet = new Map();
    for (const t of towers) {
      const nid = t.networkId != null ? String(t.networkId) : "unknown";
      byNet.set(nid, (byNet.get(nid) || 0) + 1);
    }
    const nets = Array.from(byNet.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const netLine = nets.map(([id, n]) => `${id}: ${n}`).join(" • ");

    const lines = towers
      .slice()
      .sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)))
      .slice(0, 30)
      .map((t) => {
        const bits = [];
        if (t.networkId != null) bits.push(`net ${t.networkId}`);
        if (t.frequencyMHz != null) bits.push(`${fmtFreq(t.frequencyMHz)} MHz`);
        return `• ${towerLabel(t)} (${t.id}) — ${bits.join(" • ")}`;
      });

    return {
      answer:
        `RTK towers:\n` +
        `• towers: ${towers.length}\n` +
        (netLine ? `• networks: ${netLine}\n` : "") +
        `\n` +
        lines.join("\n") +
        (towers.length > 30 ? `\n\n(Showing first 30)` : ""),
      meta: { snapshotId, towers: towers.length, networks: nets.length }
    };
  }

  // filter: network
  const networkId = parseNetwork(q);
  if (networkId != null) {
    const list = towers
      .filter((t) => Number(t.networkId) === networkId)
      .sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)));
    const lines = list.map((t) => `• ${towerLabel(t)} (${t.id}) — ${fmtFreq(t.frequencyMHz)} MHz`);
    return {
      answer:
        `RTK towers — network ${networkId}: ${list.length}\n\n` +
        (lines.length ? lines.join("\n") : "No towers found for that network."),
      meta: { snapshotId, networkId, matching: list.length }
    };
  }

  // filter: frequency
  const freq = parseFreq(q);
  if (freq) {
    const fn = norm(freq);
    const list = towers
      .filter((t) => norm(safeStr(t.frequencyMHz)).includes(fn))
      .sort((a, b) => towerLabel(a).localeCompare(towerLabel(b)));
    const lines = list.map((t) => `• ${towerLabel(t)} (${t.id}) — net ${t.networkId} • ${fmtFreq(t.frequencyMHz)} MHz`);
    return {
      answer:
        `RTK towers — frequency ~${freq}: ${list.length}\n\n` +
        (lines.length ? lines.join("\n") : "No towers found matching that frequency."),
      meta: { snapshotId, freq, matching: list.length }
    };
  }

  // detail lookup: "rtk tower <name>" or "rtk <name>"
  const needle = pickNeedle(q);
  if (needle && !includesAny(qn, ["network", "freq", "frequency", "towers"])) {
    const t = resolveTower(towers, needle);
    if (!t) return { answer: `No RTK tower found for "${needle}".`, meta: { snapshotId } };

    const lines = [];
    lines.push(`RTK Tower: ${towerLabel(t)} (${t.id})`);
    if (t.networkId != null) lines.push(`• networkId: ${t.networkId}`);
    if (t.frequencyMHz != null) lines.push(`• frequency: ${fmtFreq(t.frequencyMHz)} MHz`);
    if (t.uid) lines.push(`• uid: ${t.uid}`);
    if (t.t != null) lines.push(`• t: ${safeStr(t.t)}`);

    const created = fmtDateTime(t.__createdMs);
    const updated = fmtDateTime(t.__updatedMs);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    return { answer: lines.join("\n"), meta: { snapshotId, towerId: t.id, networkId: t.networkId } };
  }

  return {
    answer:
      `I can list RTK towers, show towers by network/frequency, or list fields using a specific tower.\n` +
      `For example: “rtk towers”, “rtk network 4010”, or “what fields use the Carlinville rtk tower”.`,
    meta: { snapshotId }
  };
}

