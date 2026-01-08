// /chat/entityResolverAI.js  (FULL FILE)
// Rev: 2026-01-06-entityResolverAI2
//
// OpenAI-based "did you mean...?" resolver.
// No deterministic fuzzy logic: OpenAI chooses from a truth-set list.
//
// Returns:
//  { ok:true, action:"retry", match:"<exact candidate>", confidence:"high|medium|low" }
//  { ok:true, action:"clarify", ask:"...", options:["..."] }
//  { ok:true, action:"no_match" }
//  { ok:false, error:"..." }

'use strict';

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export async function resolveEntityWithOpenAI({
  entityType,
  userText,
  candidates,
  debug = false
}) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY not set", meta: { model } };

  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return { ok: true, action: "no_match" };

  // keep prompt small and stable
  const trimmed = list.slice(0, 220);

  const system = `
You are a name resolver for FarmVista.

The database lookup returned 0 rows. You must decide if the user made a typo and which item from the provided list is the closest match.

Return ONLY valid JSON in one of these shapes:

1) Retry:
{ "action":"retry", "match":"<EXACT item from list>", "confidence":"high|medium|low" }

2) Clarify (only if multiple plausible):
{ "action":"clarify", "ask":"<question>", "options":["<EXACT item>","<EXACT item>"] }

3) No match:
{ "action":"no_match" }

Rules:
- match MUST be exactly one of the provided list items.
- options MUST be values exactly from the list.
- If it looks like a simple typo (Sean creek vs Swan Creek), choose retry with confidence "high".
- If the user text is too vague (e.g., "need tower info") choose clarify asking which ${entityType}.
`.trim();

  const user = `
Entity type: ${entityType}
User text: ${userText}

Candidate names:
${trimmed.join("\n")}
`.trim();

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_output_tokens: 350
  };

  const t0 = Date.now();
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const ms = Date.now() - t0;

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return {
        ok: false,
        error: `OpenAI HTTP ${r.status}`,
        meta: { model, ms, detail: debug ? txt.slice(0, 2000) : txt.slice(0, 250) }
      };
    }

    const j = await r.json();
    const outText = safeStr(j?.output_text || "");

    let parsed = null;
    try { parsed = JSON.parse(outText); }
    catch {
      return {
        ok: false,
        error: "resolver_non_json",
        meta: { model, ms, detail: debug ? outText.slice(0, 2000) : outText.slice(0, 250) }
      };
    }

    const action = safeStr(parsed?.action || "").toLowerCase();
    const match = safeStr(parsed?.match || "");
    const confidence = safeStr(parsed?.confidence || "low").toLowerCase();
    const ask = safeStr(parsed?.ask || "");

    if (action === "retry") {
      if (!match || !trimmed.includes(match)) {
        return { ok: false, error: "resolver_bad_match", meta: { model, ms, match } };
      }
      return { ok: true, action: "retry", match, confidence, meta: { model, ms } };
    }

    if (action === "clarify") {
      const rawOpts = Array.isArray(parsed?.options) ? parsed.options.map(safeStr).filter(Boolean) : [];
      const options = rawOpts.filter(o => trimmed.includes(o)).slice(0, 4);
      return { ok: true, action: "clarify", ask: ask || `Which ${entityType} did you mean?`, options, confidence, meta: { model, ms } };
    }

    if (action === "no_match") {
      return { ok: true, action: "no_match", confidence, meta: { model, ms } };
    }

    return { ok: false, error: "resolver_unknown_action", meta: { model, ms, action } };
  } catch (e) {
    return { ok: false, error: safeStr(e?.message || e) };
  }
}