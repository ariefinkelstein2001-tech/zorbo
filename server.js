import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

app.use(cors());
app.use(express.json());

// ─── Storage paths (con soporte Railway Volume) ──────────────────────────────
// DATA_DIR (env var) apunta a un volumen persistente. Sin él, todo vive en el
// contenedor efímero y se pierde en cada redeploy. En Railway:
//   1. Service → Settings → Volumes → mount /data
//   2. Variables → DATA_DIR=/data
// Cuando DATA_DIR está seteado:
//   - Logs (conversaciones, feedback, juegos, leads) → $DATA_DIR/logs/
//   - Overrides editables del panel (.md de marca + products.json) →
//     $DATA_DIR/prompts/. Los .md del repo (prompts/*.md) actúan como seed:
//     si no hay override en disco, se usa el del repo.

const DATA_DIR = process.env.DATA_DIR || null;
const LOGS_DIR = DATA_DIR ? join(DATA_DIR, 'logs') : join(__dirname, 'logs');
const PROMPTS_BASE_DIR     = join(__dirname, 'prompts');
const PROMPTS_OVERRIDE_DIR = DATA_DIR ? join(DATA_DIR, 'prompts') : null;
const PROMPTS_EFFECTIVE_DIR = PROMPTS_OVERRIDE_DIR || PROMPTS_BASE_DIR;

const CONV_LOG  = join(LOGS_DIR, 'conversations.json');
const ERR_LOG   = join(LOGS_DIR, 'errors.json');
const GAMES_LOG = join(LOGS_DIR, 'games.json');
const LEADS_LOG = join(LOGS_DIR, 'mayoristas_leads.json');

function initLogs() {
  if (!existsSync(LOGS_DIR))   mkdirSync(LOGS_DIR, { recursive: true });
  if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) {
    mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
  }
  if (!existsSync(CONV_LOG))   writeFileSync(CONV_LOG,  '[]');
  if (!existsSync(ERR_LOG))    writeFileSync(ERR_LOG,   '[]');
  if (!existsSync(GAMES_LOG))  writeFileSync(GAMES_LOG, '[]');
  if (!existsSync(LEADS_LOG))  writeFileSync(LEADS_LOG, '[]');
  console.log('[storage] DATA_DIR=' + (DATA_DIR || '(no seteado · efímero)'));
}

// Lee un prompt: prioriza el override del volumen; si no, usa el del repo.
function readPromptFile(filename) {
  if (PROMPTS_OVERRIDE_DIR) {
    const o = join(PROMPTS_OVERRIDE_DIR, filename);
    if (existsSync(o)) return readFileSync(o, 'utf-8');
  }
  return readFileSync(join(PROMPTS_BASE_DIR, filename), 'utf-8');
}
// Guarda un prompt: si hay override dir, escribe ahí (no toca el repo).
function writePromptFile(filename, content) {
  const target = join(PROMPTS_EFFECTIVE_DIR, filename);
  if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) {
    mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
  }
  writeFileSync(target, content, 'utf-8');
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
  // topBrand siempre recomputado desde los mensajes con la lógica nueva
  // (usuario pesa 3x, empates → "Mixto", todos en 0 → null).
  const topBrand = pickTopBrand(computeBrandMentions(s.messages));
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
  // intención explícita de comprar
  'quiero pagar', 'confirmar pedido', 'lo llevo', 'dale pídelo', 'dale, pídelo',
  'me lo llevo', 'quiero comprar', 'lo quiero todo', 'lo compro', 'hacer el pedido',
  'arma el pedido', 'checkout', 'quiero pedir', 'listo lo llevo',
  'voy a pagar', 'paguemos', 'pagamos',
  // pedidos del link / checkout (variantes comunes)
  'link', 'el link', 'pasame el link', 'pásame el link', 'mandame el link',
  'mándame el link', 'envíame el link', 'enviame el link', 'manda el link',
  'pásamelo', 'pasamelo', 'mándamelo', 'mandamelo',
  'link de pago', 'link de checkout', 'link para pagar',
  'donde pago', 'dónde pago', 'cómo pago', 'como pago',
];

const B2B_KW = [
  'restaurante', ' bar', 'bares', 'cantina', 'hotel', 'por volumen',
  'mayorista', 'por mayor', 'cajas', 'distribuci', 'proveedor', 'local gastronómico',
  'dueño de un bar', 'tengo un bar', 'tengo un restaurante',
];

