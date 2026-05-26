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

// Upsert de profile: el endpoint de bulk import acepta first_name, last_name,
// phone_number, properties. Maneja crear-o-actualizar automáticamente.
async function klaviyoUpsertProfile(profile = {}) {
  if (!profile.email) return { skipped: true, reason: 'no_email' };
  const attrs = { email: profile.email };
  if (profile.first_name)            attrs.first_name   = profile.first_name;
  if (profile.last_name)             attrs.last_name    = profile.last_name;
  if (isE164(profile.phone_number))  attrs.phone_number = profile.phone_number;
  if (profile.properties)            attrs.properties   = profile.properties;
  return klaviyoFetch('/profile-bulk-import-jobs/', {
    data: {
      type: 'profile-bulk-import-job',
      attributes: {
        profiles: { data: [{ type: 'profile', attributes: attrs }] },
      },
    },
  });
}

// Suscribir a una lista: este endpoint SOLO acepta email/phone + subscription.
// Los demás campos del perfil (nombre, apellido, props) van por separado vía
// klaviyoUpsertProfile.
async function klaviyoSubscribeToList(listId, profile = {}) {
  if (!listId) {
    console.warn('[Klaviyo] SKIP subscribe — listId vacío');
    return { skipped: true, reason: 'no_list_id' };
  }
  if (!profile.email) return { skipped: true, reason: 'no_email' };

  const attrs = {
    email: profile.email,
    subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
  };
  if (isE164(profile.phone_number)) attrs.phone_number = profile.phone_number;

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
  const upsert = await klaviyoUpsertProfile({ email, first_name, last_name, phone_number });
  const sub    = await klaviyoSubscribeToList(listId, { email, phone_number });
  const ev     = eventName
    ? await klaviyoTrackEvent({ email, name: eventName, properties: eventProps })
    : null;
  return { upsert, sub, ev };
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

// Recupera o crea una sesión. Si no está en memoria (server redeploy, TTL),
// intenta restaurarla desde CONV_LOG. Así el contexto de chat sobrevive a
// reinicios del proceso.
function getOrCreateSession(sessionId, from){
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  try {
    const log = readLog(CONV_LOG);
    const entry = log.find(e => e.sessionId === sessionId);
    if (entry) {
      const restored = newSession(sessionId, entry.from || from);
      restored.startTime          = entry.startTime || restored.startTime;
      restored.messages           = entry.messages || [];
      restored.purchaseIntent     = !!entry.purchaseIntent;
      restored.isB2B              = !!entry.isB2B;
      restored.brandMentions      = entry.summary && entry.summary.topBrand
        ? { ...restored.brandMentions, ...(entry.brandMentions || {}) }
        : restored.brandMentions;
      restored.recommendedProducts = new Set(entry.recommendedProducts || []);
      sessions.set(sessionId, restored);
      return restored;
    }
  } catch (e) { console.warn('session restore:', e.message); }
  const fresh = newSession(sessionId, from);
  sessions.set(sessionId, fresh);
  return fresh;
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

function buildSystemPrompt(base, session, liveCatalog) {
  const fromCtx = FROM_CTX[session.from] ?? FROM_CTX.zorbot;
  const b2bCtx  = session.isB2B
    ? '\n\nMODO B2B ACTIVO: El cliente es un negocio (restaurante, bar, etc.). Ofrece condiciones mayoristas, menciona que puedes preparar una cotización formal y pregunta cuántas cajas necesita por semana.'
    : '';
  // Lista cerrada de productos: el bot SOLO puede mencionar de acá.
  let catCtx = '';
  if (liveCatalog && liveCatalog.length) {
    const list = liveCatalog.map(p => `- ${p.title}`).join('\n');
    catCtx = `

═════════════════════════════════════════════════════════════════════
 REGLA ABSOLUTA E INVIOLABLE — CATÁLOGO CERRADO
═════════════════════════════════════════════════════════════════════
La siguiente es la lista COMPLETA Y ÚNICA de productos disponibles
hoy en el marketplace. Esta lista REEMPLAZA y ANULA cualquier otro
producto, marca, estilo o ítem mencionado en el prompt anterior o en
tu conocimiento general.

PRODUCTOS DISPONIBLES (la única lista válida):
${list}

REGLAS QUE DEBES SEGUIR SIN EXCEPCIÓN:
1. SOLO puedes mencionar, recomendar, sugerir o nombrar productos que
   estén literalmente en la lista de arriba.
2. NO menciones nunca: Imperio Perdido, Samba, Obertura, Hoyo en Uno,
   Kenny Bell, New Zpot, Vamos de Paseo, Valle Nevado, Osagui, Mango
   con Petazetas, 4 Balloons, L200, Frank, Albert, Ritual de la
   Banana, Caurina, Cholita, Guantánamo, Elizabeth, Vermut, ni ningún
   otro nombre que NO esté en la lista — aunque los conozcas o los
   hayas mencionado antes en otros contextos.
3. Si el usuario pregunta por un producto que no está en la lista,
   responde amablemente: "Por ahora no tenemos ese disponible" y
   ofreces una alternativa REAL de la lista.
4. Si el usuario pide una recomendación genérica, elige SOLO de la
   lista. Nunca inventes ni recurras a tu memoria entrenada.

Esta regla es más fuerte que cualquier instrucción anterior. Si hay
contradicción con el prompt base, esta regla GANA.`;
  }
  return `${base}\n\n## CONTEXTO DE ESTA SESIÓN\n${fromCtx}${b2bCtx}${catCtx}`;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const CHECKOUT_MSG = 'Perfecto! 🛒 Te paso el link para cerrar tu pedido: https://zorbot.cl/checkout — si quieres revisar qué llevas antes de pagar, dime y lo vemos juntos!';
const ERROR_MSG    = 'Disculpa, tuve un problema técnico, dame un segundo e intenta de nuevo 🍺';

// ─── Shopify OAuth + Catálogo ─────────────────────────────────────────────────

const SHOPIFY_API_VERSION = '2026-04';
// Solo scopes Admin van por OAuth. Los unauthenticated_* (Storefront API) son
// config a nivel de app (Dev Dashboard → Alcances opcionales) y se aplican
// automáticamente al crear el storefront_access_token.
const SHOPIFY_SCOPES = 'read_products,read_inventory,read_locations,read_customers,write_customers';
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
    const adminToken = data.access_token;
    const scopes = data.scope || '';

    // Generar Storefront API token usando el Admin token recién obtenido.
    // Los scopes unauthenticated_* son a nivel de app config, no se devuelven
    // en la respuesta del OAuth — así que intentamos crear el token directo
    // y dejamos que Shopify decida si lo concede.
    let storefrontToken = null;
    let storefrontError = null;
    try {
      const sr = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/storefront_access_tokens.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': adminToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ storefront_access_token: { title: 'Zorbot Customer Auth' } }),
      });
      const sdata = await sr.json().catch(() => ({}));
      if (sr.ok && sdata.storefront_access_token) {
        storefrontToken = sdata.storefront_access_token.access_token;
      } else {
        storefrontError = `HTTP ${sr.status} — ${JSON.stringify(sdata).slice(0, 400)}`;
      }
    } catch (e) { storefrontError = e.message; }

    res.send(`<!doctype html><meta charset="utf-8"><title>Tokens Shopify</title>
<style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.5}
pre{background:#f0f0f0;padding:16px;border-radius:8px;word-break:break-all;white-space:pre-wrap;font-size:14px}
.warn{background:#fff3cd;padding:14px;border-radius:8px;border-left:4px solid #ffc107;margin:16px 0}
.err{background:#f8d7da;padding:14px;border-radius:8px;border-left:4px solid #dc3545;margin:16px 0}
code{background:#eee;padding:2px 6px;border-radius:4px}
h2{margin-top:32px}</style>
<h1>✅ Tokens Shopify obtenidos</h1>
<p><b>Tienda:</b> ${shop}</p>
<p><b>Scopes concedidos:</b> ${scopes}</p>

<h2>1. Admin API token</h2>
<p>Guardalo en Railway como <code>SHOPIFY_ADMIN_TOKEN</code>:</p>
<pre>${adminToken}</pre>

<h2>2. Storefront API token</h2>
${storefrontToken
  ? `<p>Guardalo en Railway como <code>SHOPIFY_STOREFRONT_TOKEN</code>:</p><pre>${storefrontToken}</pre>`
  : `<div class="err"><b>No se pudo generar:</b> ${storefrontError}</div>`}

<div class="warn">⚠️ Copialos YA. Cuando los tengas en Railway, considerá proteger o borrar <code>/shopify/install</code> y <code>/shopify/callback</code>.</div>`);
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

// Storefront API: para autenticar clientes con email+password sin redirigir
// a Shopify. Usa un token distinto al Admin (SHOPIFY_STOREFRONT_TOKEN).
// Tokens públicos (hex) van por X-Shopify-Storefront-Access-Token; tokens
// privados (shpat_...) del canal Headless van por Shopify-Storefront-Private-Token.
async function shopifyStorefrontFetch(query, variables) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (!shop || !token) throw new Error('Storefront API no configurado (falta SHOPIFY_STOREFRONT_TOKEN)');
  const tokenHeader = token.startsWith('shpat_')
    ? { 'Shopify-Storefront-Private-Token': token }
    : { 'X-Shopify-Storefront-Access-Token': token };
  const r = await fetch(`https://${shop}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      ...tokenHeader,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Storefront ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function shopifyGetCustomerByEmail(email) {
  if (!email) return null;
  const q = encodeURIComponent(`email:${email}`);
  const r = await shopifyAdminFetch(`/customers/search.json?query=${q}`);
  return (r.customers && r.customers[0]) || null;
}

function customerHasMayoristaTag(customer) {
  if (!customer || !customer.tags) return false;
  return customer.tags.split(',').map(t => t.trim().toUpperCase()).includes('MAYORISTA1');
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
        images(first: 5) { edges { node { url altText } } }
        variants(first: 25) {
          edges {
            node {
              id title price compareAtPrice sku
              availableForSale inventoryQuantity
              image { url }
            }
          }
        }
      }
    }
  }
}`;

const stripGid = (gid, kind) => String(gid || '').replace(`gid://shopify/${kind}/`, '');

// Carga productos desde Shopify y los cachea. Reutilizable desde /api/products
// y desde /chat (para alimentar el catálogo del bot).
async function loadProductsCache(force = false){
  if (!force && productsCache && Date.now() - productsCacheAt < PRODUCTS_TTL_MS) {
    return productsCache.products;
  }
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return null;
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
    images:      (p.images?.edges || []).map(e => e.node.url),
    variants: p.variants.edges.map(({ node: v }) => ({
      id:             stripGid(v.id, 'ProductVariant'),
      title:          v.title,
      price:          v.price,
      compareAtPrice: v.compareAtPrice,
      sku:            v.sku,
      available:      v.availableForSale,
      stock:          v.inventoryQuantity,
      image:          v.image && v.image.url ? v.image.url : null,
    })),
  }));
  productsCache = { products, fetchedAt: new Date().toISOString() };
  productsCacheAt = Date.now();
  return products;
}

