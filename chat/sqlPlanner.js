// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-08-sqlPlanner13-add-list_fields_metric
//
// Keeps your existing contracts and adds:
// ✅ intent=list_fields_metric contract so planner understands drilldowns if fallback is used.
//
// NOTE: handleChat now routes farms/fields/rtk deterministically before calling this,
// so this is mostly a safety net.

'use strict';

const OPENAI_URL = "https://api.openai.com/v1/responses";
function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export async function planSql({ question, debug = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  if (!apiKey) {
    return { ok: false, intent: "", sql: "", targetType: "", targetText: "", meta: { used: false, error: "OPENAI_API_KEY not set", model } };
  }

  const q = safeStr(question);

  const system = `
You are FarmVista Copilot SQL planner.

Return ONLY valid JSON:
{
  "intent": "<one of: rtk_tower_info | field_info | list_fields | list_farms | list_counties | list_rtk_towers | group_metric | list_fields_metric | count | sum>",
  "sql": "SELECT ... (SQLite dialect, SELECT-only, NO semicolon)",
  "targetType": "<optional: tower|farm|county|field>",
  "targetText": "<optional: the exact string user typed for the target>"
}

GLOBAL:
- SQLite dialect.
- SELECT ONLY. No semicolons.
- ALWAYS include LIMIT (default 80 unless smaller implied).
- Default scope ACTIVE ONLY unless user explicitly asks include archived/inactive.
  Active-only fields:
    fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive')
  Active-only farms:
    farms.status IS NULL OR farms.status='' OR LOWER(farms.status) NOT IN ('archived','inactive')

SCHEMA:
farms(id, name, status, name_norm, name_sq)
fields(id, name, status, farmId, county, state, tillable, helAcres, crpAcres, rtkTowerId, name_norm, name_sq, county_norm, state_norm, field_num)
rtkTowers(id, name, frequencyMHz, networkId, name_norm, name_sq)

JOINS:
fields.farmId = farms.id
fields.rtkTowerId = rtkTowers.id

NORMALIZED MATCHING:
- farms.name_norm LIKE '%token%'
- fields.name_norm LIKE '%token%'
- fields.name_sq LIKE '%squished%'
- fields.county_norm LIKE '%token%'
- rtkTowers.name_norm LIKE '%token%'

CRITICAL INTENT RULE (NO EXCEPTIONS):
If the user asks for ANY of:
- info / information / details
- frequency / mhz
- network id / network
about an RTK tower (by tower name),
intent MUST be "rtk_tower_info" (NOT list_rtk_towers).

CRITICAL COUNTY METRIC RULE (NO EXCEPTIONS):
If the user asks for a metric PER COUNTY / BY COUNTY / IN EACH COUNTY, and mentions any of:
- hel
- crp
- tillable
- acres
intent MUST be "group_metric" (NOT list_counties).

CRITICAL DRILLDOWN RULE:
If the user asks for FIELDS in a SPECIFIC COUNTY and mentions a metric (HEL/CRP/tillable),
intent MUST be "list_fields_metric".

FIELD NUMBER:
If user says "field 0832" or "field number 710":
use fields.field_num = 832/710 OR fields.name_norm LIKE '0832%' OR fields.name LIKE '0832-%'

INTENT CONTRACTS (MUST MATCH):

1) intent="rtk_tower_info"
   SQL MUST return aliases EXACT:
     rtkTowers.name AS tower,
     rtkTowers.frequencyMHz AS frequencyMHz,
     rtkTowers.networkId AS networkId
   ALSO set targetType="tower"

2) intent="list_rtk_towers"
   SQL MUST return rtkTowers.name AS tower
   AND include ORDER BY rtkTowers.name_norm ASC

3) intent="list_fields"
   SQL MUST return fields.id AS field_id, fields.name AS field
   AND include ORDER BY fields.field_num ASC, fields.name_norm ASC

4) intent="field_info"
   MUST return full field card aliases:
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

5) intent="group_metric"
   SQL MUST return:
     groupName AS groupName,
     value AS value
   (grouped by county or farm)

6) intent="list_fields_metric"  (DRILLDOWN)
   PURPOSE: List only fields within a county that have a metric > 0.
   SQL MUST return aliases EXACT:
     fields.id AS field_id,
     fields.name AS field,
     value AS value
   REQUIRED:
   - For HEL: value = COALESCE(fields.helAcres,0) and filter COALESCE(fields.helAcres,0) > 0
   - For CRP: value = COALESCE(fields.crpAcres,0) and filter > 0
   - For tillable: value = COALESCE(fields.tillable,0) and filter > 0
   - Filter by county (fields.county_norm LIKE '%token%')
   - ORDER BY value DESC, fields.name_norm ASC
   - LIMIT 2000
`.trim();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: q }
    ],
    max_output_tokens: 900
  };

  const t0 = Date.now();
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const ms = Date.now() - t0;

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return {
        ok: false, intent: "", sql: "", targetType: "", targetText: "",
        meta: { used: true, error: `OpenAI HTTP ${r.status}`, detail: debug ? txt.slice(0, 2000) : txt.slice(0, 250), model, ms }
      };
    }

    const j = await r.json();
    let outText = safeStr(j?.output_text || "");
    if (!outText) {
      try {
        const chunks = [];
        for (const item of (j.output || [])) {
          for (const c of (item.content || [])) {
            const t = safeStr(c?.text || "");
            if (t) chunks.push(t);
          }
        }
        outText = chunks.join("\n").trim();
      } catch {}
    }

    let parsed = null;
    try { parsed = JSON.parse(outText); } catch {
      return {
        ok: false, intent: "", sql: "", targetType: "", targetText: "",
        meta: { used: true, error: "Planner returned non-JSON", detail: debug ? outText.slice(0, 2000) : outText.slice(0, 250), model, ms }
      };
    }

    const intent = safeStr(parsed?.intent);
    const sql = safeStr(parsed?.sql);
    const targetType = safeStr(parsed?.targetType || "");
    const targetText = safeStr(parsed?.targetText || "");

    if (!intent) return { ok: false, intent: "", sql: "", targetType, targetText, meta: { used: true, error: "Missing intent", model, ms } };
    if (!sql) return { ok: false, intent, sql: "", targetType, targetText, meta: { used: true, error: "Missing sql", model, ms } };

    return { ok: true, intent, sql, targetType, targetText, meta: { used: true, ok: true, model, ms, intent, sql: debug ? sql : undefined } };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, intent: "", sql: "", targetType: "", targetText: "", meta: { used: true, error: e?.message || String(e), model, ms } };
  }
}