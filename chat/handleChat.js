// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-30-normalize-intent (Global normalizeIntent + routes by intent; features stop seeing raw English)

import { canHandleEquipment, answerEquipment } from "../features/equipment.js";
import { canHandleBoundaryRequests, answerBoundaryRequests } from "../features/boundaryRequests.js";
import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";

import { answerFieldReadinessLatest } from "../features/fieldReadinessLatest.js";

import { canHandleGrainBagEvents, answerGrainBagEvents } from "../features/grainBagEvents.js";
import { canHandleProducts, answerProducts } from "../features/products.js";
import { canHandleRtkTowers, answerRtkTowers } from "../features/rtkTowers.js";
import { canHandleSeasonalPrecheck, answerSeasonalPrecheck } from "../features/seasonalPrecheck.js";
import { canHandleStarfireMoves, answerStarfireMoves } from "../features/starfireMoves.js";
import { canHandleVehicleRegistrations, answerVehicleRegistrations } from "../features/vehicleRegistrations.js";
import { canHandleCombineMetrics, answerCombineMetrics } from "../features/combineMetrics.js";

import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";
import { canHandleFarms, answerFarms } from "../features/farms.js";
import { canHandleFieldMaintenance, answerFieldMaintenance } from "../features/fieldMaintenance.js";

/* --------------------------------------------------
   REPORT INTENT DETECTION (no buttons)
-------------------------------------------------- */
function wantsReport(text) {
  const t = (text || "").toString().toLowerCase().trim();
  if (!t) return false;

  return (
    (t.includes("make") && (t.includes("report") || t.includes("pdf") || t.includes("print"))) ||
    (t.includes("turn") && (t.includes("report") || t.includes("pdf"))) ||
    (t.includes("export") && (t.includes("pdf") || t.includes("report"))) ||
    t.includes("print this") ||
    t.includes("print that") ||
    t.includes("make this into a report") ||
    t.includes("make a report of") ||
    (t.includes("everything so far") && (t.includes("report") || t.includes("pdf") || t.includes("print")))
  );
}

function wantsFullConversation(text) {
  const t = (text || "").toString().toLowerCase();
  return t.includes("everything") || t.includes("entire") || t.includes("whole conversation") || t.includes("so far");
}

const norm = (s) => (s || "").toString().trim().toLowerCase();

function isReadinessQuery(qn) {
  if (!qn) return false;
  if (qn.includes("readiness")) return true;
  if (qn.includes("how ready") && qn.includes("field")) return true;
  if (qn.includes("which fields") && (qn.includes("plant") || qn.includes("spray") || qn.includes("work") || qn.includes("till"))) return true;
  if (qn.includes("can we plant") || qn.includes("can we spray") || qn.includes("can we work") || qn.includes("can we till")) return true;
  return false;
}

/* --------------------------------------------------
   GLOBAL INTENT NORMALIZATION
   - One place that turns messy human phrasing into
     structured intent + a "normalizedQuestion" string.
   - Feature handlers should not have to parse English.
-------------------------------------------------- */
function normalizeIntent(question) {
  const raw = (question || "").toString().trim();
  const qn = norm(raw);

  const intent = {
    raw,
    topic: null,
    mode: null,
    args: {},
    // Some legacy features still expect a string command.
    // normalizedQuestion lets us keep those working without rewriting.
    normalizedQuestion: raw
  };

  if (!qn) return intent;

  // ---- Equipment (high priority) ----
  const mentionsEquipment =
    qn.includes("equipment") ||
    qn.includes("tractor") ||
    qn.includes("tractors") ||
    qn.includes("combine") ||
    qn.includes("combines") ||
    qn.includes("sprayer") ||
    qn.includes("sprayers") ||
    qn.includes("implement") ||
    qn.includes("implements");

  if (mentionsEquipment) {
    intent.topic = "equipment";

    // Human phrasing → summary/list
    const wantsList =
      qn.includes(" list") ||
      qn.endsWith(" list") ||
      qn.includes("show equipment") ||
      qn.includes("show me equipment") ||
      qn.includes("all equipment") ||
      qn.includes("equipment summary") ||
      (qn === "equipment") ||
      qn.includes("equipment overview");

    if (wantsList) {
      intent.mode = "summary";
      intent.normalizedQuestion = "equipment summary";
      return intent;
    }

    // Friendly patterns for filters
    // examples:
    // "equipment type starfire" / "equipment type: starfire"
    let m = /\btype\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "type";
      intent.args.type = m[1].trim();
      intent.normalizedQuestion = `equipment type ${intent.args.type}`;
      return intent;
    }

    // "john deere equipment" (common)
    // If they mention equipment + a make-like phrase without "type/model/search",
    // treat as a make filter by default.
    if (!/\b(model|search|qr|id|serial|sn|type)\b/i.test(qn) && qn.includes("equipment")) {
      // heuristic: if they wrote "X equipment" or "equipment X", keep raw as make needle
      const cleaned = raw
        .replace(/\bequipment\b/i, "")
        .trim();
      if (cleaned && cleaned.length >= 3) {
        intent.mode = "make";
        intent.args.make = cleaned;
        intent.normalizedQuestion = `equipment make ${intent.args.make}`;
        return intent;
      }
    }

    // "equipment make John Deere"
    m = /\bmake\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "make";
      intent.args.make = m[1].trim();
      intent.normalizedQuestion = `equipment make ${intent.args.make}`;
      return intent;
    }

    // "equipment model 8R 410"
    m = /\bmodel\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "model";
      intent.args.model = m[1].trim();
      intent.normalizedQuestion = `equipment model ${intent.args.model}`;
      return intent;
    }

    // "equipment search 8R410" / "find 8R410"
    m = /\b(search|find|lookup)\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[2]) {
      intent.mode = "search";
      intent.args.needle = m[2].trim();
      intent.normalizedQuestion = `equipment search ${intent.args.needle}`;
      return intent;
    }

    // "equipment qr <id>"
    m = /\bqr\b\s*:?\s*([a-zA-Z0-9_-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "qr";
      intent.args.id = m[1].trim();
      intent.normalizedQuestion = `equipment qr ${intent.args.id}`;
      return intent;
    }

    // If user typed "equipment <something>" and it isn't "summary/list",
    // DO NOT assume it's an id. Treat it as search instead (fixes: equipment list → id=list).
    if (qn.startsWith("equipment ")) {
      const rest = raw.slice(raw.toLowerCase().indexOf("equipment") + "equipment".length).trim();
      if (rest) {
        intent.mode = "search";
        intent.args.needle = rest;
        intent.normalizedQuestion = `equipment search ${intent.args.needle}`;
        return intent;
      }
    }

    // Default equipment → summary
    intent.mode = "summary";
    intent.normalizedQuestion = "equipment summary";
    return intent;
  }

  // ---- Readiness ----
  if (isReadinessQuery(qn)) {
    intent.topic = "readiness";
    intent.mode = "latest";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // (Keep adding topics over time, but we do NOT need to rewrite everything today.)
  return intent;
}

