import { answerAerialApplications } from "../features/aerialApplications.js";
import { answerFieldTrials } from "../features/fieldTrials.js";
import { answerFieldReadinessWeather } from "../features/fieldReadinessWeather.js";
import { answerGrain } from "../features/grain.js";
import { answerFields } from "../features/fields.js";

const norm = (s) => (s || "").toString().trim().toLowerCase();

function detectIntents(question) {
  const q = norm(question);

  const intents = [];

  // Field readiness weather: requires "field ..." + rain/temp/weather keywords
  const looksLikeFieldWeather =
    /^(field|show field|open field)\b/.test(q) &&
    (q.includes("rain") || q.includes("precip") || q.includes("weather") || q.includes("temp"));

  if (looksLikeFieldWeather) intents.push("fieldWeather");

  // Aerial
  if (q.includes("aerial")) intents.push("aerial");

  // Trials
  if (q.includes("trial") || q.includes("trials")) intents.push("trials");

  // Grain
  if (
    q.includes("grain") ||
    q.includes("bag") ||
    q.includes("bags") ||
    q.includes("bin") ||
    q.includes("bins")
  ) intents.push("grain");

  // Fields
  if (
    q.includes("field") ||
    q.includes("fields") ||
    q.includes("farm") ||
    q.includes("farms")
  ) intents.push("fields");

  // De-dupe while keeping order
  return [...new Set(intents)];
}

function heading(name) {
  // Keep it simple + readable in your chat box
  switch (name) {
    case "fields": return "FIELDS";
    case "grain": return "GRAIN";
    case "trials": return "FIELD TRIALS";
    case "aerial": return "AERIAL";
    case "fieldWeather": return "FIELD WEATHER";
    default: return name.toUpperCase();
  }
}

function cleanAnswerBlock(text) {
  const t = (text || "").toString().trim();
  if (!t) return "";
  return t;
}

function joinBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    const body = cleanAnswerBlock(b.body);
    if (!body) continue;
    parts.push(`=== ${heading(b.intent)} ===\n${body}`);
  }
  return parts.join("\n\n");
}

function capText(s, maxChars) {
  const t = (s || "").toString();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 40) + "\n\n…(trimmed for brevity)";
}

/**
 * Returns null if it should NOT handle as multi-intent.
 * Otherwise returns a combined { answer, meta } response.
 */
export async function maybeHandleMulti({ question, snapshot }) {
  const intents = detectIntents(question);

  // Only do multi when 2+ areas are clearly referenced
  if (intents.length < 2) return null;

  // Hard cap: don’t try to combine more than 4 modules in one response
  const selected = intents.slice(0, 4);

  const results = [];

  for (const intent of selected) {
    try {
      let out = null;

      if (intent === "fieldWeather") out = answerFieldReadinessWeather({ question, snapshot });
      else if (intent === "aerial") out = answerAerialApplications({ question, snapshot });
      else if (intent === "trials") out = answerFieldTrials({ question, snapshot });
      else if (intent === "grain") out = answerGrain({ question, snapshot });
      else if (intent === "fields") out = answerFields({ question, snapshot });

      if (out && out.answer) {
        results.push({ intent, body: out.answer, meta: out.meta || null });
      }
    } catch (e) {
      results.push({
        intent,
        body: `Error while answering this section: ${e && e.message ? e.message : String(e)}`,
        meta: null
      });
    }
  }

  const combined = joinBlocks(results);

  return {
    answer: capText(combined, 3500),
    meta: {
      snapshotId: snapshot?.activeSnapshotId || "unknown",
      multi: true,
      intents: selected
    }
  };
}