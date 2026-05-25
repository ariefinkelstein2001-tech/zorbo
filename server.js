import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';

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
const todayISO = () => new Date().toISOString().slice(0, 10);

// ─── Klaviyo (no-op si KLAVIYO_API_KEY no está configurada) ──────────────────

const KLAVIYO_REVISION = '2024-10-15';
const isE164 = (p) => typeof p === 'string' && /^\+[1-9]\d{6,14}$/.test(p);

async function klaviyoFetch(path, body, method = 'POST') {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) {
    console.warn(`[Klaviyo] SKIP ${method} ${path} — KLAVIYO_API_KEY no está seteada`);
    return { skipped: true, reason: 'no_api_key' };
  }
  try {
    const res = await fetch(`https://a.klaviyo.com/api${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        accept: 'application/json',
        revision: KLAVIYO_REVISION,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      console.error(`[Klaviyo] ERROR ${method} ${path} → ${res.status}`, txt.slice(0, 500));
      return { ok: false, status: res.status, body: txt };
    }
    console.log(`[Klaviyo] OK ${method} ${path} → ${res.status}`);
    return { ok: true, status: res.status, body: txt };
  } catch (e) {
    console.error(`[Klaviyo] NETWORK ${method} ${path} →`, e.message);
    return { ok: false, error: e.message };
  }
}

// Endpoint combinado: crea o actualiza el perfil Y lo suscribe a la lista en
// una sola llamada. Devuelve OK también si el email ya existía.
async function klaviyoSubscribeToList(listId, profile = {}) {
  if (!listId) {
    console.warn('[Klaviyo] SKIP subscribe — listId vacío');
    return { skipped: true, reason: 'no_list_id' };
  }
  if (!profile.email) return { skipped: true, reason: 'no_email' };

  const attrs = { email: profile.email };
  if (profile.first_name)   attrs.first_name   = profile.first_name;
  if (profile.last_name)    attrs.last_name    = profile.last_name;
  if (isE164(profile.phone_number)) attrs.phone_number = profile.phone_number;
  if (profile.properties)   attrs.properties   = profile.properties;
  attrs.subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };

  return klaviyoFetch('/profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'Zorbot',
        historical_import: false,
        profiles: { data: [{ type: 'profile', attributes: attrs }] },
      },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  });
}

async function klaviyoTrackEvent({ email, name, properties }) {
  if (!email || !name) return { skipped: true };
  return klaviyoFetch('/events/', {
    data: {
      type: 'event',
      attributes: {
        properties: properties || {},
        metric:  { data: { type: 'metric',  attributes: { name } } },
        profile: { data: { type: 'profile', attributes: { email } } },
      },
    },
  });
}

async function klaviyoOnboard({ email, first_name, last_name, phone_number, listId, eventName, eventProps }) {
  if (!email) return;
  const sub = await klaviyoSubscribeToList(listId, { email, first_name, last_name, phone_number });
  if (eventName) {
    const ev = await klaviyoTrackEvent({ email, name: eventName, properties: eventProps });
    return { sub, ev };
  }
  return { sub };
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

// ─── Shopify OAuth + Catálogo ─────────────────────────────────────────────────

const SHOPIFY_API_VERSION = '2026-04';
const SHOPIFY_SCOPES = 'read_products,read_inventory,read_locations';
const SHOPIFY_SHOP_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function verifyShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string') return false;
  const message = Object.keys(rest).sort()
    .map(k => `${k}=${rest[k]}`).join('&');
  const computed = createHmac('sha256', secret).update(message).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hmac, 'hex'));
  } catch { return false; }
}

// GET /shopify/install — redirige al consent screen de Shopify
app.get('/shopify/install', (req, res) => {
  const shop = String(req.query.shop || process.env.SHOPIFY_STORE_DOMAIN || '');
  if (!SHOPIFY_SHOP_REGEX.test(shop)) {
    return res.status(400).send('Dominio inválido. Esperaba algo como kairos-brewing.myshopify.com');
  }
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return res.status(500).send('Falta SHOPIFY_API_KEY en el servidor.');

  const redirectUri = `https://${req.get('host')}/shopify/callback`;
  const state = randomUUID();
  const url = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(apiKey)}`
    + `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

// GET /shopify/callback — intercambia code por access_token y lo muestra una vez
app.get('/shopify/callback', async (req, res) => {
  const shop = String(req.query.shop || '');
  const code = String(req.query.code || '');
  if (!SHOPIFY_SHOP_REGEX.test(shop) || !code) {
    return res.status(400).send('Parámetros inválidos.');
  }
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(500).send('Faltan SHOPIFY_API_KEY o SHOPIFY_API_SECRET.');

  if (!verifyShopifyHmac(req.query, apiSecret)) {
    return res.status(401).send('HMAC inválido.');
  }

  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      return res.status(500).send(`<pre>Error: ${JSON.stringify(data, null, 2)}</pre>`);
    }
    res.send(`<!doctype html><meta charset="utf-8"><title>Token Shopify</title>
<style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.5}
pre{background:#f0f0f0;padding:16px;border-radius:8px;word-break:break-all;white-space:pre-wrap;font-size:14px}
.warn{background:#fff3cd;padding:14px;border-radius:8px;border-left:4px solid #ffc107;margin:16px 0}
code{background:#eee;padding:2px 6px;border-radius:4px}</style>
<h1>✅ Token Shopify obtenido</h1>
<p>Copia este token y guárdalo en Railway como variable de entorno <code>SHOPIFY_ADMIN_TOKEN</code>:</p>
<pre>${data.access_token}</pre>
<p><b>Scopes:</b> ${data.scope || '(no devueltos)'}</p>
<p><b>Tienda:</b> ${shop}</p>
<div class="warn">⚠️ Copia el token YA. Cuando lo tengas en Railway, considerá borrar los endpoints <code>/shopify/install</code> y <code>/shopify/callback</code> o protegerlos — ahora cualquiera con esta URL puede iniciar el flujo.</div>`);
  } catch (e) {
    res.status(500).send(`<pre>Error: ${e.message}</pre>`);
  }
});

