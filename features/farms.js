// /features/farms.js  (FULL FILE)

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

function farmLabel(f) {
  return safeStr(f.name).trim() || f.id || "Farm";
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function pickNeedle(q) {
  // farm <needle>
  let m = /^farm\s+(.+)$/i.exec(q);
  if (!m) m = /^farm\s+id\s+for\s+(.+)$/i.exec(q);
  if (!m) m = /^id\s+for\s+farm\s+(.+)$/i.exec(q);
  if (!m) m = /^farm\s+details\s+(.+)$/i.exec(q);
  if (!m) m = /^details\s+for\s+farm\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function isCountQuery(qn) {
  return qn.includes("how many") || qn.startsWith("count ") || qn === "count farms" || qn === "farm count";
}

function wantsAll(qn) {
  return qn.includes("all") || qn.includes("full") || qn.includes("everything");
}

function wantsActive(qn) {
  return qn.includes("active");
}

function wantsInactive(qn) {
  return qn.includes("inactive") || qn.includes("archived") || qn.includes("disabled");
}

function wantsUsed(qn) {
  return qn.includes("used") && !qn.includes("unused") && !qn.includes("not used");
}

function wantsUnused(qn) {
  return qn.includes("unused") || qn.includes("not used") || qn.includes("not-used") || qn.includes("unused farms");
}

export function canHandleFarms(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "farms" || q === "farm" || q === "list farms" || q === "show farms" || q === "farm list") return true;

  // filters / counts
  if (q.includes(" farms")) {
    if (q.includes("active") || q.includes("inactive") || q.includes("unused") || q.includes("not used") || q.includes("used") || q.includes("how many"))
      return true;
  }

  // lookups
  if (q.startsWith("farm ")) return true;
  if (q.startsWith("farm id for ")) return true;
  if (q.startsWith("id for farm ")) return true;
  if (q.startsWith("farm details ")) return true;
  if (q.startsWith("details for farm ")) return true;

  return false;
}

export function answerFarms({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const farms = colAsArray(colsRoot, "farms").map((f) => ({
    ...f,
    __createdMs: parseTime(f.createdAt) || null,
    __updatedMs: parseTime(f.updatedAt) || null
  }));

  if (!farms.length) return { answer: "No farms records found in the snapshot.", meta: { snapshotId } };

  // ---- lookup mode ----
  const needle = pickNeedle(q);
  if (needle) {
    const byId = farms.find((f) => f.id === needle) || null;
    const nn = norm(needle);
    const byName =
      farms.find((f) => norm(farmLabel(f)) === nn) ||
      farms.find((f) => norm(farmLabel(f)).includes(nn)) ||
      null;

    const farm = byId || byName;
    if (!farm) {
      return { answer: `No farm found for "${needle}". Try "farms" to list.`, meta: { snapshotId } };
    }

    const lines = [];
    lines.push(`Farm: ${farmLabel(farm)} (${farm.id})`);
    if (farm.status) lines.push(`• status: ${farm.status}`);
    if (typeof farm.used === "boolean") lines.push(`• used: ${farm.used}`);
    if (farm.uid) lines.push(`• uid: ${farm.uid}`);
    if (farm.t != null) lines.push(`• t: ${safeStr(farm.t)}`);
    const created = fmtDateTime(farm.__createdMs);
    const updated = fmtDateTime(farm.__updatedMs);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    return { answer: lines.join("\n"), meta: { snapshotId, farmId: farm.id } };
  }

  // ---- list/summary mode ----
  let list = farms.slice();

  if (wantsActive(qn)) list = list.filter((f) => norm(f.status) === "active");
  if (wantsInactive(qn)) list = list.filter((f) => norm(f.status) && norm(f.status) !== "active");
  if (wantsUnused(qn)) list = list.filter((f) => f.used === false);
  if (wantsUsed(qn)) list = list.filter((f) => f.used === true);

  const total = farms.length;
  const active = farms.filter((f) => norm(f.status) === "active").length;
  const used = farms.filter((f) => f.used === true).length;
  const unused = farms.filter((f) => f.used === false).length;

  // counts only?
  if (isCountQuery(qn)) {
    const subset = list.length;
    const labelBits = [];
    if (wantsActive(qn)) labelBits.push("active");
    if (wantsInactive(qn)) labelBits.push("inactive");
    if (wantsUsed(qn)) labelBits.push("used");
    if (wantsUnused(qn)) labelBits.push("unused");

    const label = labelBits.length ? `${labelBits.join(" ")} farms` : "farms";
    return {
      answer:
        `Count (${label}) (snapshot ${snapshotId}): ${subset}\n\n` +
        `All farms:\n` +
        `• total: ${total}\n` +
        `• active: ${active}\n` +
        `• used: ${used}\n` +
        `• unused: ${unused}`,
      meta: { snapshotId, total, active, used, unused, subset }
    };
  }

  // sort list by name
  list.sort((a, b) => farmLabel(a).localeCompare(farmLabel(b)));

  const maxShow = wantsAll(qn) ? 9999 : 20;
  const shown = list.slice(0, maxShow);

  const lines = shown.map((f) => {
    const bits = [];
    if (f.status) bits.push(f.status);
    if (typeof f.used === "boolean") bits.push(f.used ? "used" : "unused");
    return `• ${farmLabel(f)} (${f.id})${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
  });

  const headerBits = [];
  if (wantsActive(qn)) headerBits.push("active");
  if (wantsInactive(qn)) headerBits.push("inactive");
  if (wantsUsed(qn)) headerBits.push("used");
  if (wantsUnused(qn)) headerBits.push("unused");

  const header = headerBits.length ? `${headerBits.join(" ")} farms` : "Farms";

  return {
    answer:
      `${header} (snapshot ${snapshotId}):\n` +
      `• total: ${total} • active: ${active} • used: ${used} • unused: ${unused}\n` +
      (headerBits.length ? `• matching filter: ${list.length}\n` : "") +
      `\n` +
      lines.join("\n") +
      (list.length > maxShow ? `\n\n(Showing first ${maxShow}. Try "farms all" for full list.)` : "") +
      `\n\nTry:\n• farm Pisgah\n• farm "Divernon-Farmersvile"\n• how many unused farms`,
    meta: { snapshotId, total, active, used, unused, shown: shown.length, matching: list.length }
  };
}
