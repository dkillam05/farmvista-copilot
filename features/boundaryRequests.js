// /features/boundaryRequests.js  (FULL FILE)
// Rev: 2025-12-30-boundaries-fields (Adds: list fields with open boundary requests; human defaults; no Try:)

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

function safeStr(v){ return (v == null) ? "" : String(v); }

function normalizeStatus(v){
  return safeStr(v).trim().replace(/\.+$/,"").toLowerCase();
}

function summarizeOne(r){
  const status = safeStr(r.status).trim() || "Unknown";
  const when = safeStr(r.when).trim() || safeStr(r.timestampISO).trim() || "";
  const farm = safeStr(r.farm).trim();
  const field = safeStr(r.field).trim();
  const who = safeStr(r.submittedBy).trim() || safeStr(r.submittedByEmail).trim();
  const photos = Array.isArray(r.photos) ? r.photos.length : 0;

  const bits = [];
  if (farm) bits.push(farm);
  if (field) bits.push(field);
  if (when) bits.push(when);
  if (who) bits.push(who);
  if (photos) bits.push(`${photos} photo${photos === 1 ? "" : "s"}`);

  return `• ${r.id} — ${status}${bits.length ? ` • ${bits.join(" • ")}` : ""}`;
}

function wantsSummary(qn){
  if (!qn) return false;
  return (
    qn === "boundaries" ||
    qn === "boundary" ||
    qn === "boundary requests" ||
    qn === "boundaries summary" ||
    qn === "boundary summary" ||
    qn.includes("boundary request") ||
    qn.includes("boundary fixes") ||
    qn.includes("field boundary")
  );
}

function wantsFieldsList(qn){
  if (!qn) return false;
  // human phrasing we want to catch
  return (
    (qn.includes("field") || qn.includes("fields")) &&
    (qn.includes("boundary") || qn.includes("boundaries")) &&
    (qn.includes("need") || qn.includes("have") || qn.includes("with") || qn.includes("list") || qn.includes("show"))
  );
}

export function canHandleBoundaryRequests(question){
  const q = norm(question);
  if (!q) return false;

  if (wantsSummary(q)) return true;
  if (wantsFieldsList(q)) return true;

  if (q.startsWith("boundaries")) return true;
  if (q.startsWith("boundary ")) return true;

  if (q.includes("boundary") && (q.includes("open") || q.includes("closed") || q.includes("fix"))) return true;

  return false;
}

