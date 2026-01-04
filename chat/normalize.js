// /chat/normalize.js  (FULL FILE)
// Rev: 2026-01-04-normalize2-carlinville
//
// Adds:
// ✅ "car like" / "carline" / "car lin" -> "carlinville"
// ✅ Keeps existing safe typo + paging normalizations

'use strict';

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function hasFieldLikePattern(s) {
  const t = safeStr(s);
  if (!t) return false;
  if (/^\s*\d{3,4}\s*-\s*.+/i.test(t)) return true;
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

  // 0) collapse whitespace
  {
    const next = text.replace(/\s+/g, " ").trim();
    if (next !== text) { text = next; rulesFired.push("ws_collapse"); }
  }

  // 1) paging commands first
  {
    const pagingRules = [
      { id: "paging_show_more", re: /^\s*show\s+(me\s+)?more\s*$/i, to: "more" },
      { id: "paging_more_pls",  re: /^\s*more\s+please\s*$/i, to: "more" },
      { id: "paging_show_all",  re: /^\s*show\s+(me\s+)?all\s*$/i, to: "show all" },
      { id: "paging_all_pls",   re: /^\s*show\s+(me\s+)?all\s+please\s*$/i, to: "show all" },
      { id: "paging_list_all",  re: /^\s*list\s+all\s*$/i, to: "show all" },
      { id: "paging_next",      re: /^\s*next\s*$/i, to: "more" },
      { id: "paging_rest",      re: /^\s*(the\s+)?rest\s*$/i, to: "show all" }
    ];
    const res = applyRules(text, pagingRules);
    text = res.text;
    rulesFired.push(...res.fired);
  }

  const fieldLike = hasFieldLikePattern(text);

  // 2) domain typos/slang (only when NOT field-like)
  if (!fieldLike) {
    const intentRules = [
      { id: "how_mans", re: /\bhow\s+mans\b/gi, to: "how many" },
      { id: "how_man",  re: /\bhow\s+man\b/gi,  to: "how many" },

      { id: "rtk_typo_rkt", re: /\brkt\b/gi, to: "rtk" },
      { id: "rtk_plural",   re: /\brtks\b/gi, to: "rtk" },

      { id: "tower_typo",   re: /\btowre\b/gi, to: "tower" },
      { id: "county_typo",  re: /\bconty\b/gi, to: "county" },
      { id: "field_typo",   re: /\bfeild\b/gi, to: "field" },
      { id: "acres_typo",   re: /\bacers\b/gi, to: "acres" },
      { id: "tillable_typo",re: /\btilable\b/gi, to: "tillable" },

      // ✅ NEW: Carlinville speech-to-text junk
      { id: "car_like_to_carlinville", re: /\bcar\s+like\b/gi, to: "carlinville" },
      { id: "car_lin_to_carlinville",  re: /\bcar\s+lin\b/gi,  to: "carlinville" },
      { id: "carline_to_carlinville",  re: /\bcarline\b/gi,    to: "carlinville" },

      // normalize common phrase
      { id: "rtk_towers_phrase",  re: /\brtk\s+tower(s)?\s+do\s+we\s+have\b/gi, to: "how many rtk towers do we use" },
      { id: "rtk_towers_phrase2", re: /\bhow\s+many\s+rtk\s+tower(s)?\s+do\s+we\s+have\b/gi, to: "how many rtk towers do we use" }
    ];

    const res = applyRules(text, intentRules);
    text = res.text;
    rulesFired.push(...res.fired);
  }

  // 3) light punctuation cleanup
  {
    const next = text.replace(/\s+\?/g, "?").replace(/\s+\./g, ".").trim();
    if (next !== text) { text = next; rulesFired.push("punct_space"); }
  }

  return {
    text,
    meta: { changed: text !== original, rules: rulesFired }
  };
}