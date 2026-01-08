// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql13-global-entity-resolve
//
// Adds global OpenAI "did you mean" resolver for ALL entity lookups:
// ✅ towers / farms / counties / fields
// ✅ if SQL returns 0 rows and planner provided targetType/targetText, we:
//    - fetch candidates from DB
//    - OpenAI chooses best match or asks clarifying question
//    - auto-retry when confident
//
// Keeps your existing result ops + list_fields id storage.

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";

import { getCandidates } from "./entityCatalog.js";
import { resolveEntityWithOpenAI } from "./entityResolver.js";

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
   Result memory helpers
========================= */

function storeLastResult(threadId, lastResult) {
  applyContextDelta(threadId, { lastResult: lastResult || null });
}

function getLastResult(ctx) {
  return (ctx && ctx.lastResult && typeof ctx.lastResult === "object") ? ctx.lastResult : null;
}

/* =========================
   RESULT_OP (same as your live behavior)
========================= */
function metricColumn(metric) {
  if (metric === "hel") return "helAcres";
  if (metric === "crp") return "crpAcres";
  return "tillable";
}

function buildInList(ids) {
  const safe = (ids || []).map(x => String(x).replace(/'/g, "''"));
  return safe.length ? safe.map(x => `'${x}'`).join(",") : "";
}

function runAugmentFields({ db, last, metric, sortMode }) {
  if (!Array.isArray(last.ids) || last.ids.length === 0) {
    return {
      ok: false,
      answer:
        "ERROR: This list can’t be augmented because it has no field IDs.\n" +
        "Please check /chat/sqlPlanner.js — intent=list_fields must return fields.id AS field_id."
    };
  }

  const col = metricColumn(metric);
  const inList = buildInList(last.ids);
  if (!inList) return { ok: false, answer: "(no matches)" };

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

  const items = [];
  for (let i = 0; i < last.ids.length; i++) {
    const id = String(last.ids[i]);
    const baseLabel = String(last.labels?.[i] || "");
    const got = map.get(id);
    items.push({ id, label: got?.label ? got.label : baseLabel, value: got ? got.value : 0 });
  }

  if (sortMode === "largest") items.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));
  else if (sortMode === "smallest") items.sort((a, b) => (a.value - b.value) || a.label.localeCompare(b.label));
  else items.sort((a, b) => a.label.localeCompare(b.label));

  const lines = items.map(it => `• ${it.label} — ${fmtA(it.value)} ac`);
  const paged = pageLines({ lines, pageSize: 25 });

  const nextLast = { ...last, metric: metric || last.metric || "tillable", metricIncluded: true, ids: items.map(x => x.id), labels: items.map(x => x.label) };
  return { ok: true, text: paged.text, continuation: paged.continuation, nextLast };
}

function runStripMetric({ last, sortMode }) {
  const items = (last.labels || []).slice().sort((a, b) => a.localeCompare(b));
  const labels = (sortMode === "az") ? items : (last.labels || []);
  const lines = labels.map(l => `• ${l}`);
  const paged = pageLines({ lines, pageSize: 25 });
  const nextLast = { ...last, metricIncluded: false };
  return { ok: true, text: paged.text, continuation: paged.continuation, nextLast };
}

