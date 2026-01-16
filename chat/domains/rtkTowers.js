// /chat/domains/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-16c  domain:rtkTowers
//
// Owns RTK tools.
// Tool: rtk_tower_profile(query) => tower details.

'use strict';

import { runSql } from "../sqlRunner.js";
import { resolveRtkTower } from "../resolve-rtkTowers.js";

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }

export function rtkTowersToolDefs() {
  return [
    {
      type: "function",
      name: "rtk_tower_profile",
      description: "Return RTK tower information (network id, frequency, etc.) Read-only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tower name or tower id." }
        },
        required: ["query"]
      }
    }
  ];
}

export function userAsksTowerDetails(text) {
  const t = norm(text);
  return (t.includes("network") || t.includes("frequency") || t.includes("freq") || t.includes("net id") || t.includes("network id"));
}

export function rtkTowersHandleToolCall(name, args) {
  if (name !== "rtk_tower_profile") return null;

  const query = safeStr(args?.query).trim();
  if (!query) return { ok: false, error: "missing_query" };

  const rt = resolveRtkTower(query);
  if (!rt?.match?.id) return { ok: false, error: "no_match", candidates: rt?.candidates || [] };

  const tid = safeStr(rt.match.id);
  const r = runSql({ sql: `SELECT * FROM rtkTowers WHERE id = ? LIMIT 1`, params: [tid], limit: 1 });
  const row = Array.isArray(r?.rows) && r.rows.length ? r.rows[0] : null;
  if (!row) return { ok: false, error: "tower_not_found" };

  const lines = [];
  lines.push(`RTK Tower: ${safeStr(row.name || row.towerName || row.rtkTowerName).trim() || "(unknown)"}`);

  const net = safeStr(row.networkId || row.netId).trim();
  if (net) lines.push(`- Network ID: ${net}`);

  const freq = safeStr(row.frequency || row.freq).trim();
  if (freq) lines.push(`- Frequency: ${freq}`);

  for (const [k, v] of Object.entries(row)) {
    const lk = k.toLowerCase();
    if (lk === "id" || lk.endsWith("id")) continue;
    if (["name", "towername", "rtktowername", "networkid", "netid", "frequency", "freq"].includes(lk)) continue;
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    lines.push(`- ${k}: ${safeStr(v)}`);
  }

  return { ok: true, text: lines.join("\n").trim() };
}