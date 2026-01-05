// /chat/executePlannedQuestion.js  (FULL FILE)
// Rev: 2026-01-04-executePlannedQuestion3
//
// Executes the LLM plan against your existing deterministic router/handlers.

'use strict';

import { routeQuestion } from "./router.js";

export async function executePlannedQuestion({ rewriteQuestion, snapshot, user, state = null, includeArchived = false }) {
  // Force scope via suffix so existing includeArchived detection works without refactors
  const forced = includeArchived ? `${rewriteQuestion} including archived` : `${rewriteQuestion} active only`;

  return await routeQuestion({
    question: forced,
    snapshot,
    user,
    state
  });
}