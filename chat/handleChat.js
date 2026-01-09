// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-08-handleChat-sql19b-deterministic-fields-farms-rtk
//
// MAKE IT RIGHT (per Dane):
// ✅ Deterministic routing for FARMS/FIELDS/COUNTIES/RTK (no LLM SQL for these)
// ✅ Stores "focus" context after every relevant answer
// ✅ Drilldown works:
//    - "What field in Morgan county has HEL?" => ONLY fields with helAcres > 0
//    - After "Morgan, IL — 55 ac", followup "what field is it?" => drills down
//
// ✅ Keeps existing:
//    - paging followups (/chat/followups.js)
//    - result ops on last field list (augment/sort/total) via __RESULT_OP__
//    - did-you-mean fallback via entityResolverAI (used when fallback planner has 0 rows)
//
// ✅ Still keeps OpenAI SQL planner as fallback ONLY for non-core questions
//
// CRITICAL FIX (so it actually runs):
// ✅ Removed duplicate function declarations (no "Identifier has already been declared")

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";   // kept for fallback only
import { runSql } from "./sqlRunner.js";

import { getCandidates } from "./entityCatalog.js";
import { resolveEntityWithOpenAI } from "./entityResolverAI.js";

/* ===========================
   Small utils
=========================== */
function safeStr(v) { return (v == null ? "" : String(v)).trim(); }
function norm(s) { return (s || "").toString().trim().toLowerCase(); }