const BRAND_KW = {
  // Solo keywords ESPECÍFICOS de cada marca. Términos genéricos como "cerveza"
  // o "artesanal" se evitan a propósito — no atribuyen a nadie. La intención
  // se infiere de menciones de marca + productos.
  'Kairos Brewing': [
    'kairos',
    'secret lab', 'galactic mission', 'alerta roja', 'nada personal',
    'imperio perdido', 'ritual de la banana', 'obertura', 'samba', 'hoyo en uno',
    'kenny bell', 'new zpot', 'vamos de paseo', 'valle nevado', 'osagui',
    'mango con petazetas', '4 balloons', 'l200', 'frank', 'albert',
  ],
  'Firulais': [
    'firulais', 'chelada', 'cheladas', 'michelada',
    'caurina', 'pepita', 'cholita', 'cachupin', 'cachupín',
  ],
  'Banny': [
    'banny', 'gin', 'whisky', 'whiskey', 'bourbon', 'ron', 'rum',
    'vermut', 'mojito', 'gin tonic', 'gintonic',
    'guantánamo', 'elizabeth', 'destilado', 'destilados', 'rtd',
    'rey de copas', 'bárvaro', 'barvaro',
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
  const t = String(text || '').toLowerCase();
  return Object.fromEntries(
    Object.entries(BRAND_KW).map(([b, kws]) => [b, kws.filter(k => t.includes(k)).length])
  );
}

// Recalcula el peso de cada marca desde el historial completo de mensajes de
// una conversación. Lo del usuario pesa 3x lo del bot (lo que pide el cliente
// importa más que lo que menciona el bot en su bienvenida/recomendación).
function computeBrandMentions(messages) {
  const mentions = { 'Kairos Brewing': 0, 'Firulais': 0, 'Banny': 0 };
  for (const m of (messages || [])) {
    if (!m || !m.content) continue;
    const weight = m.role === 'user' ? 3 : 1;
    const c = countBrands(m.content);
    for (const [b, v] of Object.entries(c)) mentions[b] += v * weight;
  }
  return mentions;
}

// Elige la "marca top" con tolerancia a empates y conversaciones genéricas:
// - 0 menciones totales → null (Sin marca).
// - 2+ marcas en empate al máximo → "Mixto".
// - 2+ marcas con menciones y la top tiene < 60% del total → "Mixto".
// - Caso restante → marca con más menciones.
function pickTopBrand(mentions) {
  const entries = Object.entries(mentions);
  const total = entries.reduce((s, e) => s + e[1], 0);
  if (total === 0) return null;
  const sorted = entries.slice().sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  const tied = sorted.filter(e => e[1] === max);
  if (tied.length > 1) return 'Mixto';
  const withMentions = sorted.filter(e => e[1] > 0).length;
  const share = max / total;
  if (withMentions >= 2 && share < 0.6) return 'Mixto';
  return sorted[0][0];
}

// Versión "lazy" que se usa al leer conversaciones del log — recomputa desde
// los mensajes para que las conversaciones viejas (con topBrand calculado por
// la vieja lógica) también queden bien.
function effectiveTopBrand(c) {
  if (Array.isArray(c.messages) && c.messages.length) {
    return pickTopBrand(computeBrandMentions(c.messages));
  }
  return c.topBrand || null;
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
  // Notas extra por producto (editables desde /admin → Productos). Se inyectan
  // SOLO para productos presentes en la lista de sesión. No tocan Shopify.
  // Incluyen también el video URL si el equipo lo cargó.
  let extrasCtx = '';
  if (liveCatalog && liveCatalog.length) {
    try {
      const extras = loadProductExtras();
      const sections = [];
      for (const p of liveCatalog) {
        const e = extras.items?.[String(p.id)];
        if (!e) continue;
        const note = (e.extra || '').trim();
        const video = (e.video || '').trim();
        if (!note && !video) continue;
        let block = `### ${p.title}\n${note}`;
        if (video) block += `${note ? '\n' : ''}VIDEO del producto: ${video} (compártelo cuando el cliente quiera ver más).`;
        sections.push(block);
      }
      if (sections.length) {
        extrasCtx = `\n\n═════════════════════════════════════════════════════════════════════\n NOTAS INTERNAS POR PRODUCTO (Zorbot-only, editadas por el equipo)\n═════════════════════════════════════════════════════════════════════\nUsá esta información cuando recomiendes o describas estos productos —\nson notas curadas por el equipo (maridajes, ocasiones, datos de marca,\ntono específico). Solo aplica a los productos listados aquí. Si hay\nvideo asociado, mencioná el link cuando aplique.\n\n${sections.join('\n\n')}`;
      }
    } catch (e) { /* notas opcionales, ignorar errores */ }
  }
  // Tutoriales / videos técnicos cargados desde /admin → Tutoriales.
  // Mayoristas reciben todos los videos; B2C solo los scope:'general'.
  let tutorialsCtx = '';
  try {
    const all = loadTutorials();
    const filtered = all.filter(t => session.isB2B || t.scope === 'general');
    if (filtered.length) {
      const list = filtered.map(t => {
        const kw = t.keywords ? ` · keywords: ${t.keywords}` : '';
        const desc = t.description ? ` — ${t.description}` : '';
        return `- "${t.title}" → ${t.videoUrl}${desc}${kw}`;
      }).join('\n');
      tutorialsCtx = `\n\n═════════════════════════════════════════════════════════════════════\n VIDEOS / TUTORIALES DISPONIBLES\n═════════════════════════════════════════════════════════════════════\nCuando el cliente pregunte por un tema cubierto por estos videos\n(matchea con las keywords listadas o el título), incluí el link al\nfinal de tu respuesta diciendo algo como "te dejo un video que lo\nexplica: <url>". No inventes videos ni links — solo usá los de esta lista.\n\n${list}`;
    }
  } catch (e) { /* opcional */ }
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
  return `${base}\n\n## CONTEXTO DE ESTA SESIÓN\n${fromCtx}${b2bCtx}${catCtx}${extrasCtx}${tutorialsCtx}${buildFeedbackCtx()}`;
}

// Few-shot de correcciones del equipo (cargado en cada request, así editar
// /admin/feedback se refleja al instante en la próxima respuesta del bot).
function buildFeedbackCtx(){
  try {
    const all = loadFeedback();
    if (!all.length) return '';
    const fb = all.slice(-FEEDBACK_INJECT);
    const examples = fb.map((f, i) => {
      const why = f.explanation ? `\nPor qué la primera está mal: ${f.explanation}` : '';
      return `Ejemplo ${i+1}:\n— Respuesta INCORRECTA (no respondas así):\n"${f.original}"\n— Respuesta CORRECTA (estilo deseado):\n"${f.improved}"${why}`;
    }).join('\n\n');
    return `\n\n═════════════════════════════════════════════════════════════════════\n CORRECCIONES DEL EQUIPO — aprende de estos ejemplos\n═════════════════════════════════════════════════════════════════════\nEl equipo de Zorbo revisó respuestas tuyas anteriores y corrigió las\nque no estaban bien. Cuando enfrentes una situación similar, seguí el\nestilo, tono y forma de la respuesta CORRECTA, no de la incorrecta.\nEstas correcciones tienen prioridad sobre el tono base del prompt.\n\n${examples}`;
  } catch (e) { return ''; }
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const CHECKOUT_MSG = 'Perfecto! 🛒 Te abro el carrito ahora — ahí ves todo lo que llevas y arriba a la derecha aprietas **Pagar** para ir directo al checkout con tus datos.';
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

// ─── Admin panel (interno) ────────────────────────────────────────────────────
// Login con cookie de sesión (12h). Credenciales en ADMIN_USER / ADMIN_PASSWORD
// (env vars). Sin esas dos variables, el panel queda desactivado.
// Edita los .md de /prompts y el bot los releé en cada request, así los cambios
// se aplican al instante.

const PROMPT_SECTIONS = {
  general:   'general.md',
  kairos:    'kairos.md',
  firulais:  'firulais.md',
  banny:     'banny.md',
  mayorista: 'mayorista.md',
};

const ADMIN_COOKIE = 'zadm';
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const ADMIN_SESSIONS = new Map(); // token → { username, expiresAt }

function parseCookies(req){
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function adminSessionFor(req){
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const s = ADMIN_SESSIONS.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { ADMIN_SESSIONS.delete(token); return null; }
  return { token, ...s };
}

function isAdminConfigured(){
  return !!(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD);
}

function wantsHtml(req){
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

// Login deshabilitado temporalmente — /admin queda abierto. La infraestructura
// de sesiones queda intacta (constantes, /admin/login, /admin/logout, cookies)
// para poder reactivar el gate más adelante seteando ADMIN_AUTH_ENABLED=1.
function requireAdmin(req, res, next){
  if (process.env.ADMIN_AUTH_ENABLED !== '1') return next();
  if (!isAdminConfigured()) {
    if (wantsHtml(req)) return res.status(503).send(
      '<h1>Panel admin no configurado</h1><p>Falta ADMIN_USER / ADMIN_PASSWORD en el entorno.</p>'
    );
    return res.status(503).json({ error: 'Panel admin no configurado en el server.' });
  }
  if (adminSessionFor(req)) return next();
  if (wantsHtml(req)) return res.redirect(302, '/admin/login');
  return res.status(401).json({ error: 'No autorizado. Iniciá sesión en /admin/login.' });
}

// Limpieza periódica de sesiones expiradas (cada hora)
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of ADMIN_SESSIONS) if (s.expiresAt < now) ADMIN_SESSIONS.delete(t);
}, 60 * 60 * 1000).unref?.();

// ─── Rutas de login ─────────────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  // Si ya hay sesión válida, redirige al panel
  if (isAdminConfigured() && adminSessionFor(req)) return res.redirect(302, '/admin');
  res.sendFile(join(__dirname, 'admin-views', 'login.html'));
});

