// /chat/handleChat.js  (FULL FILE)
// Rev: 2025-12-30-normalize-intent-plus (Normalize: equipment + readiness + fields + grain + maintenance + boundaries + humanizeAnswer)

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

function isReadinessQuery(qn) {
  if (!qn) return false;
  if (qn.includes("readiness")) return true;
  if (qn.includes("how ready") && qn.includes("field")) return true;
  if (qn.includes("which fields") && (qn.includes("plant") || qn.includes("spray") || qn.includes("work") || qn.includes("till"))) return true;
  if (qn.includes("can we plant") || qn.includes("can we spray") || qn.includes("can we work") || qn.includes("can we till")) return true;
  return false;
}

/* --------------------------------------------------
   OUTPUT HUMANIZER
   - Prevents CLI-style "Try:" menus & debug-ish blocks
     from leaking into normal chat or reports.
-------------------------------------------------- */
function humanizeAnswer(out) {
  if (!out || typeof out !== "object") return out;
  if (typeof out.answer !== "string") return out;

  let t = out.answer;

  // Remove any trailing "Try:" command menus from old features
  // (from "\n\nTry:" to end)
  t = t.replace(/\n{0,2}^\s*Try:\s*[\s\S]*$/gmi, "");

  // Remove leading internal markers like [FV-...]
  t = t.replace(/^\[[^\]]+\]\s*/gm, "");

  // Trim excess whitespace
  t = t.replace(/\n{3,}/g, "\n\n").trim();

  return { ...out, answer: t };
}

