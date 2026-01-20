import OpenAI from 'openai';

const openai = new OpenAI();

export async function detectIntent(question) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: `
Classify the user question into ONE intent:

FIELD_FULL
GRAIN_BAGS_DOWN
UNKNOWN

Return JSON only:
{ "intent": "...", "key": "..." }
        `
      },
      { role: 'user', content: question }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}
