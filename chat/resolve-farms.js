// /chat/resolve-farms.js  (FULL FILE)
// Rev: 2026-01-11-resolve-farms2-abbrev
//
// Adds abbreviation expansion so:
// - "cville" matches "Cville-StdCty-Barnet"
// - short slang works better without changing resolve-core

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

function norm(s){
  return (s || "").toString().trim().toLowerCase();
}

function expandFarmQuery(qRaw){
  const q = norm(qRaw);
  if (!q) return "";

  // Common Dowson shorthand expansions
  // Keep these conservative; they only add helpful tokens.
  const expands = [];

  expands.push(q);

  if (q === "cville" || q === "cvill" || q === "carlinville" || q.includes("carlin")) {
    expands.push("cville stdcty barnet");
    expands.push("cville std cty barnet");
  }

  if (q === "mt auburn" || q.includes("mtaub")) expands.push("illiopolis mtauburn");
  if (q.includes("divernon")) expands.push("divernon farmersvile");
  if (q.includes("sherman")) expands.push("shermn wville elkhrt");

  // Join expansions into a single broader query string that will widen LIKE matching
  // resolve-core will generate multiple LIKE patterns from tokens.
  return expands.join(" ");
}

export function resolveFarm(query) {
  const expanded = expandFarmQuery(query);

  return resolveEntity({
    table: "farms",
    idCol: "id",
    nameCol: "name",
    extraCols: [],
    query: expanded,
    limitCandidates: 80,
    returnTop: 12
  });
}