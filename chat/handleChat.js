// /chat/handleChat.js  (FULL FILE)

import { canHandleEquipment, answerEquipment } from "../features/equipment.js";
import { canHandleBoundaryRequests, answerBoundaryRequests } from "../features/boundaryRequests.js";
import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";
import { canHandleFarms, answerFarms } from "../features/farms.js";

export async function handleChat({ question, snapshot }) {
  if (canHandleEquipment(question)) return answerEquipment({ question, snapshot });
  if (canHandleBoundaryRequests(question)) return answerBoundaryRequests({ question, snapshot });
  if (canHandleBinSites(question)) return answerBinSites({ question, snapshot });
  if (canHandleBinMovements(question)) return answerBinMovements({ question, snapshot });
  if (canHandleAerialApplications(question)) return answerAerialApplications({ question, snapshot });
  if (canHandleFieldTrials(question)) return answerFieldTrials({ question, snapshot });
  if (canHandleFieldReadinessWeather(question)) return answerFieldReadinessWeather({ question, snapshot });
  if (canHandleGrain(question)) return answerGrain({ question, snapshot });
  if (canHandleFields(question)) return answerFields({ question, snapshot });
  if (canHandleFarms(question)) return answerFarms({ question, snapshot });

  return {
    answer:
      `Try:\n` +
      `• Farms: "farms", "farm Pisgah", "active farms", "unused farms"\n` +
      `• Equipment: "equipment summary", "equipment type starfire", "equipment search 8R410"\n` +
      `• Boundaries: "boundaries open"\n` +
      `• Bin Sites: "binsites summary"\n` +
      `• Bin Movements: "bins net last 7 days"\n` +
      `• Aerial: "aerial summary"\n` +
      `• Trials: "trials compare fungicide"\n` +
      `• Grain: "grain summary"\n` +
      `• Fields: "list fields"\n` +
      `• Weather: "field <name> rain yesterday"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
