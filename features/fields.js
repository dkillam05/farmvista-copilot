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

export function findFieldsRoot(snapshotJson) {
  const d = snapshotJson || {};
  const candidates = [
    "fields",
    "fieldList",
    "fv_fields",
    "Fields"
  ];
  for (const k of candidates) {
    if (Array.isArray(d[k])) return { key: k, arr: d[k] };
  }

  const nested = [
    ["collections", "fields"],
    ["data", "fields"]
  ];
  for (const [a, b] of nested) {
    if (d[a] && Array.isArray(d[a][b])) return { key: `${a}.${b}`, arr: d[a][b] };
  }

  return { key: null, arr: [] };
}

function fieldDisplayName(f) {
  const name = pick(f, ["name", "fieldName", "label", "title"]) || "";
  const farm = pick(f, ["farmName", "farm", "farmLabel"]) || "";
  const id = pick(f, ["id", "fieldId", "docId"]) || "";
  const num = pick(f, ["fieldNumber", "number"]) || "";
  const base = name || (num ? `Field ${num}` : id ? String(id) : "Field");
  return farm ? `${base} (${farm})` : base;
}

function summarizeFieldDetailed(f) {
  const out = {};
  out.id = pick(f, ["id", "fieldId", "docId"]);
  out.name = pick(f, ["name", "fieldName", "label", "title"]);
  out.farm = pick(f, ["farmName", "farm", "farmLabel"]);
  out.acres = fmtAcres(pick(f, ["acres", "areaAcres", "tillableAcres", "acresTillable", "area"]));
  out.county = pick(f, ["county"]);
  out.state = pick(f, ["state"]);

  out.lat = pick(f, ["lat", "latitude", "centerLat"]);
  out.lon = pick(f, ["lon", "lng", "longitude", "centerLon", "centerLng"]);

  out.fsaFarm = pick(f, ["fsaFarm", "fsaFarmNumber", "farmNumber"]);
  out.tract = pick(f, ["tract", "tractNumber"]);
  out.fsaField = pick(f, ["fsaField", "fsaFieldNumber", "fieldNumber"]);

  out.boundaryId = pick(f, ["boundaryId", "boundary", "shapeId", "polygonId"]);
  out.soil = pick(f, ["soilType", "soil", "soilClass"]);
  out.notes = pick(f, ["notes", "note"]);

  for (const k of Object.keys(out)) {
    if (out[k] == null || out[k] === "") delete out[k];
  }
  return out;
}

function formatBullets(obj) {
  return Object.entries(obj || {}).map(([k, v]) => `• ${k}: ${v}`).join("\n");
}

function findField(fields, needleRaw) {
  const needle = (needleRaw || "").trim();
  const n = norm(needle);
  if (!n) return null;

  if (isNum(needle)) {
    return (
      fields.find(f => String(pick(f, ["fieldNumber", "number"]) || "").trim() === needle) ||
      fields.find(f => String(pick(f, ["id", "fieldId", "docId"]) || "").trim() === needle) ||
      null
    );
  }

  return (
    fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])) === n) ||
    fields.find(f => norm(pick(f, ["name", "fieldName", "label", "title"])).includes(n)) ||
    fields.find(f => norm(fieldDisplayName(f)).includes(n)) ||
    null
  );
}

export function canHandleFields(question) {
  const q = norm(question);
  if (!q) return false;
  if (["fields", "list fields", "show fields", "field list", "debug fields"].includes(q)) return true;
  if (/^(field|show field|open field)\s*[:#]?\s*.+$/i.test(question)) return true;
  return false;
}

export function answerFields({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  if (!json) {
    return {
      answer: "Snapshot is not available right now.",
      meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", snapshotError: snapshot?.lastError || null }
    };
  }

  const { key: fieldsKey, arr: fields } = findFieldsRoot(json);
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (qn === "debug fields") {
    return {
      answer: `Fields source: ${fieldsKey || "(not found)"} — count: ${fields.length}`,
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
    };
  }

  if (["fields", "list fields", "show fields", "field list"].includes(qn)) {
    if (!fields.length) {
      return {
        answer: "I can’t find a fields list in the current snapshot. Try “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0 }
      };
    }

    const lines = fields.slice(0, 50).map((f, i) => {
      const name = fieldDisplayName(f);
      const acres = fmtAcres(pick(f, ["acres", "areaAcres", "tillableAcres", "acresTillable", "area"]));
      const farm = pick(f, ["farmName", "farm", "farmLabel"]);
      const bits = [];
      if (acres) bits.push(`${acres} ac`);
      if (farm && !name.includes(`(${farm})`)) bits.push(farm);
      return `${i + 1}. ${name}${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
    });

    return {
      answer:
        `You have ${fields.length} fields.\n\n` +
        lines.join("\n") +
        (fields.length > 50 ? `\n\n(Showing first 50. Ask “field <name>” for details.)` : ""),
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
    };
  }

  const m =
    /^field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^show\s+field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^open\s+field\s*[:#]?\s*(.+)$/i.exec(q);

  if (m) {
    if (!fields.length) {
      return {
        answer: "I can’t find a fields list in the current snapshot. Try “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0 }
      };
    }

    const needle = (m[1] || "").trim();
    const found = findField(fields, needle);

    if (!found) {
      return {
        answer: `I couldn’t find a field matching “${needle}”. Try “list fields”.`,
        meta: { snapshotId, fieldsKey, fieldsCount: fields.length }
      };
    }

    const detail = summarizeFieldDetailed(found);
    return {
      answer: `Field details:\n${formatBullets(detail)}`,
      meta: { snapshotId, fieldsKey }
    };
  }

  return {
    answer: `Try:\n• "list fields"\n• "field North 80"\n• "field 12"\n• "debug fields"`,
    meta: { snapshotId }
  };
}
