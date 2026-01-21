// /src/chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-20-v2-handlechat-splitgetters-acceptText-returnTextMeta
//
// Fix:
// ✅ Accept payload.text (FarmVista UI) AND payload.question (console/tools)
// ✅ Return response.text (preferred) AND response.answer (compat)
// ✅ Include meta so UI can show AI proof footer
// ✅ Preserve split getters + existing prompts

import { detectIntent } from "./intent.js";
import { writeAnswer } from "./answerWriter.js";
import { ensureReady } from "../data/sqlite.js";
import { getFieldFullByKey, getGrainBagsDownSummary } from "../data/getters/index.js";

function pickPrompt(body) {
  const q = (body?.question ?? "").toString().trim();
  const t = (body?.text ?? "").toString().trim();
  return q || t;
}

export async function handleChat(req, res) {
  try {
    const promptIn = pickPrompt(req.body);
    if (!promptIn) {
      return res.status(400).json({ ok: false, error: "Missing text/question" });
    }

    await ensureReady();

    // OpenAI intent detection
    const intent = await detectIntent(promptIn);

    let data;
    let prompt;

    switch ((intent?.intent || "").toUpperCase()) {
      case "FIELD_FULL":
        data = getFieldFullByKey(intent.key);
        prompt =
          "Write a complete field summary for operations. Include farm + county/state + tillable acres + HEL/CRP + RTK tower/network/frequency if present.";
        break;

      case "GRAIN_BAGS_DOWN":
        data = getGrainBagsDownSummary();
        prompt =
          "Summarize grain bags currently down. For each cropType show remaining full/partial counts and bushelsFull/bushelsPartial/bushelsTotal.";
        break;

      default: {
        const msg = "I don't know how to answer that yet in v2.";
        return res.json({
          ok: true,
          text: msg,
          answer: msg,
          meta: {
            usedOpenAI: true,
            provider: "OpenAI",
            model: "gpt-4.1-mini",
            route: "/chat",
            intent: intent?.intent || "UNKNOWN"
          }
        });
      }
    }

    // OpenAI answer writing
    const outText = await writeAnswer(prompt, data);

    res.json({
      ok: true,
      text: outText,
      answer: outText,
      meta: {
        usedOpenAI: true,
        provider: "OpenAI",
        model: "gpt-4.1-mini",
        route: "/chat",
        intent: intent.intent,
        key: intent.key || ""
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}