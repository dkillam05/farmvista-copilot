// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-31-clarify-reply-history-text-fallback
//
// Fix:
// ✅ When user replies 1/2/3 and state.lastIntent/meta.intent is missing,
//    infer the pending clarify from the LAST assistant message text in history.
//    This fixes: "grain bag inventory" -> (2) -> "unknown".
//
// Keeps:
// ✅ Truth Gate (ok:true required)
// ✅ Single routing path
// ✅ Grain events routing priority

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

function buildClarifyQuestion(lines) {
  return (
    "Quick question so I pull the right data:\n" +
    lines.map((l, i) => `${i + 1}) ${l}`).join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
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

/* ---------------- Clarify library ---------------- */
const CLARIFY = {
  grain: {
    prompt: buildClarifyQuestion(["Grain bags", "Grain bins", "Grain summary"]),
    resolve: (n) => {
      if (n === 1) return { topic: "grain", question: "grain bags", intent: { topic: "grain", mode: "bags" } };
      if (n === 2) return { topic: "grain", question: "grain bins", intent: { topic: "grain", mode: "bins" } };
      if (n === 3) return { topic: "grain", question: "grain summary", intent: { topic: "grain", mode: "summary" } };
      return null;
    }
  },

  grainbags: {
    prompt: buildClarifyQuestion([
      "On-hand inventory (by SKU)",
      "Where bags are placed (putDown / pickUp by field)",
      "Recent bag activity (events)"
    ]),
    resolve: (n) => {
      if (n === 1) return { topic: "grain", question: "grain bags", intent: { topic: "grain", mode: "bags" } };
      if (n === 2) return { topic: "grainBagEvents", question: "grain bags putdowns", intent: { topic: "grainBagEvents", mode: "putdowns" } };
      if (n === 3) return { topic: "grainBagEvents", question: "grain bags events last 10", intent: { topic: "grainBagEvents", mode: "events" } };
      return null;
    }
  },

  maintenance: {
    prompt: buildClarifyQuestion(["Pending maintenance", "Needs approved", "All maintenance"]),
    resolve: (n) => {
      if (n === 1) return { topic: "maintenance", question: "pending maintenance", intent: { topic: "maintenance" } };
      if (n === 2) return { topic: "maintenance", question: "needs approved maintenance", intent: { topic: "maintenance" } };
      if (n === 3) return { topic: "maintenance", question: "maintenance", intent: { topic: "maintenance" } };
      return null;
    }
  },

  boundaries: {
    prompt: buildClarifyQuestion(["Fields with open boundary requests", "Open boundary requests (full list)", "Boundary requests summary"]),
    resolve: (n) => {
      if (n === 1) return { topic: "boundaries", question: "fields with boundary requests", intent: { topic: "boundaries", mode: "fields" } };
      if (n === 2) return { topic: "boundaries", question: "boundaries open", intent: { topic: "boundaries", mode: "open" } };
      if (n === 3) return { topic: "boundaries", question: "boundaries summary", intent: { topic: "boundaries", mode: "summary" } };
      return null;
    }
  }
};

/* ---------------- Find last assistant text in history ---------------- */
function getLastAssistantText(history) {
  const h = Array.isArray(history) ? history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const msg = h[i] || {};
    const role = (msg.role || msg.type || msg.author || "").toString().toLowerCase();
    const isAssistant = role.includes("assistant") || role === "copilot";
    if (!isAssistant) continue;

    const text =
      (typeof msg.answer === "string" && msg.answer) ||
      (typeof msg.content === "string" && msg.content) ||
      (typeof msg.text === "string" && msg.text) ||
      "";

    if (text && typeof text === "string") return text;
  }
  return "";
}

function inferClarifyKeyFromText(text) {
  const t = (text || "").toString();
  if (!t.includes("Quick question so I pull the right data:")) return null;

  // Grainbags inventory vs placed vs events
  if (t.includes("On-hand inventory (by SKU)") && t.includes("Where bags are placed")) return "grainbags";

  // Grain high-level
  if (t.includes("1) Grain bags") && t.includes("2) Grain bins") && t.includes("3) Grain summary")) return "grain";

  // Maintenance
  if (t.includes("Pending maintenance") && t.includes("Needs approved")) return "maintenance";

  // Boundaries
  if (t.includes("boundary requests") || t.includes("Fields with open boundary requests")) return "boundaries";

  return null;
}

/* ---------------- Ambiguity detection (ask first) ---------------- */
function detectAmbiguity(question) {
  const qn = norm(question);
  if (!qn) return null;

  // Grain bag inventory / placed ambiguity
  const mentionsBags =
    qn.includes("grain bag") || qn.includes("grain bags") ||
    qn.includes("bag inventory") || qn.includes("bags inventory") ||
    qn === "grain bags" || qn === "bags";

  const mentionsInventory = qn.includes("inventory") || qn.includes("on hand") || qn.includes("onhand");
  const mentionsPlaced = qn.includes("placed") || qn.includes("where");
  const mentionsEvents = qn.includes("events") || qn.includes("activity") || qn.includes("history");

  const alreadySpecific =
    qn.includes("putdown") || qn.includes("put down") || qn.includes("pickup") || qn.includes("pick up") ||
    mentionsEvents || mentionsInventory ||
    qn.startsWith("sku ") || qn.startsWith("grain sku ") || qn.startsWith("bags sku ");

  if (mentionsBags && (mentionsInventory || mentionsPlaced || qn.includes("inventory")) && !alreadySpecific) return "grainbags";

  // Broad grain
  if (qn === "grain" || qn === "show grain" || qn === "grain inventory") return "grain";

  // Broad maintenance
  if (qn === "maintenance" || qn === "show maintenance" || qn === "list maintenance") return "maintenance";

  // Broad boundaries
  if (qn === "boundaries" || qn === "boundary requests" || qn === "boundary" || qn === "show boundaries") {
    const already = qn.includes("open") || qn.includes("closed") || qn.includes("summary") || qn.includes("fields");
    if (!already) return "boundaries";
  }

  return null;
}

/* ---------------- Intent normalization ---------------- */
function normalizeIntent(question) {
  const qn = norm(question);
  if (!qn) return null;

  // Grain bag events ALWAYS win if asked explicitly
  const wantsBagEvents =
    (qn.includes("grain") && qn.includes("bag") && (qn.includes("event") || qn.includes("activity") || qn.includes("history"))) ||
    qn.includes("putdown") || qn.includes("put down") || qn.includes("pickup") || qn.includes("pick up");

  if (wantsBagEvents) return { topic: "grainBagEvents", q: question };

  if (qn.includes("readiness")) return { topic: "readiness", q: question };

  if (qn.includes("equipment") || qn.includes("tractor") || qn.includes("combine") || qn.includes("sprayer") || qn.includes("implement")) {
    if (qn.includes("equipment list") || qn === "equipment") return { topic: "equipment", q: "equipment summary", intent: { mode: "summary" } };
    return { topic: "equipment", q: question };
  }

  if (qn.includes("field")) {
    if (qn === "fields" || qn.includes("list fields") || qn.includes("fields list") || qn.includes("show fields")) {
      return { topic: "fields", q: "list fields", intent: { mode: "list" } };
    }
    return { topic: "fields", q: question };
  }

  if (qn.includes("grain")) return { topic: "grain", q: question };

  if (qn.includes("maintenance") || qn.includes("work order")) return { topic: "maintenance", q: question };
  if (qn.includes("boundary")) return { topic: "boundaries", q: question };
  if (qn.includes("rtk")) return { topic: "rtk", q: question };
  if (qn.includes("farm")) return { topic: "farms", q: question };

  return null;
}

/* ---------------- MAIN ---------------- */
export async function handleChat({ question, snapshot, history, state }) {
  const pick = choiceNumber(question);

  // 1) If user replied 1/2/3, resolve pending clarify using:
  //    state.lastIntent/meta.intent (if present) OR last assistant message text (history fallback).
  if (pick) {
    let key = null;

    const s = (state?.lastIntent || "").toString().trim();
    if (s.startsWith("clarify:")) key = s.slice("clarify:".length);
    else if (CLARIFY[s]) key = s;

    if (!key) {
      const lastTxt = getLastAssistantText(history);
      key = inferClarifyKeyFromText(lastTxt);
    }

    if (key && CLARIFY[key]) {
      const resolved = CLARIFY[key].resolve(pick);
      if (resolved) {
        return await route(resolved.topic, resolved.question, snapshot, resolved.intent || null);
      }
      // if somehow can't resolve, re-ask
      return { answer: CLARIFY[key].prompt, meta: { intent: `clarify:${key}`, clarify: true } };
    }

    // If we can't infer what the numbers refer to, don't say "unknown"
    return {
      answer: "Reply with 1, 2, or 3 to the last question I asked so I can pull the right data.",
      meta: { intent: "clarify:missing-context", clarify: true }
    };
  }

  // 2) Ask clarify if ambiguous
  const ambKey = detectAmbiguity(question);
  if (ambKey && CLARIFY[ambKey]) {
    return { answer: CLARIFY[ambKey].prompt, meta: { intent: `clarify:${ambKey}`, clarify: true } };
  }

  // 3) Normalize and route once
  const intent = normalizeIntent(question);
  if (!intent) {
    return {
      answer:
        "I didn’t understand that request.\n\n" +
        "Tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness).",
      meta: { intent: "unknown" }
    };
  }

  return await route(intent.topic, intent.q, snapshot, intent.intent || null);
}

/* ---------------- ROUTER ---------------- */
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
