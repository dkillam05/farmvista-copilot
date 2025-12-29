// /chat/handleChat.js  (FULL FILE)

import { canHandleEquipment, answerEquipment } from "../features/equipment.js";
import { canHandleBoundaryRequests, answerBoundaryRequests } from "../features/boundaryRequests.js";
import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { canHandleFieldReadinessLatest, answerFieldReadinessLatest } from "../features/fieldReadinessLatest.js";
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
  const t = (text || "").toString().toLowerCase();
  if (!t) return false;

  // broad but safe: requires a “report-ish” verb/noun
  return (
    t.includes("make") && (t.includes("report") || t.includes("pdf") || t.includes("print")) ||
    t.includes("turn") && (t.includes("report") || t.includes("pdf")) ||
    t.includes("export") && (t.includes("pdf") || t.includes("report")) ||
    t.includes("print this") ||
    t.includes("print that") ||
    t.includes("make this into a report") ||
    t.includes("make a report of") ||
    t.includes("report of everything") ||
    t.includes("everything so far") && (t.includes("report") || t.includes("pdf") || t.includes("print"))
  );
}
function wantsFullConversation(text) {
  const t = (text || "").toString().toLowerCase();
  return (
    t.includes("everything") ||
    t.includes("entire") ||
    t.includes("whole conversation") ||
    t.includes("so far")
  );
}

/* --------------------------------------------------
   MAIN CHAT ROUTER
-------------------------------------------------- */
export async function handleChat({ question, snapshot }) {
  // 🚨 report trigger (frontend should: auto-open + also show link)
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

  // Feature routing
  if (canHandleEquipment(question)) return answerEquipment({ question, snapshot });
  if (canHandleBoundaryRequests(question)) return answerBoundaryRequests({ question, snapshot });
  if (canHandleBinSites(question)) return answerBinSites({ question, snapshot });
  if (canHandleBinMovements(question)) return answerBinMovements({ question, snapshot });
  if (canHandleAerialApplications(question)) return answerAerialApplications({ question, snapshot });
  if (canHandleFieldTrials(question)) return answerFieldTrials({ question, snapshot });
  if (canHandleFieldReadinessWeather(question)) return answerFieldReadinessWeather({ question, snapshot });
  if (canHandleFieldReadinessLatest(question)) return answerFieldReadinessLatest({ question, snapshot });
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

  return {
    answer:
      `Try:\n` +
      `• Combine: "combine yield last 10", "combine loss last 10", "yield calibration last 10", "combine yield field 1027", "combine loss combine x9"\n` +
      `• Vehicle regs: "vehicle registrations", "vehicle reg expiring"\n` +
      `• StarFire: "starfire moves", "starfire receiver 456789"\n` +
      `• Pre-checks: "precheck templates", "precheck items"\n` +
      `• RTK: "rtk towers", "rtk network 4010"\n` +
      `• Products: "products summary", "seed list"\n` +
      `• Fields: "list fields"\n\n` +
      `When ready, say: "make this into a report" / "print this" / "export pdf"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
