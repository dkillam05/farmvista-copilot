import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";

export async function handleChat({ question, snapshot }) {
  // Field-readiness weather (requires "field ..." and rain/temp keywords)
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
      `• Fields: "list fields", "field <name>"\n` +
      `• Grain: "grain summary", "grain bags"\n` +
      `• Field Readiness Weather: "field <name> rain yesterday", "field <name> rain last 3 days", "field <name> temp now"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
