import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

app.use(cors());
app.use(express.json());

// ─── Logs ─────────────────────────────────────────────────────────────────────

const LOGS_DIR  = join(__dirname, 'logs');
const CONV_LOG  = join(LOGS_DIR, 'conversations.json');
const ERR_LOG   = join(LOGS_DIR, 'errors.json');
const GAMES_LOG = join(LOGS_DIR, 'games.json');
const LEADS_LOG = join(LOGS_DIR, 'mayoristas_leads.json');

function initLogs() {
  if (!existsSync(LOGS_DIR))   mkdirSync(LOGS_DIR, { recursive: true });
  if (!existsSync(CONV_LOG))   writeFileSync(CONV_LOG,  '[]');
  if (!existsSync(ERR_LOG))    writeFileSync(ERR_LOG,   '[]');
  if (!existsSync(GAMES_LOG))  writeFileSync(GAMES_LOG, '[]');
  if (!existsSync(LEADS_LOG))  writeFileSync(LEADS_LOG, '[]');
}

function readLog(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); }
  catch { return []; }
}

function appendLog(file, entry) {
  try {
    const list = readLog(file);
    list.push(entry);
    writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (e) { console.error('Log append error:', e.message); }
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const RAND_ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += RAND_ALPH[Math.floor(Math.random() * RAND_ALPH.length)];
  return s;
}

function saveSession(session) {
  try {
    const log = readLog(CONV_LOG);
    const entry = serializeSession(session);
    const idx = log.findIndex(e => e.sessionId === session.id);
    if (idx >= 0) log[idx] = entry; else log.push(entry);
    writeFileSync(CONV_LOG, JSON.stringify(log, null, 2));
  } catch (e) { console.error('Log write error:', e.message); }
}

function logError(sessionId, err) {
  try {
    const log = readLog(ERR_LOG);
    log.push({ timestamp: new Date().toISOString(), sessionId, error: err.message ?? String(err) });
    writeFileSync(ERR_LOG, JSON.stringify(log, null, 2));
  } catch {}
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 min de inactividad

function newSession(id, from) {
  const validFrom = ['firulais', 'banny', 'zorbot'].includes(from) ? from : 'zorbot';
  return {
    id,
    startTime:          new Date().toISOString(),
    from:               validFrom,
    messages:           [],
    purchaseIntent:     false,
    isB2B:              false,
    brandMentions:      { 'Kairos Brewing': 0, 'Firulais': 0, 'Banny': 0 },
    recommendedProducts: new Set(),
    timer:              null,
  };
}

function touchSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    const live = sessions.get(id);
    if (live) { saveSession(live); sessions.delete(id); }
  }, SESSION_TTL);
}

