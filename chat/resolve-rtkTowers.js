// /chat/resolve-rtkTowers.js  (FULL FILE)
// Rev: 2026-01-10-resolve-rtkTowers1
//
// RTK Tower resolver tool: resolve_rtk_tower(query)

'use strict';

import { resolveEntity } from "./resolve-core.js";

export const resolveRtkTowerTool = {
  type: "function",
  name: "resolve_rtk_tower",
  description: "Fuzzy-resolve an RTK tower by user text (handles typos/slang). Returns match or candidates for 'did you mean'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "User-provided RTK tower reference (name, partial, typo, slang)." }
    },
    required: ["query"]
  }
};

export function resolveRtkTower(query) {
  return resolveEntity({
    table: "rtkTowers",
    idCol: "id",
    nameCol: "name",
    // Your snapshot builder currently uses columns networkId/frequency/provider.
    // If you later store frequencyMHz, add it to extraCols too.
    extraCols: ["networkId", "frequency", "provider"],
    query,
    limitCandidates: 60,
    returnTop: 12
  });
}
