// /src/chat/intent.js  (FULL FILE)
// Rev: 2026-01-21-v2-intent-active-default-archived-flag-county
//
// Adds:
// - COUNTY_FIELDS / COUNTY_FARMS / COUNTY_STATS
// - includeArchived boolean flag (default false)
// Active-only is the default system behavior across the bot.

import OpenAI from 'openai';

const openai = new OpenAI();

export async function detectIntent(userText) {
  const question = (userText || '').toString();

  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `
Classify the user request into ONE intent and return JSON ONLY.

Return JSON ONLY:
{ "intent": "<INTENT>", "key": "<string>", "includeArchived": <true|false> }

INTENTS:
- FIELD_FULL: field details (id/name). key=field id/name.
- GRAIN_BAGS_DOWN: grain bags down summary. key="".
- RTK_TOWER_COUNT: count RTK towers. key="".
- RTK_TOWER_LIST: list RTK towers. key="".
- RTK_TOWER_FIELDS: fields assigned to a specific RTK tower. key=tower name/id.

COUNTY INTENTS:
- COUNTIES_FARMED: how many counties we farm in / list counties. key="".
- COUNTY_FIELDS: list fields in a given county. key=county name.
- COUNTY_FARMS: list farms that have fields in a given county. key=county name.
- COUNTY_STATS: HEL/CRP/tillable summaries for a given county. key=county name.

- UNKNOWN: anything else. key="".

ARCHIVED RULE (GLOBAL):
- includeArchived = true ONLY if the user explicitly asks for archived/inactive items
  (words like: "archived", "inactive", "old", "show archived", "include archived").
- Otherwise includeArchived MUST be false.

INTENT RULES:
- If question asks "how many" AND mentions rtk + tower -> RTK_TOWER_COUNT.
- If question asks to "list/show" towers -> RTK_TOWER_LIST.
- If question asks for fields assigned to a tower -> RTK_TOWER_FIELDS (key=tower).

- If question asks "how many counties" OR "which counties" AND mentions we farm/farm in -> COUNTIES_FARMED.
- If question mentions "fields" AND contains "<something> county" -> COUNTY_FIELDS (key=<something>).
- If question mentions "farms" AND contains "<something> county" -> COUNTY_FARMS (key=<something>).
- If question mentions "<something> county" AND mentions any of (HEL, CRP, tillable, acres, totals, stats) -> COUNTY_STATS (key=<something>).

IMPORTANT:
- Do NOT choose FIELD_FULL for generic phrases like "rtk towers".
- For key extraction: if user says "Pike County" or "pice county", key should be the word before "county" (e.g. "Pike" or "pice").
        `.trim()
      },
      { role: 'user', content: question }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}
