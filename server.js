import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

app.use(cors());
app.use(express.json({ limit: '12mb' })); // 12mb para permitir uploads base64 (PDF/imagen) desde el admin

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
// Archivos subidos desde el admin (PDF/imágenes de producto). En el volumen
// si DATA_DIR está seteado; servidos en /uploads.
const UPLOADS_DIR = DATA_DIR ? join(DATA_DIR, 'uploads') : join(__dirname, 'public', 'uploads');

function initLogs() {
  if (!existsSync(LOGS_DIR))   mkdirSync(LOGS_DIR, { recursive: true });
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
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
        const files = Array.isArray(e.files) ? e.files : [];
        if (!note && !video && !files.length) continue;
        let block = `### ${p.title}\n${note}`;
        if (video) block += `${note ? '\n' : ''}VIDEO del producto: ${video} (compártelo cuando el cliente quiera ver más).`;
        if (files.length) {
          const base = process.env.PUBLIC_BASE_URL || '';
          const fileLines = files.map(f => `${f.type === 'pdf' ? 'PDF' : 'Imagen'} "${f.name}": ${base}${f.url}`).join('\n');
          block += `${(note||video) ? '\n' : ''}ARCHIVOS/FICHAS del producto (compártelos cuando el cliente pida ficha técnica, especificaciones o más info):\n${fileLines}`;
        }
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
    // Solo inyectamos tutoriales CON videoUrl. Los que están sin link son
    // placeholders pendientes de grabar — no los menciona el bot.
    const filtered = all.filter(t => t.videoUrl && t.videoUrl.trim() && (session.isB2B || t.scope === 'general'));
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
const SHOPIFY_SCOPES = 'read_products,write_products,read_inventory,read_locations,read_customers,write_customers,read_orders';
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
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || '').trim();
  const token = (process.env.SHOPIFY_ADMIN_TOKEN || '').trim();
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
    // El público SOLO ve productos activos (los borradores quedan ocultos).
    if (String(p.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
    const isB2B = isMayoristaProduct(p);
    if (mode === 'b2b') return isB2B;
    if (mode === 'b2c') return !isB2B;
    return true; // mode === 'all'
  });
}

const PRODUCTS_QUERY = `query($cursor: String) {
  products(first: 100, after: $cursor, query: "status:active OR status:draft") {
    edges {
      cursor
      node {
        id title handle description productType vendor tags status
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
    pageInfo { hasNextPage }
  }
}`;

const stripGid = (gid, kind) => String(gid || '').replace(`gid://shopify/${kind}/`, '');

