// /src/chat/intent.js  (FULL FILE)
// Rev: 2026-01-23-v5-intent-grainbags-count-routing
//
// Adds/Adjusts:
// - GRAIN_BAGS_REPORT now triggers for "how many / count / number of" + grain bags/bags
//   so questions like "how many corn grain bags do we have" route correctly.
//
// Keeps v4 adds:
// - GRAIN_BAGS_REPORT (bushels by crop + county/farm/field linkage)
// Keeps v3 adds:
// - BOUNDARY_REQUESTS
// - FIELD_MAINTENANCE
// - EQUIPMENT / EQUIPMENT_MAKES / EQUIPMENT_MODELS
// - BIN_SITES / BIN_MOVEMENTS
//
// includeArchived boolean flag (default false)
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
- GRAIN_BAGS_DOWN: grain bags down summary. key="".  (quick summary)
- GRAIN_BAGS_REPORT: grain bags FULL report w/ bushels by crop and rollups. key may be crop filter ("corn", "soybeans", "beans", "wheat") or "".
- RTK_TOWER_COUNT: count RTK towers. key="". 
- RTK_TOWER_LIST: list RTK towers. key="".
- RTK_TOWER_FIELDS: fields assigned to a specific RTK tower. key=tower name/id.

COUNTY INTENTS:
- COUNTIES_FARMED: how many counties we farm in / list counties. key="".
- COUNTY_FIELDS: list fields in a given county. key=county name.
- COUNTY_FARMS: list farms that have fields in a given county. key=county name.
- COUNTY_STATS: HEL/CRP/tillable summaries for a given county. key=county name.

NEW DOMAIN INTENTS:
- BOUNDARY_REQUESTS: boundary fix requests report. key can be "open", "completed", or "all" (default "open").
- FIELD_MAINTENANCE: field maintenance report. key can be a status like "needs approved", "pending", or "all".
- EQUIPMENT: equipment list. key can be equipment type (tractor/combine/implement/sprayer/truck/starfire/etc) OR search text.
- EQUIPMENT_MAKES: equipment makes list. key can be category OR search text.
- EQUIPMENT_MODELS: equipment models list. key can be makeId OR category OR search text.
- BIN_SITES: grain bin sites list. key can be search text or "".
- BIN_MOVEMENTS: grain bin movements list. key can be siteId OR site name/search text.

- UNKNOWN: anything else. key="".

ARCHIVED RULE (GLOBAL):
- includeArchived = true ONLY if the user explicitly asks for archived/inactive items
  (words like: "archived", "inactive", "old", "show archived", "include archived", "include inactive").
- Otherwise includeArchived MUST be false.

INTENT RULES (keep simple):
- If question asks "how many" AND mentions rtk + tower -> RTK_TOWER_COUNT.
- If question asks to "list/show" towers -> RTK_TOWER_LIST.
- If question asks for fields assigned to a tower -> RTK_TOWER_FIELDS (key=tower).

- If question asks "how many counties" OR "which counties" AND mentions we farm/farm in -> COUNTIES_FARMED.
- If question mentions "fields" AND contains "<something> county" -> COUNTY_FIELDS (key=<something>).
- If question mentions "farms" AND contains "<something> county" -> COUNTY_FARMS (key=<something>).
- If question mentions "<something> county" AND mentions any of (HEL, CRP, tillable, acres, totals, stats) -> COUNTY_STATS (key=<something>).

GRAIN BAGS RULES:
- If question mentions "grain bags" (or "grain bag" or "grainbag" or "bags") AND asks any of:
  ("how many", "count", "number of")
  -> GRAIN_BAGS_REPORT.
- Else if question mentions "grain bags" (or "bags") AND mentions any of:
  ("bushels", "by crop", "by county", "by farm", "report", "inventory", "capacity", "remaining")
  -> GRAIN_BAGS_REPORT.
- Otherwise if question mentions "grain bags down" or "bags down" -> GRAIN_BAGS_DOWN.

- If question mentions "boundary" and ("fix" or "request" or "requests") -> BOUNDARY_REQUESTS.
- If question mentions "field maintenance" or "maintenance" with field/farm context -> FIELD_MAINTENANCE.
- If question mentions "equipment makes" -> EQUIPMENT_MAKES.
- If question mentions "equipment models" -> EQUIPMENT_MODELS.
- If question mentions "equipment" -> EQUIPMENT.
- If question mentions "bin sites" or "grain bins" or "bin locations" -> BIN_SITES.
- If question mentions "bin movements" or "bin transfers" or "in/out of bins" -> BIN_MOVEMENTS.

KEY EXTRACTION:
- If user says "Pike County" or "pice county", key should be the word before "county" (e.g. "Pike" or "pice").
- For BOUNDARY_REQUESTS: if user says open/completed/all, key should be that word.
- For FIELD_MAINTENANCE: if user says a status (needs approved, pending, etc), key should be that phrase; if user says "all", key="all".
- For BIN_MOVEMENTS: if user names a bin site, put that in key.
- For GRAIN_BAGS_REPORT: if user says "corn" or "soybeans/beans" or "wheat", key should be that crop word; otherwise key="".

IMPORTANT:
- Do NOT choose FIELD_FULL for generic phrases like "rtk towers".
        `.trim()
      },
      { role: 'user', content: question }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}
