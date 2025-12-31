// /features/grainBagEvents.js  (FULL FILE)
// Rev: 2025-12-31-okflag
// Change:
// ✅ Adds ok:true on successful answers so Truth Gate can pass
// ✅ Adds ok:false on error/empty states (no logic changes)

const norm = (s) => (s || "").toString().trim().toLowerCase();

console.log("[DEV CHECK] grainBagEvents loaded - OK FLAG VERSION");


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

function fmtDate(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return null;
  }
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

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function skuLabel(sku) {
  if (!sku || typeof sku !== "object") return "Unknown SKU";
  const brand = safeStr(sku.brand).trim();
  const dia = sku.diameterFt != null ? `${sku.diameterFt}` : "";
  const len = sku.sizeFeet != null ? `${sku.sizeFeet}` : (sku.lengthFt != null ? `${sku.lengthFt}` : "");
  const loc = safeStr(sku.location).trim();
  const parts = [];
  if (brand) parts.push(brand);
  if (dia && len) parts.push(`${dia}x${len}`);
  else if (dia) parts.push(`${dia}ft`);
  else if (len) parts.push(`${len}ft`);
  if (loc) parts.push(`@ ${loc}`);
  return parts.join(" ") || "SKU";
}

function eventTypeLabel(t) {
  const x = norm(t);
  if (x === "putdown" || x === "put down" || x === "put_down") return "putDown";
  if (x === "pickup" || x === "pick up" || x === "pick_up") return "pickUp";
  return t || "event";
}

function pickMode(qn) {
  // summary / on hand / events / putdowns / pickups
  if (qn.includes("on hand") || qn.includes("onhand")) return "onhand";
  if (qn.includes("events") || qn.includes("activity") || qn.includes("history")) return "events";
  if (qn.includes("putdown") || qn.includes("put down") || qn.includes("placed")) return "putdowns";
  if (qn.includes("pickup") || qn.includes("pick up") || qn.includes("picked up")) return "pickups";
  return "summary";
}

function parseLimit(q) {
  const m = /\b(top|last)\s+(\d{1,3})\b/i.exec(q);
  if (!m) return 10;
  const n = Number(m[2]) || 10;
  return Math.max(1, Math.min(50, n));
}

