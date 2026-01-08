// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql10-resultops
//
// Adds full generic Result Set Memory (B):
// ✅ Stores ctx.lastResult for list answers (ids + labels + entity type + metric)
// ✅ Follow-up ops operate on ctx.lastResult (no re-guessing):
//    - include hel/tillable/crp
//    - total those
//    - largest first / smallest first / A-Z
//    - no acres
//
// Keeps your current flow:
// ✅ snapshot->sqlite
// ✅ followups paging
// ✅ followupInterpreter rewrites to "__RESULT_OP__"
// ✅ SQL execution
// ✅ clean output

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }
function norm(s) { return (s || "").toString().trim().toLowerCase(); }

function makeThreadId() {
  try { return crypto.randomUUID(); }
  catch { return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
}

/* =========================
   Output helpers
========================= */
function fmtA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function pageLines({ lines, pageSize = 25 }) {
  const size = Math.max(10, Math.min(80, Number(pageSize) || 25));
  const first = lines.slice(0, size);
  const remaining = lines.length - first.length;

  const out = [];
  out.push(...first);
  if (remaining > 0) out.push(`…plus ${remaining} more.`);

  const continuation = (remaining > 0)
    ? { kind: "page", title: "", lines, offset: size, pageSize: size }
    : null;

  return { text: out.join("\n"), continuation };
}

/* =========================
   Result memory format
   ctx.lastResult = {
     kind: "list",
     entity: "fields" | "towers" | "farms" | "counties" | ...
     ids: [id...],
     labels: [label...],   // same order as ids
     metric: "hel"|"tillable"|"crp"|""  (what the list was about)
     metricIncluded: boolean
     includeArchived: boolean
   }
========================= */

function storeLastResult(threadId, lastResult) {
  applyContextDelta(threadId, { lastResult: lastResult || null });
}

function getLastResult(ctx) {
  return (ctx && ctx.lastResult && typeof ctx.lastResult === "object") ? ctx.lastResult : null;
}

/* =========================
   Execute RESULT_OP on lastResult
========================= */
function metricColumn(metric) {
  if (metric === "hel") return "helAcres";
  if (metric === "crp") return "crpAcres";
  return "tillable"; // default
}

function buildInList(ids) {
  // ids are doc ids (strings)
  const safe = (ids || []).map(x => String(x).replace(/'/g, "''"));
  return safe.length ? safe.map(x => `'${x}'`).join(",") : "";
}

function runAugmentFields({ db, last, metric, sortMode }) {
  const col = metricColumn(metric);
  const inList = buildInList(last.ids);
  if (!inList) return { ok: false, answer: "(no matches)" };

  // pull label + metric for those exact ids
  const sql = `
    SELECT
      fields.id AS id,
      fields.name AS label,
      fields.${col} AS value
    FROM fields
    WHERE fields.id IN (${inList})
    LIMIT 2000
  `.trim();

  const ex = runSql({ db, sql, limitDefault: 2000 });
  if (!ex.ok) return { ok: false, answer: "(no matches)" };

  const rows = ex.rows || [];
  const map = new Map();
  for (const r of rows) map.set(String(r.id), { label: String(r.label || ""), value: Number(r.value) || 0 });

  // rebuild in the lastResult order
  const items = [];
  for (let i = 0; i < last.ids.length; i++) {
    const id = String(last.ids[i]);
    const baseLabel = String(last.labels?.[i] || "");
    const got = map.get(id);
    items.push({
      id,
      label: got?.label ? got.label : baseLabel,
      value: got ? got.value : 0
    });
  }

  // sorting
  if (sortMode === "largest") items.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));
  else if (sortMode === "smallest") items.sort((a, b) => (a.value - b.value) || a.label.localeCompare(b.label));
  else items.sort((a, b) => a.label.localeCompare(b.label));

  const lines = items.map(it => `• ${it.label} — ${fmtA(it.value)} ac`);
  const paged = pageLines({ lines, pageSize: 25 });

  // update lastResult state (metric now included)
  const nextLast = {
    ...last,
    metric: metric || last.metric || "tillable",
    metricIncluded: true,
    ids: items.map(x => x.id),
    labels: items.map(x => x.label)
  };

  return { ok: true, text: paged.text, continuation: paged.continuation, nextLast };
}

function runStripMetric({ last, sortMode }) {
  const items = (last.labels || []).slice().sort((a, b) => a.localeCompare(b));
  // If lastResult ids/labels are already ordered by sort, keep it unless asked A-Z
  const labels = (sortMode === "az") ? items : (last.labels || []);
  const lines = labels.map(l => `• ${l}`);
  const paged = pageLines({ lines, pageSize: 25 });

  const nextLast = { ...last, metricIncluded: false };
  return { ok: true, text: paged.text, continuation: paged.continuation, nextLast };
}

function runTotal({ db, last, metric }) {
  const col = metricColumn(metric);
  const inList = buildInList(last.ids);
  if (!inList) return { ok: false, answer: "(no matches)" };

  const sql = `
    SELECT SUM(fields.${col}) AS value
    FROM fields
    WHERE fields.id IN (${inList})
    LIMIT 1
  `.trim();

  const ex = runSql({ db, sql, limitDefault: 1 });
  if (!ex.ok || !ex.rows?.length) return { ok: false, answer: "(no matches)" };

  const v = Number(ex.rows[0].value) || 0;
  return { ok: true, text: fmtA(v), continuation: null, nextLast: last };
}

export async function handleChat({
  question,
  snapshot,
  authHeader = "",
  state = null,
  threadId = "",
  continuation = null,
  debugAI = false
}) {
  const tid = safeStr(threadId) || makeThreadId();
  const debug = !!debugAI;

  const qRaw0 = safeStr(question);
  if (!qRaw0) {
    return { ok: false, error: "missing_question", answer: "Missing question.", action: null, meta: { threadId: tid }, state: state || null };
  }

  if (!snapshot?.ok || !snapshot?.json) {
    return { ok: false, error: snapshot?.error || "snapshot_not_loaded", answer: "Snapshot not loaded.", action: null, meta: { threadId: tid }, state: state || null };
  }

  // ensure DB
  try { ensureDbFromSnapshot(snapshot); } catch (e) {
    return { ok: false, error: "db_build_failed", answer: "DB build failed.", meta: { threadId: tid, detail: safeStr(e?.message || e) }, state: state || null };
  }

  const db = getDb();
  if (!db) return { ok: false, error: "db_not_ready", answer: "DB not ready.", meta: { threadId: tid }, state: state || null };

  // normalization
  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  // seed paging continuation store
  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  // paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return { ok: fu?.ok !== false, answer: safeStr(fu?.answer) || "No response.", action: fu?.action || null, meta: { ...(fu?.meta || {}), threadId: tid }, state: state || null };
    }
  } catch { clearContinuation(tid); }

  // followup interpreter
  let routedQuestion = qRaw;
  let interpDelta = null;
  try {
    const ctx0 = getThreadContext(tid) || {};
    const interp = interpretFollowup({ question: qRaw, ctx: ctx0 });
    if (interp?.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      interpDelta = interp.contextDelta || null;
      if (interpDelta) applyContextDelta(tid, interpDelta);
    }
  } catch {}

  // ✅ RESULT OP execution (global)
  if (routedQuestion === "__RESULT_OP__") {
    const ctx = getThreadContext(tid) || {};
    const last = getLastResult(ctx);
    const op = ctx?.resultOp?.op || null;

    if (!last || last.kind !== "list" || last.entity !== "fields") {
      return { ok: false, answer: "No active list to apply that to.", meta: { threadId: tid } };
    }

    if (op === "augment") {
      const metric = ctx.resultOp.metric || last.metric || "tillable";
      const sortMode = ctx.resultOp.mode || "az";
      const r = runAugmentFields({ db, last, metric, sortMode });
      if (r.ok) {
        storeLastResult(tid, r.nextLast);
        if (r.continuation) setContinuation(tid, r.continuation);
        return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "augment", continuation: r.continuation || null } };
      }
      return { ok: false, answer: "(no matches)", meta: { threadId: tid } };
    }

    if (op === "strip_metric") {
      const sortMode = ctx.resultOp.mode || "az";
      const r = runStripMetric({ last, sortMode });
      storeLastResult(tid, r.nextLast);
      if (r.continuation) setContinuation(tid, r.continuation);
      return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "strip_metric", continuation: r.continuation || null } };
    }

    if (op === "total") {
      const metric = ctx.resultOp.metric || last.metric || "tillable";
      const r = runTotal({ db, last, metric });
      return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "total", metric } };
    }

    if (op === "sort") {
      // sort without requery: if metric included, keep; otherwise A-Z
      const mode = ctx.resultOp.mode || "az";
      if (last.metricIncluded) {
        const metric = last.metric || "tillable";
        const r = runAugmentFields({ db, last, metric, sortMode: mode });
        if (r.ok) {
          storeLastResult(tid, r.nextLast);
          if (r.continuation) setContinuation(tid, r.continuation);
          return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "sort", mode } };
        }
      } else {
        const r = runStripMetric({ last, sortMode: mode });
        storeLastResult(tid, r.nextLast);
        if (r.continuation) setContinuation(tid, r.continuation);
        return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "sort", mode } };
      }
    }

    return { ok: false, answer: "Unknown follow-up operation.", meta: { threadId: tid } };
  }

  // ===========================
  // Normal OpenAI->SQL->DB path
  // ===========================
  const plan = await planSql({ question: routedQuestion, debug });
  if (!plan.ok) {
    return { ok: false, answer: `Planner failed: ${plan?.meta?.error || "unknown"}`, meta: { threadId: tid } };
  }

  const exec = runSql({ db, sql: plan.sql, limitDefault: 80 });
  if (!exec.ok) {
    return { ok: false, answer: `SQL failed: ${exec.error}`, meta: { threadId: tid, detail: exec.detail || "" } };
  }

  const rows = exec.rows || [];
  if (!rows.length) return { ok: true, answer: "(no matches)", meta: { threadId: tid } };

  // If list_fields intent returns ids, store lastResult for follow-ups
  if (plan.intent === "list_fields") {
    // Expect: field_id + field label (planner should be doing this already)
    const ids = [];
    const labels = [];
    for (const r of rows) {
      const id = (r.field_id || r.id || "").toString().trim();
      const label = (r.field || r.label || r.name || "").toString().trim();
      if (!id || !label) continue;
      ids.push(id);
      labels.push(label);
    }
    if (ids.length) {
      storeLastResult(tid, {
        kind: "list",
        entity: "fields",
        ids,
        labels,
        metric: plan.metric || "",       // optional from planner if provided
        metricIncluded: false,
        includeArchived: false
      });
    }
  }

  // Format default output for list_fields as bullets
  if (plan.intent === "list_fields") {
    const lines = rows.map(r => `• ${(r.field || r.label || r.name || "").toString().trim()}`).filter(Boolean);
    const paged = pageLines({ lines, pageSize: 25 });
    if (paged.continuation) setContinuation(tid, paged.continuation);
    return { ok: true, answer: paged.text, meta: { threadId: tid, continuation: paged.continuation || null } };
  }

  // Fallback generic formatting
  const firstRow = rows[0] || {};
  const keys = Object.keys(firstRow || {});
  if (rows.length === 1 && keys.length === 1) {
    return { ok: true, answer: String(firstRow[keys[0]]), meta: { threadId: tid } };
  }

  const lines = [];
  for (const r of rows.slice(0, 25)) {
    const any = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? "").toString().trim();
    if (any) lines.push(`• ${any}`);
  }
  return { ok: true, answer: lines.length ? lines.join("\n") : "(no matches)", meta: { threadId: tid } };
}