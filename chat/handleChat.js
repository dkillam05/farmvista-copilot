// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-30-clarify-gate (Option A: ask follow-ups only when ambiguous; supports 1/2/3 replies via state.lastIntent)

import { canHandleEquipment, answerEquipment } from "../features/equipment.js";
import { canHandleBoundaryRequests, answerBoundaryRequests } from "../features/boundaryRequests.js";
import { canHandleBinSites, answerBinSites } from "../features/binSites.js";
import { canHandleBinMovements, answerBinMovements } from "../features/binMovements.js";
import { canHandleAerialApplications, answerAerialApplications } from "../features/aerialApplications.js";
import { canHandleFieldTrials, answerFieldTrials } from "../features/fieldTrials.js";

import { answerFieldReadinessLatest } from "../features/fieldReadinessLatest.js";

import { canHandleGrainBagEvents, answerGrainBagEvents } from "../features/grainBagEvents.js";
import { canHandleProducts, answerProducts } from "../features/products.js";
import { canHandleRtkTowers, answerRtkTowers } from "../features/rtkTowers.js";
import { canHandleSeasonalPrecheck, answerSeasonalPrecheck } from "../features/seasonalPrecheck.js";
import { canHandleStarfireMoves, answerStarfireMoves } from "../features/starfireMoves.js";
import { canHandleVehicleRegistrations, answerVehicleRegistrations } from "../features/vehicleRegistrations.js";
import { canHandleCombineMetrics, answerCombineMetrics } from "../features/combineMetrics.js";

import { canHandleGrain, answerGrain } from "../features/grain.js";
import { canHandleFields, answerFields } from "../features/fields.js";
import { canHandleFarms, answerFarms } from "../features/farms.js";
import { canHandleFieldMaintenance, answerFieldMaintenance } from "../features/fieldMaintenance.js";

/* --------------------------------------------------
   Prompt templates (these can live in /prompts later)
-------------------------------------------------- */
const PROMPTS = {
  clarifyPrefix: "Quick question so I pull the right data:",
  pickOne: "Reply with 1, 2, or 3.",
  unknownArea:
    `I didn’t understand that request.\n\n` +
    `Tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness, rtk), and I’ll pull the right data.`
};

/* --------------------------------------------------
   REPORT INTENT DETECTION (no buttons)
-------------------------------------------------- */
function wantsReport(text) {
  const t = (text || "").toString().toLowerCase().trim();
  if (!t) return false;

  return (
    (t.includes("make") && (t.includes("report") || t.includes("pdf") || t.includes("print"))) ||
    (t.includes("turn") && (t.includes("report") || t.includes("pdf"))) ||
    (t.includes("export") && (t.includes("pdf") || t.includes("report"))) ||
    t.includes("print this") ||
    t.includes("print that") ||
    t.includes("make this into a report") ||
    t.includes("make a report of") ||
    (t.includes("everything so far") && (t.includes("report") || t.includes("pdf") || t.includes("print")))
  );
}

function wantsFullConversation(text) {
  const t = (text || "").toString().toLowerCase();
  return t.includes("everything") || t.includes("entire") || t.includes("whole conversation") || t.includes("so far");
}

const norm = (s) => (s || "").toString().trim().toLowerCase();

/* --------------------------------------------------
   OUTPUT HUMANIZER
-------------------------------------------------- */
function humanizeAnswer(out) {
  if (!out || typeof out !== "object") return out;
  if (typeof out.answer !== "string") return out;

  let t = out.answer;

  // remove old CLI menus from legacy features
  t = t.replace(/\n{0,2}^\s*Try:\s*[\s\S]*$/gmi, "");

  // remove internal bracket tags
  t = t.replace(/^\[[^\]]+\]\s*/gm, "");

  // collapse spacing
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return { ...out, answer: t };
}

