// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-31-domain-router-grain
//
// Design:
// - handleChat decides domain (grain/equipment/etc)
// - grain domain decisions live in /routers/grainRouter.js
// - Truth Gate enforced here

import { grainPlan } from "../routers/grainRouter.js";

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

const norm = (s) => (s || "").toString().trim().toLowerCase();

function choiceNumber(txt) {
  const t = norm(txt);
  if (!t) return null;
  if (t === "1" || t === "one") return 1;
  if (t === "2" || t === "two") return 2;
  if (t === "3" || t === "three") return 3;
  return null;
}

/* ---------------- Truth Gate ---------------- */
function enforceTruth(out) {
  return !!(out && typeof out === "object" && out.ok === true);
}

function blockedAnswer(reason = "feature-no-data") {
  return {
    answer:
      "I can’t confidently answer that yet.\n" +
      "Can you be more specific about what you want to see?",
    meta: { intent: "blocked", reason }
  };
}

/* -------- Pending clarify key from state/history -------- */
function getPendingKey(state, history) {
  const s = (state?.lastIntent || "").toString().trim();
  if (s.startsWith("clarify:")) return s.slice("clarify:".length);
  if (s) return s;

  const h = Array.isArray(history) ? history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const msg = h[i] || {};
    const metaIntent = (msg.meta && msg.meta.intent) || msg.intent || "";
    const v = (metaIntent || "").toString().trim();
    if (!v) continue;
    if (v.startsWith("clarify:")) return v.slice("clarify:".length);
  }
  return null;
}

/* ---------------- Intent normalize ---------------- */
function normalizeIntent(question) {
  const qn = norm(question);
  if (!qn) return null;

  // readiness
  if (qn.includes("readiness")) return { topic: "readiness", q: question };

  // grain (delegate)
  if (qn.includes("grain") || qn.includes("bag") || qn === "bins" || qn === "bin") return { topic: "grain", q: question };

  // equipment
  if (qn.includes("equipment") || qn.includes("tractor") || qn.includes("combine") || qn.includes("sprayer") || qn.includes("implement")) {
    if (qn.includes("equipment list") || qn === "equipment") return { topic: "equipment", q: "equipment summary", intent: { mode: "summary" } };
    return { topic: "equipment", q: question };
  }

  // fields
  if (qn.includes("field")) {
    if (qn === "fields" || qn.includes("list fields") || qn.includes("fields list") || qn.includes("show fields")) {
      return { topic: "fields", q: "list fields", intent: { mode: "list" } };
    }
    return { topic: "fields", q: question };
  }

  // maintenance
  if (qn.includes("maintenance") || qn.includes("work order")) return { topic: "maintenance", q: question };

  // boundaries
  if (qn.includes("boundary")) return { topic: "boundaries", q: question };

  // rtk
  if (qn.includes("rtk")) return { topic: "rtk", q: question };

  // farms
  if (qn.includes("farm")) return { topic: "farms", q: question };

  return null;
}

/* ---------------- Main ---------------- */
export async function handleChat({ question, snapshot, history, state }) {
  const pick = choiceNumber(question);

  // If user replied 1/2/3, try to resolve with pending clarify key
  const pendingKey = pick ? getPendingKey(state, history) : null;

  // Route by intent
  const intent = normalizeIntent(question);
  if (!intent) {
    return {
      answer:
        "I didn’t understand that request.\n\n" +
        "Tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness).",
      meta: { intent: "unknown" }
    };
  }

  // Grain domain router
  if (intent.topic === "grain") {
    const plan = grainPlan({ question: intent.q, pendingKey });
    if (plan && plan.kind === "clarify") {
      return { answer: plan.answer, meta: { intent: `clarify:${plan.key}`, clarify: true } };
    }
    if (plan && plan.kind === "route") {
      return await route(plan.topic, plan.question, snapshot, plan.intent || null);
    }

    // If we can't plan, fall back to grain summary clarify
    return {
      answer: "Quick question so I pull the right data:\n1) Grain bags\n2) Grain bins\n3) Grain summary\n\nReply with 1, 2, or 3.",
      meta: { intent: "clarify:grain", clarify: true }
    };
  }

  // Non-grain routes (single path)
  if (intent.topic === "readiness") return await route("readiness", intent.q, snapshot, null);
  if (intent.topic === "equipment") return await route("equipment", intent.q, snapshot, intent.intent || null);
  if (intent.topic === "fields") return await route("fields", intent.q, snapshot, intent.intent || null);
  if (intent.topic === "maintenance") return await route("maintenance", intent.q, snapshot, null);
  if (intent.topic === "boundaries") return await route("boundaries", intent.q, snapshot, null);
  if (intent.topic === "rtk") return await route("rtk", intent.q, snapshot, null);
  if (intent.topic === "farms") return await route("farms", intent.q, snapshot, null);

  return blockedAnswer("no-route");
}

/* ---------------- Single authoritative router ---------------- */
async function route(topic, question, snapshot, intent) {
  let out;

  switch (topic) {
    case "readiness":
      out = await answerFieldReadinessLatest({ question, snapshot });
      break;

    case "equipment":
      out = await answerEquipment({ question, snapshot, intent });
      break;

    case "fields":
      out = await answerFields({ question, snapshot, intent });
      break;

    case "grain":
      out = await answerGrain({ question, snapshot, intent });
      break;

    case "grainBagEvents":
      out = await answerGrainBagEvents({ question, snapshot, intent });
      break;

    case "binSites":
      out = await answerBinSites({ question, snapshot, intent });
      break;

    case "binMovements":
      out = await answerBinMovements({ question, snapshot, intent });
      break;

    case "maintenance":
      out = await answerFieldMaintenance({ question, snapshot, intent });
      break;

    case "boundaries":
      out = await answerBoundaryRequests({ question, snapshot, intent });
      break;

    case "rtk":
      out = await answerRtkTowers({ question, snapshot, intent });
      break;

    case "farms":
      out = await answerFarms({ question, snapshot, intent });
      break;

    // keep available
    case "products":
      out = await answerProducts({ question, snapshot, intent });
      break;
    case "aerial":
      out = await answerAerialApplications({ question, snapshot, intent });
      break;
    case "trials":
      out = await answerFieldTrials({ question, snapshot, intent });
      break;
    case "precheck":
      out = await answerSeasonalPrecheck({ question, snapshot, intent });
      break;
    case "starfire":
      out = await answerStarfireMoves({ question, snapshot, intent });
      break;
    case "vehicles":
      out = await answerVehicleRegistrations({ question, snapshot, intent });
      break;
    case "combineMetrics":
      out = await answerCombineMetrics({ question, snapshot, intent });
      break;

    default:
      return blockedAnswer("no-route");
  }

  if (!enforceTruth(out)) return blockedAnswer("feature-no-data");
  return out;
}
