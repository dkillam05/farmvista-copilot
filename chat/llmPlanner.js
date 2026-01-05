// /chat/llmPlanner.js  (FULL FILE)
// Rev: 2026-01-04-llmPlanner4-request-debug
//
// OpenAI planner.
// Returns: { ok, plan, meta }
// meta always includes: used, ok, model, ms, error?

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

  function firstValues(obj, limit) { try { return Object.values(obj || {}).slice(0, limit); } catch { return []; } }
  function firstKeys(obj, limit) { try { return Object.keys(obj || {}).slice(0, limit); } catch { return []; } }

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

  const system = `
You are FarmVista Copilot Planner.

You MUST output JSON ONLY (no extra text). You do NOT answer with data.
You produce a PLAN that the server will execute deterministically from the snapshot.

Rules:
- Default scope is ACTIVE ONLY.
- If scope is ambiguous AND likely to change the answer materially, ask ONE follow-up:
  "Active only, or include archived?"
  action="clarify" and set ask.
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

Supported deterministic execution:
RTK:
- How many RTK towers do we use?
- List RTK towers we use
- Fields on <tower> (optional tillable acres)
- What RTK tower does field <id/name> use?
Farms/Fields/Counties:
- How many farms/counties/fields
- List all farms
- Tillable acres by county
- HEL acres by farm
- List fields in <County> County (optional acres)

If the question is about equipment/work orders/grain/contracts and not fields/farms, action="clarify" and ask:
"Do you mean fields/farms data, or equipment/work orders/grain/contracts?"
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
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const ms = Date.now() - t0;

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: `OpenAI HTTP ${r.status}`, detail: (txt || "").slice(0, 200) } };
    }

    const j = await r.json();
    const outText = safeStr(j?.output_text || "");
    if (!outText) return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: "OpenAI returned empty plan" } };

    let plan = null;
    try { plan = JSON.parse(outText); }
    catch {
      return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: "Invalid JSON plan", raw: debug ? outText : undefined } };
    }

    if (!plan || (plan.action !== "execute" && plan.action !== "clarify")) {
      return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: "Plan missing action", raw: debug ? outText : undefined } };
    }

    plan.rewriteQuestion = safeStr(plan.rewriteQuestion) || q;
    if (plan.action === "clarify") plan.ask = safeStr(plan.ask) || "Active only, or include archived?";

    return { ok: true, plan, meta: { used: true, ok: true, model, ms, plan: debug ? plan : undefined } };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, plan: null, meta: { used: true, ok: false, model, ms, error: e?.message || String(e) } };
  }
}