function serializeSession(s) {
  const topBrand = Object.entries(s.brandMentions).sort((a, b) => b[1] - a[1])[0][0];
  const products  = [...s.recommendedProducts];
  return {
    sessionId:           s.id,
    startTime:           s.startTime,
    endTime:             new Date().toISOString(),
    from:                s.from,
    messages:            s.messages,
    recommendedProducts: products,
    topBrand,
    purchaseIntent:      s.purchaseIntent,
    isB2B:               s.isB2B,
    duration:            Math.round((Date.now() - new Date(s.startTime).getTime()) / 1000),
    summary: {
      products,
      purchaseIntent:      s.purchaseIntent,
      topBrand,
      estimatedOrderSize:  products.length ? `${products.length} producto(s) mencionado(s)` : 'sin pedido armado',
      clientType:          s.isB2B ? 'B2B' : 'B2C',
    },
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

const PURCHASE_KW = [
  'quiero pagar', 'confirmar pedido', 'lo llevo', 'dale pídelo', 'dale, pídelo',
  'me lo llevo', 'quiero comprar', 'lo quiero todo', 'lo compro', 'hacer el pedido',
  'arma el pedido', 'checkout', 'quiero pedir', 'listo lo llevo',
];

const B2B_KW = [
  'restaurante', ' bar', 'bares', 'cantina', 'hotel', 'por volumen',
  'mayorista', 'por mayor', 'cajas', 'distribuci', 'proveedor', 'local gastronómico',
  'dueño de un bar', 'tengo un bar', 'tengo un restaurante',
];

const BRAND_KW = {
  'Kairos Brewing': [
    'kairos', 'secret lab', 'galactic mission', 'alerta roja', 'nada personal',
    'imperio perdido', 'ritual de la banana', 'obertura', 'samba', 'hoyo en uno',
    'kenny bell', 'new zpot', 'vamos de paseo', 'valle nevado', 'osagui',
    'mango con petazetas', '4 balloons', 'l200', 'frank', 'albert',
    'cerveza', 'cerv', 'ipa', 'neipa', 'pils', 'stout', 'ale', 'lager',
    'weizen', 'märzen', 'bock', 'golden', 'artesanal',
  ],
  'Firulais': ['firulais', 'chelada', 'michelada', 'caurina', 'pepita', 'cholita'],
  'Banny': [
    'banny', 'gin ', 'ron ', 'rum ', 'whiskey', 'vermut', 'mojito',
    'guantánamo', 'elizabeth', 'destilado', 'rtd', 'ready to drink',
    'rey de copas', 'bárvaro',
  ],
};

const PRODUCT_LIST = [
  'Secret Lab', 'Galactic Mission', 'Alerta Roja', 'Nada Personal', 'Imperio Perdido',
  'Ritual de la Banana', 'Obertura', 'Samba', 'Hoyo en Uno', 'Kenny Bell',
  'New Zpot', 'Vamos de Paseo', 'Valle Nevado', 'Osagui', 'Mango con Petazetas',
  '4 Balloons', 'L200', 'Frank', 'Albert',
  'Caurina', 'Pepita', 'Cholita',
  'Gin Banny Contemporáneo', 'Gin Banny London Dry', 'Rey de Copas White Rum',
  'Vermut Banny', 'Bárvaro Whiskey Banny', 'Guantánamo Mojito', 'Elizabeth Gin Tonic',
];

const detect = (text, kws) => kws.some(k => text.toLowerCase().includes(k));

function countBrands(text) {
  const t = text.toLowerCase();
  return Object.fromEntries(
    Object.entries(BRAND_KW).map(([b, kws]) => [b, kws.filter(k => t.includes(k)).length])
  );
}

const findProducts = text =>
  PRODUCT_LIST.filter(p => text.toLowerCase().includes(p.toLowerCase()));

// ─── System prompt ────────────────────────────────────────────────────────────

const FROM_CTX = {
  firulais: 'El cliente llegó desde la landing de Firulais Craft Mix. Arranca enfocado en cheladas artesanales (Caurina, Pepita, Cholita). Conoces todo el catálogo — haz cross-sell natural a Kairos Brewing y Banny cuando la conversación fluya.',
  banny:    'El cliente llegó desde la landing de Banny by Kairos. Arranca enfocado en destilados y RTD (Gin, Ron, Whiskey, Vermut, Mojito, Gin Tonic). Conoces todo el catálogo — haz cross-sell natural a Kairos y Firulais cuando la conversación fluya.',
  zorbot:   'El cliente llegó directo a la botillería virtual Zorbot. Sé neutro y amigable, presenta las 3 marcas disponibles: Kairos Brewing, Firulais y Banny.',
};

function buildSystemPrompt(base, session) {
  const fromCtx = FROM_CTX[session.from] ?? FROM_CTX.zorbot;
  const b2bCtx  = session.isB2B
    ? '\n\nMODO B2B ACTIVO: El cliente es un negocio (restaurante, bar, etc.). Ofrece condiciones mayoristas, menciona que puedes preparar una cotización formal y pregunta cuántas cajas necesita por semana.'
    : '';
  return `${base}\n\n## CONTEXTO DE ESTA SESIÓN\n${fromCtx}${b2bCtx}`;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const CHECKOUT_MSG = 'Perfecto! 🛒 Te paso el link para cerrar tu pedido: https://zorbot.cl/checkout — si quieres revisar qué llevas antes de pagar, dime y lo vemos juntos!';
const ERROR_MSG    = 'Disculpa, tuve un problema técnico, dame un segundo e intenta de nuevo 🍺';

// ─── Static frontend ──────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, 'public')));

// ─── Init ─────────────────────────────────────────────────────────────────────

initLogs();

// ─── POST /chat ───────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message, sessionId: clientId } = req.body;
  const from      = req.body.from || req.query.from;
  const mayorista = req.body.mayorista === true;

  if (!message) return res.status(400).json({ error: 'El campo "message" es requerido.' });

  let promptBase;
  try {
    const promptFile = mayorista ? 'mayorista.md' : 'master.md';
    promptBase = readFileSync(join(__dirname, 'prompts', promptFile), 'utf-8');
  } catch {
    return res.status(500).json({ error: 'Error al cargar el sistema.' });
  }

  // Sesión
  const sessionId = clientId || randomUUID();
  if (!sessions.has(sessionId)) sessions.set(sessionId, newSession(sessionId, from));
  const session = sessions.get(sessionId);
  touchSession(sessionId);

  // Detectar flags
  const wasB2B = session.isB2B;
  if (detect(message, B2B_KW)) session.isB2B = true;
  const newlyB2B = !wasB2B && session.isB2B;

  // Intención de compra → bypass Claude, enviar link de checkout
  // Skip si el mensaje contiene contexto B2B (mayorista, no checkout)
  if (!detect(message, B2B_KW) && detect(message, PURCHASE_KW)) {
    session.purchaseIntent = true;
    session.messages.push({ role: 'user',      content: message,      timestamp: new Date().toISOString() });
    session.messages.push({ role: 'assistant', content: CHECKOUT_MSG, timestamp: new Date().toISOString() });
    saveSession(session);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
    res.write(`data: ${JSON.stringify({ delta: CHECKOUT_MSG })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Construir historial para Claude
  const apiMessages = session.messages.map(m => ({ role: m.role, content: m.content }));
  apiMessages.push({ role: 'user', content: message });

  // Trackear mensaje del usuario
  session.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
  for (const [b, c] of Object.entries(countBrands(message))) session.brandMentions[b] += c;

  // SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

  let fullResponse = '';
  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSystemPrompt(promptBase, session),
      messages: apiMessages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullResponse += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
      }
    }

    session.messages.push({ role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() });
    for (const p of findProducts(fullResponse)) session.recommendedProducts.add(p);
    for (const [b, c] of Object.entries(countBrands(fullResponse))) session.brandMentions[b] += c;
    saveSession(session);

  } catch (err) {
    console.error('API error:', err.message);
    logError(sessionId, err);
    res.write(`data: ${JSON.stringify({ delta: ERROR_MSG })}\n\n`);
    session.messages.push({ role: 'assistant', content: ERROR_MSG, timestamp: new Date().toISOString() });
    saveSession(session);
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── POST /game/check-email — verifica si el email ya jugó ───────────────────

app.post('/game/check-email', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido.' });
  }
  const list = readLog(GAMES_LOG);
  const exists = list.some(g => normEmail(g.email) === email);
  res.json({ exists });
});

// ─── POST /game/claim — registra el premio ganado y devuelve el cupón ────────

app.post('/game/claim', (req, res) => {
  const { nombre, apellido, email, prize } = req.body || {};
  const e = normEmail(email);
  if (!e || !e.includes('@')) return res.status(400).json({ error: 'Email inválido.' });
  if (!nombre || !apellido)   return res.status(400).json({ error: 'Nombre y apellido son requeridos.' });
  if (!prize || !prize.type)  return res.status(400).json({ error: 'Premio inválido.' });

  const list = readLog(GAMES_LOG);
  if (list.some(g => normEmail(g.email) === e)) {
    return res.status(409).json({ error: 'Ya jugaste con este email. El cupón es uno por persona.' });
  }

  const suffix = randomCode(6);
  const code = prize.type === 'pct'  ? `ZORBO${prize.value}-${suffix}`
             : prize.type === 'ship' ? `ENVIO-${suffix}`
             :                         `REGALO-${suffix}`;

  const entry = {
    timestamp: new Date().toISOString(),
    nombre, apellido, email: e,
    prize, code,
    shopifyCreated: false, // se actualiza a true cuando integremos Admin API
  };
  appendLog(GAMES_LOG, entry);
  // TODO Shopify Admin API: crear discount code y marcar shopifyCreated:true
  res.json({ ok: true, code });
});

// ─── POST /mayorista/login — autenticación contra Shopify (pendiente) ────────

app.post('/mayorista/login', (req, res) => {
  // TODO Storefront API customerAccessTokenCreate + Admin API tag check (MAYORISTA1).
  // Mientras no tengamos los tokens, devolvemos 501 con mensaje claro.
  return res.status(501).json({
    error: 'Acceso mayorista pendiente: la integración con Shopify aún no está activa. Tu equipo está terminando de conectarla.',
  });
});

// ─── POST /mayorista/lead — guarda info de mayorista nuevo ───────────────────

app.post('/mayorista/lead', (req, res) => {
  const { nombre, local, comuna, canal, email, telefono, mensaje } = req.body || {};
  if (!nombre || !telefono) {
    return res.status(400).json({ error: 'Nombre y teléfono son requeridos.' });
  }
  const entry = {
    timestamp: new Date().toISOString(),
    nombre, local, comuna, canal,
    email:    normEmail(email),
    telefono: String(telefono).trim(),
    mensaje:  mensaje || '',
  };
  appendLog(LEADS_LOG, entry);
  res.json({ ok: true });
});

// ─── DELETE /session/:id — terminar sesión y obtener resumen ──────────────────

app.delete('/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada.' });
  clearTimeout(session.timer);
  saveSession(session);
  sessions.delete(req.params.id);
  res.json({ ok: true, summary: serializeSession(session).summary });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zorbot escuchando en http://localhost:${PORT}`));