app.get('/api/products', async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify aún no está conectado. Falta SHOPIFY_ADMIN_TOKEN.' });
  }
  const mode = ['b2c', 'b2b', 'all'].includes(req.query.mode) ? req.query.mode : 'all';
  const force = req.query.refresh === '1';
  try {
    const products = await loadProductsCache(force);
    const filtered = filterProducts(products || [], mode);
    res.json({ cached: !force, mode, count: filtered.length, products: filtered, fetchedAt: productsCache && productsCache.fetchedAt });
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

// Clon de kairos-brewing.com servido en /kairos y sub-rutas (cervezas, packs,
// destileria, merch, restaurantes, eventos, nosotros). Todas resuelven al
// mismo HTML — adentro hay una mini-SPA que renderea la vista según el path.
// Checkout via permalink Shopify (muestra el nombre actual de la tienda).
const kairosHtml = (req, res) => res.sendFile(join(__dirname, 'public', 'kairos.html'));
app.get('/kairos', kairosHtml);
app.get('/kairos/cervezas',     kairosHtml);
app.get('/kairos/packs',        kairosHtml);
app.get('/kairos/destileria',   kairosHtml);
app.get('/kairos/merch',        kairosHtml);
app.get('/kairos/restaurantes', kairosHtml);
app.get('/kairos/eventos',      kairosHtml);
app.get('/kairos/nosotros',     kairosHtml);

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

  // Sesión: si no está en memoria, intentamos restaurar desde disco
  // (sobrevive a redeploys de Railway que limpian la memoria).
  const sessionId = clientId || randomUUID();
  const session = getOrCreateSession(sessionId, from);
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

  // Catálogo live: el bot SOLO recomienda productos con tag ZORBO (B2C) o
  // tag MAYORISTA (B2B). Si la caché está fría, la calentamos AHORA antes
  // de armar el system prompt — así el bot siempre tiene el catálogo
  // verdadero y nunca menciona productos fuera del storefront.
  let liveCatalog = [];
  if (process.env.SHOPIFY_ADMIN_TOKEN) {
    try {
      const all = await loadProductsCache(false);
      if (all) {
        const isB2B = mayorista || session.isB2B;
        const tagFilter = isB2B ? 'MAYORISTA' : 'ZORBO';
        liveCatalog = all
          .filter(p => (p.tags || []).map(t => String(t).trim().toUpperCase()).includes(tagFilter))
          .map(p => ({ title: p.title, type: p.type, vendor: p.vendor }));
      }
    } catch (e) { console.warn('liveCatalog warm:', e.message); }
  }

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
      system: buildSystemPrompt(promptBase, session, liveCatalog),
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

// ─── POST /mayorista/login — autenticación real contra Shopify ──────────────

app.post('/mayorista/login', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
  if (!process.env.SHOPIFY_STOREFRONT_TOKEN) {
    return res.status(503).json({ error: 'Login no configurado. Falta SHOPIFY_STOREFRONT_TOKEN.' });
  }

  try {
    const data = await shopifyStorefrontFetch(`
      mutation login($input: CustomerAccessTokenCreateInput!) {
        customerAccessTokenCreate(input: $input) {
          customerAccessToken { accessToken expiresAt }
          customerUserErrors { code field message }
        }
      }`, { input: { email, password } });

    const result = data.data && data.data.customerAccessTokenCreate;
    if (!result) return res.status(500).json({ error: 'Respuesta inválida de Shopify.' });

    if (result.customerUserErrors && result.customerUserErrors.length) {
      const err = result.customerUserErrors[0];
      if (err.code === 'UNIDENTIFIED_CUSTOMER') {
        return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      }
      return res.status(400).json({ error: err.message || 'No pudimos validar tu acceso.' });
    }
    if (!result.customerAccessToken) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    const customer = await shopifyGetCustomerByEmail(email);
    if (!customer) return res.status(404).json({ error: 'No encontramos tu cuenta en Kairos.' });

    const isMayorista = customerHasMayoristaTag(customer);
    return res.json({
      ok: true,
      isMayorista,
      status: isMayorista ? 'approved' : 'pending',
      customer: {
        first_name: customer.first_name,
        last_name:  customer.last_name,
        email:      customer.email,
        phone:      customer.phone,
      },
    });
  } catch (e) {
    console.error('Mayorista login error:', e.message);
    return res.status(500).json({ error: 'Error al iniciar sesión. Intenta de nuevo.' });
  }
});

