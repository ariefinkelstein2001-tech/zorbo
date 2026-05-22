import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

app.use(cors());
app.use(express.json());

function loadSystemPrompt() {
  return readFileSync(join(__dirname, 'prompts', 'master.md'), 'utf-8');
}

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'El campo "message" es requerido.' });
  }

  const systemPrompt = loadSystemPrompt();

  const messages = [
    ...history,
    { role: 'user', content: message },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  res.json({ response: text });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zorbot escuchando en http://localhost:${PORT}`);
});
