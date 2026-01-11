// /chat/resolve-binSites.js  (FULL FILE)
// Rev: 2026-01-11-resolve-binSites1
//
// Bin site resolver tool: resolve_binSite(query)
// Thin resolver only (no intent logic)

'use strict';

import { resolveEntity } from "./resolve-core.js";

export const resolveBinSiteTool = {
  type: "function",
  name: "resolve_binSite",
  description: "Fuzzy-resolve a bin site by user text (handles typos/slang). Returns match or candidates for 'did you mean'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "User-provided bin site reference (name, partial, typo, slang)." }
    },
    required: ["query"]
  }
};

export function resolveBinSite(query) {
  return resolveEntity({
    table: "binSites",
    idCol: "id",
    nameCol: "name",
    extraCols: [],
    query,
    limitCandidates: 60,
    returnTop: 12
  });
}