// /src/chat/intent.js  (FULL FILE)
// Rev: 2026-01-20-v2-intent-add-rtk-count

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
Classify the user request into ONE intent and return JSON ONLY:

Intents:
- FIELD_FULL: user wants details about a specific field (id or name). Return key as field id/name.
- GRAIN_BAGS_DOWN: user wants current grain bags down summary. key should be "".
- RTK_TOWER_COUNT: user asks "how many rtk towers" or total count of towers. key should be "".
- UNKNOWN: anything else. key should be "".

Return JSON only:
{ "intent": "FIELD_FULL|GRAIN_BAGS_DOWN|RTK_TOWER_COUNT|UNKNOWN", "key": "<string>" }

Rules:
- If the question contains "how many" AND mentions "rtk" and "tower" (or "towers"), choose RTK_TOWER_COUNT.
- Do NOT choose FIELD_FULL for generic phrases like "rtk towers" without a field identifier.
        `.trim()
      },
      { role: 'user', content: question }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}