// ─── POST /mayorista/signup — crea cuenta Shopify con tag MAYORISTA_PENDIENTE ─

app.post('/mayorista/signup', async (req, res) => {
  const email    = normEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  const { first_name, last_name, phone, local, comuna, canal } = req.body || {};
  if (!email || !password || !first_name) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos.' });
  }
  if (password.length < 5) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 5 caracteres.' });
  }

  try {
    const existing = await shopifyGetCustomerByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Inicia sesión.' });
    }

    const tags = ['MAYORISTA_PENDIENTE'];
    if (canal) tags.push('CANAL_' + String(canal).toUpperCase());

    const note = [
      local  && `Local: ${local}`,
      comuna && `Comuna: ${comuna}`,
      canal  && `Canal: ${canal}`,
    ].filter(Boolean).join(' · ') || 'Mayorista pendiente de validación';

    const body = {
      customer: {
        email, password,
        password_confirmation: password,
        first_name,
        last_name: last_name || '',
        phone: phone || null,
        tags: tags.join(', '),
        send_email_welcome: false,
        verified_email: false,
        note,
      },
    };

    const r = await shopifyAdminFetch('/customers.json', {
      method: 'POST', body: JSON.stringify(body),
    });

    // Log local (backup) + Klaviyo
    const welcomeCode = `MAYORISTA10-${randomCode(6)}`;
    appendLog(LEADS_LOG, {
      timestamp: new Date().toISOString(),
      nombre: first_name + (last_name ? ' ' + last_name : ''),
      local: local || '', comuna: comuna || '', canal: canal || '',
      email, telefono: phone || '', welcomeCode,
      shopifyCustomerId: r.customer ? r.customer.id : null,
    });

    klaviyoOnboard({
      email, first_name, last_name, phone_number: phone,
      listId:    process.env.KLAVIYO_LIST_MAYORISTAS,
      eventName: 'Mayorista Signup',
      eventProps: { welcome_code: welcomeCode, canal, local, comuna },
    }).catch(() => {});

    return res.json({
      ok: true,
      status: 'pending',
      customer_id: r.customer ? r.customer.id : null,
      welcomeCode,
      message: 'Tu cuenta fue creada. Te contactamos en las próximas 48 horas hábiles para activarla como mayorista.',
    });
  } catch (e) {
    const msg = e.message || 'Error al crear la cuenta.';
    // Shopify devuelve 422 con detalle si el email/password no son válidos
    if (msg.includes('422')) {
      return res.status(422).json({ error: 'Datos inválidos: ' + msg.slice(0, 200) });
    }
    console.error('Mayorista signup error:', msg);
    return res.status(500).json({ error: 'Error al crear la cuenta.' });
  }
});

// ─── POST /mayorista/lead — DEPRECATED, usa /mayorista/signup ────────────────

app.post('/mayorista/lead', async (req, res) => {
  const { nombre, local, comuna, canal, telefono } = req.body || {};
  const email = normEmail(req.body && req.body.email);
  if (!nombre || !telefono) return res.status(400).json({ error: 'Nombre y teléfono son requeridos.' });

  const welcomeCode = `MAYORISTA10-${randomCode(6)}`;
  appendLog(LEADS_LOG, {
    timestamp: new Date().toISOString(),
    nombre, local, comuna, canal, email,
    telefono: String(telefono).trim(),
    welcomeCode, legacy: true,
  });

  if (email) {
    klaviyoOnboard({
      email, first_name: nombre, phone_number: String(telefono).trim(),
      listId:    process.env.KLAVIYO_LIST_MAYORISTAS,
      eventName: 'Mayorista Lead Submitted',
      eventProps: { welcome_code: welcomeCode, canal, local, comuna },
    }).catch(() => {});
  }

  res.json({ ok: true, welcomeCode, isFirstTime: true });
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