function isReadinessQuery(qn) {
  if (!qn) return false;
  if (qn.includes("readiness")) return true;
  if (qn.includes("how ready") && qn.includes("field")) return true;
  if (qn.includes("which fields") && (qn.includes("plant") || qn.includes("spray") || qn.includes("work") || qn.includes("till"))) return true;
  if (qn.includes("can we plant") || qn.includes("can we spray") || qn.includes("can we work") || qn.includes("can we till")) return true;
  return false;
}

/* --------------------------------------------------
   Clarify Gate (Option A): only when ambiguous
   Mechanism:
   - We return meta.intent like "clarify:rtk" / "clarify:boundaries"
   - copilotLogs stores that as assistant intent
   - deriveStateFromHistory exposes state.lastIntent
   - next user message "1"/"2"/... resolves the pending clarify
-------------------------------------------------- */
function parseChoiceReply(qn) {
  const t = (qn || "").trim();
  if (!t) return null;

  if (t === "1" || t === "one") return 1;
  if (t === "2" || t === "two") return 2;
  if (t === "3" || t === "three") return 3;
  if (t === "4" || t === "four") return 4;

  // keyword-ish choices
  if (t.includes("bags")) return "bags";
  if (t.includes("bins")) return "bins";
  if (t.includes("summary")) return "summary";
  if (t.includes("open")) return "open";
  if (t.includes("closed")) return "closed";
  if (t.includes("fields")) return "fields";
  if (t.includes("details")) return "details";
  if (t.includes("tower")) return "details";
  if (t.includes("pending")) return "pending";
  if (t.includes("approved")) return "needs approved";

  return null;
}

function buildClarifyAnswer(topic, options) {
  const lines = [];
  lines.push(PROMPTS.clarifyPrefix);
  options.forEach((o, i) => lines.push(`${i + 1}) ${o.label}`));
  lines.push("");
  lines.push(PROMPTS.pickOne);
  return lines.join("\n");
}

