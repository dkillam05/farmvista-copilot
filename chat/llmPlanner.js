// /chat/llmPlanner.js  (FULL FILE)
// Rev: 2026-01-04-llmPlanner3-debug
//
// OpenAI planner that outputs a JSON "plan".
// It does NOT answer with farm data; it only decides how to answer.
//
// Debug:
// - Returns timing + model + plan in meta
// - If OPENAI_API_KEY is missing => ok:false

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

function envBool(name) {
  const v = safeStr(process.env[name]);
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export async function llmPlan({ question, threadCtx = {}, snapshot, authPresent = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  const debug = envBool("FV_AI_DEBUG");

  if (!apiKey) {
    return {
      ok: false,
      error: "OPENAI_API_KEY not set",
      meta: { used: false, model, ms: 0 },
      plan: null
    };
  }

  const q = safeStr(question);
  const snapSummary = buildSchemaSummary(snapshot);

  const system = `
You are FarmVista Copilot Planner.

You MUST output JSON ONLY (no extra text). You do NOT answer with data.
Your job is to produce a PLAN that the server will execute deterministically from the snapshot.

Rules:
- Default is ACTIVE ONLY.
- If scope is ambiguous AND likely to change the result materially, ask ONE follow-up:
  "Active only, or include archived?"
  Use action="clarify" and set ask accordingly.
- If user says include archived/inactive => includeArchived=true.
- If user says active only => includeArchived=false.
- Paging commands: "show all", "more", "next" => action="execute" and rewriteQuestion exactly that command.
- Prefer canonical short rewrites like:
  - "Tillable acres by county"
  - "HEL acres by farm"
  - "List fields in Sangamon County with acres"
  - "List all farms"
  - "How many counties do we farm in?"
  - "Fields on Carlinville tower with tillable acres"
  - "What RTK tower does field 0515 use?"

Supported execution domains (deterministic handlers):
RTK:
- How many RTK towers do we use?
- List RTK towers we use
- Fields on <tower> (with optional tillable acres)
- What RTK tower does field <id/name> use?
Farms/Fields/Counties:
- How many farms/counties/fields
- List all farms
- Tillable acres by county
- HEL acres by farm
- List fields in <County> County (with optional acres)

If the question is about "farm equipment", "work orders", "grain", "contracts", do NOT rewrite into farms/fields queries.
Instead, action="clarify" and ask: "Do you mean fields/farms data, or equipment/work orders/grain/contracts?"
`.trim();

  const schema = {
    name: "farmvista_plan",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["execute", "clarify"] },
        ask: { type: "string" },
        includeArchived: { type: ["boolean", "null"] },
        rewriteQuestion: { type: "string" },
        reason: { type: "string" }
      },
      required: ["action", "includeArchived", "rewriteQuestion"]
    }
  };

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
    response_format: { type: "json_schema", json_schema: schema },
    max_output_tokens: 650
  };

  const t0 = Date.now();
  let plan = null;

  // timeout guard
  const controller = new AbortController();
  const timeoutMs = Number(process.env.FV_AI_TIMEOUT_MS || 12000);
  const timer = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs));

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const ms = Date.now() - t0;

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return {
        ok: false,
        error: `OpenAI HTTP ${r.status}`,
        detail: (txt || "").slice(0, 300),
        meta: { used: true, ok: false, model, ms },
        plan: null
      };
    }

    const j = await r.json();
    const outText = safeStr(j?.output_text || "");
    if (!outText) {
      return { ok: false, error: "OpenAI returned empty plan", meta: { used: true, ok: false, model, ms }, plan: null };
    }

    try { plan = JSON.parse(outText); }
    catch {
      return { ok: false, error: "Invalid JSON plan from OpenAI", meta: { used: true, ok: false, model, ms, raw: debug ? outText : undefined }, plan: null };
    }

    // normalize fields
    if (!plan || (plan.action !== "execute" && plan.action !== "clarify")) {
      return { ok: false, error: "Plan missing action", meta: { used: true, ok: false, model, ms, raw: debug ? outText : undefined }, plan: null };
    }

    plan.rewriteQuestion = safeStr(plan.rewriteQuestion) || q;
    if (plan.action === "clarify") plan.ask = safeStr(plan.ask) || "Active only, or include archived?";

    return {
      ok: true,
      meta: { used: true, ok: true, model, ms, plan: debug ? plan : undefined },
      plan
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      ok: false,
      error: e?.name === "AbortError" ? "OpenAI timeout" : (e?.message || String(e)),
      meta: { used: true, ok: false, model, ms },
      plan: null
    };
  } finally {
    clearTimeout(timer);
  }
}