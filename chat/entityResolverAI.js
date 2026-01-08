// /chat/entityResolver.js  (FULL FILE)
// Rev: 2026-01-06-entityResolver1-openai
//
// Uses OpenAI to resolve a misspelled/partial entity string against a candidate list.
// Returns either:
// - { action:"retry", match:"Swan Creek", confidence:"high" }
// - { action:"clarify", ask:"Did you mean Swan Creek or ...?" }
// - { action:"no_match" }

'use strict';

function safeStr(v) { return (v == null ? "" : String(v)).trim(); }

export async function resolveEntityWithOpenAI({
  userText,
  entityType,
  candidates,
  debug = false
}) {
  const apiKey = safeStr(process.env.OPENAI_API_KEY);
  const model = safeStr(process.env.OPENAI_MODEL || "gpt-4.1-mini");
  if (!apiKey) return { ok: false, action: "error", error: "OPENAI_API_KEY not set" };

  const list = Array.isArray(candidates) ? candidates.filter(Boolean).slice(0, 250) : [];
  if (!list.length) return { ok: false, action: "error", error: "No candidates available" };

  const system = `
You are a fuzzy matcher for FarmVista entity names.

Entity type: ${entityType}

You MUST choose from the provided list. Return ONLY valid JSON:

{ "action": "retry|clarify|no_match",
  "match": "<exact item from list or empty>",
  "ask": "<question if clarify else empty>",
  "confidence": "high|medium|low"
}

Rules:
- If there is a very close typo match, action="retry" and match MUST be exactly one item from list.
- If multiple plausible, action="clarify" and ask should present up to 3 options from list.
- If none plausible, action="no_match".
- Never invent names not in list.
`.trim();

  const user = `
User text: ${userText}

Candidates:
${list.join("\n")}
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
      return { ok: false, action: "error", error: `OpenAI HTTP ${r.status}`, detail: debug ? txt.slice(0, 2000) : txt.slice(0, 250), model, ms };
    }

    const j = await r.json();
    const outText = safeStr(j?.output_text || "");
    let parsed = null;
    try { parsed = JSON.parse(outText); } catch {
      return { ok: false, action: "error", error: "non_json", detail: debug ? outText.slice(0, 2000) : outText.slice(0, 250), model, ms };
    }

    const action = safeStr(parsed?.action || "").toLowerCase();
    const match = safeStr(parsed?.match || "");
    const ask = safeStr(parsed?.ask || "");
    const confidence = safeStr(parsed?.confidence || "low").toLowerCase();

    const inList = match ? list.includes(match) : false;

    if (action === "retry") {
      if (!match || !inList) {
        return { ok: false, action: "error", error: "invalid_retry_match", detail: debug ? outText : "", model, ms };
      }
      return { ok: true, action: "retry", match, confidence, model, ms };
    }

    if (action === "clarify") {
      return { ok: true, action: "clarify", match: "", ask: ask || "Which one did you mean?", confidence, model, ms };
    }

    if (action === "no_match") {
      return { ok: true, action: "no_match", match: "", ask: "", confidence, model, ms };
    }

    return { ok: false, action: "error", error: "bad_action", detail: debug ? outText : "", model, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, action: "error", error: safeStr(e?.message || e), model, ms };
  }
}