export function answerBoundaryRequests({ question, snapshot, intent }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find boundary request collections in this snapshot right now.", meta: { snapshotId } };

  const reqs = colAsArray(colsRoot, "boundary_requests").map(r => ({
    ...r,
    __createdMs: parseTime(r.createdAt) || parseTime(r.timestampISO) || null,
    __updatedMs: parseTime(r.updatedAt) || null,
    __status: normalizeStatus(r.status)
  }));

  if (!reqs.length) return { answer: "No boundary requests were found in the snapshot.", meta: { snapshotId } };

  // ---------- NEW: fields list (open requests grouped by field) ----------
  if (wantsFieldsList(qn) || (intent && intent.mode === "fields")) {
    const open = reqs.filter(r => r.__status === "open");
    if (!open.length) {
      return { answer: "No fields currently have open boundary requests.", meta: { snapshotId, open: 0 } };
    }

    // group by field (include farm)
    const map = new Map(); // key => { farm, field, count, latestMs, ids[] }
    for (const r of open) {
      const farm = safeStr(r.farm).trim();
      const field = safeStr(r.field).trim();
      const key = `${farm}||${field}`.toLowerCase();

      const whenMs = r.__updatedMs || r.__createdMs || 0;

      if (!map.has(key)) {
        map.set(key, { farm, field, count: 0, latestMs: 0, ids: [] });
      }
      const row = map.get(key);
      row.count += 1;
      row.latestMs = Math.max(row.latestMs, whenMs);
      row.ids.push(r.id);
    }

    const grouped = [...map.values()]
      .sort((a,b)=> (b.count - a.count) || (b.latestMs - a.latestMs))
      .slice(0, 50);

    const lines = grouped.map(g => {
      const label = `${g.farm || "Farm?"} • ${g.field || "Field?"}`;
      const idPart = g.ids.slice(0, 4).join(", ") + (g.ids.length > 4 ? ` …+${g.ids.length - 4}` : "");
      const reqLabel = g.count === 1 ? "request" : "requests";
      return `• ${label} — ${g.count} ${reqLabel} (${idPart})`;
    });

    return {
      answer:
        `Fields with open boundary requests (${open.length} total requests):\n\n` +
        lines.join("\n") +
        (map.size > 50 ? `\n\n(Showing first 50 fields)` : ""),
      meta: { snapshotId, openRequests: open.length, fieldsWithOpen: map.size }
    };
  }

  // ---------- summary ----------
  if (wantsSummary(qn) || (intent && intent.mode === "summary")) {
    const total = reqs.length;
    const open = reqs.filter(r => r.__status === "open").length;
    const closed = reqs.filter(r => r.__status === "closed").length;

    return {
      answer:
        `Boundary requests summary:\n` +
        `• Total: ${total}\n` +
        `• Open: ${open}\n` +
        `• Closed: ${closed}`,
      meta: { snapshotId, total, open, closed }
    };
  }

  // ---------- open/closed ----------
  let m = /^boundaries\s+(open|closed)\s*$/i.exec(q) ||
          /^(open|closed)\s+boundaries\s*$/i.exec(q) ||
          /^boundary\s+requests\s+(open|closed)\s*$/i.exec(q);
  if (m) {
    const st = norm(m[1]);
    const list = reqs.filter(r => r.__status === st);
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests ${st} (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, status: st, count: list.length }
    };
  }

  // ---------- by farm ----------
  m = /^boundaries\s+(farm|for\s+farm)\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = (m[2] || "").trim();
    const nn = norm(needle);
    const list = reqs.filter(r => norm(r.farm).includes(nn));
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests for farm "${needle}" (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, farm: needle, count: list.length }
    };
  }

  // ---------- by field ----------
  m = /^boundaries\s+(field|for\s+field)\s+(.+)\s*$/i.exec(q);
  if (m) {
    const needle = (m[2] || "").trim();
    const nn = norm(needle);
    const list = reqs.filter(r => norm(r.field).includes(nn));
    const show = [...list].sort((a,b)=> (b.__updatedMs||0)-(a.__updatedMs||0)).slice(0, 40);

    return {
      answer: `Boundary requests for field "${needle}" (${list.length}):\n\n` + (show.length ? show.map(summarizeOne).join("\n") : "• none"),
      meta: { snapshotId, field: needle, count: list.length }
    };
  }

  // ---------- detail: boundary <id> ----------
  m = /^boundary\s+([a-zA-Z0-9_-]+)\s*$/i.exec(q);
  if (m) {
    const id = m[1].trim();
    const found = reqs.find(r => r.id === id) || null;

    if (!found) {
      return { answer: `I couldn’t find a boundary request with id "${id}".`, meta: { snapshotId } };
    }

    const lines = [];
    lines.push(`Boundary request: ${found.id}`);
    if (found.status) lines.push(`• status: ${found.status}`);
    if (found.when) lines.push(`• when: ${found.when}`);
    if (found.boundaryType) lines.push(`• boundaryType: ${found.boundaryType}`);
    if (found.scope) lines.push(`• scope: ${found.scope}`);
    if (found.farm) lines.push(`• farm: ${found.farm}${found.farmId ? ` (${found.farmId})` : ""}`);
    if (found.field) lines.push(`• field: ${found.field}${found.fieldId ? ` (${found.fieldId})` : ""}`);
    if (found.rtkTowerId) lines.push(`• rtkTowerId: ${found.rtkTowerId}`);
    if (found.submittedBy) lines.push(`• submittedBy: ${found.submittedBy}`);
    if (found.submittedByEmail) lines.push(`• submittedByEmail: ${found.submittedByEmail}`);
    if (found.notes) lines.push(`• notes: ${safeStr(found.notes).trim()}`);

    const photos = Array.isArray(found.photos) ? found.photos : [];
    lines.push(`• photos: ${photos.length}`);

    return { answer: lines.join("\n"), meta: { snapshotId, boundaryId: found.id } };
  }

  return {
    answer:
      `I can summarize boundary requests, show open/closed, or list fields with open boundary requests.\n` +
      `For example: “open boundaries” or “fields with boundary requests”.`,
    meta: { snapshotId }
  };
}