app.post('/admin/login', async (req, res) => {
  if (!isAdminConfigured()) return res.status(503).json({ error: 'Panel admin no configurado.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Faltan credenciales.' });
  }

  // Comparación constante en tiempo para evitar timing attacks
  const eqUser = safeStrEq(username.trim().toLowerCase(), String(process.env.ADMIN_USER).trim().toLowerCase());
  const eqPass = safeStrEq(password, String(process.env.ADMIN_PASSWORD));

  // Pequeño delay artificial para frenar fuerza bruta
  await new Promise(r => setTimeout(r, 250));

  if (!eqUser || !eqPass) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_TTL_MS;
  ADMIN_SESSIONS.set(token, { username: process.env.ADMIN_USER, expiresAt });

  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok: true, expiresAt });
});

app.post('/admin/logout', (req, res) => {
  const s = adminSessionFor(req);
  if (s) ADMIN_SESSIONS.delete(s.token);
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

function safeStrEq(a, b){
  const A = Buffer.from(a, 'utf-8');
  const B = Buffer.from(b, 'utf-8');
  if (A.length !== B.length) {
    // Igualar longitudes para que timingSafeEqual no tire
    timingSafeEqual(A, A);
    return false;
  }
  return timingSafeEqual(A, B);
}

// ─── Rutas protegidas ───────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(join(__dirname, 'admin-views', 'admin.html'));
});

app.get('/admin/me', requireAdmin, (req, res) => {
  const s = adminSessionFor(req);
  res.json({ username: s.username, expiresAt: s.expiresAt });
});

app.get('/admin/brand/:seccion', requireAdmin, (req, res) => {
  const file = PROMPT_SECTIONS[req.params.seccion];
  if (!file) return res.status(404).json({ error: 'Sección no encontrada' });
  try {
    const content = readPromptFile(file);
    res.json({ seccion: req.params.seccion, content });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo: ' + e.message });
  }
});

app.post('/admin/save-brand', requireAdmin, (req, res) => {
  const { seccion, contenido } = req.body || {};
  const file = PROMPT_SECTIONS[seccion];
  if (!file) return res.status(400).json({ error: 'Sección inválida' });
  if (typeof contenido !== 'string') return res.status(400).json({ error: 'Contenido inválido' });
  if (contenido.length > 200000) return res.status(413).json({ error: 'Contenido demasiado grande' });
  try {
    writePromptFile(file, contenido);
    res.json({ ok: true, seccion, bytes: contenido.length });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando: ' + e.message });
  }
});

// ─── Productos: catálogo Shopify + notas extra para Zorbot ──────────────────
// La lista de productos viene del cache de Shopify (autosync).
// Las "notas extra" se guardan en prompts/products.json y se inyectan SOLO al
// system prompt de Zorbot, sin tocar Shopify.

// Las extras de productos también se editan desde el panel → van al volumen.
const PRODUCTS_EXTRAS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'products.json');

