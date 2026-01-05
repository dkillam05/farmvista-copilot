// /chat/executePlannedQuestion.js  (FULL FILE)
// Rev: 2026-01-04-executePlannedQuestion4
//
// Execute the planner rewrite via your existing router, forcing scope in text.

'use strict';

import { routeQuestion } from "./router.js";

export async function executePlannedQuestion({ rewriteQuestion, snapshot, user, state = null, includeArchived = false }) {
  const forced = includeArchived
    ? `${rewriteQuestion} including archived`
    : `${rewriteQuestion} active only`;

  return await routeQuestion({
    question: forced,
    snapshot,
    user,
    state
  });
}