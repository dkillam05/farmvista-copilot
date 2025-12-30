// /features/fields.js  (FULL FILE)
// Rev: 2025-12-30-fields-firefoo-root (Use Firefoo __collections__.fields directly; fix acres=tillable; join farmId->farmName; no CLI Try: menus)

const norm = (s) => (s || "").toString().trim().toLowerCase();
const isNum = (s) => /^[0-9]+$/.test((s || "").toString().trim());

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") {
      return obj[k];
    }
  }
  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtAcres(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function safeStr(v){ return (v == null) ? "" : String(v); }

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

function fieldDisplayName(f, farmNameMap) {
  const name = pick(f, ["name", "fieldName", "label", "title"]) || "";
  const id = pick(f, ["id", "fieldId", "docId"]) || f.id || "";
  const num = pick(f, ["fieldNumber", "number"]) || "";

  const farmId = safeStr(pick(f, ["farmId"])).trim();
  const farmName =
    safeStr(pick(f, ["farmName", "farm", "farmLabel"])).trim() ||
    (farmId && farmNameMap && farmNameMap.has(farmId) ? farmNameMap.get(farmId) : "");

  const base = name || (num ? `Field ${num}` : id ? String(id) : "Field");
  return farmName ? `${base} (${farmName})` : base;
}

function summarizeFieldDetailed(f, farmNameMap) {
  const out = {};
  const farmId = safeStr(pick(f, ["farmId"])).trim();
  const farmName =
    safeStr(pick(f, ["farmName", "farm", "farmLabel"])).trim() ||
    (farmId && farmNameMap && farmNameMap.has(farmId) ? farmNameMap.get(farmId) : "");

  out.id = pick(f, ["id", "fieldId", "docId"]) || f.id;
  out.name = pick(f, ["name", "fieldName", "label", "title"]);
  out.farm = farmName || null;
  out.farmId = farmId || null;

  // ✅ IMPORTANT: your snapshot uses "tillable" for acres
  out.acres = fmtAcres(pick(f, ["tillable", "tillableAcres", "acres", "areaAcres", "acresTillable", "area"]));

  out.county = pick(f, ["county"]);
  out.state = pick(f, ["state"]);
  out.status = pick(f, ["status"]);

  out.rtkTowerId = pick(f, ["rtkTowerId"]);
  out.hasHEL = pick(f, ["hasHEL"]);
  out.helAcres = fmtAcres(pick(f, ["helAcres"]));
  out.hasCRP = pick(f, ["hasCRP"]);
  out.crpAcres = fmtAcres(pick(f, ["crpAcres"]));

  for (const k of Object.keys(out)) {
    if (out[k] == null || out[k] === "") delete out[k];
  }
  return out;
}

function formatBullets(obj) {
  return Object.entries(obj || {}).map(([k, v]) => `• ${k}: ${v}`).join("\n");
}

function findField(fields, needleRaw, farmNameMap) {
  const needle = (needleRaw || "").trim();
  const n = norm(needle);
  if (!n) return null;

  // numeric match: fieldNumber OR id
  if (isNum(needle)) {
    return (
      fields.find(f => String(pick(f, ["fieldNumber", "number"]) || "").trim() === needle) ||
      fields.find(f => String((pick(f, ["id", "fieldId", "docId"]) || f.id || "")).trim() === needle) ||
      null
    );
  }

  // name match
  return (
    fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])) === n) ||
    fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])).includes(n)) ||
    fields.find(f => norm(fieldDisplayName(f, farmNameMap)).includes(n)) ||
    null
  );
}

function wantsList(qn) {
  if (!qn) return false;
  return (
    qn === "fields" ||
    qn === "field list" ||
    qn === "fields list" ||
    qn === "list fields" ||
    qn === "show fields" ||
    qn === "show me fields" ||
    qn === "show all fields" ||
    qn === "all fields"
  );
}

export function canHandleFields(question) {
  const q = norm(question);
  if (!q) return false;

  if (wantsList(q)) return true;
  if (q === "debug fields" || q === "fields debug") return true;

  if (/^(field|show field|open field)\s*[:#]?\s*.+$/i.test(question)) return true;

  return false;
}

export function answerFields({ question, snapshot, intent }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) {
    return {
      answer: "Snapshot is not available right now.",
      meta: { snapshotId, snapshotError: snapshot?.lastError || null }
    };
  }

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) {
    return {
      answer: "I can’t find Firefoo collections in this snapshot.",
      meta: { snapshotId }
    };
  }

  // ✅ Authoritative: use Firefoo collection directly
  const fields = colAsArray(colsRoot, "fields");
  const farmNameMap = buildFarmNameMap(colsRoot);

  const debugRequested = (qn === "debug fields" || qn === "fields debug");
  if (debugRequested) {
    const keys = Object.keys(colsRoot);
    return {
      answer:
        `Fields diagnostic:\n` +
        `• collectionsRoot: YES\n` +
        `• fields collection: ${fields.length}\n` +
        `• collections keys (first 25): ${keys.slice(0, 25).join(", ")}${keys.length > 25 ? " …" : ""}`,
      meta: { snapshotId, fieldsCount: fields.length, diagnostic: true, keys: keys.slice(0, 50) }
    };
  }

  // List
  if (wantsList(qn) || (intent && intent.topic === "fields" && intent.mode === "list")) {
    if (!fields.length) {
      return {
        answer: "No fields were found in the snapshot.",
        meta: { snapshotId, fieldsCount: 0 }
      };
    }

    const shownMax = 50;
    const lines = fields.slice(0, shownMax).map((f, i) => {
      const name = fieldDisplayName(f, farmNameMap);
      const acres = fmtAcres(pick(f, ["tillable", "tillableAcres", "acres", "areaAcres", "acresTillable", "area"]));
      const bits = [];
      if (acres) bits.push(`${acres} ac`);
      return `${i + 1}. ${name}${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
    });

    const n = fields.length;
    const noun = (n === 1) ? "field" : "fields";

    return {
      answer:
        `You have ${n} ${noun}.\n\n` +
        lines.join("\n") +
        (n > shownMax ? `\n\n(Showing first ${shownMax}. Ask “field <name>” for details.)` : ""),
      meta: { snapshotId, fieldsCount: n }
    };
  }

  // Detail
  const m =
    /^field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^show\s+field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^open\s+field\s*[:#]?\s*(.+)$/i.exec(q);

  if (m) {
    if (!fields.length) {
      return {
        answer: "No fields were found in the snapshot.",
        meta: { snapshotId, fieldsCount: 0 }
      };
    }

    const needle = (m[1] || "").trim();
    const found = findField(fields, needle, farmNameMap);

    if (!found) {
      const sample = fields.slice(0, 12).map(f => `• ${fieldDisplayName(f, farmNameMap)}`).join("\n");
      return {
        answer:
          `I couldn’t find a field matching “${needle}”.\n\n` +
          `Here are a few field names to pick from:\n${sample}`,
        meta: { snapshotId, needle, fieldsCount: fields.length }
      };
    }

    const detail = summarizeFieldDetailed(found, farmNameMap);
    return {
      answer: `Field details:\n${formatBullets(detail)}`,
      meta: { snapshotId, needle }
    };
  }

  return {
    answer:
      `I can list your fields or open a specific field.\n` +
      `For example: “show all fields” or “field 0513”.`,
    meta: { snapshotId }
  };
}
