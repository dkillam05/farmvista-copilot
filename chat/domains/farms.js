// /chat/domains/farms.js  (FULL FILE)
// Rev: 2026-01-16c  domain:farms
//
// Owns Farms tools.
// Tool: farm_profile(query)

'use strict';

import { runSql } from "../sqlRunner.js";
import { resolveFarm } from "../resolve-farms.js";

function safeStr(v) { return (v == null ? "" : String(v)); }

export function farmsToolDefs() {
  return [
    {
      type: "function",
      name: "farm_profile",
      description: "Return farm information. Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Farm name or farm id." }
        },
        required: ["query"]
      }
    }
  ];
}

export function farmsHandleToolCall(name, args) {
  if (name !== "farm_profile") return null;

  const query = safeStr(args?.query).trim();
  if (!query) return { ok: false, error: "missing_query" };

  const rf = resolveFarm(query);
  if (!rf?.match?.id) return { ok: false, error: "no_match", candidates: rf?.candidates || [] };

  const fid = safeStr(rf.match.id);
  const r = runSql({ sql: `SELECT * FROM farms WHERE id = ? LIMIT 1`, params: [fid], limit: 1 });
  const row = Array.isArray(r?.rows) && r.rows.length ? r.rows[0] : null;
  if (!row) return { ok: false, error: "farm_not_found" };

  const lines = [];
  lines.push(`Farm: ${safeStr(row.name || row.farmName).trim() || "(unknown)"}`);

  for (const [k, v] of Object.entries(row)) {
    const lk = k.toLowerCase();
    if (lk === "id" || lk.endsWith("id")) continue;
    if (["name", "farmname"].includes(lk)) continue;
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    lines.push(`- ${k}: ${safeStr(v)}`);
  }

  return { ok: true, text: lines.join("\n").trim() };
}