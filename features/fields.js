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

// -----------------------------
// Field "shape" scoring
// -----------------------------
function fieldScore(o) {
  if (!o || typeof o !== "object") return 0;

  const hasName = !!pick(o, ["name", "fieldName", "label", "title"]);
  const hasAcres = pick(o, ["acres", "areaAcres", "tillableAcres", "acresTillable", "area"]) != null;
  const hasFarm = !!pick(o, ["farmName", "farm", "farmLabel"]);
  const hasFsa = !!pick(o, ["fsaFarm", "fsaFarmNumber", "farmNumber", "tract", "tractNumber", "fsaField", "fsaFieldNumber"]);
  const hasGeo = !!pick(o, ["lat", "lon", "lng", "latitude", "longitude", "centerLat", "centerLon", "centerLng", "boundaryId", "polygonId", "shapeId", "boundary"]);

  let score = 0;
  if (hasName) score += 3;
  if (hasAcres) score += 3;
  if (hasFarm) score += 2;
  if (hasFsa) score += 1;
  if (hasGeo) score += 1;

  return score;
}

function looksLikeFieldArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, score: 0 };
  const sample = arr.slice(0, 25).filter(v => v && typeof v === "object");
  if (!sample.length) return { ok: false, score: 0 };

  const scores = sample.map(fieldScore);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Threshold: needs to look pretty field-ish
  return { ok: avg >= 3.5, score: avg };
}

// Some exports store collections as objects-of-objects instead of arrays:
// { fields: { docId1:{...}, docId2:{...} } }
function objectOfObjectsToArray(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length < 1) return null;

  // If most values are objects, convert
  let objCount = 0;
  const out = [];
  for (const k of keys.slice(0, 5000)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      objCount++;
      out.push({ id: k, ...v });
    }
  }
  if (!out.length) return null;

  // If at least half look like objects, accept
  if (objCount / Math.min(keys.length, 5000) >= 0.5) return out;
  return null;
}

function getAtPath(root, pathParts) {
  let cur = root;
  for (const p of pathParts) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur;
}

// Auto-discover fields anywhere in snapshot (depth-limited)
export function findFieldsRoot(snapshotJson) {
  const d = snapshotJson || {};
  const topKeys = (d && typeof d === "object") ? Object.keys(d) : [];

  // 1) Quick common keys (fast path)
  const directCandidates = [
    "fields",
    "fieldList",
    "fv_fields",
    "Fields",
    "FIELDs"
  ];

  for (const k of directCandidates) {
    if (Array.isArray(d[k])) return { key: k, arr: d[k], method: "direct" };
    const asArr = objectOfObjectsToArray(d[k]);
    if (asArr) {
      const chk = looksLikeFieldArray(asArr);
      if (chk.ok) return { key: k, arr: asArr, method: "direct-objectmap" };
    }
  }

  // 2) Nested common patterns
  const nestedCandidates = [
    ["collections", "fields"],
    ["collections", "fieldList"],
    ["data", "fields"],
    ["export", "fields"],
    ["snapshot", "fields"],
    ["fv", "fields"]
  ];

  for (const path of nestedCandidates) {
    const v = getAtPath(d, path);
    if (Array.isArray(v)) return { key: path.join("."), arr: v, method: "nested" };

    const asArr = objectOfObjectsToArray(v);
    if (asArr) {
      const chk = looksLikeFieldArray(asArr);
      if (chk.ok) return { key: path.join("."), arr: asArr, method: "nested-objectmap" };
    }
  }

  // 3) Brute scan (depth 4), score candidates
  const best = { key: null, arr: [], score: 0, method: "scan" };
  const seen = new Set();

  function scan(node, path, depth) {
    if (!node || typeof node !== "object") return;
    if (depth > 4) return;

    // Avoid cycles
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      // Candidate array
      const chk = looksLikeFieldArray(node);
      if (chk.ok && chk.score > best.score) {
        best.key = path || "(root array)";
        best.arr = node;
        best.score = chk.score;
      }
      return;
    }

    // Object-of-objects candidate
    const maybeArr = objectOfObjectsToArray(node);
    if (maybeArr) {
      const chk = looksLikeFieldArray(maybeArr);
      if (chk.ok && chk.score > best.score) {
        best.key = path || "(root objectmap)";
        best.arr = maybeArr;
        best.score = chk.score;
      }
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== "object") continue;
      const nextPath = path ? `${path}.${k}` : k;
      scan(v, nextPath, depth + 1);
    }
  }

  scan(d, "", 0);

  if (best.key && best.arr.length) {
    return { key: best.key, arr: best.arr, method: `scan(score=${best.score.toFixed(2)})`, topKeys };
  }

  return { key: null, arr: [], method: "not-found", topKeys };
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
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) {
    return {
      answer: "Snapshot is not available right now.",
      meta: { snapshotId, snapshotError: snapshot?.lastError || null }
    };
  }

  const { key: fieldsKey, arr: fields, method, topKeys } = findFieldsRoot(json);

  if (qn === "debug fields") {
    return {
      answer: `Fields source: ${fieldsKey || "(not found)"} — count: ${fields.length}${method ? ` — via ${method}` : ""}`,
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length, method, topKeys: (topKeys || []).slice(0, 30) }
    };
  }

  if (["fields", "list fields", "show fields", "field list"].includes(qn)) {
    if (!fields.length) {
      return {
        answer: "I still can’t locate fields in the snapshot. Run “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0, method, topKeys: (topKeys || []).slice(0, 30) }
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
      meta: { snapshotId, fieldsKey, fieldsCount: fields.length, method }
    };
  }

  const m =
    /^field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^show\s+field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^open\s+field\s*[:#]?\s*(.+)$/i.exec(q);

  if (m) {
    if (!fields.length) {
      return {
        answer: "I can’t locate fields in the snapshot yet. Run “debug fields”.",
        meta: { snapshotId, fieldsKey, fieldsCount: 0, method, topKeys: (topKeys || []).slice(0, 30) }
      };
    }

    const needle = (m[1] || "").trim();
    const found = findField(fields, needle);

    if (!found) {
      return {
        answer: `I couldn’t find a field matching “${needle}”. Try “list fields”.`,
        meta: { snapshotId, fieldsKey, fieldsCount: fields.length, method }
      };
    }

    const detail = summarizeFieldDetailed(found);
    return {
      answer: `Field details:\n${formatBullets(detail)}`,
      meta: { snapshotId, fieldsKey, method }
    };
  }

  return {
    answer: `Try:\n• "list fields"\n• "field North 80"\n• "field 12"\n• "debug fields"`,
    meta: { snapshotId }
  };
}
