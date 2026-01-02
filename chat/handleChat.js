// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-02-openai-always1
//
// IMPORTANT:
// - Provides NAMED export: handleChat (required by index.js)
// - Uses OpenAI for EVERY question (if OPENAI_API_KEY is set)
// - If key is missing, returns a short error (no guessing)

'use strict';

export async function handleChat({ question, snapshot, history, state }) {
  const q = (question || "").toString().trim();
  if (!q) {
    return { answer: "Missing question.", meta: { intent: "chat", error: true } };
  }

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  if (!apiKey) {
    return {
      answer: "OPENAI_API_KEY is not set on the Cloud Run service.",
      meta: { intent: "chat", error: true, usedOpenAI: false }
    };
  }

  try {
    const answer = await callOpenAI({ apiKey, model, question: q, history });
    return {
      answer: (answer || "").trim() || "No answer.",
      meta: { intent: "chat", usedOpenAI: true, model }
    };
  } catch (e) {
    return {
      answer: "OpenAI error.",
      meta: { intent: "chat", error: true, usedOpenAI: false, detail: e?.message || String(e) }
    };
  }
}

async function callOpenAI({ apiKey, model, question, history }) {
  // Keep it simple and direct. No fake Q&A.
  const input = [
    {
      role: "system",
      content:
        "You are FarmVista Copilot. Give direct, practical answers. " +
        "If you truly need a choice, ask ONE short question with 1–3 options and ask the user to reply 1/2/3. " +
        "Do not mention internal code, logs, snapshots, or revisions."
    }
  ];

  // Include a small amount of recent context (optional)
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  for (const h of recent) {
    const role = (h?.role || "").toString().toLowerCase() === "assistant" ? "assistant" : "user";
    const text = (h?.text || "").toString().trim();
    if (text) input.push({ role, content: text });
  }

  input.push({ role: "user", content: question });

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: 700
    })
  });

  if (!resp.ok) {
    const t = await safeText(resp);
    throw new Error(`OpenAI HTTP ${resp.status}: ${t || resp.statusText}`);
  }

  const json = await resp.json();

  // Prefer output_text if present
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // Fallback extraction
  try {
    const out = json?.output;
    if (Array.isArray(out)) {
      let acc = "";
      for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") acc += c.text;
        }
      }
      return acc.trim();
    }
  } catch {}

  return "";
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
