import OpenAI from 'openai';
const openai = new OpenAI();

export async function writeAnswer(prompt, data) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'You write clear farm-operational answers.' },
      { role: 'user', content: `${prompt}\n\nDATA:\n${JSON.stringify(data, null, 2)}` }
    ]
  });

  return res.choices[0].message.content;
}
