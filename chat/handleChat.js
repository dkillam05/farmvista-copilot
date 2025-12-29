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
    t.includes("make this into a report") ||
    t.includes("make this a report") ||
    t.includes("turn this into a report") ||
    t.includes("turn that into a report") ||
    t.includes("print this") ||
    t.includes("print that") ||
    t.includes("print it") ||
    t.includes("export this") ||
    t.includes("export that") ||
    t.includes("export it") ||
    t.includes("pdf") ||
    t.includes("save this as a pdf") ||
    t.includes("i want this as a report") ||
    t.includes("i need this as a report") ||
    t.includes("can i get this as a report") ||
    t.includes("can you make this a report")
  );
}

/* --------------------------------------------------
   MAIN CHAT ROUTER
-------------------------------------------------- */
export async function handleChat({ question, snapshot }) {
  // 🚨 FIRST: check for report intent
  if (wantsReport(question)) {
    return {
      answer: "Got it — generating a report from the last answer.",
      action: "report",               // frontend will trigger /report
      meta: {
        intent: "report"
      }
    };
  }

  // Normal feature routing
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

  // Fallback help
  return {
    answer:
      `Try:\n` +
      `• Vehicle regs: "vehicle registrations", "vehicle reg expiring"\n` +
      `• StarFire: "starfire moves", "starfire receiver 456789"\n` +
      `• Pre-checks: "precheck templates", "precheck items"\n` +
      `• RTK: "rtk towers", "rtk network 4010"\n` +
      `• Products: "products summary", "seed list"\n` +
      `• Grain: "grain summary"\n` +
      `• Fields: "list fields"\n\n` +
      `When ready, just say:\n` +
      `• "make this into a report"\n` +
      `• "print this"\n` +
      `• "export this as a pdf"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
