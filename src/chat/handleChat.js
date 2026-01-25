// /src/chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-23-v6-handlechat-add-hel-crp-totals
//
// Enforces: ACTIVE ONLY by default.
// includeArchived=true requests separated archived results (where getter supports it).
//
// Update:
// - HEL_TOTALS / CRP_TOTALS / HEL_CRP_TOTALS now supported.
// - Uses toggle-first logic in getter: hasHEL/hasCRP determines field counts; acres sum only when toggle is on.

import { detectIntent } from "./intent.js";
import { writeAnswer } from "./answerWriter.js";
import { ensureReady } from "../data/sqlite.js";

import {
  getFieldFullByKey,
  getGrainBagsDownSummary,
  getGrainBagsReport,
  getRtkTowerCount,
  getRtkTowerList,
  getFieldsByRtkTowerKey,
  getCountySummary,
  getCountyStatsByKey,
  getFieldsInCounty,
  getFarmsInCounty,

  // NEW
  getBoundaryRequests,
  getFieldMaintenance,
  getEquipment,
  getEquipmentMakes,
  getEquipmentModels,
  getBinSites,
  getBinMovements,

  // NEW: HEL/CRP totals
  getHelCrpTotals
} from "../data/getters/index.js";

function pickPrompt(body) {
  const q = (body?.question ?? "").toString().trim();
  const t = (body?.text ?? "").toString().trim();
  return q || t;
}

function normKey(x){
  return (x ?? "").toString().trim();
}

function lower(x){
  return (x ?? "").toString().trim().toLowerCase();
}

function looksLikeFirestoreId(s){
  const t = normKey(s);
  return t.length >= 18 && t.length <= 40 && /^[A-Za-z0-9_-]+$/.test(t);
}

function isBagCountQuestion(s){
  const t = (s ?? "").toString().toLowerCase();
  const asksCount = /\b(how many|count|number of|total)\b/.test(t);
  const mentionsBags = /\b(bag|bags|grain bag|grain bags|grainbag|grainbags)\b/.test(t);
  return asksCount && mentionsBags;
}