function loadProductExtras(){
  try {
    if (!existsSync(PRODUCTS_EXTRAS_FILE)) return { version: 1, items: {} };
    const raw = readFileSync(PRODUCTS_EXTRAS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.items || typeof parsed.items !== 'object') return { version: 1, items: {} };
    return parsed;
  } catch (e) {
    console.warn('product extras load:', e.message);
    return { version: 1, items: {} };
  }
}
function saveProductExtras(data){
  writeFileSync(PRODUCTS_EXTRAS_FILE, JSON.stringify(data, null, 2));
}
function brandFromProduct(p){
  const v = String(p.vendor || '').toLowerCase();
  const t = String(p.title  || '').toLowerCase();
  const tags = (p.tags || []).map(x => String(x).toLowerCase());
  if (v.includes('kairos')   || tags.includes('kairos')   || t.includes('kairos'))   return 'kairos';
  if (v.includes('firulais') || tags.includes('firulais') || t.includes('firulais')) return 'firulais';
  if (v.includes('banny')    || tags.includes('banny')    || t.includes('banny'))    return 'banny';
  return 'otros';
}

app.get('/admin/products', requireAdmin, async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify no está conectado (falta SHOPIFY_ADMIN_TOKEN).' });
  }
  // Sección: minorista = solo productos con tag ZORBO; mayorista = solo MAYORISTA.
  // Default minorista (lo que ve el público en la home).
  const section = String(req.query.section || 'minorista').toLowerCase();
  const requiredTag = section === 'mayorista' ? 'MAYORISTA' : 'ZORBO';
  try {
    const all = await loadProductsCache(false);
    if (!all) return res.json({ products: [], section, requiredTag });
    const extras = loadProductExtras();
    const products = all
      .filter(p => (p.tags || []).map(t => String(t).trim().toUpperCase()).includes(requiredTag))
      .map(p => {
        const ex = extras.items[String(p.id)] || null;
        const tagsUpper = (p.tags || []).map(t => String(t).toUpperCase());
        const isMayorista = tagsUpper.includes('MAYORISTA');
        const isZorbo     = tagsUpper.includes('ZORBO');
        return {
          id:         String(p.id),
          title:      p.title,
          handle:     p.handle,
          vendor:     p.vendor,
          brand:      brandFromProduct(p),
          image:      ex?.image || p.image || null,
          video:      ex?.video || null,
          price:      p.variants?.[0]?.price ? Number(p.variants[0].price) : null,
          compareAt:  p.variants?.[0]?.compareAtPrice ? Number(p.variants[0].compareAtPrice) : null,
          variants:   (p.variants || []).length,
          isMayorista, isZorbo,
          extra:      ex?.extra || '',
          hasExtra:   !!(ex && (ex.extra && ex.extra.trim() || ex.video)),
          updatedAt:  ex?.updatedAt || null,
        };
      });
    res.json({ section, requiredTag, products });
  } catch (e) {
    res.status(500).json({ error: 'Error cargando productos: ' + e.message });
  }
});

app.post('/admin/products/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id).trim();
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const { extra = '', image = '', video = '' } = req.body || {};
  if (typeof extra !== 'string' || typeof image !== 'string' || typeof video !== 'string') {
    return res.status(400).json({ error: 'Tipos inválidos.' });
  }
  if (extra.length > 50000) return res.status(413).json({ error: 'Texto extra demasiado largo.' });
  if (image.length > 1000)  return res.status(413).json({ error: 'URL de imagen demasiado larga.' });
  if (video.length > 1000)  return res.status(413).json({ error: 'URL de video demasiado larga.' });
  try {
    const data = loadProductExtras();
    const trimmedExtra = extra.trim();
    const trimmedImage = image.trim();
    const trimmedVideo = video.trim();
    if (!trimmedExtra && !trimmedImage && !trimmedVideo) {
      delete data.items[id];
    } else {
      data.items[id] = {
        extra: trimmedExtra,
        ...(trimmedImage ? { image: trimmedImage } : {}),
        ...(trimmedVideo ? { video: trimmedVideo } : {}),
        updatedAt: new Date().toISOString(),
      };
    }
    saveProductExtras(data);
    res.json({ ok: true, id, hasExtra: !!(trimmedExtra || trimmedVideo) });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando: ' + e.message });
  }
});

// ─── Conversaciones (embudo) ────────────────────────────────────────────────
// Listado y detalle de las sesiones de chat ya persistidas en CONV_LOG. El
// listado va liviano (resumen + primer/último mensaje); el detalle trae la
// transcripción completa.

