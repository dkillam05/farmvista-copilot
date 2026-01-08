// /chat/intentContracts.js  (FULL FILE)
// Rev: 2026-01-06-intentContracts1
//
// Defines what a "complete" SQL answer must contain per intent.
// If the SQL result doesn't meet the contract, we FAIL FAST with a helpful error.
// No handler fallback.

'use strict';

export const INTENT_CONTRACTS = {
  // Tower detail/info: requires freq + networkId at minimum
  rtk_tower_info: {
    minRows: 1,
    requiredColumns: ["tower", "frequencyMHz", "networkId"]
  },

  // Field -> tower info: field + tower required; show freq/net if available
  field_rtk_info: {
    minRows: 1,
    requiredColumns: ["field", "tower", "frequencyMHz", "networkId"]
  },

  // Field info (not tower): must include field name
  field_info: {
    minRows: 1,
    requiredColumns: ["field"]
  },

  // Lists
  list_fields: {
    minRows: 1,
    requiredColumns: ["field"]
  },
  list_farms: {
    minRows: 1,
    requiredColumns: ["farm"]
  },
  list_counties: {
    minRows: 1,
    requiredColumns: ["county"]
  },
  list_rtk_towers: {
    minRows: 1,
    requiredColumns: ["tower"]
  },

  // Metrics
  count: {
    minRows: 1,
    requiredColumns: ["value"]
  },
  sum: {
    minRows: 1,
    requiredColumns: ["value"]
  },
  group_metric: {
    minRows: 1,
    requiredColumns: ["label", "value"]
  }
};