// /chat/sqlRunner.js  (FULL FILE)
// Rev: 2026-01-06-sqlRunner1
//
// Executes SELECT-only SQL against better-sqlite3 DB.
// Enforces safety:
// - SELECT only
// - no semicolons
// - no PRAGMA/ATTACH/INSERT/UPDATE/DELETE/DROP
// - ensures a LIMIT exists (adds LIMIT 80 if missing)

'use strict';

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

function isSelectOnly(sql) {
  const s = safeStr(sql).toLowerCase();
  if (!s) return false;

  if (s.includes(";")) return false;

  // must start with SELECT or WITH ... SELECT
  if (!(s.startsWith("select") || s.startsWith("with"))) return false;

  // block dangerous keywords
  const bad = ["pragma", "attach", "detach", "insert", "update", "delete", "drop", "alter", "create", "replace", "vacuum"];
  for (const k of bad) {
    if (s.includes(k + " ")) return false;
  }

  return true;
}

function ensureLimit(sql, n = 80) {
  const s = safeStr(sql);
  if (!s) return s;
  const low = s.toLowerCase();
  if (low.includes(" limit ")) return s;
  return `${s} LIMIT ${Math.max(1, Math.min(200, Number(n) || 80))}`;
}

export function runSql({ db, sql, limitDefault = 80 }) {
  if (!db) return { ok: false, error: "db_not_ready", rows: [] };

  const raw = safeStr(sql);
  if (!raw) return { ok: false, error: "missing_sql", rows: [] };

  if (!isSelectOnly(raw)) return { ok: false, error: "sql_not_allowed", rows: [] };

  const finalSql = ensureLimit(raw, limitDefault);

  try {
    const stmt = db.prepare(finalSql);
    const rows = stmt.all();
    return { ok: true, sql: finalSql, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    return { ok: false, error: "sql_exec_failed", detail: safeStr(e?.message || e), sql: finalSql, rows: [] };
  }
}