function convPreviewText(messages, role){
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (m.role !== role) continue;
    const t = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

function summarizeConversation(c){
  const messages = Array.isArray(c.messages) ? c.messages : [];
  const userMsgCount = messages.filter(m => m.role === 'user').length;
  const botMsgCount  = messages.filter(m => m.role === 'assistant').length;
  const lastTs = messages.length ? (messages[messages.length-1].timestamp || c.endTime) : c.endTime;
  return {
    sessionId:       c.sessionId,
    startTime:       c.startTime || null,
    endTime:         c.endTime   || null,
    lastActivity:    lastTs      || c.endTime || c.startTime || null,
    from:            c.from || 'zorbot',
    isB2B:           !!c.isB2B,
    purchaseIntent:  !!c.purchaseIntent,
    topBrand:        effectiveTopBrand(c),
    duration:        Number(c.duration) || 0,
    products:        Array.isArray(c.recommendedProducts) ? c.recommendedProducts : [],
    msgCount:        messages.length,
    userMsgCount, botMsgCount,
    firstUserMsg:    convPreviewText(messages, 'user').slice(0, 240),
    lastBotMsg:      [...messages].reverse().find(m => m.role === 'assistant')
                       ? String([...messages].reverse().find(m => m.role === 'assistant').content || '').replace(/\s+/g,' ').trim().slice(0, 240)
                       : '',
  };
}

function brandKey(label){
  const s = String(label || '').toLowerCase();
  if (s.includes('kairos'))   return 'kairos';
  if (s.includes('firulais')) return 'firulais';
  if (s.includes('banny'))    return 'banny';
  return null;
}

app.get('/admin/conversations', requireAdmin, (req, res) => {
  try {
    const all = readLog(CONV_LOG);
    if (!Array.isArray(all)) return res.json({ total: 0, stats: {}, items: [] });

    // Filtros (todos opcionales)
    const fBrand  = String(req.query.brand  || 'all').toLowerCase(); // all | kairos | firulais | banny
    const fMode   = String(req.query.mode   || 'all').toLowerCase(); // all | b2c | b2b
    const fIntent = String(req.query.intent || 'all').toLowerCase(); // all | yes
    const fFrom   = req.query.from ? new Date(req.query.from).getTime() : null;
    const fTo     = req.query.to   ? new Date(req.query.to).getTime()   : null;
    const fQ      = String(req.query.q || '').trim().toLowerCase();
    const limit   = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10) || 200));

    // Stats sobre TODA la base (no afectadas por filtros), más útiles que sobre el subset
    const stats = {
      total:        all.length,
      withIntent:   all.filter(c => !!c.purchaseIntent).length,
      b2c:          all.filter(c => !c.isB2B).length,
      b2b:          all.filter(c => !!c.isB2B).length,
      last24h:      all.filter(c => {
        const t = new Date(c.endTime || c.startTime || 0).getTime();
        return t && (Date.now() - t < 24 * 60 * 60 * 1000);
      }).length,
      withProducts: all.filter(c => Array.isArray(c.recommendedProducts) && c.recommendedProducts.length).length,
    };

    let items = all.map(summarizeConversation);

    if (fBrand !== 'all') {
      if (fBrand === 'mixto')   items = items.filter(c => c.topBrand === 'Mixto');
      else if (fBrand === 'none') items = items.filter(c => !c.topBrand);
      else items = items.filter(c => brandKey(c.topBrand) === fBrand);
    }
    if (fMode === 'b2c')  items = items.filter(c => !c.isB2B);
    if (fMode === 'b2b')  items = items.filter(c =>  c.isB2B);
    if (fIntent === 'yes') items = items.filter(c => c.purchaseIntent);
    if (fFrom)   items = items.filter(c => {
      const t = new Date(c.lastActivity || c.startTime || 0).getTime();
      return t && t >= fFrom;
    });
    if (fTo)     items = items.filter(c => {
      const t = new Date(c.lastActivity || c.startTime || 0).getTime();
      return t && t <= fTo;
    });
    if (fQ)      items = items.filter(c =>
      (c.firstUserMsg || '').toLowerCase().includes(fQ) ||
      (c.lastBotMsg   || '').toLowerCase().includes(fQ) ||
      (c.sessionId    || '').toLowerCase().includes(fQ) ||
      (c.products || []).some(p => String(p).toLowerCase().includes(fQ))
    );

    // Ordenar por última actividad descendente
    items.sort((a, b) => {
      const ta = new Date(a.lastActivity || a.startTime || 0).getTime();
      const tb = new Date(b.lastActivity || b.startTime || 0).getTime();
      return tb - ta;
    });

    const filteredCount = items.length;
    items = items.slice(0, limit);

    res.json({ total: filteredCount, stats, items });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo conversaciones: ' + e.message });
  }
});

app.get('/admin/conversations/:id', requireAdmin, (req, res) => {
  try {
    const all = readLog(CONV_LOG);
    if (!Array.isArray(all)) return res.status(404).json({ error: 'No hay conversaciones.' });
    const c = all.find(e => e.sessionId === req.params.id);
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada.' });
    const feedback = loadFeedback().filter(f => f.sessionId === c.sessionId);
    res.json({ conversation: c, summary: summarizeConversation(c), feedback });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo conversación: ' + e.message });
  }
});