// ─── Shopify Catalog API ──────────────────────────────────────────────────────

async function shopifyAdminFetch(path, init = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) throw new Error('Shopify no configurado (faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_ADMIN_TOKEN)');
  const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': token,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

let productsCache = null;
let productsCacheAt = 0;
const PRODUCTS_TTL_MS = 5 * 60 * 1000;

// Productos/handles a ocultar siempre (tests, eventos, recargas, reservas).
const HIDE_HANDLES = new Set([
  'producto-de-prueba', 'evento', 'recarga-co2', 'reserva-cumpleanos',
]);
const HIDE_TITLE_RX = /^(pago factura|reservas?|recarga)/i;

function isMayoristaProduct(p) {
  const tags = (p.tags || []).map(t => t.toUpperCase());
  if (tags.includes('MAYORISTA')) return true;
  const title = (p.title || '').toLowerCase();
  if (title.startsWith('barril ') || title.startsWith('bidon ')) return true;
  if (/^\d+\s*pack.*mayorista/i.test(p.title || '')) return true;
  return false;
}

function filterProducts(products, mode) {
  return products.filter(p => {
    if (HIDE_HANDLES.has(p.handle)) return false;
    if (HIDE_TITLE_RX.test(p.title || '')) return false;
    const isB2B = isMayoristaProduct(p);
    if (mode === 'b2b') return isB2B;
    if (mode === 'b2c') return !isB2B;
    return true; // mode === 'all'
  });
}

const PRODUCTS_QUERY = `{
  products(first: 100, query: "status:active") {
    edges {
      node {
        id title handle description productType vendor tags
        featuredImage { url altText }
        variants(first: 25) {
          edges {
            node {
              id title price compareAtPrice sku
              availableForSale inventoryQuantity
            }
          }
        }
      }
    }
  }
}`;

const stripGid = (gid, kind) => String(gid || '').replace(`gid://shopify/${kind}/`, '');

