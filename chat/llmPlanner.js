// /chat/llmPlanner.js  (FULL FILE)
// Rev: 2026-01-04-llmPlanner2
//
// OpenAI planner: produces a deterministic plan JSON.
// It does NOT answer with data. It only decides:
// - clarify vs execute
// - includeArchived flag
// - rewriteQuestion (canonical phrasing for your deterministic handlers)

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

export async function llmPlan({ question, threadCtx = {}, snapshot, authPresent = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");

  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY not set", plan: null };
  }

  const q = safeStr(question);
  const snapSummary = buildSchemaSummary(snapshot);

  const system = `
You are FarmVista Copilot Planner.

You output JSON ONLY (no extra text). You do NOT answer with data.

Goal:
- Decide if you should "clarify" or "execute".
- Provide rewriteQuestion (canonical) + includeArchived (boolean).

Rules:
- Default scope is ACTIVE ONLY.
- If the user question is ambiguous about scope AND likely to change the answer materially, ask ONE follow-up:
  "Active only, or include archived?"
  Use action="clarify" and set ask accordingly.
- If the user explicitly says include archived/inactive => includeArchived=true.
- If they explicitly say active only => includeArchived=false.
- Paging commands: "show all", "more", "next" should return action="execute" and rewriteQuestion exactly equal to that command.

Supported deterministic execution capabilities:
RTK:
- "How many RTK towers do we use?"
- "List RTK towers we use"
- "Fields on <tower>" (and with tillable acres)
- "What RTK tower does field <id/name> use?"
Farms/Fields/Counties:
- "How many farms do we have?"
- "List all farms"
- "How many counties do we farm in?"
- "Tillable acres by county"
- "HEL acres by farm"
- "List fields in <County> County" (and with acres)

When rewriting:
- Prefer short canonical forms like:
  - "Tillable acres by county"
  - "HEL acres by farm"
  - "List fields in Sangamon County with acres"
  - "Fields on Carlinville tower with tillable acres"
- Keep the user’s county/tower/farm names.

Return JSON matching schema exactly.
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

  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { ok: false, error: `OpenAI HTTP ${r.status}`, detail: (t || "").slice(0, 300), plan: null };
  }

  const j = await r.json();
  const txt = safeStr(j?.output_text || "");
  if (!txt) return { ok: false, error: "OpenAI returned empty plan", plan: null };

  let plan = null;
  try { plan = JSON.parse(txt); } catch { return { ok: false, error: "Invalid JSON plan from OpenAI", raw: txt, plan: null }; }

  if (!plan || (plan.action !== "execute" && plan.action !== "clarify")) {
    return { ok: false, error: "Plan missing action", raw: txt, plan: null };
  }

  plan.rewriteQuestion = safeStr(plan.rewriteQuestion) || q;
  if (plan.action === "clarify") {
    plan.ask = safeStr(plan.ask) || "Active only, or include archived?";
  }

  // includeArchived null => treat as false by default later
  return { ok: true, plan };
}