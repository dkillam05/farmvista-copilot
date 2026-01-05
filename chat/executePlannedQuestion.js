// /chat/executePlannedQuestion.js  (FULL FILE)
// Rev: 2026-01-04-execPlan1
//
// Executes the planner's rewriteQuestion against existing deterministic handlers.

'use strict';

import { handleFarmsFields } from "../handlers/farmsFields.handler.js";
import { handleRTK } from "../handlers/rtk.handler.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function looksRTK(q) {
  const s = norm(q);
  return (
    s.includes("rtk") ||
    s.includes("tower") ||
    s.includes("mhz") ||
    s.includes("network id") ||
    s.includes("net ")
  );
}

export async function executePlannedQuestion({ rewriteQuestion, snapshot, user, includeArchived = false }) {
  const q = (rewriteQuestion || "").toString();

  // Route RTK vs farms/fields
  if (looksRTK(q)) {
    return await handleRTK({ question: q, snapshot, user, includeArchived, meta: { routerReason: "llm_plan_rtk" } });
  }

  return await handleFarmsFields({ question: q, snapshot, user, includeArchived, meta: { routerReason: "llm_plan_ff" } });
}