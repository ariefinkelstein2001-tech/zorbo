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

  let systemPrompt;
  try {
    systemPrompt = loadSystemPrompt();
  } catch {
    return res.status(500).json({ error: 'Error al cargar el system prompt.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const messages = [
    ...history,
    { role: 'user', content: message },
  ];

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    const fallback = 'Uy, tuve un problema técnico. Intenta de nuevo en un momento.';
    res.write(`data: ${JSON.stringify({ delta: fallback })}\n\n`);
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zorbot escuchando en http://localhost:${PORT}`);
});
