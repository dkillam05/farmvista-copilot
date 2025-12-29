// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-29s  (Hard-route readiness to Latest; thresholds only when asked)

import { canHandleEquipment, answerEquipment } from "../features/equipment.js";
import { canHandleBoundaryRequests, answerBoundaryRequests } from "../features/boundaryRequests.js";
import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";

import { canHandleFieldReadinessLatest, answerFieldReadinessLatest } from "../features/fieldReadinessLatest.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";

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

/* --------------------------------------------------
   READINESS HARD ROUTING
-------------------------------------------------- */
function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

function isReadinessIntent(qn) {
  if (!qn) return false;

  // Direct
  if (qn.includes("readiness")) return true;
  if (qn.includes("field readiness")) return true;

  // Natural phrasing
  if (qn.includes("how ready") && qn.includes("field")) return true;
  if (qn.includes("which fields") && (qn.includes("plant") || qn.includes("spray") || qn.includes("work") || qn.includes("till"))) return true;
  if (qn.includes("can we plant") || qn.includes("can we spray") || qn.includes("can we till")) return true;

  return false;
}

function isWeatherOrThresholdQuestion(qn) {
  // Only route to the thresholds/weather module if they clearly ask for it.
  return (
    qn.includes("threshold") ||
    qn.includes("thresholds") ||
    qn.includes("operation threshold") ||
    qn.includes("planting threshold") ||
    qn.includes("spraying threshold") ||
    qn.includes("tillage threshold") ||
    qn.includes("weather") ||
    qn.includes("forecast") ||
    qn.includes("rain") ||
    qn.includes("rainfall") ||
    qn.includes("precip") ||
    qn.includes("snow") ||
    qn.includes("temperature") ||
    qn.includes("temp")
  );
}

/* --------------------------------------------------
   MAIN CHAT ROUTER
-------------------------------------------------- */
export async function handleChat({ question, snapshot }) {
  // 🚨 report trigger
  if (wantsReport(question)) {
    const mode = wantsFullConversation(question) ? "conversation" : "recent";
    return {
      answer:
        `✅ Report ready.\n` +
        `I’m opening the PDF now.\n\n` +
        `Open again: /report?mode=${mode}`,
      action: "report",
      meta: { intent: "report", reportMode: mode, reportUrl: `/report?mode=${mode}` }
    };
  }

  const qn = norm(question);

  // ✅ HARD OVERRIDE:
  // If it’s a readiness question AND not explicitly weather/thresholds,
  // we always use fieldReadinessLatest. No other module gets a chance.
  if (isReadinessIntent(qn) && !isWeatherOrThresholdQuestion(qn)) {
    // Even if canHandleFieldReadinessLatest is too strict, we still call it,
    // because the user clearly asked for readiness.
    return answerFieldReadinessLatest({ question, snapshot });
  }

  // If user explicitly asked about thresholds/weather, route to Weather module
  if (isReadinessIntent(qn) && isWeatherOrThresholdQuestion(qn)) {
    return answerFieldReadinessWeather({ question, snapshot });
  }

  // Other features
  if (canHandleEquipment(question)) return answerEquipment({ question, snapshot });
  if (canHandleBoundaryRequests(question)) return answerBoundaryRequests({ question, snapshot });
  if (canHandleBinSites(question)) return answerBinSites({ question, snapshot });
  if (canHandleBinMovements(question)) return answerBinMovements({ question, snapshot });
  if (canHandleAerialApplications(question)) return answerAerialApplications({ question, snapshot });
  if (canHandleFieldTrials(question)) return answerFieldTrials({ question, snapshot });

  if (canHandleGrainBagEvents(question)) return answerGrainBagEvents({ question, snapshot });
  if (canHandleProducts(question)) return answerProducts({ question, snapshot });
  if (canHandleRtkTowers(question)) return answerRtkTowers({ question, snapshot });
  if (canHandleSeasonalPrecheck(question)) return answerSeasonalPrecheck({ question, snapshot });
  if (canHandleStarfireMoves(question)) return answerStarfireMoves({ question, snapshot });
  if (canHandleVehicleRegistrations(question)) return answerVehicleRegistrations({ question, snapshot });
  if (canHandleCombineMetrics(question)) return answerCombineMetrics({ question, snapshot });

  if (canHandleGrain(question)) return answerGrain({ question, snapshot });
  if (canHandleFields(question)) return answerFields({ question, snapshot });
  if (canHandleFarms(question)) return answerFarms({ question, snapshot });
  if (canHandleFieldMaintenance(question)) return answerFieldMaintenance({ question, snapshot });

  // fallback
  return {
    answer:
      `Try:\n` +
      `• Readiness: "readiness summary", "readiness top 10", "readiness bottom 10", "which fields can we plant"\n` +
      `• Thresholds/weather: "readiness thresholds", "field 0100 rain yesterday", "field 0513 forecast"\n` +
      `• Combine: "combine yield last 10", "combine loss last 10", "yield calibration last 10"\n` +
      `• Fields: "list fields"\n\n` +
      `When ready, say: "make this into a report" / "print this" / "export pdf"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
