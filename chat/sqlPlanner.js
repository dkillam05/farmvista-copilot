// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-06-sqlPlanner3-intent-sql
//
// OpenAI -> (intent, SQL) planner.
// Returns ONLY JSON: { "intent": "...", "sql": "SELECT ..." }.
//
// No fallbacks in handleChat; planner must produce usable SQL.

'use strict';

const OPENAI_URL = "https://api.openai.com/v1/responses";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export async function planSql({ question, debug = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  if (!apiKey) {
    return { ok: false, intent: "", sql: "", meta: { used: false, error: "OPENAI_API_KEY not set", model } };
  }

  const q = safeStr(question);

  const system = `
You are FarmVista Copilot SQL planner.

Return ONLY valid JSON:
{
  "intent": "<one of: rtk_tower_info | field_rtk_info | field_info | list_fields | list_farms | list_counties | list_rtk_towers | count | sum | group_metric>",
  "sql": "SELECT ... (SQLite dialect, SELECT-only, NO semicolon)"
}

GLOBAL RULES:
- SQLite dialect.
- SELECT statements ONLY. No semicolons.
- ALWAYS include LIMIT (default 80, unless question implies smaller).
- Default scope is ACTIVE ONLY unless user says include archived/inactive.
  Active-only rule for fields:
    fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive')
  Active-only rule for farms:
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
- fields.county_norm LIKE '%token%'
- rtkTowers.name_norm LIKE '%token%'

INTENT CONTRACTS (IMPORTANT — MUST MATCH):
1) intent="rtk_tower_info"
   SQL MUST return columns (aliases exactly):
     tower, frequencyMHz, networkId
   Recommended extra columns:
     fieldsUsing, farmsUsing
2) intent="field_rtk_info"
   SQL MUST return columns:
     field, tower, frequencyMHz, networkId
   Recommended extra:
     farm, county, state
3) intent="field_info"
   SQL MUST return at least:
     field
   Recommended:
     farm, county, state, status, tillable, helAcres, crpAcres, tower
4) intent="list_fields"
   SQL MUST return:
     field
   Optional (ONLY if user asks for acres/tillable):
     acres
   Ordering for fields list:
     ORDER BY fields.field_num ASC, fields.name_norm ASC
5) intent="list_rtk_towers"
   SQL MUST return:
     tower
   Optional:
     fieldCount, frequencyMHz, networkId
6) intent="count" or "sum"
   SQL MUST return:
     value   (single row)
7) intent="group_metric"
   SQL MUST return:
     label, value

FIELD NUMBER PATTERN:
If user says "field 0832" or "field number 710":
Use fields.field_num = 832 / 710 OR fields.name_norm LIKE '0832%' etc.
But still output the required aliases for the intent.

EXAMPLES:
- "RTK tower info for field 0832" => intent field_rtk_info
- "network id and frequency for Carlinville tower" => intent rtk_tower_info
- "list fields in macoupin county" => intent list_fields
- "how many fields in cville farm" => intent count (value)
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
        ok: false,
        intent: "",
        sql: "",
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
      return { ok: false, intent: "", sql: "", meta: { used: true, error: "Planner returned non-JSON", detail: debug ? outText.slice(0, 2000) : outText.slice(0, 250), model, ms } };
    }

    const intent = safeStr(parsed?.intent);
    const sql = safeStr(parsed?.sql);

    if (!intent) return { ok: false, intent: "", sql: "", meta: { used: true, error: "Missing intent", model, ms } };
    if (!sql) return { ok: false, intent, sql: "", meta: { used: true, error: "Missing sql", model, ms } };

    return { ok: true, intent, sql, meta: { used: true, ok: true, model, ms, intent, sql: debug ? sql : undefined } };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, intent: "", sql: "", meta: { used: true, error: e?.message || String(e), model, ms } };
  }
}