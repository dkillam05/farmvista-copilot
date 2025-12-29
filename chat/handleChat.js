import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";

export async function handleChat({ question, snapshot }) {
  if (canHandleBinSites(question)) return answerBinSites({ question, snapshot });
  if (canHandleBinMovements(question)) return answerBinMovements({ question, snapshot });
  if (canHandleAerialApplications(question)) return answerAerialApplications({ question, snapshot });
  if (canHandleFieldTrials(question)) return answerFieldTrials({ question, snapshot });
  if (canHandleFieldReadinessWeather(question)) return answerFieldReadinessWeather({ question, snapshot });
  if (canHandleGrain(question)) return answerGrain({ question, snapshot });
  if (canHandleFields(question)) return answerFields({ question, snapshot });

  return {
    answer:
      `Try:\n` +
      `• Bin Sites: "binsites summary", "binsite \\"FPI Macomb\\"", "binsite <siteId>"\n` +
      `• Bin Movements: "bins summary", "bins site \\"FPI Macomb\\"", "bins net last 7 days"\n` +
      `• Aerial: "aerial summary"\n` +
      `• Trials: "trials summary", "trials compare fungicide"\n` +
      `• Grain: "grain summary"\n` +
      `• Fields: "list fields"\n` +
      `• Weather: "field <name> rain yesterday"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
