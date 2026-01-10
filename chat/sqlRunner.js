// /chat/sqlRunner.js  (FULL FILE)
// Rev: 2026-01-10-sqlRunner-guardrails1
//
// Read-only SQL runner with hard guardrails:
// ✅ SELECT only
// ✅ no multi-statement
// ✅ blocks PRAGMA/ATTACH/INSERT/UPDATE/etc
// ✅ enforces a LIMIT if missing
// ✅ returns rows + rowCount

'use strict';

import { getDb } from "../context/snapshot-db.js";

function bad(msg) {
  const e = new Error(msg);
  e.code = "sql_guardrail";
  return e;
}

function normalizeSql(sql) {
  return (sql || "").toString().trim();
}

function isSafeSelect(sqlLower) {
  if (!sqlLower.startsWith("select")) return false;

  // Block known risky statements/keywords (even if buried)
  const blocked = [
    "pragma",
    "attach",
    "detach",
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "replace",
    "vacuum",
    "reindex",
    "analyze",
    "load_extension"
  ];

  for (const b of blocked) {
    if (sqlLower.includes(b)) return false;
  }

  return true;
}

function hasLimit(sqlLower) {
  // simplistic but effective
  return /\blimit\b\s+\d+/i.test(sqlLower);
}

function enforceLimit(sql, limit) {
  const s = normalizeSql(sql);
  const low = s.toLowerCase();
  if (hasLimit(low)) return s;
  return `${s}\nLIMIT ${Math.max(1, Math.min(Number(limit || 200), 1000))}`;
}

export function runSql({ sql, params = [], limit = 200 }) {
  const raw = normalizeSql(sql);
  if (!raw) throw bad("Empty SQL");

  if (raw.includes(";")) throw bad("Multi-statement SQL is not allowed");

  const low = raw.toLowerCase();
  if (!isSafeSelect(low)) throw bad("Only safe SELECT queries are allowed");

  const finalSql = enforceLimit(raw, limit);

  const db = getDb();
  const stmt = db.prepare(finalSql);

  let rows;
  if (Array.isArray(params) && params.length) rows = stmt.all(params);
  else rows = stmt.all();

  return {
    sql: finalSql,
    rowCount: rows.length,
    rows
  };
}
