import { detectIntent } from './intent.js';
import { writeAnswer } from './answerWriter.js';
import { getFieldFullByKey, getGrainBagSummary } from '../data/getters.js';

export async function handleChat(req, res) {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    const intent = await detectIntent(question);

    let data;
    let prompt;

    switch (intent.intent) {
      case 'FIELD_FULL':
        data = getFieldFullByKey(intent.key);
        prompt = 'Explain everything about this field including RTK info.';
        break;

      case 'GRAIN_BAGS_DOWN':
        data = getGrainBagSummary();
        prompt = 'Summarize current grain bags down.';
        break;

      default:
        return res.json({ answer: "I don't know how to answer that yet." });
    }

    const answer = await writeAnswer(prompt, data);
    res.json({ answer });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
