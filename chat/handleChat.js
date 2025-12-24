import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";

export async function handleChat({ question, snapshot }) {
  // Field Trials
  if (canHandleFieldTrials(question)) {
    return answerFieldTrials({ question, snapshot });
  }

  // Field-readiness weather (requires "field ..." + rain/temp)
  if (canHandleFieldReadinessWeather(question)) {
    return answerFieldReadinessWeather({ question, snapshot });
  }

  // Grain
  if (canHandleGrain(question)) {
    return answerGrain({ question, snapshot });
  }

  // Fields
  if (canHandleFields(question)) {
    return answerFields({ question, snapshot });
  }

  return {
    answer:
      `Try:\n` +
      `• Trials: "trials summary", "trials pending", "trial <id>"\n` +
      `• Fields: "list fields", "field <name>"\n` +
      `• Grain: "grain summary", "grain bags"\n` +
      `• Weather: "field <name> rain yesterday"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
