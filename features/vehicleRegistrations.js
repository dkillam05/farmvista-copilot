// /features/vehicleRegistrations.js  (FULL FILE)

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

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function parseISODate(s) {
  const t = safeStr(s).trim();
  if (!t) return null;
  // expect YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function daysUntil(ms) {
  if (!ms) return null;
  const now = Date.now();
  const diff = ms - now;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

function parseLimit(q) {
  const m = /\b(top|next|last)\s+(\d{1,3})\b/i.exec(q);
  if (!m) return 10;
  const n = Number(m[2]) || 10;
  return Math.max(1, Math.min(50, n));
}

function regLabel(r) {
  const unit = safeStr(r.unit).trim();
  const plate = safeStr(r.plate).trim();
  const state = safeStr(r.state).trim();
  const year = safeStr(r.year).trim();
  const make = safeStr(r.make).trim();
  const model = safeStr(r.model).trim();

  const head = unit || [make, model, year && `(${year})`].filter(Boolean).join(" ") || r.id;
  const plateBit = plate ? `${plate}${state ? `-${state}` : ""}` : "";
  return `${head}${plateBit ? ` — ${plateBit}` : ""}`.trim();
}

function matchReg(r, nn) {
  const hay = [
    r.id,
    r.unit,
    r.plate,
    r.state,
    r.vin,
    r.make,
    r.model,
    r.year,
    r.type,
    r.regtype,
    r.carrier,
    r.gvwr
  ]
    .map((x) => norm(x))
    .join(" ");
  return hay.includes(nn);
}

function pickNeedle(q) {
  // vehicle reg <needle>
  // registration <needle>
  let m =
    /^vehicle\s+reg(?:istration)?\s+(.+)$/i.exec(q) ||
    /^vehicle\s+registration\s+(.+)$/i.exec(q) ||
    /^registration\s+(.+)$/i.exec(q);
  return m ? stripQuotes(m[1]) : "";
}

export function canHandleVehicleRegistrations(question) {
  const q = norm(question);
  if (!q) return false;

  if (q === "vehicle registrations" || q === "vehicle regs" || q === "registrations" || q === "vehicle registration") return true;
  if (q.startsWith("vehicle reg")) return true;
  if (q.startsWith("vehicle registration")) return true;
  if (q.startsWith("registrations")) return true;

  // explicit collection name
  if (q.includes("vehicleregistrations")) return true;

  // expiring queries
  if (q.includes("registration") && (q.includes("expiring") || q.includes("expires") || q.includes("exp"))) return true;

  return false;
}

export function answerVehicleRegistrations({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const regs = colAsArray(colsRoot, "vehicleRegistrations").map((r) => ({
    ...r,
    __createdMs: parseTime(r.createdAt) || null,
    __expMs: parseISODate(r.exp) || null,
    __iexpMs: parseISODate(r.iexp) || null
  }));

  if (!regs.length) return { answer: "No vehicleRegistrations records found in the snapshot.", meta: { snapshotId } };

  // expiring mode
  if (includesAny(qn, ["expiring", "expires", "expiring soon"]) || qn.includes("exp ")) {
    const limit = parseLimit(q);
    // default window: next 120 days
    let windowDays = 120;
    const m = /\bwithin\s+(\d{1,4})\s+days?\b/i.exec(q);
    if (m) windowDays = Math.max(1, Math.min(3650, Number(m[1]) || 120));

    const now = Date.now();
    const cutoff = now + windowDays * 24 * 60 * 60 * 1000;

    const list = regs
      .filter((r) => (r.__expMs != null && r.__expMs <= cutoff) || (r.__iexpMs != null && r.__iexpMs <= cutoff))
      .slice()
      .sort((a, b) => {
        const ae = a.__expMs ?? Infinity;
        const be = b.__expMs ?? Infinity;
        return ae - be;
      });

    const shown = list.slice(0, limit).map((r) => {
      const expDays = r.__expMs ? daysUntil(r.__expMs) : null;
      const iexpDays = r.__iexpMs ? daysUntil(r.__iexpMs) : null;
      const exp = r.exp ? `${r.exp}${expDays != null ? ` (${expDays}d)` : ""}` : "";
      const iexp = r.iexp ? `${r.iexp}${iexpDays != null ? ` (${iexpDays}d)` : ""}` : "";
      const bits = [];
      if (exp) bits.push(`reg exp ${exp}`);
      if (iexp) bits.push(`ins exp ${iexp}`);
      return `• ${regLabel(r)} (${r.id}) — ${bits.join(" • ")}`;
    });

    return {
      answer:
        `Vehicle registrations expiring within ${windowDays} days (snapshot ${snapshotId}): ${list.length}\n\n` +
        (shown.length ? shown.join("\n") : "No matches.") +
        (list.length > limit ? `\n\n(Showing first ${limit})` : "") +
        `\n\nTry:\n• vehicle reg expiring within 30 days\n• vehicle reg DJK-AG\n• vehicle reg vin 0123`,
      meta: { snapshotId, matching: list.length, windowDays, shown: shown.length }
    };
  }

  // detail lookup
  const needle = pickNeedle(q);
  if (needle && !includesAny(qn, ["expiring", "expires", "within"])) {
    const nn = norm(needle);
    const byId = regs.find((r) => r.id === needle) || null;
    const byPlate = regs.find((r) => norm(r.plate) === nn) || null;
    const byVin = regs.find((r) => norm(r.vin).includes(nn)) || null;
    const byUnit = regs.find((r) => norm(r.unit).includes(nn)) || null;

    const r = byId || byPlate || byVin || byUnit || regs.find((x) => matchReg(x, nn)) || null;
    if (!r) return { answer: `No vehicle registration found for "${needle}". Try "vehicle registrations".`, meta: { snapshotId } };

    const lines = [];
    lines.push(`Vehicle registration: ${regLabel(r)} (${r.id})`);
    if (r.unit) lines.push(`• unit: ${r.unit}`);
    if (r.type) lines.push(`• type: ${r.type}`);
    if (r.regtype) lines.push(`• regtype: ${r.regtype}`);
    if (r.plate) lines.push(`• plate: ${r.plate}`);
    if (r.state) lines.push(`• state: ${r.state}`);
    if (r.year || r.make || r.model) lines.push(`• vehicle: ${[r.year, r.make, r.model].filter(Boolean).join(" ")}`);
    if (r.vin) lines.push(`• vin: ${r.vin}`);
    if (r.gvwr) lines.push(`• gvwr: ${fmtInt(r.gvwr)}`);
    if (r.carrier) lines.push(`• carrier: ${r.carrier}`);
    if (r.policy) lines.push(`• policy: ${r.policy}`);
    if (r.notes) lines.push(`• notes: ${r.notes}`);

    if (r.exp) {
      const d = r.__expMs ? daysUntil(r.__expMs) : null;
      lines.push(`• reg exp: ${r.exp}${d != null ? ` (${d} days)` : ""}`);
    }
    if (r.iexp) {
      const d = r.__iexpMs ? daysUntil(r.__iexpMs) : null;
      lines.push(`• ins exp: ${r.iexp}${d != null ? ` (${d} days)` : ""}`);
    }

    const created = fmtDateTime(r.__createdMs);
    if (created) lines.push(`• added: ${created}`);

    return { answer: lines.join("\n"), meta: { snapshotId, id: r.id, plate: r.plate || null } };
  }

  // list / summary
  if (qn === "vehicle registrations" || qn === "vehicle regs" || qn === "registrations" || qn === "vehicle registration") {
    const lines = regs
      .slice()
      .sort((a, b) => regLabel(a).localeCompare(regLabel(b)))
      .slice(0, 25)
      .map((r) => {
        const bits = [];
        if (r.exp) bits.push(`reg exp ${r.exp}`);
        if (r.iexp) bits.push(`ins exp ${r.iexp}`);
        return `• ${regLabel(r)} (${r.id})${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
      });

    return {
      answer:
        `Vehicle registrations (snapshot ${snapshotId}): ${regs.length}\n\n` +
        (lines.length ? lines.join("\n") : "No registrations.") +
        (regs.length > 25 ? `\n\n(Showing first 25)` : "") +
        `\n\nTry:\n• vehicle reg DJK-AG\n• vehicle reg expiring within 60 days\n• vehicle reg vin 0123`,
      meta: { snapshotId, total: regs.length }
    };
  }

  // fallback help
  return {
    answer:
      `Try:\n` +
      `• vehicle registrations\n` +
      `• vehicle reg DJK-AG\n` +
      `• vehicle reg expiring within 30 days\n` +
      `• vehicle reg vin 0123`,
    meta: { snapshotId }
  };
}