/* --------------------------------------------------
   GLOBAL INTENT NORMALIZATION
   - One place that turns messy human phrasing into
     structured intent + a "normalizedQuestion" string.
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

  // ---- Equipment ----
  const mentionsEquipment =
    qn.includes("equipment") ||
    qn.includes("tractor") || qn.includes("tractors") ||
    qn.includes("combine") || qn.includes("combines") ||
    qn.includes("sprayer") || qn.includes("sprayers") ||
    qn.includes("implement") || qn.includes("implements");

  if (mentionsEquipment) {
    intent.topic = "equipment";

    const wantsList =
      qn.includes(" list") ||
      qn.endsWith(" list") ||
      qn.includes("show equipment") ||
      qn.includes("show me equipment") ||
      qn.includes("all equipment") ||
      qn.includes("equipment summary") ||
      (qn === "equipment") ||
      qn.includes("equipment overview");

    if (wantsList) {
      intent.mode = "summary";
      intent.normalizedQuestion = "equipment summary";
      return intent;
    }

    let m = /\btype\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "type";
      intent.args.type = m[1].trim();
      intent.normalizedQuestion = `equipment type ${intent.args.type}`;
      return intent;
    }

    if (!/\b(model|search|qr|id|serial|sn|type)\b/i.test(qn) && qn.includes("equipment")) {
      const cleaned = raw.replace(/\bequipment\b/i, "").trim();
      if (cleaned && cleaned.length >= 3) {
        intent.mode = "make";
        intent.args.make = cleaned;
        intent.normalizedQuestion = `equipment make ${intent.args.make}`;
        return intent;
      }
    }

    m = /\bmake\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "make";
      intent.args.make = m[1].trim();
      intent.normalizedQuestion = `equipment make ${intent.args.make}`;
      return intent;
    }

    m = /\bmodel\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "model";
      intent.args.model = m[1].trim();
      intent.normalizedQuestion = `equipment model ${intent.args.model}`;
      return intent;
    }

    m = /\b(search|find|lookup)\b\s*:?\s*([a-z0-9 _-]+)\s*$/i.exec(raw);
    if (m && m[2]) {
      intent.mode = "search";
      intent.args.needle = m[2].trim();
      intent.normalizedQuestion = `equipment search ${intent.args.needle}`;
      return intent;
    }

    m = /\bqr\b\s*:?\s*([a-zA-Z0-9_-]+)\s*$/i.exec(raw);
    if (m && m[1]) {
      intent.mode = "qr";
      intent.args.id = m[1].trim();
      intent.normalizedQuestion = `equipment qr ${intent.args.id}`;
      return intent;
    }

    if (qn.startsWith("equipment ")) {
      const rest = raw.slice(raw.toLowerCase().indexOf("equipment") + "equipment".length).trim();
      if (rest) {
        intent.mode = "search";
        intent.args.needle = rest;
        intent.normalizedQuestion = `equipment search ${intent.args.needle}`;
        return intent;
      }
    }

    intent.mode = "summary";
    intent.normalizedQuestion = "equipment summary";
    return intent;
  }

  // ---- Readiness ----
  if (isReadinessQuery(qn)) {
    intent.topic = "readiness";
    intent.mode = "latest";
    intent.normalizedQuestion = raw;
    return intent;
  }

  // ---- Fields ----
  const mentionsFields =
    qn === "fields" ||
    qn.includes("field list") ||
    qn.includes("list fields") ||
    qn.includes("show fields") ||
    qn.includes("show me fields") ||
    qn.includes("all fields") ||
    qn.startsWith("field ") ||
    qn.startsWith("show field") ||
    qn.startsWith("open field");

  if (mentionsFields) {
    intent.topic = "fields";

    if (
      qn === "fields" ||
      qn.includes("list fields") ||
      qn.includes("show fields") ||
      qn.includes("all fields") ||
      qn.includes("field list")
    ) {
      intent.mode = "list";
      intent.normalizedQuestion = "list fields";
      return intent;
    }

    // detail
    let m = /^(field|show field|open field)\s*[:#]?\s*(.+)$/i.exec(raw);
    if (m && m[2]) {
      intent.mode = "detail";
      intent.args.needle = m[2].trim();
      intent.normalizedQuestion = `field ${intent.args.needle}`;
      return intent;
    }

    // default list
    intent.mode = "list";
    intent.normalizedQuestion = "list fields";
    return intent;
  }

  // ---- Grain ----
  const mentionsGrain =
    qn === "grain" ||
    qn.includes("grain summary") ||
    qn.includes("grain bags") ||
    qn.includes("bag inventory") ||
    qn.includes("bags on hand") ||
    qn.includes("grain bins") ||
    qn === "bins" ||
    qn.startsWith("grain sku ") ||
    qn.startsWith("sku ") ||
    qn.startsWith("bags sku ");

  if (mentionsGrain) {
    intent.topic = "grain";

    if (qn.startsWith("grain sku ") || qn.startsWith("sku ") || qn.startsWith("bags sku ")) {
      intent.mode = "bags";
      intent.normalizedQuestion = raw; // keep original for filter parsing
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

  // ---- Field Maintenance / Work Orders ----
  const mentionsMaint =
    qn === "maintenance" ||
    qn.includes("field maintenance") ||
    qn.includes("maintenance ") ||
    qn.includes("work order") ||
    qn.includes("work orders") ||
    qn.includes("needs approved") ||
    qn.includes("pending maintenance") ||
    qn.includes("pending work");

  if (mentionsMaint) {
    intent.topic = "fieldMaintenance";
    // Let the feature parse human filters itself (we already made it tolerant)
    intent.normalizedQuestion = raw;
    return intent;
  }

  // ---- Boundary Requests ----
  const mentionsBoundaries =
    qn.includes("boundary") ||
    qn.includes("boundaries");

  if (mentionsBoundaries) {
    intent.topic = "boundaries";

    if (qn.includes("open boundaries") || qn.includes("boundaries open") || qn.includes("open boundary")) {
      intent.mode = "open";
      intent.normalizedQuestion = "boundaries open";
      return intent;
    }

    if (qn.includes("closed boundaries") || qn.includes("boundaries closed") || qn.includes("closed boundary")) {
      intent.mode = "closed";
      intent.normalizedQuestion = "boundaries closed";
      return intent;
    }

    // pass-through for "boundary <id>", "boundaries farm X", etc.
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

  const intent = normalizeIntent(question);

  // Readiness: always uses fieldReadinessLatest
  if (intent.topic === "readiness") {
    const out = await answerFieldReadinessLatest({ question, snapshot, history, state });
    out.meta = { ...(out.meta || {}), intent: "readiness" };
    return humanizeAnswer(out);
  }

  // Equipment
  if (intent.topic === "equipment") {
    const out = await answerEquipment({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "equipment", intentMode: intent.mode || null };
    return humanizeAnswer(out);
  }

  // Fields
  if (intent.topic === "fields") {
    const out = await answerFields({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "fields", intentMode: intent.mode || null };
    return humanizeAnswer(out);
  }

  // Grain
  if (intent.topic === "grain") {
    const out = await answerGrain({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "grain", intentMode: intent.mode || null };
    return humanizeAnswer(out);
  }

  // Field Maintenance
  if (intent.topic === "fieldMaintenance") {
    const out = await answerFieldMaintenance({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "fieldMaintenance" };
    return humanizeAnswer(out);
  }

  // Boundaries
  if (intent.topic === "boundaries") {
    const out = await answerBoundaryRequests({
      question: intent.normalizedQuestion || question,
      snapshot,
      intent
    });
    out.meta = { ...(out.meta || {}), intent: "boundaryRequests", intentMode: intent.mode || null };
    return humanizeAnswer(out);
  }

  // Legacy routing (still works)
  const qForHandlers = intent.normalizedQuestion || question;

  if (canHandleEquipment(qForHandlers)) return humanizeAnswer(await answerEquipment({ question: qForHandlers, snapshot, intent }));
  if (canHandleBoundaryRequests(qForHandlers)) return humanizeAnswer(await answerBoundaryRequests({ question: qForHandlers, snapshot, intent }));
  if (canHandleBinSites(qForHandlers)) return humanizeAnswer(await answerBinSites({ question: qForHandlers, snapshot }));
  if (canHandleBinMovements(qForHandlers)) return humanizeAnswer(await answerBinMovements({ question: qForHandlers, snapshot }));
  if (canHandleAerialApplications(qForHandlers)) return humanizeAnswer(await answerAerialApplications({ question: qForHandlers, snapshot }));
  if (canHandleFieldTrials(qForHandlers)) return humanizeAnswer(await answerFieldTrials({ question: qForHandlers, snapshot }));

  if (canHandleGrainBagEvents(qForHandlers)) return humanizeAnswer(await answerGrainBagEvents({ question: qForHandlers, snapshot }));
  if (canHandleProducts(qForHandlers)) return humanizeAnswer(await answerProducts({ question: qForHandlers, snapshot }));
  if (canHandleRtkTowers(qForHandlers)) return humanizeAnswer(await answerRtkTowers({ question: qForHandlers, snapshot }));
  if (canHandleSeasonalPrecheck(qForHandlers)) return humanizeAnswer(await answerSeasonalPrecheck({ question: qForHandlers, snapshot }));
  if (canHandleStarfireMoves(qForHandlers)) return humanizeAnswer(await answerStarfireMoves({ question: qForHandlers, snapshot }));
  if (canHandleVehicleRegistrations(qForHandlers)) return humanizeAnswer(await answerVehicleRegistrations({ question: qForHandlers, snapshot }));
  if (canHandleCombineMetrics(qForHandlers)) return humanizeAnswer(await answerCombineMetrics({ question: qForHandlers, snapshot }));

  if (canHandleGrain(qForHandlers)) return humanizeAnswer(await answerGrain({ question: qForHandlers, snapshot, intent }));
  if (canHandleFields(qForHandlers)) return humanizeAnswer(await answerFields({ question: qForHandlers, snapshot, intent }));
  if (canHandleFarms(qForHandlers)) return humanizeAnswer(await answerFarms({ question: qForHandlers, snapshot }));
  if (canHandleFieldMaintenance(qForHandlers)) return humanizeAnswer(await answerFieldMaintenance({ question: qForHandlers, snapshot, intent }));

  return {
    answer:
      `I’m still early in development and learning how different questions are phrased.\n\n` +
      `If that didn’t come back the way you expected, try rephrasing a bit — I’m getting better at interpreting “show me…”, “list…”, and “summarize…”.`,
    meta: { snapshotId: snapshot?.activeSnapshotId || "unknown", intent: "unknown" }
  };
}
