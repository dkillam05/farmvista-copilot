// /features/seasonalPrecheck.js  (FULL FILE)

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

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

function tplLabel(t) {
  const title = safeStr(t.title).trim();
  const type = safeStr(t.equipmentType).trim();
  return `${title || t.id || "Template"}${type ? ` — ${type}` : ""}`;
}

function itemLabel(i) {
  return safeStr(i.label).trim() || i.id || "Item";
}

function matchTpl(t, nn) {
  const hay = [t.id, t.title, t.titleLower, t.equipmentType].map((x) => norm(x)).join(" ");
  return hay.includes(nn);
}

function matchItem(i, nn) {
  const hay = [i.id, i.label, i.labelLower].map((x) => norm(x)).join(" ");
  return hay.includes(nn);
}

function parseEquipType(q) {
  // "equipmentType tractor" OR "type tractor"
  let m = /\b(equipmenttype|type)\s+([a-z0-9_-]+)\b/i.exec(q);
  return m ? String(m[2]) : "";
}

function pickNeedle(q) {
  // precheck template <needle>
  // precheck item <needle>
  let m =
    /^precheck\s+template\s+(.+)$/i.exec(q) ||
    /^precheck\s+templates?\s+(.+)$/i.exec(q) ||
    /^template\s+(.+)$/i.exec(q);
  if (m) return { mode: "template", needle: stripQuotes(m[1]) };

  m =
    /^precheck\s+item\s+(.+)$/i.exec(q) ||
    /^precheck\s+items?\s+(.+)$/i.exec(q) ||
    /^item\s+(.+)$/i.exec(q);
  if (m) return { mode: "item", needle: stripQuotes(m[1]) };

  return { mode: "", needle: "" };
}

export function canHandleSeasonalPrecheck(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "precheck" || q === "pre-check" || q === "prechecks") return true;
  if (q.startsWith("precheck")) return true;
  if (q.startsWith("pre-check")) return true;
  if (q.includes("precheck") || q.includes("pre-check")) return true;

  // explicit collection names sometimes typed
  if (q.includes("seasonal_precheck")) return true;

  return false;
}

