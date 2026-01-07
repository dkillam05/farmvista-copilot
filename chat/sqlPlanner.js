// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-06-sqlPlanner2-field-number-tower
//
// Adds:
// ✅ Explicit pattern for "Field #### tower info" and "what tower does field #### use"
// ✅ Uses fields.id OR fields.name_norm startswith digits OR fields.field_num
//
// Returns SELECT-only SQL JSON: { "sql": "...", "notes": "..." }

'use strict';

const OPENAI_URL = "https://api.openai.com/v1/responses";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export async function planSql({ question, debug = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  if (!apiKey) return { ok: false, sql: "", meta: { used: false, error: "OPENAI_API_KEY not set", model } };

  const q = safeStr(question);

  const system = `
You are a SQL generator for FarmVista Copilot.
Return ONLY valid JSON with this shape:
{
  "sql": "SELECT ...",
  "notes": "optional"
}

Rules:
- SQLite dialect.
- SELECT statements ONLY. No semicolons.
- Default scope is ACTIVE ONLY unless user says include archived/inactive.
  Active-only rule for fields: fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive')
  Active-only rule for farms: farms.status IS NULL OR farms.status='' OR LOWER(farms.status) NOT IN ('archived','inactive')
- Always add LIMIT 80 unless question implies a smaller number.

Tables/columns:
farms(id, name, status, name_norm, name_sq)
fields(id, name, status, farmId, county, state, tillable, helAcres, crpAcres, rtkTowerId, name_norm, name_sq, county_norm, state_norm, field_num)
rtkTowers(id, name, frequencyMHz, networkId, name_norm, name_sq)

Joins:
fields.farmId = farms.id
fields.rtkTowerId = rtkTowers.id

Shorthand matching:
- Use *_norm LIKE '%token%' for user text (tokens are lowercase words).
- Counties: fields.county_norm LIKE '%macoupin%'
- Farms: farms.name_norm LIKE '%cville%'
- Towers: rtkTowers.name_norm LIKE '%carlinville%'

Ordering:
- Field lists: ORDER BY fields.field_num ASC, fields.name_norm ASC
- Farm/county/tower lists default A-Z unless asked "largest first"/"descending".

CRITICAL PATTERN (must handle):
If user mentions a FIELD NUMBER like 1323 (3–4 digits) and asks RTK/tower info, generate SQL like:
SELECT
  fields.name AS field,
  farms.name AS farm,
  fields.county AS county,
  fields.state AS state,
  rtkTowers.name AS tower,
  rtkTowers.frequencyMHz AS frequencyMHz,
  rtkTowers.networkId AS networkId
FROM fields
LEFT JOIN farms ON farms.id = fields.farmId
LEFT JOIN rtkTowers ON rtkTowers.id = fields.rtkTowerId
WHERE
  (fields.field_num = 1323 OR fields.id = '1323' OR fields.name_norm LIKE '1323%' OR fields.name LIKE '1323-%')
  AND (fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive'))
LIMIT 5

If user asks "what tower does field #### use" use the same WHERE and return tower columns.

If ambiguous, choose most likely interpretation and still return SQL.
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
      return { ok: false, sql: "", meta: { used: true, error: `OpenAI HTTP ${r.status}`, detail: debug ? txt.slice(0, 2000) : txt.slice(0, 250), model, ms } };
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
      return { ok: false, sql: "", meta: { used: true, error: "Planner returned non-JSON", detail: debug ? outText.slice(0, 2000) : outText.slice(0, 250), model, ms } };
    }

    const sql = safeStr(parsed?.sql);
    if (!sql) return { ok: false, sql: "", meta: { used: true, error: "Missing sql", model, ms } };

    return { ok: true, sql, meta: { used: true, ok: true, model, ms, notes: safeStr(parsed?.notes || ""), sql: debug ? sql : undefined } };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, sql: "", meta: { used: true, error: e?.message || String(e), model, ms } };
  }
}