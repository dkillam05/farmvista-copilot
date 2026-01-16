// /chat/domains/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-16a  domain:rtkTowers
//
// Purpose:
// - Own RTK tower follow-up helper + (later) tower profile tool.
// - Not wired yet.

'use strict';

import { norm } from "../lib/shared.js";

export function rtkTowersToolDefs() {
  // Later: rtk_tower_profile, rtk_tower_list, etc.
  return [];
}

export function rtkTowersHandleToolCall(/* name, args, ctx */) {
  // Not wired yet.
  return null;
}

/* =====================================================================
   ✅ "that tower" follow-up helper (moved from handleChat, unchanged)
===================================================================== */
export function userAsksTowerDetails(text) {
  const t = norm(text);
  return (t.includes("network") || t.includes("frequency") || t.includes("freq") || t.includes("net id") || t.includes("network id"));
}