/* --------------------------------------------------
   MAIN CHAT ROUTER
-------------------------------------------------- */
export async function handleChat({ question, snapshot, history, state }) {
  // Report trigger
  if (wantsReport(question)) {
    const mode = wantsFullConversation(question) ? "conversation" : "recent";
    return {
      answer:
        `✅ Report ready.\n` +
        `I’m opening the PDF now.\n\n` +
        `View PDF: /report?mode=${mode}`,
      action: "report",
      meta: { intent: "report", reportMode: mode, reportUrl: `/report?mode=${mode}` }
    };
  }

  const intent = normalizeIntent(question);

  // Readiness: always uses fieldReadinessLatest
  if (intent.topic === "readiness") {
    const out = await answerFieldReadinessLatest({ question, snapshot, history, state });
    // Preserve existing behavior but tag intent for logs/reports
    out.meta = { ...(out.meta || {}), intent: "readiness" };
    return out;
  }

  // Equipment: route via intent (no raw-English parsing)
  if (intent.topic === "equipment") {
    const out = await answerEquipment({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "equipment", intentMode: intent.mode || null };
    return out;
  }

  // Legacy routing for other features (still uses raw English for now)
  // But we pass normalizedQuestion (when available) to make behavior more forgiving.
  const qForHandlers = intent.normalizedQuestion || question;

  if (canHandleEquipment(qForHandlers)) return answerEquipment({ question: qForHandlers, snapshot, intent });
  if (canHandleBoundaryRequests(qForHandlers)) return answerBoundaryRequests({ question: qForHandlers, snapshot });
  if (canHandleBinSites(qForHandlers)) return answerBinSites({ question: qForHandlers, snapshot });
  if (canHandleBinMovements(qForHandlers)) return answerBinMovements({ question: qForHandlers, snapshot });
  if (canHandleAerialApplications(qForHandlers)) return answerAerialApplications({ question: qForHandlers, snapshot });
  if (canHandleFieldTrials(qForHandlers)) return answerFieldTrials({ question: qForHandlers, snapshot });

  if (canHandleGrainBagEvents(qForHandlers)) return answerGrainBagEvents({ question: qForHandlers, snapshot });
  if (canHandleProducts(qForHandlers)) return answerProducts({ question: qForHandlers, snapshot });
  if (canHandleRtkTowers(qForHandlers)) return answerRtkTowers({ question: qForHandlers, snapshot });
  if (canHandleSeasonalPrecheck(qForHandlers)) return answerSeasonalPrecheck({ question: qForHandlers, snapshot });
  if (canHandleStarfireMoves(qForHandlers)) return answerStarfireMoves({ question: qForHandlers, snapshot });
  if (canHandleVehicleRegistrations(qForHandlers)) return answerVehicleRegistrations({ question: qForHandlers, snapshot });
  if (canHandleCombineMetrics(qForHandlers)) return answerCombineMetrics({ question: qForHandlers, snapshot });

  if (canHandleGrain(qForHandlers)) return answerGrain({ question: qForHandlers, snapshot });
  if (canHandleFields(qForHandlers)) return answerFields({ question: qForHandlers, snapshot });
  if (canHandleFarms(qForHandlers)) return answerFarms({ question: qForHandlers, snapshot });
  if (canHandleFieldMaintenance(qForHandlers)) return answerFieldMaintenance({ question: qForHandlers, snapshot });

  return {
    answer:
      `I’m still early in development and learning how different questions are phrased.\n\n` +
      `If that didn’t come back the way you expected, try rephrasing a bit — I’m getting better at interpreting “show me…”, “list…”, and “summarize…”.`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", intent: "unknown" }
  };
}