function runTotal({ db, last, metric }) {
  if (!Array.isArray(last.ids) || last.ids.length === 0) {
    return {
      ok: false,
      answer:
        "ERROR: I can’t total this list because it has no field IDs.\n" +
        "Please check /chat/sqlPlanner.js — intent=list_fields must return fields.id AS field_id."
    };
  }

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

/* =========================
   NEW: helper to attempt auto-resolve and retry
========================= */
function escapeRegExp(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveAndRetry({ db, routedQuestion, plan, debug }) {
  const tType = safeStr(plan.targetType || "");
  const tText = safeStr(plan.targetText || "");
  if (!tType || !tText) return null;

  const cat = getCandidates({ db, type: tType, limit: 250 });
  if (!cat.ok || !cat.candidates.length) return null;

  const res = await resolveEntityWithOpenAI({
    userText: tText,
    entityType: tType,
    candidates: cat.candidates,
    debug
  });

  if (!res.ok) return { ok: true, action: "no_match", answer: "(no matches)" };

  if (res.action === "clarify") {
    return { ok: true, action: "clarify", answer: res.ask || "Which one did you mean?" };
  }

  if (res.action === "retry" && res.match) {
    // Replace just the targetText portion in the question
    const re = new RegExp(escapeRegExp(tText), "ig");
    const rewrittenQuestion = routedQuestion.match(re)
      ? routedQuestion.replace(re, res.match)
      : `${routedQuestion} (${res.match})`;

    return { ok: true, action: "retry", rewrittenQuestion, resolved: res.match };
  }

  return { ok: true, action: "no_match", answer: "(no matches)" };
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
  if (!qRaw0) return { ok: false, error: "missing_question", answer: "Missing question.", meta: { threadId: tid }, state: state || null };

  if (!snapshot?.ok || !snapshot?.json) return { ok: false, error: snapshot?.error || "snapshot_not_loaded", answer: "Snapshot not loaded.", meta: { threadId: tid }, state: state || null };

  try { ensureDbFromSnapshot(snapshot); } catch (e) {
    return { ok: false, error: "db_build_failed", answer: "DB build failed.", meta: { threadId: tid, detail: safeStr(e?.message || e) }, state: state || null };
  }

  const db = getDb();
  if (!db) return { ok: false, error: "db_not_ready", answer: "DB not ready.", meta: { threadId: tid }, state: state || null };

  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  // paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) return { ok: fu?.ok !== false, answer: safeStr(fu?.answer) || "No response.", meta: { ...(fu?.meta || {}), threadId: tid }, state: state || null };
  } catch { clearContinuation(tid); }

  // followup interpreter
  let routedQuestion = qRaw;
  try {
    const ctx0 = getThreadContext(tid) || {};
    const interp = interpretFollowup({ question: qRaw, ctx: ctx0 });
    if (interp?.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // RESULT OP
  if (routedQuestion === "__RESULT_OP__") {
    const ctx = getThreadContext(tid) || {};
    const last = getLastResult(ctx);
    const op = ctx?.resultOp?.op || null;

    if (!last || last.kind !== "list" || last.entity !== "fields") return { ok: false, answer: "No active list to apply that to.", meta: { threadId: tid } };

    if (op === "augment") {
      const metric = ctx.resultOp.metric || last.metric || "tillable";
      const sortMode = ctx.resultOp.mode || "az";
      const r = runAugmentFields({ db, last, metric, sortMode });
      if (r.ok) {
        storeLastResult(tid, r.nextLast);
        if (r.continuation) setContinuation(tid, r.continuation);
        return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "augment", continuation: r.continuation || null } };
      }
      return { ok: false, answer: r.answer || "(no matches)", meta: { threadId: tid } };
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
      if (r.ok) return { ok: true, answer: r.text, meta: { threadId: tid, routed: "result_op", op: "total", metric } };
      return { ok: false, answer: r.answer || "(no matches)", meta: { threadId: tid } };
    }

    if (op === "sort") {
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

  // OpenAI->SQL plan
  let plan = await planSql({ question: routedQuestion, debug });
  if (!plan.ok) return { ok: false, answer: `Planner failed: ${plan?.meta?.error || "unknown"}`, meta: { threadId: tid } };

  // Execute
  let exec = runSql({ db, sql: plan.sql, limitDefault: 80 });
  let rows = exec.ok ? (exec.rows || []) : [];

  // ✅ Global resolver: if 0 rows and planner provided targetType/targetText, resolve and retry
  if (exec.ok && rows.length === 0 && plan.targetType && plan.targetText) {
    const rr = await resolveAndRetry({ db, routedQuestion, plan, debug });
    if (rr?.action === "clarify") {
      return { ok: true, answer: rr.answer, meta: { threadId: tid, routed: "resolver_clarify", targetType: plan.targetType, targetText: plan.targetText } };
    }
    if (rr?.action === "retry" && rr.rewrittenQuestion) {
      // replan with corrected text
      plan = await planSql({ question: rr.rewrittenQuestion, debug });
      if (!plan.ok) return { ok: false, answer: `Planner failed: ${plan?.meta?.error || "unknown"}`, meta: { threadId: tid } };

      exec = runSql({ db, sql: plan.sql, limitDefault: 80 });
      rows = exec.ok ? (exec.rows || []) : [];

      if (exec.ok && rows.length === 0) {
        return { ok: true, answer: "(no matches)", meta: { threadId: tid, routed: "resolver_retry_no_match", resolved: rr.resolved } };
      }
    }
  }

  if (!exec.ok) return { ok: false, answer: `SQL failed: ${exec.error}`, meta: { threadId: tid, detail: exec.detail || "" } };
  if (!rows.length) return { ok: true, answer: "(no matches)", meta: { threadId: tid } };

  // Store lastResult for list_fields
  if (plan.intent === "list_fields") {
    const ids = [];
    const labels = [];
    for (const r of rows) {
      const id = (r.field_id || r.id || "").toString().trim();
      const label = (r.field || r.label || r.name || "").toString().trim();
      if (!id || !label) continue;
      ids.push(id);
      labels.push(label);
    }
    if (ids.length) storeLastResult(tid, { kind: "list", entity: "fields", ids, labels, metric: "", metricIncluded: false, includeArchived: false });
  }

  // Output list_rtk_towers
  if (plan.intent === "list_rtk_towers") {
    const lines = rows.map(r => `• ${(r.tower || "").toString().trim()}`).filter(Boolean);
    const paged = pageLines({ lines, pageSize: 80 });
    return { ok: true, answer: paged.text, meta: { threadId: tid } };
  }

  // Output rtk_tower_info detail
  if (plan.intent === "rtk_tower_info") {
    const r0 = rows[0] || {};
    const out = [];
    out.push(`RTK tower: ${r0.tower}`);
    out.push(`Frequency: ${r0.frequencyMHz} MHz`);
    out.push(`Network ID: ${r0.networkId}`);
    if (r0.fieldsUsing != null) out.push(`Fields using tower: ${r0.fieldsUsing}`);
    if (r0.farmsUsing != null) out.push(`Farms using tower: ${r0.farmsUsing}`);
    return { ok: true, answer: out.join("\n"), meta: { threadId: tid } };
  }

  // Output list_fields
  if (plan.intent === "list_fields") {
    const lines = rows.map(r => `• ${(r.field || r.label || r.name || "").toString().trim()}`).filter(Boolean);
    const paged = pageLines({ lines, pageSize: 25 });
    if (paged.continuation) setContinuation(tid, paged.continuation);
    return { ok: true, answer: paged.text, meta: { threadId: tid, continuation: paged.continuation || null } };
  }

  // Default bullets
  const lines = [];
  for (const r of rows.slice(0, 80)) {
    const any = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? "").toString().trim();
    if (any) lines.push(`• ${any}`);
  }
  return { ok: true, answer: lines.length ? lines.join("\n") : "(no matches)", meta: { threadId: tid } };
}