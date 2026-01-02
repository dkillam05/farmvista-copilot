// /chat/multi.js  (FULL FILE)
// Rev: 2026-01-02-disable-multi
//
// Multi-intent routing is DISABLED.
//
// Why:
// - The old system guessed modules by keywords and caused dumb/confusing answers.
// - We are rebuilding one feature at a time using explicit /data/* lookups.
// - Chat should not auto-combine multiple domains in a single response.
//
// Contract:
// - maybeHandleMulti(...) returns null so the normal chat handler runs.

'use strict';

/**
 * Returns null to indicate: do not handle as multi-intent.
 * @returns {Promise<null>}
 */
export async function maybeHandleMulti() {
  return null;
}
