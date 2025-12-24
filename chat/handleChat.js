import { canHandleFields, answerFields } from "../features/fields.js";

export async function handleChat({ question, snapshot }) {
  // Route to the right feature module
  if (canHandleFields(question)) {
    return answerFields({ question, snapshot });
  }

  // Default help (until we add more modules)
  return {
    answer:
      `I can help with Fields right now.\n\n` +
      `Try:\n• "list fields"\n• "field <name>"\n• "debug fields"`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown" }
  };
}
