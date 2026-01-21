// /src/chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-21-v2-handlechat-active-default-county-suite
//
// Enforces: ACTIVE ONLY by default.
// If includeArchived=true, the county getters return separated active vs archived sections.

import { detectIntent } from "./intent.js";
import { writeAnswer } from "./answerWriter.js";
import { ensureReady } from "../data/sqlite.js";

import {
  getFieldFullByKey,
  getGrainBagsDownSummary,
  getRtkTowerCount,
  getRtkTowerList,
  getFieldsByRtkTowerKey,
  getCountySummary,
  getCountyStatsByKey,
  getFieldsInCounty,
  getFarmsInCounty
} from "../data/getters/index.js";

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
    const includeArchived = intent?.includeArchived === true;

    let data;
    let prompt;

    switch ((intent?.intent || "").toUpperCase()) {
      case "FIELD_FULL":
        data = getFieldFullByKey(intent.key, { includeArchived });
        prompt =
          "Write a complete field summary for operations. Default is ACTIVE ONLY. If the field is archived, clearly label it ARCHIVED. Include farm + county/state + tillable acres + HEL/CRP + RTK tower/network/frequency if present.";
        break;

      case "GRAIN_BAGS_DOWN":
        data = getGrainBagsDownSummary();
        prompt =
          "Summarize grain bags currently down. For each cropType show remaining full/partial counts and bushelsFull/bushelsPartial/bushelsTotal.";
        break;

      case "RTK_TOWER_COUNT":
        data = getRtkTowerCount();
        prompt =
          "Answer in one sentence with the total count of RTK towers.";
        break;

      case "RTK_TOWER_LIST":
        data = getRtkTowerList({ includeArchived });
        prompt =
          "List all RTK towers. Default is ACTIVE ONLY (fieldCount based on active fields). For each include towerName, networkId, frequency, and fieldCount. Keep it readable.";
        break;

      case "RTK_TOWER_FIELDS":
        data = getFieldsByRtkTowerKey(intent.key, { includeArchived });
        prompt =
          "Show the RTK tower info (name, network, frequency). Default is ACTIVE ONLY. Then list the ACTIVE fields assigned to it. If includeArchived=true and there are archived fields, show a separate ARCHIVED section.";
        break;

      case "COUNTIES_FARMED":
        data = getCountySummary({ includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Answer how many counties we farm in (active). Then list each active county with fieldCount and tillableAcres. If includeArchived=true, add a separate ARCHIVED-ONLY section for counties that have zero active fields.";
        break;

      case "COUNTY_FIELDS":
        data = getFieldsInCounty(intent.key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Show the county name, then list ACTIVE fields in that county. For each field show fieldName, farmName, acresTillable, and HEL/CRP acres if any. If includeArchived=true and there are archived fields, show them in a separate ARCHIVED section.";
        break;

      case "COUNTY_FARMS":
        data = getFarmsInCounty(intent.key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Show the county name, then list farms that have ACTIVE fields in that county. For each farm show farmName, fieldCount, and tillableAcres. If includeArchived=true, include a separate ARCHIVED section.";
        break;

      case "COUNTY_STATS":
        data = getCountyStatsByKey(intent.key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Give county totals for ACTIVE fields: fieldCount, tillableAcres, HEL acres + helFieldCount, CRP acres + crpFieldCount. If includeArchived=true, also show a separate ARCHIVED totals section.";
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
        key: intent?.key || "",
        includeArchived: includeArchived
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