app.get('/api/products', async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify aún no está conectado. Falta SHOPIFY_ADMIN_TOKEN.' });
  }
  const mode = ['b2c', 'b2b', 'all'].includes(req.query.mode) ? req.query.mode : 'all';
  const force = req.query.refresh === '1';
  if (!force && productsCache && Date.now() - productsCacheAt < PRODUCTS_TTL_MS) {
    const filtered = filterProducts(productsCache.products, mode);
    return res.json({ cached: true, mode, count: filtered.length, products: filtered, fetchedAt: productsCache.fetchedAt });
  }
  try {
    const resp = await shopifyAdminFetch('/graphql.json', {
      method: 'POST',
      body: JSON.stringify({ query: PRODUCTS_QUERY }),
    });
    if (resp.errors) throw new Error(JSON.stringify(resp.errors));

    const products = resp.data.products.edges.map(({ node: p }) => ({
      id:          stripGid(p.id, 'Product'),
      handle:      p.handle,
      title:       p.title,
      description: p.description,
      type:        p.productType,
      vendor:      p.vendor,
      tags:        p.tags,
      image:       p.featuredImage?.url || null,
      variants: p.variants.edges.map(({ node: v }) => ({
        id:             stripGid(v.id, 'ProductVariant'),
        title:          v.title,
        price:          v.price,
        compareAtPrice: v.compareAtPrice,
        sku:            v.sku,
        available:      v.availableForSale,
        stock:          v.inventoryQuantity,
      })),
    }));

    productsCache = { products, fetchedAt: new Date().toISOString() };
    productsCacheAt = Date.now();
    const filtered = filterProducts(products, mode);
    res.json({ cached: false, mode, count: filtered.length, products: filtered, fetchedAt: productsCache.fetchedAt });
  } catch (e) {
    console.error('Shopify products error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cart-link?items=44123:2,44987:1 → URL de checkout pre-cargado
app.get('/api/cart-link', (req, res) => {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  if (!shop) return res.status(500).json({ error: 'SHOPIFY_STORE_DOMAIN no configurado.' });
  const items = String(req.query.items || '');
  if (!/^\d+:\d+(,\d+:\d+)*$/.test(items)) {
    return res.status(400).json({ error: 'Formato inválido. Esperaba variantId:qty,variantId:qty' });
  }
  res.json({ url: `https://${shop}/cart/${items}` });
});

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

// ─── POST /game/register — crea perfil + cupón de bienvenida, valida juego ───

app.post('/game/register', async (req, res) => {
  const { nombre, apellido } = req.body || {};
  const email = normEmail(req.body && req.body.email);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido.' });
  if (!nombre || !apellido)            return res.status(400).json({ error: 'Nombre y apellido son requeridos.' });

  const list = readLog(GAMES_LOG);
  let entry = list.find(g => normEmail(g.email) === email);
  let isFirstTime = false;

  if (!entry) {
    const welcomeCode = `BIENVENIDA10-${randomCode(6)}`;
    entry = {
      email, nombre, apellido,
      createdAt: new Date().toISOString(),
      welcomeCode,
      welcomeShopifyCreated: false, // TODO Shopify Admin API: crear discount real
      plays: [],
    };
    list.push(entry);
    writeFileSync(GAMES_LOG, JSON.stringify(list, null, 2));
    isFirstTime = true;

    klaviyoOnboard({
      email, first_name: nombre, last_name: apellido,
      listId:    process.env.KLAVIYO_LIST_FIRST_PURCHASE,
      eventName: 'Welcome 10% Issued',
      eventProps: { welcome_code: welcomeCode, source: 'game-gate' },
    }).catch(() => {});
  }

  const today    = todayISO();
  const lastPlay = Array.isArray(entry.plays) && entry.plays[entry.plays.length - 1];
  const canPlayToday = !lastPlay || lastPlay.date !== today;

  res.json({
    isFirstTime,
    welcomeCode: entry.welcomeCode,
    canPlayToday,
    nombre: entry.nombre,
    apellido: entry.apellido,
  });
});

// ─── POST /game/claim — registra el premio ganado del día y devuelve cupón ───

app.post('/game/claim', async (req, res) => {
  const { prize } = req.body || {};
  const email = normEmail(req.body && req.body.email);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido.' });
  if (!prize || !prize.type)           return res.status(400).json({ error: 'Premio inválido.' });

  const list = readLog(GAMES_LOG);
  const entry = list.find(g => normEmail(g.email) === email);
  if (!entry) return res.status(404).json({ error: 'Tu correo no está registrado. Pasa por el gate primero.' });

  if (!Array.isArray(entry.plays)) entry.plays = [];
  const today = todayISO();
  if (entry.plays.some(p => p.date === today)) {
    return res.status(409).json({ error: 'Ya jugaste hoy. Vuelve mañana para otra oportunidad.' });
  }

  const suffix = randomCode(6);
  const code = prize.type === 'pct'  ? `ZORBO${prize.value}-${suffix}`
             : prize.type === 'ship' ? `ENVIO-${suffix}`
             :                         `REGALO-${suffix}`;

  entry.plays.push({
    date: today,
    timestamp: new Date().toISOString(),
    prize, code,
    shopifyCreated: false, // TODO Shopify Admin API: crear discount real
  });
  writeFileSync(GAMES_LOG, JSON.stringify(list, null, 2));

  klaviyoTrackEvent({
    email, name: 'Game Prize Won',
    properties: { prize_type: prize.type, prize_value: prize.value || null, code, day: today },
  }).catch(() => {});

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

app.post('/mayorista/lead', async (req, res) => {
  const { nombre, local, comuna, canal, telefono, mensaje } = req.body || {};
  const email = normEmail(req.body && req.body.email);
  if (!nombre || !telefono) {
    return res.status(400).json({ error: 'Nombre y teléfono son requeridos.' });
  }

  const list = readLog(LEADS_LOG);
  const existing = email && list.find(l => normEmail(l.email) === email);
  let welcomeCode = existing && existing.welcomeCode ? existing.welcomeCode : null;
  let isFirstTime = false;
  if (!welcomeCode) {
    welcomeCode = `MAYORISTA10-${randomCode(6)}`;
    isFirstTime = true;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    nombre, local, comuna, canal,
    email,
    telefono: String(telefono).trim(),
    mensaje:  mensaje || '',
    welcomeCode,
    welcomeShopifyCreated: false, // TODO Shopify Admin API
  };
  appendLog(LEADS_LOG, entry);

  if (isFirstTime && email) {
    klaviyoOnboard({
      email, first_name: nombre, phone_number: entry.telefono,
      listId:    process.env.KLAVIYO_LIST_MAYORISTAS,
      eventName: 'Mayorista Lead Submitted',
      eventProps: { welcome_code: welcomeCode, canal, local, comuna },
    }).catch(() => {});
  }

  res.json({ ok: true, welcomeCode, isFirstTime });
});

// ─── Klaviyo: diagnóstico ────────────────────────────────────────────────────

app.get('/klaviyo/status', (req, res) => {
  res.json({
    apiKeyPresent:     !!process.env.KLAVIYO_API_KEY,
    apiKeyPrefix:      process.env.KLAVIYO_API_KEY ? process.env.KLAVIYO_API_KEY.slice(0, 6) + '...' : null,
    listFirstPurchase: process.env.KLAVIYO_LIST_FIRST_PURCHASE || null,
    listMayoristas:    process.env.KLAVIYO_LIST_MAYORISTAS || null,
    revision:          KLAVIYO_REVISION,
  });
});

app.post('/klaviyo/test', async (req, res) => {
  const { email, listId, kind } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email requerido' });
  const useList = listId
    || (kind === 'mayorista' ? process.env.KLAVIYO_LIST_MAYORISTAS : process.env.KLAVIYO_LIST_FIRST_PURCHASE);
  const result = await klaviyoOnboard({
    email,
    first_name: 'Test',
    last_name:  'Zorbo',
    listId:     useList,
    eventName:  'Zorbo Test Sync',
    eventProps: { source: 'klaviyo-test-endpoint' },
  });
  res.json({ listIdUsed: useList, result });
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