function extractTowerNameFromText(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";

  // capture "... <NAME> rtk tower" or "rtk tower <NAME>"
  let m =
    /rtk\s+tower\s+(.+)$/i.exec(s) ||
    /(.+?)\s+rtk\s+tower/i.exec(s);
  if (m && m[1]) return m[1].trim();

  // heuristic: remove filler words
  const cleaned = s
    .replace(/\?/g, " ")
    .replace(/\bwhat\b/ig, " ")
    .replace(/\bwhich\b/ig, " ")
    .replace(/\bfields?\b/ig, " ")
    .replace(/\buse\b/ig, " ")
    .replace(/\busing\b/ig, " ")
    .replace(/\bon\b/ig, " ")
    .replace(/\bthe\b/ig, " ")
    .replace(/\brtk\b/ig, " ")
    .replace(/\btower\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function shouldClarify(raw) {
  const qn = norm(raw);
  if (!qn) return null;

  // Ambiguous RTK: they mention a tower name but don’t specify “fields using” vs “tower details”
  if (qn.includes("rtk") && qn.includes("tower")) {
    const wantsFields = qn.includes("field") || qn.includes("fields") || qn.includes("use") || qn.includes("using");
    const wantsDetails = qn.includes("details") || qn.includes("frequency") || qn.includes("freq") || qn.includes("network");
    if (!wantsFields && !wantsDetails) {
      const tower = extractTowerNameFromText(raw);
      if (tower) {
        return {
          intentKey: "clarify:rtk",
          context: { tower },
          options: [
            { label: `Tower details for “${tower}”`, run: () => ({ topic: "rtk", question: `rtk tower ${tower}` }) },
            { label: `Fields using “${tower}” tower`, run: () => ({ topic: "rtk", question: `what fields use the ${tower} rtk tower` }) }
          ]
        };
      }
    }
  }

  // Ambiguous boundaries: user asks broadly without open/closed/fields grouping
  if (qn.includes("boundary") || qn.includes("boundaries")) {
    const asksOpen = qn.includes("open");
    const asksClosed = qn.includes("closed");
    const asksFields = qn.includes("field") || qn.includes("fields");
    const asksId = /^boundary\s+[a-z0-9_-]+$/i.test((raw || "").trim());
    if (!asksOpen && !asksClosed && !asksFields && !asksId) {
      return {
        intentKey: "clarify:boundaries",
        context: {},
        options: [
          { label: "Fields with open boundary requests", run: () => ({ topic: "boundaries", question: "fields with boundary requests" }) },
          { label: "Open boundary requests (full list)", run: () => ({ topic: "boundaries", question: "boundaries open" }) },
          { label: "Boundary requests summary", run: () => ({ topic: "boundaries", question: "boundaries summary" }) }
        ]
      };
    }
  }

  // Ambiguous grain: “show grain” could mean bags/bins/summary
  if (qn.includes("grain") && (qn.includes("show") || qn.includes("list"))) {
    const mentionsBags = qn.includes("bag") || qn.includes("bags");
    const mentionsBins = qn.includes("bin") || qn.includes("bins");
    const mentionsSku = qn.includes("sku");
    if (!mentionsBags && !mentionsBins && !mentionsSku) {
      return {
        intentKey: "clarify:grain",
        context: {},
        options: [
          { label: "Grain bags on hand", run: () => ({ topic: "grain", question: "grain bags" }) },
          { label: "Bin sites", run: () => ({ topic: "grain", question: "grain bins" }) },
          { label: "Grain summary", run: () => ({ topic: "grain", question: "grain summary" }) }
        ]
      };
    }
  }

  // Ambiguous maintenance: “show maintenance” could mean pending/needs approved/all
  if (qn.includes("maintenance") && (qn.includes("show") || qn === "maintenance" || qn.includes("list"))) {
    const mentionsPending = qn.includes("pending");
    const mentionsApproved = qn.includes("needs approved") || qn.includes("approved");
    const mentionsFarm = qn.includes("by farm") || qn.includes("for farm") || qn.includes("for ") || qn.includes("at ");
    if (!mentionsPending && !mentionsApproved && !mentionsFarm) {
      return {
        intentKey: "clarify:maintenance",
        context: {},
        options: [
          { label: "Pending maintenance", run: () => ({ topic: "maintenance", question: "pending maintenance" }) },
          { label: "Needs approved maintenance", run: () => ({ topic: "maintenance", question: "needs approved maintenance" }) },
          { label: "All maintenance (newest first)", run: () => ({ topic: "maintenance", question: "maintenance" }) }
        ]
      };
    }
  }

  return null;
}

function resolvePendingClarify(stateLastIntent, userText) {
  const last = (stateLastIntent || "").toString().trim();
  if (!last.startsWith("clarify:")) return null;

  const qn = norm(userText);
  const choice = parseChoiceReply(qn);
  if (!choice) return null;

  // Map intentKey -> options (must match shouldClarify)
  const key = last; // "clarify:rtk" etc.

  // We need some context to resolve RTK tower name if used.
  // Since state only stores lastIntent, we keep RTK ambiguous followups minimal:
  // If user got a clarify question, they typically reply immediately with 1/2.
  // For RTK we embed the tower name into the clarify intent itself: "clarify:rtk:<tower>"
  // (handled below in normalizeIntent)
  if (key.startsWith("clarify:rtk:")) {
    const tower = key.slice("clarify:rtk:".length).trim();
    const opts = [
      { run: () => ({ topic: "rtk", question: `rtk tower ${tower}` }) },
      { run: () => ({ topic: "rtk", question: `what fields use the ${tower} rtk tower` }) }
    ];
    const idx = (typeof choice === "number") ? choice : (choice === "details" ? 1 : (choice === "fields" ? 2 : null));
    if (!idx || idx < 1 || idx > opts.length) return null;
    return opts[idx - 1].run();
  }

  if (key === "clarify:boundaries") {
    const opts = [
      { run: () => ({ topic: "boundaries", question: "fields with boundary requests" }) },
      { run: () => ({ topic: "boundaries", question: "boundaries open" }) },
      { run: () => ({ topic: "boundaries", question: "boundaries summary" }) }
    ];
    const idx = (typeof choice === "number") ? choice : (choice === "fields" ? 1 : (choice === "open" ? 2 : (choice === "summary" ? 3 : null)));
    if (!idx || idx < 1 || idx > opts.length) return null;
    return opts[idx - 1].run();
  }

  if (key === "clarify:grain") {
    const opts = [
      { run: () => ({ topic: "grain", question: "grain bags" }) },
      { run: () => ({ topic: "grain", question: "grain bins" }) },
      { run: () => ({ topic: "grain", question: "grain summary" }) }
    ];
    const idx = (typeof choice === "number") ? choice : (choice === "bags" ? 1 : (choice === "bins" ? 2 : (choice === "summary" ? 3 : null)));
    if (!idx || idx < 1 || idx > opts.length) return null;
    return opts[idx - 1].run();
  }

  if (key === "clarify:maintenance") {
    const opts = [
      { run: () => ({ topic: "maintenance", question: "pending maintenance" }) },
      { run: () => ({ topic: "maintenance", question: "needs approved maintenance" }) },
      { run: () => ({ topic: "maintenance", question: "maintenance" }) }
    ];
    const idx = (typeof choice === "number") ? choice : (choice === "pending" ? 1 : (choice === "needs approved" ? 2 : null));
    if (!idx || idx < 1 || idx > opts.length) return null;
    return opts[idx - 1].run();
  }

  return null;
}

/* --------------------------------------------------
   Global intent normalization (plus clarify support)
-------------------------------------------------- */
function normalizeIntent(question) {
  const raw = (question || "").toString().trim();
  const qn = norm(raw);

  const intent = {
    raw,
    topic: null,
    mode: null,
    args: {},
    normalizedQuestion: raw
  };

  if (!qn) return intent;

  // Readiness
  if (isReadinessQuery(qn)) {
    intent.topic = "readiness";
    intent.mode = "latest";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // Fields
  if (
    qn === "fields" ||
    qn.includes("list fields") ||
    qn.includes("show fields") ||
    qn.includes("show all fields") ||
    qn.includes("all fields") ||
    qn.includes("field list") ||
    qn.startsWith("field ") ||
    qn.startsWith("show field") ||
    qn.startsWith("open field")
  ) {
    intent.topic = "fields";
    if (qn.startsWith("field ") || qn.startsWith("show field") || qn.startsWith("open field")) {
      intent.mode = "detail";
      intent.normalizedQuestion = raw;
    } else {
      intent.mode = "list";
      intent.normalizedQuestion = "list fields";
    }
    return intent;
  }

  // Grain (default summary; clarify gate may override when ambiguous)
  if (qn.includes("grain") || qn.includes("bags on hand") || qn.includes("bag inventory") || qn.startsWith("sku ") || qn.startsWith("grain sku ") || qn.startsWith("bags sku ") || qn === "bins" || qn.includes("grain bins")) {
    intent.topic = "grain";
    if (qn.startsWith("sku ") || qn.startsWith("grain sku ") || qn.startsWith("bags sku ")) {
      intent.mode = "bags";
      intent.normalizedQuestion = raw;
      return intent;
    }
    if (qn.includes("bag") || qn.includes("bags")) {
      intent.mode = "bags";
      intent.normalizedQuestion = "grain bags";
      return intent;
    }
    if (qn.includes("bin") || qn === "bins") {
      intent.mode = "bins";
      intent.normalizedQuestion = "grain bins";
      return intent;
    }
    intent.mode = "summary";
    intent.normalizedQuestion = "grain summary";
    return intent;
  }

  // Maintenance
  if (qn.includes("maintenance") || qn.includes("work order") || qn.includes("work orders")) {
    intent.topic = "maintenance";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // Boundaries
  if (qn.includes("boundary") || qn.includes("boundaries")) {
    intent.topic = "boundaries";
    // common phrasing shortcut
    if ((qn.includes("field") || qn.includes("fields")) && (qn.includes("need") || qn.includes("with") || qn.includes("have"))) {
      intent.mode = "fields";
      intent.normalizedQuestion = "fields with boundary requests";
      return intent;
    }
    intent.normalizedQuestion = raw;
    return intent;
  }

  // RTK
  if (qn.includes("rtk") && (qn.includes("tower") || qn.includes("towers"))) {
    intent.topic = "rtk";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // Equipment (leave to feature; equipment file is already tolerant)
  if (
    qn.includes("equipment") ||
    qn.includes("tractor") || qn.includes("tractors") ||
    qn.includes("combine") || qn.includes("combines") ||
    qn.includes("sprayer") || qn.includes("sprayers") ||
    qn.includes("implement") || qn.includes("implements")
  ) {
    intent.topic = "equipment";
    intent.normalizedQuestion = raw;
    return intent;
  }

  return intent;
}

/* --------------------------------------------------
   MAIN CHAT ROUTER
-------------------------------------------------- */
export async function handleChat({ question, snapshot, history, state }) {
  // Report trigger
  if (wantsReport(question)) {
    const mode = wantsFullConversation(question) ? "conversation" : "recent";
    return {
      answer:
        `✅ Report ready.\n` +
        `I’m opening the PDF now.\n\n` +
        `View PDF: /report?mode=${mode}`,
      action: "report",
      meta: { intent: "report", reportMode: mode, reportUrl: `/report?mode=${mode}` }
    };
  }

  // 1) Resolve pending clarify (user replied "1"/"2"/etc)
  const pending = resolvePendingClarify(state?.lastIntent, question);
  if (pending && pending.topic && pending.question) {
    // Route immediately using the resolved choice
    if (pending.topic === "rtk") {
      const out = await answerRtkTowers({ question: pending.question, snapshot, intent: { topic: "rtk" } });
      out.meta = { ...(out.meta || {}), intent: "rtk" };
      return humanizeAnswer(out);
    }
    if (pending.topic === "boundaries") {
      const out = await answerBoundaryRequests({ question: pending.question, snapshot, intent: { topic: "boundaries" } });
      out.meta = { ...(out.meta || {}), intent: "boundaryRequests" };
      return humanizeAnswer(out);
    }
    if (pending.topic === "grain") {
      const out = await answerGrain({ question: pending.question, snapshot, intent: { topic: "grain" } });
      out.meta = { ...(out.meta || {}), intent: "grain" };
      return humanizeAnswer(out);
    }
    if (pending.topic === "maintenance") {
      const out = await answerFieldMaintenance({ question: pending.question, snapshot, intent: { topic: "maintenance" } });
      out.meta = { ...(out.meta || {}), intent: "fieldMaintenance" };
      return humanizeAnswer(out);
    }
  }

  // 2) Ask clarify question ONLY if ambiguous
  const clarify = shouldClarify(question);
  if (clarify) {
    // Special: persist RTK tower name in lastIntent so a "1/2" reply works
    let intentKey = clarify.intentKey;
    if (intentKey === "clarify:rtk") {
      const tower = (clarify.context && clarify.context.tower) ? String(clarify.context.tower) : "";
      intentKey = tower ? `clarify:rtk:${tower}` : "clarify:rtk";
    }

    return {
      answer: buildClarifyAnswer(intentKey, clarify.options),
      meta: { intent: intentKey, clarify: true }
    };
  }

  // 3) Normal routing
  const intent = normalizeIntent(question);
  const qn = norm(question);

  // Readiness
  if (intent.topic === "readiness") {
    const out = await answerFieldReadinessLatest({ question, snapshot, history, state });
    out.meta = { ...(out.meta || {}), intent: "readiness" };
    return humanizeAnswer(out);
  }

  // Equipment
  if (intent.topic === "equipment") {
    const out = await answerEquipment({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "equipment" };
    return humanizeAnswer(out);
  }

  // Fields
  if (intent.topic === "fields") {
    const out = await answerFields({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "fields" };
    return humanizeAnswer(out);
  }

  // Grain
  if (intent.topic === "grain") {
    const out = await answerGrain({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "grain" };
    return humanizeAnswer(out);
  }

  // Maintenance
  if (intent.topic === "maintenance") {
    const out = await answerFieldMaintenance({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "fieldMaintenance" };
    return humanizeAnswer(out);
  }

  // Boundaries
  if (intent.topic === "boundaries") {
    const out = await answerBoundaryRequests({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "boundaryRequests" };
    return humanizeAnswer(out);
  }

  // RTK
  if (intent.topic === "rtk") {
    const out = await answerRtkTowers({ question: intent.normalizedQuestion || question, snapshot, intent });
    out.meta = { ...(out.meta || {}), intent: "rtk" };
    return humanizeAnswer(out);
  }

  // Legacy handlers
  const qForHandlers = intent.normalizedQuestion || question;

  if (canHandleEquipment(qForHandlers)) return humanizeAnswer(await answerEquipment({ question: qForHandlers, snapshot, intent }));
  if (canHandleBoundaryRequests(qForHandlers)) return humanizeAnswer(await answerBoundaryRequests({ question: qForHandlers, snapshot, intent }));
  if (canHandleBinSites(qForHandlers)) return humanizeAnswer(await answerBinSites({ question: qForHandlers, snapshot }));
  if (canHandleBinMovements(qForHandlers)) return humanizeAnswer(await answerBinMovements({ question: qForHandlers, snapshot }));
  if (canHandleAerialApplications(qForHandlers)) return humanizeAnswer(await answerAerialApplications({ question: qForHandlers, snapshot }));
  if (canHandleFieldTrials(qForHandlers)) return humanizeAnswer(await answerFieldTrials({ question: qForHandlers, snapshot }));

  if (canHandleGrainBagEvents(qForHandlers)) return humanizeAnswer(await answerGrainBagEvents({ question: qForHandlers, snapshot }));
  if (canHandleProducts(qForHandlers)) return humanizeAnswer(await answerProducts({ question: qForHandlers, snapshot }));
  if (canHandleRtkTowers(qForHandlers)) return humanizeAnswer(await answerRtkTowers({ question: qForHandlers, snapshot, intent }));
  if (canHandleSeasonalPrecheck(qForHandlers)) return humanizeAnswer(await answerSeasonalPrecheck({ question: qForHandlers, snapshot }));
  if (canHandleStarfireMoves(qForHandlers)) return humanizeAnswer(await answerStarfireMoves({ question: qForHandlers, snapshot }));
  if (canHandleVehicleRegistrations(qForHandlers)) return humanizeAnswer(await answerVehicleRegistrations({ question: qForHandlers, snapshot }));
  if (canHandleCombineMetrics(qForHandlers)) return humanizeAnswer(await answerCombineMetrics({ question: qForHandlers, snapshot }));

  if (canHandleGrain(qForHandlers)) return humanizeAnswer(await answerGrain({ question: qForHandlers, snapshot, intent }));
  if (canHandleFields(qForHandlers)) return humanizeAnswer(await answerFields({ question: qForHandlers, snapshot, intent }));
  if (canHandleFarms(qForHandlers)) return humanizeAnswer(await answerFarms({ question: qForHandlers, snapshot }));
  if (canHandleFieldMaintenance(qForHandlers)) return humanizeAnswer(await answerFieldMaintenance({ question: qForHandlers, snapshot, intent }));

  // Unknown (no more “early in development” cop-out)
  return {
    answer: PROMPTS.unknownArea,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", intent: "unknown" }
  };
}
