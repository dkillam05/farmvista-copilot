// /chat/sqlPlanner.js  (FULL FILE)
// Rev: 2026-01-06-sqlPlanner1
//
// OpenAI -> SQL planner (SELECT-only).
// Returns { ok, sql, meta }.
// No response_format (avoids 400s). We force JSON via prompt.

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
  Active-only rule: fields.status is NULL/empty OR NOT IN ('archived','inactive').
  Farm active-only: farms.status is NULL/empty OR NOT IN ('archived','inactive').
- Always add LIMIT 80 unless question implies a smaller number.
- Use these tables/columns:

farms(id, name, status, name_norm, name_sq)
fields(id, name, status, farmId, county, state, tillable, helAcres, crpAcres, rtkTowerId, name_norm, name_sq, county_norm, state_norm, field_num)
rtkTowers(id, name, frequencyMHz, networkId, name_norm, name_sq)

Joins:
fields.farmId = farms.id
fields.rtkTowerId = rtkTowers.id

Shorthand matching:
- Use *_norm LIKE '%token%' for user text (lowercase tokens).
- Counties: fields.county_norm LIKE '%macoupin%'
- Farms: farms.name_norm LIKE '%cville%'
- Towers: rtkTowers.name_norm LIKE '%carlinville%'

Ordering:
- Field lists should use ORDER BY fields.field_num ASC, fields.name_norm ASC
- Farm/county/tower lists default ORDER BY name A-Z unless asked "largest first" / "descending".

If a question is ambiguous (needs farm vs county etc), still choose the most likely interpretation and write SQL for it.
`.trim();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: q }
    ],
    max_output_tokens: 800
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
      // fallback extract
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