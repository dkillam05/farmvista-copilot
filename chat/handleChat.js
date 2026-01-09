// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-08-handleChat-sql17-county-metrics
//
// Fix:
// ✅ intent=list_counties now prints a deduped county list (De Witt vs DeWitt merged by planner SQL)
// ✅ intent=group_metric now prints "Group — ### ac" (HEL/CRP/Tillable per county/farm)
// ✅ group_metric output is paged and supports "total" followup via continuation acres lines
//
// Keeps:
// ✅ field_info full card (RTK always included)
// ✅ list_fields paging + lastResult store for augment/sort/total
// ✅ list_rtk_towers output ALWAYS A–Z
// ✅ rtk_tower_info output

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
import { resolveEntityWithOpenAI } from "./entityResolverAI.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }
function norm(s) { return (s || "").toString().trim().toLowerCase(); }

function makeThreadId() {
  try { return crypto.randomUUID(); }
  catch { return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
}

function pageLines({ lines, pageSize = 25, title = "" }) {
  const size = Math.max(10, Math.min(80, Number(pageSize) || 25));
  const first = lines.slice(0, size);
  const remaining = lines.length - first.length;

  const out = [];
  if (title) out.push(title);
  out.push(...first);
  if (remaining > 0) out.push(`…plus ${remaining} more.`);

  const continuation = (remaining > 0)
    ? { kind: "page", title, lines, offset: size, pageSize: size }
    : null;

  return { text: out.join("\n"), continuation };
}

function storeLastResult(threadId, lastResult) {
  applyContextDelta(threadId, { lastResult: lastResult || null });
}

function getLastResult(ctx) {
  return (ctx && ctx.lastResult && typeof ctx.lastResult === "object") ? ctx.lastResult : null;
}

function metricColumn(metric) {
  if (metric === "hel") return "helAcres";
  if (metric === "crp") return "crpAcres";
  return "tillable";
}

function buildInList(ids) {
  const safe = (ids || []).map(x => String(x).replace(/'/g, "''"));
  return safe.length ? safe.map(x => `'${x}'`).join(",") : "";
}

function fmtA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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

function looksLikeYes(raw) {
  const q = norm(raw);
  return q === "yes" || q === "yep" || q === "yeah" || q === "correct" || q === "that one" || q === "ok" || q === "do it";
}

function buildRetryQuestion(intent, match) {
  const m = safeStr(match);
  if (!m) return "";
  if (intent === "rtk_tower_info") return `RTK tower info for ${m}`;
  if (intent === "list_fields") return `List fields for ${m}`;
  if (intent === "list_farms") return `List farms for ${m}`;
  if (intent === "list_counties") return `List counties for ${m}`;
  if (intent === "field_info") return `Field info for ${m}`;
  return m;
}

async function tryDidYouMean({ db, plan, userText, debug }) {
  const tType = safeStr(plan?.targetType || "");
  const tText = safeStr(plan?.targetText || "");
  if (!tType || !tText) return null;

  const cat = getCandidates({ db, type: tType, limit: tType === "field" ? 600 : 250 });
  if (!cat.ok || !cat.candidates.length) return null;

  const res = await resolveEntityWithOpenAI({
    entityType: tType,
    userText: tText,
    candidates: cat.candidates,
    debug
  });

  if (!res.ok) return null;
  return { ...res, targetType: tType, targetText: tText };
}

function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatFieldCard(r0) {
  const field = safeStr(r0?.field || r0?.name || "");
  const fieldId = safeStr(r0?.field_id || r0?.id || "");
  const fieldNum = (r0?.field_num != null && safeStr(r0?.field_num) !== "") ? safeStr(r0.field_num) : "";
  const farm = safeStr(r0?.farm || "");
  const county = safeStr(r0?.county || "");
  const state = safeStr(r0?.state || "");
  const status = safeStr(r0?.status || "");

  const tillableN = isFiniteNum(r0?.tillable);
  const helN = isFiniteNum(r0?.helAcres);
  const crpN = isFiniteNum(r0?.crpAcres);

  const rtkTower = safeStr(r0?.rtkTower || r0?.tower || "");
  const freq = safeStr(r0?.frequencyMHz || "");
  const net = safeStr(r0?.networkId || "");

  const out = [];
  out.push(`Field: ${field || "(unknown)"}`);
  if (fieldNum) out.push(`Field # : ${fieldNum}`);
  if (fieldId) out.push(`Field ID: ${fieldId}`);
  if (farm) out.push(`Farm: ${farm}`);

  const loc = [county, state].filter(Boolean).join(", ");
  if (loc) out.push(`Location: ${loc}`);

  out.push(`Tillable: ${tillableN != null ? fmtA(tillableN) : "0"} ac`);
  out.push(`HEL: ${helN != null ? fmtA(helN) : "0"} ac`);
  out.push(`CRP: ${crpN != null ? fmtA(crpN) : "0"} ac`);

  // RTK ALWAYS (per Dane)
  out.push(`RTK tower: ${rtkTower || "(none)"}`);
  out.push(`Frequency: ${freq ? `${freq} MHz` : "(unknown)"}`);
  out.push(`Network ID: ${net || "(unknown)"}`);

  if (status) out.push(`Status: ${status}`);
  return out.join("\n");
}

function dedupeLines(lines) {
  const out = [];
  const seen = new Set();
  for (const ln of (lines || [])) {
    const s = safeStr(ln);
    if (!s) continue;
    const k = norm(s).replace(/\s+/g, " ");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
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

  try { ensureDbFromSnapshot(snapshot); } catch (e) {
    return { ok: false, error: "db_build_failed", answer: "DB build failed.", meta: { threadId: tid, detail: safeStr(e?.message || e) }, state: state || null };
  }

  const db = getDb();
  if (!db) return { ok: false, error: "db_not_ready", answer: "DB not ready.", meta: { threadId: tid }, state: state || null };

  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  // accept pending suggestion
  try {
    const ctx = getThreadContext(tid) || {};
    const pr = ctx?.pendingResolve || null;
    if (pr && pr.suggestion && pr.intent && (looksLikeYes(qRaw) || norm(qRaw) === norm(pr.suggestion))) {
      applyContextDelta(tid, { pendingResolve: null });
      const rq = buildRetryQuestion(pr.intent, pr.suggestion) || pr.suggestion;
      return await handleChat({ question: rq, snapshot, authHeader, state, threadId: tid, continuation, debugAI });
    }
  } catch {}

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

  // OpenAI->SQL
  const plan = await planSql({ question: routedQuestion, debug });
  if (!plan.ok) return { ok: false, answer: `Planner failed: ${plan?.meta?.error || "unknown"}`, meta: { threadId: tid } };

  const exec = runSql({ db, sql: plan.sql, limitDefault: 80 });
  if (!exec.ok) return { ok: false, answer: `SQL failed: ${exec.error}`, meta: { threadId: tid, detail: exec.detail || "" } };

  let rows = exec.rows || [];

  // did-you-mean if 0 rows
  if (rows.length === 0) {
    const dy = await tryDidYouMean({ db, plan, userText: routedQuestion, debug });
    if (dy && dy.ok && dy.action === "retry" && dy.match) {
      if ((dy.confidence || "").toLowerCase() === "high") {
        const rq = buildRetryQuestion(plan.intent, dy.match) || dy.match;
        const plan2 = await planSql({ question: rq, debug });
        if (plan2.ok) {
          const ex2 = runSql({ db, sql: plan2.sql, limitDefault: 80 });
          if (ex2.ok && (ex2.rows || []).length) {
            rows = ex2.rows || [];
            plan.intent = plan2.intent;
          } else {
            applyContextDelta(tid, { pendingResolve: { intent: plan.intent, suggestion: dy.match } });
            return { ok: true, answer: `I don’t see "${dy.targetText}". Did you mean **${dy.match}**? (reply "yes")`, meta: { threadId: tid, routed: "did_you_mean" } };
          }
        }
      } else {
        applyContextDelta(tid, { pendingResolve: { intent: plan.intent, suggestion: dy.match } });
        return { ok: true, answer: `I don’t see "${dy.targetText}". Did you mean **${dy.match}**? (reply "yes")`, meta: { threadId: tid, routed: "did_you_mean" } };
      }
    }
    return { ok: true, answer: "(no matches)", meta: { threadId: tid } };
  }

  // list_fields store lastResult
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
    if (labels.length) storeLastResult(tid, { kind: "list", entity: "fields", ids, labels, metric: "", metricIncluded: false, includeArchived: false, idsMissing: ids.length === 0 });
  }

  // list_fields output
  if (plan.intent === "list_fields") {
    const lines = rows.map(r => `• ${(r.field || r.label || r.name || "").toString().trim()}`).filter(Boolean);
    const paged = pageLines({ lines, pageSize: 25 });
    if (paged.continuation) setContinuation(tid, paged.continuation);
    return { ok: true, answer: paged.text, meta: { threadId: tid, continuation: paged.continuation || null } };
  }

  // ✅ list_counties output (deduped)
  if (plan.intent === "list_counties") {
    const linesRaw = rows.map(r => {
      const c = safeStr(r.county || r.name || "");
      const s = safeStr(r.state || "");
      return `• ${[c, s].filter(Boolean).join(", ")}`.trim();
    }).filter(x => x && x !== "•");

    const lines = dedupeLines(linesRaw);
    const paged = pageLines({ lines, pageSize: 200 });
    return { ok: true, answer: paged.text, meta: { threadId: tid } };
  }

  // ✅ group_metric output (HEL/CRP/Tillable per county/farm)
  if (plan.intent === "group_metric") {
    const linesRaw = rows.map(r => {
      const g = safeStr(r.group || r.name || r.county || r.farm || "");
      const v = Number(r.value);
      const n = Number.isFinite(v) ? v : 0;
      return `• ${g} — ${fmtA(n)} ac`;
    }).filter(Boolean);

    const lines = dedupeLines(linesRaw);
    const title = ""; // keep blank; helps totals parser work cleanly
    const paged = pageLines({ lines, pageSize: 50, title });

    // seed continuation with FULL lines so followups.js "total" works
    if (paged.continuation) setContinuation(tid, paged.continuation);

    return { ok: true, answer: paged.text, meta: { threadId: tid, continuation: paged.continuation || null } };
  }

  // ✅ list_rtk_towers output ALWAYS A–Z
  if (plan.intent === "list_rtk_towers") {
    const names = rows
      .map(r => safeStr(r.tower || r.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const lines = names.map(n => `• ${n}`);
    const paged = pageLines({ lines, pageSize: 200 });
    return { ok: true, answer: paged.text, meta: { threadId: tid } };
  }

  // rtk_tower_info detail
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

  // field_info: FULL FIELD CARD (RTK ALWAYS)
  if (plan.intent === "field_info") {
    if ((rows || []).length > 1) {
      const opts = rows
        .map(r => safeStr(r.field || r.name))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      const lines = opts.map(x => `• ${x}`);
      const paged = pageLines({ lines, pageSize: 25 });
      if (paged.continuation) setContinuation(tid, paged.continuation);

      const msg =
        `I found multiple fields matching that. Reply with the exact one (or type the field number):\n` +
        `${paged.text}`;

      return { ok: true, answer: msg, meta: { threadId: tid, intent: "field_info", ambiguous: true, continuation: paged.continuation || null } };
    }

    const r0 = (rows || [])[0] || {};
    return { ok: true, answer: formatFieldCard(r0), meta: { threadId: tid, intent: "field_info" } };
  }

  // default
  const firstRow = rows[0] || {};
  const keys = Object.keys(firstRow || {});
  if (rows.length === 1 && keys.length === 1) return { ok: true, answer: String(firstRow[keys[0]]), meta: { threadId: tid } };

  const outLines = [];
  for (const r of rows.slice(0, 25)) {
    const any = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? r.group ?? "").toString().trim();
    if (any) outLines.push(`• ${any}`);
  }
  return { ok: true, answer: outLines.length ? outLines.join("\n") : "(no matches)", meta: { threadId: tid } };
}