// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-30-truth-gate
//
// HARD RULES:
// 1) Exactly ONE routing path per request
// 2) Clarify OR Answer — never both
// 3) No feature result => NO ANSWER (Truth Gate)
// 4) Legacy canHandle* routing REMOVED
//
// This file is now the single authority.

import { answerEquipment } from "../features/equipment.js";
import { answerBoundaryRequests } from "../features/boundaryRequests.js";
import { answerBinSites } from "../features/binSites.js";
import { answerBinMovements } from "../features/binMovements.js";
import { answerAerialApplications } from "../features/aerialApplications.js";
import { answerFieldTrials } from "../features/fieldTrials.js";
import { answerFieldReadinessLatest } from "../features/fieldReadinessLatest.js";
import { answerGrainBagEvents } from "../features/grainBagEvents.js";
import { answerProducts } from "../features/products.js";
import { answerRtkTowers } from "../features/rtkTowers.js";
import { answerSeasonalPrecheck } from "../features/seasonalPrecheck.js";
import { answerStarfireMoves } from "../features/starfireMoves.js";
import { answerVehicleRegistrations } from "../features/vehicleRegistrations.js";
import { answerCombineMetrics } from "../features/combineMetrics.js";
import { answerGrain } from "../features/grain.js";
import { answerFields } from "../features/fields.js";
import { answerFarms } from "../features/farms.js";
import { answerFieldMaintenance } from "../features/fieldMaintenance.js";

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */
const norm = (s) => (s || "").toString().trim().toLowerCase();

/* --------------------------------------------------
   Truth Gate (NON-NEGOTIABLE)
-------------------------------------------------- */
function enforceTruth(out) {
  if (!out || typeof out !== "object") return false;
  if (out.ok === true) return true;

  // If feature did not explicitly prove success, block response
  return false;
}

function blockedAnswer(reason = "no-data") {
  return {
    answer:
      "I can’t confidently answer that yet.\n" +
      "Can you be more specific about what you want to see?",
    meta: { intent: "blocked", reason }
  };
}

/* --------------------------------------------------
   Clarify Logic (minimal, authoritative)
-------------------------------------------------- */
function needsClarify(qn) {
  if (!qn) return null;

  if (qn === "grain") {
    return {
      intent: "clarify:grain",
      answer:
        "Quick question so I pull the right data:\n" +
        "1) Grain bags\n" +
        "2) Grain bins\n" +
        "3) Grain summary\n\n" +
        "Reply with 1, 2, or 3."
    };
  }

  if (qn === "maintenance") {
    return {
      intent: "clarify:maintenance",
      answer:
        "Quick question so I pull the right data:\n" +
        "1) Pending maintenance\n" +
        "2) Needs approved\n" +
        "3) All maintenance\n\n" +
        "Reply with 1, 2, or 3."
    };
  }

  return null;
}

function resolveClarify(lastIntent, reply) {
  const r = norm(reply);
  if (!lastIntent || !r) return null;

  if (lastIntent === "clarify:grain") {
    if (r === "1") return { topic: "grain", question: "grain bags" };
    if (r === "2") return { topic: "grain", question: "grain bins" };
    if (r === "3") return { topic: "grain", question: "grain summary" };
  }

  if (lastIntent === "clarify:maintenance") {
    if (r === "1") return { topic: "maintenance", question: "pending maintenance" };
    if (r === "2") return { topic: "maintenance", question: "needs approved maintenance" };
    if (r === "3") return { topic: "maintenance", question: "maintenance" };
  }

  return null;
}

/* --------------------------------------------------
   Intent Normalization (SINGLE SOURCE)
-------------------------------------------------- */
function normalizeIntent(question) {
  const qn = norm(question);
  if (!qn) return null;

  if (qn.includes("readiness")) return { topic: "readiness" };
  if (qn.includes("field")) return { topic: "fields" };
  if (qn.includes("equipment") || qn.includes("tractor") || qn.includes("combine")) return { topic: "equipment" };
  if (qn.includes("grain")) return { topic: "grain" };
  if (qn.includes("maintenance")) return { topic: "maintenance" };
  if (qn.includes("boundary")) return { topic: "boundaries" };
  if (qn.includes("rtk")) return { topic: "rtk" };
  if (qn.includes("farm")) return { topic: "farms" };

  return null;
}

/* --------------------------------------------------
   MAIN CHAT HANDLER
-------------------------------------------------- */
export async function handleChat({ question, snapshot, state }) {
  const qn = norm(question);

  // 1) Resolve pending clarify
  const resolved = resolveClarify(state?.lastIntent, question);
  if (resolved) {
    return await route(resolved.topic, resolved.question, snapshot);
  }

  // 2) Ask clarify if needed
  const clarify = needsClarify(qn);
  if (clarify) {
    return {
      answer: clarify.answer,
      meta: { intent: clarify.intent, clarify: true }
    };
  }

  // 3) Normalize intent
  const intent = normalizeIntent(question);
  if (!intent) {
    return {
      answer:
        "I didn’t understand that request.\n\n" +
        "Tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness).",
      meta: { intent: "unknown" }
    };
  }

  // 4) Route ONCE
  return await route(intent.topic, question, snapshot);
}

/* --------------------------------------------------
   SINGLE ROUTER (authoritative)
-------------------------------------------------- */
async function route(topic, question, snapshot) {
  let out;

  switch (topic) {
    case "readiness":
      out = await answerFieldReadinessLatest({ question, snapshot });
      break;

    case "equipment":
      out = await answerEquipment({ question, snapshot });
      break;

    case "fields":
      out = await answerFields({ question, snapshot });
      break;

    case "grain":
      out = await answerGrain({ question, snapshot });
      break;

    case "maintenance":
      out = await answerFieldMaintenance({ question, snapshot });
      break;

    case "boundaries":
      out = await answerBoundaryRequests({ question, snapshot });
      break;

    case "rtk":
      out = await answerRtkTowers({ question, snapshot });
      break;

    case "farms":
      out = await answerFarms({ question, snapshot });
      break;

    default:
      return blockedAnswer("no-route");
  }

  // 🔒 TRUTH GATE
  if (!enforceTruth(out)) {
    return blockedAnswer("feature-no-data");
  }

  return out;
}