export function answerSeasonalPrecheck({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const items = colAsArray(colsRoot, "seasonal_precheck_item_bank").map((i) => ({
    ...i,
    __createdMs: parseTime(i.createdAt) || null,
    __updatedMs: parseTime(i.updatedAt) || null
  }));

  const templates = colAsArray(colsRoot, "seasonal_precheck_templates").map((t) => ({
    ...t,
    __createdMs: parseTime(t.createdAt) || null,
    __updatedMs: parseTime(t.updatedAt) || null
  }));

  if (!items.length && !templates.length) {
    return { answer: "No seasonal precheck items/templates found in the snapshot.", meta: { snapshotId } };
  }

  const equipType = parseEquipType(q);

  // quick list modes
  const wantsTemplates =
    qn.includes("template") ||
    qn.includes("templates") ||
    qn === "precheck templates" ||
    qn === "precheck template";

  const wantsItems =
    qn.includes("items") ||
    qn.includes("item bank") ||
    qn === "precheck items" ||
    qn === "precheck item";

  const { mode, needle } = pickNeedle(q);
  const nn = norm(needle);

  // ---- SUMMARY ----
  if (qn === "precheck" || qn === "prechecks" || qn === "precheck summary") {
    const activeItems = items.filter((i) => i.archived === false).length;
    const archivedItems = items.filter((i) => i.archived === true).length;
    const activeTpl = templates.filter((t) => t.archived === false).length;
    const archivedTpl = templates.filter((t) => t.archived === true).length;

    return {
      answer:
        `Seasonal Pre-checks summary (snapshot ${snapshotId}):\n` +
        `• Item bank: ${items.length} (active: ${activeItems} • archived: ${archivedItems})\n` +
        `• Templates: ${templates.length} (active: ${activeTpl} • archived: ${archivedTpl})\n\n` +
        `Try:\n` +
        `• precheck templates\n` +
        `• precheck templates type tractor\n` +
        `• precheck template "Spring Startup"\n` +
        `• precheck items\n` +
        `• precheck item tire`,
      meta: { snapshotId, items: items.length, templates: templates.length }
    };
  }

  // ---- TEMPLATES LIST / SEARCH / DETAIL ----
  if (wantsTemplates || mode === "template") {
    // list
    if (!needle || includesAny(qn, ["list", "show", "summary", "templates"])) {
      let list = templates.slice();
      if (equipType) list = list.filter((t) => norm(t.equipmentType) === norm(equipType));
      list.sort((a, b) => safeStr(a.title).localeCompare(safeStr(b.title)));

      const lines = list.slice(0, 30).map((t) => {
        const bits = [];
        if (t.equipmentType) bits.push(t.equipmentType);
        if (t.archived === true) bits.push("archived");
        const upd = fmtDateTime(t.__updatedMs);
        if (upd) bits.push(`updated ${upd}`);
        return `• ${safeStr(t.title).trim() || t.id} (${t.id})${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
      });

      return {
        answer:
          `Precheck templates (snapshot ${snapshotId}): ${list.length}${equipType ? ` (type=${equipType})` : ""}\n\n` +
          (lines.length ? lines.join("\n") : "No templates found.") +
          (list.length > 30 ? `\n\n(Showing first 30)` : "") +
          `\n\nTry:\n• precheck template "Spring Startup"\n• precheck template "Harvest Inspection"`,
        meta: { snapshotId, matching: list.length, equipType: equipType || null }
      };
    }

    // search/detail by id or title
    const byId = templates.find((t) => t.id === needle) || null;
    const byTitle =
      templates.find((t) => norm(t.titleLower || t.title) === nn) ||
      templates.find((t) => norm(t.titleLower || t.title).includes(nn)) ||
      templates.find((t) => matchTpl(t, nn)) ||
      null;

    const t = byId || byTitle;
    if (!t) return { answer: `No precheck template found for "${needle}". Try "precheck templates".`, meta: { snapshotId } };

    const lines = [];
    lines.push(`Precheck template: ${safeStr(t.title).trim() || t.id} (${t.id})`);
    if (t.equipmentType) lines.push(`• equipmentType: ${t.equipmentType}`);
    if (typeof t.archived === "boolean") lines.push(`• archived: ${t.archived}`);
    const created = fmtDateTime(t.__createdMs);
    const updated = fmtDateTime(t.__updatedMs);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    return { answer: lines.join("\n"), meta: { snapshotId, templateId: t.id } };
  }

  // ---- ITEMS LIST / SEARCH / DETAIL ----
  if (wantsItems || mode === "item") {
    // list
    if (!needle || includesAny(qn, ["list", "show", "summary", "items", "bank"])) {
      let list = items.slice();
      // default: show non-archived first
      list.sort((a, b) => {
        const aa = a.archived === true ? 1 : 0;
        const bb = b.archived === true ? 1 : 0;
        return aa - bb || itemLabel(a).localeCompare(itemLabel(b));
      });

      const lines = list.slice(0, 40).map((i) => {
        const bits = [];
        if (i.archived === true) bits.push("archived");
        const upd = fmtDateTime(i.__updatedMs);
        if (upd) bits.push(`updated ${upd}`);
        return `• ${itemLabel(i)} (${i.id})${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
      });

      return {
        answer:
          `Precheck item bank (snapshot ${snapshotId}): ${list.length}\n\n` +
          (lines.length ? lines.join("\n") : "No items found.") +
          (list.length > 40 ? `\n\n(Showing first 40)` : "") +
          `\n\nTry:\n• precheck item tire\n• precheck item "Clean Air Filters"`,
        meta: { snapshotId, matching: list.length }
      };
    }

    // search/detail
    const byId = items.find((i) => i.id === needle) || null;
    const byLabel =
      items.find((i) => norm(i.labelLower || i.label) === nn) ||
      items.find((i) => norm(i.labelLower || i.label).includes(nn)) ||
      items.find((i) => matchItem(i, nn)) ||
      null;

    const it = byId || byLabel;
    if (!it) return { answer: `No precheck item found for "${needle}". Try "precheck items".`, meta: { snapshotId } };

    const lines = [];
    lines.push(`Precheck item: ${itemLabel(it)} (${it.id})`);
    if (typeof it.archived === "boolean") lines.push(`• archived: ${it.archived}`);
    const created = fmtDateTime(it.__createdMs);
    const updated = fmtDateTime(it.__updatedMs);
    if (created) lines.push(`• created: ${created}`);
    if (updated) lines.push(`• updated: ${updated}`);

    return { answer: lines.join("\n"), meta: { snapshotId, itemId: it.id } };
  }

  // fallback help
  return {
    answer:
      `Try:\n` +
      `• precheck summary\n` +
      `• precheck templates\n` +
      `• precheck templates type tractor\n` +
      `• precheck template "Spring Startup"\n` +
      `• precheck items\n` +
      `• precheck item tire`,
    meta: { snapshotId }
  };
}
