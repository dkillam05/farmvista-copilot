// /utils/prompts.js  (FULL FILE)
// Rev: 2025-12-30-prompts-loader
//
// Loads markdown prompt files from /prompts and exposes a small API.
// Safe defaults if files are missing.

import fs from "fs/promises";
import path from "path";

const DEFAULTS = {
  tone: `FarmVista Copilot tone rules:\n- Be direct and helpful.\n- No “Try:” menus.\n- No dev tags or internal IDs in user answers.\n- Ask one clarifying question when ambiguous.\n`,
  clarify: `Quick question so I pull the right data:\n1) ...\n2) ...\n\nReply with 1 or 2.\n`,
  fallback:
    `I didn’t understand that request.\n\n` +
    `Tell me what area you’re asking about (fields, equipment, grain, maintenance, boundaries, readiness, rtk), and I’ll pull the right data.\n`,
  report: `Report rules:\n- recent = last topic only\n- strip dev text\n`
};

let CACHE = null;
let CACHE_AT = 0;
const TTL_MS = 30_000; // reload at most every 30s

function baseDir() {
  // Assumes prompts folder at repo root: /prompts
  // index.js typically runs from repo root, so process.cwd() is OK.
  return process.cwd();
}

async function readMaybe(filePath) {
  try {
    const s = await fs.readFile(filePath, "utf8");
    return String(s || "").trim() || null;
  } catch {
    return null;
  }
}

export async function loadPrompts({ force = false } = {}) {
  const now = Date.now();
  if (!force && CACHE && (now - CACHE_AT) < TTL_MS) return CACHE;

  const pdir = path.join(baseDir(), "prompts");

  const [tone, clarify, fallback, report] = await Promise.all([
    readMaybe(path.join(pdir, "tone.md")),
    readMaybe(path.join(pdir, "clarify.md")),
    readMaybe(path.join(pdir, "fallback.md")),
    readMaybe(path.join(pdir, "report.md"))
  ]);

  CACHE = {
    tone: tone || DEFAULTS.tone,
    clarify: clarify || DEFAULTS.clarify,
    fallback: fallback || DEFAULTS.fallback,
    report: report || DEFAULTS.report
  };
  CACHE_AT = now;

  return CACHE;
}
