// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-30-followups (Adds follow-up routing using state.lastIntent; normalizes "fields with boundary requests")

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

/* ---------------- Report detection ---------------- */
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

/* ---------------- Humanize output ---------------- */
function humanizeAnswer(out) {
  if (!out || typeof out !== "object") return out;
  if (typeof out.answer !== "string") return out;

  let t = out.answer;
  t = t.replace(/\n{0,2}^\s*Try:\s*[\s\S]*$/gmi, "");
  t = t.replace(/^\[[^\]]+\]\s*/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return { ...out, answer: t };
}

/* ---------------- Readiness detector ---------------- */
function isReadinessQuery(qn) {
  if (!qn) return false;
  if (qn.includes("readiness")) return true;
  if (qn.includes("how ready") && qn.includes("field")) return true;
  if (qn.includes("which fields") && (qn.includes("plant") || qn.includes("spray") || qn.includes("work") || qn.includes("till"))) return true;
  if (qn.includes("can we plant") || qn.includes("can we spray") || qn.includes("can we work") || qn.includes("can we till")) return true;
  return false;
}

/* ---------------- Follow-up detector ---------------- */
function looksLikeFollowup(qn) {
  if (!qn) return false;

  // short “reaction” questions that should stay on the last topic
  if (qn.length <= 32) {
    const triggers = [
      "only", "why", "how", "what about", "that seems wrong", "doesnt seem right",
      "are you sure", "really", "huh", "ok", "okay", "list them", "show them",
      "more", "tell me more", "explain", "details"
    ];
    if (triggers.some(x => qn.includes(x))) return true;
  }

  // specific patterns
  if (qn === "only 1 field?" || qn === "only one field?" || qn === "only 1?" || qn === "only one?") return true;
  if (qn.includes("list") && qn.includes("them")) return true;

  return false;
}

/* ---------------- Intent normalization ---------------- */
function normalizeIntent(question, state) {
  const raw = (question || "").toString().trim();
  const qn = norm(raw);

  const intent = {
    raw,
    topic: null,
    mode: null,
    args: {},
    normalizedQuestion: raw,
    isFollowup: false
  };

  if (!qn) return intent;

  // If it looks like a follow-up, keep the last intent topic
  if (looksLikeFollowup(qn) && state && state.lastIntent) {
    intent.isFollowup = true;
    intent.topic = String(state.lastIntent);
    intent.normalizedQuestion = raw;
    return intent;
  }

  // Boundaries: fields with boundary requests
  if ((qn.includes("field") || qn.includes("fields")) && (qn.includes("boundary") || qn.includes("boundaries"))) {
    intent.topic = "boundaryRequests";
    intent.mode = "fields";
    intent.normalizedQuestion = "fields with boundary requests";
    return intent;
  }

  // Readiness
  if (isReadinessQuery(qn)) {
    intent.topic = "readiness";
    intent.mode = "latest";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // Everything else: leave as raw and let canHandle* decide
  return intent;
}

/* ---------------- Main router ---------------- */
export async function handleChat({ question, snapshot, history, state }) {
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

  const intent = normalizeIntent(question, state);
  const qForHandlers = intent.normalizedQuestion || question;

  // Readiness
  if (intent.topic === "readiness") {
    const out = await answerFieldReadinessLatest({ question: qForHandlers, snapshot, history, state });
    out.meta = { ...(out.meta || {}), intent: "readiness" };
    return humanizeAnswer(out);
  }

  // Boundaries (fields mode)
  if (intent.topic === "boundaryRequests") {
    const out = await answerBoundaryRequests({ question: qForHandlers, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "boundaryRequests", intentMode: intent.mode || null };
    return humanizeAnswer(out);
  }

  // Normal routing
  if (canHandleEquipment(qForHandlers)) return humanizeAnswer(await answerEquipment({ question: qForHandlers, snapshot, intent }));
  if (canHandleBoundaryRequests(qForHandlers)) return humanizeAnswer(await answerBoundaryRequests({ question: qForHandlers, snapshot, intent }));
  if (canHandleBinSites(qForHandlers)) return humanizeAnswer(await answerBinSites({ question: qForHandlers, snapshot }));
  if (canHandleBinMovements(qForHandlers)) return humanizeAnswer(await answerBinMovements({ question: qForHandlers, snapshot }));
  if (canHandleAerialApplications(qForHandlers)) return humanizeAnswer(await answerAerialApplications({ question: qForHandlers, snapshot }));
  if (canHandleFieldTrials(qForHandlers)) return humanizeAnswer(await answerFieldTrials({ question: qForHandlers, snapshot }));

  if (canHandleGrainBagEvents(qForHandlers)) return humanizeAnswer(await answerGrainBagEvents({ question: qForHandlers, snapshot }));
  if (canHandleProducts(qForHandlers)) return humanizeAnswer(await answerProducts({ question: qForHandlers, snapshot }));
  if (canHandleRtkTowers(qForHandlers)) return humanizeAnswer(await answerRtkTowers({ question: qForHandlers, snapshot }));
  if (canHandleSeasonalPrecheck(qForHandlers)) return humanizeAnswer(await answerSeasonalPrecheck({ question: qForHandlers, snapshot }));
  if (canHandleStarfireMoves(qForHandlers)) return humanizeAnswer(await answerStarfireMoves({ question: qForHandlers, snapshot }));
  if (canHandleVehicleRegistrations(qForHandlers)) return humanizeAnswer(await answerVehicleRegistrations({ question: qForHandlers, snapshot }));
  if (canHandleCombineMetrics(qForHandlers)) return humanizeAnswer(await answerCombineMetrics({ question: qForHandlers, snapshot }));

  if (canHandleGrain(qForHandlers)) return humanizeAnswer(await answerGrain({ question: qForHandlers, snapshot, intent }));
  if (canHandleFields(qForHandlers)) return humanizeAnswer(await answerFields({ question: qForHandlers, snapshot, intent }));
  if (canHandleFarms(qForHandlers)) return humanizeAnswer(await answerFarms({ question: qForHandlers, snapshot }));
  if (canHandleFieldMaintenance(qForHandlers)) return humanizeAnswer(await answerFieldMaintenance({ question: qForHandlers, snapshot, intent }));

  // If it was a follow-up but we couldn't answer, don't insult the user with "early in development"
  if (intent.isFollowup && state && state.lastIntent) {
    return {
      answer: `I didn’t catch what you want me to do next. Do you want a list, a summary, or details?`,
      meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", intent: "followup_unknown", lastIntent: state.lastIntent }
    };
  }

  return {
    answer: `I didn’t understand that request. If you tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness), I’ll pull the right data.`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", intent: "unknown" }
  };
}