function makeThreadId() {
  try { return crypto.randomUUID(); }
  catch { return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
}

function fmtA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function pageLines({ lines, pageSize = 25, title = "" }) {
  const size = Math.max(10, Math.min(200, Number(pageSize) || 25));
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

function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// better SQL error reporting (kept)
function formatSqlExecError(exec, planSqlText, debug) {
  const err = safeStr(exec?.error || "sql_failed");
  const detail = safeStr(exec?.detail || "");
  const sql = safeStr(exec?.sql || planSqlText || "");
  const lines = [];
  lines.push(`SQL failed: ${err}${detail ? `: ${detail}` : ""}`);
  if (debug && sql) lines.push(`SQL:\n${sql}`);
  return lines.join("\n");
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

/* ===========================
   Deterministic parsing helpers
=========================== */

function activeOnlyWhere(alias = "fields") {
  return `(${alias}.status IS NULL OR ${alias}.status='' OR LOWER(${alias}.status) NOT IN ('archived','inactive'))`;
}

function escSqlStr(s) {
  return String(s || "").replace(/'/g, "''");
}

function countyKeyFromNorm(countyNorm) {
  // merge "de witt" and "dewitt"
  return (countyNorm || "").toString().toLowerCase().replace(/\s+/g, "");
}

function parseMetricFromText(q) {
  const s = norm(q);
  if (s.includes("hel")) return "hel";
  if (s.includes("crp")) return "crp";
  if (s.includes("tillable")) return "tillable";
  if (s.includes("acres")) return "tillable";
  return "";
}

function wantsGroupByCounty(q) {
  const s = norm(q);
  return (s.includes("by county") || s.includes("per county") || s.includes("each county") || s.includes("in each county"));
}

function wantsGroupByFarm(q) {
  const s = norm(q);
  return (s.includes("by farm") || s.includes("per farm") || s.includes("each farm"));
}

function wantsListCounties(q) {
  const s = norm(q);
  return (s.includes("list") || s.includes("show") || s.includes("give me")) && s.includes("count") && s.includes("counties");
}

function wantsRtkTowerList(q) {
  const s = norm(q);
  return (s.includes("list") && s.includes("rtk") && s.includes("tower")) || (s === "list rtk towers");
}

function wantsRtkTowerInfo(q) {
  const s = norm(q);
  if (!(s.includes("rtk") && s.includes("tower"))) return false;
  return s.includes("frequency") || s.includes("mhz") || s.includes("network") || s.includes("info") || s.includes("information") || s.includes("details");
}

function extractCountyPhrase(q) {
  const m = safeStr(q).match(/\b([A-Za-z][A-Za-z\s.'-]{1,40})\s+county\b/i);
  return m ? safeStr(m[1]) : "";
}

function extractFieldNumber(q) {
  const m = safeStr(q).match(/\bfield\s*(number\s*)?(\d{3,4})\b/i);
  if (m && m[2]) return m[2];
  const m2 = safeStr(q).match(/^\s*(\d{3,4})\b/);
  return m2 ? m2[1] : "";
}

function wantsFieldInfo(q) {
  const s = norm(q);
  if (s.startsWith("field info")) return true;
  if (s.includes("tell me about field")) return true;
  if (s.includes("all field info")) return true;
  if (s.includes("everything about field")) return true;
  return false;
}

function wantsFieldsInCounty(q) {
  const s = norm(q);
  return (s.includes("list fields in") || s.includes("fields in")) && s.includes("county");
}

function wantsFieldsMetricInCounty(q) {
  const s = norm(q);
  const hasCounty = s.includes("county");
  const hasField = s.includes("field");
  const met = parseMetricFromText(s);
  return hasCounty && hasField && !!met && (s.includes("has") || s.includes("with") || s.includes("having") || s.includes("what field") || s.includes("which field") || s.includes("which fields"));
}

function wantsDrilldownFollowup(q) {
  const s = norm(q);
  if (!s) return false;
  return (
    s === "what field is it" ||
    s === "what field is that" ||
    s === "which field is it" ||
    s.includes("what field") ||
    s.includes("which field") ||
    s.includes("which fields") ||
    s.includes("what fields")
  );
}

/* ===========================
   Deterministic DB resolvers
=========================== */

function resolveCountyRow({ db, countyText }) {
  const ct = safeStr(countyText);
  if (!ct) return null;

  const token = escSqlStr(ct.toLowerCase());
  const tokenKey = escSqlStr(countyKeyFromNorm(ct));

  const sql = `
    SELECT
      MIN(TRIM(fields.county)) AS county,
      MIN(TRIM(fields.state)) AS state,
      REPLACE(fields.county_norm,' ','') AS county_key,
      fields.state_norm AS state_norm
    FROM fields
    WHERE TRIM(COALESCE(fields.county,'')) <> ''
      AND (fields.county_norm LIKE '%${token}%' OR REPLACE(fields.county_norm,' ','') LIKE '%${tokenKey}%')
    GROUP BY county_key, fields.state_norm
    ORDER BY LOWER(county) ASC, LOWER(state) ASC
    LIMIT 5
  `.trim();

  const ex = runSql({ db, sql, limitDefault: 5 });
  if (!ex.ok) return null;
  const rows = ex.rows || [];
  if (!rows.length) return null;
  return rows[0];
}

function listCounties({ db }) {
  const sql = `
    SELECT
      MIN(TRIM(fields.county)) AS county,
      MIN(TRIM(fields.state)) AS state
    FROM fields
    WHERE TRIM(COALESCE(fields.county,'')) <> ''
      AND ${activeOnlyWhere("fields")}
    GROUP BY REPLACE(fields.county_norm,' ',''), fields.state_norm
    ORDER BY LOWER(county) ASC, LOWER(state) ASC
    LIMIT 400
  `.trim();

  return runSql({ db, sql, limitDefault: 400 });
}

function groupMetricByCounty({ db, metric }) {
  const col = metricColumn(metric);
  const sql = `
    SELECT
      CASE
        WHEN TRIM(COALESCE(MIN(fields.state),'')) <> '' THEN MIN(TRIM(fields.county)) || ', ' || MIN(TRIM(fields.state))
        ELSE MIN(TRIM(fields.county))
      END AS groupName,
      SUM(COALESCE(fields.${col},0)) AS value
    FROM fields
    WHERE TRIM(COALESCE(fields.county,'')) <> ''
      AND ${activeOnlyWhere("fields")}
    GROUP BY REPLACE(fields.county_norm,' ',''), fields.state_norm
    ORDER BY LOWER(groupName) ASC
    LIMIT 400
  `.trim();

  return runSql({ db, sql, limitDefault: 400 });
}

function groupMetricByFarm({ db, metric }) {
  const col = metricColumn(metric);
  const sql = `
    SELECT
      MIN(farms.name) AS groupName,
      SUM(COALESCE(fields.${col},0)) AS value
    FROM fields
    LEFT JOIN farms ON fields.farmId = farms.id
    WHERE ${activeOnlyWhere("fields")}
    GROUP BY farms.name_norm
    ORDER BY LOWER(groupName) ASC
    LIMIT 400
  `.trim();

  return runSql({ db, sql, limitDefault: 400 });
}

function listFieldsInCounty({ db, countyRow }) {
  const countyKey = escSqlStr(safeStr(countyRow?.county_key));
  const stateNorm = escSqlStr(safeStr(countyRow?.state_norm || "").toLowerCase());

  const sql = `
    SELECT
      fields.id AS field_id,
      fields.name AS field
    FROM fields
    WHERE ${activeOnlyWhere("fields")}
      AND REPLACE(fields.county_norm,' ','') = '${countyKey}'
      ${stateNorm ? `AND fields.state_norm = '${stateNorm}'` : ""}
    ORDER BY COALESCE(fields.field_num, 999999) ASC, fields.name_norm ASC
    LIMIT 2000
  `.trim();

  return runSql({ db, sql, limitDefault: 2000 });
}

function listFieldsMetricInCounty({ db, countyRow, metric }) {
  const col = metricColumn(metric);
  const countyKey = escSqlStr(safeStr(countyRow?.county_key));
  const stateNorm = escSqlStr(safeStr(countyRow?.state_norm || "").toLowerCase());

  const sql = `
    SELECT
      fields.id AS field_id,
      fields.name AS field,
      COALESCE(fields.${col},0) AS value
    FROM fields
    WHERE ${activeOnlyWhere("fields")}
      AND REPLACE(fields.county_norm,' ','') = '${countyKey}'
      ${stateNorm ? `AND fields.state_norm = '${stateNorm}'` : ""}
      AND COALESCE(fields.${col},0) > 0
    ORDER BY value DESC, fields.name_norm ASC
    LIMIT 2000
  `.trim();

  return runSql({ db, sql, limitDefault: 2000 });
}

function fieldInfoByNumberOrName({ db, qText }) {
  const raw = safeStr(qText);
  const num = extractFieldNumber(raw);
  if (num) {
    const n = parseInt(num, 10);
    const nStr = escSqlStr(num);
    const sql = `
      SELECT
        fields.id AS field_id,
        fields.name AS field,
        fields.field_num AS field_num,
        farms.name AS farm,
        fields.county AS county,
        fields.state AS state,
        fields.tillable AS tillable,
        fields.helAcres AS helAcres,
        fields.crpAcres AS crpAcres,
        rtkTowers.name AS rtkTower,
        rtkTowers.frequencyMHz AS frequencyMHz,
        rtkTowers.networkId AS networkId,
        fields.status AS status
      FROM fields
      LEFT JOIN farms ON fields.farmId = farms.id
      LEFT JOIN rtkTowers ON fields.rtkTowerId = rtkTowers.id
      WHERE ${activeOnlyWhere("fields")}
        AND (
          fields.field_num = ${Number.isFinite(n) ? n : 999999}
          OR fields.name_norm LIKE '${nStr}%'
          OR fields.name LIKE '${nStr}-%'
        )
      ORDER BY fields.field_num ASC, fields.name_norm ASC
      LIMIT 5
    `.trim();
    return runSql({ db, sql, limitDefault: 5 });
  }

  const tokens = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).map(s => s.trim()).filter(Boolean);
  const keyTokens = tokens.filter(t => t.length >= 2).slice(0, 6);
  if (!keyTokens.length) return { ok: true, rows: [] };

  const where = keyTokens.map(t => `fields.name_norm LIKE '%${escSqlStr(t)}%'`).join(" AND ");

  const sql = `
    SELECT
      fields.id AS field_id,
      fields.name AS field,
      fields.field_num AS field_num,
      farms.name AS farm,
      fields.county AS county,
      fields.state AS state,
      fields.tillable AS tillable,
      fields.helAcres AS helAcres,
      fields.crpAcres AS crpAcres,
      rtkTowers.name AS rtkTower,
      rtkTowers.frequencyMHz AS frequencyMHz,
      rtkTowers.networkId AS networkId,
      fields.status AS status
    FROM fields
    LEFT JOIN farms ON fields.farmId = farms.id
    LEFT JOIN rtkTowers ON fields.rtkTowerId = rtkTowers.id
    WHERE ${activeOnlyWhere("fields")}
      AND (${where})
    ORDER BY fields.name_norm ASC
    LIMIT 10
  `.trim();

  return runSql({ db, sql, limitDefault: 10 });
}

function listRtkTowers({ db }) {
  const sql = `
    SELECT rtkTowers.name AS tower
    FROM rtkTowers
    WHERE rtkTowers.name IS NOT NULL AND rtkTowers.name <> ''
    ORDER BY rtkTowers.name_norm ASC
    LIMIT 400
  `.trim();
  return runSql({ db, sql, limitDefault: 400 });
}

function rtkTowerInfoByName({ db, towerName }) {
  const t = safeStr(towerName);
  if (!t) return { ok: true, rows: [] };
  const token = escSqlStr(t.toLowerCase());
  const sql = `
    SELECT
      rtkTowers.name AS tower,
      rtkTowers.frequencyMHz AS frequencyMHz,
      rtkTowers.networkId AS networkId
    FROM rtkTowers
    WHERE rtkTowers.name_norm LIKE '%${token}%'
    ORDER BY rtkTowers.name_norm ASC
    LIMIT 5
  `.trim();
  return runSql({ db, sql, limitDefault: 5 });
}

/* ===========================
   Formatters
=========================== */

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

  out.push(`RTK tower: ${rtkTower || "(none)"}`);
  out.push(`Frequency: ${freq ? `${freq} MHz` : "(unknown)"}`);
  out.push(`Network ID: ${net || "(unknown)"}`);

  if (status) out.push(`Status: ${status}`);
  return out.join("\n");
}

/* ===========================
   did-you-mean (fallback planner only)
=========================== */
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

/* ===========================
   Result Ops (existing)
=========================== */
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

/* ===========================
   MAIN
=========================== */
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

  /* =========================================================
     ✅ DETERMINISTIC CORE ROUTING (FIELDS/FARMS/RTK)
  ========================================================= */

  const ctxNow = getThreadContext(tid) || {};
  const focus = ctxNow.focus || null;

  // DRILLDOWN FOLLOWUP: "what field is it?" after a county drill/group focus
  if (wantsDrilldownFollowup(routedQuestion) && focus && focus.module === "fields" && focus.entity?.type === "county" && focus.metric) {
    const countyRow = resolveCountyRow({ db, countyText: focus.entity.label || focus.entity.name || "" });
    if (countyRow) {
      const ex = listFieldsMetricInCounty({ db, countyRow, metric: focus.metric });
      if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

      const rows = ex.rows || [];
      const lines = rows.map(r => `• ${safeStr(r.field)} — ${fmtA(Number(r.value) || 0)} ac`).filter(Boolean);
      const paged = pageLines({ lines, pageSize: 50 });
      if (paged.continuation) setContinuation(tid, paged.continuation);

      storeLastResult(tid, {
        kind: "list",
        entity: "fields",
        ids: rows.map(x => safeStr(x.field_id)).filter(Boolean),
        labels: rows.map(x => safeStr(x.field)).filter(Boolean),
        metric: focus.metric,
        metricIncluded: true
      });

      applyContextDelta(tid, {
        focus: {
          module: "fields",
          entity: { type: "county", key: safeStr(countyRow.county_key), label: `${safeStr(countyRow.county)}, ${safeStr(countyRow.state || "IL")}`.replace(/\s*,\s*$/, "") },
          metric: focus.metric,
          operation: "drilldown"
        }
      });

      return { ok: true, answer: paged.text || "(no matches)", meta: { threadId: tid, routed: "det_drilldown_fields_metric", continuation: paged.continuation || null } };
    }
  }

  // LIST COUNTIES
  if (wantsListCounties(routedQuestion)) {
    const ex = listCounties({ db });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

    const lines = (ex.rows || []).map(r => {
      const c = safeStr(r.county);
      const s = safeStr(r.state);
      return `• ${[c, s].filter(Boolean).join(", ")}`.trim();
    }).filter(x => x && x !== "•");

    const out = pageLines({ lines: dedupeLines(lines), pageSize: 400 });
    applyContextDelta(tid, { focus: { module: "fields", entity: { type: "counties", key: "all", label: "All counties" }, metric: "", operation: "list" } });
    return { ok: true, answer: out.text, meta: { threadId: tid, routed: "det_list_counties" } };
  }

  // GROUP METRIC BY COUNTY / FARM
  const metricQ = parseMetricFromText(routedQuestion);
  if (metricQ && (wantsGroupByCounty(routedQuestion) || wantsGroupByFarm(routedQuestion))) {
    const by = wantsGroupByFarm(routedQuestion) ? "farm" : "county";
    const ex = (by === "farm") ? groupMetricByFarm({ db, metric: metricQ }) : groupMetricByCounty({ db, metric: metricQ });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

    const rows = ex.rows || [];
    const lines = rows.map(r => `• ${safeStr(r.groupName)} — ${fmtA(Number(r.value) || 0)} ac`).filter(Boolean);
    const out = pageLines({ lines, pageSize: 120 });
    if (out.continuation) setContinuation(tid, out.continuation);

    applyContextDelta(tid, { focus: { module: "fields", entity: { type: by, key: "all", label: by === "county" ? "All counties" : "All farms" }, metric: metricQ, operation: "group" } });
    return { ok: true, answer: out.text, meta: { threadId: tid, routed: by === "county" ? "det_group_metric_county" : "det_group_metric_farm", continuation: out.continuation || null } };
  }

  // DRILLDOWN: fields in <county> with <metric> > 0
  if (wantsFieldsMetricInCounty(routedQuestion)) {
    const countyText = extractCountyPhrase(routedQuestion);
    const m = parseMetricFromText(routedQuestion);
    const countyRow = resolveCountyRow({ db, countyText });
    if (!countyRow) return { ok: true, answer: "(no matches)", meta: { threadId: tid, routed: "det_drilldown_no_county" } };

    const ex = listFieldsMetricInCounty({ db, countyRow, metric: m });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

    const rows = ex.rows || [];
    const lines = rows.map(r => `• ${safeStr(r.field)} — ${fmtA(Number(r.value) || 0)} ac`).filter(Boolean);
    const out = pageLines({ lines, pageSize: 50 });
    if (out.continuation) setContinuation(tid, out.continuation);

    storeLastResult(tid, {
      kind: "list",
      entity: "fields",
      ids: rows.map(x => safeStr(x.field_id)).filter(Boolean),
      labels: rows.map(x => safeStr(x.field)).filter(Boolean),
      metric: m,
      metricIncluded: true
    });

    applyContextDelta(tid, {
      focus: {
        module: "fields",
        entity: { type: "county", key: safeStr(countyRow.county_key), label: `${safeStr(countyRow.county)}, ${safeStr(countyRow.state || "IL")}`.replace(/\s*,\s*$/, "") },
        metric: m,
        operation: "drilldown"
      }
    });

    return { ok: true, answer: out.text || "(no matches)", meta: { threadId: tid, routed: "det_list_fields_metric_in_county", continuation: out.continuation || null } };
  }

  // LIST FIELDS IN COUNTY (generic)
  if (wantsFieldsInCounty(routedQuestion)) {
    const countyText = extractCountyPhrase(routedQuestion);
    const countyRow = resolveCountyRow({ db, countyText });
    if (!countyRow) return { ok: true, answer: "(no matches)", meta: { threadId: tid, routed: "det_list_fields_no_county" } };

    const ex = listFieldsInCounty({ db, countyRow });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

    const rows = ex.rows || [];
    const labels = rows.map(r => safeStr(r.field)).filter(Boolean);
    const ids = rows.map(r => safeStr(r.field_id)).filter(Boolean);

    storeLastResult(tid, { kind: "list", entity: "fields", ids, labels, metric: "", metricIncluded: false });

    const lines = labels.map(l => `• ${l}`);
    const out = pageLines({ lines, pageSize: 50 });
    if (out.continuation) setContinuation(tid, out.continuation);

    applyContextDelta(tid, {
      focus: {
        module: "fields",
        entity: { type: "county", key: safeStr(countyRow.county_key), label: `${safeStr(countyRow.county)}, ${safeStr(countyRow.state || "IL")}`.replace(/\s*,\s*$/, "") },
        metric: "",
        operation: "list"
      }
    });

    return { ok: true, answer: out.text, meta: { threadId: tid, routed: "det_list_fields_in_county", continuation: out.continuation || null } };
  }

  // FIELD INFO (always includes RTK)
  if (wantsFieldInfo(routedQuestion) || extractFieldNumber(routedQuestion)) {
    const ex = fieldInfoByNumberOrName({ db, qText: routedQuestion });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };

    const rows = ex.rows || [];
    if (!rows.length) return { ok: true, answer: "(no matches)", meta: { threadId: tid } };

    if (rows.length > 1 && !extractFieldNumber(routedQuestion)) {
      const opts = rows.map(r => safeStr(r.field)).filter(Boolean);
      const lines = opts.map(o => `• ${o}`);
      const out = pageLines({ lines, pageSize: 25 });
      if (out.continuation) setContinuation(tid, out.continuation);

      applyContextDelta(tid, { pendingResolve: { intent: "field_info", suggestion: opts[0] } });
      return { ok: true, answer: `I found multiple fields. Reply with the exact one:\n${out.text}`, meta: { threadId: tid, routed: "det_field_info_ambiguous" } };
    }

    const r0 = rows[0] || {};
    applyContextDelta(tid, { focus: { module: "fields", entity: { type: "field", key: safeStr(r0.field_id || ""), label: safeStr(r0.field || "") }, metric: "", operation: "detail" } });
    return { ok: true, answer: formatFieldCard(r0), meta: { threadId: tid, routed: "det_field_info" } };
  }

  // RTK tower list/info (deterministic)
  if (wantsRtkTowerList(routedQuestion)) {
    const ex = listRtkTowers({ db });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };
    const names = (ex.rows || []).map(r => safeStr(r.tower)).filter(Boolean);
    const out = pageLines({ lines: names.map(n => `• ${n}`), pageSize: 200 });
    applyContextDelta(tid, { focus: { module: "rtk", entity: { type: "tower", key: "all", label: "All RTK towers" }, metric: "", operation: "list" } });
    return { ok: true, answer: out.text, meta: { threadId: tid, routed: "det_list_rtk_towers" } };
  }

  if (wantsRtkTowerInfo(routedQuestion)) {
    let towerText = "";
    const m = safeStr(routedQuestion).match(/rtk\s+tower\s+(info|information|details)?\s*(for\s+)?(.+)$/i);
    if (m && m[3]) towerText = safeStr(m[3]);
    if (!towerText) towerText = safeStr(routedQuestion).replace(/.*rtk\s+tower/i, "").trim();

    const ex = rtkTowerInfoByName({ db, towerName: towerText });
    if (!ex.ok) return { ok: false, answer: formatSqlExecError(ex, ex.sql || "", debug), meta: { threadId: tid } };
    const rows = ex.rows || [];
    if (!rows.length) return { ok: true, answer: "(no matches)", meta: { threadId: tid } };

    const r0 = rows[0];
    const out = [];
    out.push(`RTK tower: ${safeStr(r0.tower)}`);
    out.push(`Frequency: ${safeStr(r0.frequencyMHz)} MHz`);
    out.push(`Network ID: ${safeStr(r0.networkId)}`);

    applyContextDelta(tid, { focus: { module: "rtk", entity: { type: "tower", key: safeStr(r0.tower), label: safeStr(r0.tower) }, metric: "", operation: "detail" } });
    return { ok: true, answer: out.join("\n"), meta: { threadId: tid, routed: "det_rtk_tower_info" } };
  }

  /* =========================================================
     FALLBACK: OpenAI planner for everything else
  ========================================================= */
  const plan = await planSql({ question: routedQuestion, debug });
  if (!plan.ok) return { ok: false, answer: `Planner failed: ${plan?.meta?.error || "unknown"}`, meta: { threadId: tid } };

  const exec = runSql({ db, sql: plan.sql, limitDefault: 80 });
  if (!exec.ok) {
    return {
      ok: false,
      answer: formatSqlExecError(exec, plan.sql, debug),
      meta: { threadId: tid, detail: exec.detail || "", sql: debug ? (exec.sql || plan.sql || "") : "" }
    };
  }

  let rows = exec.rows || [];

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

  const firstRow = rows[0] || {};
  const keys = Object.keys(firstRow || {});
  if (rows.length === 1 && keys.length === 1) return { ok: true, answer: String(firstRow[keys[0]]), meta: { threadId: tid } };

  const outLines = [];
  for (const r of rows.slice(0, 25)) {
    const any = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? r.groupName ?? r.group ?? "").toString().trim();
    if (any) outLines.push(`• ${any}`);
  }
  return { ok: true, answer: outLines.length ? outLines.join("\n") : "(no matches)", meta: { threadId: tid } };
}