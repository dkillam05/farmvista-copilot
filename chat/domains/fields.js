// /chat/domains/fields.js  (FULL FILE)
// Rev: 2026-01-16a  domain:fields
//
// Purpose:
// - Own field prefix guardrail + field “profile” tool (later)
// - For now: move the existing RTK field-prefix guardrail helpers here unchanged.
// - Not wired yet.

'use strict';

import { runSql } from "../sqlRunner.js";
import { safeStr, norm } from "../lib/shared.js";

export function fieldsToolDefs() {
  // Later we’ll add: field_profile, field_list, etc.
  return [];
}

export function fieldsHandleToolCall(/* name, args, ctx */) {
  // Not wired yet.
  return null;
}

/* =====================================================================
   ✅ RTK+Field prefix guardrail (moved from handleChat, unchanged)
===================================================================== */
export function looksLikeRtkFieldPrefix(text) {
  const t = norm(text);
  if (!t.includes("rtk")) return null;
  if (!t.includes("field")) return null;
  const m = t.match(/\bfield\s*[:#]?\s*(\d{3,5})\b/);
  if (!m) return null;
  const prefix = m[1];
  if (t.includes(`${prefix}-`)) return null;
  return prefix;
}

export function findFieldsByPrefix(prefix) {
  const sql = `
    SELECT id, name, rtkTowerId, rtkTowerName
    FROM fields
    WHERE name LIKE ?
    ORDER BY name
    LIMIT 8
  `;
  return runSql({ sql, params: [`${safeStr(prefix)}-%`], limit: 8 });
}