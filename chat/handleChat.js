// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-31-clarify-anywhere-truth-gate-history-fallback
//
// Guarantees:
// 1) ONE routing path per request
// 2) If ambiguous between multiple valid answers -> ASK (clarify)
// 3) 1/2/3 reply resolves even if state.lastIntent is missing (uses history fallback)
// 4) No feature proof (ok:true) -> BLOCK (Truth Gate)
// 5) No legacy canHandle* routing

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

/* --------------------------------------------------
   Truth Gate
-------------------------------------------------- */
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

/* --------------------------------------------------
   Clarify definitions
-------------------------------------------------- */
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

  // Grain bags ambiguity: inventory vs placed/events
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

  bins: {
    prompt: buildClarifyQuestion(["Bin sites (locations)", "Bin movements (in/out/net)", "Both: sites + movements summary"]),
    resolve: (n) => {
      if (n === 1) return { topic: "binSites", question: "binsites summary", intent: { topic: "binSites" } };
      if (n === 2) return { topic: "binMovements", question: "bins summary", intent: { topic: "binMovements" } };
      if (n === 3) return { topic: "grain", question: "grain bins", intent: { topic: "grain", mode: "bins" } };
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

/* --------------------------------------------------
   Read last clarify key from state OR history
   - State can vary depending on how deriveStateFromHistory stores it.
   - We support:
     "clarify:grainbags"
     "grainbags"
-------------------------------------------------- */
function getPendingClarifyKey(state, history) {
  const s = (state?.lastIntent || "").toString().trim();
  if (s) {
    if (s.startsWith("clarify:")) return s.slice("clarify:".length);
    if (CLARIFY[s]) return s;
  }

  // history fallback (walk backwards)
  const h = Array.isArray(history) ? history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const msg = h[i] || {};
    // try common shapes
    const metaIntent =
      (msg.meta && msg.meta.intent) ||
      msg.intent ||
      (msg.meta && msg.meta.lastIntent) ||
      "";

    const v = (metaIntent || "").toString().trim();
    if (!v) continue;

    if (v.startsWith("clarify:")) {
      const key = v.slice("clarify:".length);
      if (CLARIFY[key]) return key;
    }
    if (CLARIFY[v]) return v;
  }

  return null;
}

/* --------------------------------------------------
   Ambiguity detection (ASK instead of guessing)
-------------------------------------------------- */
function detectAmbiguity(question) {
  const qn = norm(question);
  if (!qn) return null;

  // grain broad
  if (qn === "grain" || qn === "show grain" || qn === "grain inventory") return "grain";

  // grain bag inventory / where placed ambiguity
  const mentionsBags = qn.includes("grain bag") || qn.includes("grain bags") || qn.includes("bag inventory") || qn.includes("bags inventory") || qn === "bags";
  const mentionsInventory = qn.includes("inventory") || qn.includes("on hand") || qn.includes("onhand");
  const mentionsPlaced = qn.includes("placed") || qn.includes("putdown") || qn.includes("put down") || qn.includes("where");
  const mentionsEvents = qn.includes("events") || qn.includes("activity") || qn.includes("history");

  // If they mention bags and aren't already specific, ask
  if (mentionsBags && (mentionsInventory || mentionsPlaced || mentionsEvents || qn === "grain bags")) {
    const alreadySpecific =
      qn.includes("putdown") || qn.includes("put down") || qn.includes("pickup") || qn.includes("pick up") ||
      qn.includes("events") || qn.includes("activity") || qn.includes("on hand") || qn.includes("onhand") ||
      qn.startsWith("sku ") || qn.startsWith("grain sku ") || qn.startsWith("bags sku ");
    if (!alreadySpecific) return "grainbags";
  }

  // maintenance broad
  if (qn === "maintenance" || qn === "show maintenance" || qn === "list maintenance") return "maintenance";

  // bins broad
  if (qn === "bins" || qn === "bin" || qn === "show bins" || qn === "grain bins") {
    if (!qn.includes("movement")) return "bins";
  }

  // boundaries broad
  if (qn === "boundaries" || qn === "boundary requests" || qn === "boundary" || qn === "show boundaries") {
    const alreadySpecific = qn.includes("open") || qn.includes("closed") || qn.includes("summary") || qn.includes("fields");
    if (!alreadySpecific) return "boundaries";
  }

  return null;
}

/* --------------------------------------------------
   Intent normalization (single source)
-------------------------------------------------- */
function normalizeIntent(question) {
  const qn = norm(question);
  if (!qn) return null;

  if (qn.includes("readiness")) return { topic: "readiness", normalizedQuestion: question };

  if (qn.includes("equipment") || qn.includes("tractor") || qn.includes("combine") || qn.includes("sprayer") || qn.includes("implement")) {
    if (qn.includes("equipment list") || qn === "equipment" || qn === "equipment summary") {
      return { topic: "equipment", mode: "summary", normalizedQuestion: "equipment summary" };
    }
    return { topic: "equipment", normalizedQuestion: question };
  }

  if (qn.includes("field")) {
    if (qn === "fields" || qn === "list fields" || qn.includes("fields list") || qn.includes("show fields")) {
      return { topic: "fields", mode: "list", normalizedQuestion: "list fields" };
    }
    return { topic: "fields", normalizedQuestion: question };
  }

  if (qn.includes("grain")) return { topic: "grain", normalizedQuestion: question };
  if (qn.includes("maintenance") || qn.includes("work order")) return { topic: "maintenance", normalizedQuestion: question };
  if (qn.includes("boundary")) return { topic: "boundaries", normalizedQuestion: question };
  if (qn.includes("rtk")) return { topic: "rtk", normalizedQuestion: question };
  if (qn.includes("farm")) return { topic: "farms", normalizedQuestion: question };

  if (qn.includes("binsite") || qn.includes("bin site") || qn.includes("binsites")) return { topic: "binSites", normalizedQuestion: question };
  if (qn.includes("bin movements") || qn.startsWith("bins ")) return { topic: "binMovements", normalizedQuestion: question };

  // direct grain bag event phrasing
  if (qn.includes("bag events") || (qn.includes("grain bags") && (qn.includes("events") || qn.includes("putdown") || qn.includes("pickup")))) {
    return { topic: "grainBagEvents", normalizedQuestion: question };
  }

  return null;
}

/* --------------------------------------------------
   Main handler
-------------------------------------------------- */
export async function handleChat({ question, snapshot, history, state }) {
  const pick = choiceNumber(question);

  // 1) Resolve pending clarify using state OR history
  if (pick) {
    const key = getPendingClarifyKey(state, history);
    if (key && CLARIFY[key]) {
      const resolved = CLARIFY[key].resolve(pick);
      if (resolved) {
        return await route(resolved.topic, resolved.question, snapshot, resolved.intent || null);
      }
      // If key exists but resolve failed, re-ask
      return { answer: CLARIFY[key].prompt, meta: { intent: `clarify:${key}`, clarify: true } };
    }

    // If user sent 1/2/3 but we can't find what it was answering, don't say "unknown"
    return {
      answer: "Reply with 1, 2, or 3 to the last question I asked so I can pull the right data.",
      meta: { intent: "clarify:missing-context", clarify: true }
    };
  }

  // 2) Detect ambiguity and ask
  const ambKey = detectAmbiguity(question);
  if (ambKey && CLARIFY[ambKey]) {
    return {
      answer: CLARIFY[ambKey].prompt,
      meta: { intent: `clarify:${ambKey}`, clarify: true }
    };
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

  return await route(intent.topic, intent.normalizedQuestion || question, snapshot, intent);
}

/* --------------------------------------------------
   Single authoritative router
-------------------------------------------------- */
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

    case "binSites":
      out = await answerBinSites({ question, snapshot, intent });
      break;

    case "binMovements":
      out = await answerBinMovements({ question, snapshot, intent });
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
