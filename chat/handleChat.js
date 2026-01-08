// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-06-handleChat-sql9-intent-contract-no-fallback
//
// LLM-only approach (per your request):
// ✅ OpenAI -> {intent, SQL}
// ✅ Execute SQL on SQLite
// ✅ Validate against intent contract
// ✅ If anything fails -> return ERROR that tells exactly what file/step to check
//
// NO handler fallback. NO "best effort" answers.

'use strict';

import crypto from "crypto";
import { tryHandleFollowup, setContinuation, clearContinuation } from "./followups.js";
import { getThreadContext, applyContextDelta } from "./conversationStore.js";
import { interpretFollowup } from "./followupInterpreter.js";
import { normalizeQuestion } from "./normalize.js";

import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { planSql } from "./sqlPlanner.js";
import { runSql } from "./sqlRunner.js";
import { INTENT_CONTRACTS } from "./intentContracts.js";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

function makeThreadId() {
  try { return crypto.randomUUID(); }
  catch { return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
}

function norm(s) { return (s || "").toString().trim().toLowerCase(); }

function ensureLimitPresent(sql) {
  const s = safeStr(sql);
  if (!s) return s;
  const low = s.toLowerCase();
  return low.includes(" limit ") ? s : `${s} LIMIT 80`;
}

function contractFor(intent) {
  return INTENT_CONTRACTS[intent] || null;
}

function missingColumns(rows, required) {
  if (!Array.isArray(rows) || !rows.length) return required || [];
  const cols = new Set(Object.keys(rows[0] || {}));
  return (required || []).filter(c => !cols.has(c));
}

function fail({ msg, file, step, detail = "", debug = false, extra = null }) {
  let out = `ERROR: ${msg}\nPlease check ${file} (${step}).`;
  const d = safeStr(detail);
  if (debug && d) out += `\n\n${d}`;
  if (debug && extra) {
    try { out += `\n\n${JSON.stringify(extra, null, 2)}`; } catch {}
  }
  return out;
}

/* =========================
   Clean formatting (Option A)
   - Only show acres if user asked.
========================= */
function userAskedForAcres(q) {
  const s = norm(q);
  return s.includes("acres") || s.includes("tillable") || s.includes("with acres") || s.includes("include acres") || s.includes("including acres");
}

function formatAnswer({ intent, question, rows }) {
  // scalar
  if (Array.isArray(rows) && rows.length === 1) {
    const keys = Object.keys(rows[0] || {});
    if (keys.length === 1) return String(rows[0][keys[0]]);
  }

  if (!Array.isArray(rows) || !rows.length) return "(no matches)";

  // Tower info
  if (intent === "rtk_tower_info") {
    const r = rows[0] || {};
    const out = [];
    out.push(`RTK tower: ${r.tower}`);
    out.push(`Frequency: ${r.frequencyMHz} MHz`);
    out.push(`Network ID: ${r.networkId}`);
    if (r.fieldsUsing != null) out.push(`Fields using tower: ${r.fieldsUsing}`);
    if (r.farmsUsing != null) out.push(`Farms using tower: ${r.farmsUsing}`);
    return out.join("\n");
  }

  // Field -> tower info
  if (intent === "field_rtk_info") {
    const r = rows[0] || {};
    const out = [];
    out.push(`Field: ${r.field}`);
    if (r.farm) out.push(`Farm: ${r.farm}`);
    if (r.county) out.push(`County: ${r.county}${r.state ? ", " + r.state : ""}`);
    out.push(`RTK tower: ${r.tower}`);
    out.push(`Frequency: ${r.frequencyMHz} MHz`);
    out.push(`Network ID: ${r.networkId}`);
    return out.join("\n");
  }

  // Field info blocks (show first 3)
  if (intent === "field_info") {
    const blocks = [];
    const take = Math.min(3, rows.length);
    for (let i = 0; i < take; i++) {
      const r = rows[i] || {};
      const out = [];
      out.push(`Field: ${r.field}`);
      if (r.farm) out.push(`Farm: ${r.farm}`);
      if (r.county) out.push(`County: ${r.county}${r.state ? ", " + r.state : ""}`);
      if (r.status) out.push(`Status: ${r.status}`);
      if (r.tillable != null) out.push(`Tillable: ${Number(r.tillable).toLocaleString(undefined,{maximumFractionDigits:2})} ac`);
      if (r.helAcres != null && Number(r.helAcres) > 0) out.push(`HEL acres: ${Number(r.helAcres).toLocaleString(undefined,{maximumFractionDigits:2})}`);
      if (r.crpAcres != null && Number(r.crpAcres) > 0) out.push(`CRP acres: ${Number(r.crpAcres).toLocaleString(undefined,{maximumFractionDigits:2})}`);
      if (r.tower) out.push(`RTK tower: ${r.tower}`);
      blocks.push(out.join("\n"));
    }
    if (rows.length > take) blocks.push(`(…plus ${rows.length - take} more matches)`);
    return blocks.join("\n\n");
  }

  // Lists
  const includeAcres = userAskedForAcres(question);

  const lines = [];
  for (const r of rows) {
    if (!r) continue;

    if (intent === "list_fields") {
      let line = `• ${r.field}`;
      if (includeAcres && r.acres != null) {
        line += ` — ${Number(r.acres).toLocaleString(undefined,{maximumFractionDigits:2})} ac`;
      }
      lines.push(line);
      continue;
    }

    if (intent === "list_farms") { lines.push(`• ${r.farm}`); continue; }
    if (intent === "list_counties") { lines.push(`• ${r.county}`); continue; }
    if (intent === "list_rtk_towers") { lines.push(`• ${r.tower}`); continue; }

    // group_metric
    if (intent === "group_metric") {
      lines.push(`• ${r.label}\n  ${r.value}`);
      continue;
    }

    // fallback list style
    const any = (r.label ?? r.name ?? r.field ?? r.farm ?? r.county ?? r.tower ?? "").toString().trim();
    if (any) lines.push(`• ${any}`);
  }

  if (!lines.length) return "(no matches)";

  // paging via global followups
  const pageSize = 25;
  const first = lines.slice(0, pageSize);
  const remaining = lines.length - first.length;

  const out = [];
  out.push(...first);
  if (remaining > 0) out.push(`…plus ${remaining} more.`);

  const continuation = (remaining > 0) ? { kind: "page", title: "", lines, offset: pageSize, pageSize } : null;
  return { text: out.join("\n"), continuation };
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
    return { ok: false, error: "missing_question", answer: fail({ msg: "Missing question", file: "/chat/handleChat.js", step: "input", debug }), action: null, meta: { threadId: tid }, state: state || null };
  }

  if (!snapshot?.ok || !snapshot?.json) {
    return { ok: false, error: "snapshot_not_loaded", answer: fail({ msg: "Snapshot not loaded", file: "/context/snapshot.js", step: "loadSnapshot", detail: snapshot?.error || "", debug }), action: null, meta: { threadId: tid }, state: state || null };
  }

  // Ensure DB exists for this snapshot
  try {
    const dbOk = ensureDbFromSnapshot(snapshot);
    if (!dbOk?.ok) {
      return { ok: false, error: "db_not_ready", answer: fail({ msg: "SQLite DB not ready", file: "/context/snapshot-db.js", step: "ensureDbFromSnapshot", detail: dbOk?.reason || dbOk?.error || "", debug }), action: null, meta: { threadId: tid }, state: state || null };
    }
  } catch (e) {
    return { ok: false, error: "db_build_failed", answer: fail({ msg: "SQLite DB build failed", file: "/context/snapshot-db.js", step: "rebuildDbFromSnapshot", detail: e?.message || String(e), debug }), action: null, meta: { threadId: tid }, state: state || null };
  }

  const db = getDb();
  if (!db) {
    return { ok: false, error: "db_null", answer: fail({ msg: "SQLite DB is null", file: "/context/snapshot-db.js", step: "getDb", debug }), action: null, meta: { threadId: tid }, state: state || null };
  }

  // Normalize
  const nrm = normalizeQuestion(qRaw0);
  const qRaw = safeStr(nrm?.text || qRaw0);

  // Continuation seed
  try { if (continuation && typeof continuation === "object") setContinuation(tid, continuation); } catch {}

  // Paging followups
  try {
    const fu = tryHandleFollowup({ threadId: tid, question: qRaw });
    if (fu) {
      return { ok: fu?.ok !== false, answer: safeStr(fu?.answer) || "No response.", action: fu?.action || null, meta: { ...(fu?.meta || {}), threadId: tid }, state: state || null };
    }
  } catch {
    clearContinuation(tid);
  }

  // Followup interpreter rewrite
  let routedQuestion = qRaw;
  try {
    const ctx = getThreadContext(tid) || {};
    const interp = interpretFollowup({ question: qRaw, ctx });
    if (interp?.rewriteQuestion) {
      routedQuestion = interp.rewriteQuestion;
      if (interp.contextDelta) applyContextDelta(tid, interp.contextDelta);
    }
  } catch {}

  // OpenAI plan
  const plan = await planSql({ question: routedQuestion, debug });
  if (!plan.ok) {
    return {
      ok: false,
      error: "planner_failed",
      answer: fail({ msg: "OpenAI planning failed", file: "/chat/sqlPlanner.js", step: "planSql", detail: plan?.meta?.error || plan?.meta?.detail || "", debug, extra: plan?.meta || null }),
      action: null,
      meta: { threadId: tid },
      state: state || null
    };
  }

  const intent = safeStr(plan.intent);
  const sql = ensureLimitPresent(plan.sql);

  const contract = contractFor(intent);
  if (!contract) {
    return {
      ok: false,
      error: "unknown_intent",
      answer: fail({ msg: `Unknown intent "${intent}"`, file: "/chat/intentContracts.js", step: "INTENT_CONTRACTS", detail: "Planner returned an intent that has no contract.", debug, extra: { intent } }),
      action: null,
      meta: { threadId: tid },
      state: state || null
    };
  }

  // Execute SQL
  const exec = runSql({ db, sql, limitDefault: 80 });
  if (!exec.ok) {
    return {
      ok: false,
      error: exec.error || "sql_exec_failed",
      answer: fail({ msg: "SQL execution failed", file: "/chat/sqlRunner.js", step: "runSql", detail: exec.detail || exec.error || "", debug, extra: { intent, sql: debug ? exec.sql : undefined } }),
      action: null,
      meta: { threadId: tid },
      state: state || null
    };
  }

  // Validate contract
  const rows = exec.rows || [];
  const minRows = Number(contract.minRows) || 1;
  if (rows.length < minRows) {
    return {
      ok: false,
      error: "contract_no_rows",
      answer: fail({
        msg: `SQL returned ${rows.length} rows, but intent "${intent}" requires >= ${minRows}.`,
        file: "/chat/sqlPlanner.js",
        step: "intent_contract_rows",
        detail: "Planner generated a query that didn't match anything. Improve filters or add clarification step.",
        debug,
        extra: { intent, sql: debug ? exec.sql : undefined }
      }),
      action: null,
      meta: { threadId: tid },
      state: state || null
    };
  }

  const miss = missingColumns(rows, contract.requiredColumns);
  if (miss.length) {
    return {
      ok: false,
      error: "contract_missing_columns",
      answer: fail({
        msg: `Intent "${intent}" missing required columns: ${miss.join(", ")}.`,
        file: "/chat/sqlPlanner.js",
        step: "intent_contract_columns",
        detail: "Planner must alias output columns exactly as required by the contract.",
        debug,
        extra: { intent, required: contract.requiredColumns, got: Object.keys(rows[0] || {}), sql: debug ? exec.sql : undefined }
      }),
      action: null,
      meta: { threadId: tid },
      state: state || null
    };
  }

  // Format answer
  const formatted = formatAnswer({ intent, question: routedQuestion, rows });

  // If formatAnswer returned paging object
  if (formatted && typeof formatted === "object" && typeof formatted.text === "string") {
    return {
      ok: true,
      answer: formatted.text,
      action: null,
      meta: { routed: "sql", threadId: tid, intent, continuation: formatted.continuation || null, sql: debug ? exec.sql : undefined },
      state: state || null
    };
  }

  return {
    ok: true,
    answer: safeStr(formatted) || "No response.",
    action: null,
    meta: { routed: "sql", threadId: tid, intent, sql: debug ? exec.sql : undefined },
    state: state || null
  };
}