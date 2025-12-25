import { maybeHandleMulti } from "./multi.js";

import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";
import { canHandleFieldReadinessWeather, answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";

export async function handleChat({ question, snapshot }) {
  // 1) Multi-intent (2–4 collections)
  const multi = await maybeHandleMulti({ question, snapshot });
  if (multi) return multi;

  // 2) Single-intent routing (normal behavior)
  if (canHandleAerialApplications(question)) {
    return answerAerialApplications({ question, snapshot });
  }

  if (canHandleFieldTrials(question)) {
    return answerFieldTrials({ question, snapshot });
  }

  if (canHandleFieldReadinessWeather(question)) {
    return answerFieldReadinessWeather({ question, snapshot });
  }

  if (canHandleGrain(question)) {
    return answerGrain({ question, snapshot });
  }

  if (canHandleFields(question)) {
    return answerFields({ question, snapshot });
  }

  return {
    answer:
      `Try:\n` +
      `• Multi: "fields and grain bags summary"\n` +
      `• Fields: "list fields"\n` +
      `• Grain: "grain summary", "grain bags"\n` +
      `• Aerial: "aerial open"\n` +
      `• Trials: "trials compare fungicide"\n` +
      `• Weather: "field <name> rain yesterday"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}