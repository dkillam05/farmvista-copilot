// /src/chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-20-v2-handlechat-rtk-count
//
// Supports:
// - payload.text or payload.question
// - intents: FIELD_FULL, GRAIN_BAGS_DOWN, RTK_TOWER_COUNT
// - returns ok/text/meta for FarmVista UI

import { detectIntent } from "./intent.js";
import { writeAnswer } from "./answerWriter.js";
import { ensureReady } from "../data/sqlite.js";
import { getFieldFullByKey, getGrainBagsDownSummary, getRtkTowerCount } from "../data/getters/index.js";

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

      case "RTK_TOWER_COUNT":
        data = getRtkTowerCount();
        prompt =
          "Answer in one sentence with the total count. If count is 0, say none are in the system.";
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
        intent: (intent?.intent || "").toUpperCase(),
        key: intent?.key || ""
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}