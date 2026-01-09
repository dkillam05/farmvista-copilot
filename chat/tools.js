'use strict';

/*
  Canonical tool definitions.
  OpenAI chooses ONE of these per message.
*/

export const TOOLS = [
  {
    name: "query_fields",
    description: "Query fields with optional filters",
    input_schema: {
      type: "object",
      properties: {
        county: { type: "string" },
        farm: { type: "string" },
        rtkTower: { type: "string" },
        metric: { type: "string", enum: ["hel", "crp", "tillable"] },
        metricGt: { type: "number" },
        groupBy: { type: "string", enum: ["county", "farm"] },
        limit: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "field_info",
    description: "Get full information for a single field",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string" }
      },
      required: ["field"]
    }
  },
  {
    name: "rtk_info",
    description: "Get RTK tower information",
    input_schema: {
      type: "object",
      properties: {
        tower: { type: "string" }
      },
      required: ["tower"]
    }
  }
];
