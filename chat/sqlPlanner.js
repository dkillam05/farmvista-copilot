// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-08-sqlPlanner12-drilldown-fields-metric
//
// Fix (foundation, not band-aid):
// ✅ Adds DRILLDOWN intent: list_fields_metric
//    - "What field in Morgan County has HEL?" => returns only fields where helAcres > 0
//    - Also supports CRP and Tillable
//
// ✅ Improves county dedupe (De Witt vs DeWitt) using county_key = REPLACE(county_norm,' ','')
//
// Keeps:
// ✅ group_metric contract uses groupName (NOT reserved "group")
// ✅ field_info contract (full field card, RTK always)
// ✅ list_counties contract (deduped)
// ✅ list_fields, list_rtk_towers, rtk_tower_info strict contracts

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

CRITICAL DRILLDOWN RULE (NO EXCEPTIONS):
If the user asks for FIELDS in a SPECIFIC COUNTY (or "what field ... in Morgan county") AND mentions:
- hel OR crp OR tillable OR acres
intent MUST be "list_fields_metric" (NOT group_metric, NOT list_fields).

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
   - Numeric field number => LIMIT 1 and ORDER BY fields.field_num ASC, fields.name_norm ASC
   - Non-numeric name query => ORDER BY fields.name_norm ASC and LIMIT 10
   ALSO set:
     targetType="field"
     targetText="<string the user typed for the field target>"

5) intent="list_counties"   (DEDUPED)
   PURPOSE:
     List all counties we farm in (active fields by default), deduping "De Witt" vs "DeWitt".
   SQL MUST return aliases EXACT:
     county AS county,
     state AS state
   REQUIRED:
   - Define county_key = REPLACE(fields.county_norm,' ','')
   - GROUP BY county_key, fields.state_norm
   - Display county/state from MIN(TRIM(fields.county)) / MIN(TRIM(fields.state))
   - Filter out blanks
   - ORDER BY LOWER(county) ASC, LOWER(state) ASC
   - LIMIT 300

6) intent="group_metric"
   PURPOSE:
     Return a metric grouped by county or by farm.
   SQL MUST return aliases EXACT:
     groupName AS groupName,
     value AS value
   REQUIRED:
   - Determine metric column:
       HEL => SUM(fields.helAcres)
       CRP => SUM(fields.crpAcres)
       Tillable/acres => SUM(fields.tillable)
   - Determine grouping:
       By county / per county / each county:
         use county_key = REPLACE(fields.county_norm,' ','')
         GROUP BY county_key, fields.state_norm
         groupName label must be:
           CASE WHEN TRIM(COALESCE(MIN(fields.state),''))<>'' THEN MIN(TRIM(fields.county)) || ', ' || MIN(TRIM(fields.state)) ELSE MIN(TRIM(fields.county)) END
         ORDER BY LOWER(groupName) ASC
       By farm / per farm / each farm:
         GROUP BY farms.name_norm
         groupName label must be MIN(farms.name)
         ORDER BY LOWER(groupName) ASC
   - Apply active-only filter unless include archived requested
   - LIMIT 200

7) intent="list_fields_metric"   (DRILLDOWN)
   PURPOSE:
     List fields that contribute to a metric within a specific county (or farm).
     Example: "What field in Morgan county has HEL?" => list fields in Morgan where helAcres > 0.

   SQL MUST return aliases EXACT:
     fields.id AS field_id,
     fields.name AS field,
     value AS value
   Where value is one of:
     fields.helAcres (HEL)
     fields.crpAcres (CRP)
     fields.tillable (Tillable)

   REQUIRED:
   - Apply active-only fields filter unless include archived requested
   - Metric filter:
       HEL => fields.helAcres > 0
       CRP => fields.crpAcres > 0
       Tillable/acres => fields.tillable > 0
   - If question specifies a county (most common):
       filter by fields.county_norm LIKE '%token%' for the county token(s)
       ORDER BY value DESC, fields.name_norm ASC
       LIMIT 200
   - If question specifies a farm instead:
       JOIN farms and filter by farms.name_norm LIKE '%token%'
       ORDER BY value DESC, fields.name_norm ASC
       LIMIT 200

   ALSO set:
     targetType="county" (or "farm" if farm drilldown)
     targetText="<the county/farm text user typed>"
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