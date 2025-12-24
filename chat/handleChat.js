import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";

export async function handleChat({ question, snapshot }) {
  // Grain first (broad keyword)
  if (canHandleGrain(question)) {
    return answerGrain({ question, snapshot });
  }

  // Fields
  if (canHandleFields(question)) {
    return answerFields({ question, snapshot });
  }

  return {
    answer:
      `I can help with:\n\n` +
      `• Grain: "grain summary", "grain bags", "grain bins"\n` +
      `• Fields: "list fields", "field <name>"\n`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
