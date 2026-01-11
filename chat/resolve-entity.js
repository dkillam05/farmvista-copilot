// /chat/resolve-entity.js  (FULL FILE)
// Rev: 2026-01-11-resolve-entity1
//
// Generic resolver tool: resolve_entity({ type, query })
// Uses existing resolve-core scoring via resolveEntity() but routes by registry.

'use strict';

import { resolveEntity } from "./resolve-core.js";
import { getEntity, listEntityTypes } from "./entityRegistry.js";

export const resolveEntityTool = {
  type: "function",
  name: "resolve_entity",
  description: "Resolve an entity by type (farms/fields/rtkTowers/etc) with typo tolerance. Returns match or candidates for 'did you mean'.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: "Entity type. One of: farms, fields, rtkTowers." },
      query: { type: "string", description: "User-provided name/partial/typo." }
    },
    required: ["type", "query"]
  }
};

export function resolveEntityGeneric(type, query) {
  const ent = getEntity(type);
  if (!ent) {
    return { ok: false, error: `Unknown entity type "${type}". Allowed: ${listEntityTypes().join(", ")}` };
  }

  return resolveEntity({
    table: ent.table,
    idCol: ent.idCol,
    nameCol: ent.nameCol,
    extraCols: [],
    query,
    limitCandidates: 120,
    returnTop: 12
  });
}