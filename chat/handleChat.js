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
import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";
import { canHandleFarms, answerFarms } from "../features/farms.js";
import { canHandleFieldMaintenance, answerFieldMaintenance } from "../features/fieldMaintenance.js";

/* --------------------------------------------------
   REPORT INTENT DETECTION
-------------------------------------------------- */
function wantsReport(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  return (
    t.includes("report") ||
    t.includes("print") ||
    t.includes("pdf") ||
    t.includes("export") ||
    t.includes("make this") ||
    t.includes("everything so far")
  );
}

function wantsFullConversation(text) {
  if (!text) return false;
  const t = text.toLowerCase();
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
  // 🚨 Report intent short-circuit
  if (wantsReport(question)) {
    const mode = wantsFullConversation(question) ? "conversation" : "recent";

    return {
      answer:
        `✅ **Report generated**\n\n` +
        `• The PDF has been opened for you.\n` +
        `• You can re-open it anytime using the link below.`,
      action: "report",
      meta: {
        intent: "report",
        reportMode: mode,
        reportUrl: `/report?mode=${mode}`
      }
    };
  }

  // Normal routing
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
  if (canHandleGrain(question)) return answerGrain({ question, snapshot });
  if (canHandleFields(question)) return answerFields({ question, snapshot });
  if (canHandleFarms(question)) return answerFarms({ question, snapshot });
  if (canHandleFieldMaintenance(question)) return answerFieldMaintenance({ question, snapshot });

  return {
    answer:
      `Ask a question normally.\n\n` +
      `When ready, say things like:\n` +
      `• "make this into a report"\n` +
      `• "print this"\n` +
      `• "make a report of everything so far"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
