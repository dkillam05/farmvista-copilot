// resolver.js
function norm(s){ return (s || "").toString().trim().toLowerCase(); }

// very simple scoring: exact > startsWith > includes
function scoreMatch(query, candidate) {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c === q) return 100;
  if (c.startsWith(q)) return 85;
  if (c.includes(q)) return 70;
  return 0;
}

/**
 * Pick best match or return clarification candidates.
 * @param {string} query - what user typed ("raymond rtk tower")
 * @param {Array<{id:string, name:string, aliases?:string[]}>} items - RTK towers
 * @param {object} opts
 */
function resolveOne(query, items, opts = {}) {
  const {
    autoAnswerScore = 85,   // >= this => just answer
    clarifyScore = 70,      // >= this => allowed into clarification list
    maxChoices = 3
  } = opts;

  const q = norm(query);

  // Build scored list using name + aliases
  const scored = items.map(it => {
    const nameScore = scoreMatch(q, it.name);
    const aliasScore = Math.max(...(it.aliases || []).map(a => scoreMatch(q, a)), 0);
    const best = Math.max(nameScore, aliasScore);
    return { it, score: best };
  }).sort((a,b) => b.score - a.score);

  const best = scored[0] || null;
  const second = scored[1] || null;

  // 1) No decent matches
  if (!best || best.score < clarifyScore) {
    return { type: "none", best: null, choices: [] };
  }

  // 2) Auto-answer if clearly best OR only one candidate
  const gap = second ? (best.score - second.score) : best.score;
  const onlyOneGood = !second || second.score < clarifyScore;

  if (best.score >= autoAnswerScore && (gap >= 10 || onlyOneGood)) {
    return { type: "match", best: best.it, choices: [] };
  }

  // 3) Otherwise clarify (but only show real candidates)
  const choices = scored
    .filter(x => x.score >= clarifyScore)
    .slice(0, maxChoices)
    .map(x => x.it);

  // If clarification list collapses to 1, answer anyway
  if (choices.length === 1) {
    return { type: "match", best: choices[0], choices: [] };
  }

  return { type: "clarify", best: best.it, choices };
}

module.exports = { resolveOne };
