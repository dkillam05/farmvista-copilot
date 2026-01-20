// /src/chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-20-v2-handlechat-dbready

import { detectIntent } from "./intent.js";
import { writeAnswer } from "./answerWriter.js";
import { ensureReady } from "../data/sqlite.js";
import { getFieldFullByKey, getGrainBagsDownSummary } from "../data/getters.js";

export async function handleChat(req, res) {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });

    await ensureReady();

    const intent = await detectIntent(question);

    let data;
    let prompt;

    switch ((intent?.intent || "").toUpperCase()) {
      case "FIELD_FULL":
        data = getFieldFullByKey(intent.key);
        prompt = "Write a complete field summary for operations. Include farm + county/state + tillable acres + HEL/CRP + RTK tower/network/frequency if present.";
        break;

      case "GRAIN_BAGS_DOWN":
        data = getGrainBagsDownSummary();
        prompt = "Summarize grain bags currently down. For each cropType show remaining full/partial counts and bushelsFull/bushelsPartial/bushelsTotal.";
        break;

      default:
        return res.json({ answer: "I don't know how to answer that yet in v2." });
    }

    const answer = await writeAnswer(prompt, data);
    res.json({ answer });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || String(err) });
  }
}
