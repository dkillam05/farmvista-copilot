// /routers/grainRouter.js  (FULL FILE)
// Rev: 2025-12-31-grain-domain-router
//
// Purpose:
// Centralize ALL grain intent decisions in one place so features stay split,
// but the user experience is unified and consistent.
//
// Outputs a plan:
//   { kind: "clarify", key, answer }
//   { kind: "route", topic, question, intent }

const norm = (s) => (s || "").toString().trim().toLowerCase();

function buildClarify(lines) {
  return (
    "Quick question so I pull the right data:\n" +
    lines.map((l, i) => `${i + 1}) ${l}`).join("\n") +
    "\n\nReply with 1, 2, or 3."
  );
}

function pickChoice(txt) {
  const t = norm(txt);
  if (!t) return null;
  if (t === "1" || t === "one") return 1;
  if (t === "2" || t === "two") return 2;
  if (t === "3" || t === "three") return 3;
  return null;
}

/**
 * Resolve a pending clarify for grain domain.
 * pendingKey examples:
 *   "grain"
 *   "grainbags"
 *   "bins"
 */
function resolvePending(pendingKey, userText) {
  const n = pickChoice(userText);
  if (!n) return null;

  if (pendingKey === "grain") {
    if (n === 1) return { topic: "grain", question: "grain bags", intent: { topic: "grain", mode: "bags" } };
    if (n === 2) return { topic: "grain", question: "grain bins", intent: { topic: "grain", mode: "bins" } };
    if (n === 3) return { topic: "grain", question: "grain summary", intent: { topic: "grain", mode: "summary" } };
    return null;
  }

  if (pendingKey === "grainbags") {
    if (n === 1) return { topic: "grain", question: "grain bags", intent: { topic: "grain", mode: "bags" } };
    if (n === 2) return { topic: "grainBagEvents", question: "grain bags putdowns", intent: { topic: "grainBagEvents", mode: "putdowns" } };
    if (n === 3) return { topic: "grainBagEvents", question: "grain bags events last 10", intent: { topic: "grainBagEvents", mode: "events" } };
    return null;
  }

  if (pendingKey === "bins") {
    if (n === 1) return { topic: "binSites", question: "binsites summary", intent: { topic: "binSites" } };
    if (n === 2) return { topic: "binMovements", question: "bins summary", intent: { topic: "binMovements" } };
    if (n === 3) return { topic: "grain", question: "grain bins", intent: { topic: "grain", mode: "bins" } };
    return null;
  }

  return null;
}

/**
 * Decide grain routing or clarify.
 */
export function grainPlan({ question, pendingKey }) {
  const raw = (question || "").toString().trim();
  const qn = norm(raw);

  // 1) If we're in a pending clarify, resolve if user replied 1/2/3
  if (pendingKey) {
    const resolved = resolvePending(pendingKey, raw);
    if (resolved) return { kind: "route", ...resolved };
    // If they replied something else, keep asking the same clarify
    if (pickChoice(raw)) {
      return { kind: "clarify", key: pendingKey, answer: clarifyText(pendingKey) };
    }
  }

  // 2) HARD PRIORITY: events / putdowns / pickups should ALWAYS go to grainBagEvents
  // This fixes your "grain bags events last 5" routing bug.
  const wantsEvents =
    qn.includes("event") || qn.includes("events") ||
    qn.includes("activity") || qn.includes("history") ||
    qn.includes("putdown") || qn.includes("put down") ||
    qn.includes("pickup") || qn.includes("pick up");

  if (qn.includes("grain") && qn.includes("bag") && wantsEvents) {
    return { kind: "route", topic: "grainBagEvents", question: raw, intent: { topic: "grainBagEvents" } };
  }

  // 3) Grain bag inventory ambiguity (on-hand vs placed vs activity)
  const mentionsBags =
    qn.includes("grain bag") || qn.includes("grain bags") ||
    qn.includes("bag inventory") || qn.includes("bags inventory") ||
    qn === "grain bags" || qn === "bags";

  const mentionsInventory = qn.includes("inventory") || qn.includes("on hand") || qn.includes("onhand");
  const mentionsPlaced = qn.includes("placed") || qn.includes("where") || qn.includes("field");
  const mentionsAny = mentionsInventory || mentionsPlaced || qn.includes("inventory");

  const alreadySpecific =
    wantsEvents ||
    qn.includes("on hand") || qn.includes("onhand") ||
    qn.startsWith("sku ") || qn.startsWith("grain sku ") || qn.startsWith("bags sku ");

  if (mentionsBags && mentionsAny && !alreadySpecific) {
    return { kind: "clarify", key: "grainbags", answer: clarifyText("grainbags") };
  }

  // 4) Grain broad (grain/show grain/grain inventory)
  if (qn === "grain" || qn === "show grain" || qn === "grain inventory") {
    return { kind: "clarify", key: "grain", answer: clarifyText("grain") };
  }

  // 5) Bins ambiguity
  if (qn === "bins" || qn === "bin" || qn === "show bins" || qn === "grain bins") {
    // if they explicitly said movements, route movements
    if (qn.includes("movement")) return { kind: "route", topic: "binMovements", question: raw, intent: { topic: "binMovements" } };
    return { kind: "clarify", key: "bins", answer: clarifyText("bins") };
  }

  // 6) If it’s clearly grain but not ambiguous, route to grain
  if (qn.includes("grain")) {
    return { kind: "route", topic: "grain", question: raw, intent: { topic: "grain" } };
  }

  return null;
}

function clarifyText(key) {
  if (key === "grain") {
    return buildClarify(["Grain bags", "Grain bins", "Grain summary"]);
  }
  if (key === "grainbags") {
    return buildClarify([
      "On-hand inventory (by SKU)",
      "Where bags are placed (putDown / pickUp by field)",
      "Recent bag activity (events)"
    ]);
  }
  if (key === "bins") {
    return buildClarify(["Bin sites (locations)", "Bin movements (in/out/net)", "Both: sites + movements summary"]);
  }
  return buildClarify(["Option 1", "Option 2", "Option 3"]);
}
