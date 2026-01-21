// /src/chat/intent.js  (FULL FILE)
// Rev: 2026-01-21-v2-intent-rtk-count-list-fields
//
// Supports RTK intents:
// - RTK_TOWER_COUNT
// - RTK_TOWER_LIST
// - RTK_TOWER_FIELDS
//
// Keeps existing FIELD_FULL and GRAIN_BAGS_DOWN behavior.

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

Intents:
- FIELD_FULL
  User wants details about a specific field (id or name).
  key = field id or field name.

- GRAIN_BAGS_DOWN
  User wants current grain bags down summary.
  key = "".

- RTK_TOWER_COUNT
  User asks how many RTK towers exist / are used.
  key = "".

- RTK_TOWER_LIST
  User asks to list RTK towers.
  key = "".

- RTK_TOWER_FIELDS
  User asks for fields assigned to a specific RTK tower.
  key = RTK tower name or id.

- UNKNOWN
  Anything else.
  key = "".

Rules (IMPORTANT):
- If question contains "how many" AND mentions "rtk" and "tower" -> RTK_TOWER_COUNT.
- If question contains "list" OR "show" AND mentions "tower" -> RTK_TOWER_LIST.
- If question mentions BOTH "fields" AND "tower" AND references a specific tower name -> RTK_TOWER_FIELDS.
- Do NOT choose FIELD_FULL for generic phrases like "rtk towers".

Return JSON ONLY in this format:
{ "intent": "<INTENT>", "key": "<string>" }
        `.trim()
      },
      { role: 'user', content: question }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}
