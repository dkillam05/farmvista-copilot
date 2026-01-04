// /chat/normalize.js  (FULL FILE)
// Rev: 2026-01-04-normalize1
//
// Safe global normalization for chat input.
// Goals:
// ✅ Fix common typos / slang for FarmVista domain words
// ✅ Normalize paging commands (show more -> more, show all -> show all, etc.)
// ✅ Do NOT mutate likely field/farm labels (e.g., "0801-Lloyd N340") or anything with long IDs
//
// Export:
// - normalizeQuestion(raw: string) -> { text: string, meta: { changed: boolean, rules: string[] } }

'use strict';

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function hasFieldLikePattern(s) {
  const t = safeStr(s);
  if (!t) return false;

  // Common field label formats:
  // - "0801-Lloyd N340"
  // - "0411-Stone Seed"
  // - "0110"
  // If it contains 3-4 leading digits followed by "-" it's a strong signal.
  if (/^\s*\d{3,4}\s*-\s*.+/i.test(t)) return true;

  // If it is exactly 3-4 digits, likely a field id shorthand.
  if (/^\s*\d{3,4}\s*$/.test(t)) return true;

  return false;
}

function applyRules(s, rules) {
  let out = s;
  const fired = [];

  for (const r of rules) {
    const next = out.replace(r.re, r.to);
    if (next !== out) {
      out = next;
      fired.push(r.id);
    }
  }
  return { text: out, fired };
}

export function normalizeQuestion(raw) {
  const original = safeStr(raw);
  if (!original) return { text: "", meta: { changed: false, rules: [] } };

  let text = original;
  const rulesFired = [];

  // 0) Trim excessive whitespace
  {
    const next = text.replace(/\s+/g, " ").trim();
    if (next !== text) { text = next; rulesFired.push("ws_collapse"); }
  }

  // 1) Normalize very common paging commands FIRST
  //    (safe to apply even if the message is just "show more")
  {
    const pagingRules = [
      { id: "paging_show_more", re: /^\s*show\s+(me\s+)?more\s*$/i, to: "more" },
      { id: "paging_more_pls",  re: /^\s*more\s+please\s*$/i,            to: "more" },
      { id: "paging_show_all",  re: /^\s*show\s+(me\s+)?all\s*$/i,       to: "show all" },
      { id: "paging_all_pls",   re: /^\s*show\s+(me\s+)?all\s+please\s*$/i, to: "show all" },
      { id: "paging_list_all",  re: /^\s*list\s+all\s*$/i,               to: "show all" },
      { id: "paging_next",      re: /^\s*next\s*$/i,                     to: "more" },
      { id: "paging_rest",      re: /^\s*(the\s+)?rest\s*$/i,            to: "show all" }
    ];

    const res = applyRules(text, pagingRules);
    text = res.text;
    rulesFired.push(...res.fired);
  }

  // If it's a field-like string, do NOT do aggressive typo replacements
  // (we already did paging normalization safely)
  const fieldLike = hasFieldLikePattern(text);

  // 2) Fix common intent typos / slang (conservative)
  //    Only applied when NOT field-like.
  if (!fieldLike) {
    const intentRules = [
      // "how mans" -> "how many"
      { id: "how_mans", re: /\bhow\s+mans\b/gi, to: "how many" },
      { id: "how_man",  re: /\bhow\s+man\b/gi,  to: "how many" },

      // Domain typos
      { id: "rtk_typo_rkt", re: /\brkt\b/gi, to: "rtk" },
      { id: "rtk_plural",   re: /\brtks\b/gi, to: "rtk" },

      { id: "tower_typo",   re: /\btowre\b/gi, to: "tower" },
      { id: "county_typo",  re: /\bconty\b/gi, to: "county" },
      { id: "field_typo",   re: /\bfeild\b/gi, to: "field" },
      { id: "acres_typo",   re: /\bacers\b/gi, to: "acres" },
      { id: "tillable_typo",re: /\btilable\b/gi, to: "tillable" },

      // Normalize common phrasing
      { id: "rtk_towers_phrase", re: /\brtk\s+tower(s)?\s+do\s+we\s+have\b/gi, to: "how many rtk towers do we use" },
      { id: "rtk_towers_phrase2",re: /\bhow\s+many\s+rtk\s+tower(s)?\s+do\s+we\s+have\b/gi, to: "how many rtk towers do we use" }
    ];

    const res = applyRules(text, intentRules);
    text = res.text;
    rulesFired.push(...res.fired);
  }

  // 3) Gentle cleanup (spacing around punctuation)
  {
    const next = text.replace(/\s+\?/g, "?").replace(/\s+\./g, ".").trim();
    if (next !== text) { text = next; rulesFired.push("punct_space"); }
  }

  return {
    text,
    meta: {
      changed: text !== original,
      rules: rulesFired
    }
  };
}