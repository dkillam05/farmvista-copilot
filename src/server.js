import express from 'express';
import { handleChat } from './chat/handleChat.js';
import { failFast } from './util/failFast.js';

failFast();

const app = express();
app.use(express.json());

app.post('/chat', handleChat);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Copilot v2 listening on ${port}`);
});