const EQUIPMENT_TYPES = new Set([
  "tractor","combine","implement","sprayer","truck","trailer","construction","fertilizer","starfire"
]);

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

    const intentName = (intent?.intent || "").toUpperCase();
    const key = normKey(intent?.key);

    switch (intentName) {
      case "FIELD_FULL":
        data = getFieldFullByKey(key, { includeArchived });
        prompt =
          "Write a complete field summary for operations. Default is ACTIVE ONLY. If the field is archived, clearly label it ARCHIVED. Include farm + county/state + tillable acres + HEL/CRP + RTK tower/network/frequency if present.";
        break;

      case "GRAIN_BAGS_DOWN":
        data = getGrainBagsDownSummary();
        prompt =
          "Summarize grain bags currently down. For each cropType show remaining full/partial counts and bushelsFull/bushelsPartial/bushelsTotal. " +
          "If the user asked for a bag count, give the bag counts first.";
        break;

      case "GRAIN_BAGS_REPORT": {
        const k = lower(key);
        const crop =
          (k.includes("corn") ? "corn" :
           (k.includes("soy") || k.includes("bean")) ? "soybeans" :
           k.includes("wheat") ? "wheat" :
           "");
        data = getGrainBagsReport({ crop: crop || "" });

        if (isBagCountQuestion(promptIn)){
          prompt =
            "The user is asking for HOW MANY BAGS, not a bushel-first report. " +
            "Answer with BAG COUNT FIRST for the requested crop (or all crops if none specified). " +
            "Inventory definition for BAG COUNTS: PUTDOWN-only from grain_bag_events (type='putDown') using counts.full + counts.partial. " +
            "Then (optional) include supporting totals like bushelsFull/bushelsPartial/bushelsTotal and small rollups by county/farm if available. " +
            "Keep it short and operational.";
        } else {
          prompt =
            "Summarize grain bags with a strong focus on BUSHELS BY CROP (most important). " +
            "Show totals by crop (bushelsFull/bushelsPartial/bushelsTotal, plus remaining full/partial counts if present). " +
            "Then show rollups by county and by farm. " +
            "Finally list notable putDowns (top remaining bushels) with field -> farm -> county and bag capacity proof. " +
            "Keep it readable and operational.";
        }
        break;
      }

      case "RTK_TOWER_COUNT":
        data = getRtkTowerCount();
        prompt = "Answer in one sentence with the total count of RTK towers.";
        break;

      case "RTK_TOWER_LIST":
        data = getRtkTowerList({ includeArchived });
        prompt =
          "List all RTK towers. Default is ACTIVE ONLY (fieldCount based on active fields). For each include towerName, networkId, frequency, and fieldCount. Keep it readable.";
        break;

      case "RTK_TOWER_FIELDS":
        data = getFieldsByRtkTowerKey(key, { includeArchived });
        prompt =
          "Show the RTK tower info (name, network, frequency). Default is ACTIVE ONLY. Then list the ACTIVE fields assigned to it. If includeArchived=true and there are archived fields, show a separate ARCHIVED section.";
        break;

      case "COUNTIES_FARMED":
        data = getCountySummary({ includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Answer how many counties we farm in (active). Then list each active county with fieldCount and tillableAcres. If includeArchived=true, add a separate ARCHIVED-ONLY section for counties that have zero active fields.";
        break;

      case "COUNTY_FIELDS":
        data = getFieldsInCounty(key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Show the county name, then list ACTIVE fields in that county. For each field show fieldName, farmName, acresTillable, and HEL/CRP acres if any. If includeArchived=true and there are archived fields, show them in a separate ARCHIVED section.";
        break;

      case "COUNTY_FARMS":
        data = getFarmsInCounty(key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Show the county name, then list farms that have ACTIVE fields in that county. For each farm show farmName, fieldCount, and tillableAcres. If includeArchived=true, include a separate ARCHIVED section.";
        break;

      case "COUNTY_STATS":
        data = getCountyStatsByKey(key, { includeArchived });
        prompt =
          "Default is ACTIVE ONLY. Give county totals for ACTIVE fields: fieldCount, tillableAcres, HEL acres + helFieldCount, CRP acres + crpFieldCount. If includeArchived=true, also show a separate ARCHIVED totals section.";
        break;

      // ---------------------------
      // HEL / CRP TOTALS (NEW)
      // ---------------------------
      case "HEL_TOTALS":
        data = getHelCrpTotals({ includeArchived, mode: "hel" });
        prompt =
          "Answer clearly with HEL totals. Use the toggle-first rule: field counts come from hasHEL (not acres). " +
          "Sum helAcres ONLY for fields where hasHEL is true. Default ACTIVE ONLY. " +
          "Return: total HEL acres + count of fields with HEL. Also include optional by-county and by-farm rollups if present. " +
          "If includeArchived=true, show a separate ARCHIVED section.";
        break;

      case "CRP_TOTALS":
        data = getHelCrpTotals({ includeArchived, mode: "crp" });
        prompt =
          "Answer clearly with CRP totals. Use the toggle-first rule: field counts come from hasCRP (not acres). " +
          "Sum crpAcres ONLY for fields where hasCRP is true. Default ACTIVE ONLY. " +
          "Return: total CRP acres + count of fields with CRP. Also include optional by-county and by-farm rollups if present. " +
          "If includeArchived=true, show a separate ARCHIVED section.";
        break;

      case "HEL_CRP_TOTALS":
        data = getHelCrpTotals({ includeArchived, mode: "both" });
        prompt =
          "Answer clearly with BOTH HEL and CRP totals. Use toggle-first: field counts come from hasHEL/hasCRP (not acres). " +
          "Sum helAcres only when hasHEL is true; sum crpAcres only when hasCRP is true. Default ACTIVE ONLY. " +
          "Return: HEL acres + fieldsWithHEL, and CRP acres + fieldsWithCRP. " +
          "Optionally include by-county and by-farm rollups if present. If includeArchived=true, show a separate ARCHIVED section.";
        break;

      // ---------------------------
      // Boundary Requests
      // ---------------------------
      case "BOUNDARY_REQUESTS": {
        const k = lower(key) || "open";
        const status =
          (k.includes("all") ? "all" :
           k.includes("complete") ? "completed" :
           k.includes("open") ? "open" :
           "open");

        data = getBoundaryRequests({ includeArchived, status });
        prompt =
          "Summarize boundary fix requests. Default is ACTIVE ONLY (Open). Show counts, then group by farm -> field. For each request show boundaryType, scope, when/date, and short notes. If includeArchived=true or status is all/completed, show a separate COMPLETED/ARCHIVED section.";
        break;
      }

      // ---------------------------
      // Field Maintenance
      // ---------------------------
      case "FIELD_MAINTENANCE": {
        const k = lower(key);
        const status = k || null; // allow "needs approved", "pending", "all", or null
        data = getFieldMaintenance({ includeArchived, status });
        prompt =
          "Summarize field maintenance. Default is ACTIVE ONLY. Show counts by status and topic, then group by farm -> field. For each item show topic, priority, status, photo count, submittedBy, and short notes. If includeArchived=true show separate ARCHIVED section.";
        break;
      }

      // ---------------------------
      // Equipment
      // ---------------------------
      case "EQUIPMENT": {
        const k = lower(key);
        const type = EQUIPMENT_TYPES.has(k) ? k : "";
        const q = (!type && key) ? key : "";
        data = getEquipment({ includeArchived, type, q });
        prompt =
          "List equipment. Default is ACTIVE ONLY. Show counts by type, then list each item as a one-line summary. If includeArchived=true, show a separate ARCHIVED section.";
        break;
      }

      case "EQUIPMENT_MAKES": {
        const k = lower(key);
        const category = EQUIPMENT_TYPES.has(k) ? k : "";
        const q = (!category && key) ? key : "";
        data = getEquipmentMakes({ includeArchived, category, q });
        prompt =
          "List equipment makes. Default is ACTIVE ONLY. Show counts by category, then list each make with its categories. If includeArchived=true, show a separate ARCHIVED section.";
        break;
      }

      case "EQUIPMENT_MODELS": {
        const kl = lower(key);
        const makeId = looksLikeFirestoreId(key) ? key : "";
        const category = (!makeId && EQUIPMENT_TYPES.has(kl)) ? kl : "";
        const q = (!makeId && !category && key) ? key : "";
        data = getEquipmentModels({ includeArchived, makeId, category, q });
        prompt =
          "List equipment models. Default is ACTIVE ONLY. If makeId filter is present, list those models. Otherwise group models by makeId and name. If includeArchived=true, show a separate ARCHIVED section.";
        break;
      }

      // ---------------------------
      // Bin Sites
      // ---------------------------
      case "BIN_SITES": {
        data = getBinSites({ includeArchived, q: key || "" });
        prompt =
          "Summarize grain bin sites. Default is ACTIVE ONLY. Show site count, total capacity, and total on-hand if available. Then list each site with bin count and per-bin quick lines. If includeArchived=true show separate ARCHIVED/USED section.";
        break;
      }

      // ---------------------------
      // Bin Movements
      // ---------------------------
      case "BIN_MOVEMENTS": {
        const siteId = looksLikeFirestoreId(key) ? key : "";
        const q = (!siteId && key) ? key : "";
        data = getBinMovements({ includeArchived, siteId, q });
        prompt =
          "Summarize grain bin movements. Default is ACTIVE bin sites only. Show totals IN/OUT/NET, then group by site -> bin -> movements newest first. If includeArchived=true show a separate OTHER/ARCHIVED SITES section.";
        break;
      }

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
        intent: intentName,
        key: key || "",
        includeArchived: includeArchived
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}