app.delete('/admin/conversations/:id', requireAdmin, (req, res) => {
  try {
    const all = readLog(CONV_LOG);
    if (!Array.isArray(all)) return res.status(404).json({ error: 'No hay conversaciones.' });
    const idx = all.findIndex(e => e.sessionId === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Conversación no encontrada.' });
    all.splice(idx, 1);
    writeFileSync(CONV_LOG, JSON.stringify(all, null, 2));
    // También limpiamos la sesión activa en memoria si existe
    sessions.delete(req.params.id);
    res.json({ ok: true, total: all.length });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando: ' + e.message });
  }
});

// ─── Feedback (entrenamiento por few-shot) ──────────────────────────────────
// Cada entrada es una corrección "respuesta incorrecta → respuesta correcta"
// guardada por el equipo desde el panel. Las últimas FEEDBACK_INJECT entradas
// se inyectan al system prompt de Zorbot como ejemplos, así el bot ajusta
// sus respuestas sin tener que tocar los .md de marca a mano.

const FEEDBACK_FILE = join(LOGS_DIR, 'feedback.json');
const FEEDBACK_INJECT = 20;

function loadFeedback(){
  try {
    if (!existsSync(FEEDBACK_FILE)) return [];
    const raw = readFileSync(FEEDBACK_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('feedback load:', e.message);
    return [];
  }
}
function saveFeedback(arr){
  writeFileSync(FEEDBACK_FILE, JSON.stringify(arr, null, 2));
}

app.get('/admin/feedback', requireAdmin, (_req, res) => {
  const all = loadFeedback();
  res.json({ total: all.length, items: all.slice(-200).reverse() });
});

app.post('/admin/feedback', requireAdmin, (req, res) => {
  const { sessionId, messageIndex, original, improved, explanation } = req.body || {};
  if (typeof original !== 'string' || typeof improved !== 'string') {
    return res.status(400).json({ error: 'Faltan original e improved.' });
  }
  const o = original.trim(), i = improved.trim(), e = (explanation || '').trim();
  if (!o) return res.status(400).json({ error: 'El mensaje original está vacío.' });
  if (!i && !e) return res.status(400).json({ error: 'Necesito al menos un mensaje mejorado o una explicación.' });
  if (i === o && !e) return res.status(400).json({ error: 'El mensaje mejorado es idéntico al original. Agregá una explicación o cambialo.' });
  if (o.length > 8000 || i.length > 8000 || e.length > 4000) {
    return res.status(413).json({ error: 'Texto demasiado largo.' });
  }
  const entry = {
    id:           randomUUID(),
    sessionId:    typeof sessionId === 'string' ? sessionId : null,
    messageIndex: Number.isInteger(messageIndex) ? messageIndex : null,
    original:     o,
    improved:     i || o,
    explanation:  e,
    createdAt:    new Date().toISOString(),
  };
  const all = loadFeedback();
  all.push(entry);
  saveFeedback(all);
  res.json({ ok: true, id: entry.id, total: all.length });
});

app.put('/admin/feedback/:id', requireAdmin, (req, res) => {
  const all = loadFeedback();
  const idx = all.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado.' });
  const { original, improved, explanation } = req.body || {};
  if (typeof original !== 'string' || typeof improved !== 'string') {
    return res.status(400).json({ error: 'Faltan original e improved.' });
  }
  const o = original.trim(), i = improved.trim(), e = (explanation || '').trim();
  if (!o) return res.status(400).json({ error: 'El mensaje original está vacío.' });
  if (!i && !e) return res.status(400).json({ error: 'Necesito al menos un mensaje mejorado o una explicación.' });
  if (i === o && !e) return res.status(400).json({ error: 'El mensaje mejorado es idéntico al original. Agregá una explicación o cambialo.' });
  if (o.length > 8000 || i.length > 8000 || e.length > 4000) {
    return res.status(413).json({ error: 'Texto demasiado largo.' });
  }
  all[idx] = {
    ...all[idx],
    original: o,
    improved: i || o,
    explanation: e,
    updatedAt: new Date().toISOString(),
  };
  saveFeedback(all);
  res.json({ ok: true, id: all[idx].id, entry: all[idx] });
});

app.delete('/admin/feedback/:id', requireAdmin, (req, res) => {
  const all = loadFeedback();
  const idx = all.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado.' });
  all.splice(idx, 1);
  saveFeedback(all);
  res.json({ ok: true, total: all.length });
});

// ─── Tutoriales / videos técnicos ──────────────────────────────────────────
// Biblioteca editable de videos que el bot conoce: cuando una pregunta del
// usuario matchea las keywords de un tutorial, Zorbot incluye el link en la
// respuesta. Hay 2 scopes: 'mayorista' (solo B2B — conexión de barriles,
// CO2, limpieza, etc.) y 'general' (ambos — degustaciones, catas, etc.).

const TUTORIALS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'tutoriales.json');

function loadTutorials(){
  try {
    if (!existsSync(TUTORIALS_FILE)) return [];
    const raw = readFileSync(TUTORIALS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { console.warn('tutorials load:', e.message); return []; }
}
function saveTutorials(arr){
  writeFileSync(TUTORIALS_FILE, JSON.stringify(arr, null, 2));
}

app.get('/admin/tutoriales', requireAdmin, (_req, res) => {
  const all = loadTutorials();
  res.json({ total: all.length, items: all });
});

function validateTutorialBody(body){
  const { title, videoUrl, keywords, description, scope } = body || {};
  if (typeof title !== 'string' || !title.trim()) return { error: 'Falta el título.' };
  if (typeof videoUrl !== 'string' || !videoUrl.trim()) return { error: 'Falta el video URL.' };
  if (title.length > 200)        return { error: 'Título demasiado largo.' };
  if (videoUrl.length > 1000)    return { error: 'URL demasiado larga.' };
  if (description && typeof description !== 'string') return { error: 'Descripción inválida.' };
  if (description && description.length > 4000) return { error: 'Descripción demasiado larga.' };
  if (keywords && typeof keywords !== 'string') return { error: 'Keywords inválidas.' };
  if (keywords && keywords.length > 1000) return { error: 'Keywords demasiado largas.' };
  const validScope = scope === 'mayorista' || scope === 'general';
  if (!validScope) return { error: "Scope debe ser 'mayorista' o 'general'." };
  return null;
}

app.post('/admin/tutoriales', requireAdmin, (req, res) => {
  const err = validateTutorialBody(req.body);
  if (err) return res.status(400).json(err);
  const all = loadTutorials();
  const entry = {
    id:          randomUUID(),
    title:       req.body.title.trim(),
    videoUrl:    req.body.videoUrl.trim(),
    keywords:    (req.body.keywords || '').trim(),
    description: (req.body.description || '').trim(),
    scope:       req.body.scope,
    createdAt:   new Date().toISOString(),
  };
  all.push(entry);
  saveTutorials(all);
  res.json({ ok: true, id: entry.id, entry, total: all.length });
});

app.put('/admin/tutoriales/:id', requireAdmin, (req, res) => {
  const err = validateTutorialBody(req.body);
  if (err) return res.status(400).json(err);
  const all = loadTutorials();
  const idx = all.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Tutorial no encontrado.' });
  all[idx] = {
    ...all[idx],
    title:       req.body.title.trim(),
    videoUrl:    req.body.videoUrl.trim(),
    keywords:    (req.body.keywords || '').trim(),
    description: (req.body.description || '').trim(),
    scope:       req.body.scope,
    updatedAt:   new Date().toISOString(),
  };
  saveTutorials(all);
  res.json({ ok: true, id: all[idx].id, entry: all[idx] });
});

app.delete('/admin/tutoriales/:id', requireAdmin, (req, res) => {
  const all = loadTutorials();
  const idx = all.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado.' });
  all.splice(idx, 1);
  saveTutorials(all);
  res.json({ ok: true, total: all.length });
});

// ─── Analítica (dashboard interno) ──────────────────────────────────────────
// Lee logs/conversations.json + cache Shopify y devuelve métricas para el tab
// "Analítica" del panel. Todo calculado on-the-fly — el dataset es chico.

function rangeFor(rangeId){
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0,0,0,0);
  if (rangeId === 'today') return { id:'today', label:'hoy',                 from: dayStart.getTime(), to: now };
  if (rangeId === '7d')    return { id:'7d',    label:'últimos 7 días',      from: now - 7*86400e3,  to: now };
  if (rangeId === '30d')   return { id:'30d',   label:'últimos 30 días',     from: now - 30*86400e3, to: now };
  return                          { id:'all',   label:'todo el histórico',   from: 0, to: now };
}

const ANALYTICS_TOPICS = [
  { id:'asado',     label:'asado / parrilla',   rx: /\b(asado|parrilla|parril|costill|carnes?)\b/i },
  { id:'regalo',    label:'regalo',             rx: /\b(regalo|present|cumple|aniversario)\b/i },
  { id:'verano',    label:'verano / patio',     rx: /\b(verano|piscina|playa|patio|terraza)\b/i },
  { id:'previa',    label:'previa / carrete',   rx: /\b(previa|carrete|juntad?a|reuni[oó]n)\b/i },
  { id:'sin_alc',   label:'sin alcohol',        rx: /sin\s+alcoh|0[\s.]*0|cero\s+alcoh/i },
  { id:'precio',    label:'precio',             rx: /\b(precio|cu[aá]nto\s+(cuesta|sale|vale|es)|valor|barat[oa]|car[oa])\b/i },
  { id:'pack',      label:'packs / cajas',      rx: /\b(pack|6[\s-]*pack|12[\s-]*pack|24[\s-]*pack|caja|cajas)\b/i },
  { id:'maridaje',  label:'maridaje / con qué', rx: /\b(marida|acompa[ñn]|combina|va\s+bien|que\s+tomar\s+con)/i },
  { id:'envio',     label:'envío / despacho',   rx: /\b(env[ií]o|despacho|domicilio|retir[oa]|llega(r|me|n)?)\b/i },
  { id:'recomenda', label:'recomendación',      rx: /\b(recomien|recomenda|sugier|sugerencia|qu[eé]\s+me\s+recomienda)/i },
  { id:'cerveza',   label:'cervezas en general',rx: /\b(cerveza|cheve|chela|chelita|chop|schop)\b/i },
  { id:'chelada',   label:'cheladas',           rx: /\b(chelada|cheladas)\b/i },
  { id:'gin',       label:'gin / cócteles',     rx: /\b(gin|tonic|c[oó]ctel|coctel|mojito|negroni|c[ií]tric)\b/i },
  { id:'whisky',    label:'whisky',             rx: /\b(whisk(e)?y|whisky|bourbon)\b/i },
  { id:'mayorista', label:'mayorista / B2B',    rx: /\b(mayorista|por\s+volumen|por\s+mayor|botiller[ií]a|restaurant?e|bar\s+|local|barril)\b/i },
];

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const r = rangeFor(String(req.query.range || '30d'));
    const all = Array.isArray(readLog(CONV_LOG)) ? readLog(CONV_LOG) : [];

    const tOf = c => new Date(c.endTime || c.startTime || 0).getTime();
    const subset = all.filter(c => {
      const t = tOf(c);
      return t >= r.from && t <= r.to;
    });

    // Globales (no afectados por rango — sirven para los chips de cabecera)
    const now = Date.now();
    const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
    const counts = {
      all:    all.length,
      today:  all.filter(c => tOf(c) >= startOfToday.getTime()).length,
      last7:  all.filter(c => now - tOf(c) <= 7*86400e3).length,
      last30: all.filter(c => now - tOf(c) <= 30*86400e3).length,
    };

    const withIntent   = subset.filter(c => c.purchaseIntent).length;
    const withProducts = subset.filter(c => Array.isArray(c.recommendedProducts) && c.recommendedProducts.length).length;
    const b2c = subset.filter(c => !c.isB2B).length;
    const b2b = subset.filter(c =>  c.isB2B).length;
    const intentRate = subset.length ? Math.round(withIntent / subset.length * 1000) / 10 : 0;
    const totalMessages = subset.reduce((s,c) => s + (Array.isArray(c.messages) ? c.messages.length : 0), 0);
    const avgMessages = subset.length ? Math.round(totalMessages / subset.length * 10) / 10 : 0;
    const totalDuration = subset.reduce((s,c) => s + (Number(c.duration) || 0), 0);
    const avgDuration = subset.length ? Math.round(totalDuration / subset.length) : 0;

    // Distribución por marca: recomputo topBrand desde los mensajes para que
    // las conversaciones viejas (con topBrand mal calculado) queden bien.
    // 5 buckets posibles: las 3 marcas + "Mixto" (varias marcas con peso
    // parejo) + "Sin marca" (ninguna marca mencionada).
    const brandCounts = { 'Kairos Brewing':0, 'Firulais':0, 'Banny':0, 'Mixto':0, 'Sin marca':0 };
    for (const c of subset) {
      const b = effectiveTopBrand(c);
      if (b === 'Mixto')                      brandCounts['Mixto']++;
      else if (b && brandCounts[b] != null)   brandCounts[b]++;
      else                                    brandCounts['Sin marca']++;
    }
    const brandTotal = Object.values(brandCounts).reduce((a,b)=>a+b,0);
    const brandDistribution = Object.entries(brandCounts)
      .map(([brand,count]) => ({ brand, count, pct: brandTotal ? Math.round(count/brandTotal*1000)/10 : 0 }))
      .filter(b => b.count > 0)
      .sort((a,b) => b.count - a.count);
    // "Marca top" para el stat card: solo si una de las 3 marcas reales
    // domina; si es Mixto o Sin marca el ganador, lo mostramos como tal.
    const topBrand = brandDistribution[0]?.count ? brandDistribution[0].brand : '—';

    // Distribución por origen (from)
    const fromMap = {};
    for (const c of subset) {
      const k = c.from || 'zorbot';
      fromMap[k] = (fromMap[k] || 0) + 1;
    }
    const fromDistribution = Object.entries(fromMap)
      .map(([from,count]) => ({ from, count }))
      .sort((a,b) => b.count - a.count);

    // Serie diaria: cubre todo el rango con días vacíos = 0
    const days = Math.min(120, Math.max(1, Math.ceil((r.to - r.from) / 86400e3)));
    const byDayMap = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(r.to - i * 86400e3);
      d.setHours(0,0,0,0);
      byDayMap.set(d.toISOString().slice(0,10), { date: d.toISOString().slice(0,10), total: 0, withIntent: 0 });
    }
    for (const c of subset) {
      const t = new Date(tOf(c));
      if (!isFinite(t)) continue;
      const key = t.toISOString().slice(0,10);
      if (!byDayMap.has(key)) byDayMap.set(key, { date: key, total: 0, withIntent: 0 });
      const e = byDayMap.get(key);
      e.total++;
      if (c.purchaseIntent) e.withIntent++;
    }
    const byDay = [...byDayMap.values()].sort((a,b) => a.date.localeCompare(b.date));

    // Top productos recomendados por Zorbot
    const prodCounts = new Map();
    for (const c of subset) {
      for (const p of (c.recommendedProducts || [])) {
        if (!p) continue;
        prodCounts.set(p, (prodCounts.get(p) || 0) + 1);
      }
    }
    const topProducts = [...prodCounts.entries()]
      .map(([name,count]) => ({ name, count }))
      .sort((a,b) => b.count - a.count)
      .slice(0, 10);

    // Distribución por hora / día de la semana (en el rango)
    const hourly  = Array.from({length:24}, (_,h) => ({ hour: h,  count: 0 }));
    const weekday = Array.from({length:7},  (_,d) => ({ day:  d,  count: 0 }));
    for (const c of subset) {
      const t = new Date(c.startTime || c.endTime || 0);
      if (!isFinite(t)) continue;
      hourly[t.getHours()].count++;
      weekday[t.getDay()].count++;
    }

    // Topics: matchea regex sobre primer mensaje del usuario
    const topicMap = ANALYTICS_TOPICS.map(t => ({ ...t, count: 0, samples: [] }));
    for (const c of subset) {
      const firstUser = (c.messages || []).find(m => m.role === 'user');
      const txt = String(firstUser?.content || '');
      if (!txt) continue;
      for (const t of topicMap) {
        if (t.rx.test(txt)) {
          t.count++;
          if (t.samples.length < 3) t.samples.push(txt.replace(/\s+/g,' ').trim().slice(0,140));
        }
      }
    }
    const topics = topicMap
      .filter(t => t.count > 0)
      .map(({ id, label, count, samples }) => ({ id, label, count, samples }))
      .sort((a,b) => b.count - a.count);

    // Oportunidades: productos preguntados por usuarios pero poco recomendados
    let underutilized = [];
    try {
      const cache = await loadProductsCache(false);
      if (Array.isArray(cache)) {
        const products = cache
          .map(p => ({ id: String(p.id), title: String(p.title || '').trim() }))
          .filter(p => p.title.length > 3);
        const askMap = new Map();
        for (const c of subset) {
          for (const m of (c.messages || [])) {
            if (m.role !== 'user') continue;
            const txt = String(m.content || '').toLowerCase();
            if (!txt) continue;
            for (const p of products) {
              const needle = p.title.toLowerCase();
              if (needle.length > 3 && txt.includes(needle)) {
                askMap.set(p.title, (askMap.get(p.title) || 0) + 1);
              }
            }
          }
        }
        underutilized = [...askMap.entries()]
          .map(([name, asked]) => {
            const rec = prodCounts.get(name) || 0;
            return { name, asked, recommended: rec, gap: asked - rec };
          })
          .filter(x => x.asked >= 2 && x.gap >= 1)
          .sort((a,b) => b.gap - a.gap)
          .slice(0, 8);
      }
    } catch (e) { /* opcional, ignorar */ }

    res.json({
      range: r,
      counts,
      totals: {
        conversations: subset.length,
        withIntent, withProducts, b2c, b2b,
        intentRate, avgMessages, avgDuration, topBrand,
      },
      byDay,
      topProducts,
      brandDistribution,
      fromDistribution,
      hourly, weekday,
      topics,
      underutilized,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error generando analítica: ' + e.message });
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

initLogs();

// ─── POST /chat ───────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message, sessionId: clientId } = req.body;
  const from      = req.body.from || req.query.from;
  const mayorista = req.body.mayorista === true;

  if (!message) return res.status(400).json({ error: 'El campo "message" es requerido.' });

  // Carga el system prompt en cada request — así editar cualquier archivo
  // de /prompts se refleja en la siguiente conversación sin reiniciar.
  // - B2B (mayorista): un solo archivo (mayorista.md).
  // - B2C: combinamos general.md + las 3 marcas (kairos, firulais, banny).
  let promptBase;
  try {
    if (mayorista) {
      promptBase = readPromptFile('mayorista.md');
    } else {
      promptBase = [
        readPromptFile('general.md'),
        readPromptFile('kairos.md'),
        readPromptFile('firulais.md'),
        readPromptFile('banny.md'),
      ].join('\n\n---\n\n');
    }
  } catch (e) {
    console.error('prompt load:', e.message);
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
  if (mayorista) session.isB2B = true;
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
    // Marca para que el frontend auto-abra el carrito tras esta respuesta.
    res.write(`data: ${JSON.stringify({ action: 'openCart' })}\n\n`);
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
          .map(p => ({ id: String(p.id), title: p.title, type: p.type, vendor: p.vendor }));
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
