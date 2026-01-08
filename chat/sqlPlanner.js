// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-08-sqlPlanner9-fieldinfo-contract
//
// Fix:
// ✅ Add strict intent contract for field_info (full field card + RTK details ALWAYS)
// ✅ Field number lookups: fields.field_num OR name prefix
// ✅ Field name (non-numeric) lookups: alphabetical ORDER BY fields.name_norm ASC, LIMIT 10 (to detect ambiguity)
// ✅ Remove need for field_rtk_info (field_info always includes RTK details)
//
// Keeps:
// ✅ list_rtk_towers MUST include ORDER BY rtkTowers.name_norm ASC
// ✅ list_rtk_towers MUST return rtkTowers.name AS tower
// ✅ list_fields returns field_id+field
// ✅ force rtk_tower_info for info/details/network/frequency
// ✅ targetType/targetText hints

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
  "intent": "<one of: rtk_tower_info | field_info | list_fields | list_farms | list_counties | list_rtk_towers | count | sum | group_metric>",
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
about an RTK tower,
intent MUST be "rtk_tower_info" (NOT list_rtk_towers).

FIELD NUMBER:
If user says "field 0832" or "field number 710":
use fields.field_num = 832/710 OR fields.name_norm LIKE '0832%' OR fields.name LIKE '0832-%'

INTENT CONTRACTS (MUST MATCH):

1) intent="rtk_tower_info"
   SQL MUST return aliases EXACT:
     rtkTowers.name AS tower,
     rtkTowers.frequencyMHz AS frequencyMHz,
     rtkTowers.networkId AS networkId
   Optional:
     fieldsUsing, farmsUsing
   ALSO set:
     targetType="tower"
     targetText="<tower name string user typed>"

2) intent="list_rtk_towers"
   SQL MUST return:
     rtkTowers.name AS tower
   AND MUST include:
     ORDER BY rtkTowers.name_norm ASC

3) intent="list_fields"
   SQL MUST return:
     fields.id AS field_id,
     fields.name AS field
   AND MUST include:
     ORDER BY fields.field_num ASC, fields.name_norm ASC

4) intent="field_info"
   PURPOSE:
     Return a full field record. RTK info MUST be included EVERY TIME.
   SQL MUST return ONE ROW (if numeric) or UP TO 10 ROWS (if non-numeric name search), with aliases EXACT:
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
   REQUIRED:
   - Use LEFT JOIN farms and LEFT JOIN rtkTowers.
   - Apply active-only fields filter unless user explicitly requests archived/inactive.
   - If user provides a numeric field number:
       WHERE (fields.field_num = <num> OR fields.name_norm LIKE '<num>%' OR fields.name LIKE '<num>-%')
       ORDER BY fields.field_num ASC, fields.name_norm ASC
       LIMIT 1
   - If user provides a NON-numeric name query (field has no number / user didn’t give number):
       WHERE fields.name_norm LIKE '%token%' (AND each meaningful token)
       ORDER BY fields.name_norm ASC
       LIMIT 10  (to detect ambiguity; handleChat will ask user to pick if multiple)
   ALSO set:
     targetType="field"
     targetText="<string the user typed for the field target>"
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