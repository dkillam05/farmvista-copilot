// /chat/llmPlanner.js  (FULL FILE)
// Rev: 2026-01-04-llmPlanner1
//
// OpenAI planner:
// - Reads question + small snapshot summary + thread context
// - Returns JSON plan: { action: "execute"|"clarify", rewriteQuestion?, includeArchived?, ask? }

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

  const PREVIEW = 6;

  for (const name of names) {
    const map = cols?.[name] || {};
    const keys = Object.keys(map || {});
    counts[name] = keys.length;

    if (name === "farms" || name === "fields" || name === "rtkTowers") {
      const vals = firstValues(map, PREVIEW).map(v => (v?.name || "").toString()).filter(Boolean);
      previews[name] = vals;
    } else {
      previews[name] = keys.slice(0, PREVIEW);
    }
  }

  return { counts, previews };
}

export async function llmPlan({ question, threadCtx = {}, snapshot, authPresent = false }) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");

  if (!apiKey) {
    return {
      ok: false,
      error: "OPENAI_API_KEY not set",
      plan: null
    };
  }

  const q = safeStr(question);
  const snapSummary = buildSchemaSummary(snapshot);

  const system = `
You are FarmVista Copilot Planner.

You MUST:
- Decide whether to ASK A CLARIFYING QUESTION (action="clarify") or EXECUTE (action="execute").
- Never fabricate data. You do not answer with data; you only output a plan.
- Plans must be grounded in snapshot-only operations supported by the app.

Key rules:
- Default scope is ACTIVE ONLY unless the user explicitly says include archived/inactive.
- If the user’s request depends on scope and could change the answer materially, ask a single clarifying question: "Active only, or include archived?"
- Follow-ups like "show all", "more", "next" are paging commands (handled elsewhere). If the user asks those, action should still be "execute" with rewriteQuestion equal to that command.

Supported domains:
1) RTK:
   - "How many RTK towers do we use?"
   - "List RTK towers we use"
   - "Fields on <tower>"
   - "Fields on <tower> with tillable acres"
   - "What RTK tower does field <id/name> use?"
2) Farms/Fields/Counties:
   - "How many fields/farms/counties"
   - "List farms"
   - "Counties we farm in with tillable acres per county"
   - "Tillable acres by county" / "HEL acres by farm"
   - "List fields in <County> County (with acres / by farm)"

Output JSON ONLY matching schema.
`;

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
      { role: "system", content: system.trim() },
      { role: "user", content: JSON.stringify(user) }
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_output_tokens: 600
  };

  const r = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
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

  // hard safety: ensure shape
  if (!plan || (plan.action !== "execute" && plan.action !== "clarify")) {
    return { ok: false, error: "Plan missing action", plan: null, raw: txt };
  }

  // If clarify, ask should be present; rewriteQuestion can be the original question.
  if (plan.action === "clarify") {
    const ask = safeStr(plan.ask) || "Active only, or include archived?";
    plan.ask = ask;
  }

  plan.rewriteQuestion = safeStr(plan.rewriteQuestion) || q;
  return { ok: true, plan };
}