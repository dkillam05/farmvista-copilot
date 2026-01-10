// /chat/resolve-farms.js  (FULL FILE)
// Rev: 2026-01-10-resolve-farms1
//
// Farm resolver tool: resolve_farm(query)

'use strict';

import { resolveEntity } from "./resolve-core.js";

export const resolveFarmTool = {
  type: "function",
  name: "resolve_farm",
  description: "Fuzzy-resolve a farm by user text (handles typos/slang). Returns match or candidates for 'did you mean'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "User-provided farm reference (name, partial, typo, slang)." }
    },
    required: ["query"]
  }
};

export function resolveFarm(query) {
  return resolveEntity({
    table: "farms",
    idCol: "id",
    nameCol: "name",
    extraCols: [],
    query,
    limitCandidates: 60,
    returnTop: 12
  });
}
