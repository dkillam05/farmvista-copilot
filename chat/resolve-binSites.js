// /chat/resolve-binSites.js
// Thin resolver — NO intent logic

'use strict';

import { resolveEntity } from "./resolve-core.js";

export const resolveBinSiteTool = {
  type: "function",
  name: "resolve_binSite",
  description: "Resolve a bin site by name (handles typos/slang).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" }
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
    limitCandidates: 50,
    returnTop: 10
  });
}