// /chat/llmPlanner.js  (FULL FILE)
// Rev: 2026-01-05-llmPlanner5-jsonobject
//
// Fix:
// ✅ Avoid json_schema (can trigger OpenAI HTTP 400 in some setups)
// ✅ Use response_format: json_object and strict prompting
// ✅ Capture OpenAI error body for debugging when debug=true

'use strict';

const OPENAI_URL = "https://api.openai.com/v1/responses";

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

function buildSchemaSummary(snapshot) {
  const root = snapshot?.json || {};
  const cols =
    root?.data?.__collections__ ||
    root?.__collections__ ||
    (root?.data && root.data.farms && root.data.fields ? root.data : null) ||
    (root?.farms && root?.fields ? root : null) ||
    {};

  const counts = {};
  const previews = {};
  const names = Object.keys(cols || {}).sort((a, b) => a.localeCompare(b));

  function firstValues(obj, limit) {
    try { return Object.values(obj || {}).slice(0, limit); } catch { return []; }
  }
  function firstKeys(obj, limit) {
    try { return Object.keys(obj || {}).slice(0, limit); } catch { return []; }
  }

  const PREVIEW = 6;

  for (const name of names) {
    const map = cols?.[name] || {};
    counts[name] = Object.keys(map).length;

    if (name === "farms" || name === "fields" || name === "rtkTowers") {
      previews[name] = firstValues(map, PREVIEW).map(v => (v?.name || "").toString()).filter(Boolean);
    } else {
      previews[name] = firstKeys(map, PREVIEW);
    }
  }

  return { counts, previews };
}

export async function llmPlan({ question, threadCtx = {}, snapshot, authPresent = false, debug = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");

  if (!apiKey) {
    return { ok: false, plan: null, meta: { used: false, ok: false, model, ms: 0, error: "OPENAI_API_KEY not set" } };
  }

  const q = safeStr(question);
  const snapSummary = buildSchemaSummary(snapshot);

  // IMPORTANT: json_object mode requires we tell it to output JSON only
  const system = `
You are FarmVista Copilot Planner.

Return ONLY valid JSON (no markdown, no extra text).

You do NOT answer with data. You only output a PLAN with this shape:
{
  "action": "execute" | "clarify",
  "includeArchived": true | false | null,
  "rewriteQuestion": "<canonical question to execute>",
  "ask": "<single follow-up question if action=clarify>",
  "reason": "<short reason>"
}

Rules:
- Default scope is ACTIVE ONLY.
- If scope is ambiguous and could change the result, action="clarify" and ask: "Active only, or include archived?"
- If user explicitly says include archived/inactive => includeArchived=true.
- If user explicitly says active only => includeArchived=false.
- Paging commands: "show all", "more", "next" => action="execute" and rewriteQuestion exactly that command.

Canonical rewrite examples:
- "Tillable acres by county"
- "HEL acres by farm"
- "List fields in Sangamon County with acres"
- "List all farms"
- "How many counties do we farm in?"
- "List fields on Carlinville tower with tillable acres"
- "What RTK tower does field 0515 use?"

Supported deterministic domains:
RTK (towers, fields on tower, field->tower)
Farms/Fields/Counties (counts, lists, grouped sums)

If user asks about equipment/work orders/grain/contracts and not fields/farms:
action="clarify" and ask: "Do you mean fields/farms data, or equipment/work orders/grain/contracts?"
`.trim();

  const user = {
    question: q,
    authPresent: !!authPresent,
    snapshotCollections: snapSummary.counts,
    snapshotPreview: snapSummary.previews,
    threadContext: threadCtx || {}
  };

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ],
    response_format: { type: "json_object" },
    max_output_tokens: 700
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
        plan: null,
        meta: {
          used: true,
          ok: false,
          model,
          ms,
          error: `OpenAI HTTP ${r.status}`,
          detail: debug ? txt.slice(0, 1200) : txt.slice(0, 200)
        }
      };
    }

    const j = await r.json();

    // Responses API: output_text may be empty; prefer output[0].content style, but output_text is easiest when present
    let outText = safeStr(j?.output_text || "");
    if (!outText) {
      // try to extract text from structured output
      try {
        const chunks = [];
        for (const item of (j.output || [])) {
          for (const c of (item.content || [])) {
            const t = safeStr(c?.text || c?.output_text || "");
            if (t) chunks.push(t);
          }
        }
        outText = chunks.join("\n").trim();
      } catch {}
    }

    if (!outText) {
      return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: "OpenAI returned empty plan" } };
    }

    let plan = null;
    try { plan = JSON.parse(outText); }
    catch {
      return {
        ok: false,
        plan: null,
        meta: { used: true, ok: false, model, ms, error: "Planner returned non-JSON", detail: debug ? outText.slice(0, 1200) : outText.slice(0, 200) }
      };
    }

    // Minimal validation + defaults
    const action = safeStr(plan?.action);
    if (action !== "execute" && action !== "clarify") {
      return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: "Plan missing valid action", detail: debug ? outText.slice(0, 1200) : outText.slice(0, 200) } };
    }

    const rewriteQuestion = safeStr(plan?.rewriteQuestion) || q;
    const includeArchived = (plan?.includeArchived === true) ? true : (plan?.includeArchived === false ? false : null);
    const ask = safeStr(plan?.ask);

    const finalPlan = {
      action,
      includeArchived,
      rewriteQuestion,
      ask: action === "clarify" ? (ask || "Active only, or include archived?") : undefined,
      reason: safeStr(plan?.reason) || ""
    };

    return {
      ok: true,
      plan: finalPlan,
      meta: { used: true, ok: true, model, ms, plan: debug ? finalPlan : undefined }
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: e?.message || String(e) } };
  }
}