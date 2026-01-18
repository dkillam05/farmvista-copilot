// /chat/domains/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-17e  domain:rtkTowers
//
// Tools:
// - rtk_towers_count_active()   => count RTK towers
// - rtk_tower_profile(query)    => tower details
// - rtk_tower_fields(query)     => list fields on that tower (optional)
//
// Goal: Prevent OpenAI loops by always providing a direct tool for "how many towers".

'use strict';

import { runSql } from "../sqlRunner.js";
import { resolveRtkTower } from "../resolve-rtkTowers.js";

function safeStr(v){ return (v==null?"":String(v)); }
function norm(v){ return safeStr(v).trim().toLowerCase(); }

export function rtkTowersToolDefs(){
  return [
    {
      type:"function",
      name:"rtk_towers_count_active",
      description:"Count RTK towers in the system. Read-only.",
      parameters:{ type:"object", properties:{} }
    },
    {
      type:"function",
      name:"rtk_tower_profile",
      description:"Return RTK tower information (network id, frequency, etc.) Read-only.",
      parameters:{ type:"object", properties:{ query:{ type:"string" } }, required:["query"] }
    },
    {
      type:"function",
      name:"rtk_tower_fields",
      description:"List fields using a given RTK tower (by tower name/id). Read-only.",
      parameters:{ type:"object", properties:{ query:{ type:"string" }, limit:{ type:"number" } }, required:["query"] }
    }
  ];
}

export function userAsksTowerDetails(text){
  const t = norm(text);
  return (t.includes("network") || t.includes("frequency") || t.includes("freq") || t.includes("net id") || t.includes("network id"));
}

function pickTowerId(query){
  const q = safeStr(query).trim();
  const rt = resolveRtkTower(q);
  if (rt?.match?.id) return safeStr(rt.match.id);
  return "";
}

export function rtkTowersHandleToolCall(name, args){
  if (name === "rtk_towers_count_active") {
    const r = runSql({ sql:`SELECT COUNT(*) AS n FROM rtkTowers`, params:[], limit:1 });
    const n = Number(r?.rows?.[0]?.n || 0);
    return { ok:true, text:`There are ${Number.isFinite(n)?n:0} RTK towers in the system.` };
  }

  if (name === "rtk_tower_profile") {
    const query = safeStr(args?.query).trim();
    if (!query) return { ok:false, error:"missing_query" };

    const tid = pickTowerId(query);
    if (!tid) return { ok:false, error:"no_match", candidates: resolveRtkTower(query)?.candidates || [] };

    const r = runSql({ sql:`SELECT * FROM rtkTowers WHERE id=? LIMIT 1`, params:[tid], limit:1 });
    const row = (r?.rows && r.rows[0]) ? r.rows[0] : null;
    if (!row) return { ok:false, error:"tower_not_found" };

    const nm = safeStr(row.name || row.towerName || row.rtkTowerName).trim() || "(unknown)";
    const lines = [`RTK Tower: ${nm}`];

    const net = safeStr(row.networkId || row.netId).trim();
    if (net) lines.push(`- Network ID: ${net}`);

    const freq = safeStr(row.frequency || row.freq).trim();
    if (freq) lines.push(`- Frequency: ${freq}`);

    return { ok:true, text: lines.join("\n") };
  }

  if (name === "rtk_tower_fields") {
    const query = safeStr(args?.query).trim();
    const limit = Math.max(1, Math.min(500, Number(args?.limit || 200)));
    if (!query) return { ok:false, error:"missing_query" };

    const tid = pickTowerId(query);
    if (!tid) return { ok:false, error:"no_match", candidates: resolveRtkTower(query)?.candidates || [] };

    const tr = runSql({ sql:`SELECT name FROM rtkTowers WHERE id=? LIMIT 1`, params:[tid], limit:1 });
    const towerName = safeStr(tr?.rows?.[0]?.name || query).trim();

    const r = runSql({
      sql:`SELECT name FROM fields WHERE rtkTowerId=? ORDER BY name LIMIT ?`,
      params:[tid, limit],
      limit
    });
    const rows = Array.isArray(r?.rows) ? r.rows : [];

    if (!rows.length) return { ok:true, text:`I found RTK tower "${towerName}", but no fields are linked to it in this snapshot.` };

    const lines = [`Fields on RTK tower "${towerName}":`];
    for (const row of rows) lines.push(`- ${safeStr(row.name)}`);
    return { ok:true, text: lines.join("\n") };
  }

  return null;
}