// Carga TODOS los productos desde Shopify (paginado) y los cachea. Reutilizable
// desde /api/products y desde /chat (para alimentar el catálogo del bot).
async function loadProductsCache(force = false){
  if (!force && productsCache && Date.now() - productsCacheAt < PRODUCTS_TTL_MS) {
    return productsCache.products;
  }
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return null;
  const products = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) { // hasta 2000 productos
    const resp = await shopifyAdminFetch('/graphql.json', {
      method: 'POST',
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
    });
    if (resp.errors) throw new Error(JSON.stringify(resp.errors));
    const conn = resp.data.products;
    for (const { node: p } of conn.edges) {
      products.push({
        id:          stripGid(p.id, 'Product'),
        handle:      p.handle,
        title:       p.title,
        description: p.description,
        type:        p.productType,
        vendor:      p.vendor,
        tags:        p.tags,
        status:      p.status || 'ACTIVE',
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
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
  }
  productsCache = { products, fetchedAt: new Date().toISOString() };
  productsCacheAt = Date.now();
  return products;
}

// ─── Órdenes Shopify (para analítica de ventas) ─────────────────────────────
// Requiere el scope read_orders. Si el token no lo tiene, Shopify responde
// 401/403 y devolvemos { available:false } para que el panel muestre estado
// vacío con instrucciones, sin romper.
let ordersCache = null;
let ordersCacheAt = 0;
const ORDERS_TTL_MS = 10 * 60 * 1000;

const ORDERS_QUERY = `query($cursor: String) {
  orders(first: 100, after: $cursor, query: "status:any", sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        name
        createdAt
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount } }
        customer { id email }
        lineItems(first: 50) {
          edges { node {
            quantity
            originalTotalSet { shopMoney { amount } }
            product { id title vendor tags }
          } }
        }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

// Carga hasta ~maxOrders órdenes recientes. Devuelve { available, orders, reason }.
async function loadOrders(force = false){
  if (!force && ordersCache && Date.now() - ordersCacheAt < ORDERS_TTL_MS) {
    return { available: true, orders: ordersCache };
  }
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return { available: false, reason: 'Shopify no conectado (falta SHOPIFY_ADMIN_TOKEN).' };
  }
  try {
    const orders = [];
    let cursor = null;
    for (let page = 0; page < 12; page++) { // hasta ~1200 órdenes
      const resp = await shopifyAdminFetch('/graphql.json', {
        method: 'POST',
        body: JSON.stringify({ query: ORDERS_QUERY, variables: { cursor } }),
      });
      if (resp.errors) {
        const msg = JSON.stringify(resp.errors);
        if (/access denied|read_orders|not approved|scope/i.test(msg)) {
          return { available: false, reason: 'El token de Shopify no tiene el permiso read_orders. Hay que re-autorizar la app.' };
        }
        throw new Error(msg);
      }
      const conn = resp.data.orders;
      for (const e of conn.edges) {
        const n = e.node;
        orders.push({
          id: stripGid(n.id, 'Order'),
          name: n.name || null,
          createdAt: n.createdAt,
          status: n.displayFulfillmentStatus || null,
          total: parseFloat(n.currentTotalPriceSet?.shopMoney?.amount || 0),
          customerId: n.customer ? stripGid(n.customer.id, 'Customer') : null,
          customerEmail: n.customer?.email || null,
          lineItems: (n.lineItems?.edges || []).map(le => ({
            qty: le.node.quantity,
            amount: parseFloat(le.node.originalTotalSet?.shopMoney?.amount || 0),
            productId: le.node.product ? stripGid(le.node.product.id, 'Product') : null,
            title: le.node.product?.title || '(producto eliminado)',
            vendor: le.node.product?.vendor || '',
            tags: le.node.product?.tags || [],
          })),
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.edges[conn.edges.length - 1].cursor;
    }
    ordersCache = orders;
    ordersCacheAt = Date.now();
    return { available: true, orders };
  } catch (e) {
    const msg = String(e.message || e);
    if (/\b40[13]\b|access denied|read_orders|scope/i.test(msg)) {
      return { available: false, reason: 'El token de Shopify no tiene el permiso read_orders. Hay que re-autorizar la app.' };
    }
    return { available: false, reason: 'Error consultando órdenes: ' + msg.slice(0, 200) };
  }
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
// Archivos subidos (PDF/imágenes de producto). Cuando DATA_DIR está seteado
// viven en el volumen, así que necesitan su propia ruta estática.
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

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
          status:     String(p.status || 'ACTIVE').toUpperCase(),
          image:      ex?.image || p.image || null,
          video:      ex?.video || null,
          price:      p.variants?.[0]?.price ? Number(p.variants[0].price) : null,
          compareAt:  p.variants?.[0]?.compareAtPrice ? Number(p.variants[0].compareAtPrice) : null,
          variants:   (p.variants || []).length,
          isMayorista, isZorbo,
          extra:      ex?.extra || '',
          files:      Array.isArray(ex?.files) ? ex.files : [],
          hasExtra:   !!(ex && (ex.extra && ex.extra.trim() || ex.video || (ex.files && ex.files.length))),
          updatedAt:  ex?.updatedAt || null,
        };
      });
    res.json({ section, requiredTag, products });
  } catch (e) {
    res.status(500).json({ error: 'Error cargando productos: ' + e.message });
  }
});

// Cambiar estado activo/borrador de un producto existente en Shopify.
app.put('/admin/products/:id/status', requireAdmin, async (req, res) => {
  const id = String(req.params.id).trim();
  const status = String((req.body || {}).status || '').toLowerCase() === 'draft' ? 'draft' : 'active';
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return res.status(503).json({ error: 'Shopify no conectado.' });
  try {
    await shopifyAdminFetch(`/products/${id}.json`, {
      method: 'PUT', body: JSON.stringify({ product: { id: Number(id), status } }),
    });
    productsCache = null; productsCacheAt = 0;
    res.json({ ok: true, id, status: status.toUpperCase() });
  } catch (e) {
    const msg = String(e.message || e);
    if (/\b40[13]\b|write_products|access denied|scope/i.test(msg)) {
      return res.status(403).json({ error: 'El token no tiene write_products. Re-autorizá la app.' });
    }
    res.status(500).json({ error: 'Error cambiando estado: ' + msg.slice(0,200) });
  }
});

// Crear un producto NUEVO en Shopify desde el panel. B2C → tag ZORBO,
// B2B → tag MAYORISTA. Recibe variantes (6/12/24) y las maquetas en base64.
// Requiere write_products. IMPORTANTE: va ANTES de /:id para que no lo capture.
app.post('/admin/products/create', requireAdmin, async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify no conectado.' });
  }
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Falta el nombre del producto.' });
  const section = String(b.section || 'minorista').toLowerCase();
  const tag = section === 'mayorista' ? 'MAYORISTA' : 'ZORBO';
  const vendor = String(b.vendor || '').trim() || 'Kairos Brewing';
  const productType = String(b.productType || '').trim();
  const extraTags = Array.isArray(b.tags) ? b.tags.map(t => String(t).trim()).filter(Boolean) : [];
  const tags = [tag, ...extraTags].join(', ');

  let variants = Array.isArray(b.variants) ? b.variants
        .filter(v => v && v.title)
        .map(v => ({ option1: String(v.title).trim(), price: String(parseInt(v.price,10) || 0) }))
      : [];
  let options;
  if (variants.length) options = [{ name: 'Cantidad', values: variants.map(v => v.option1) }];
  else { variants = [{ price: String(parseInt(b.price,10) || 0) }]; options = undefined; }

  const images = (Array.isArray(b.images) ? b.images : [])
    .filter(im => im && im.dataBase64)
    .map(im => ({ attachment: String(im.dataBase64), alt: String(im.alt || '').slice(0,120) }));

  const status = String(b.status || 'active').toLowerCase() === 'draft' ? 'draft' : 'active';
  const payload = { product: {
    title, vendor, status, tags,
    ...(productType ? { product_type: productType } : {}),
    ...(options ? { options } : {}),
    variants,
    ...(images.length ? { images } : {}),
  }};

  try {
    const r = await shopifyAdminFetch('/products.json', { method: 'POST', body: JSON.stringify(payload) });
    const product = r.product;
    if (!product) throw new Error('Shopify no devolvió el producto.');
    try {
      if (product.images && product.variants) {
        for (const v of product.variants) {
          const img = product.images.find(im => (im.alt || '').trim() === (v.option1 || '').trim());
          if (img) {
            await shopifyAdminFetch(`/variants/${v.id}.json`, {
              method: 'PUT',
              body: JSON.stringify({ variant: { id: v.id, image_id: img.id } }),
            });
          }
        }
      }
    } catch (e) { console.warn('variant image assoc:', e.message); }
    productsCache = null; productsCacheAt = 0;
    res.json({ ok: true, id: String(product.id), handle: product.handle, title: product.title });
  } catch (e) {
    const msg = String(e.message || e);
    if (/\b40[13]\b|write_products|access denied|not approved|scope/i.test(msg)) {
      return res.status(403).json({ error: 'El token de Shopify no tiene write_products. Re-autorizá la app (/shopify/install) y actualizá SHOPIFY_ADMIN_TOKEN.' });
    }
    res.status(500).json({ error: 'Error creando producto: ' + msg.slice(0, 300) });
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
    // Preservamos los archivos ya subidos (se gestionan en endpoints aparte).
    const existingFiles = Array.isArray(data.items[id]?.files) ? data.items[id].files : [];
    if (!trimmedExtra && !trimmedImage && !trimmedVideo && !existingFiles.length) {
      delete data.items[id];
    } else {
      data.items[id] = {
        extra: trimmedExtra,
        ...(trimmedImage ? { image: trimmedImage } : {}),
        ...(trimmedVideo ? { video: trimmedVideo } : {}),
        ...(existingFiles.length ? { files: existingFiles } : {}),
        updatedAt: new Date().toISOString(),
      };
    }
    saveProductExtras(data);
    res.json({ ok: true, id, hasExtra: !!(trimmedExtra || trimmedVideo || existingFiles.length) });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando: ' + e.message });
  }
});

// Subida de archivo (PDF o imagen) para un producto. El admin manda el archivo
// en base64. Lo guardamos en UPLOADS_DIR y lo agregamos a files[] del producto.
const UPLOAD_TYPES = {
  'application/pdf':  'pdf',
  'image/png':        'png',
  'image/jpeg':       'jpg',
  'image/jpg':        'jpg',
  'image/webp':       'webp',
  'image/gif':        'gif',
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

app.post('/admin/products/:id/upload', requireAdmin, (req, res) => {
  const id = String(req.params.id).trim();
  if (!id) return res.status(400).json({ error: 'Falta id.' });
  const { filename = '', contentType = '', dataBase64 = '' } = req.body || {};
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'Falta el archivo.' });
  }
  const ext = UPLOAD_TYPES[String(contentType).toLowerCase()];
  if (!ext) return res.status(415).json({ error: 'Solo se permiten PDF o imágenes (png, jpg, webp, gif).' });
  let buf;
  try { buf = Buffer.from(dataBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'Archivo inválido.' }); }
  if (!buf.length)              return res.status(400).json({ error: 'Archivo vacío.' });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Máximo 8 MB por archivo.' });
  try {
    const safeName = randomUUID() + '.' + ext;
    writeFileSync(join(UPLOADS_DIR, safeName), buf);
    const fileInfo = {
      url:        '/uploads/' + safeName,
      name:       String(filename || ('archivo.' + ext)).slice(0, 200),
      type:       ext === 'pdf' ? 'pdf' : 'image',
      size:       buf.length,
      uploadedAt: new Date().toISOString(),
    };
    const data = loadProductExtras();
    const item = data.items[id] || { extra: '' };
    item.files = Array.isArray(item.files) ? item.files : [];
    item.files.push(fileInfo);
    item.updatedAt = new Date().toISOString();
    data.items[id] = item;
    saveProductExtras(data);
    res.json({ ok: true, file: fileInfo });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando archivo: ' + e.message });
  }
});

app.delete('/admin/products/:id/file', requireAdmin, (req, res) => {
  const id = String(req.params.id).trim();
  const { url = '' } = req.body || {};
  if (!id || !url) return res.status(400).json({ error: 'Falta id o url.' });
  try {
    const data = loadProductExtras();
    const item = data.items[id];
    if (!item || !Array.isArray(item.files)) return res.status(404).json({ error: 'Sin archivos.' });
    const idx = item.files.findIndex(f => f.url === url);
    if (idx < 0) return res.status(404).json({ error: 'Archivo no encontrado.' });
    const [removed] = item.files.splice(idx, 1);
    // Borrar del disco (solo si la url está dentro de /uploads/ — anti path traversal)
    if (removed && /^\/uploads\/[\w.-]+$/.test(removed.url)) {
      const p = join(UPLOADS_DIR, removed.url.replace('/uploads/', ''));
      try { if (existsSync(p)) unlinkSync(p); } catch {}
    }
    if (!item.files.length) delete item.files;
    if (!item.extra && !item.image && !item.video && !item.files) delete data.items[id];
    else { item.updatedAt = new Date().toISOString(); data.items[id] = item; }
    saveProductExtras(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando archivo: ' + e.message });
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

// ── Etiquetas manuales de conversaciones (gestión del equipo) ──
const CONV_LABELS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'conv-labels.json');
function loadConvLabels(){
  try {
    if (!existsSync(CONV_LABELS_FILE)) return {};
    const p = JSON.parse(readFileSync(CONV_LABELS_FILE, 'utf-8'));
    return (p && typeof p === 'object') ? p : {};
  } catch { return {}; }
}
function saveConvLabels(d){ writeFileSync(CONV_LABELS_FILE, JSON.stringify(d, null, 2)); }
const CONV_VALID_TAGS = ['reclamo','agendamiento','intent','faq','seguimiento'];

// ── Clasificación automática en módulos ──
const CONV_MODULE_RX = {
  reclamo:      /\b(problema|reclamo|queja|no\s+lleg|nunca\s+lleg|lleg[oó]\s+mal|mal\s+estado|en\s+mal|defect|roto|rota|devoluci|reembols|equivoc|cobr[oó]\s+mal|me\s+cobraron|tard[oó]|p[eé]sim|mala\s+atenci|estafa|horrible)\b/i,
  agendamiento: /\b(agendar|agenda|coordina|coordinemos|reuni[oó]n|visita|qu[eé]\s+d[ií]a|qu[eé]\s+hora|nos\s+juntamos|pasar\s+a\s+(dejar|buscar|retirar)|fecha\s+de\s+entrega|cu[aá]ndo\s+(pueden|pasan|vienen)|programar)\b/i,
  faq:          /\b(horario|a\s+qu[eé]\s+hora\s+(abren|cierran)|abren|cierran|d[oó]nde\s+(est[aá]n|queda|retiro)|ubicaci|direcci[oó]n\s+del\s+local|formas?\s+de\s+pago|medios?\s+de\s+pago|hacen\s+env[ií]o|tienen\s+local|c[oó]mo\s+(compro|funciona|pido)|aceptan)\b/i,
};
const CONV_BOT_FALLBACK_RX = /(no\s+tengo\s+esa\s+info|no\s+s[eé]\b|no\s+estoy\s+seguro|no\s+puedo\s+ayudar(te)?\s+con|no\s+manejo\s+esa|disculp[ae].*(problema\s+t[eé]cnico)|tuve\s+un\s+problema\s+t[eé]cnico|intenta\s+de\s+nuevo|no\s+entend[ií]|no\s+s[eé]\s+(c[oó]mo|qu[eé]))/i;

function classifyConversation(c){
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  const userText = msgs.filter(m => m.role === 'user').map(m => m.content || '').join(' \n ');
  const botText  = msgs.filter(m => m.role === 'assistant').map(m => m.content || '').join(' \n ');
  const products = Array.isArray(c.recommendedProducts) ? c.recommendedProducts : [];
  const intentWords = /\b(quiero\s+(comprar|llevar|\d)|me\s+lo\s+llevo|agreg|al\s+carrito|arma\s+el?\s+pedido|p[áa]same\s+el\s+link)\b/i.test(userText);
  return {
    // reclamo y faq se detectan SOLO en lo que dice el usuario (el bot puede
    // decir "tuve un problema técnico" y eso no es un reclamo del cliente).
    reclamo:      CONV_MODULE_RX.reclamo.test(userText),
    agendamiento: CONV_MODULE_RX.agendamiento.test(userText + ' ' + botText),
    faq:          CONV_MODULE_RX.faq.test(userText) && !c.purchaseIntent,
    sinRespuesta: CONV_BOT_FALLBACK_RX.test(botText),
    abandonado:   !c.purchaseIntent && (products.length > 0 || intentWords) && msgs.length >= 2,
  };
}

// Membresía en módulo combinando auto + etiqueta manual.
function inModule(mod, c, flags, manualTags){
  const has = t => manualTags.includes(t);
  switch (mod) {
    case 'todos':        return true;
    case 'intent':       return !!c.purchaseIntent || has('intent');
    case 'reclamos':     return flags.reclamo || has('reclamo');
    case 'sin_respuesta':return flags.sinRespuesta;
    case 'agendamientos':return flags.agendamiento || has('agendamiento');
    case 'abandonados':  return flags.abandonado;
    case 'faq':          return flags.faq || has('faq');
    default:             return true;
  }
}
const CONV_MODULES = ['todos','intent','reclamos','sin_respuesta','agendamientos','abandonados','faq'];

app.get('/admin/conversations', requireAdmin, (req, res) => {
  try {
    const all = readLog(CONV_LOG);
    if (!Array.isArray(all)) return res.json({ total: 0, stats: {}, moduleCounts: {}, items: [] });
    const labels = loadConvLabels();

    const fBrand  = String(req.query.brand  || 'all').toLowerCase();
    const fMode   = String(req.query.mode   || 'b2c').toLowerCase();  // b2c | b2b
    const fModule = String(req.query.module || 'todos').toLowerCase();
    const fFrom   = req.query.from ? new Date(req.query.from).getTime() : null;
    const fTo     = req.query.to   ? new Date(req.query.to).getTime()   : null;
    const fQ      = String(req.query.q || '').trim().toLowerCase();
    const limit   = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10) || 200));

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

    // Enriquecemos cada conversación con summary + flags + label manual
    let enriched = all.map(c => {
      const s = summarizeConversation(c);
      const flags = classifyConversation(c);
      const lab = labels[c.sessionId] || {};
      return { c, s, flags, tags: Array.isArray(lab.tags) ? lab.tags : [], resolved: !!lab.resolved };
    });

    // Filtros base (mode + brand + fecha + búsqueda) — SIN el módulo todavía,
    // para poder contar cada módulo sobre el mismo subset.
    const base = enriched.filter(x => {
      if (fMode === 'b2c' && x.s.isB2B) return false;
      if (fMode === 'b2b' && !x.s.isB2B) return false;
      if (fBrand !== 'all') {
        if (fBrand === 'mixto')      { if (x.s.topBrand !== 'Mixto') return false; }
        else if (fBrand === 'none')  { if (x.s.topBrand) return false; }
        else if (brandKey(x.s.topBrand) !== fBrand) return false;
      }
      const t = new Date(x.s.lastActivity || x.s.startTime || 0).getTime();
      if (fFrom && !(t >= fFrom)) return false;
      if (fTo && !(t <= fTo)) return false;
      if (fQ) {
        const hay = (x.s.firstUserMsg||'').toLowerCase().includes(fQ)
          || (x.s.lastBotMsg||'').toLowerCase().includes(fQ)
          || (x.s.sessionId||'').toLowerCase().includes(fQ)
          || (x.s.products||[]).some(p => String(p).toLowerCase().includes(fQ));
        if (!hay) return false;
      }
      return true;
    });

    // Conteo por módulo sobre el subset base
    const moduleCounts = {};
    for (const m of CONV_MODULES) moduleCounts[m] = base.filter(x => inModule(m, x.c, x.flags, x.tags)).length;

    // Aplicar módulo seleccionado
    let items = base.filter(x => inModule(fModule, x.c, x.flags, x.tags));

    items.sort((a, b) => {
      const ta = new Date(a.s.lastActivity || a.s.startTime || 0).getTime();
      const tb = new Date(b.s.lastActivity || b.s.startTime || 0).getTime();
      return tb - ta;
    });

    const filteredCount = items.length;
    const out = items.slice(0, limit).map(x => ({
      ...x.s,
      flags: x.flags,
      tags: x.tags,
      resolved: x.resolved,
    }));

    res.json({ total: filteredCount, stats, moduleCounts, items: out });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo conversaciones: ' + e.message });
  }
});

// Marcado manual de una conversación (status resuelto + tags de gestión)
app.post('/admin/conversations/:id/label', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const { tags, resolved } = req.body || {};
  if (tags != null && !Array.isArray(tags)) return res.status(400).json({ error: 'tags inválido.' });
  try {
    const data = loadConvLabels();
    const clean = (tags || []).filter(t => CONV_VALID_TAGS.includes(t));
    const entry = { tags: clean, resolved: !!resolved, updatedAt: new Date().toISOString() };
    if (!clean.length && !entry.resolved) delete data[id];
    else data[id] = entry;
    saveConvLabels(data);
    res.json({ ok: true, tags: clean, resolved: entry.resolved });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando etiqueta: ' + e.message });
  }
});

app.get('/admin/conversations/:id', requireAdmin, (req, res) => {
  try {
    const all = readLog(CONV_LOG);
    if (!Array.isArray(all)) return res.status(404).json({ error: 'No hay conversaciones.' });
    const c = all.find(e => e.sessionId === req.params.id);
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada.' });
    const feedback = loadFeedback().filter(f => f.sessionId === c.sessionId);
    const lab = loadConvLabels()[c.sessionId] || {};
    res.json({
      conversation: c,
      summary: summarizeConversation(c),
      flags: classifyConversation(c),
      label: { tags: Array.isArray(lab.tags) ? lab.tags : [], resolved: !!lab.resolved },
      feedback,
    });
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
  if (videoUrl != null && typeof videoUrl !== 'string') return { error: 'URL inválida.' };
  if (title.length > 200)        return { error: 'Título demasiado largo.' };
  if (videoUrl && videoUrl.length > 1000) return { error: 'URL demasiado larga.' };
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
    videoUrl:    (req.body.videoUrl || '').trim(),
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
    videoUrl:    (req.body.videoUrl || '').trim(),
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

// Plantilla de tutoriales: temas que el equipo debería grabar. El admin
// dispara POST /admin/tutoriales/seed y se agregan a la biblioteca sin
// duplicar (matchea por título normalizado contra los ya existentes).
const DEFAULT_TUTORIALS = [
  // ── Mayorista (operación / técnico) ──
  { scope:'mayorista', title:'Pinchado del barril paso a paso',
    description:'Cómo conectar correctamente un barril Kairos (slim 20/30L, válvula tipo G) — temperatura recomendada, reposo tras transporte, presión inicial 14–20 PSI.',
    keywords:'pinchar barril, conectar barril, instalar barril, pinchador, tipo G, válvula barril' },
  { scope:'mayorista', title:'Limpieza alcalina y ácida de schopperas',
    description:'Protocolo obligatorio mensual: alcalina cada 15 días + ácida cada 30 días. Diluciones, tiempos, enjuague y limpieza de grifos y líneas.',
    keywords:'limpieza schoppera, limpieza líneas, alcalina, ácida, sanitizar, lavar máquina' },
  { scope:'mayorista', title:'Diagnóstico de espuma excesiva',
    description:'Causas más comunes: temperatura fuera de rango, presión alta, líneas calientes, grifo sucio, barril movido recién, sistema sin frío adecuado. Checklist de qué revisar.',
    keywords:'mucha espuma, espumosa, espuma, no servir, foaming, exceso espuma' },
  { scope:'mayorista', title:'Cerveza plana / poco gas — qué revisar',
    description:'Diagnóstico cuando la cerveza sale sin carbonatación: presión baja, fuga de CO2, regulador mal calibrado, pérdida de carbonatación.',
    keywords:'cerveza plana, poco gas, sin carbonatación, sin gas, baja presión' },
  { scope:'mayorista', title:'Sale solo gas y no cerveza',
    description:'Posibles causas: barril vacío, conexión incorrecta, acople mal puesto, línea obstruida, error en pinchado.',
    keywords:'sale gas, no sale cerveza, solo espuma, no tira, barril vacío' },
  { scope:'mayorista', title:'No tira cerveza — diagnóstico',
    description:'Cilindro CO2 vacío, llaves cerradas, fuga de presión, barril vacío, acople mal conectado, sistema obstruido, línea congelada.',
    keywords:'no tira, no sale nada, schoppera no funciona, sin flujo' },
  { scope:'mayorista', title:'Detección y solución de fugas de CO2',
    description:'Señales (cilindro se vacía rápido, silbido, presión cae sola). Test con agua jabonosa en conexiones. Qué cambiar primero.',
    keywords:'fuga CO2, escape CO2, pierde gas, cilindro se vacía, silbido' },
  { scope:'mayorista', title:'Manejo seguro del CO2',
    description:'Cilindro vertical bien afirmado, lejos de calor. Abrir/cerrar válvulas lentamente. CO2 nunca debe estar en frío. Seguridad operativa.',
    keywords:'CO2 seguridad, cilindro CO2, manejar CO2, válvula CO2, regulador' },
  { scope:'mayorista', title:'Configurar presión de CO2 por largo de línea',
    description:'Sistema corto (<6m): no debiera ser mayor a 1.4 bar. Sistema largo (>6m): no debiera exceder 2.5 bar. Cómo ajustar y qué dejar como base.',
    keywords:'presión CO2, configurar presión, bar PSI, regulador presión, línea schoppera' },
  { scope:'mayorista', title:'Cadena de frío y conservación del barril',
    description:'Cadena de frío completa producción → envasado → despacho → local. Sin sistema refrigerado integral: rotar en 5–7 días, nunca > 25°C. Dónde NO ubicar el barril.',
    keywords:'cadena de frío, conservar barril, temperatura barril, refrigeración, almacenar barril' },
  { scope:'mayorista', title:'Defectos sensoriales y cómo identificarlos',
    description:'Asociaciones: cartón mojado → oxidación, mantequilla → diacetilo, agrio → contaminación, químico → residuo de limpieza, etc. Cómo levantar el caso.',
    keywords:'defecto sensorial, sabor raro, off-flavor, cartón, diacetilo, oxidación, contaminación' },
  { scope:'mayorista', title:'Líneas congeladas — causas y solución',
    description:'Síntomas, causas en cámaras de frío / refrigeradores / schopperas refrigeradas. Cuándo es operativo y cuándo derivar a maestro cervecero.',
    keywords:'línea congelada, hielo en línea, schoppera fría, refrigerador problema' },
  { scope:'mayorista', title:'Turbidez en cerveza: normal vs problema',
    description:'Cuándo es esperable (sin filtrar, levadura en suspensión, estilo turbio, cerveza muy fría) y cuándo es señal de problema (olor o sabor raro).',
    keywords:'turbio, cerveza turbia, opaca, levadura en suspensión, turbidez' },
  { scope:'mayorista', title:'Distinguir problema de línea vs problema de producto',
    description:'Línea: se repite en distintos barriles, mejora con limpieza. Producto: solo un barril, viene mal desde el primer servido, no se replica en otras líneas.',
    keywords:'línea o producto, defecto cerveza, problema barril, distinguir defecto' },
  { scope:'mayorista', title:'Mermas en latas y proceso de cambio',
    description:'Latas golpeadas o con fecha vencida → considerar merma. Cómo levantar el caso para revisión.',
    keywords:'merma, latas dañadas, lata golpeada, lata vencida, cambio lata' },
  { scope:'mayorista', title:'Servido perfecto del barril',
    description:'Inclinar vaso 45°, grifo completamente abierto, enderezar al final para formar espuma. Errores comunes y cómo enseñar al staff.',
    keywords:'servido, servir cerveza, técnica servido, espuma cremosa, vaso 45' },
  { scope:'mayorista', title:'Aplicar código de descuento mayorista',
    description:'Dónde se aplica (celular: arriba de Pagar ahora; computador: al lado del carrito). Respetar mayúsculas, sin espacios.',
    keywords:'código descuento, cupón mayorista, aplicar descuento, código pedido' },
  { scope:'mayorista', title:'Crear cuenta mayorista y recuperar contraseña',
    description:'Cómo crear usuario, dónde iniciar sesión (computador: persona arriba derecha; celular: menú 3 líneas). Recuperar contraseña.',
    keywords:'crear cuenta, registro mayorista, recuperar contraseña, login mayorista, olvidé contraseña' },
  { scope:'mayorista', title:'Plazos de pedido y despacho mayorista',
    description:'Pedido máximo hasta las 16:00 del día anterior al despacho. No se despacha sábados ni domingos.',
    keywords:'plazo pedido, horario despacho, cierre pedido, hora corte' },

  // ── General (B2C + B2B) ──
  { scope:'general', title:'Cómo guardar y conservar cerveza craft en casa',
    description:'Cerveza viva sin filtrar: mantener en frío, evitar luz directa, consumir fresca. Cuánto dura bien conservada.',
    keywords:'guardar cerveza, conservar cerveza, refrigerar cerveza, cuánto dura, almacenar craft' },
  { scope:'general', title:'Vaso y temperatura ideal para cada estilo',
    description:'Qué vaso usar (pinta, weizen, snifter), a qué temperatura servir (lager fría / ales más templadas / stouts casi ambiente).',
    keywords:'vaso cerveza, temperatura cerveza, copa cerveza, servir cerveza, cómo tomar' },
  { scope:'general', title:'Maridajes con cervezas Kairos',
    description:'Asados → red ales y estilos maltosos. Comida liviana → pilsner/golden. Picantes → APAs y NEIPAs. Quesos cremosos → estilos jugosos.',
    keywords:'maridaje cerveza, qué tomar con asado, qué tomar con comida picante, maridar craft' },
  { scope:'general', title:'Maridajes con Firulais (cheladas)',
    description:'Mexicano, tex-mex, asados intensos, tablas y picoteo. Ideal para quien no toma cerveza pura.',
    keywords:'maridaje chelada, chelada con tacos, chelada con comida, maridar firulais' },
  { scope:'general', title:'Cócteles en casa con Banny',
    description:'Gin tonic, mojito con ron, whiskey sour, negroni con vermut. Proporciones básicas y trucos.',
    keywords:'cocteles, gin tonic, mojito, whiskey sour, negroni, banny coctel, recetas trago' },
  { scope:'general', title:'Historia y filosofía Kairos Brewing',
    description:'Cervecería artesanal chilena nacida en 2017. Cervezas vivas, sin filtrar, sin aditivos. Los 4 pilares: calidad, innovación, alta tomabilidad, experiencia integral.',
    keywords:'historia kairos, quienes somos, sobre kairos, kairos brewing historia, filosofía' },
  { scope:'general', title:'Recorrido por los estilos Kairos',
    description:'APA, Golden Ale, Red Ale, Pilsner, NEIPA, Weizen, Stout y más. A qué saben, cuándo conviene cada uno.',
    keywords:'estilos kairos, qué cervezas hay, tipos de cerveza, estilos craft, neipa, ipa, pilsner' },
  { scope:'general', title:'Firulais: la chelada artesanal explicada',
    description:'Cheladas 100% naturales, 4.5% ABV, latas 473cc. Perfiles cítricos, frutales y con toque picante. Por qué son "perrísimas".',
    keywords:'firulais, chelada craft, qué es firulais, ingredientes firulais, sabor chelada' },
  { scope:'general', title:'Banny: destilados craft del grupo Kairos',
    description:'Gin, ron, whiskey, vermut y RTD. Premium pero accesible, "craft to be wild". Cómo elegir entre destilado en botella y RTD en lata.',
    keywords:'banny, destilados banny, gin banny, ron banny, qué es banny, rtd banny' },
];

function normalizeTitle(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\w]+/g,' ').trim();
}

app.post('/admin/tutoriales/seed', requireAdmin, (_req, res) => {
  try {
    const all = loadTutorials();
    const existingTitles = new Set(all.map(t => normalizeTitle(t.title)));
    let added = 0;
    for (const t of DEFAULT_TUTORIALS) {
      if (existingTitles.has(normalizeTitle(t.title))) continue;
      all.push({
        id: randomUUID(),
        title: t.title,
        videoUrl: '',
        keywords: t.keywords,
        description: t.description,
        scope: t.scope,
        createdAt: new Date().toISOString(),
        seeded: true,
      });
      added++;
    }
    saveTutorials(all);
    res.json({ ok: true, added, total: all.length });
  } catch (e) {
    res.status(500).json({ error: 'Error sembrando: ' + e.message });
  }
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
  if (rangeId === '90d')   return { id:'90d',   label:'últimos 90 días',     from: now - 90*86400e3, to: now };
  if (rangeId === 'year')  return { id:'year',  label:'último año',          from: now - 365*86400e3, to: now };
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

// ─── Analítica de VENTAS mayoristas (Shopify orders) ────────────────────────
// SOLO productos con tag MAYORISTA. Requiere read_orders.
const isMayoristaLine = (li) => (li.tags || []).map(t => String(t).toUpperCase()).includes('MAYORISTA');

// Diagnóstico: qué scopes tiene REALMENTE el token actual de Shopify.
app.get('/admin/shopify/scopes', requireAdmin, async (_req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN || !process.env.SHOPIFY_STORE_DOMAIN) {
    return res.json({ ok:false, reason:'Falta SHOPIFY_ADMIN_TOKEN o SHOPIFY_STORE_DOMAIN.' });
  }
  try {
    const r = await shopifyAdminFetch('/oauth/access_scopes.json');
    const granted = (r.access_scopes || []).map(s => s.handle);
    res.json({
      ok: true,
      shop: process.env.SHOPIFY_STORE_DOMAIN,
      granted,
      hasReadOrders:    granted.includes('read_orders'),
      hasReadCustomers: granted.includes('read_customers'),
    });
  } catch (e) {
    res.json({ ok:false, reason: String(e.message || e).slice(0, 300) });
  }
});

app.get('/admin/analytics/sales', requireAdmin, async (req, res) => {  const r = rangeFor(String(req.query.range || '30d'));
  const result = await loadOrders(String(req.query.refresh || '') === '1');
  if (!result.available) {
    return res.json({ available: false, reason: result.reason, range: r });
  }
  try {
    const orders = result.orders.filter(o => {
      const t = new Date(o.createdAt).getTime();
      return t >= r.from && t <= r.to;
    });

    // Solo líneas de productos mayoristas
    const moneyByProduct = new Map();   // title → $
    const qtyByProduct   = new Map();   // title → unidades
    let mayoOrderCount = 0, mayoRevenue = 0;
    const comboCounts = new Map();      // "A|||B" → veces
    const dayOfMonth = {};              // 1..31 → { sum, count(días distintos) }
    const heat = Array.from({length:7}, () => Array(24).fill(0)); // [weekday][hour] = $
    const seenDates = {};               // para contar días distintos por day-of-month

    for (const o of orders) {
      const mayoLines = (o.lineItems || []).filter(isMayoristaLine);
      if (!mayoLines.length) continue;
      mayoOrderCount++;
      let orderMayoTotal = 0;
      const titlesInOrder = new Set();
      for (const li of mayoLines) {
        moneyByProduct.set(li.title, (moneyByProduct.get(li.title) || 0) + li.amount);
        qtyByProduct.set(li.title, (qtyByProduct.get(li.title) || 0) + li.qty);
        orderMayoTotal += li.amount;
        titlesInOrder.add(li.title);
      }
      mayoRevenue += orderMayoTotal;

      // combinaciones (pares distintos dentro de la orden)
      const titles = [...titlesInOrder].sort();
      for (let i = 0; i < titles.length; i++)
        for (let j = i+1; j < titles.length; j++)
          comboCounts.set(`${titles[i]}|||${titles[j]}`, (comboCounts.get(`${titles[i]}|||${titles[j]}`) || 0) + 1);

      // day-of-month + heatmap
      const d = new Date(o.createdAt);
      const dom = d.getDate();
      const dateKey = d.toISOString().slice(0,10);
      if (!dayOfMonth[dom]) dayOfMonth[dom] = { sum: 0, dates: new Set() };
      dayOfMonth[dom].sum += orderMayoTotal;
      dayOfMonth[dom].dates.add(dateKey);
      heat[d.getDay()][d.getHours()] += orderMayoTotal;
    }

    const topMoney = [...moneyByProduct.entries()].map(([name, v]) => ({ name, value: Math.round(v) }))
      .sort((a,b)=>b.value-a.value).slice(0,10);
    const topQty = [...qtyByProduct.entries()].map(([name, v]) => ({ name, value: v }))
      .sort((a,b)=>b.value-a.value).slice(0,10);
    const avgTicket = mayoOrderCount ? Math.round(mayoRevenue / mayoOrderCount) : 0;
    const combos = [...comboCounts.entries()].map(([k, v]) => {
      const [a,b] = k.split('|||'); return { a, b, count: v };
    }).sort((x,y)=>y.count-x.count).slice(0,10);

    // Top 5 días del mes por venta promedio
    const bestDays = Object.entries(dayOfMonth).map(([dom, o]) => ({
      day: Number(dom), avg: Math.round(o.sum / o.dates.size), total: Math.round(o.sum),
    })).sort((a,b)=>b.avg-a.avg).slice(0,5);

    // Mes vs mes anterior por producto (usa TODO el cache, no el rango)
    const now = new Date();
    const thisM = now.getMonth(), thisY = now.getFullYear();
    const prevDate = new Date(thisY, thisM-1, 1);
    const prevM = prevDate.getMonth(), prevY = prevDate.getFullYear();
    const cur = new Map(), prev = new Map();
    for (const o of result.orders) {
      const d = new Date(o.createdAt);
      const inCur  = d.getMonth()===thisM && d.getFullYear()===thisY;
      const inPrev = d.getMonth()===prevM && d.getFullYear()===prevY;
      if (!inCur && !inPrev) continue;
      for (const li of (o.lineItems||[]).filter(isMayoristaLine)) {
        const m = inCur ? cur : prev;
        m.set(li.title, (m.get(li.title) || 0) + li.amount);
      }
    }
    const growthNames = new Set([...cur.keys(), ...prev.keys()]);
    const growth = [...growthNames].map(name => {
      const c = Math.round(cur.get(name)||0), p = Math.round(prev.get(name)||0);
      const pct = p > 0 ? Math.round((c-p)/p*100) : (c > 0 ? null : 0); // null = nuevo (sin base)
      return { name, current: c, previous: p, pct };
    }).filter(x => x.current || x.previous)
      .sort((a,b)=> (b.current - b.previous) - (a.current - a.previous)).slice(0,10);

    res.json({
      available: true, range: r,
      summary: { orders: mayoOrderCount, revenue: Math.round(mayoRevenue), avgTicket },
      topMoney, topQty, combos, bestDays, heat,
      growth: { thisMonthLabel: monthLabel(thisM), prevMonthLabel: monthLabel(prevM), items: growth },
    });
  } catch (e) {
    res.status(500).json({ error: 'Error en analítica de ventas: ' + e.message });
  }
});

function monthLabel(m){
  return ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][m] || '';
}

// ─── Analítica del BOT (uso desde conversations.json) ───────────────────────
// Orden = prioridad de clasificación (la primera que matchea gana). Reclamos
// y envío van primero para que "mi pedido no llegó" caiga en reclamo, no en
// armado de pedido.
const BOT_USE_CATEGORIES = [
  { id:'reclamo',       label:'Atención / reclamos', rx: /\b(problema|reclamo|queja|no\s+lleg|lleg[oó]\s+mal|defect|roto|rota|devoluci|cambio|equivoca|tard[oó]|nunca\s+lleg)\b/i },
  { id:'envio',         label:'Consulta de envío',   rx: /\b(env[ií]o|despacho|domicilio|retir[oa]|cu[aá]ndo\s+lleg|direcci[oó]n|comuna|reparto|seguimiento|tracking)\b/i },
  { id:'precio',        label:'Consulta de precios', rx: /\b(precio|cu[aá]nto\s+(cuesta|sale|vale|es)|valor|barat[oa]|car[oa]|descuento|oferta)\b/i },
  { id:'pedido',        label:'Armado de pedido',    rx: /\b(pedido|comprar|carrito|carro|llevar|quiero\s+\d|pack|caja|link|pagar|checkout)\b/i },
  { id:'recomendacion', label:'Recomendación',       rx: /\b(recomien|recomenda|sugier|sugerenc|qu[eé]\s+me\s+(das|sirve|conviene)|para\s+un\s+asado|para\s+regalo|qu[eé]\s+tomar)\b/i },
];

app.get('/admin/analytics/bot', requireAdmin, (req, res) => {
  try {
    const r = rangeFor(String(req.query.range || '30d'));
    const all = Array.isArray(readLog(CONV_LOG)) ? readLog(CONV_LOG) : [];
    const subset = all.filter(c => {
      const t = new Date(c.endTime || c.startTime || 0).getTime();
      return t >= r.from && t <= r.to;
    });

    // Para qué usan a Zorbot — clasifica cada conversación por el primer y
    // segundo mensaje del usuario (la intención dominante). 1 categoría por chat.
    const usage = Object.fromEntries(BOT_USE_CATEGORIES.map(c => [c.id, { id:c.id, label:c.label, count:0 }]));
    usage.otros = { id:'otros', label:'Otros', count:0 };
    for (const c of subset) {
      const userText = (c.messages || []).filter(m => m.role==='user').map(m => m.content).join(' \n ');
      const cat = BOT_USE_CATEGORIES.find(k => k.rx.test(userText));
      usage[cat ? cat.id : 'otros'].count++;
    }
    const usageList = Object.values(usage).sort((a,b)=>b.count-a.count);

    // Por qué vuelven — sesiones con actividad en más de 1 día distinto.
    let multiDay = 0, totalSpanDays = 0;
    const returnByGap = { '1d':0, '2-7d':0, '8-30d':0, '30d+':0 };
    for (const c of subset) {
      const ts = (c.messages || []).map(m => m.timestamp ? new Date(m.timestamp).getTime() : null).filter(Boolean);
      if (ts.length < 2) continue;
      const days = new Set(ts.map(t => new Date(t).toISOString().slice(0,10)));
      if (days.size > 1) {
        multiDay++;
        const spanDays = Math.round((Math.max(...ts) - Math.min(...ts)) / 86400e3);
        totalSpanDays += spanDays;
        if (spanDays <= 1) returnByGap['1d']++;
        else if (spanDays <= 7) returnByGap['2-7d']++;
        else if (spanDays <= 30) returnByGap['8-30d']++;
        else returnByGap['30d+']++;
      }
    }
    const returning = {
      total: subset.length,
      multiDay,
      rate: subset.length ? Math.round(multiDay / subset.length * 1000)/10 : 0,
      avgSpanDays: multiDay ? Math.round(totalSpanDays / multiDay) : 0,
      byGap: returnByGap,
    };

    res.json({ available: true, range: r, usage: usageList, returning });
  } catch (e) {
    res.status(500).json({ error: 'Error en analítica del bot: ' + e.message });
  }
});

// ─── Pixis (data de mercado externa) — placeholder hasta tener credenciales ──
app.get('/admin/analytics/pixis', requireAdmin, (_req, res) => {
  const configured = !!(process.env.PIXIS_API_KEY && process.env.PIXIS_API_BASE);
  if (!configured) {
    return res.json({
      available: false,
      reason: 'Pixis no está conectado.',
      needs: ['PIXIS_API_BASE', 'PIXIS_API_KEY'],
    });
  }
  // TODO: cuando tengamos doc de la API de Pixis, implementar las llamadas
  // reales (sell-out cadena, competencia, top licores, crecimiento por local).
  res.json({ available: false, reason: 'Pixis configurado pero la integración aún no está implementada (falta doc de endpoints).' });
});

// ─── Clientes mayoristas ────────────────────────────────────────────────────
// Lista de clientes Shopify con tag que contenga "mayorista" (case-insensitive),
// enriquecidos con métricas de sus órdenes. Notas internas en JSON propio.

const CUSTOMER_NOTES_FILE = join(PROMPTS_EFFECTIVE_DIR, 'customer-notes.json');
function loadCustomerNotes(){
  try {
    if (!existsSync(CUSTOMER_NOTES_FILE)) return {};
    const p = JSON.parse(readFileSync(CUSTOMER_NOTES_FILE, 'utf-8'));
    return (p && typeof p === 'object') ? p : {};
  } catch { return {}; }
}
function saveCustomerNotes(data){ writeFileSync(CUSTOMER_NOTES_FILE, JSON.stringify(data, null, 2)); }

const CUSTOMERS_QUERY = `query($cursor: String) {
  customers(first: 100, after: $cursor, query: "tag:mayorista") {
    edges { cursor node {
      id firstName lastName email phone note createdAt numberOfOrders tags
      amountSpent { amount }
      defaultAddress { address1 address2 city province company phone }
    } }
    pageInfo { hasNextPage }
  }
}`;

let wholesaleCache = null, wholesaleCacheAt = 0;
const WHOLESALE_TTL_MS = 10 * 60 * 1000;

function hasMayoristaTagArr(tags){
  return (tags || []).some(t => String(t).toLowerCase().includes('mayorista'));
}

async function loadWholesaleCustomers(force = false){
  if (!force && wholesaleCache && Date.now() - wholesaleCacheAt < WHOLESALE_TTL_MS) {
    return { available: true, customers: wholesaleCache };
  }
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return { available: false, reason: 'Shopify no conectado (falta SHOPIFY_ADMIN_TOKEN).' };
  }
  try {
    const customers = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const resp = await shopifyAdminFetch('/graphql.json', {
        method: 'POST',
        body: JSON.stringify({ query: CUSTOMERS_QUERY, variables: { cursor } }),
      });
      if (resp.errors) {
        const msg = JSON.stringify(resp.errors);
        if (/access denied|read_customers|scope/i.test(msg)) {
          return { available: false, reason: 'El token de Shopify no tiene read_customers. Re-autorizá la app.' };
        }
        throw new Error(msg);
      }
      const conn = resp.data.customers;
      for (const e of conn.edges) {
        const n = e.node;
        const tags = n.tags || [];
        if (!hasMayoristaTagArr(tags)) continue; // doble check case-insensitive
        const addr = n.defaultAddress || {};
        customers.push({
          id: stripGid(n.id, 'Customer'),
          name: [n.firstName, n.lastName].filter(Boolean).join(' ').trim() || addr.company || '(sin nombre)',
          company: addr.company || null,
          email: n.email || null,
          phone: n.phone || addr.phone || null,
          address: [addr.address1, addr.address2, addr.city, addr.province].filter(Boolean).join(', ') || null,
          shopifyNote: n.note || null,
          createdAt: n.createdAt,
          numberOfOrders: Number(n.numberOfOrders || 0),
          amountSpent: parseFloat(n.amountSpent?.amount || 0),
          tags,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.edges[conn.edges.length - 1].cursor;
    }
    wholesaleCache = customers;
    wholesaleCacheAt = Date.now();
    return { available: true, customers };
  } catch (e) {
    const msg = String(e.message || e);
    if (/\b40[13]\b|access denied|read_customers/i.test(msg)) {
      return { available: false, reason: 'El token de Shopify no tiene read_customers. Re-autorizá la app.' };
    }
    return { available: false, reason: 'Error consultando clientes: ' + msg.slice(0, 200) };
  }
}

// Agrega métricas de órdenes a cada cliente (total, count, last, top product).
function ordersByCustomer(orders){
  const map = new Map();
  for (const o of orders) {
    if (!o.customerId) continue;
    if (!map.has(o.customerId)) map.set(o.customerId, []);
    map.get(o.customerId).push(o);
  }
  return map;
}

app.get('/admin/customers/wholesale', requireAdmin, async (req, res) => {
  const cust = await loadWholesaleCustomers(String(req.query.refresh||'')==='1');
  if (!cust.available) return res.json({ available: false, reason: cust.reason });
  const ord = await loadOrders(false);
  const byCust = ord.available ? ordersByCustomer(ord.orders) : new Map();
  const notes = loadCustomerNotes();

  const list = cust.customers.map(c => {
    const cOrders = byCust.get(c.id) || [];
    let total = 0, lastDate = null;
    const prodQty = new Map();
    for (const o of cOrders) {
      total += o.total;
      if (!lastDate || new Date(o.createdAt) > new Date(lastDate)) lastDate = o.createdAt;
      for (const li of o.lineItems) prodQty.set(li.title, (prodQty.get(li.title)||0) + li.qty);
    }
    // Si Shopify ya da amountSpent/numberOfOrders, preferimos eso para total
    // histórico; las órdenes del cache sirven para "última compra" y top.
    const topProduct = [...prodQty.entries()].sort((a,b)=>b[1]-a[1])[0];
    return {
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      totalSpent: Math.round(c.amountSpent || total),
      orders: c.numberOfOrders || cOrders.length,
      lastOrder: lastDate,
      topProduct: topProduct ? topProduct[0] : null,
      hasNote: !!(notes[c.id] && notes[c.id].note),
    };
  });

  res.json({ available: true, total: list.length, customers: list });
});

app.get('/admin/customers/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const cust = await loadWholesaleCustomers(false);
  if (!cust.available) return res.json({ available: false, reason: cust.reason });
  const c = cust.customers.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const ord = await loadOrders(false);
  const cOrders = (ord.available ? ord.orders.filter(o => o.customerId === id) : [])
    .sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));

  // Métricas
  let total = 0; const prodQty = new Map(); const monthly = {};
  for (const o of cOrders) {
    total += o.total;
    const mk = String(o.createdAt).slice(0,7); // YYYY-MM
    monthly[mk] = (monthly[mk] || 0) + o.total;
    for (const li of o.lineItems) prodQty.set(li.title, (prodQty.get(li.title)||0) + li.qty);
  }
  const orderCount = cOrders.length;
  const firstOrder = orderCount ? cOrders[cOrders.length-1].createdAt : null;
  const lastOrder  = orderCount ? cOrders[0].createdAt : null;
  const avgTicket  = orderCount ? Math.round(total / orderCount) : 0;
  // Frecuencia: días promedio entre órdenes
  let freqDays = null;
  if (orderCount >= 2) {
    const span = (new Date(lastOrder) - new Date(firstOrder)) / 86400e3;
    freqDays = Math.round(span / (orderCount - 1));
  }
  const topProducts = [...prodQty.entries()].map(([name,qty])=>({name,qty})).sort((a,b)=>b.qty-a.qty).slice(0,5);
  const monthlySpend = Object.entries(monthly).map(([month,amount])=>({month, amount: Math.round(amount)})).sort((a,b)=>a.month.localeCompare(b.month));

  // Conversaciones asociadas (match por email o teléfono en los mensajes)
  let conversations = [];
  try {
    const allConv = Array.isArray(readLog(CONV_LOG)) ? readLog(CONV_LOG) : [];
    const needles = [c.email, c.phone].filter(Boolean).map(s => String(s).toLowerCase());
    if (needles.length) {
      conversations = allConv.filter(cv => {
        const txt = (cv.messages||[]).map(m => String(m.content||'').toLowerCase()).join(' ');
        return needles.some(n => txt.includes(n));
      }).map(summarizeConversation).slice(0, 50);
    }
  } catch {}

  const notes = loadCustomerNotes();
  res.json({
    available: true,
    customer: {
      ...c,
      metrics: {
        totalSpent: Math.round(c.amountSpent || total),
        ordersCount: c.numberOfOrders || orderCount,
        avgTicket, freqDays, firstOrder, lastOrder,
      },
      orders: cOrders.map(o => ({
        id: o.id, name: o.name, createdAt: o.createdAt, total: Math.round(o.total),
        status: o.status,
        items: o.lineItems.map(li => ({ title: li.title, qty: li.qty })),
      })),
      topProducts, monthlySpend, conversations,
      note: notes[id]?.note || '',
      noteUpdatedAt: notes[id]?.updatedAt || null,
    },
  });
});

app.post('/admin/customers/:id/note', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const { note = '' } = req.body || {};
  if (typeof note !== 'string') return res.status(400).json({ error: 'Nota inválida.' });
  if (note.length > 10000) return res.status(413).json({ error: 'Nota demasiado larga.' });
  try {
    const data = loadCustomerNotes();
    if (!note.trim()) delete data[id];
    else data[id] = { note: note.trim(), updatedAt: new Date().toISOString() };
    saveCustomerNotes(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando nota: ' + e.message });
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
          .filter(p => String(p.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
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