function extractAfter(q, label) {
  const re = new RegExp(`\\b${label}\\b\\s+(.+)$`, "i");
  const m = re.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

function partialFeetTotal(counts) {
  const arr = counts && Array.isArray(counts.partialFeet) ? counts.partialFeet : [];
  let sum = 0;
  for (const v of arr) sum += Number(v) || 0;
  return sum;
}

function summarizePutDown(e) {
  const sku = skuLabel(e.bagSku);
  const crop = safeStr(e.cropType).trim() || safeStr(e.crop).trim();
  const yr = e.cropYear != null ? String(e.cropYear) : "";
  const moist = e.cropMoisture != null ? `${e.cropMoisture}%` : "";
  const field = e.field && e.field.name ? e.field.name : "";
  const placed = safeStr(e.datePlaced).trim() || fmtDate(parseTime(e.createdAt)) || "";
  const full = Number(e.counts?.full) || 0;
  const part = Number(e.counts?.partial) || 0;
  const pFeet = partialFeetTotal(e.counts);
  const pri = e.priority != null ? `P${e.priority}` : "";
  const priR = safeStr(e.priorityReason).trim();

  const bits = [];
  if (placed) bits.push(placed);
  if (field) bits.push(field);
  if (crop || yr || moist) bits.push([crop, yr && `(${yr})`, moist].filter(Boolean).join(" "));
  bits.push(`${fmtInt(full)} full`);
  if (part) bits.push(`${fmtInt(part)} partial`);
  if (pFeet) bits.push(`${fmtInt(pFeet)} ft partial`);
  if (pri) bits.push(pri);
  if (priR) bits.push(priR);

  return `• putDown ${sku} (${e.id}) — ${bits.join(" • ")}`;
}

function summarizePickUp(e) {
  const crop = safeStr(e.crop).trim() || safeStr(e.cropType).trim();
  const yr = e.cropYear != null ? String(e.cropYear) : "";
  const field = e.field && e.field.name ? e.field.name : "";
  const dt = safeStr(e.pickedUpDate).trim() || fmtDate(parseTime(e.createdAt)) || "";
  const full = Number(e.countsPicked?.full) || 0;
  const part = Number(e.countsPicked?.partial) || 0;
  const refs = Array.isArray(e.appliedTo) ? e.appliedTo.length : 0;

  const bits = [];
  if (dt) bits.push(dt);
  if (field) bits.push(field);
  if (crop || yr) bits.push([crop, yr && `(${yr})`].filter(Boolean).join(" "));
  bits.push(`${fmtInt(full)} full`);
  if (part) bits.push(`${fmtInt(part)} partial`);
  if (refs) bits.push(`appliedTo: ${refs}`);

  return `• pickUp (${e.id}) — ${bits.join(" • ")}`;
}

export function canHandleGrainBagEvents(question) {
  const q = norm(question);
  if (!q) return false;

  // primary triggers
  if (q === "grain bags" || q === "grain bag" || q === "grain bags summary") return true;
  if (q.startsWith("grain bag")) return true;
  if (q.startsWith("grain bags")) return true;
  if (q.startsWith("bag events") || q.startsWith("bags")) return true;

  // allow inventory phrasing
  if (q.includes("grain bag") || q.includes("bag sku") || q.includes("bags on hand")) return true;

  return false;
}

export function answerGrainBagEvents({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { ok: false, answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { ok: false, answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const events = colAsArray(colsRoot, "grain_bag_events").map((e) => ({
    ...e,
    __createdMs: parseTime(e.createdAt) || null,
    __updatedMs: parseTime(e.updatedAt) || null,
    __type: eventTypeLabel(e.type)
  }));

  const inv = colAsArray(colsRoot, "inventoryGrainBagMovements").map((r) => ({
    ...r,
    __createdMs: parseTime(r.createdAt) || null,
    __updatedMs: parseTime(r.updatedAt) || null,
    __lastAdjMs: parseTime(r.lastManualAdjustment) || null
  }));

  if (!events.length && !inv.length) {
    return { ok: false, answer: "No grain bag events or inventory movements found in the snapshot.", meta: { snapshotId } };
  }

  const mode = pickMode(qn);

  // filters: year, crop, field, sku, location, brand
  let year = null;
  let m = /\b(20\d{2})\b/.exec(q);
  if (m) year = Number(m[1]) || null;

  const cropNeedle = extractAfter(q, "crop") || "";
  const fieldNeedle = extractAfter(q, "field") || "";
  const skuNeedle = extractAfter(q, "sku") || "";
  const brandNeedle = extractAfter(q, "brand") || "";
  const locNeedle = extractAfter(q, "location") || "";

  const cropN = norm(cropNeedle);
  const fieldN = norm(fieldNeedle);
  const skuN = norm(skuNeedle);
  const brandN = norm(brandNeedle);
  const locN = norm(locNeedle);

  // if user says "grain bags field 0501" (no keyword "field")
  let looseFieldN = "";
  m = /\bgrain\s+bags?\s+field\s+(.+)$/i.exec(q) || /\bbags?\s+field\s+(.+)$/i.exec(q);
  if (m) looseFieldN = norm(stripQuotes(m[1]));

  // event list filtering
  let ev = events.slice();

  if (year != null) ev = ev.filter((e) => Number(e.cropYear) === year);
  if (cropN) ev = ev.filter((e) => norm(e.cropType || e.crop).includes(cropN));
  if (fieldN) ev = ev.filter((e) => norm(e.field?.name).includes(fieldN) || safeStr(e.field?.id) === fieldNeedle);
  if (looseFieldN) ev = ev.filter((e) => norm(e.field?.name).includes(looseFieldN));
  if (skuN) ev = ev.filter((e) => norm(skuLabel(e.bagSku)).includes(skuN) || safeStr(e.bagSku?.id) === skuNeedle);
  if (brandN) ev = ev.filter((e) => norm(e.bagSku?.brand).includes(brandN));
  if (locN) ev = ev.filter((e) => norm(e.bagSku?.location).includes(locN));

  // inventory filtering
  let iv = inv.slice();
  if (brandN) iv = iv.filter((r) => norm(r.brand).includes(brandN));
  if (locN) iv = iv.filter((r) => norm(r.location).includes(locN));
  if (skuN) iv = iv.filter((r) => norm(`${r.brand} ${r.diameterFt}x${r.lengthFt} @ ${r.location || ""}`).includes(skuN) || r.id === skuNeedle);

  // ---- mode: onHand ----
  if (mode === "onhand") {
    const lines = iv
      .slice()
      .sort((a, b) => `${a.brand}`.localeCompare(`${b.brand}`) || (Number(a.diameterFt) || 0) - (Number(b.diameterFt) || 0))
      .map((r) => {
        const label = `${safeStr(r.brand).trim()} ${safeStr(r.diameterFt)}x${safeStr(r.lengthFt)}${r.location ? ` @ ${r.location}` : ""}`;
        const onHand = Number(r.onHand) || 0;
        const qty = Number(r.qty) || 0;
        const updated = fmtDateTime(r.__updatedMs) || fmtDateTime(r.__createdMs) || "";
        const bits = [];
        bits.push(`onHand: ${fmtInt(onHand)}`);
        if (qty) bits.push(`qty: ${fmtInt(qty)}`);
        if (updated) bits.push(`updated: ${updated}`);
        return `• ${label} (${r.id}) — ${bits.join(" • ")}`;
      });

    const totalOnHand = iv.reduce((s, r) => s + (Number(r.onHand) || 0), 0);

    return {
      ok: true,
      answer:
        `Grain bags on hand (inventoryGrainBagMovements) (snapshot ${snapshotId}):\n` +
        `• SKUs: ${iv.length}\n` +
        `• Total onHand: ${fmtInt(totalOnHand)}\n\n` +
        (lines.length ? lines.join("\n") : "No matching inventory rows."),
      meta: { snapshotId, skus: iv.length, totalOnHand }
    };
  }

  // ---- mode: events / putdowns / pickups ----
  if (mode === "events" || mode === "putdowns" || mode === "pickups") {
    let list = ev.slice();
    if (mode === "putdowns") list = list.filter((e) => e.__type === "putDown");
    if (mode === "pickups") list = list.filter((e) => e.__type === "pickUp");

    list.sort((a, b) => (b.__createdMs || 0) - (a.__createdMs || 0));

    const limit = parseLimit(q);
    const shown = list.slice(0, limit);

    const lines = shown.map((e) => {
      if (e.__type === "putDown") return summarizePutDown(e);
      if (e.__type === "pickUp") return summarizePickUp(e);
      return `• ${safeStr(e.type)} (${e.id})`;
    });

    const putDowns = list.filter((e) => e.__type === "putDown").length;
    const pickUps = list.filter((e) => e.__type === "pickUp").length;

    return {
      ok: true,
      answer:
        `Grain bag ${mode === "events" ? "events" : mode} (snapshot ${snapshotId}):\n` +
        `• matching: ${list.length} (putDown: ${putDowns} • pickUp: ${pickUps})\n\n` +
        (lines.length ? lines.join("\n") : "No matching events.") +
        (list.length > limit ? `\n\n(Showing last ${limit})` : ""),
      meta: { snapshotId, matching: list.length, shown: shown.length, putDowns, pickUps }
    };
  }

  // ---- mode: summary (default) ----
  let putFull = 0, putPart = 0, pickFull = 0, pickPart = 0;

  const byYearCrop = new Map(); // key "2025|Corn" => {putFull,putPart,pickFull,pickPart}
  for (const e of ev) {
    const yr = e.cropYear != null ? String(e.cropYear) : "unknown";
    const crop = safeStr(e.cropType || e.crop).trim() || "unknown";
    const key = `${yr}|${crop}`;
    if (!byYearCrop.has(key)) byYearCrop.set(key, { yr, crop, putFull: 0, putPart: 0, pickFull: 0, pickPart: 0 });

    const agg = byYearCrop.get(key);

    if (e.__type === "putDown") {
      const f = Number(e.counts?.full) || 0;
      const p = Number(e.counts?.partial) || 0;
      putFull += f; putPart += p;
      agg.putFull += f; agg.putPart += p;
    } else if (e.__type === "pickUp") {
      const f = Number(e.countsPicked?.full) || 0;
      const p = Number(e.countsPicked?.partial) || 0;
      pickFull += f; pickPart += p;
      agg.pickFull += f; agg.pickPart += p;
    }
  }

  const netFull = putFull - pickFull;
  const netPart = putPart - pickPart;

  const lastEventMs = Math.max(...ev.map((e) => e.__createdMs || 0));
  const lastEventTxt = fmtDateTime(lastEventMs);

  const byLines = Array.from(byYearCrop.values())
    .sort((a, b) => (b.yr.localeCompare(a.yr)) || a.crop.localeCompare(b.crop))
    .slice(0, 10)
    .map((r) => {
      const netF = r.putFull - r.pickFull;
      const netP = r.putPart - r.pickPart;
      return `• ${r.yr} ${r.crop}: net ${fmtInt(netF)} full • ${fmtInt(netP)} partial (put ${fmtInt(r.putFull)}/${fmtInt(r.putPart)} • pick ${fmtInt(r.pickFull)}/${fmtInt(r.pickPart)})`;
    });

  const invOnHand = iv.reduce((s, r) => s + (Number(r.onHand) || 0), 0);

  return {
    ok: true,
    answer:
      `Grain bags summary (snapshot ${snapshotId}):\n` +
      (lastEventTxt ? `• last event: ${lastEventTxt}\n` : "") +
      `• events: ${ev.length}\n` +
      `• putDown: ${fmtInt(putFull)} full • ${fmtInt(putPart)} partial\n` +
      `• pickUp: ${fmtInt(pickFull)} full • ${fmtInt(pickPart)} partial\n` +
      `• net: ${fmtInt(netFull)} full • ${fmtInt(netPart)} partial\n` +
      `• inventory onHand (from inventoryGrainBagMovements): ${fmtInt(invOnHand)}\n\n` +
      `By crop/year (top 10):\n` +
      (byLines.length ? byLines.join("\n") : "• (no breakdown)"),
    meta: {
      snapshotId,
      events: ev.length,
      putFull,
      putPart,
      pickFull,
      pickPart,
      netFull,
      netPart,
      invOnHand
    }
  };
}
