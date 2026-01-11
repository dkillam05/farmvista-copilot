// /chat/resolve-fields.js  (FULL FILE)
// Rev: 2026-01-11-resolve-fields2
//
// Field resolver tool: resolve_field(query)
// Returns best match or candidates ("did you mean")

'use strict';

import { resolveEntity } from "./resolve-core.js";

export const resolveFieldTool = {
  type: "function",
  name: "resolve_field",
  description: "Fuzzy-resolve a field by user text (handles typos/slang). Returns match or candidates for 'did you mean'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "User-provided field reference (name, partial, typo, slang)." }
    },
    required: ["query"]
  }
};

export function resolveField(query) {
  return resolveEntity({
    table: "fields",
    idCol: "id",
    nameCol: "name",
    extraCols: ["county", "state", "farmName"],
    query,
    limitCandidates: 120,
    returnTop: 12
  });
}