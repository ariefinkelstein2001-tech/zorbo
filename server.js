import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual, randomBytes, scryptSync, createHash } from 'crypto';

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
// Backup de los pronósticos del Mundial. Lo llena el form de /pages/mundial ANTES
// del checkout, así iDTE/Flapp no puede pisarlo (sobrescribe los cart attributes).
const MUNDIAL_BACKUP_FILE = join(LOGS_DIR, 'mundial-backup.json');
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

// ─── Notificación de waitlist mayorista (email + WhatsApp) ──────────────────
// Cada inscripción en "Soy nuevo / Únete a la waitlist" avisa al equipo.
// Destinos configurables por env; por defecto los del negocio.
const WAITLIST_EMAIL    = process.env.WAITLIST_NOTIFY_EMAIL    || 'vfernandez@kairosdrinks.com';
const WAITLIST_WHATSAPP = process.env.WAITLIST_NOTIFY_WHATSAPP || '+56996605516';

async function sendWaitlistEmail(lead) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true, reason: 'no RESEND_API_KEY' };
  const from = process.env.RESEND_FROM || 'Zorbo <onboarding@resend.dev>';
  const rows = Object.entries(lead)
    .map(([k, v]) => `<tr><td style="padding:4px 12px;font-weight:600;text-transform:capitalize">${k}</td><td style="padding:4px 12px">${v || '-'}</td></tr>`)
    .join('');
  const html = `<h2>Nuevo inscrito en la waitlist mayorista</h2><table style="border-collapse:collapse">${rows}</table>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [WAITLIST_EMAIL], subject: `Nuevo mayorista waitlist: ${lead.nombre || lead.email}`, html }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { ok: true };
}

async function sendWaitlistWhatsApp(lead) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const fromWa = process.env.TWILIO_WHATSAPP_FROM; // ej: whatsapp:+1415... o +1415...
  if (!sid || !tok || !fromWa) return { skipped: true, reason: 'no Twilio config' };
  const body = 'Nueva waitlist mayorista Zorbo:\n' +
    `Nombre: ${lead.nombre || '-'}\n` +
    `Local: ${lead.local || '-'}\n` +
    `Comuna: ${lead.comuna || '-'}\n` +
    `Canal: ${lead.canal || '-'}\n` +
    `Email: ${lead.email || '-'}\n` +
    `Teléfono: ${lead.telefono || '-'}`;
  const wa = (s) => (String(s).startsWith('whatsapp:') ? String(s) : 'whatsapp:' + String(s));
  const params = new URLSearchParams({ From: wa(fromWa), To: wa(WAITLIST_WHATSAPP), Body: body });
  const auth = Buffer.from(`${sid}:${tok}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) throw new Error('Twilio ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { ok: true };
}

// Fire-and-forget: no bloquea la respuesta al usuario. Si un canal no está
// configurado, se omite (y queda el log local del lead de respaldo).
function notifyWaitlist(lead) {
  sendWaitlistWebhook(lead).catch(e => console.warn('waitlist webhook:', e.message));
  sendWaitlistEmail(lead).catch(e => console.warn('waitlist email:', e.message));
  sendWaitlistWhatsApp(lead).catch(e => console.warn('waitlist whatsapp:', e.message));
}

// Opción más simple: mandar el lead a un webhook de Make/Zapier/n8n que se
// encarga del email + WhatsApp. Solo hay que pegar la URL del webhook en env.
async function sendWaitlistWebhook(lead) {
  const url = process.env.WAITLIST_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: 'no WAITLIST_WEBHOOK_URL' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...lead,
      notify_email: WAITLIST_EMAIL,
      notify_whatsapp: WAITLIST_WHATSAPP,
      source: 'zorbo-waitlist-mayorista',
      timestamp: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error('Webhook ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { ok: true };
}

// ─── Solicitudes de servicio (reposición, capacitación, limpieza de líneas) ──
// Avisan al equipo (webhook Make + email + WhatsApp), igual que la waitlist.
// NO pasan por carrito ni pago: son agendamientos/solicitudes.
function notifyServiceRequest(data) {
  const url = process.env.WAITLIST_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL;
  if (url) {
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'service-request', ...data, notify_email: WAITLIST_EMAIL, notify_whatsapp: WAITLIST_WHATSAPP, source: 'zorbo-servicio-mayorista', timestamp: new Date().toISOString() }),
    }).catch(e => console.warn('service webhook:', e.message));
  }
  sendServiceEmail(data).catch(e => console.warn('service email:', e.message));
  sendServiceWhatsApp(data).catch(e => console.warn('service whatsapp:', e.message));
}
async function sendServiceEmail(d) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };
  const from = process.env.RESEND_FROM || 'Zorbo <onboarding@resend.dev>';
  const rows = Object.entries(d).map(([k, v]) => `<tr><td style="padding:4px 12px;font-weight:600;text-transform:capitalize">${k}</td><td style="padding:4px 12px">${v || '-'}</td></tr>`).join('');
  const html = `<h2>Nueva solicitud de servicio mayorista</h2><table style="border-collapse:collapse">${rows}</table>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [WAITLIST_EMAIL], subject: `Solicitud de servicio: ${d.servicio || ''}`, html }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
  return { ok: true };
}
async function sendServiceWhatsApp(d) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, fromWa = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !tok || !fromWa) return { skipped: true };
  const body = 'Solicitud de servicio Zorbo:\n' + Object.entries(d).map(([k, v]) => `${k}: ${v || '-'}`).join('\n');
  const wa = (s) => (String(s).startsWith('whatsapp:') ? String(s) : 'whatsapp:' + String(s));
  const params = new URLSearchParams({ From: wa(fromWa), To: wa(WAITLIST_WHATSAPP), Body: body });
  const auth = Buffer.from(`${sid}:${tok}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  if (!r.ok) throw new Error('Twilio ' + r.status);
  return { ok: true };
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

// Sólo palabras de "abrime el carrito / pasame el link" → bypass directo.
// "quiero comprar X" NO entra acá: va al bot normal para que recomiende y
// pregunte si lo agrega. La idea es: recomendar → preguntar → confirmar.
const CHECKOUT_OPEN_KW = [
  // pedidos del link / checkout
  'link', 'el link', 'pasame el link', 'pásame el link', 'mandame el link',
  'mándame el link', 'envíame el link', 'enviame el link', 'manda el link',
  'pásamelo', 'pasamelo', 'mándamelo', 'mandamelo',
  'link de pago', 'link de checkout', 'link para pagar',
  'donde pago', 'dónde pago', 'cómo pago', 'como pago',
  // ir a pagar
  'checkout', 'quiero pagar', 'voy a pagar', 'paguemos', 'pagamos', 'pagar ahora',
];
// Confirmaciones / intenciones de "metelo al carrito ya". Cuando matchea Y se
// puede identificar el producto en el último mensaje del bot, el server agrega
// al carrito directo. Si NO hay match claro, deja pasar al bot (que va a
// recomendar o preguntar). Así nunca miente con "ya lo agregué".
const ADD_NOW_KW = [
  // Confirmaciones explícitas
  'agrégalo', 'agregalo', 'agrégalos', 'agregalos',
  'agrégame', 'agregame', 'agrégamelos', 'agregamelos', 'agrégamela', 'agregamela',
  'sumalo', 'súmalo', 'sumalos', 'súmalos',
  'metelo', 'mételo', 'metelos', 'mételos',
  'ponelo en el carrito', 'ponelo al carrito', 'ponelos en el carrito',
  // Intenciones directas con artículo (= pedido concreto)
  'me lo llevo', 'me los llevo', 'lo llevo', 'los llevo',
  'lo quiero', 'los quiero', 'la quiero', 'las quiero',
  'lo compro', 'los compro', 'la compro', 'las compro',
  'quiero un', 'quiero una', 'quiero unos', 'quiero unas',
  'quiero el', 'quiero la', 'quiero los', 'quiero las',
  'quiero comprar', 'quiero pedir', 'quiero llevar',
  'dame un', 'dame una', 'dame unos', 'dame unas',
  'dame el', 'dame la', 'dame los', 'dame las',
];
// Mantenido por compatibilidad con flags de sesión / clasificación.
const PURCHASE_KW = [...CHECKOUT_OPEN_KW, ...ADD_NOW_KW];

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

function buildSystemPrompt(base, session, liveCatalog, lastOrderInfo) {
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
  // Historial de compra del mayorista → recompra proactiva (Prioridad 1).
  // Solo se inyecta si el cliente tiene un último pedido identificado.
  let reorderCtx = '';
  if (lastOrderInfo && lastOrderInfo.hasOrder && lastOrderInfo.order) {
    const fecha = (() => {
      try { return new Date(lastOrderInfo.order.createdAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'long' }); }
      catch { return 'tu última visita'; }
    })();
    const items = (lastOrderInfo.order.items || []).map(i => `- ${i.name} x${i.qty}`).join('\n');
    reorderCtx = `

═════════════════════════════════════════════════════════════════════
 HISTORIAL DE COMPRA DEL CLIENTE — RECOMPRA (úsalo proactivamente)
═════════════════════════════════════════════════════════════════════
Este cliente es un mayorista activo con historial. Su último pedido (${fecha}) fue:
${items}

CÓMO USARLO:
1. Si abre la conversación de forma general ("hola", "qué hay", "necesito reponer"), ofrécele PRIMERO reponer lo de siempre con esta lista exacta, ANTES de mostrar el catálogo completo. Ejemplo: "te dejo lista la reposición de la otra vez — [resumen]. La repetimos igual o cambiamos algo?".
2. Dile que puede tocar el botón **Repetir último pedido** que tiene arriba en su tienda para recargar todo de una, o que te confirme y lo guías.
3. NO inventes productos ni cantidades fuera de esta lista ni de la lista de catálogo de la sesión.
4. Después de cerrar la reposición, puedes sugerir UNA sola novedad del catálogo con argumento de reventa (rotación / margen), nunca más de una.`;
  }
  return `${base}\n\n## CONTEXTO DE ESTA SESIÓN\n${fromCtx}${b2bCtx}${reorderCtx}${catCtx}${extrasCtx}${tutorialsCtx}${buildFeedbackCtx()}`;
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

// Busca productos del catálogo mencionados en el texto (último mensaje del bot)
// por coincidencia de título. Devuelve productData listo para el frontend.
// Detecta el tamaño de pack mencionado por el cliente (6/12/24) en su mensaje.
// Devuelve { size, regex } o null. La regex sirve para enmascarar el match antes
// de extraer la cantidad (así "un 12 pack" no se confunde con qty=12).
function parsePackSize(u){
  const tests = [
    { size: 24, rx: /\b(24|veinticuatro)\s*[- ]?pack/i },
    { size: 12, rx: /\b(12|doce)\s*[- ]?pack/i },
    { size: 6,  rx: /\b(6|seis|six)\s*[- ]?pack/i },
  ];
  for (const t of tests) if (t.rx.test(u)) return { size: t.size, rx: t.rx };
  return null;
}
// Shorthand de intención de compra: mensajes cortos del tipo "1 24", "2 12 pack",
// "un 12", "12 pack". Cuando el bot acaba de mostrar opciones, el cliente
// abrevia. Estos patrones implican qty + pack-size sin verbos.
function isShorthandAddIntent(msg){
  const t = String(msg).trim();
  // "1 24" / "un 12" / "2 6" (qty + size, sin "pack")
  if (/^(un|uno|una|\d{1,2})\s+(?:6|12|24)\s*$/i.test(t)) return true;
  // "12 pack" / "1 24 pack" / "un 12 pack"
  if (/^(?:(?:un|uno|una|\d{1,2})\s+)?(?:6|12|24)\s*[- ]?pack\s*$/i.test(t)) return true;
  // Solo el número de pack ("6", "12", "24") — sin nada más.
  if (/^(?:6|12|24)\s*$/i.test(t)) return true;
  return false;
}

// ¿El mensaje es una pregunta o consulta (no una confirmación de compra)?
function isQuestionish(msg){
  const t = String(msg).toLowerCase();
  if (t.includes('?')) return true;
  return /\b(cu[aá]nto|cu[aá]l|cu[aá]les|precio|cuesta|vale|sale|info|ficha|d[oó]nde|c[oó]mo|por\s*qu[eé]|qu[eé]\s*es|stock|hay|tienen|ten[eé]s)\b/.test(t);
}
// "Selección suave": el cliente confirma/elige una opción que el bot acaba de
// ofrecer, sin usar un verbo de agregar explícito (ej. "solo golden", "ese",
// "dale el golden", "el osagui"). Solo cuenta si NO es pregunta ni negación.
const SELECT_KW = new Set(['si','sí','sip','sipo','dale','ya','ok','okey','oka','obvio','claro','ese','esa','esos','esas','solo','sólo','el','la','los','las','ambos','ambas','todos','todas','listo','perfecto','bkn','bacán','bacan','filo']);
function isSoftSelection(msg){
  const t = String(msg).trim().toLowerCase();
  if (!t || t.length > 50) return false;
  if (isQuestionish(t)) return false;
  if (/^no\b/.test(t)) return false;
  // Despedidas / declinaciones / cierres: no son selección de compra.
  if (/\b(gracias|chao|nada|m[aá]s\s*nada|eso\s*nom[aá]s|despu[eé]s|luego|otro\s*d[ií]a|mejor\s*no|ahora\s*no)\b/.test(t)) return false;
  const words = t.split(/[^a-záéíóúñ0-9]+/i).filter(Boolean);
  return words.some(w => SELECT_KW.has(w));
}
// Orden por formato: "1 barril de lanus", "2 latas de X", "un bidón de gin",
// "barril osagui". Cantidad (opcional) + un formato + (marca/estilo). No cuenta
// si es pregunta ("cuánto sale 1 barril?").
function isQtyFormatOrder(msg){
  const t = String(msg).trim().toLowerCase();
  if (!t || t.length > 60 || isQuestionish(t)) return false;
  if (/^no\b/.test(t)) return false;
  const FMT = /\b(barril|barriles|lata|latas|bid[oó]n|bidones|botella|botellas|pack|packs|caja|cajas)\b/;
  const QTY = /\b(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|media|medio)\b/;
  if (QTY.test(t) && FMT.test(t)) return true;     // "1 barril de lanus"
  if (/^\s*(barril|barriles|lata|latas|bid[oó]n|botella|pack)\b/.test(t)) return true; // "barril lanus"
  return false;
}

// Convierte el shorthand en un mensaje "agrégame qty N pack" para que el
// parser de pack-size lo entienda como tal.
function normalizeShorthand(msg){
  const t = String(msg).trim();
  // "1 24" → "agrégame 1 24 pack" (para que parsePackSize matchee)
  const m1 = t.match(/^(un|uno|una|\d{1,2})\s+(6|12|24)\s*$/i);
  if (m1) return `agrégame ${m1[1]} ${m1[2]} pack`;
  return t;
}
function parseQty(u){
  const words = { un:1, uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5,
                  seis:6, siete:7, ocho:8, nueve:9, diez:10 };
  for (const w in words) if (new RegExp('\\b' + w + '\\b', 'i').test(u)) return words[w];
  const m = u.match(/\b(\d{1,2})\b(?!\s*[- ]?pack)/i);
  if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 99) return n; }
  return 1;
}

// Busca productos del catálogo mencionados en `botText` (último mensaje del bot)
// y los filtra/cuantifica según `userMessage` (el "agrégalo" del cliente).
// Devuelve productData listo para el frontend.
function findMentionedProducts(botText, catalog, userMessage){
  if (!botText || !catalog || !catalog.length) return [];
  // 1. Match de TODOS los productos mencionados en el último mensaje del bot
  //    (ordenado por título más largo primero + masking para evitar prefijos).
  let lower = String(botText).toLowerCase();
  const candidates = [];
  const seen = new Set();
  const ordered = [...catalog].sort((a, b) => (b.title || '').length - (a.title || '').length);
  for (const p of ordered) {
    const title = String(p.title || '').toLowerCase().trim();
    if (!title || seen.has(p.id)) continue;
    if (!lower.includes(title)) continue;
    seen.add(p.id);
    lower = lower.split(title).join(' '.repeat(title.length));
    candidates.push(p);
  }
  if (!candidates.length) return [];

  // 2. Parsear el mensaje del cliente: pack size + cantidad.
  const u = String(userMessage || '').toLowerCase();
  const pack = parsePackSize(u);
  let filtered = candidates;
  let consumedNum = null;  // número del mensaje que ya usamos como pack-size
  if (pack) {
    const inTitle = new RegExp('(^|\\s|\\b)' + pack.size + '\\s*[- ]?pack', 'i');
    let matched = candidates.filter(p => inTitle.test(String(p.title || '')));
    if (!matched.length) {
      // El bot recomendó (por ej.) el 6 Pack, pero el cliente quiere el 12.
      // Buscar en el catálogo completo el "hermano" con el pack pedido y
      // mismo nombre base (sin el prefijo "N Pack").
      const stripPack = s => String(s || '')
        .replace(/(\d+|seis|six|doce|veinticuatro)\s*[- ]?pack/gi, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-,.;]+|[\s\-,.;]+$/g, '')
        .toLowerCase();
      const candidateBases = new Set(candidates.map(c => stripPack(c.title)));
      matched = catalog.filter(p => inTitle.test(String(p.title || '')) && candidateBases.has(stripPack(p.title)));
    }
    filtered = matched;
  } else if (candidates.length > 1) {
    // Heurística: sin "X pack" explícito, si el mensaje tiene un número que
    // coincide con el pack-size de uno (y solo uno) de los candidatos, ése
    // es el elegido. Útil para "dame un 24" cuando el bot mostró 6/12/24.
    const nums = (u.match(/\b(\d{1,3})\b/g) || []).map(s => parseInt(s, 10));
    for (const n of nums) {
      if (n < 2 || n > 99) continue;
      const inTitle = new RegExp('(^|\\s|\\b)' + n + '\\s*[- ]?pack', 'i');
      const matched = candidates.filter(p => inTitle.test(String(p.title || '')));
      if (matched.length === 1) { filtered = matched; consumedNum = n; break; }
    }
  }
  if (!filtered.length) return [];
  // Si el bot mostró varias opciones y no desambiguamos por pack/número, probamos
  // por PALABRA del mensaje del cliente (ej. "solo golden" → elige el Golden).
  if (filtered.length > 1) {
    const STOP = new Set(['solo','sólo','el','la','los','las','un','una','unos','unas','pack','packs','de','del','con','mayorista','cerveza','cervezas','quiero','dame','ese','esa','esos','esas','mismo','lata','latas','barril','barriles','bidon','bidón','bidones','botella','botellas','caja','cajas','y','o','por','favor','este','esta','va','voy','llevo','lleva','473cc','473']);
    const words = u.split(/[^a-záéíóúñ0-9]+/i).filter(w => w.length >= 3 && !STOP.has(w));
    if (words.length) {
      const byWord = filtered.filter(p => {
        const t = String(p.title || '').toLowerCase();
        return words.some(w => t.includes(w));
      });
      if (byWord.length === 1) filtered = byWord;
    }
  }
  // Si aún hay varias opciones sin desambiguar → preguntar (no adivinar).
  if (filtered.length > 1) return [];
  // Para la qty: enmascarar el pack-size que ya consumimos.
  let uForQty = u;
  if (pack) uForQty = uForQty.replace(pack.rx, ' ');
  if (consumedNum != null) uForQty = uForQty.replace(new RegExp('\\b' + consumedNum + '\\b'), ' ');
  const qty = parseQty(uForQty);

  return filtered.map(p => {
    const v = (p.variants || [])[0];
    if (!v) return null;
    return {
      productData: {
        name:      p.title,
        brand:     p.vendor || '',
        emoji:     '🍺',
        style:     '',
        desc:      '',
        price:     parseFloat(v.price) || 0,
        variantId: String(v.id),
        image:     v.image || p.image || (p.images && p.images[0]) || null,
      },
      qty,
    };
  }).filter(Boolean);
}
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

// Nivel de acceso mayorista según los tags del cliente:
//   'ex'  → tag MAYORISTA1: SOLO ve la colección "MAYORISTA EX"
//   'all' → tag MAYORISTA:  ve todos los productos mayoristas
//   null  → sin acceso mayorista
// MAYORISTA1 tiene precedencia (es el segmento restringido).
function mayoLevelFromTags(tags) {
  const up = String(tags || '').split(',').map(t => t.trim().toUpperCase());
  if (up.includes('MAYORISTA1')) return 'ex';
  if (up.includes('MAYORISTA'))  return 'all';
  return null;
}

function customerHasMayoristaTag(customer) {
  return !!mayoLevelFromTags(customer && customer.tags);
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
    // El público SOLO ve productos activos (los borradores quedan ocultos).
    if (String(p.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
    const isB2B = isMayoristaProduct(p);
    // Mayorista: NO ocultamos recargas/CO2/accesorios — son insumos del local
    // (van a la sección Servicios). Las reglas de ocultar son solo para B2C.
    if (mode === 'b2b') return isB2B;
    if (HIDE_HANDLES.has(p.handle)) return false;
    if (HIDE_TITLE_RX.test(p.title || '')) return false;
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

// ─── Colección "MAYORISTA EX" (clientes con tag MAYORISTA1) ──────────────────
// Devuelve el set de IDs de producto que pertenecen a la colección. Cacheado.
// El título es configurable por env (MAYO_EX_COLLECTION), default "MAYORISTA EX".
const MAYO_EX_TITLE = (process.env.MAYO_EX_COLLECTION || 'MAYORISTAS EX').trim();
const MAYO_EX_TTL_MS = 10 * 60 * 1000;
let mayoExCache = null;
let mayoExCacheAt = 0;

async function loadMayoExProductIds(force = false) {
  if (!force && mayoExCache && Date.now() - mayoExCacheAt < MAYO_EX_TTL_MS) return mayoExCache;
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return { available: false, found: false, ids: new Set(), reason: 'Shopify no conectado.' };
  try {
    // 1) Ubicar la colección por título (match exacto, case-insensitive).
    const cq = await shopifyAdminFetch('/graphql.json', {
      method: 'POST',
      body: JSON.stringify({
        query: `query($q:String!){ collections(first:10, query:$q){ edges{ node{ id title } } } }`,
        variables: { q: `title:'${MAYO_EX_TITLE.replace(/'/g, '')}'` },
      }),
    });
    if (cq.errors) throw new Error(JSON.stringify(cq.errors));
    const edges = cq.data?.collections?.edges || [];
    const want = MAYO_EX_TITLE.toUpperCase();
    const match = edges.find(e => String(e.node.title || '').trim().toUpperCase() === want) || edges[0];
    if (!match) {
      mayoExCache = { available: true, found: false, ids: new Set(), title: MAYO_EX_TITLE };
      mayoExCacheAt = Date.now();
      return mayoExCache;
    }
    // 2) Paginar los productos de la colección.
    const ids = new Set();
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const pr = await shopifyAdminFetch('/graphql.json', {
        method: 'POST',
        body: JSON.stringify({
          query: `query($id:ID!,$cursor:String){ collection(id:$id){ products(first:250, after:$cursor){ edges{ node{ id } } pageInfo{ hasNextPage } } } }`,
          variables: { id: match.node.id, cursor },
        }),
      });
      if (pr.errors) throw new Error(JSON.stringify(pr.errors));
      const conn = pr.data?.collection?.products;
      if (!conn) break;
      for (const e of conn.edges) ids.add(stripGid(e.node.id, 'Product'));
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.edges[conn.edges.length - 1].cursor;
    }
    mayoExCache = { available: true, found: true, ids, title: match.node.title };
    mayoExCacheAt = Date.now();
    return mayoExCache;
  } catch (e) {
    return { available: false, found: false, ids: new Set(), reason: String(e.message || e).slice(0, 200) };
  }
}

// Nivel mayorista de un cliente por email (cacheado, evita golpear Shopify en
// cada mensaje del chat). Devuelve 'all' | 'ex' | null.
const CUST_LEVEL_TTL_MS = 10 * 60 * 1000;
const custLevelCache = new Map(); // email → { level, at }

async function getCustomerMayoLevel(email) {
  const norm = normEmail(email);
  if (!norm) return null;
  const hit = custLevelCache.get(norm);
  if (hit && Date.now() - hit.at < CUST_LEVEL_TTL_MS) return hit.level;
  try {
    const customer = await shopifyGetCustomerByEmail(norm);
    const level = customer ? mayoLevelFromTags(customer.tags) : null;
    custLevelCache.set(norm, { level, at: Date.now() });
    return level;
  } catch {
    return null;
  }
}

// Visibilidad base (mismas reglas que filterProducts, reutilizable para EX).
function isVisibleProduct(p) {
  if (HIDE_HANDLES.has(p.handle)) return false;
  if (HIDE_TITLE_RX.test(p.title || '')) return false;
  if (String(p.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
  return true;
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
        note
        customAttributes { key value }
        currentTotalPriceSet { shopMoney { amount } }
        customer { id email firstName lastName phone }
        shippingAddress { company address1 city province country zip latitude longitude }
        lineItems(first: 50) {
          edges { node {
            quantity
            originalTotalSet { shopMoney { amount } }
            customAttributes { key value }
            variant { id title price image { url } }
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
          note: n.note || '',
          attributes: (n.customAttributes || []).map(a => ({ key: a.key, value: a.value })),
          total: parseFloat(n.currentTotalPriceSet?.shopMoney?.amount || 0),
          customerId: n.customer ? stripGid(n.customer.id, 'Customer') : null,
          customerEmail: n.customer?.email || null,
          customerFirstName: n.customer?.firstName || '',
          customerLastName: n.customer?.lastName || '',
          customerPhone: n.customer?.phone || '',
          shippingAddress: n.shippingAddress ? {
            company:  n.shippingAddress.company || '',
            address1: n.shippingAddress.address1 || '',
            city:     n.shippingAddress.city || '',
            province: n.shippingAddress.province || '',
            country:  n.shippingAddress.country || '',
            zip:      n.shippingAddress.zip || '',
            lat:      n.shippingAddress.latitude != null ? Number(n.shippingAddress.latitude) : null,
            lng:      n.shippingAddress.longitude != null ? Number(n.shippingAddress.longitude) : null,
          } : null,
          lineItems: (n.lineItems?.edges || []).map(le => ({
            qty: le.node.quantity,
            amount: parseFloat(le.node.originalTotalSet?.shopMoney?.amount || 0),
            productId: le.node.product ? stripGid(le.node.product.id, 'Product') : null,
            title: le.node.product?.title || '(producto eliminado)',
            vendor: le.node.product?.vendor || '',
            tags: le.node.product?.tags || [],
            properties: (le.node.customAttributes || []).map(a => ({ key: a.key, value: a.value })),
            // Variant exacto comprado → necesario para "Repetir último pedido"
            // (el carrito arma el permalink con variantId). Precio/imagen del
            // variant ACTUAL, así la reposición refleja el precio de hoy.
            variantId: le.node.variant ? stripGid(le.node.variant.id, 'ProductVariant') : null,
            variantTitle: le.node.variant?.title || '',
            unitPrice: parseFloat(le.node.variant?.price || 0),
            image: le.node.variant?.image?.url || null,
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

// Último pedido de un cliente (por email) → items listos para recargar el
// carrito. Reutiliza la caché de loadOrders. Devuelve:
//   { available:false, reason }            → token sin read_orders / Shopify off
//   { available:true,  hasOrder:false }    → cliente sin historial de compra
//   { available:true,  hasOrder:true, order:{ name, createdAt, items:[...] } }
async function getLastOrderItemsForEmail(email) {
  const norm = normEmail(email);
  if (!norm) return { available: true, hasOrder: false };
  const result = await loadOrders(false);
  if (!result.available) return { available: false, reason: result.reason };
  const mine = (result.orders || [])
    .filter(o => normEmail(o.customerEmail) === norm)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!mine.length) return { available: true, hasOrder: false };
  const last = mine[0];
  const items = (last.lineItems || [])
    .filter(li => li.variantId)         // solo lo que se puede volver a comprar
    .map(li => ({
      variantId: li.variantId,
      name: li.title,
      qty: li.qty,
      price: li.unitPrice || 0,
      image: li.image || null,
      brand: li.vendor || '',
    }));
  return {
    available: true,
    hasOrder: items.length > 0,
    order: { name: last.name, createdAt: last.createdAt, items },
  };
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

// POST /api/mayo-products — catálogo mayorista filtrado por nivel del cliente.
// El nivel se resuelve SERVER-SIDE desde los tags del cliente (por email), no
// se confía en el cliente. MAYORISTA1 → solo colección "MAYORISTA EX";
// MAYORISTA (o guest del equipo) → todos los productos mayoristas.
// POST /api/service-request — solicitud de servicio (reposición / capacitación /
// limpieza de líneas). Avisa al equipo, no pasa por carrito.
app.post('/api/service-request', (req, res) => {
  const { product, option, date, time, customer } = req.body || {};
  if (!product) return res.status(400).json({ error: 'Falta el servicio.' });
  const c = customer || {};
  const data = {
    servicio: String(product).slice(0, 120),
    opcion:   option ? String(option).slice(0, 80) : '',
    fecha:    date ? String(date).slice(0, 40) : '',
    hora:     time ? String(time).slice(0, 20) : '',
    cliente:  [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
    email:    c.email || '',
    telefono: c.phone || '',
  };
  try { notifyServiceRequest(data); } catch (e) { console.warn('service-request:', e.message); }
  try { appendLog(LEADS_LOG, { timestamp: new Date().toISOString(), kind: 'service', ...data }); } catch {}
  return res.json({ ok: true });
});

// POST /api/mundial-backup — backup server-side de los pronósticos del Mundial.
// Se llama desde el form de /pages/mundial ANTES de mandar al checkout, así los
// datos quedan a salvo aunque iDTE/Flapp sobrescriba los atributos del pedido.
function loadMundialBackups(){ return readLog(MUNDIAL_BACKUP_FILE); }
// Recuperación fija (bundled en el repo): pronósticos rescatados de un export
// del 24-jun antes de que iDTE los borrara. Se cruzan por número de pedido.
let _mundialRecovery = null;
function loadMundialRecovery(){
  if (_mundialRecovery) return _mundialRecovery;
  try {
    const raw = readFileSync(join(__dirname, 'mundial-recovery.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    _mundialRecovery = Array.isArray(parsed.records) ? parsed.records : [];
  } catch { _mundialRecovery = []; }
  return _mundialRecovery;
}
const pickField = (obj, keys) => {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
};
// Composición del pack → texto legible. Acepta objeto {estilo:cantidad} o array.
function packToText(pack){
  if (!pack) return '';
  try {
    if (Array.isArray(pack)) {
      return pack.map(x => ({ n: Number(x.cantidad ?? x.qty ?? x.cantidad), e: x.estilo ?? x.style ?? x.nombre ?? x.name }))
        .filter(x => x.n > 0 && x.e).map(x => `${x.n}× ${x.e}`).join(' · ');
    }
    if (typeof pack === 'object') {
      return Object.entries(pack).map(([k, v]) => ({ n: Number(v), e: k })).filter(x => x.n > 0 && x.e).map(x => `${x.n}× ${x.e}`).join(' · ');
    }
    return String(pack);
  } catch { return ''; }
}

app.post('/api/mundial-backup', (req, res) => {
  const b = req.body || {};
  const rec = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    email:    normEmail(pickField(b, ['email', 'correo', 'mail'])),
    nombre:   pickField(b, ['nombre', 'name', 'nombre_apellido', 'fullName']).slice(0, 160),
    telefono: pickField(b, ['telefono', 'phone', 'fono', 'celular']).slice(0, 60),
    primero:  pickField(b, ['primero', 'primer', 'primer_lugar', 'first', 'campeon']).slice(0, 80),
    segundo:  pickField(b, ['segundo', 'segundo_lugar', 'second']).slice(0, 80),
    tercero:  pickField(b, ['tercero', 'tercer', 'tercer_lugar', 'third']).slice(0, 80),
    goleador: pickField(b, ['goleador', 'scorer', 'goal', 'pichichi']).slice(0, 80),
    pack:     b.pack ?? b.composicion ?? b.composition ?? null,
    // Referencia única que también viaja como propiedad oculta de la línea del
    // pack (_zorbo_ref). Permite cruzar el backup con el pedido SIN pedirle email
    // ni datos extra al cliente (las line item properties no las pisa iDTE).
    ref:      pickField(b, ['ref', 'zorbo_ref', '_zorbo_ref']).slice(0, 80),
    order:    pickField(b, ['order', 'pedido', 'order_name', 'orderName']).slice(0, 40),
    cartToken: pickField(b, ['cartToken', 'cart_token', 'token']).slice(0, 120),
  };
  // Guardamos también el payload crudo como red de seguridad (si es chico).
  try { const s = JSON.stringify(b); if (s.length < 20000) rec.raw = b; } catch {}
  try { appendLog(MUNDIAL_BACKUP_FILE, rec); } catch (e) { console.warn('mundial-backup:', e.message); }
  return res.json({ ok: true, id: rec.id });
});

app.post('/api/mayo-products', async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify aún no está conectado. Falta SHOPIFY_ADMIN_TOKEN.' });
  }
  const email = normEmail(req.body && req.body.email);
  try {
    const all = await loadProductsCache(req.body && req.body.refresh === true) || [];
    let level = email ? (await getCustomerMayoLevel(email)) : null;
    // Sin email (preview ?mayo=guest del equipo) o sin tag reconocido → 'all'.
    if (!level) level = 'all';

    if (level === 'ex') {
      const ex = await loadMayoExProductIds(false);
      // Si la colección no se puede resolver, NO mostramos todo el catálogo
      // (rompería la restricción). Devolvemos vacío + motivo para el frontend.
      const products = (ex.available && ex.found)
        ? all.filter(p => ex.ids.has(String(p.id)) && String(p.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        : [];
      return res.json({
        level, restricted: true, collection: MAYO_EX_TITLE,
        exAvailable: !!(ex.available && ex.found),
        reason: (ex.available && ex.found) ? undefined : (ex.reason || `No se encontró la colección "${MAYO_EX_TITLE}".`),
        count: products.length, products,
      });
    }
    const products = filterProducts(all, 'b2b');
    return res.json({ level, restricted: false, count: products.length, products });
  } catch (e) {
    console.error('mayo-products error:', e.message);
    return res.status(500).json({ error: e.message });
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

// POST /api/checkout — crea un carrito Storefront ASOCIADO al cliente logueado
// (buyerIdentity con su customerAccessToken). El checkout que devuelve queda
// con el cliente iniciado sesión (su email/condiciones), no como invitado.
// Si no se manda token (B2C), igual crea el carrito como invitado.
app.post('/api/checkout', async (req, res) => {
  if (!process.env.SHOPIFY_STOREFRONT_TOKEN) {
    return res.status(503).json({ error: 'Checkout no configurado. Falta SHOPIFY_STOREFRONT_TOKEN.' });
  }
  const { items, token, discount, attributes } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Carrito vacío.' });
  try {
    const lines = items
      .filter(i => i && i.variantId)
      .map(i => ({
        merchandiseId: `gid://shopify/ProductVariant/${String(i.variantId).replace(/\D/g, '')}`,
        quantity: Math.max(1, parseInt(i.qty, 10) || 1),
      }))
      .filter(l => /\d/.test(l.merchandiseId));
    if (!lines.length) return res.status(400).json({ error: 'Sin productos válidos.' });

    const input = { lines };
    if (token) input.buyerIdentity = { customerAccessToken: String(token) };
    if (discount) input.discountCodes = [String(discount)];
    if (Array.isArray(attributes) && attributes.length) {
      input.attributes = attributes
        .filter(a => a && a.key)
        .map(a => ({ key: String(a.key), value: String(a.value ?? '') }));
    }

    const data = await shopifyStorefrontFetch(`
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id checkoutUrl }
          userErrors { field message }
        }
      }`, { input });

    const r = data && data.data && data.data.cartCreate;
    const errs = (r && r.userErrors) || [];
    if (!r || !r.cart || errs.length) {
      // Si el token venció o es inválido, reintenta SIN token (invitado).
      if (token) {
        const retry = await shopifyStorefrontFetch(`
          mutation cartCreate($input: CartInput!) {
            cartCreate(input: $input) { cart { checkoutUrl } userErrors { message } }
          }`, { input: { ...input, buyerIdentity: undefined } });
        const rr = retry && retry.data && retry.data.cartCreate;
        if (rr && rr.cart && rr.cart.checkoutUrl) return res.json({ checkoutUrl: rr.cart.checkoutUrl, guest: true });
      }
      return res.status(400).json({ error: (errs[0] && errs[0].message) || 'No se pudo crear el checkout.' });
    }
    return res.json({ checkoutUrl: r.cart.checkoutUrl });
  } catch (e) {
    console.error('checkout error:', e.message);
    return res.status(500).json({ error: 'Error creando el checkout.' });
  }
});

// ─── Static frontend ──────────────────────────────────────────────────────────

// Modo de tienda: 'both' (default), 'mayorista' (solo B2B, oculta B2C al público)
// o 'b2c'. Controlado por env var STOREFRONT_MODE. Para previsualizar B2C
// mientras esté oculto, abrir / con ?preview=b2c (chequeo en el frontend).
const STOREFRONT_MODE = (() => {
  const v = String(process.env.STOREFRONT_MODE || 'both').toLowerCase();
  return ['both','mayorista','b2c'].includes(v) ? v : 'both';
})();

// Inyecta el modo en el <head> del index.html antes de servir el archivo
// estático, así el frontend sabe el modo sin tener que esperar un fetch.
function serveIndexWithMode(req, res, next){
  // En k-bros.cl el "/" es la puerta K-BROS (panel.html), no el marketplace.
  // Este guard va acá porque esta ruta se registra ANTES que el resto del ruteo
  // por dominio; sin él, k-bros.cl/ caía siempre en el index del marketplace.
  if (isKbros(req)) return sendPanel(req, res);
  try {
    const path = join(__dirname, 'public', 'index.html');
    let html = readFileSync(path, 'utf8');
    const marker = `<script>window.__STOREFRONT_MODE__ = ${JSON.stringify(STOREFRONT_MODE)};</script>`;
    html = html.replace('</head>', marker + '\n</head>');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { next(e); }
}
app.get(['/', '/index.html'], serveIndexWithMode);

// ── Cara pública de K-BROS (dominio k-bros.cl) sobre la MISMA app ──
// Todo (código, env vars, volumen, data) vive en un solo servicio. Con k-bros.cl
// apuntado a esta misma app, el "/" en k-bros.cl muestra la puerta de K-BROS
// (landing + login → /admin), mientras zorbo.cl sigue sirviendo el marketplace.
// El login usa la auth existente (POST /admin/login). Sin app nueva ni env nuevas.
const KBROS_HOST = /(^|\.)k-bros\.cl$/i;
// Host real detrás de proxies (Cloudflare/Railway): x-forwarded-host suele traer el
// dominio original; si no, cae al Host header o req.hostname. Saca lista y puerto.
const hostOf = (req) => String(req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname || '').split(',')[0].split(':')[0].trim().toLowerCase();
const isKbros = (req) => KBROS_HOST.test(hostOf(req));
// no-store: la puerta K-BROS nunca se cachea en Cloudflare (evita que k-bros.cl
// sirva una copia vieja del marketplace). El HTML es liviano, no necesita caché.
const sendPanel = (req, res) => { res.set('Cache-Control', 'no-store, must-revalidate'); res.sendFile(join(__dirname, 'public', 'panel.html')); };
// ── El admin vive SOLO en k-bros.cl ──────────────────────────────────────────
// zorbo.cl es únicamente la tienda: su /admin, /login y /panel quedan cerrados.
// Puerta de emergencia: el dominio interno de Railway (*.up.railway.app) y
// localhost siguen abiertos, así el dueño no se queda sin acceso si k-bros.cl
// (DNS/Cloudflare) llegara a caerse. No cambia nada de la lógica/data del admin.
const isEmergencyHost = (req) => { const h = hostOf(req); return /\.railway\.app$/.test(h) || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/.test(h); };
const ADMIN_DOOR_PATH = /^\/(admin|login|panel)(\/|$)/i;
app.use((req, res, next) => {
  if (ADMIN_DOOR_PATH.test(req.path) && !isKbros(req) && !isEmergencyHost(req)) {
    // En la tienda (zorbo.cl) el panel no existe: HTML → al marketplace; API → 404.
    if (wantsHtml(req)) return res.redirect(302, '/');
    return res.status(404).json({ error: 'No encontrado.' });
  }
  next();
});
// El "/" ya lo maneja serveIndexWithMode (con guard isKbros) unas líneas arriba.
app.get(['/login', '/panel'], sendPanel);

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

// Credenciales del panel. Idealmente se setean en Railway como ADMIN_USER /
// ADMIN_PASSWORD. Si no están, caen a un default para no dejar el panel
// inaccesible — CAMBIALAS en producción seteando las env vars.
const ADMIN_USER_DEFAULT = 'zorbo';
const ADMIN_PASSWORD_DEFAULT = 'zorbo2026';
function adminCreds(){
  return {
    user: (process.env.ADMIN_USER || ADMIN_USER_DEFAULT),
    pass: (process.env.ADMIN_PASSWORD || ADMIN_PASSWORD_DEFAULT),
  };
}
function isAdminConfigured(){
  return true; // siempre hay credenciales (env o default)
}
// Usuarios con rol LIMITADO "costeo": solo ven el módulo Costeo de carta, y dentro
// solo pueden EDITAR Recetas base y Platos/Tragos. Cada uno acotado a UN servicio
// (svc): Mao → comida, Raúl → barra. Ven ambos, pero editan solo el suyo.
const COSTEO_USERS = {
  'mcastillo@grupomilsabores.com': { svc: 'comida' },
  'rquispe@kairosdrinks.com': { svc: 'barra' },
};
const COSTEO_USERS_PASS = 'Kairos2026.-';
// ¿Puede el rol "costeo" tocar esta request? Ve todo lo de costeo (GET) pero solo
// edita recetas base y platos/tragos, y solo en su servicio (sess.costeoSvc).
function costeoRoleAllows(req, sess){
  const p = req.path, m = req.method;
  if (p === '/admin' || p === '/admin/' || p === '/admin/me' || p === '/admin/logout') return true;
  if (p.startsWith('/admin/costeo')) {
    if (m === 'GET' || m === 'HEAD') return true; // ver todo (comida y barra)
    const isEdit = /^\/admin\/costeo\/recetas(\/|$)/.test(p) || /^\/admin\/costeo\/platos(\/|$)/.test(p);
    if (!isEdit) return false; // insumos, carta/asignar, secciones, precio-real → solo ver
    const scope = sess && sess.costeoSvc; // 'comida' | 'barra' | undefined(=todo)
    if (scope) {
      const svc = (req.query.svc === 'barra') ? 'barra' : 'comida';
      if (svc !== scope) return false;
    }
    return true;
  }
  return false;
}

function wantsHtml(req){
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

// Login ACTIVO por defecto. Para abrir el panel sin login (debug) setear
// ADMIN_AUTH_ENABLED=0.
function requireAdmin(req, res, next){
  if (process.env.ADMIN_AUTH_ENABLED === '0') return next();
  const sess = adminSessionFor(req);
  if (!sess) {
    if (wantsHtml(req)) return res.redirect(302, '/login');
    return res.status(401).json({ error: 'No autorizado. Iniciá sesión en /login.' });
  }
  // Rol limitado "costeo": bloquea todo lo que no sea ver/editar lo permitido.
  if (sess.role === 'costeo' && !costeoRoleAllows(req, sess)) {
    if (wantsHtml(req)) return res.redirect(302, '/admin');
    return res.status(403).json({ error: 'No tenés permiso para editar esta sección.' });
  }
  return next();
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
  // La puerta de acceso ahora es la de K-BROS (/login). El login viejo de ZORBO
  // queda deprecado: cualquier link/bookmark a /admin/login cae en la puerta K-BROS.
  res.redirect(302, '/login');
});

app.post('/admin/login', async (req, res) => {
  if (!isAdminConfigured()) return res.status(503).json({ error: 'Panel admin no configurado.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Faltan credenciales.' });
  }

  const creds = adminCreds();
  const userLc = username.trim().toLowerCase();

  // Admin completo (env/default), cuenta individual propia, o usuario de rol "costeo".
  let account = null;
  if (safeStrEq(userLc, String(creds.user).trim().toLowerCase()) && safeStrEq(password, String(creds.pass))) {
    account = { username: creds.user, role: 'admin' };
  } else {
    const teamMember = teamFindByUsername(userLc);
    if (teamMember && teamMember.passwordHash && teamVerifyPassword(password, teamMember.passwordHash)) {
      account = { username: teamMember.username, role: teamMember.role || 'admin', teamId: teamMember.id };
    } else if (COSTEO_USERS[userLc] && safeStrEq(password, COSTEO_USERS_PASS)) {
      account = { username: userLc, role: 'costeo', costeoSvc: COSTEO_USERS[userLc].svc };
    }
  }

  // Pequeño delay artificial para frenar fuerza bruta
  await new Promise(r => setTimeout(r, 250));

  if (!account) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  // Perfil (nombre/apodo) enganchado por username, sin importar la puerta de login.
  const profile = teamProfileFor(account.username) || {};
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_TTL_MS;
  ADMIN_SESSIONS.set(token, {
    username: account.username, role: account.role, costeoSvc: account.costeoSvc, teamId: account.teamId || null,
    nombre: profile.nombre || '', apodo: profile.apodo || '', expiresAt,
  });

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

// ─── Cuentas individuales de equipo (saludo personalizado) ─────────────────
// ADITIVO — no reemplaza ni toca ADMIN_USER/ADMIN_PASSWORD: esa credencial
// compartida sigue funcionando exactamente igual. Esto agrega:
//  (a) cuentas propias reales (usuario + clave propios) para el rol admin, y
//  (b) "perfiles" (nombre/apodo) que se enganchan por username a CUALQUIER
//      login exitoso (compartido, propio o costeo) para poder saludar por
//      apodo sin importar por qué puerta entró la persona.
const TEAM_FILE = join(PROMPTS_EFFECTIVE_DIR, 'team.json');
function teamHashPassword(pw){
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function teamVerifyPassword(pw, stored){
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  let calc; try { calc = scryptSync(pw, salt, 64); } catch { return false; }
  const orig = Buffer.from(hash, 'hex');
  if (calc.length !== orig.length) return false;
  return timingSafeEqual(calc, orig);
}
let TEAM_ID_SEQ = 0;
function teamNewId(){ TEAM_ID_SEQ = (TEAM_ID_SEQ + 1) % 100000; return 'team_' + Date.now().toString(36) + '_' + TEAM_ID_SEQ.toString(36); }
function teamSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(TEAM_FILE, JSON.stringify(d, null, 2)); }
function teamLoad(){
  let data = { members: [] };
  try { if (existsSync(TEAM_FILE)) { const p = JSON.parse(readFileSync(TEAM_FILE, 'utf-8')); if (Array.isArray(p.members)) data.members = p.members; } }
  catch (e) { console.warn('team load:', e.message); }
  // Semilla única: perfil de Arie enganchado al username ya usado hoy para
  // entrar (la credencial compartida) — sin contraseña propia (profileOnly),
  // así el saludo funciona apenas se despliega, sin tocar el login existente.
  if (!data.members.some(m => (m.username || '').toLowerCase() === 'afinkelstein@kairosdrinks.com')) {
    data.members.push({
      id: teamNewId(), username: 'afinkelstein@kairosdrinks.com', passwordHash: null, profileOnly: true,
      nombre: 'Arie', apellido: '', apodo: 'Dj Cookie', role: 'admin', createdAt: Date.now(),
    });
    teamSave(data);
  }
  return data;
}
function teamFindByUsername(username){
  const uLc = String(username || '').trim().toLowerCase();
  if (!uLc) return null;
  return teamLoad().members.find(m => (m.username || '').toLowerCase() === uLc) || null;
}
// Perfil (nombre/apodo) para decorar el saludo, sin importar la puerta de login.
function teamProfileFor(username){
  const m = teamFindByUsername(username);
  if (!m) return null;
  return { nombre: m.nombre || '', apellido: m.apellido || '', apodo: m.apodo || '' };
}

// ─── Rutas protegidas ───────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(join(__dirname, 'admin-views', 'admin.html'));
});

app.get('/admin/me', requireAdmin, (req, res) => {
  const s = adminSessionFor(req);
  if (!s) return res.json({ username: null, role: 'admin', costeoSvc: null, nombre: '', apodo: '', teamId: null, expiresAt: null }); // auth deshabilitada
  res.json({ username: s.username, role: s.role || 'admin', costeoSvc: s.costeoSvc || null, nombre: s.nombre || '', apodo: s.apodo || '', teamId: s.teamId || null, expiresAt: s.expiresAt });
});

// ─── Cuentas de equipo: alta / edición / listado ────────────────────────────
// Mismo permiso plano que el resto del panel (cualquier sesión admin puede
// gestionar el equipo, igual que ya puede tocar cualquier otra sección).
const teamPublic = (m) => ({ id: m.id, username: m.username, nombre: m.nombre || '', apellido: m.apellido || '', apodo: m.apodo || '', role: m.role || 'admin', profileOnly: !!m.profileOnly, createdAt: m.createdAt || null });
app.get('/admin/team', requireAdmin, (req, res) => {
  res.json({ members: teamLoad().members.map(teamPublic) });
});
app.post('/admin/team', requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = costosStr(b.username, 120).toLowerCase();
  const password = String(b.password || '');
  const nombre = costosStr(b.nombre, 80);
  const apellido = costosStr(b.apellido, 80);
  const apodo = costosStr(b.apodo, 40);
  if (!username || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) return res.status(400).json({ error: 'Ingresá un correo válido como usuario.' });
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  const data = teamLoad();
  if (data.members.some(m => (m.username || '').toLowerCase() === username)) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
  const member = { id: teamNewId(), username, passwordHash: teamHashPassword(password), profileOnly: false, nombre, apellido, apodo, role: 'admin', createdAt: Date.now() };
  data.members.push(member); teamSave(data);
  res.json({ ok: true, member: teamPublic(member) });
});
app.put('/admin/team/me', requireAdmin, (req, res) => {
  const s = adminSessionFor(req);
  if (!s) return res.status(401).json({ error: 'No autorizado.' });
  const data = teamLoad();
  let member = (s.teamId && data.members.find(m => m.id === s.teamId)) || data.members.find(m => (m.username || '').toLowerCase() === String(s.username || '').toLowerCase());
  if (!member) {
    // Primera vez que esta persona edita su perfil (venía solo del saludo genérico): lo crea profileOnly.
    member = { id: teamNewId(), username: s.username, passwordHash: null, profileOnly: true, nombre: '', apellido: '', apodo: '', role: s.role || 'admin', createdAt: Date.now() };
    data.members.push(member);
  }
  const b = req.body || {};
  if (b.nombre != null) member.nombre = costosStr(b.nombre, 80);
  if (b.apellido != null) member.apellido = costosStr(b.apellido, 80);
  if (b.apodo != null) member.apodo = costosStr(b.apodo, 40);
  teamSave(data);
  // Refresca la sesión activa (en memoria) para que el saludo se actualice sin
  // requerir un nuevo login: adminSessionFor() devuelve una copia, así que
  // mutamos el objeto real del Map directamente.
  const rawSession = ADMIN_SESSIONS.get(s.token);
  if (rawSession) { rawSession.nombre = member.nombre; rawSession.apodo = member.apodo; rawSession.teamId = member.id; }
  res.json({ ok: true, member: teamPublic(member) });
});
app.put('/admin/team/:id', requireAdmin, (req, res) => {
  const data = teamLoad();
  const member = data.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'No se encontró la cuenta.' });
  const b = req.body || {};
  if (b.nombre != null) member.nombre = costosStr(b.nombre, 80);
  if (b.apellido != null) member.apellido = costosStr(b.apellido, 80);
  if (b.apodo != null) member.apodo = costosStr(b.apodo, 40);
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    member.passwordHash = teamHashPassword(String(b.password)); member.profileOnly = false;
  }
  teamSave(data);
  res.json({ ok: true, member: teamPublic(member) });
});
app.delete('/admin/team/:id', requireAdmin, (req, res) => {
  const data = teamLoad();
  const n = data.members.length;
  data.members = data.members.filter(m => m.id !== req.params.id);
  if (data.members.length === n) return res.status(404).json({ error: 'No se encontró la cuenta.' });
  teamSave(data);
  res.json({ ok: true });
});

app.get('/admin/brand/:seccion', requireAdmin, (req, res) => {
  const key = req.params.seccion;
  let file = PROMPT_SECTIONS[key];
  let custom = false;
  if (!file) {
    if (!isValidBrandKey(key) || !getCustomBrands().some(b => b.key === key))
      return res.status(404).json({ error: 'Sección no encontrada' });
    file = customBrandFile(key); custom = true;
  }
  try {
    const content = custom ? readPromptFileSafe(file) : readPromptFile(file);
    res.json({ seccion: key, content, custom });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo: ' + e.message });
  }
});

app.post('/admin/save-brand', requireAdmin, (req, res) => {
  const { seccion, contenido } = req.body || {};
  let file = PROMPT_SECTIONS[seccion];
  if (!file) {
    if (!isValidBrandKey(seccion) || !getCustomBrands().some(b => b.key === seccion))
      return res.status(400).json({ error: 'Sección inválida' });
    file = customBrandFile(seccion);
  }
  if (typeof contenido !== 'string') return res.status(400).json({ error: 'Contenido inválido' });
  if (contenido.length > 200000) return res.status(413).json({ error: 'Contenido demasiado grande' });
  try {
    writePromptFile(file, contenido);
    res.json({ ok: true, seccion, bytes: contenido.length });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando: ' + e.message });
  }
});

// Genera el knowledge .md de una marca custom a partir de un cuestionario,
// usando el mismo tono/estructura que las marcas existentes.
app.post('/admin/brand/:key/generate', requireAdmin, async (req, res) => {
  const key = req.params.key;
  if (!isValidBrandKey(key)) return res.status(400).json({ error: 'Marca inválida.' });
  const brand = getCustomBrands().find(b => b.key === key);
  if (!brand) return res.status(404).json({ error: 'Marca no encontrada. Creala primero en Página web → Marcas.' });
  const a = req.body || {};
  const about    = String(a.about || '').slice(0, 4000);
  const products = String(a.products || '').slice(0, 4000);
  const audience = String(a.audience || '').slice(0, 1500);
  const extra    = String(a.extra || '').slice(0, 4000);
  if (!about && !products && !extra) return res.status(400).json({ error: 'Contanos algo de la marca para poder generar.' });

  const ref = readPromptFileSafe('firulais.md') || readPromptFileSafe('kairos.md') || '';
  const sys = `Sos redactor de Zorbo, una botillería virtual artesanal chilena. Escribí el "knowledge" de UNA marca para que el asistente Zorbot la conozca y la venda. Reglas de tono: español de Chile, cercano y juvenil chileno, profesional, sin tecnicismos excesivos; NUNCA uses signos de apertura (¿ ¡), solo los de cierre. Devolvé SOLO Markdown, con secciones encabezadas por "## ". Cubrí: identidad e historia, personalidad y tono, línea de productos (estilos y formatos), ocasiones de consumo y maridajes, cómo recomendarla y hacer cross-sell con las otras marcas, y datos clave. NO inventes precios ni productos puntuales que el usuario no haya mencionado; si falta info, escribí en general. Empezá con un encabezado "## ${brand.label}".`;
  const userMsg = `Marca: ${brand.label}\nVendor en Shopify: ${brand.vendor}\n\n¿De qué se trata la marca?\n${about}\n\n¿Qué productos tiene?\n${products}\n\nPúblico / ocasiones de consumo:\n${audience}\n\nMás contexto libre:\n${extra}\n\n--- Ejemplo de estructura y tono de otra marca (NO copies el contenido, solo el formato) ---\n${ref.slice(0, 4000)}`;
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
    });
    const md = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!md) throw new Error('La IA no devolvió contenido.');
    writePromptFile(customBrandFile(key), md + '\n');
    res.json({ ok: true, content: md + '\n' });
  } catch (e) {
    res.status(500).json({ error: 'Error generando: ' + String(e.message || e).slice(0, 300) });
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
function brandFromProduct(p, customBrands){
  const v = String(p.vendor || '').toLowerCase();
  const t = String(p.title  || '').toLowerCase();
  const tags = (p.tags || []).map(x => String(x).toLowerCase());
  // Marcas custom (creadas desde el panel) ganan por coincidencia de vendor.
  if (Array.isArray(customBrands)) {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const nv = norm(p.vendor);
    if (nv) for (const b of customBrands) {
      const bv = norm(b.vendor);
      if (bv && (nv === bv || nv.includes(bv) || bv.includes(nv))) return b.key;
    }
  }
  if (v.includes('kairos')   || tags.includes('kairos')   || t.includes('kairos'))   return 'kairos';
  if (v.includes('firulais') || tags.includes('firulais') || t.includes('firulais')) return 'firulais';
  if (v.includes('banny')    || tags.includes('banny')    || t.includes('banny'))    return 'banny';
  return 'otros';
}

// ─── Marcas custom (definidas en Página web → Marcas) ─────────────────────────
const BASE_BRAND_KEYS = ['kairos', 'firulais', 'banny'];
function getCustomBrands(){
  const cfg = loadSiteConfig();
  if (!Array.isArray(cfg.brands)) return [];
  return cfg.brands
    .filter(b => b && b.key && !BASE_BRAND_KEYS.includes(b.key))
    .map(b => ({ key:String(b.key), label:String(b.label || b.key), vendor:String(b.vendor || ''), category:String(b.category || '') }));
}
function isValidBrandKey(k){ return /^[a-z0-9-]{1,40}$/.test(String(k || '')); }
function customBrandFile(key){ return 'brand-' + key + '.md'; }
function readPromptFileSafe(filename){
  try { return readPromptFile(filename); } catch { return ''; }
}

// ─── Config editable del home (franja, banner, botones, marcas) ───────────────
// Lo edita el equipo desde el panel /admin → pestaña "Página web". Vive en el
// volumen. Si el archivo no existe, el home usa sus defaults hardcodeados (no
// cambia nada). Estructura: { version, topbar:{promos:[]}, hero:{desktop:[],
// mobile:[]}, pills:[{label,target}], brands:[{key,label,logo,category,vendor}],
// categories:[{key,title,sub}] }.
const SITE_CONFIG_FILE = join(PROMPTS_EFFECTIVE_DIR, 'site-config.json');

function loadSiteConfig(){
  try {
    if (!existsSync(SITE_CONFIG_FILE)) return {};
    const parsed = JSON.parse(readFileSync(SITE_CONFIG_FILE, 'utf-8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('site config load:', e.message);
    return {};
  }
}
function saveSiteConfig(data){
  if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) {
    mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
  }
  writeFileSync(SITE_CONFIG_FILE, JSON.stringify(data, null, 2));
}

// Sanea/normaliza la config que llega del panel antes de guardar.
function sanitizeSiteConfig(input){
  const c = (input && typeof input === 'object') ? input : {};
  const str = (v, max = 300) => String(v == null ? '' : v).slice(0, max);
  const arrStr = (a, max = 60) => Array.isArray(a) ? a.map(x => str(x)).filter(Boolean).slice(0, max) : [];
  const slug = (v) => str(v, 40).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('cat-' + Math.random().toString(36).slice(2, 7));

  const out = { version: 1 };
  out.topbar = { promos: arrStr(c.topbar?.promos) };
  out.hero = {
    desktop: arrStr(c.hero?.desktop, 20),
    mobile:  arrStr(c.hero?.mobile, 20),
  };
  out.pills = Array.isArray(c.pills) ? c.pills.slice(0, 20).map(p => ({
    label:  str(p?.label, 40),
    target: str(p?.target, 60),
  })).filter(p => p.label && p.target) : [];
  out.categories = Array.isArray(c.categories) ? c.categories.slice(0, 30).map(cat => ({
    key:   cat?.key ? slug(cat.key) : slug(cat?.title),
    title: str(cat?.title, 60),
    sub:   str(cat?.sub, 160),
  })).filter(cat => cat.title) : [];
  out.brands = Array.isArray(c.brands) ? c.brands.slice(0, 40).map(b => ({
    key:      b?.key ? slug(b.key) : slug(b?.label),
    label:    str(b?.label, 60),
    logo:     str(b?.logo, 500),
    category: str(b?.category, 40),
    vendor:   str(b?.vendor, 80),
    target:   str(b?.target, 60),
  })).filter(b => b.label) : [];
  out.categoryOrder = Array.isArray(c.categoryOrder)
    ? c.categoryOrder.map(k => slug(k)).filter(Boolean).slice(0, 40) : [];
  // Texto del bot en el home B2C (bubble de bienvenida arriba).
  out.botWelcome = arrStr(c.botWelcome, 8);

  // Home mayorista (B2B): banner, círculos, orden/títulos de secciones, bienvenida.
  const MAYO_SECTION_KEYS = ['chelasBarril','packs','craftmixBarril','licoresBidon','licoresBotella','otros'];
  const m = (c.mayo && typeof c.mayo === 'object') ? c.mayo : {};
  out.mayo = {
    promos: arrStr(m.promos),
    hero: arrStr(m.hero, 20),
    pills: Array.isArray(m.pills) ? m.pills.slice(0, 20).map(p => ({
      label:  str(p?.label, 40),
      target: str(p?.target, 60),
    })).filter(p => p.label && p.target) : [],
    brands: Array.isArray(m.brands) ? m.brands.slice(0, 40).map(b => ({
      label:  str(b?.label, 60),
      logo:   str(b?.logo, 500),
      target: str(b?.target, 60),
    })).filter(b => b.logo) : [],
    sectionOrder: Array.isArray(m.sectionOrder)
      ? m.sectionOrder.map(k => str(k, 40)).filter(k => MAYO_SECTION_KEYS.includes(k)).slice(0, 10) : [],
    sections: (m.sections && typeof m.sections === 'object')
      ? Object.fromEntries(MAYO_SECTION_KEYS.filter(k => m.sections[k]).map(k => [k, {
          title: str(m.sections[k]?.title, 80),
          sub:   str(m.sections[k]?.sub, 160),
        }])) : {},
    welcome: arrStr(m.welcome, 8),
    landing: {
      title:    str(m.landing?.title, 200),
      subtitle: str(m.landing?.subtitle, 600),
      stats: Array.isArray(m.landing?.stats) ? m.landing.stats.slice(0, 6).map(s => ({
        label: str(s?.label, 40),
        value: str(s?.value, 20),
      })).filter(s => s.label) : [],
    },
  };
  return out;
}

// Pública: el home la lee al cargar. Devuelve {} si no hay config (usa defaults).
app.get('/api/site-config', (_req, res) => {
  const cfg = loadSiteConfig();
  cfg.storefrontMode = STOREFRONT_MODE;
  res.json(cfg);
});

app.get('/admin/site-config', requireAdmin, (_req, res) => {
  res.json(loadSiteConfig());
});

app.post('/admin/site-config', requireAdmin, (req, res) => {
  try {
    const clean = sanitizeSiteConfig(req.body);
    saveSiteConfig(clean);
    res.json({ ok: true, config: clean });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando config: ' + e.message });
  }
});

// Subida genérica de imágenes (logos de marca, fotos de banner) → /uploads.
// No está atada a un producto, a diferencia de /admin/products/:id/upload.
app.post('/admin/upload', requireAdmin, (req, res) => {
  const { filename = '', contentType = '', dataBase64 = '' } = req.body || {};
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'Falta el archivo.' });
  }
  const ext = UPLOAD_TYPES[String(contentType).toLowerCase()];
  if (!ext || ext === 'pdf') return res.status(415).json({ error: 'Solo se permiten imágenes (png, jpg, webp, gif).' });
  let buf;
  try { buf = Buffer.from(dataBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'Archivo inválido.' }); }
  if (!buf.length)                   return res.status(400).json({ error: 'Archivo vacío.' });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Máximo 8 MB por archivo.' });
  try {
    const safeName = randomUUID() + '.' + ext;
    writeFileSync(join(UPLOADS_DIR, safeName), buf);
    res.json({ ok: true, url: '/uploads/' + safeName, name: String(filename || ('imagen.' + ext)).slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando archivo: ' + e.message });
  }
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Shopify no está conectado (falta SHOPIFY_ADMIN_TOKEN).' });
  }
  // Sección: minorista = solo productos con tag ZORBO; mayorista = solo MAYORISTA.
  // Default minorista (lo que ve el público en la home).
  const section = String(req.query.section || 'minorista').toLowerCase();
  const requiredTag = section === 'mayorista' ? 'MAYORISTA' : 'ZORBO';
  try {
    const all = await loadProductsCache(String(req.query.refresh || '') === '1');
    if (!all) return res.json({ products: [], section, requiredTag });
    const extras = loadProductExtras();
    const customBrands = getCustomBrands();
    const productCosts = loadDistri().productCosts || {};
    const products = all
      .filter(p => (p.tags || []).map(t => String(t).trim().toUpperCase()).includes(requiredTag))
      .map(p => {
        const ex = extras.items[String(p.id)] || null;
        const pc = productCosts[String(p.id)] || null;
        const tagsUpper = (p.tags || []).map(t => String(t).toUpperCase());
        const isMayorista = tagsUpper.includes('MAYORISTA');
        const isZorbo     = tagsUpper.includes('ZORBO');
        return {
          id:         String(p.id),
          title:      p.title,
          handle:     p.handle,
          vendor:     p.vendor,
          brand:      brandFromProduct(p, customBrands),
          status:     String(p.status || 'ACTIVE').toUpperCase(),
          image:      ex?.image || p.image || null,
          video:      ex?.video || null,
          price:      p.variants?.[0]?.price ? Number(p.variants[0].price) : null,
          compareAt:  p.variants?.[0]?.compareAtPrice ? Number(p.variants[0].compareAtPrice) : null,
          variants:   (p.variants || []).length,
          isMayorista, isZorbo,
          ilaPct:     pc && Number.isFinite(pc.ilaPct) ? Number(pc.ilaPct) : 0,
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

// ─── Estado de Resultado CD · DIAGNÓSTICO (read-only) ────────────────────────
// Solo lee de Shopify (órdenes + clientes + productos), NO escribe nada. Sirve
// para validar, antes de construir el módulo: detección de transferencias por
// código de descuento, clasificación cliente→punto de venta→grupo, mapeo
// producto→estilo→litros→tipo, y los tests contra el Excel de julio.
const cdNorm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
let CD_PDV_CACHE = null;
function cdLoadPdv(){
  if (CD_PDV_CACHE) return CD_PDV_CACHE;
  try { CD_PDV_CACHE = JSON.parse(readFileSync(join(__dirname, 'cd-pdv-seed.json'), 'utf-8')).puntos || []; }
  catch { CD_PDV_CACHE = []; }
  return CD_PDV_CACHE;
}
// Precios de transferencia (config; hoy fijos, luego editables en el módulo).
const CD_PRECIOS = { cerveza: 1830, gin: 7447, ron: 6617, despacho: 1033 };
// Referencias del Excel por mes (para el % de desvío del diagnóstico). "base" =
// facturación base sin los "otros ingresos" ni Antofagasta.
const CD_EXCEL_REF = {
  '2026-07': { garden_lt_cerveza: 2700, garden_gin: 160, garden_ron: 140, garden_valor: 10157900, web: 949112, cd_kairos_base: 30496638, cruzada_base: 5695733, ingresos_total: 52085893 },
  '2026-06': { garden_lt_cerveza: 5280, web: 5001805, cd_kairos_base: 29673041, cruzada_base: 15659104 },
};
const ESTADO_MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const estadoMonthLabel = (m) => { const [y, mo] = String(m).split('-'); return (ESTADO_MESES[+mo] || m) + ' ' + y; };
// Códigos de descuento con que se marcan las transferencias 100% off.
const CD_TRANSFER_CODES = { PEDIDOGARDENVSP: 'garden', PEDIDOSBADASSPA: 'badass' };
// Diccionario DEFINITIVO código→bucket. Match EXACTO (===), nunca substring:
// "PEDIDOGARDENVSP" contiene "VSP" pero NO es "PEDIDOSVSP" (Vespucio), y
// "PEDIDOSBADASSPA" contiene "PA" pero NO es "PEDIDOSPA" (Parque Arauco).
// Transferencias = locales propios (se revaluan). Cruzada/CD Kairos = ORIGINAL.
const CD_CODE_MAP = {
  // Transferencias (locales propios)
  PEDIDOGARDENVSP: { bucket: 'transfer', loc: 'garden' },
  PEDIDOSBADASSPA: { bucket: 'transfer', loc: 'badass' },
  // Ventas Cruzada (500 Sabores)
  PEDIDOSTOBALABA: { bucket: 'cruzada', pdv: 'Plaza Tobalaba' },
  PEDIDOSVSP: { bucket: 'cruzada', pdv: 'Plaza Vespucio' },
  PEDIDOSOESTE: { bucket: 'cruzada', pdv: 'Plaza Oeste' },
  PEDIDOSNORTE: { bucket: 'cruzada', pdv: 'Plaza Norte' },
  'PEDIDOSEGAÑA': { bucket: 'cruzada', pdv: 'Plaza Egaña' },
  PEDIDOSEGANA: { bucket: 'cruzada', pdv: 'Plaza Egaña' },
  PEDIDOSDOMINICOS: { bucket: 'cruzada', pdv: 'Dominicos' },
  // CD Kairos (resto de mayoristas)
  PEDIDOSCOSTANERA: { bucket: 'cd_kairos' },
  PEDIDOSSKYCOSTANERA: { bucket: 'cd_kairos' },
  PEDIDOSALTO: { bucket: 'cd_kairos' },
  PEDIDOSPANORAMICO: { bucket: 'cd_kairos' },
  PEDIDOSFLORIDACENTER: { bucket: 'cd_kairos' },
  PEDIDOSHOTELW: { bucket: 'cd_kairos' },
  PEDIDOSLADEHESA: { bucket: 'cd_kairos' },
  PEDIDOSPA: { bucket: 'cd_kairos' },
  PEDIDOOSAKA: { bucket: 'cd_kairos' },
  PEDIDOSOPEN: { bucket: 'cd_kairos' },
  PEDIDOSMARINA: { bucket: 'cd_kairos' },
  PEDIDOSBULNES: { bucket: 'cd_kairos' },
  PEDIDOSNUEVACOSTANERA: { bucket: 'cd_kairos' },
  // Retail (Walmart) — ③ Retail
  PEDIDOSWALMART: { bucket: 'walmart' },
};
// Resuelve el bucket de un pedido por sus códigos (match EXACTO en el diccionario).
// Devuelve {bucket, loc?, pdv?, code} conocido, o {bucket:'codigo_nuevo', code} si
// hay un PEDIDO*/PEDIDOS* no mapeado, o null (retail: código retail o sin código).
function cdBucketForCodes(codes){
  for (const c of codes) if (CD_CODE_MAP[c]) return { code: c, ...CD_CODE_MAP[c] };
  const nuevo = codes.find(c => /^PEDIDOS?/.test(c));
  if (nuevo) return { code: nuevo, bucket: 'codigo_nuevo' };
  return null;
}
// Zona (sector) que aporta cada código (para resolver el PdV del pedido HORECA).
const CD_CODE_ZONA = {
  PEDIDOSTOBALABA: 'Plaza Tobalaba', PEDIDOSVSP: 'Plaza Vespucio', PEDIDOSOESTE: 'Plaza oeste', PEDIDOSNORTE: 'Plaza norte', 'PEDIDOSEGAÑA': 'Plaza Egaña', PEDIDOSEGANA: 'Plaza Egaña', PEDIDOSDOMINICOS: 'Dominicos',
  PEDIDOSCOSTANERA: 'Costanera Center', PEDIDOSSKYCOSTANERA: 'Costanera Center', PEDIDOSALTO: 'Alto las condes', PEDIDOSPANORAMICO: 'Panoramico', PEDIDOSFLORIDACENTER: 'Florida center', PEDIDOSHOTELW: 'Hotel W', PEDIDOSLADEHESA: 'Portal La Dehesa', PEDIDOSPA: 'Parque Arauco', PEDIDOSOPEN: 'Open Kennedy', PEDIDOSMARINA: 'Viña (Mall)', PEDIDOSBULNES: 'Bulnes/Vivo imperio', PEDIDOSNUEVACOSTANERA: 'Nueva Costanera',
};
// Índice del maestro de puntos de venta (memoizado): por local (marca) y por zona.
let CD_PDV_INDEX = null;
function cdPdvIndex(){
  if (CD_PDV_INDEX) return CD_PDV_INDEX;
  const byLocal = new Map(), byZona = new Map();
  for (const p of cdLoadPdv()) {
    const ln = cdNorm(p.local).replace(/\s+/g, '');
    if (ln.length >= 5 && !byLocal.has(ln)) byLocal.set(ln, p);
    // Alias de cliente: nombres con los que el cliente aparece en Shopify pero que
    // no son el nombre del local (ej. "Helar Valdiviezo" → Osaka).
    for (const a of (p.alias || [])) { const an = cdNorm(a).replace(/\s+/g, ''); if (an.length >= 5 && !byLocal.has(an)) byLocal.set(an, p); }
    const zn = cdNorm(p.zona);
    if (zn) { if (!byZona.has(zn)) byZona.set(zn, []); byZona.get(zn).push(p); }
  }
  CD_PDV_INDEX = { byLocal, byZona };
  return CD_PDV_INDEX;
}
// Grupo/razón representativos de una zona. Grupo: si la zona tiene locales del
// Grupo Mil Sabores (food halls), un pedido por código de esa zona es del food
// hall → mil_sabores. Los bares retail "otros" de la misma zona ordenan con su
// propio nombre (se resuelven por local exacto, no por zona). Razón: la más
// frecuente ENTRE los mil_sabores si los hay, si no la más frecuente.
function cdZonaRepr(pdvs){
  const cnt = (arr, k) => { const m = {}; arr.forEach(x => { const v = x[k] || ''; if (v) m[v] = (m[v] || 0) + 1; }); return (Object.entries(m).sort((a, b) => b[1] - a[1])[0] || [''])[0]; };
  const mil = pdvs.filter(p => p.grupo === 'mil_sabores');
  const grupo = mil.length ? 'mil_sabores' : 'otros';
  const razon = cnt(mil.length ? mil : pdvs, 'razon');
  return { grupo, razon };
}
// Resuelve un pedido HORECA a su punto de venta: {grupo, sector, razon, marca}.
// marca (local exacto) solo si el cliente lo nombra; si es a nivel mall, marca=''.
function cdResolveHoreca(o, cm, bucketName){
  const idx = cdPdvIndex();
  const hay = cdNorm((o.customer && o.customer.displayName) + ' ' + (o.customer && o.customer.defaultAddress && o.customer.defaultAddress.company || '')).replace(/\s+/g, '');
  // 1) Local (marca) exacto por el nombre del cliente.
  for (const [ln, p] of idx.byLocal) if (hay.includes(ln)) return { grupo: p.grupo, sector: p.zona, razon: p.razon, marca: p.local };
  // 2) Zona: del código o del nombre del cliente.
  let zona = (cm && cm.pdv) || (cm && cm.code && CD_CODE_ZONA[cm.code]) || '';
  if (!zona) { for (const [zn, arr] of idx.byZona) if (zn.length >= 5 && hay.includes(zn.replace(/\s+/g, ''))) { zona = arr[0].zona; break; } }
  if (zona && idx.byZona.has(cdNorm(zona))) { const arr = idx.byZona.get(cdNorm(zona)); const r = cdZonaRepr(arr); return { grupo: r.grupo, sector: zona, razon: r.razon, marca: '' }; }
  // 3) Sin resolver: Cruzada = 500 Sabores (mil_sabores); CD Kairos sin match = otros.
  if (bucketName === 'ventas_cruzada') return { grupo: 'mil_sabores', sector: '', razon: '500 Sabores SpA', marca: '' };
  return { grupo: 'otros', sector: '', razon: '', marca: '' };
}
// ── Venta web: proveedor (vendor de Shopify) + detalle de entrega ──
// Las 4 secciones de venta web se dividen por el vendor del producto. Lo que no
// caiga en las 4 marcas conocidas va a "Otros".
const CD_WEB_PROVEEDORES = ['Kairos Brewing', 'Firulais', 'Banny', 'ZORBO'];
function cdWebProveedor(vendor){
  const nv = cdNorm(vendor);
  if (/kairos/.test(nv)) return 'Kairos Brewing';
  if (/firulais/.test(nv)) return 'Firulais';
  if (/banny/.test(nv)) return 'Banny';
  if (/zorbo/.test(nv)) return 'ZORBO';
  return 'Otros';
}
// Normaliza el courier a PKT1 / Flapp. "Other" en Shopify = Flapp (según el
// mapeo real de la tienda). Deja el texto tal cual si es otro courier.
function cdCourierName(s){
  const n = cdNorm(s);
  if (!n) return '';
  if (/pkt\s*1|pkt1|\bpkt\b/.test(n)) return 'PKT1';
  if (/flapp/.test(n)) return 'Flapp';
  if (/^other$|^otro$|generic/.test(n)) return 'Flapp'; // "Other" = Flapp
  return String(s || '').trim();
}
// ¿Pedido mayorista sin código? Se detecta por el método de envío "Mayorista"
// (ej. "Mayorista – A acordar con el cliente"). Estos NO son venta online: van a
// HORECA (mall). Sin shippingLine (nivel base) no se puede detectar → queda en web.
function cdEsMayorista(o){
  const s = ((o.shippingLine && o.shippingLine.title) || '') + ' ' + ((o.shippingLine && o.shippingLine.code) || '');
  return /mayorista/i.test(s);
}
// Normaliza a la tienda física de Kairos: Antofagasta / Garden / Badass, o ''.
function cdKairosTienda(s){
  const n = cdNorm(s);
  if (/antofa/.test(n)) return 'Antofagasta';
  if (/badass/.test(n)) return 'Badass';
  if (/garden/.test(n)) return 'Garden';
  return '';
}
// De un pedido web, resuelve el canal de entrega en 3:
//  - Tienda: compra presencial (Kioskify / POS)
//  - Retiro: compra online con retiro en un local Kairos (Garden/Badass/Antofa)
//  - Despacho: envío por courier (PKT1 / Flapp)
function cdWebDetalle(o){
  const fos = (o.fulfillmentOrders && o.fulfillmentOrders.nodes) || [];
  const fo = fos.find(f => f && f.deliveryMethod) || fos[0] || null;
  const methodType = (fo && fo.deliveryMethod && fo.deliveryMethod.methodType) || '';
  const shipTitle = (o.shippingLine && o.shippingLine.title) || '';
  const shipCode = (o.shippingLine && o.shippingLine.code) || '';
  let trackCompany = '', fulfLoc = '';
  for (const f of (o.fulfillments || [])) {
    if (!trackCompany) { const c = (f.trackingInfo || []).map(t => t && t.company).filter(Boolean)[0]; if (c) trackCompany = c; }
    if (!fulfLoc && f && f.location && f.location.name) fulfLoc = f.location.name;
  }
  const retailLoc = (o.retailLocation && o.retailLocation.name) || '';
  // SUCURSAL: de dónde sale / dónde ocurre el pedido = location del fulfillment
  // (assignedLocation → location del fulfillment → retailLocation). Es SEPARADA del
  // MÉTODO de envío: en un despacho Flapp que sale de Kairos Badass, la sucursal es
  // Badass pero el método es Flapp (despacho, no retiro).
  const asignada = (fo && fo.assignedLocation && fo.assignedLocation.name) || fulfLoc || retailLoc || '';
  // El MÉTODO de entrega elegido (shippingLine). Si el método nombra un local Kairos
  // (Garden/Badass/Antofagasta) es un RETIRO en esa tienda.
  const metodoTxt = shipTitle || shipCode || '';
  const metodoTienda = cdKairosTienda(metodoTxt);
  const sucursalTienda = metodoTienda || cdKairosTienda(asignada);           // Badass/Garden/Antofagasta
  const sucursal = sucursalTienda ? ('Kairos ' + sucursalTienda) : (asignada || '');
  const appName = (o.app && o.app.name) || '';
  const source = o.sourceName || '';
  // 1) Presencial: Kioskify / POS (por el ORIGEN del pedido).
  if (/kioskify|point of sale|\bpos\b/i.test(appName + ' ' + source)) {
    return { entrega: 'Tienda', canal: 'tienda', tienda: sucursalTienda, sucursal, local: sucursal || 'Kioskify', courier: '', origen: sucursal, metodo: appName || 'Kioskify' };
  }
  // 2) Retiro: el MÉTODO es un local Kairos, o es PICK_UP, o dice retiro/recoger.
  const esRetiro = !!metodoTienda || /PICK_UP|PICKUP/i.test(methodType) || /retiro|pickup|recog|recoge/i.test(shipTitle + ' ' + shipCode);
  if (esRetiro) {
    const tienda = metodoTienda || sucursalTienda;
    const suc = tienda ? ('Kairos ' + tienda) : sucursal;
    return { entrega: 'Retiro', canal: 'retiro', tienda, sucursal: suc, local: suc, courier: '', origen: suc, metodo: shipTitle };
  }
  // 3) Despacho: SOLO Flapp ("Otro"/"Other") o PKT1. Sale desde la sucursal.
  const courier = cdCourierName(trackCompany || shipTitle || shipCode);
  return { entrega: 'Despacho', canal: 'despacho', tienda: sucursalTienda, sucursal, local: '', courier, origen: sucursal, metodo: shipTitle };
}
// Diccionario keyword→{estilo,tipo}. El primero que matchee en el título gana.
// Lo que no matchee queda "sin mapear" (no se adivina).
const CD_ESTILO_DICT = [
  { k: 'rey de copas', estilo: 'Ron Rey de Copas', tipo: 'ron' },
  { k: 'ron', estilo: 'Ron Rey de Copas', tipo: 'ron' },
  { k: 'gin', estilo: 'Gin', tipo: 'gin' },
  { k: 'banny', estilo: 'Gin', tipo: 'gin' },
  { k: 'neipa', estilo: 'NEIPA', tipo: 'cerveza' },
  { k: 'weizen', estilo: 'Weizen', tipo: 'cerveza' },
  { k: 'golden', estilo: 'Golden', tipo: 'cerveza' },
  { k: 'pils', estilo: 'Pils', tipo: 'cerveza' },
  { k: 'apa', estilo: 'APA', tipo: 'cerveza' },
  { k: 'alerta roja', estilo: 'Red', tipo: 'cerveza' },
  { k: 'red', estilo: 'Red', tipo: 'cerveza' },
  { k: 'oatmeal', estilo: 'Obertura', tipo: 'cerveza' },
  { k: 'obertura', estilo: 'Obertura', tipo: 'cerveza' },
  { k: 'hoyo en uno', estilo: 'Hoppy Lagger', tipo: 'cerveza' },
  { k: 'hoppy', estilo: 'Hoppy Lagger', tipo: 'cerveza' },
  { k: 'samba', estilo: 'IPA', tipo: 'cerveza' },
  { k: 'ipa', estilo: 'IPA', tipo: 'cerveza' },
  { k: 'kenny bell', estilo: 'Ambar', tipo: 'cerveza' },
  { k: 'ambar', estilo: 'Ambar', tipo: 'cerveza' },
  { k: 'cachupin', estilo: 'Cachupín', tipo: 'cerveza' },
  { k: 'firulais', estilo: 'Cachupín', tipo: 'cerveza' },
  { k: 'chelada', estilo: 'Cachupín', tipo: 'cerveza' },
  { k: 'osagui', estilo: 'Osagui', tipo: 'cerveza' },
  { k: 'acholada', estilo: 'Acholada', tipo: 'cerveza' },
  { k: 'good bye my lover', estilo: 'Colección de Artista', tipo: 'cerveza' },
  { k: 'valle nevado', estilo: 'Colección de Artista', tipo: 'cerveza' },
  { k: 'goat father', estilo: 'Colección de Artista', tipo: 'cerveza' },
  { k: 'goatfather', estilo: 'Colección de Artista', tipo: 'cerveza' },
  { k: 'goattfather', estilo: 'Colección de Artista', tipo: 'cerveza' },
  { k: 'american amber ale', estilo: 'Ambar', tipo: 'cerveza' },
  { k: 'amber ale', estilo: 'Ambar', tipo: 'cerveza' },
  { k: 'amber', estilo: 'Ambar', tipo: 'cerveza' },
  { k: 'stout', estilo: 'Obertura', tipo: 'cerveza' },
];
function cdEstiloOf(prodTitle, varTitle){
  const t = ' ' + cdNorm((prodTitle || '') + ' ' + (varTitle || '')) + ' ';
  for (const d of CD_ESTILO_DICT) if (t.includes(' ' + cdNorm(d.k) + ' ')) return { estilo: d.estilo, tipo: d.tipo };
  return null;
}
// Litros por unidad de la variante, derivado del título. Reglas reales de Shopify:
//   - Barriles/growlers: el número + "Litros"/"lt"/"l" (ej "Barril ... :: 30 Litros")
//   - Latas/botellas: tamaño sub-litro en cc/cm3/ml (ej "Lata (473 cm3)")
//     multiplicado por la cantidad del pack (6/12/24 Pack, N latas, caja N).
function cdLitrosUnidad(prodTitle, varTitle){
  const t = ((prodTitle || '') + ' ' + (varTitle || '')).toLowerCase();
  // Litros explícitos (barril, growler): "30 litros", "30 lt", "30 l", "1,5 l".
  const litM = t.match(/(\d+(?:[.,]\d+)?)\s*(?:litros?|lts?|l)\b/);
  // Tamaño sub-litro: cc / cm3 / ml.
  const subM = t.match(/(\d+)\s*(?:cm3|cc|ml)\b/);
  if (litM && !subM) return parseFloat(litM[1].replace(',', '.'));
  const size = subM ? parseInt(subM[1], 10) / 1000 : 0.473;
  // Cantidad de unidades del formato (pack N / N latas / caja N). Barril y lata suelta = 1.
  let n = 1;
  const p = (varTitle || '').match(/(\d+)\s*pack/i) || t.match(/(\d+)\s*pack/) || t.match(/(\d+)\s*latas?/) || t.match(/caja\s*(\d+)/);
  if (p) n = parseInt(p[1], 10);
  return Math.round(n * size * 1000) / 1000;
}
async function cdShopifyGraph(query, variables){
  return shopifyAdminFetch('/graphql.json', { method: 'POST', body: JSON.stringify({ query, variables }) });
}
// Órdenes de un mes con código de descuento + tags del cliente + líneas.
// Campos base (solo read_orders). El `vendor` del producto es lo que en Shopify
// marca el proveedor (Kairos Brewing / Firulais / Banny / ZORBO) → se usa para
// dividir la venta web por proveedor.
const CD_ORDER_FIELDS_BASE = `
      id name createdAt discountCodes sourceName
      totalPriceSet{ shopMoney{ amount } }
      customer{ id displayName email tags defaultAddress{ company address1 city province } }
      lineItems(first:50){ nodes{
        quantity
        originalTotalSet{ shopMoney{ amount } }
        variant{ id title sku }
        product{ id title vendor tags }
      } }`;
// Detalle de entrega (courier + método + tienda POS) — read_orders. `retailLocation`
// es la tienda física donde se hizo la venta presencial (Kioskify / POS).
const CD_ORDER_FIELDS_SHIP = `
      displayFulfillmentStatus
      app{ name }
      retailLocation{ name }
      shippingLine{ title code }
      fulfillments(first:5){ trackingInfo{ company } }`;
// + Sucursal desde la que sale el pedido (location del fulfillment). Puede requerir
// read_locations; si falta, se cae al nivel SHIP (sin sucursal).
const CD_ORDER_FIELDS_LOC = `
      displayFulfillmentStatus
      app{ name }
      retailLocation{ name }
      shippingLine{ title code }
      fulfillments(first:5){ trackingInfo{ company } location{ name } }`;
// + Método de entrega fiable (retiro/despacho) y assignedLocation. Necesita el
// scope de fulfillment orders. assignedLocation.name es un string.
const CD_ORDER_FIELDS_FULL = CD_ORDER_FIELDS_LOC + `
      fulfillmentOrders(first:5){ nodes{ deliveryMethod{ methodType } assignedLocation{ name } } }`;
const cdOrdersQuery = (extra) => `query($cursor:String,$q:String){
  orders(first:100, after:$cursor, query:$q, sortKey:CREATED_AT){
    edges{ cursor node{${CD_ORDER_FIELDS_BASE}${extra || ''}
    } }
    pageInfo{ hasNextPage }
  }
}`;
// Niveles de detalle: FULL (retiro/origen), SHIP (courier), BASE (solo core).
// Se prueba el más completo primero y se cae al siguiente si falta scope, así
// los números del Estado nunca se rompen aunque falte un permiso de fulfillment.
const CD_ORDER_TIERS = [
  { key: 'full', extra: CD_ORDER_FIELDS_FULL },
  { key: 'loc', extra: CD_ORDER_FIELDS_LOC },
  { key: 'ship', extra: CD_ORDER_FIELDS_SHIP },
  { key: 'base', extra: '' },
];
let cdOrdersTier = null; // se memoiza el primer nivel que funciona
const CD_ORDERS_QUERY = cdOrdersQuery(CD_ORDER_FIELDS_FULL);
// Rango por defecto de un mes (día 1 al último). Devuelve {from, to} en YYYY-MM-DD.
function cdMonthRange(month){
  const [y, mo] = month.split('-').map(Number);
  const from = `${y}-${String(mo).padStart(2, '0')}-01`;
  const endD = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const to = `${y}-${String(mo).padStart(2, '0')}-${String(endD).padStart(2, '0')}`;
  return { from, to };
}
// Carga órdenes de Shopify entre dos fechas exactas (inclusive), YYYY-MM-DD.
async function cdLoadOrdersRange(from, to){
  const q = `created_at:>=${from} created_at:<=${to} status:any`;
  // Elegí el nivel de detalle (una vez). Si falla por scope de fulfillment,
  // bajá de nivel; el core (read_orders) siempre queda disponible.
  if (!cdOrdersTier) {
    for (const tier of CD_ORDER_TIERS) {
      const resp = await cdShopifyGraph(cdOrdersQuery(tier.extra), { cursor: null, q });
      if (!resp.errors) { cdOrdersTier = tier; break; }
      const msg = JSON.stringify(resp.errors);
      const esScope = /fulfillment|access denied|scope|permission|doesn't exist|Field/i.test(msg);
      // Sólo bajamos de nivel ante error de permiso/campo de fulfillment. Si es
      // otro error, o ya estamos en el nivel base, se propaga.
      if (!esScope || tier.key === 'base') throw new Error(msg);
    }
  }
  const query = cdOrdersQuery(cdOrdersTier.extra);
  const orders = []; let cursor = null;
  for (let page = 0; page < 20; page++) {
    const resp = await cdShopifyGraph(query, { cursor, q });
    if (resp.errors) throw new Error(JSON.stringify(resp.errors));
    const conn = resp.data.orders;
    for (const e of conn.edges) orders.push(e.node);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
  }
  return orders;
}
async function cdLoadMonthOrders(month){ const { from, to } = cdMonthRange(month); return cdLoadOrdersRange(from, to); }
// Histograma de tags de clientes (para ver si hay uno que distinga 500 Sabores/zonas).
const CD_CUSTOMERS_QUERY = `query($cursor:String){
  customers(first:200, after:$cursor){
    edges{ cursor node{ id displayName tags } }
    pageInfo{ hasNextPage }
  }
}`;
async function cdCustomerTagHistogram(){
  const hist = {}; let cursor = null; let total = 0;
  for (let page = 0; page < 30; page++) {
    const resp = await cdShopifyGraph(CD_CUSTOMERS_QUERY, { cursor });
    if (resp.errors) throw new Error(JSON.stringify(resp.errors));
    const conn = resp.data.customers;
    for (const e of conn.edges) {
      total++;
      (e.node.tags || []).forEach(t => { const k = String(t).trim(); if (k) hist[k] = (hist[k] || 0) + 1; });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.edges[conn.edges.length - 1].cursor;
  }
  return { totalClientes: total, tags: Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) };
}
// Clasifica un cliente Shopify → punto de venta → grupo (cruzada/cd_kairos), usando
// el maestro. Devuelve {grupo, pdv, estado: limpio|ambiguo|sin_clasificar}.
function cdClassifyCustomer(customer){
  // SOLO nombre del cliente + company. NO la dirección: las calles/comunas de
  // clientes retail (personas) matcheaban zonas por error. Nunca se defaultea a
  // mayorista: si no matchea un local o zona del maestro, es retail.
  const name = cdNorm(customer && customer.displayName);
  const company = cdNorm(customer && customer.defaultAddress && customer.defaultAddress.company);
  if (!name && !company) return { grupo: null, estado: 'sin_clasificar', pdv: null };
  if (/500 sabores/.test(name) || /500 sabores/.test(company)) return { grupo: 'cruzada', estado: 'limpio', pdv: '500 Sabores SpA' };
  if (/kairos garden/.test(name) || /badass/.test(name)) return { grupo: 'transfer', estado: 'limpio', pdv: customer.displayName };
  const pdv = cdLoadPdv();
  // Comparación sin espacios (tolera "Mallplaza" vs "Mall plaza") y solo nombres
  // de local/zona de ≥5 chars (evita ruido de nombres cortos tipo Muu/Mila/Udon).
  const squish = s => cdNorm(s).replace(/\s+/g, '');
  const hay = squish((customer && customer.displayName) + ' ' + (company ? customer.defaultAddress.company : ''));
  const matchLocal = p => { const k = squish(p.local); return k.length >= 5 && hay.includes(k); };
  const matchZona = p => { const k = squish(p.zona); return k.length >= 5 && hay.includes(k); };
  const cand = pdv.filter(p => matchLocal(p) || matchZona(p));
  if (!cand.length) return { grupo: null, estado: 'sin_clasificar', pdv: null };
  const grupos = [...new Set(cand.map(p => p.grupo))];
  if (grupos.length === 1) {
    const best = cand.find(matchZona) || cand[0];
    return { grupo: grupos[0], estado: 'limpio', pdv: best.local + ' (' + best.zona + ')' };
  }
  // Local ambiguo entre grupos: desambiguar por la ZONA presente en el nombre.
  const byZona = cand.filter(matchZona);
  const zg = [...new Set(byZona.map(p => p.grupo))];
  if (zg.length === 1) return { grupo: zg[0], estado: 'limpio', pdv: byZona[0].local + ' (' + byZona[0].zona + ')' };
  return { grupo: null, estado: 'ambiguo', pdv: cand.slice(0, 4).map(p => p.local + '/' + p.zona).join(' | ') };
}
const cdMoney = (n) => Math.round(Number(n) || 0);
const cdR3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
// Núcleo compartido: computa los números de Shopify de un mes (transferencias
// revaluadas, buckets con cobrado/original, y el DETALLE por pedido para el
// drill-down). Precios de transferencia configurables (precios). Un pedido va a
// UN bucket por su código exacto; transferencias primero.
async function cdShopifyMonth(month, precios, rango){
  const P = precios || CD_PRECIOS;
  const r = (rango && rango.from && rango.to) ? rango : cdMonthRange(month);
  const orders = await cdLoadOrdersRange(r.from, r.to);
  const estiloUnmapped = new Map();
  const litrosByEstiloGrupo = {};
  const addLitros = (g, e, t, lt) => { litrosByEstiloGrupo[g] = litrosByEstiloGrupo[g] || {}; const k = e + '|' + t; litrosByEstiloGrupo[g][k] = (litrosByEstiloGrupo[g][k] || 0) + lt; };
  const transfers = { garden: { litros: 0, valor: 0, ordenes: 0, porCodigo: 0, porCliente: 0, pedidos: [] }, badass: { litros: 0, valor: 0, ordenes: 0, porCodigo: 0, porCliente: 0, pedidos: [] } };
  const bucket = {
    transferencias: { n: 0, cobrado: 0, original: 0, usa: 'revaluado', pedidos: [] },
    ventas_cruzada: { n: 0, cobrado: 0, original: 0, usa: 'original', pedidos: [] },
    cd_kairos_mall: { n: 0, cobrado: 0, original: 0, usa: 'original', pedidos: [] },
    retail: { n: 0, cobrado: 0, original: 0, usa: 'cobrado', pedidos: [] },
    walmart: { n: 0, cobrado: 0, original: 0, usa: 'original', pedidos: [] },
    codigo_nuevo: { n: 0, cobrado: 0, original: 0, usa: '—', pedidos: [] },
  };
  let totalCobrado = 0, totalOriginal = 0, sinCodigo = 0;
  const codesHist = {}; const codigosNuevos = new Set();
  // Venta por día (misma base de valorización que usa totalIngresos por canal:
  // original en HORECA/walmart, cobrado en retail, revaluado a precio de
  // transferencia en garden/badass) — insumo del gráfico "ventas en el tiempo".
  const porDia = {};
  const addDia = (fecha, monto) => { if (!fecha || !monto) return; porDia[fecha] = (porDia[fecha] || 0) + Math.round(monto); };
  for (const o of orders) {
    const codes = (o.discountCodes || []).map(c => String(c).toUpperCase().trim()).filter(Boolean);
    if (!codes.length) sinCodigo++;
    codes.forEach(c => { codesHist[c] = (codesHist[c] || 0) + 1; });
    const cm = cdBucketForCodes(codes);
    const cn = cdNorm(o.customer && o.customer.displayName);
    const byCust = /kairos garden/.test(cn) ? 'garden' : /badass/.test(cn) ? 'badass' : null;
    let bucketName, transferLocal = null;
    if (cm && cm.bucket === 'transfer') { transferLocal = cm.loc; bucketName = 'transferencias'; transfers[transferLocal].porCodigo++; }
    else if (byCust && !(cm && cm.bucket && cm.bucket !== 'codigo_nuevo')) { transferLocal = byCust; bucketName = 'transferencias'; transfers[transferLocal].porCliente++; }
    else if (cm && cm.bucket === 'cruzada') bucketName = 'ventas_cruzada';
    else if (cm && cm.bucket === 'cd_kairos') bucketName = 'cd_kairos_mall';
    else if (cm && cm.bucket === 'walmart') bucketName = 'walmart';
    else if (cm && cm.bucket === 'codigo_nuevo') { bucketName = 'codigo_nuevo'; codigosNuevos.add(cm.code); }
    else if (cdEsMayorista(o)) bucketName = 'cd_kairos_mall'; // mayorista sin código → HORECA, no web
    else bucketName = 'retail';
    const orig = (o.lineItems && o.lineItems.nodes || []).reduce((a, li) => a + parseFloat((li.originalTotalSet && li.originalTotalSet.shopMoney && li.originalTotalSet.shopMoney.amount) || 0), 0);
    const total = parseFloat((o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount) || 0);
    totalCobrado += total; totalOriginal += orig;
    const rec = { pedido: o.name || '', fecha: (o.createdAt || '').slice(0, 10), cliente: (o.customer && o.customer.displayName) || '—', codigo: codes.join(', ') || '—', original: cdMoney(orig), cobrado: cdMoney(total) };
    // HORECA (cd_kairos + cruzada): resolver punto de venta + litros + detalle para el filtrado.
    if (bucketName === 'cd_kairos_mall' || bucketName === 'ventas_cruzada') {
      const pdv = cdResolveHoreca(o, cm, bucketName);
      let litros = 0; const det = [];
      for (const li of (o.lineItems && o.lineItems.nodes) || []) {
        const lt = (Number(li.quantity) || 0) * cdLitrosUnidad(li.product && li.product.title, li.variant && li.variant.title);
        litros += lt;
        if (li.product) det.push({ producto: li.product.title, variante: (li.variant && li.variant.title) || '', cantidad: li.quantity, litros: cdR3(lt), estilo: (cdEstiloOf(li.product.title, li.variant && li.variant.title) || {}).estilo || 'sin mapear' });
      }
      rec.grupo = pdv.grupo; rec.sector = pdv.sector; rec.razon = pdv.razon; rec.marca = pdv.marca; rec.litros = cdR3(litros); rec.detalle = det;
      // El "plata" del pedido HORECA es el ORIGINAL (pre-descuento).
      rec.monto = rec.original;
      addDia(rec.fecha, rec.original);
    }
    // VENTA WEB (retail) y RETAIL WALMART: dividir por proveedor/marca (vendor de
    // Shopify) + detalle de lo pedido. La web además trae detalle de entrega.
    if (bucketName === 'retail' || bucketName === 'walmart') {
      if (bucketName === 'retail') rec.web = cdWebDetalle(o);
      const porProv = {}; const det = [];
      for (const li of (o.lineItems && o.lineItems.nodes) || []) {
        const prov = cdWebProveedor(li.product && li.product.vendor);
        const monto = parseFloat((li.originalTotalSet && li.originalTotalSet.shopMoney && li.originalTotalSet.shopMoney.amount) || 0);
        porProv[prov] = (porProv[prov] || 0) + monto;
        det.push({ producto: (li.product && li.product.title) || '', variante: (li.variant && li.variant.title) || '', cantidad: li.quantity, vendor: (li.product && li.product.vendor) || '', proveedor: prov, monto: cdMoney(monto) });
      }
      rec.detalle = det;
      rec.porProveedor = Object.entries(porProv).map(([proveedor, monto]) => ({ proveedor, monto: cdMoney(monto) }));
      rec.proveedor = (rec.porProveedor.slice().sort((a, b) => b.monto - a.monto)[0] || {}).proveedor || 'Otros';
      addDia(rec.fecha, bucketName === 'retail' ? total : orig);
    }
    if (transferLocal) {
      const lineas = [];
      let valorTransfer = 0;
      for (const li of (o.lineItems && o.lineItems.nodes) || []) {
        const est = cdEstiloOf(li.product && li.product.title, li.variant && li.variant.title);
        const ltU = cdLitrosUnidad(li.product && li.product.title, li.variant && li.variant.title);
        const litros = (Number(li.quantity) || 0) * ltU;
        if (est) {
          addLitros(transferLocal, est.estilo, est.tipo, litros);
          valorTransfer += litros * (P[est.tipo] || P.cerveza) + P.despacho * litros;
          lineas.push({ producto: (li.product && li.product.title) || '', variante: (li.variant && li.variant.title) || '', cantidad: li.quantity, estilo: est.estilo, tipo: est.tipo, litros: cdR3(litros) });
        }
        else if (li.product) { const k = li.product.title + ' :: ' + (li.variant ? li.variant.title : ''); estiloUnmapped.set(k, (estiloUnmapped.get(k) || 0) + 1); lineas.push({ producto: li.product.title, variante: (li.variant && li.variant.title) || '', cantidad: li.quantity, estilo: 'sin mapear', litros: cdR3(litros) }); }
      }
      transfers[transferLocal].ordenes++;
      transfers[transferLocal].pedidos.push({ ...rec, lineas });
      addDia(rec.fecha, valorTransfer);
    }
    bucket[bucketName].n++; bucket[bucketName].cobrado += total; bucket[bucketName].original += orig;
    if (bucket[bucketName].pedidos.length < 500) bucket[bucketName].pedidos.push(rec);
  }
  for (const k of Object.keys(bucket)) { bucket[k].cobrado = cdMoney(bucket[k].cobrado); bucket[k].original = cdMoney(bucket[k].original); }
  bucket.retail.promedio = bucket.retail.n ? cdMoney(bucket.retail.cobrado / bucket.retail.n) : 0;
  for (const loc of ['garden', 'badass']) {
    const byE = litrosByEstiloGrupo[loc] || {};
    let litros = 0, valor = 0; const porTipo = { cerveza: 0, gin: 0, ron: 0 };
    for (const [key, lt] of Object.entries(byE)) {
      const tipo = key.split('|')[1];
      const precio = P[tipo] || P.cerveza;
      litros += lt; valor += lt * precio + P.despacho * lt;
      porTipo[tipo] = (porTipo[tipo] || 0) + lt;
    }
    transfers[loc].litros = cdR3(litros);
    transfers[loc].litrosCerveza = cdR3(porTipo.cerveza); transfers[loc].litrosGin = cdR3(porTipo.gin); transfers[loc].litrosRon = cdR3(porTipo.ron);
    transfers[loc].valor = cdMoney(valor);
    transfers[loc].porEstilo = Object.entries(byE).map(([k, lt]) => ({ estilo: k.split('|')[0], tipo: k.split('|')[1], litros: cdR3(lt) })).sort((a, b) => b.litros - a.litros);
  }
  return { ordenes: orders.length, transfers, bucket, totalCobrado: cdMoney(totalCobrado), totalOriginal: cdMoney(totalOriginal), sinCodigo, codesHist, codigosNuevos: [...codigosNuevos], sinMapear: [...estiloUnmapped.entries()].map(([producto, lineas]) => ({ producto, lineas })), porDia };
}
app.get('/admin/cd/diag', requireAdmin, async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) return res.status(503).json({ error: 'Shopify no conectado.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : '2026-07';
  try {
    const tagsHist = await cdCustomerTagHistogram();
    const m = await cdShopifyMonth(month);
    const { transfers, bucket } = m;
    res.json({
      month,
      a_tags: tagsHist,
      e_transferencias: transfers,
      e_test_garden: { esperado: { litros_cerveza: 2700, gin: 160, ron: 140, valor: 10157900 }, obtenido: transfers.garden },
      e_sin_mapear: m.sinMapear,
      hard_total: {
        ordenes: m.ordenes, total_cobrado_shopify: m.totalCobrado, total_original_pre_descuento: m.totalOriginal,
        excel: { ingresos_julio: 52085893, cd_kairos: 30496638, ventas_cruzada: 5695733, ventas_web: 949112 },
        desglose: bucket,
        valor_para_estado: { transferencias_revaluado: transfers.garden.valor + transfers.badass.valor, ventas_cruzada: bucket.ventas_cruzada.original, cd_kairos_mall: bucket.cd_kairos_mall.original, retail: bucket.retail.cobrado },
      },
      g_codigos_descuento: Object.entries(m.codesHist).sort((a, b) => b[1] - a[1]).map(([codigo, pedidos]) => ({ codigo, pedidos, bucket: (CD_CODE_MAP[codigo] && CD_CODE_MAP[codigo].bucket) || (/^PEDIDOS?/.test(codigo) ? 'CODIGO NUEVO SIN CLASIFICAR' : 'retail') })),
      g_codigos_nuevos_sin_clasificar: m.codigosNuevos,
      desvios_vs_excel: (() => {
        const ref = CD_EXCEL_REF[month]; if (!ref) return { nota: 'No hay referencia de Excel para este mes.' };
        const pct = (obt, exc) => (exc ? Math.round(((obt - exc) / exc) * 1000) / 10 + '%' : '—');
        return {
          garden_cerveza_lt: { shopify: transfers.garden.litrosCerveza, excel: ref.garden_lt_cerveza, desvio: pct(transfers.garden.litrosCerveza, ref.garden_lt_cerveza) },
          retail_web: { shopify: bucket.retail.cobrado, excel: ref.web, desvio: pct(bucket.retail.cobrado, ref.web) },
          cd_kairos_original: { shopify: bucket.cd_kairos_mall.original, excel: ref.cd_kairos_base, desvio: pct(bucket.cd_kairos_mall.original, ref.cd_kairos_base) },
          ventas_cruzada_original: { shopify: bucket.ventas_cruzada.original, excel: ref.cruzada_base, desvio: pct(bucket.ventas_cruzada.original, ref.cruzada_base) },
        };
      })(),
      meta: { ordenes_mes: m.ordenes, pedidos_sin_codigo: m.sinCodigo, precios: CD_PRECIOS, codigos_transfer: CD_TRANSFER_CODES },
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/read_orders|read_customers|access denied|scope|not approved/i.test(msg)) return res.status(403).json({ error: 'Falta permiso Shopify (read_orders/read_customers). Re-autorizá la app.' });
    res.status(500).json({ error: 'Error en diagnóstico: ' + msg.slice(0, 400) });
  }
});

// ─── ESTADO DE RESULTADO MENSUAL (CD) ───────────────────────────────────────
// Ingresos: parte AUTOMÁTICA de Shopify (transferencias revaluadas, cruzada y
// cd_kairos original, retail cobrado) + parte MANUAL (líneas con nombre). El
// número automático NO se edita: si falta plata, se agrega una línea. Persistencia
// por mes en JSON. Los costos/gastos llegan en la parte 2.
const ESTADO_FILE = join(PROMPTS_EFFECTIVE_DIR, 'estado-resultado.json');
const estadoNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const estadoStr = (v, m = 200) => String(v == null ? '' : v).trim().slice(0, m);
function estadoLineList(arr, fields){ return (Array.isArray(arr) ? arr : []).map(x => { const o = {}; fields.forEach(f => { o[f.k] = f.num ? estadoNum(x && x[f.k]) : estadoStr(x && x[f.k], f.max || 200); }); return o; }); }
const F_FUERA = [{ k: 'desc' }, { k: 'factura', max: 60 }, { k: 'fecha', max: 20 }, { k: 'monto', num: true }];
const F_NC = [{ k: 'proveedor' }, { k: 'fecha', max: 20 }, { k: 'factura', max: 60 }, { k: 'monto', num: true }];
function estadoNormPeriodo(p){
  p = p || {}; const pr = p.preciosTransfer || {};
  const ck = p.cdKairos || {}; const vc = p.ventasCruzada || {}; const wm = p.walmart || {};
  return {
    preciosTransfer: { cerveza: estadoNum(pr.cerveza || CD_PRECIOS.cerveza), gin: estadoNum(pr.gin || CD_PRECIOS.gin), ron: estadoNum(pr.ron || CD_PRECIOS.ron), despacho: estadoNum(pr.despacho || CD_PRECIOS.despacho) },
    cdKairos: { fueraShopify: estadoLineList(ck.fueraShopify, F_FUERA), notasCredito: estadoLineList(ck.notasCredito, F_NC), otrosIngresos: estadoLineList(ck.otrosIngresos, [{ k: 'desc' }, { k: 'monto', num: true }]) },
    ventasCruzada: { fueraShopify: estadoLineList(vc.fueraShopify, F_FUERA) },
    antofagasta: estadoLineList(p.antofagasta, [{ k: 'estilo', max: 60 }, { k: 'litros', num: true }]),
    activo: estadoNum(p.activo),
    walmart: { cajas: estadoNum(wm.cajas), valorCaja: estadoNum(wm.valorCaja || 48409) },
  };
}
function estadoLoad(){ try { if (!existsSync(ESTADO_FILE)) return { version: 1, periodos: {} }; const p = JSON.parse(readFileSync(ESTADO_FILE, 'utf-8')); return { version: 1, periodos: (p && p.periodos) || {} }; } catch (e) { console.warn('estado load:', e.message); return { version: 1, periodos: {} }; } }
function estadoSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(ESTADO_FILE, JSON.stringify(d, null, 2)); }
// Pedidos de Retail (Walmart) hechos en el sistema viejo, ANTES de la
// automatización con PEDIDOSWALMART. Se inyectan en el bucket Walmart como si
// vinieran de Shopify (mismo formato de pedido). Los pedidos nuevos ya entran
// solos por el código, así que esto es solo para los históricos puntuales.
const CD_WALMART_SEED = {
  '2026-07': [
    { pedido: '00004262', fecha: '2026-07-14', cliente: 'Aquavitae', codigo: 'PEDIDOSWALMART', original: 2468808, cobrado: 2468808, proveedor: 'Kairos Brewing', porProveedor: [{ proveedor: 'Kairos Brewing', monto: 2468808 }], detalle: [{ producto: 'Galactic Mission', variante: 'Pack de 24x Lata (473 ml)', cantidad: 51, proveedor: 'Kairos Brewing', monto: 2468808 }] },
  ],
};
// Transferencias a Kairos Garden ANTOFAGASTA hechas en el sistema viejo, antes de
// la automatización con Shopify. Se inyectan en el bucket garden como si vinieran
// de Shopify (mismo formato: pedido con líneas estilo/tipo/litros). El cliente dice
// "Antofagasta" para que caiga en el sub-filtro. Los nuevos entran solos por Shopify.
const CD_GARDEN_SEED = {
  '2026-07': [
    { pedido: '00004263', fecha: '2026-07-14', cliente: 'Kairos Garden Antofagasta', codigo: '', original: 0, cobrado: 0, lineas: [
      { producto: 'Nada Personal', variante: 'Barril 30 lts', cantidad: 15, estilo: 'Nada Personal', tipo: 'cerveza', litros: 450 },
      { producto: 'Galactic Mission', variante: 'Barril PET (20000 ml)', cantidad: 15, estilo: 'Galactic Mission', tipo: 'cerveza', litros: 300 },
      { producto: 'Imperio Perdido', variante: 'Barril 30 lts', cantidad: 3, estilo: 'NEIPA', tipo: 'cerveza', litros: 90 },
      { producto: 'SAMBA', variante: 'Barril 30 lts', cantidad: 6, estilo: 'IPA', tipo: 'cerveza', litros: 180 },
      { producto: 'Alerta Roja', variante: 'Barril 30 lts', cantidad: 3, estilo: 'Red', tipo: 'cerveza', litros: 90 },
      { producto: 'Bidon Ron Rey de copas 20lts', variante: 'Bidón 20 L', cantidad: 2, estilo: 'Ron Rey de Copas', tipo: 'ron', litros: 40 },
      { producto: 'Bidon Gin Banny 20L', variante: 'Bidón 20 L', cantidad: 1, estilo: 'Gin', tipo: 'gin', litros: 20 },
      { producto: 'Goodbye my lover', variante: 'Barril 30 lts', cantidad: 3, estilo: 'Colección de Artista', tipo: 'cerveza', litros: 90 },
      { producto: 'Goodbye my lover', variante: 'Lata (473 ml)', cantidad: 24, estilo: 'Colección de Artista', tipo: 'cerveza', litros: 11.35 },
    ] },
    { pedido: '00004204', fecha: '2026-07-08', cliente: 'Kairos Garden Antofagasta', codigo: '', original: 0, cobrado: 0, lineas: [
      { producto: 'Ritual De La Banana', variante: 'Barril 30 lts', cantidad: 5, estilo: 'Ritual De La Banana', tipo: 'cerveza', litros: 150 },
      { producto: 'Hoyo en uno', variante: 'Barril 30 lts', cantidad: 4, estilo: 'Hoppy Lagger', tipo: 'cerveza', litros: 120 },
      { producto: 'Alerta Roja', variante: 'Barril 30 lts', cantidad: 5, estilo: 'Red', tipo: 'cerveza', litros: 150 },
      { producto: 'Obertura', variante: 'Barril 30 lts', cantidad: 4, estilo: 'Obertura', tipo: 'cerveza', litros: 120 },
      { producto: 'Secret Lab', variante: 'Barril 30 lts', cantidad: 3, estilo: 'Secret Lab', tipo: 'cerveza', litros: 90 },
      { producto: 'Imperio Perdido', variante: 'Barril 30 lts', cantidad: 3, estilo: 'NEIPA', tipo: 'cerveza', litros: 90 },
      { producto: 'SAMBA', variante: 'Barril 30 lts', cantidad: 3, estilo: 'IPA', tipo: 'cerveza', litros: 90 },
      { producto: 'Bidon Ron Rey de copas 20lts', variante: 'Bidón 20 L', cantidad: 2, estilo: 'Ron Rey de Copas', tipo: 'ron', litros: 40 },
      { producto: 'Nada Personal', variante: 'Barril 30 lts', cantidad: 14, estilo: 'Nada Personal', tipo: 'cerveza', litros: 420 },
    ] },
  ],
};
async function estadoResolve(month, rango){
  const all = estadoLoad(); const per = estadoNormPeriodo(all.periodos[month]);
  const precios = per.preciosTransfer;
  const r = (rango && rango.from && rango.to) ? rango : cdMonthRange(month);
  const sh = await cdShopifyMonth(month, precios, r).catch(e => ({ error: String(e.message || e) }));
  const shOk = !sh.error;
  const sum = (arr) => (arr || []).reduce((a, x) => a + (Number(x.monto) || 0), 0);
  const shCd = shOk ? sh.bucket.cd_kairos_mall.original : 0;
  const shCruz = shOk ? sh.bucket.ventas_cruzada.original : 0;
  const shWeb = shOk ? sh.bucket.retail.cobrado : 0;
  const shWalmart = shOk ? sh.bucket.walmart.original : 0;
  const ratio = (shop, base) => (base ? Math.round((shop / base) * 1000) / 10 : (shop ? 100 : 0));
  // Antofagasta: tabla manual valorizada a precio de transferencia (cerveza).
  const antoTabla = per.antofagasta.map(r => ({ estilo: r.estilo, precioLt: precios.cerveza, despachoLt: precios.despacho, litros: r.litros, valor: Math.round(r.litros * precios.cerveza + precios.despacho * r.litros) }));
  const antoLitros = antoTabla.reduce((a, r) => a + r.litros, 0);
  const antoValor = antoTabla.reduce((a, r) => a + r.valor, 0);
  antoTabla.forEach(r => r.pct = antoLitros ? Math.round((r.litros / antoLitros) * 1000) / 10 : 0);
  const mkTabla = (t) => (t && t.porEstilo || []).map(e => ({ estilo: e.estilo, tipo: e.tipo, precioLt: precios[e.tipo] || precios.cerveza, despachoLt: precios.despacho, litros: e.litros, valor: Math.round(e.litros * (precios[e.tipo] || precios.cerveza) + precios.despacho * e.litros), pct: t.litros ? Math.round((e.litros / t.litros) * 1000) / 10 : 0 }));
  // Seed de transferencias históricas a Garden Antofagasta (pre-Shopify): se suma
  // al garden como si fueran pedidos de Shopify (litros + valor revaluado).
  const gardenSeed = CD_GARDEN_SEED[month] || [];
  const seedLitros = gardenSeed.reduce((a, p) => a + (p.lineas || []).reduce((s, l) => s + (Number(l.litros) || 0), 0), 0);
  const seedValor = gardenSeed.reduce((a, p) => a + (p.lineas || []).reduce((s, l) => s + (Number(l.litros) || 0) * ((precios[l.tipo] || precios.cerveza) + precios.despacho), 0), 0);
  const gardenValor = (shOk ? sh.transfers.garden.valor : 0) + Math.round(seedValor);
  const badassValor = shOk ? sh.transfers.badass.valor : 0;
  const garden = { litros: cdR3((shOk ? sh.transfers.garden.litros : 0) + seedLitros), valor: gardenValor, tabla: shOk ? mkTabla(sh.transfers.garden) : [], pedidos: [...(shOk ? sh.transfers.garden.pedidos : []), ...gardenSeed] };
  const badass = { litros: shOk ? sh.transfers.badass.litros : 0, valor: badassValor, tabla: shOk ? mkTabla(sh.transfers.badass) : [], pedidos: shOk ? sh.transfers.badass.pedidos : [] };
  const antofagasta = { litros: antoLitros, valor: antoValor, tabla: antoTabla, manual: per.antofagasta };
  // 100% automático de Shopify: sin líneas manuales.
  const cdNeto = shCd;
  const cruzTotal = shCruz;
  const hospitalityTotal = gardenValor + badassValor;
  // ③ Retail = Walmart, 100% automático de Shopify (código PEDIDOSWALMART) +
  // pedidos históricos puntuales inyectados como si vinieran de Shopify.
  const walmartSeed = CD_WALMART_SEED[month] || [];
  const walmartPedidos = [...(shOk ? sh.bucket.walmart.pedidos : []), ...walmartSeed];
  const retail = shWalmart + walmartSeed.reduce((a, p) => a + (Number(p.original) || 0), 0);
  // Venta por día = total real de Shopify por día + seeds históricos puntuales (que
  // también traen su fecha real). Misma base de valorización que totalIngresos.
  const porDia = {};
  const addDia = (fecha, monto) => { if (!fecha || !monto) return; porDia[fecha] = (porDia[fecha] || 0) + Math.round(monto); };
  if (shOk) Object.entries(sh.porDia).forEach(([f, v]) => addDia(f, v));
  gardenSeed.forEach(p => addDia(p.fecha, (p.lineas || []).reduce((s, l) => s + (Number(l.litros) || 0) * ((precios[l.tipo] || precios.cerveza) + precios.despacho), 0)));
  walmartSeed.forEach(p => addDia(p.fecha, Number(p.original) || 0));
  // Walmart por marca (vendor de Shopify): resumen + filtro, igual que Venta Online.
  const wmProvKeys = [...CD_WEB_PROVEEDORES, 'Otros'];
  const walmartPorProv = {}; for (const k of wmProvKeys) walmartPorProv[k] = { total: 0, n: 0, pedidos: [] };
  for (const ped of walmartPedidos) {
    const monto = Number(ped.original) || 0;
    const provs = (ped.porProveedor && ped.porProveedor.length) ? ped.porProveedor : [{ proveedor: ped.proveedor || 'Otros', monto }];
    const base = provs.reduce((a, x) => a + (x.monto || 0), 0) || 1;
    for (const pp of provs) {
      const key = walmartPorProv[pp.proveedor] ? pp.proveedor : 'Otros';
      const alloc = Math.round(monto * ((pp.monto || 0) / base));
      walmartPorProv[key].total += alloc; walmartPorProv[key].n++;
      walmartPorProv[key].pedidos.push({ ...ped, montoProveedor: alloc });
    }
  }
  // HORECA por canal de venta: Grupo Mil Sabores vs Otros. Cada pedido trae su
  // punto de venta (marca/razón/sector) para filtrar.
  const horecaPedidos = shOk ? [...sh.bucket.cd_kairos_mall.pedidos, ...sh.bucket.ventas_cruzada.pedidos] : [];
  const chanTotal = (g) => horecaPedidos.filter(p => p.grupo === g).reduce((a, p) => a + (p.monto || 0), 0);
  const horeca = { total: cdNeto + cruzTotal, milSabores: chanTotal('mil_sabores'), otros: chanTotal('otros'), pedidos: horecaPedidos };
  // VENTA WEB por proveedor (vendor de Shopify): 4 secciones + Otros. El monto de
  // cada sección se prorratea del cobrado real del pedido según la participación
  // de cada proveedor en las líneas, así las secciones suman ≈ el total web.
  const webPedidos = shOk ? sh.bucket.retail.pedidos : [];
  const provKeys = [...CD_WEB_PROVEEDORES, 'Otros'];
  const webPorProv = {}; for (const k of provKeys) webPorProv[k] = { total: 0, n: 0, pedidos: [] };
  for (const ped of webPedidos) {
    const provs = (ped.porProveedor && ped.porProveedor.length) ? ped.porProveedor : [{ proveedor: 'Otros', monto: ped.cobrado }];
    const base = provs.reduce((a, x) => a + (x.monto || 0), 0) || 1;
    for (const pp of provs) {
      const key = webPorProv[pp.proveedor] ? pp.proveedor : 'Otros';
      const alloc = Math.round(ped.cobrado * ((pp.monto || 0) / base));
      webPorProv[key].total += alloc; webPorProv[key].n++;
      webPorProv[key].pedidos.push({ ...ped, montoProveedor: alloc });
    }
  }
  const ingresos = {
    cd_kairos: { shopify: shCd, neto: cdNeto, pedidos: shOk ? sh.bucket.cd_kairos_mall.pedidos : [] },
    ventas_cruzada: { shopify: shCruz, total: cruzTotal, pedidos: shOk ? sh.bucket.ventas_cruzada.pedidos : [] },
    horeca,
    hospitality: { garden, badass, total: hospitalityTotal },
    ventas_web: { cobrado: shWeb, n: shOk ? sh.bucket.retail.n : 0, pedidos: webPedidos, porProveedor: webPorProv, proveedores: provKeys, detalleEntrega: !!(cdOrdersTier && cdOrdersTier.key !== 'base'), origenDespacho: !!(cdOrdersTier && (cdOrdersTier.key === 'full' || cdOrdersTier.key === 'loc')) },
    retail,
    walmart: { total: retail, n: walmartPedidos.length, pedidos: walmartPedidos, porProveedor: walmartPorProv, proveedores: wmProvKeys },
  };
  const totalIngresos = cdNeto + cruzTotal + hospitalityTotal + shWeb + retail;
  return {
    month, precios, periodo: per, ingresos, totalIngresos, porDia,
    rango: r, mesCompleto: (r.from === cdMonthRange(month).from && r.to === cdMonthRange(month).to),
    shopifyOk: shOk, shopifyError: sh.error || null,
    alertas: { codigosNuevos: shOk ? sh.codigosNuevos : [], sinMapear: shOk ? sh.sinMapear : [], sinCodigo: shOk ? sh.sinCodigo : 0 },
    excelRef: CD_EXCEL_REF[month] || null,
  };
}
// Lee un rango de fechas de los query params (from/to en YYYY-MM-DD), o null.
function estadoRangeFromReq(req){
  const d = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  return (d.test(from) && d.test(to) && from <= to) ? { from, to } : null;
}
app.get('/admin/estado/periodos', requireAdmin, (req, res) => { res.json({ periodos: Object.keys(estadoLoad().periodos).sort().reverse() }); });
app.get('/admin/estado', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  try { res.json(await estadoResolve(month, estadoRangeFromReq(req))); } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 300) }); }
});
app.put('/admin/estado/:month', requireAdmin, (req, res) => {
  const month = String(req.params.month); if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mes inválido.' });
  const all = estadoLoad(); all.periodos[month] = estadoNormPeriodo(req.body || {}); estadoSave(all); res.json({ ok: true });
});
app.post('/admin/estado/:month/duplicar', requireAdmin, (req, res) => {
  const month = String(req.params.month); const from = String((req.body && req.body.from) || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Mes inválido.' });
  const all = estadoLoad(); const src = all.periodos[from];
  all.periodos[month] = estadoNormPeriodo(src ? JSON.parse(JSON.stringify(src)) : {});
  estadoSave(all); res.json({ ok: true });
});
// Exporta el Estado de Resultado a Excel (.xlsx) — solo lectura, misma estructura
// que el Excel manual pero con la info de Zorbo. Los datos se cambian en Zorbo.
function estadoSheetRows(data, month){
  const S = { title: 5, header: 1, sec: 2, money: 3, pct: 4, secMoney: 6, secPct: 7 };
  const M = (v) => ({ v: Math.round(Number(v) || 0), t: 'n', s: S.money });
  const SM = (v) => ({ v: Math.round(Number(v) || 0), t: 'n', s: S.secMoney });
  const PCT = (v) => ({ v: (Number(v) || 0) / 100, t: 'n', s: S.pct });
  const N = (v) => ({ v: Number(v) || 0, t: 'n' });
  const T = (v) => ({ v: v == null ? '' : String(v) });
  const H = (v) => ({ v: v == null ? '' : String(v), s: S.header });
  const SEC = (v) => ({ v: v == null ? '' : String(v), s: S.sec });
  const i = data.ingresos; const rows = [];
  const blank = () => rows.push([]);
  rows.push([{ v: 'ESTADO DE RESULTADO · CD KAIROS · ' + estadoMonthLabel(month), s: S.title }]);
  rows.push([T(data.shopifyOk ? 'Ingresos 100% automáticos de Shopify · solo lectura' : '⚠️ Shopify no disponible al exportar')]);
  blank();
  rows.push([SEC('INGRESOS'), SEC(''), SEC(''), SEC(''), SEC(''), SM(data.totalIngresos)]);
  blank();
  const horeca = i.cd_kairos.neto + i.ventas_cruzada.total, online = i.ventas_web.cobrado, retail = (i.retail != null ? i.retail : 0), hospitality = i.hospitality.total;
  const pctOf = (v) => data.totalIngresos ? Math.round(v / data.totalIngresos * 1000) / 10 : 0;
  rows.push([SEC('CANALES'), SEC(''), SEC(''), SEC(''), SEC('%'), SEC('Monto')]);
  rows.push([T('① HORECA (restaurantes/bares)'), T(''), T(''), T(''), PCT(pctOf(horeca)), SM(horeca)]);
  rows.push([T('② Venta Online (web)'), T(''), T(''), T(''), PCT(pctOf(online)), SM(online)]);
  rows.push([T('③ Retail (Walmart)'), T(''), T(''), T(''), PCT(pctOf(retail)), SM(retail)]);
  rows.push([T('④ Hospitality (locales propios)'), T(''), T(''), T(''), PCT(pctOf(hospitality)), SM(hospitality)]);
  blank();
  const transTable = (nombre, t) => {
    rows.push([SEC(nombre), SEC(''), SEC(''), SEC(t.litros + ' lt'), SEC(''), SM(t.valor)]);
    rows.push([H('Estilo'), H('$/lt'), H('Despacho'), H('Litros'), H('%'), H('Valor')]);
    (t.tabla || []).forEach(r => rows.push([T(r.estilo), M(r.precioLt), M(r.despachoLt), N(r.litros), PCT(r.pct), M(r.valor)]));
    blank();
  };
  // ① HORECA = CD Kairos + Ventas Cruzada (100% Shopify)
  rows.push([SEC('① HORECA'), SEC(''), SEC(''), SEC(''), SEC(''), SM(horeca)]);
  rows.push([T('CD Kairos (Shopify malls · ' + i.cd_kairos.pedidos.length + ' pedidos)'), T(''), T(''), T(''), T(''), M(i.cd_kairos.neto)]);
  rows.push([T('Ventas Cruzada (500 Sabores · ' + i.ventas_cruzada.pedidos.length + ' pedidos)'), T(''), T(''), T(''), T(''), M(i.ventas_cruzada.total)]);
  blank();
  // ② Venta Online (web) — dividida por proveedor (vendor de Shopify)
  rows.push([SEC('② VENTA ONLINE (página web)'), SEC(''), SEC(''), SEC(''), SEC(''), SM(online)]);
  const wpp = i.ventas_web.porProveedor || {};
  (i.ventas_web.proveedores || Object.keys(wpp)).forEach(prov => {
    const b = wpp[prov]; if (!b || (!b.n && !b.total)) return;
    rows.push([T(prov + ' (' + b.n + ' pedidos)'), T(''), T(''), T(''), T(''), M(b.total)]);
  });
  rows.push([T('Total web (' + i.ventas_web.n + ' pedidos)'), T(''), T(''), T(''), T(''), M(i.ventas_web.cobrado)]);
  blank();
  // ③ Retail (Walmart) — Shopify por código PEDIDOSWALMART
  rows.push([SEC('③ RETAIL (Walmart)'), SEC(''), SEC(''), SEC(''), SEC(''), SM(retail)]);
  rows.push([T('Walmart (código PEDIDOSWALMART · ' + ((i.walmart && i.walmart.n) || 0) + ' pedidos)'), T(''), T(''), T(''), T(''), M(retail)]);
  blank();
  // ④ Hospitality (locales propios)
  rows.push([SEC('④ HOSPITALITY (locales propios)'), SEC(''), SEC(''), SEC(''), SEC(''), SM(hospitality)]);
  transTable('Garden Vespucio (auto)', i.hospitality.garden);
  transTable('Badass (auto)', i.hospitality.badass);
  rows.push([SEC('TOTAL INGRESOS'), SEC(''), SEC(''), SEC(''), SEC(''), SM(data.totalIngresos)]);
  if (data.excelRef && data.excelRef.ingresos_total) {
    rows.push([T('Excel manual (referencia)'), T(''), T(''), T(''), T(''), M(data.excelRef.ingresos_total)]);
    rows.push([T('Diferencia (módulo − Excel)'), T(''), T(''), T(''), T(''), M(data.totalIngresos - data.excelRef.ingresos_total)]);
  }
  return rows;
}
app.get('/admin/estado/export.xlsx', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).send('Falta el mes (YYYY-MM).');
  try {
    const data = await estadoResolve(month, estadoRangeFromReq(req));
    const buf = xlsxPackage([{ name: estadoMonthLabel(month) + ' CD', rows: estadoSheetRows(data, month) }]);
    sendXlsx(res, buf, 'Estado_Resultado_' + month + '.xlsx');
  } catch (e) { res.status(500).send('Error: ' + String(e.message || e).slice(0, 200)); }
});
// Preview del Excel DENTRO de Zorbo (grilla tipo planilla, solo lectura): mismas
// filas que el .xlsx pero con el texto ya formateado y una clase de estilo.
const EST_STYLE_CLASS = { 1: 'h', 2: 'sec', 3: 'money', 4: 'pct', 5: 'title', 6: 'secmoney', 7: 'secpct' };
app.get('/admin/estado/preview', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  try {
    const data = await estadoResolve(month, estadoRangeFromReq(req));
    const rows = estadoSheetRows(data, month).map(r => (r || []).map(c => {
      if (!c) return { t: '' };
      let t;
      if (c.t === 'n') t = (c.s === 4 || c.s === 7) ? (Math.round((Number(c.v) || 0) * 1000) / 10 + '%') : ('$' + Math.round(Number(c.v) || 0).toLocaleString('es-CL'));
      else t = String(c.v == null ? '' : c.v);
      return { t, s: EST_STYLE_CLASS[c.s] || '', n: c.t === 'n' };
    }));
    res.json({ month, rows });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});

// ─── COSTOS Y GASTOS ────────────────────────────────────────────────────────
// Registro de costos/gastos que llegan a la empresa: se elige un PROVEEDOR (de los
// ya creados, o se crea uno nuevo), la CATEGORÍA del Estado de Resultado a la que
// imputa, la fecha del documento, el folio y el valor. Persistencia en JSON.
const COSTOS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'costos-gastos.json');
// tipo: 'costo' (ficha Costos) o 'gasto' (ficha Gastos) — separa qué categorías
// se ofrecen en cada formulario, aunque ambos comparten el mismo archivo/registro.
const COSTOS_CATEGORIAS = [
  { id: 'costo_directo', label: 'Costo directo', tipo: 'costo' },
  { id: 'costo_indirecto', label: 'Costo indirecto', tipo: 'costo' },
  { id: 'gastos_operativos', label: 'Operativos', tipo: 'gasto' },
  { id: 'gastos_admin_venta', label: 'Administración y venta', tipo: 'gasto' },
  { id: 'marketing_publicidad', label: 'Marketing y publicidad', tipo: 'gasto' },
  // Renombre: el id se MANTIENE (activos_fijos) para no romper los registros existentes
  // ni la referencia del Estado de Resultado; solo cambia el label visible.
  { id: 'activos_fijos', label: 'CAPEX y Activos Fijos', tipo: 'gasto' },
];
// Subcategorías (2º nivel). Transporte tiene un 3º nivel (sub). Solo Operativos las usa hoy.
const COSTOS_SUBCATEGORIAS = {
  gastos_operativos: [
    { id: 'general', label: 'General' },
    { id: 'transporte', label: 'Transporte', sub: [
      { id: 'venta', label: 'Venta' },
      { id: 'logistico', label: 'Logístico' },
      { id: 'administrativo', label: 'Administrativo' },
    ] },
    { id: 'almacenamiento', label: 'Almacenamiento' },
    { id: 'mantencion', label: 'Mantención y reparación de equipos' },
    { id: 'arriendo', label: 'Arriendo y/o Gasto Común' },
    { id: 'opex', label: 'OPEX' },
  ],
};
// Subcategoría efectiva: los Operativos sin subcategoría se muestran como "General"
// (migración NO destructiva — no se reescribe el archivo; el default se aplica al leer).
function costosSubEfectiva(e){
  if (e.categoria !== 'gastos_operativos') return e.subcategoria || '';
  return e.subcategoria || 'general';
}
function costosSubLabel(catId, subId, subnivel){
  const subs = COSTOS_SUBCATEGORIAS[catId]; if (!subs || !subId) return '';
  const s = subs.find(x => x.id === subId); if (!s) return '';
  if (subnivel && Array.isArray(s.sub)) { const n = s.sub.find(x => x.id === subnivel); if (n) return s.label + ' · ' + n.label; }
  return s.label;
}
// Valida (categoria, subcategoria, subnivel) contra la estructura; devuelve {sub, subnivel} saneados.
function costosSubValidar(catId, subId, subnivel){
  const subs = COSTOS_SUBCATEGORIAS[catId];
  if (!subs) return { subcategoria: '', subnivel: '' };
  const s = subs.find(x => x.id === subId);
  if (!s) return { subcategoria: '', subnivel: '' };
  let sn = '';
  if (Array.isArray(s.sub) && subnivel) { const n = s.sub.find(x => x.id === subnivel); if (n) sn = n.id; }
  return { subcategoria: s.id, subnivel: sn };
}
const COSTOS_TIPOS = ['costo', 'gasto'];
// Marcas propias de Zorbo, para poder imputar cada costo/gasto a una marca (o a
// varias, con % de reparto) y así medir desempeño por marca a futuro.
const COSTOS_MARCAS = ['kairos', 'banny', 'firulais'];
const COSTOS_MARCA_VALORES = [...COSTOS_MARCAS, 'todas', 'algunas'];
// Proveedores iniciales (semilla). Se pueden agregar más desde el panel.
const COSTOS_PROVEEDORES_SEED = [
  'Embotelladora Andina', 'Navarro y Cía. SpA', 'Navarro y Cía. SpA (Insumo de Oasis)', 'Ariscorp SpA',
  'Comercializadora Gecorp', 'Gecorp', 'MACC SpA', 'Destilería Zunda SpA', 'Bucarest SpA', 'ICYLAB SpA',
  'Comercial e Inversiones Cervecera del Puerto', 'Plaza Vespucio SpA', 'Transportes 369 SpA', 'AGSB',
  'Controlbar Solutions SpA', 'Caya Servicios', 'Devoluciones', 'Caja Chica',
  'Centro de Servicios Compartidos Los Robles SpA', 'Banco de Crédito e Inversiones',
  'Producciones Gráficas SpA', 'PRISA', 'Confección de Ropa Dimenta Ltda', 'Convertidora de Material SIM Ltda',
];
const costosNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; };
const costosStr = (v, m = 200) => String(v == null ? '' : v).trim().slice(0, m);
let COSTOS_ID_SEQ = 0;
function costosNewId(prefix){ COSTOS_ID_SEQ = (COSTOS_ID_SEQ + 1) % 100000; return prefix + '_' + Date.now().toString(36) + '_' + COSTOS_ID_SEQ.toString(36); }
function costosLoad(){
  let data = { proveedores: [], entradas: [] };
  try { if (existsSync(COSTOS_FILE)) { const p = JSON.parse(readFileSync(COSTOS_FILE, 'utf-8')); data.proveedores = Array.isArray(p.proveedores) ? p.proveedores : []; data.entradas = Array.isArray(p.entradas) ? p.entradas : []; } }
  catch (e) { console.warn('costos load:', e.message); }
  // Semilla de proveedores la primera vez (o si el archivo no tiene proveedores).
  if (!data.proveedores.length) {
    const seen = new Set();
    data.proveedores = COSTOS_PROVEEDORES_SEED.filter(n => { const k = n.toLowerCase().replace(/\s+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(nombre => ({ id: costosNewId('prov'), nombre }));
  }
  return data;
}
function costosSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(COSTOS_FILE, JSON.stringify(d, null, 2)); }
const costosMes = (fecha) => /^\d{4}-\d{2}/.test(String(fecha)) ? String(fecha).slice(0, 7) : '';
const COSTOS_CAT_TIPO = Object.fromEntries(COSTOS_CATEGORIAS.map(c => [c.id, c.tipo]));
// Valor que efectivamente corresponde a Zorbo. En Gastos, si se cargó "Porcentaje
// del total" (facturas compartidas con el restaurante, ej. arriendo), solo esa
// fracción del monto de la factura cuenta para el Estado de Resultado — el monto y
// el folio que se ven en la tabla siguen siendo los de la factura real, sin tocar.
function costosValorEfectivo(e){
  const valor = Number(e.valor) || 0;
  if (COSTOS_CAT_TIPO[e.categoria] !== 'gasto') return valor;
  const pct = e.pctTotal;
  if (pct == null || pct === '') return valor;
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  return Math.round(valor * p / 100);
}
// Resumen por categoría (montos + cantidad) para un set de entradas.
function costosResumen(entradas){
  const porCat = {}; COSTOS_CATEGORIAS.forEach(c => porCat[c.id] = { total: 0, n: 0 });
  let total = 0;
  for (const e of entradas) {
    const c = porCat[e.categoria] || (porCat[e.categoria] = { total: 0, n: 0 });
    const v = costosValorEfectivo(e);
    c.total += v; c.n++; total += v;
  }
  return { porCategoria: porCat, total };
}
// ── Vista previa de migración de categorías de Gastos (READ-ONLY, no escribe nada) ──
// Cuenta los registros reales por categoría y muestra a dónde iría cada uno con la nueva
// estructura jerárquica, para revisar ANTES de aplicar la migración. Página HTML simple.
app.get('/admin/costos/migracion-preview', requireAdmin, (req, res) => {
  const data = costosLoad();
  const entradas = Array.isArray(data.entradas) ? data.entradas : [];
  const counts = {};
  COSTOS_CATEGORIAS.forEach(c => counts[c.id] = { label: c.label, tipo: c.tipo, n: 0, total: 0, opSinSub: 0 });
  const huerfanas = {};
  for (const e of entradas) {
    const c = counts[e.categoria];
    if (!c) { huerfanas[e.categoria || '(vacío)'] = (huerfanas[e.categoria || '(vacío)'] || 0) + 1; continue; }
    c.n++; c.total += costosValorEfectivo(e);
    if (e.categoria === 'gastos_operativos' && !e.subcategoria) c.opSinSub++;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clp = n => '$' + (Number(n) || 0).toLocaleString('es-CL');
  const destino = (id) => {
    if (id === 'gastos_operativos') return 'Operativos › <b>General</b> (por defecto; editable a Transporte/Almacenamiento/Mantención/Arriendo/OPEX)';
    if (id === 'activos_fijos') return '<b>CAPEX y Activos Fijos</b> (solo cambia el nombre; mismo id, registros intactos)';
    return 'Sin cambios';
  };
  const rows = COSTOS_CATEGORIAS.map(c => {
    const x = counts[c.id];
    return `<tr><td>${c.label}</td><td class="t">${c.tipo}</td><td class="n">${x.n}</td><td class="n">${clp(x.total)}</td><td>${destino(c.id)}</td></tr>`;
  }).join('');
  const huerfKeys = Object.keys(huerfanas);
  const huerfHtml = huerfKeys.length
    ? `<div class="warn"><b>⚠️ Categorías desconocidas (fuera de la lista):</b><ul>${huerfKeys.map(k => `<li>${esc(k)} — ${huerfanas[k]} registro(s)</li>`).join('')}</ul>Estas NO se tocarán; avisame para decidir su destino.</div>`
    : `<div class="ok">✓ No hay registros en categorías desconocidas: nada quedaría sin categoría tras migrar.</div>`;
  const totalReg = entradas.length;
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Migración de categorías · Gastos · K-BROS</title>
<style>
body{font-family:'DM Sans',system-ui,sans-serif;background:#f4f5f7;color:#18181b;margin:0;padding:28px;line-height:1.5}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .2rem}.sub{color:#52525b;font-size:.9rem;margin-bottom:1.2rem}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e7e7ea;border-radius:12px;overflow:hidden;font-size:.86rem}
th,td{padding:.6rem .7rem;text-align:left;border-bottom:1px solid #eee;vertical-align:top}
th{background:#0b2a5e;color:#eaf0fb;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.t{color:#9a5b00}
.badge{display:inline-block;background:#fdf3e0;color:#9a5b00;font-weight:700;font-size:.72rem;padding:.2rem .5rem;border-radius:99px;margin-left:.4rem}
.ok{background:#e7f6ee;color:#1f7a44;border:1px solid #bfe6cf;border-radius:10px;padding:.7rem .9rem;margin-top:1rem;font-size:.86rem}
.warn{background:#fdeaea;color:#b91c1c;border:1px solid #f6caca;border-radius:10px;padding:.7rem .9rem;margin-top:1rem;font-size:.86rem}
.note{color:#52525b;font-size:.8rem;margin-top:1.2rem;border-left:3px solid #f5a623;padding:.3rem .8rem}
</style></head><body><div class="wrap">
<h1>Migración de categorías de Gastos <span class="badge">VISTA PREVIA · no aplica nada</span></h1>
<div class="sub">Total de registros (costos + gastos): <b>${totalReg}</b>. Esta página es de solo lectura: muestra cuántos registros hay por categoría hoy y a dónde irían con la nueva estructura. No se modifica ningún dato.</div>
<table><thead><tr><th>Categoría actual</th><th>Tipo</th><th>Registros</th><th>Monto (efectivo)</th><th>Destino tras migrar</th></tr></thead><tbody>${rows}</tbody></table>
${huerfHtml}
<div class="note">Nueva estructura propuesta — <b>OPERATIVOS</b>: General · Transporte (Venta/Logístico/Administrativo) · Almacenamiento · Mantención y reparación de equipos · Arriendo y/o Gasto Común · OPEX. <b>Administración y venta</b>, <b>Marketing y publicidad</b> y los <b>Costos</b> quedan igual. <b>Activos fijos → CAPEX y Activos Fijos</b> (mismo id, solo el nombre). Los registros hoy en Operativos se asignan a <b>Operativos › General</b> y quedan editables.</div>
</div></body></html>`);
});

// GET: proveedores + categorías + entradas (opcional filtradas por mes/tipo) + resumen.
// tipo=costo|gasto separa la ficha de Costos de la de Gastos (mismo registro, distinta vista).
app.get('/admin/costos', requireAdmin, (req, res) => {
  const data = costosLoad();
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes)) ? String(req.query.mes) : null;
  const tipo = COSTOS_TIPOS.includes(String(req.query.tipo)) ? String(req.query.tipo) : null;
  let entradas = data.entradas.slice().sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  if (tipo) entradas = entradas.filter(e => COSTOS_CAT_TIPO[e.categoria] === tipo);
  const entradasDelTipo = entradas;
  if (mes) entradas = entradas.filter(e => costosMes(e.fecha) === mes);
  const meses = [...new Set(entradasDelTipo.map(e => costosMes(e.fecha)).filter(Boolean))].sort().reverse();
  res.json({
    categorias: tipo ? COSTOS_CATEGORIAS.filter(c => c.tipo === tipo) : COSTOS_CATEGORIAS,
    subcategorias: COSTOS_SUBCATEGORIAS,
    marcas: COSTOS_MARCAS,
    proveedores: data.proveedores.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    // subEfectiva/subLabel: incluyen el default "General" para Operativos sin subcategoría (no destructivo).
    entradas: entradas.map(e => { const sub = costosSubEfectiva(e); return { ...e, marca: e.marca || 'todas', subEfectiva: sub, subLabel: costosSubLabel(e.categoria, sub, e.subnivel) }; }),
    meses, mes,
    resumen: costosResumen(entradas),
  });
});
// POST proveedor nuevo.
app.post('/admin/costos/proveedor', requireAdmin, (req, res) => {
  const nombre = costosStr(req.body && req.body.nombre, 120);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del proveedor.' });
  const data = costosLoad();
  const k = nombre.toLowerCase().replace(/\s+/g, ' ').trim();
  const existe = data.proveedores.find(p => p.nombre.toLowerCase().replace(/\s+/g, ' ').trim() === k);
  if (existe) return res.json({ ok: true, proveedor: existe, yaExistia: true });
  const prov = { id: costosNewId('prov'), nombre };
  data.proveedores.push(prov); costosSave(data);
  res.json({ ok: true, proveedor: prov });
});
// POST entrada (costo/gasto).
app.post('/admin/costos/entrada', requireAdmin, (req, res) => {
  const b = req.body || {};
  const proveedor = costosStr(b.proveedor, 120);
  const categoria = costosStr(b.categoria, 40);
  const fecha = costosStr(b.fecha, 20);
  const folio = costosStr(b.folio, 60);
  const valor = costosNum(b.valor);
  const marca = costosStr(b.marca, 20);
  if (!proveedor) return res.status(400).json({ error: 'Elegí un proveedor.' });
  const catDef = COSTOS_CATEGORIAS.find(c => c.id === categoria);
  if (!catDef) return res.status(400).json({ error: 'Elige una categoría válida.' });
  // Subcategoría (2 niveles). Si la categoría tiene subcategorías, se exige elegir una.
  const { subcategoria, subnivel } = costosSubValidar(categoria, costosStr(b.subcategoria, 40), costosStr(b.subnivel, 40));
  if (COSTOS_SUBCATEGORIAS[categoria] && !subcategoria) return res.status(400).json({ error: 'Elige una subcategoría.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Elegí la fecha del documento.' });
  if (!valor) return res.status(400).json({ error: 'Ingresá el valor.' });
  if (!COSTOS_MARCA_VALORES.includes(marca)) return res.status(400).json({ error: 'Elegí a qué marca corresponde.' });
  // "Algunas": reparto explícito por marca, con % de esa factura para cada una.
  let marcaDetalle = null;
  if (marca === 'algunas') {
    const arr = Array.isArray(b.marcaDetalle) ? b.marcaDetalle : [];
    const seen = new Set();
    marcaDetalle = [];
    for (const it of arr) {
      const m = costosStr(it && it.marca, 20);
      if (!COSTOS_MARCAS.includes(m) || seen.has(m)) continue;
      const pct = Number(it && it.pct);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
      seen.add(m); marcaDetalle.push({ marca: m, pct: Math.round(pct * 10) / 10 });
    }
    if (!marcaDetalle.length) return res.status(400).json({ error: 'Elegí al menos una marca y su porcentaje.' });
    const suma = marcaDetalle.reduce((s, it) => s + it.pct, 0);
    if (suma > 100.01) return res.status(400).json({ error: 'La suma de los porcentajes por marca no puede superar 100%.' });
  }
  // "Porcentaje del total": solo aplica a Gastos (facturas compartidas con el restaurante).
  let pctTotal = null;
  if (catDef.tipo === 'gasto' && b.pctTotal != null && b.pctTotal !== '') {
    const p = Number(b.pctTotal);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return res.status(400).json({ error: 'El porcentaje del total debe ser entre 1 y 100.' });
    pctTotal = Math.round(p * 10) / 10;
  }
  // Adjunto opcional (factura/documento) en base64 → se guarda en UPLOADS_DIR.
  let adjunto = null;
  const adj = b.adjunto;
  if (adj && adj.dataBase64) {
    const ext = UPLOAD_TYPES[String(adj.contentType).toLowerCase()];
    if (!ext) return res.status(415).json({ error: 'Archivo no permitido. Subí PDF o imagen (png/jpg/webp).' });
    let buf; try { buf = Buffer.from(adj.dataBase64, 'base64'); } catch { return res.status(400).json({ error: 'Archivo inválido.' }); }
    if (!buf.length) return res.status(400).json({ error: 'Archivo vacío.' });
    if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Máximo 8 MB por archivo.' });
    try { const safeName = randomUUID() + '.' + ext; writeFileSync(join(UPLOADS_DIR, safeName), buf); adjunto = { url: '/uploads/' + safeName, name: costosStr(adj.filename, 200) || ('documento.' + ext) }; }
    catch (e) { return res.status(500).json({ error: 'Error guardando archivo: ' + e.message }); }
  }
  const data = costosLoad();
  // Si el proveedor no está creado, lo crea al vuelo (viene de "crear nuevo").
  if (!data.proveedores.some(p => p.nombre === proveedor)) data.proveedores.push({ id: costosNewId('prov'), nombre: proveedor });
  const entrada = { id: costosNewId('cg'), proveedor, categoria, subcategoria, subnivel, fecha, folio, valor, adjunto, marca, marcaDetalle, pctTotal };
  data.entradas.push(entrada); costosSave(data);
  res.json({ ok: true, entrada });
});
// PUT: reclasifica la subcategoría/subnivel de un registro existente (edición no destructiva).
app.put('/admin/costos/entrada/:id/subcategoria', requireAdmin, (req, res) => {
  const id = String(req.params.id); const data = costosLoad();
  const e = (data.entradas || []).find(x => x.id === id);
  if (!e) return res.status(404).json({ error: 'Registro no encontrado.' });
  if (!COSTOS_SUBCATEGORIAS[e.categoria]) return res.status(400).json({ error: 'Esta categoría no usa subcategorías.' });
  const b = req.body || {};
  const { subcategoria, subnivel } = costosSubValidar(e.categoria, costosStr(b.subcategoria, 40), costosStr(b.subnivel, 40));
  if (!subcategoria) return res.status(400).json({ error: 'Elige una subcategoría válida.' });
  e.subcategoria = subcategoria; e.subnivel = subnivel;
  costosSave(data);
  res.json({ ok: true });
});
app.delete('/admin/costos/entrada/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id); const data = costosLoad();
  const removed = data.entradas.find(e => e.id === id);
  const n = data.entradas.length; data.entradas = data.entradas.filter(e => e.id !== id);
  if (data.entradas.length === n) return res.status(404).json({ error: 'No se encontró la entrada.' });
  // Borrar el adjunto del disco (solo dentro de /uploads/ — anti path traversal).
  if (removed && removed.adjunto && removed.adjunto.url && removed.adjunto.url.startsWith('/uploads/')) {
    try { const p = join(UPLOADS_DIR, removed.adjunto.url.replace('/uploads/', '')); if (existsSync(p)) unlinkSync(p); } catch {}
  }
  costosSave(data); res.json({ ok: true });
});

// ─── ESTADO DE RESULTADO (P&L) = Ingresos por venta − Costos y Gastos ────────
// Cruza los ingresos automáticos (hoja Ingreso por Venta) con los costos/gastos
// registrados del mes, agrupados por categoría, y calcula margen bruto y EBITDA.
// Costos/gastos dentro de un rango de fechas exacto (inclusive, YYYY-MM-DD) en vez
// de un mes calendario completo — necesario para períodos como "Últimos 30 días"
// o un rango personalizado que no calzan con costosMes().
function costosEnRango(entradas, from, to){
  return entradas.filter(e => { const f = costosStr(e.fecha, 20); return f && f >= from && f <= to; });
}
async function pnlCompute(month, rango){
  const est = await estadoResolve(month, rango);
  const cd = costosLoad();
  const entradas = (rango && rango.from && rango.to)
    ? costosEnRango(cd.entradas, rango.from, rango.to)
    : cd.entradas.filter(e => costosMes(e.fecha) === month);
  const rs = costosResumen(entradas);
  // Ajustes que corrigen/complementan el EERR: boletas de honorarios (suman a su categoría),
  // notas de crédito (restan ingresos / suman costos-gastos), y costo empresa por mes.
  const bol = nominaBoletasDelMes(month);
  const nc = notasCreditoDelMes(month);
  const catTot = (id) => ((rs.porCategoria[id] || { total: 0 }).total) + (bol[id] || 0) + (nc.costo[id] || 0);
  const ingresos = est.totalIngresos - (nc.ingreso || 0);
  const costoDirecto = catTot('costo_directo'), costoIndirecto = catTot('costo_indirecto');
  const gastosOper = catTot('gastos_operativos'), gastosAdmin = catTot('gastos_admin_venta');
  const gastosMarketing = catTot('marketing_publicidad'), activos = catTot('activos_fijos');
  const gastoPersonal = nominaCostoEmpresaMes(month); // costo empresa del mes (Gestión de Personas)
  const margenBruto = ingresos - costoDirecto - costoIndirecto;
  const ebitda = margenBruto - gastosOper - gastosAdmin - gastosMarketing - gastoPersonal;
  const ratio = (v) => ingresos ? Math.round((v / ingresos) * 1000) / 10 : 0;
  const i = est.ingresos;
  return {
    month, shopifyOk: est.shopifyOk,
    ingresos: { total: ingresos, canales: {
      horeca: i.cd_kairos.neto + i.ventas_cruzada.total,
      online: i.ventas_web.cobrado,
      retail: (i.retail != null ? i.retail : 0),
      hospitality: i.hospitality.total,
    } },
    costos: { costoDirecto, costoIndirecto, gastosOper, gastosAdmin, gastosMarketing, gastoPersonal, activos },
    docs: Object.fromEntries(Object.entries(rs.porCategoria).map(([k, v]) => [k, v.n])),
    ajustes: { ncIngreso: nc.ingreso || 0, ncCosto: nc.costo, boletas: bol }, // notas de crédito + boletas aplicadas
    margenBruto, ebitda,
    ratios: {
      costoDirecto: ratio(costoDirecto), costoIndirecto: ratio(costoIndirecto),
      gastosOper: ratio(gastosOper), gastosAdmin: ratio(gastosAdmin), gastosMarketing: ratio(gastosMarketing), gastoPersonal: ratio(gastoPersonal),
      margenBruto: ratio(margenBruto), ebitda: ratio(ebitda), activos: ratio(activos),
    },
  };
}
// Filas del Estado de Resultado para el .xlsx (mismo formato de celdas que Ingreso por Venta).
function pnlSheetRows(data, month){
  const S = { title: 5, header: 1, sec: 2, money: 3, pct: 4, secMoney: 6, secPct: 7 };
  const M = (v) => ({ v: Math.round(Number(v) || 0), t: 'n', s: S.money });
  const SM = (v) => ({ v: Math.round(Number(v) || 0), t: 'n', s: S.secMoney });
  const PCT = (v) => ({ v: (Number(v) || 0) / 100, t: 'n', s: S.pct });
  const SPCT = (v) => ({ v: (Number(v) || 0) / 100, t: 'n', s: S.secPct });
  const T = (v) => ({ v: v == null ? '' : String(v) });
  const SEC = (v) => ({ v: v == null ? '' : String(v), s: S.sec });
  const ing = data.ingresos, co = data.costos, rt = data.ratios;
  const rows = []; const blank = () => rows.push([]);
  rows.push([{ v: 'ESTADO DE RESULTADO · K-BROS · ' + estadoMonthLabel(month), s: S.title }]);
  rows.push([T(data.shopifyOk ? 'Ingresos automáticos de Shopify menos costos y gastos del mes' : '⚠️ Shopify no disponible al exportar')]);
  blank();
  rows.push([SEC('INGRESOS POR VENTA'), SPCT(100), SM(ing.total)]);
  rows.push([T('HORECA'), T(''), M(ing.canales.horeca)]);
  rows.push([T('Venta Online'), T(''), M(ing.canales.online)]);
  rows.push([T('Retail'), T(''), M(ing.canales.retail)]);
  rows.push([T('Hospitality'), T(''), M(ing.canales.hospitality)]);
  blank();
  rows.push([T('Costo directo'), PCT(-rt.costoDirecto), M(-co.costoDirecto)]);
  rows.push([T('Costo indirecto'), PCT(-rt.costoIndirecto), M(-co.costoIndirecto)]);
  rows.push([SEC('MARGEN BRUTO'), SPCT(rt.margenBruto), SM(data.margenBruto)]);
  blank();
  rows.push([T('Gastos operativos'), PCT(-rt.gastosOper), M(-co.gastosOper)]);
  rows.push([T('Gastos de administración y venta'), PCT(-rt.gastosAdmin), M(-co.gastosAdmin)]);
  rows.push([T('Marketing y publicidad'), PCT(-rt.gastosMarketing), M(-co.gastosMarketing)]);
  rows.push([T('Gasto de personal (nómina)'), PCT(-rt.gastoPersonal), M(-co.gastoPersonal)]);
  rows.push([SEC('EBITDA · RESULTADO OPERATIVO'), SPCT(rt.ebitda), SM(data.ebitda)]);
  blank();
  rows.push([T('Activos fijos'), T(''), M(co.activos)]);
  return rows;
}
// ── Objetivos de Finanzas (metas editables) + proyección del mes en curso ──
const OBJETIVOS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'objetivos-finanzas.json');
const OBJETIVOS_DEFAULT = { margenBruto: 55, gastoPersonal: 18, marketing: 5, ebitda: 15, comentario: '' };
function objetivosLoad(){
  try { if (existsSync(OBJETIVOS_FILE)) { const o = JSON.parse(readFileSync(OBJETIVOS_FILE, 'utf-8')); return { ...OBJETIVOS_DEFAULT, ...o }; } }
  catch (e) { console.warn('objetivos load:', e.message); }
  return { ...OBJETIVOS_DEFAULT };
}
function objetivosSave(o){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(OBJETIVOS_FILE, JSON.stringify(o, null, 2)); }
function pnlPrevMonth(month){ const [y, m] = String(month).split('-').map(Number); const d = new Date(y, m - 2, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
// Totales de los 4 gastos estructurales de un mes (para proyectar el mes en curso).
function pnlGastosDeMes(month){
  const cd = costosLoad();
  const rs = costosResumen(cd.entradas.filter(e => costosMes(e.fecha) === month));
  const t = id => (rs.porCategoria[id] || { total: 0 }).total;
  return { gastosOper: t('gastos_operativos'), gastosAdmin: t('gastos_admin_venta'), gastosMarketing: t('marketing_publicidad'), gastoPersonal: nominaLoad().costoEmpresa || 0 };
}
app.get('/admin/objetivos', requireAdmin, (req, res) => res.json(objetivosLoad()));
app.put('/admin/objetivos', requireAdmin, (req, res) => {
  const b = req.body || {}; const cur = objetivosLoad();
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 10) / 10 : d; };
  const o = {
    margenBruto: num(b.margenBruto, cur.margenBruto), gastoPersonal: num(b.gastoPersonal, cur.gastoPersonal),
    marketing: num(b.marketing, cur.marketing), ebitda: num(b.ebitda, cur.ebitda),
    comentario: String(b.comentario == null ? cur.comentario : b.comentario).slice(0, 4000),
  };
  objetivosSave(o); res.json({ ok: true, objetivos: o });
});
// ══ Notas de crédito: corrigen el EERR (restan ingresos de un canal o suman costos/gastos) ══
const NC_FILE = join(PROMPTS_EFFECTIVE_DIR, 'notas-credito.json');
const NC_TIPOS = ['ingreso', 'costo', 'gasto'];
const NC_CANALES = [
  { id: 'horeca', label: 'HORECA' }, { id: 'online', label: 'Venta Online' }, { id: 'retail', label: 'Retail' },
  { id: 'hospitality', label: 'Hospitality' }, { id: 'otro', label: 'Otro canal' },
];
const NC_CANAL_IDS = NC_CANALES.map(c => c.id);
function ncLoad(){ try { if (existsSync(NC_FILE)) { const p = JSON.parse(readFileSync(NC_FILE, 'utf-8')); if (Array.isArray(p.notas)) return { notas: p.notas }; } } catch (e) { console.warn('nc load:', e.message); } return { notas: [] }; }
function ncSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(NC_FILE, JSON.stringify(d, null, 2)); }
function ncNorm(b, id){
  const tipo = NC_TIPOS.includes(costosStr(b.tipo, 20)) ? costosStr(b.tipo, 20) : '';
  const out = { id: id || costosNewId('nc'), tipo, folio: costosStr(b.folio, 60), fecha: costosStr(b.fecha, 20), monto: costosNum(b.monto), referencia: costosStr(b.referencia, 80), motivo: costosStr(b.motivo, 300), anulaCompleta: !!b.anulaCompleta };
  if (tipo === 'ingreso') out.canal = NC_CANAL_IDS.includes(costosStr(b.canal, 20)) ? costosStr(b.canal, 20) : '';
  else out.categoria = (COSTOS_CATEGORIAS.find(c => c.id === costosStr(b.categoria, 40)) ? costosStr(b.categoria, 40) : '');
  return out;
}
// Efecto de las NC del mes en el EERR: {ingreso: total a restar, costo:{catId: total a sumar}, porCanal}.
function notasCreditoDelMes(month){
  const d = ncLoad(); const out = { ingreso: 0, porCanal: {}, costo: {} };
  for (const n of (d.notas || [])) {
    if (costosMes(n.fecha) !== month) continue; const m = Number(n.monto) || 0;
    if (n.tipo === 'ingreso') { out.ingreso += m; if (n.canal) out.porCanal[n.canal] = (out.porCanal[n.canal] || 0) + m; }
    else if (n.categoria) { out.costo[n.categoria] = (out.costo[n.categoria] || 0) + m; }
  }
  return out;
}
app.get('/admin/notas-credito', requireAdmin, (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes)) ? String(req.query.mes) : null;
  const d = ncLoad(); let notas = (d.notas || []).slice().sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const meses = [...new Set((d.notas || []).map(n => costosMes(n.fecha)).filter(Boolean))].sort().reverse();
  if (mes) notas = notas.filter(n => costosMes(n.fecha) === mes);
  res.json({ notas, meses, mes, tipos: NC_TIPOS, canales: NC_CANALES, categorias: COSTOS_CATEGORIAS });
});
app.post('/admin/notas-credito', requireAdmin, (req, res) => {
  const n = ncNorm(req.body || {});
  if (!n.tipo) return res.status(400).json({ error: 'Elige el tipo de nota de crédito.' });
  if (!n.folio) return res.status(400).json({ error: 'Ingresa el folio de la nota de crédito.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n.fecha)) return res.status(400).json({ error: 'Ingresa la fecha.' });
  if (!n.monto) return res.status(400).json({ error: 'Ingresa el monto.' });
  if (n.tipo === 'ingreso' && !n.canal) return res.status(400).json({ error: 'Elige el canal de venta a anular.' });
  if ((n.tipo === 'costo' || n.tipo === 'gasto') && !n.categoria) return res.status(400).json({ error: 'Elige la categoría a corregir.' });
  const d = ncLoad(); d.notas.push(n); ncSave(d); res.json({ ok: true, nota: n });
});
app.delete('/admin/notas-credito/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id); const d = ncLoad(); const nlen = d.notas.length; d.notas = d.notas.filter(n => n.id !== id);
  if (d.notas.length === nlen) return res.status(404).json({ error: 'No se encontró la nota.' });
  ncSave(d); res.json({ ok: true });
});
app.get('/admin/pnl', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  try {
    const data = await pnlCompute(month, estadoRangeFromReq(req));
    data.objetivos = objetivosLoad();
    // Proyección (solo lectura): replica el gasto TOTAL del mes anterior ya cerrado en las
    // 4 líneas estructurales y recalcula el EBITDA. No toca los datos guardados.
    if (String(req.query.proyectar) === '1') {
      const prev = pnlPrevMonth(month);
      const pe = pnlGastosDeMes(prev);
      const ing = data.ingresos.total;
      const ratio = v => ing ? Math.round((v / ing) * 1000) / 10 : 0;
      data.costos.gastosOper = pe.gastosOper; data.costos.gastosAdmin = pe.gastosAdmin;
      data.costos.gastosMarketing = pe.gastosMarketing; data.costos.gastoPersonal = pe.gastoPersonal;
      data.ratios.gastosOper = ratio(pe.gastosOper); data.ratios.gastosAdmin = ratio(pe.gastosAdmin);
      data.ratios.gastosMarketing = ratio(pe.gastosMarketing); data.ratios.gastoPersonal = ratio(pe.gastoPersonal);
      data.ebitda = data.margenBruto - pe.gastosOper - pe.gastosAdmin - pe.gastosMarketing - pe.gastoPersonal;
      data.ratios.ebitda = ratio(data.ebitda);
      data.proyectado = true; data.mesReplicado = prev; data.mesReplicadoLabel = estadoMonthLabel(prev);
      data.lineasProyectadas = ['gastosOper', 'gastosAdmin', 'gastosMarketing', 'gastoPersonal', 'ebitda'];
    }
    res.json(data);
  }
  catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
// ══ Inicio del área FINANZAS: 3 cuadros (datos reales) + resumen IA cacheado ══
function finYearAgo(month){ const [y, mo] = String(month).split('-').map(Number); return (y - 1) + '-' + String(mo).padStart(2, '0'); }
function finCurMonth(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
async function finVentaMes(m){ try { const e = await estadoResolve(m); return Math.round((e.totalIngresos || 0) - (notasCreditoDelMes(m).ingreso || 0)); } catch { return null; } }
// Cuadro 2: ratio Gastos Operativos / Venta + peso de cada subcategoría operativa.
function finGastosOperativos(month){
  const cd = costosLoad();
  const ops = (cd.entradas || []).filter(e => costosMes(e.fecha) === month && e.categoria === 'gastos_operativos');
  const bySub = {}; let total = 0;
  for (const e of ops) { const v = costosValorEfectivo(e); const sub = costosSubEfectiva(e); total += v; bySub[sub] = (bySub[sub] || 0) + v; }
  const porSub = (COSTOS_SUBCATEGORIAS['gastos_operativos'] || [])
    .map(s => ({ id: s.id, label: s.label, total: bySub[s.id] || 0, pct: total ? Math.round(((bySub[s.id] || 0) / total) * 1000) / 10 : 0 }))
    .filter(x => x.total > 0);
  return { total, porSub, docs: ops.length };
}
// Cuadro 3: Top-5 productos por unidades vendidas del mes vs su stock actual (Shopify).
async function finTopVentaVsStock(month, n = 5){
  const prods = await loadProductsCache().catch(() => null);
  const inventarioDisponible = Array.isArray(prods) && prods.length > 0;
  const stockByTitle = {};
  if (inventarioDisponible) for (const p of prods) stockByTitle[p.title] = (p.variants || []).reduce((s, v) => s + (Number.isFinite(v.stock) ? v.stock : 0), 0);
  const ord = await loadOrders().catch(() => ({ available: false }));
  if (!ord || !ord.available) return { ventasDisponible: false, inventarioDisponible, items: [] };
  const { from, to } = cdMonthRange(month);
  const qty = {};
  for (const o of ord.orders) { const dk = String(o.createdAt).slice(0, 10); if (dk < from || dk > to) continue; for (const li of (o.lineItems || [])) qty[li.title] = (qty[li.title] || 0) + (Number(li.qty) || 0); }
  const items = Object.entries(qty).map(([title, u]) => ({ title, unidades: u, stock: inventarioDisponible ? (stockByTitle[title] != null ? stockByTitle[title] : null) : null }))
    .sort((a, b) => b.unidades - a.unidades).slice(0, n);
  return { ventasDisponible: true, inventarioDisponible, items };
}
app.get('/admin/finanzas/home', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : finCurMonth();
  const prev = pnlPrevMonth(month), ya = finYearAgo(month);
  try {
    const [vAct, vPrev, vYa] = await Promise.all([finVentaMes(month), finVentaMes(prev), finVentaMes(ya)]);
    const gops = finGastosOperativos(month);
    const top = await finTopVentaVsStock(month);
    res.json({
      month, monthLabel: estadoMonthLabel(month), prevLabel: estadoMonthLabel(prev), yearAgoLabel: estadoMonthLabel(ya),
      ventas: { actual: vAct, mesPasado: vPrev, anioPasado: vYa },
      gastosOperativos: { ...gops, ratioVenta: (vAct && gops.total) ? Math.round((gops.total / vAct) * 1000) / 10 : (vAct ? 0 : null) },
      topVenta: top,
      objetivos: objetivosLoad(),
    });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
// Resumen IA: cacheado (no se regenera en cada carga). GET devuelve el cacheado; POST /generar lo rehace.
const FIN_RESUMEN_FILE = join(PROMPTS_EFFECTIVE_DIR, 'finanzas-resumen.json');
function finResumenLoad(){ try { if (existsSync(FIN_RESUMEN_FILE)) return JSON.parse(readFileSync(FIN_RESUMEN_FILE, 'utf-8')); } catch (e) { console.warn('fin resumen load:', e.message); } return null; }
function finResumenSave(o){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(FIN_RESUMEN_FILE, JSON.stringify(o, null, 2)); }
app.get('/admin/finanzas/resumen', requireAdmin, (req, res) => res.json(finResumenLoad() || { texto: null, generadoEn: null }));
app.post('/admin/finanzas/resumen/generar', requireAdmin, async (req, res) => {
  try {
    const month = finCurMonth(), prev = pnlPrevMonth(month);
    const [pnlCur, pnlPrev] = await Promise.all([pnlCompute(month, null), pnlCompute(prev, null)]);
    const obj = objetivosLoad();
    const fmt = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
    // Se le pasan al modelo SÓLO cifras reales ya calculadas por el sistema.
    const datos = [
      `MES ACTUAL (${estadoMonthLabel(month)}):`,
      `- Ingresos por venta: ${fmt(pnlCur.ingresos.total)}`,
      `- Margen bruto: ${fmt(pnlCur.margenBruto)} = ${pnlCur.ratios.margenBruto}% de la venta (meta ${obj.margenBruto}%)`,
      `- EBITDA: ${fmt(pnlCur.ebitda)} = ${pnlCur.ratios.ebitda}% (meta ${obj.ebitda}%)`,
      `- Gasto de personal: ${pnlCur.ratios.gastoPersonal}% de la venta (meta ${obj.gastoPersonal}%)`,
      `- Marketing y publicidad: ${pnlCur.ratios.gastosMarketing}% (meta ${obj.marketing}%)`,
      `- Gastos operativos: ${fmt(pnlCur.costos.gastosOper)}; Administración y venta: ${fmt(pnlCur.costos.gastosAdmin)}`,
      ``,
      `MES ANTERIOR YA CERRADO (${estadoMonthLabel(prev)}):`,
      `- Ingresos: ${fmt(pnlPrev.ingresos.total)}; EBITDA: ${fmt(pnlPrev.ebitda)} = ${pnlPrev.ratios.ebitda}%; Margen bruto: ${pnlPrev.ratios.margenBruto}%`,
    ].join('\n');
    const sys = 'Sos analista financiero de K-BROS. Escribe en español chileno neutro (tuteo), claro y directo, en 2 o 3 párrafos breves. Cubre: cómo viene el negocio según el Estado de Resultado, cómo cerró el mes pasado, y en qué poner atención este mes para mejorar, contrastando SIEMPRE contra las metas. REGLA ABSOLUTA: usa ÚNICAMENTE los números que te paso abajo; NO inventes ni estimes NINGÚN número; si falta un dato, omítelo; no inventes causas o hechos que no se deduzcan de las cifras.';
    const msg = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 900, system: sys, messages: [{ role: 'user', content: 'Cifras reales ya calculadas por el sistema:\n' + datos }] });
    const texto = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const out = { texto, generadoEn: new Date().toISOString(), mes: month };
    finResumenSave(out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'No se pudo generar el resumen: ' + String(e.message || e).slice(0, 200) }); }
});
app.get('/admin/pnl/export.xlsx', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).send('Falta el mes (YYYY-MM).');
  try {
    const data = await pnlCompute(month, estadoRangeFromReq(req));
    const buf = xlsxPackage([{ name: 'Estado Resultado', rows: pnlSheetRows(data, month) }]);
    sendXlsx(res, buf, 'Estado_Resultado_' + month + '.xlsx');
  } catch (e) { res.status(500).send('Error: ' + String(e.message || e).slice(0, 200)); }
});

// ─── FORECAST ─────────────────────────────────────────────────────────────
// Proyecciones sobre el Estado de Resultado:
//  (A) "Proyectado": copia el EERR real de un mes y le suma ajustes manuales.
//  (B) "Presupuesto": venta proyectada + % objetivo por categoría → $ por área.
//  (C) "Simulación anual": mapea meses futuros del año a meses que ya ocurrieron,
//      para ver cómo cerraría el año completo.
const FORECAST_FILE = join(PROMPTS_EFFECTIVE_DIR, 'forecast.json');
// Mismas categorías de gasto que el EERR real (menos Activos fijos, que no afecta
// el resultado operativo) + "gasto_personal": no está en COSTOS_CATEGORIAS porque
// viene de Gestión de Personas (nómina), no del módulo de Costos/Gastos.
const FORECAST_CATS = [
  ...COSTOS_CATEGORIAS.filter(c => c.tipo === 'gasto' && c.id !== 'activos_fijos').map(c => ({ id: c.id, label: c.label })),
];
FORECAST_CATS.unshift(...COSTOS_CATEGORIAS.filter(c => c.tipo === 'costo').map(c => ({ id: c.id, label: c.label })));
FORECAST_CATS.push({ id: 'gasto_personal', label: 'Gasto de personal · nómina' });
function forecastLoad(){
  let data = { proyectado: {}, presupuestos: {}, simulacionAnual: {} };
  try {
    if (existsSync(FORECAST_FILE)) {
      const p = JSON.parse(readFileSync(FORECAST_FILE, 'utf-8'));
      if (p && typeof p.proyectado === 'object') data.proyectado = p.proyectado;
      if (p && typeof p.presupuestos === 'object') data.presupuestos = p.presupuestos;
      if (p && typeof p.simulacionAnual === 'object') data.simulacionAnual = p.simulacionAnual;
    }
  } catch (e) { console.warn('forecast load:', e.message); }
  return data;
}
function forecastSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(FORECAST_FILE, JSON.stringify(d, null, 2)); }
let FORECAST_ID_SEQ = 0;
function forecastNewId(){ FORECAST_ID_SEQ = (FORECAST_ID_SEQ + 1) % 100000; return 'fc_' + Date.now().toString(36) + '_' + FORECAST_ID_SEQ.toString(36); }
const forecastCurMonth = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

// ── (A) Proyectado ──
function forecastAjustesTotales(ajustes){
  const porCat = {}; FORECAST_CATS.forEach(c => porCat[c.id] = 0);
  for (const a of (ajustes || [])) porCat[a.categoria] = (porCat[a.categoria] || 0) + (Number(a.monto) || 0);
  return porCat;
}
app.get('/admin/forecast/proyectado', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  try {
    const real = await pnlCompute(month, estadoRangeFromReq(req));
    const data = forecastLoad();
    const bucket = data.proyectado[month] || {};
    const ajustes = bucket.ajustes || [];
    const extra = forecastAjustesTotales(ajustes);
    // El gasto de personal proyectado es un valor libre (no depende del real de
    // hoy): puede haber más o menos colaboradores en el mes proyectado. Si no se
    // definió un override, se sugiere el costo empresa actual como punto de partida.
    const gastoPersonalOverride = (bucket.gastoPersonalOverride != null) ? Number(bucket.gastoPersonalOverride) : null;
    const gastoPersonal = gastoPersonalOverride != null ? gastoPersonalOverride : real.costos.gastoPersonal;
    const costos = {
      costoDirecto: real.costos.costoDirecto + (extra.costo_directo || 0),
      costoIndirecto: real.costos.costoIndirecto + (extra.costo_indirecto || 0),
      gastosOper: real.costos.gastosOper + (extra.gastos_operativos || 0),
      gastosAdmin: real.costos.gastosAdmin + (extra.gastos_admin_venta || 0),
      gastosMarketing: real.costos.gastosMarketing + (extra.marketing_publicidad || 0),
      gastoPersonal,
      activos: real.costos.activos,
    };
    const ingresos = real.ingresos.total;
    const margenBruto = ingresos - costos.costoDirecto - costos.costoIndirecto;
    const ebitda = margenBruto - costos.gastosOper - costos.gastosAdmin - costos.gastosMarketing - costos.gastoPersonal;
    const ratio = (v) => ingresos ? Math.round((v / ingresos) * 1000) / 10 : 0;
    res.json({
      month, categorias: FORECAST_CATS, ingresos: real.ingresos,
      real: { costos: real.costos, margenBruto: real.margenBruto, ebitda: real.ebitda },
      ajustes, gastoPersonalOverride, costos, margenBruto, ebitda,
      ratios: {
        costoDirecto: ratio(costos.costoDirecto), costoIndirecto: ratio(costos.costoIndirecto),
        gastosOper: ratio(costos.gastosOper), gastosAdmin: ratio(costos.gastosAdmin),
        gastosMarketing: ratio(costos.gastosMarketing), gastoPersonal: ratio(costos.gastoPersonal),
        margenBruto: ratio(margenBruto), ebitda: ratio(ebitda),
      },
    });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
app.post('/admin/forecast/proyectado/personal', requireAdmin, (req, res) => {
  const b = req.body || {};
  const month = /^\d{4}-\d{2}$/.test(String(b.month)) ? String(b.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes.' });
  const data = forecastLoad();
  if (!data.proyectado[month]) data.proyectado[month] = { ajustes: [] };
  if (b.valor == null || b.valor === '') {
    delete data.proyectado[month].gastoPersonalOverride;
  } else {
    const v = costosNum(b.valor);
    data.proyectado[month].gastoPersonalOverride = v;
  }
  forecastSave(data);
  res.json({ ok: true, gastoPersonalOverride: data.proyectado[month].gastoPersonalOverride != null ? data.proyectado[month].gastoPersonalOverride : null });
});
app.post('/admin/forecast/proyectado/ajuste', requireAdmin, (req, res) => {
  const b = req.body || {};
  const month = /^\d{4}-\d{2}$/.test(String(b.month)) ? String(b.month) : null;
  const categoria = costosStr(b.categoria, 40);
  const descripcion = costosStr(b.descripcion, 200);
  const monto = costosNum(b.monto);
  if (!month) return res.status(400).json({ error: 'Falta el mes.' });
  if (categoria === 'gasto_personal') return res.status(400).json({ error: 'El gasto de personal se edita directo en la fila de la tabla, no como ajuste.' });
  if (!FORECAST_CATS.some(c => c.id === categoria)) return res.status(400).json({ error: 'Elegí una categoría válida.' });
  if (!monto) return res.status(400).json({ error: 'Ingresá el monto.' });
  const data = forecastLoad();
  if (!data.proyectado[month]) data.proyectado[month] = { ajustes: [] };
  const ajuste = { id: forecastNewId(), categoria, descripcion, monto };
  data.proyectado[month].ajustes.push(ajuste);
  forecastSave(data);
  res.json({ ok: true, ajuste });
});
app.delete('/admin/forecast/proyectado/ajuste/:month/:id', requireAdmin, (req, res) => {
  const month = String(req.params.month), id = String(req.params.id);
  const data = forecastLoad();
  const bucket = data.proyectado[month];
  if (!bucket) return res.status(404).json({ error: 'No se encontró el mes.' });
  const n = bucket.ajustes.length;
  bucket.ajustes = bucket.ajustes.filter(a => a.id !== id);
  if (bucket.ajustes.length === n) return res.status(404).json({ error: 'No se encontró el ajuste.' });
  forecastSave(data); res.json({ ok: true });
});

// ── (B) Presupuesto ──
app.get('/admin/forecast/presupuesto', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  const data = forecastLoad();
  const p = data.presupuestos[month] || { ventaProyectada: 0, pcts: {} };
  let real = null;
  try {
    const r = await pnlCompute(month, estadoRangeFromReq(req));
    real = { ingresos: r.ingresos.total, costos: r.costos, margenBruto: r.margenBruto, ebitda: r.ebitda };
  } catch {}
  const venta = Number(p.ventaProyectada) || 0;
  const montoPor = (id) => Math.round(venta * ((Number((p.pcts || {})[id]) || 0) / 100));
  const presupuesto = { ebitda: montoPor('ebitda') };
  FORECAST_CATS.forEach(c => presupuesto[c.id] = montoPor(c.id));
  res.json({ month, categorias: FORECAST_CATS, ventaProyectada: venta, pcts: p.pcts || {}, presupuesto, real });
});
app.post('/admin/forecast/presupuesto', requireAdmin, (req, res) => {
  const b = req.body || {};
  const month = /^\d{4}-\d{2}$/.test(String(b.month)) ? String(b.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes.' });
  const ventaProyectada = costosNum(b.ventaProyectada);
  const pctsIn = (b.pcts && typeof b.pcts === 'object') ? b.pcts : {};
  const validIds = new Set([...FORECAST_CATS.map(c => c.id), 'ebitda']);
  const pcts = {};
  for (const [k, v] of Object.entries(pctsIn)) {
    if (!validIds.has(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    pcts[k] = Math.round(n * 10) / 10;
  }
  const data = forecastLoad();
  data.presupuestos[month] = { ventaProyectada, pcts };
  forecastSave(data);
  res.json({ ok: true, presupuesto: data.presupuestos[month] });
});

// ── (C) Simulación anual ──
app.get('/admin/forecast/anual', requireAdmin, async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : null;
  if (!year) return res.status(400).json({ error: 'Falta el año (YYYY).' });
  const data = forecastLoad();
  const mapeo = data.simulacionAnual[year] || {};
  const curKey = forecastCurMonth();
  const plan = [];
  for (let m = 1; m <= 12; m++) {
    const key = year + '-' + String(m).padStart(2, '0');
    const esPasado = key <= curKey;
    const fuente = esPasado ? key : (mapeo[key] || null);
    const origen = esPasado ? 'real' : (fuente ? 'copiado' : null);
    plan.push({ month: key, esPasado, fuente, origen });
  }
  // Memoiza pnlCompute por mes fuente para no repetir el mismo mes varias veces
  // (meses pasados se piden siempre, y varios meses futuros pueden copiar el mismo origen).
  const cache = new Map();
  const calc = async (mes) => {
    if (cache.has(mes)) return cache.get(mes);
    const p = (async () => {
      try { const r = await pnlCompute(mes, null); return { ingresos: r.ingresos.total, costos: r.costos, margenBruto: r.margenBruto, ebitda: r.ebitda }; }
      catch (e) { return null; }
    })();
    cache.set(mes, p); return p;
  };
  const meses = [];
  for (const it of plan) {
    const valores = it.fuente ? await calc(it.fuente) : null;
    meses.push({ ...it, valores });
  }
  const totales = meses.reduce((acc, m) => {
    if (!m.valores) return acc;
    acc.ingresos += m.valores.ingresos; acc.ebitda += m.valores.ebitda; acc.margenBruto += m.valores.margenBruto;
    acc.costoDirecto += m.valores.costos.costoDirecto; acc.costoIndirecto += m.valores.costos.costoIndirecto;
    acc.gastosOper += m.valores.costos.gastosOper; acc.gastosAdmin += m.valores.costos.gastosAdmin;
    acc.gastosMarketing += m.valores.costos.gastosMarketing; acc.gastoPersonal += m.valores.costos.gastoPersonal;
    return acc;
  }, { ingresos: 0, ebitda: 0, margenBruto: 0, costoDirecto: 0, costoIndirecto: 0, gastosOper: 0, gastosAdmin: 0, gastosMarketing: 0, gastoPersonal: 0 });
  res.json({ year, meses, mapeo, totales, curMonth: curKey });
});
app.post('/admin/forecast/anual/mapeo', requireAdmin, (req, res) => {
  const b = req.body || {};
  const year = /^\d{4}$/.test(String(b.year)) ? String(b.year) : null;
  const mesObjetivo = /^\d{4}-\d{2}$/.test(String(b.mesObjetivo)) ? String(b.mesObjetivo) : null;
  const mesFuenteRaw = b.mesFuente;
  const mesFuente = (mesFuenteRaw == null || mesFuenteRaw === '') ? null : (/^\d{4}-\d{2}$/.test(String(mesFuenteRaw)) ? String(mesFuenteRaw) : undefined);
  if (!year || !mesObjetivo) return res.status(400).json({ error: 'Falta el año o el mes objetivo.' });
  if (mesFuente === undefined) return res.status(400).json({ error: 'Mes fuente inválido.' });
  const curKey = forecastCurMonth();
  if (mesObjetivo <= curKey) return res.status(400).json({ error: 'Ese mes ya ocurrió — usa sus valores reales, no se puede mapear.' });
  if (mesFuente && mesFuente > curKey) return res.status(400).json({ error: 'El mes fuente tiene que ser un mes que ya ocurrió.' });
  const data = forecastLoad();
  if (!data.simulacionAnual[year]) data.simulacionAnual[year] = {};
  if (mesFuente) data.simulacionAnual[year][mesObjetivo] = mesFuente;
  else delete data.simulacionAnual[year][mesObjetivo];
  forecastSave(data);
  res.json({ ok: true, mapeo: data.simulacionAnual[year] });
});

// ─── FORECAST OPERACIONAL (v1) ───────────────────────────────────────────
// Cuántos litros producir por marca/estilo. Fórmula (según especificación):
//   litros a producir = (demanda proyectada + inventario objetivo − inventario inicial) / (1 − % merma)
// desfasado hacia atrás según el lead time del estilo.
// Limitaciones v1 (confirmadas con el usuario antes de construir):
//  - Demanda = litros vendidos HORECA + hospitality (barriles/kegs), que ya se
//    miden en litros hoy. Retail/web (latas Shopify) quedan fuera por ahora —
//    no hay mapeo SKU→volumen de envase para convertirlas.
//  - No hay tracking de inventario real de cerveza terminada todavía → inventario
//    inicial se asume 0 (limitación conocida, no oculta: se muestra en la UI).
//  - Un solo método de proyección (estacional simple: mismo mes año anterior ×
//    tasa de crecimiento editable, con fallback a promedio de últimos meses).
//    Sin Holt-Winters, sin versionado de forecast ni seguimiento de precisión.
const OPERACIONAL_FILE = join(PROMPTS_EFFECTIVE_DIR, 'operacional.json');
// Mapeo estilo→marca confirmado con el usuario + parámetros por defecto
// (editables desde el panel): merma 8%, lead time / stock de seguridad en MESES
// (no semanas, para que calce con la granularidad mensual del resto del sistema).
const OPERACIONAL_ESTILOS_SEED = {
  'NEIPA': 'kairos', 'Weizen': 'kairos', 'Golden': 'kairos', 'Pils': 'kairos', 'APA': 'kairos', 'Red': 'kairos',
  'Obertura': 'kairos', 'Hoppy Lagger': 'kairos', 'IPA': 'kairos', 'Ambar': 'kairos', 'Osagui': 'kairos', 'Acholada': 'kairos',
  'Colección de Artista': 'kairos', 'Cachupín': 'firulais', 'Gin': 'banny', 'Ron Rey de Copas': 'banny',
};
const OPERACIONAL_CONFIG_DEF = { mermaPct: 8, leadTimeMeses: 1, stockSeguridadMeses: 1, tamanoLoteMinL: 500, tasaCrecimientoPct: 0 };
function operacionalLoad(){
  let data = { estilos: {} };
  try { if (existsSync(OPERACIONAL_FILE)) { const p = JSON.parse(readFileSync(OPERACIONAL_FILE, 'utf-8')); if (p && typeof p.estilos === 'object') data.estilos = p.estilos; } }
  catch (e) { console.warn('operacional load:', e.message); }
  let changed = false;
  for (const [estilo, marca] of Object.entries(OPERACIONAL_ESTILOS_SEED)) {
    if (!data.estilos[estilo]) { data.estilos[estilo] = { marca, ...OPERACIONAL_CONFIG_DEF }; changed = true; }
  }
  if (changed) operacionalSave(data);
  return data;
}
function operacionalSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(OPERACIONAL_FILE, JSON.stringify(d, null, 2)); }
// Litros vendidos por estilo en un mes, HORECA (cd_kairos_mall + ventas_cruzada)
// + hospitality (garden + badass) — los dos canales que ya se miden en litros.
async function opLitrosPorEstiloMes(month, rango){
  const out = {};
  const add = (estilo, litros) => { if (!estilo || estilo === 'sin mapear') return; out[estilo] = (out[estilo] || 0) + (Number(litros) || 0); };
  try {
    const est = await estadoResolve(month, rango || null);
    (est.ingresos.hospitality.garden.tabla || []).forEach(r => add(r.estilo, r.litros));
    (est.ingresos.hospitality.badass.tabla || []).forEach(r => add(r.estilo, r.litros));
    (est.ingresos.horeca.pedidos || []).forEach(p => (p.detalle || []).forEach(d => add(d.estilo, d.litros)));
  } catch (e) { /* mes sin datos de Shopify: litros quedan en 0 */ }
  return out;
}
function opShiftMonth(month, deltaMeses){
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 - Math.round(deltaMeses), 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
app.get('/admin/forecast/operacional', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : null;
  if (!month) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
  try {
    const data = operacionalLoad();
    // Fallback "promedio últimos 3 meses": se ancla al mes actual real, no al mes
    // objetivo — si se está proyectando un mes lejano en el futuro, los 3 meses
    // anteriores A ESE mes tampoco tendrían datos.
    const curMonth = forecastCurMonth();
    const [litrosAnioAnterior, litrosM1, litrosM2, litrosM3] = await Promise.all([
      opLitrosPorEstiloMes(opShiftMonth(month, 12)), // mismo mes, un año antes
      opLitrosPorEstiloMes(opShiftMonth(curMonth, 1)),
      opLitrosPorEstiloMes(opShiftMonth(curMonth, 2)),
      opLitrosPorEstiloMes(opShiftMonth(curMonth, 3)),
    ]);
    const estilos = Object.entries(data.estilos).map(([estilo, cfg]) => {
      const anioAnterior = litrosAnioAnterior[estilo] || 0;
      const promedio3m = ((litrosM1[estilo] || 0) + (litrosM2[estilo] || 0) + (litrosM3[estilo] || 0)) / 3;
      const demandaBase = anioAnterior > 0 ? anioAnterior : promedio3m;
      const fuenteDemanda = anioAnterior > 0 ? 'mismo mes año anterior' : (promedio3m > 0 ? 'promedio últimos 3 meses' : 'sin datos — cargar manual');
      const demandaProyectada = Math.round(demandaBase * (1 + (Number(cfg.tasaCrecimientoPct) || 0) / 100));
      const inventarioObjetivo = Math.round(demandaProyectada * (Number(cfg.stockSeguridadMeses) || 0));
      const inventarioInicial = 0; // v1: sin tracking real de inventario de cerveza terminada
      const merma = Math.min(0.95, Math.max(0, (Number(cfg.mermaPct) || 0) / 100));
      const produccionBruta = merma < 1 ? (demandaProyectada + inventarioObjetivo - inventarioInicial) / (1 - merma) : 0;
      const loteL = Math.max(1, Number(cfg.tamanoLoteMinL) || 1);
      const produccionLote = Math.max(0, Math.ceil(produccionBruta / loteL) * loteL);
      const mesProduccion = opShiftMonth(month, Number(cfg.leadTimeMeses) || 0);
      return { estilo, ...cfg, demandaBase: Math.round(demandaBase), demandaProyectada, fuenteDemanda, inventarioObjetivo, inventarioInicial, produccionBruta: Math.round(produccionBruta), produccionLote, mesProduccion };
    }).sort((a, b) => a.marca.localeCompare(b.marca) || a.estilo.localeCompare(b.estilo, 'es'));
    const porMarca = {};
    for (const m of COSTOS_MARCAS) porMarca[m] = { litrosProduccion: 0, litrosDemanda: 0 };
    for (const e of estilos) { const b = porMarca[e.marca] || (porMarca[e.marca] = { litrosProduccion: 0, litrosDemanda: 0 }); b.litrosProduccion += e.produccionLote; b.litrosDemanda += e.demandaProyectada; }
    res.json({ month, marcas: COSTOS_MARCAS, estilos, porMarca });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
app.post('/admin/forecast/operacional/estilo', requireAdmin, (req, res) => {
  const b = req.body || {};
  const estilo = costosStr(b.estilo, 60);
  if (!estilo) return res.status(400).json({ error: 'Falta el estilo.' });
  const data = operacionalLoad();
  const cur = data.estilos[estilo] || { marca: 'kairos', ...OPERACIONAL_CONFIG_DEF };
  const marca = COSTOS_MARCAS.includes(b.marca) ? b.marca : cur.marca;
  const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
  data.estilos[estilo] = {
    marca,
    mermaPct: Math.min(95, Math.max(0, num(b.mermaPct, cur.mermaPct))),
    leadTimeMeses: Math.min(12, Math.max(0, num(b.leadTimeMeses, cur.leadTimeMeses))),
    stockSeguridadMeses: Math.min(12, Math.max(0, num(b.stockSeguridadMeses, cur.stockSeguridadMeses))),
    tamanoLoteMinL: Math.max(1, num(b.tamanoLoteMinL, cur.tamanoLoteMinL)),
    tasaCrecimientoPct: Math.min(500, Math.max(-100, num(b.tasaCrecimientoPct, cur.tasaCrecimientoPct))),
  };
  operacionalSave(data);
  res.json({ ok: true, estilo: { estilo, ...data.estilos[estilo] } });
});

// ─── Forecast Operacional · Fase 1: ingesta y modelo de datos ──────────────
// "Prompt maestro — proyección de inventario, producción y flota de barriles":
// la base guarda HECHOS (fecha/canal/estilo/formato/litros), nunca porcentajes
// ni mezclas persistidas — el mix se calcula al vuelo cuando haga falta.
// No se conecta un "connector" nuevo: Shopify ya está integrado vía
// estadoResolve() (mismo motor de Ingreso por Venta) y Gestión Cervecera vía
// el sync de Producción — acá se AGREGAN y NORMALIZAN esos datos ya reales.
const FORECAST_OP_FILE = join(PROMPTS_EFFECTIVE_DIR, 'forecast-data.json');
// Tabla lote→estilo comercial confirmada en el reporte de Paso 0 (antes vivía
// implícita/mezclada en OPERACIONAL_ESTILOS_SEED) — acá queda editable, no hardcodeada.
const FORECAST_LOTE_ESTILO_SEED = {
  'Osagui': 'Japanese Lager', 'Acholada': 'Andes Lager', 'Ritual de la Banana': 'Weizen',
  'Kenny Bell': 'Ámbar', 'Obertura': 'Stout', 'Hoyo en Uno': 'Hoppy Lager', 'CDA': 'Colección de Artista',
};
function forecastDataDefaults(){
  return { sinonimos: {}, loteEstilo: { ...FORECAST_LOTE_ESTILO_SEED }, driverExterno: [], traspasos500: [], eventos: [], capacidadMaquila: [], capacidad: [], parametros: [], analogos: [], inventarioActual: [], quiebres: [], barrilesEventos: [] };
}
function forecastDataLoad(){
  const d = forecastDataDefaults();
  try {
    if (existsSync(FORECAST_OP_FILE)) {
      const p = JSON.parse(readFileSync(FORECAST_OP_FILE, 'utf-8'));
      if (p && typeof p === 'object') {
        if (p.sinonimos && typeof p.sinonimos === 'object') d.sinonimos = p.sinonimos;
        if (p.loteEstilo && typeof p.loteEstilo === 'object') d.loteEstilo = { ...d.loteEstilo, ...p.loteEstilo };
        for (const k of ['driverExterno', 'traspasos500', 'eventos', 'capacidadMaquila', 'capacidad', 'parametros', 'analogos', 'inventarioActual', 'quiebres', 'barrilesEventos']) {
          if (Array.isArray(p[k])) d[k] = p[k];
        }
      }
    }
  } catch (e) { console.warn('forecast-data load:', e.message); }
  return d;
}
function forecastDataSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(FORECAST_OP_FILE, JSON.stringify(d, null, 2)); }
// Normaliza un nombre de estilo al ingerir: sinónimos declarados (case-insensitive)
// primero, después mapeo lote→estilo comercial. Si no hay match, se devuelve tal
// cual (nunca se inventa un estilo) — sirve para ver en el diagnóstico qué nombres
// todavía no están mapeados.
function forecastNormalizeEstilo(raw, d){
  const data = d || forecastDataLoad();
  const s = String(raw || '').trim();
  if (!s) return '';
  const sinKey = Object.keys(data.sinonimos).find(k => k.toLowerCase() === s.toLowerCase());
  if (sinKey) return data.sinonimos[sinKey];
  const loteKey = Object.keys(data.loteEstilo).find(k => k.toLowerCase() === s.toLowerCase());
  if (loteKey) return data.loteEstilo[loteKey];
  return s;
}
// Resuelve el valor vigente de un parámetro/capacidad versionado a una fecha dada
// (por defecto hoy): la entrada con vigenteDesde <= fecha más reciente. Nunca
// sobreescribe en el archivo — el historial completo queda siempre disponible.
function forecastVigente(lista, filtro, fechaRef){
  const ref = fechaRef || new Date().toISOString().slice(0, 10);
  const candidatas = (lista || []).filter(e => filtro(e) && e.vigenteDesde <= ref).sort((a, b) => b.vigenteDesde.localeCompare(a.vigenteDesde));
  return candidatas[0] || null;
}
// Parámetro versionado, opcionalmente por estilo: si hay una entrada específica
// del estilo la usa, si no cae al valor general de la clave (estilo=null); si
// no hay ninguna, devuelve el valor por defecto — nunca inventa, solo declara
// explícitamente cuál es el default hasta que alguien lo cargue en Parámetros.
function forecastParamVigente(clave, estilo, data, defecto){
  const d = data || forecastDataLoad();
  if (estilo) { const esp = forecastVigente(d.parametros, p => p.clave === clave && p.estilo === estilo); if (esp) return esp.valor; }
  const gen = forecastVigente(d.parametros, p => p.clave === clave && !p.estilo);
  return gen ? gen.valor : defecto;
}
// Filas de ventas (HECHOS: fecha/canal/estilo/litros) de un mes, reusando
// estadoResolve (mismo Shopify ya integrado en Ingreso por Venta) — sin volver
// a pedir nada a Shopify por separado. Canales con litros medidos hoy: CD Kairos,
// Ventas Cruzada (500 Sabores), Garden Vespucio, Badass, Antofagasta (manual).
async function forecastVentasDelMes(month, data){
  const d = data || forecastDataLoad();
  const rows = [];
  let est;
  try { est = await estadoResolve(month, null); } catch (e) { return { rows, error: String(e.message || e).slice(0, 200) }; }
  if (!est.shopifyOk) return { rows, error: est.shopifyError || 'Shopify no disponible para este mes.' };
  const add = (fecha, canal, estilo, litros) => {
    const lt = Number(litros) || 0; if (!fecha || !lt || !estilo || estilo === 'sin mapear') return;
    rows.push({ fecha, canal, estilo: forecastNormalizeEstilo(estilo, d), litros: lt });
  };
  (est.ingresos.cd_kairos.pedidos || []).forEach(p => (p.detalle || []).forEach(l => add(p.fecha, 'cd_kairos', l.estilo, l.litros)));
  (est.ingresos.ventas_cruzada.pedidos || []).forEach(p => (p.detalle || []).forEach(l => add(p.fecha, 'ventas_cruzada', l.estilo, l.litros)));
  (est.ingresos.hospitality.garden.pedidos || []).forEach(p => (p.lineas || []).forEach(l => add(p.fecha, 'garden', l.estilo, l.litros)));
  (est.ingresos.hospitality.badass.pedidos || []).forEach(p => (p.lineas || []).forEach(l => add(p.fecha, 'badass', l.estilo, l.litros)));
  // Antofagasta: tabla manual del mes (per.antofagasta), sin fecha por línea —
  // se ancla al día 1 del mes, es lo más honesto que se puede hacer sin fecha real.
  (est.periodo.antofagasta || []).forEach(r => add(month + '-01', 'antofagasta', r.estilo, r.litros));
  return { rows, error: null };
}
// Cifras de referencia 2025 tal como las trae el documento (para la validación de
// reconciliación de Fase 1) — NO son un cálculo del sistema, son el ancla externa
// contra la que se compara lo que el sistema efectivamente suma.
const FORECAST_RECON_REF = {
  '2025': { cd_kairos: 96267, garden: 97334, antofagasta: 28084, badass: 11753, eventos: 4072, total: 237510 },
};
app.get('/admin/forecast/reconciliacion', requireAdmin, async (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : '2025';
  try {
    const d = forecastDataLoad();
    const meses = Array.from({ length: 12 }, (_, i) => year + '-' + String(i + 1).padStart(2, '0'));
    const porCanal = { cd_kairos: 0, ventas_cruzada: 0, garden: 0, badass: 0, antofagasta: 0 };
    const mesesConError = [];
    for (const m of meses) {
      const { rows, error } = await forecastVentasDelMes(m, d);
      if (error) { mesesConError.push({ mes: m, error }); continue; }
      for (const r of rows) if (porCanal[r.canal] != null) porCanal[r.canal] += r.litros;
    }
    const eventosLitros = (d.eventos || []).filter(e => String(e.fecha || '').slice(0, 4) === year).reduce((a, e) => a + (Number(e.litros) || 0), 0);
    const computado = { ...porCanal, eventos: eventosLitros };
    const ref = FORECAST_RECON_REF[year] || null;
    const canalesRef = ['cd_kairos', 'garden', 'antofagasta', 'badass', 'eventos'];
    const filas = [...canalesRef, 'ventas_cruzada'].map(canal => ({
      canal, computado: Math.round(computado[canal] || 0),
      referencia: ref && ref[canal] != null ? ref[canal] : null,
      delta: (ref && ref[canal] != null) ? Math.round(computado[canal] || 0) - ref[canal] : null,
    }));
    const totalComputado = canalesRef.reduce((a, c) => a + (computado[c] || 0), 0);
    res.json({ year, filas, totalComputado: Math.round(totalComputado), totalReferencia: ref ? ref.total : null, mesesConError, tieneReferencia: !!ref });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
app.get('/admin/forecast/data', requireAdmin, (req, res) => {
  const d = forecastDataLoad();
  // Además del historial completo, resuelve qué valor está VIGENTE hoy para cada
  // combinación tipo+sede de capacidad y cada clave de parámetro — así el frontend
  // no repite la lógica de "el más reciente con vigenteDesde <= hoy".
  const capClaves = [...new Set((d.capacidad || []).map(c => c.tipo + '|' + (c.sede || '')))];
  const capacidadVigente = capClaves.map(k => { const [tipo, sede] = k.split('|'); return forecastVigente(d.capacidad, c => c.tipo === tipo && (c.sede || '') === sede); }).filter(Boolean);
  const paramClaves = [...new Set((d.parametros || []).map(p => p.clave + '|' + (p.estilo || '')))];
  const parametrosVigentes = paramClaves.map(k => { const [clave, estilo] = k.split('|'); return forecastVigente(d.parametros, p => p.clave === clave && (p.estilo || '') === estilo); }).filter(Boolean);
  res.json({ ...d, capacidadVigente, parametrosVigentes });
});
const FORECAST_LISTS = ['driverExterno', 'traspasos500', 'eventos', 'capacidadMaquila', 'capacidad', 'parametros', 'analogos', 'inventarioActual', 'quiebres', 'barrilesEventos'];
app.post('/admin/forecast/data/:list', requireAdmin, (req, res) => {
  const list = req.params.list;
  if (!FORECAST_LISTS.includes(list)) return res.status(400).json({ error: 'Lista inválida.' });
  const b = req.body || {};
  const sess = adminSessionFor(req);
  const quien = (sess && (sess.nombre || sess.apodo || sess.username)) || 'admin';
  const entry = { id: randomBytes(6).toString('hex'), creadoPor: quien, creadoEn: new Date().toISOString() };
  const fecha = /^\d{4}-\d{2}-\d{2}$/, mes = /^\d{4}-\d{2}$/;
  if (list === 'driverExterno') {
    if (!mes.test(b.mes)) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
    entry.mes = b.mes; entry.litrosMilSabores = Math.max(0, Number(b.litrosMilSabores) || 0); entry.nota = costosStr(b.nota, 200);
  } else if (list === 'traspasos500' || list === 'eventos') {
    if (!fecha.test(b.fecha)) return res.status(400).json({ error: 'Falta la fecha (YYYY-MM-DD).' });
    entry.fecha = b.fecha; entry.estilo = costosStr(b.estilo, 60); entry.formato = prodFormatoOk(b.formato);
    entry.litros = Math.max(0, Number(b.litros) || 0);
    if (list === 'eventos') entry.motivo = costosStr(b.motivo || b.nota, 200); else entry.nota = costosStr(b.nota, 200);
  } else if (list === 'capacidadMaquila') {
    if (!mes.test(b.mes)) return res.status(400).json({ error: 'Falta el mes (YYYY-MM).' });
    entry.mes = b.mes; entry.sede = costosStr(b.sede, 40); entry.litrosReservados = Math.max(0, Number(b.litrosReservados) || 0); entry.nota = costosStr(b.nota, 200);
  } else if (list === 'capacidad') {
    if (!costosStr(b.tipo) || !fecha.test(b.vigenteDesde)) return res.status(400).json({ error: 'Falta el tipo o la fecha de vigencia (YYYY-MM-DD).' });
    entry.tipo = costosStr(b.tipo, 40); entry.sede = costosStr(b.sede, 40); entry.valor = Math.max(0, Number(b.valor) || 0);
    entry.unidad = costosStr(b.unidad || 'L', 10); entry.vigenteDesde = b.vigenteDesde; entry.nota = costosStr(b.nota, 200);
  } else if (list === 'parametros') {
    if (!costosStr(b.clave) || !fecha.test(b.vigenteDesde)) return res.status(400).json({ error: 'Falta la clave o la fecha de vigencia (YYYY-MM-DD).' });
    entry.clave = costosStr(b.clave, 60); entry.estilo = costosStr(b.estilo, 60) || null; entry.valor = Number(b.valor); entry.vigenteDesde = b.vigenteDesde; entry.nota = costosStr(b.nota, 200);
  } else if (list === 'analogos') {
    if (!costosStr(b.canal) || !costosStr(b.analogoCanal)) return res.status(400).json({ error: 'Falta el canal o el análogo.' });
    entry.canal = costosStr(b.canal, 40); entry.estilo = costosStr(b.estilo, 60) || null;
    entry.analogoCanal = costosStr(b.analogoCanal, 40); entry.analogoEstilo = costosStr(b.analogoEstilo, 60) || null;
    entry.nota = costosStr(b.nota, 200);
  } else if (list === 'inventarioActual') {
    if (!fecha.test(b.fecha) || !costosStr(b.estilo)) return res.status(400).json({ error: 'Falta la fecha o el estilo.' });
    entry.fecha = b.fecha; entry.estilo = costosStr(b.estilo, 60); entry.formato = prodFormatoOk(b.formato);
    entry.litros = Math.max(0, Number(b.litros) || 0); entry.nota = costosStr(b.nota, 200);
  } else if (list === 'quiebres') {
    if (!mes.test(b.mes) || !costosStr(b.canal) || !costosStr(b.estilo)) return res.status(400).json({ error: 'Falta el mes, el canal o el estilo.' });
    entry.mes = b.mes; entry.canal = costosStr(b.canal, 40); entry.estilo = costosStr(b.estilo, 60);
    entry.litrosObservados = Math.max(0, Number(b.litrosObservados) || 0); entry.litrosCorregidos = Math.max(0, Number(b.litrosCorregidos) || 0);
    entry.nota = costosStr(b.nota, 200);
  } else if (list === 'barrilesEventos') {
    if (!fecha.test(b.fecha) || !['despacho', 'retorno'].includes(b.tipo) || !costosStr(b.puntoVenta)) return res.status(400).json({ error: 'Falta la fecha, el tipo (despacho/retorno) o el punto de venta.' });
    entry.fecha = b.fecha; entry.tipo = b.tipo; entry.formato = prodFormatoOk(b.formato) === 'lata' ? 'barril20' : prodFormatoOk(b.formato);
    entry.puntoVenta = costosStr(b.puntoVenta, 60); entry.cantidad = Math.max(1, Math.round(Number(b.cantidad) || 1)); entry.nota = costosStr(b.nota, 200);
  }
  const d = forecastDataLoad(); d[list].push(entry); forecastDataSave(d);
  res.json({ ok: true, entry });
});
// Nota de orden: las rutas específicas de sinónimo/lote-estilo van ANTES del
// DELETE genérico :list/:id — si no, el genérico las intercepta primero (Express
// matchea por orden de registro) y nunca llegan a ejecutarse.
app.put('/admin/forecast/data/sinonimo', requireAdmin, (req, res) => {
  const b = req.body || {}; const desde = costosStr(b.desde, 60), hacia = costosStr(b.hacia, 60);
  if (!desde || !hacia) return res.status(400).json({ error: 'Falta el nombre de origen o de destino.' });
  const d = forecastDataLoad(); d.sinonimos[desde] = hacia; forecastDataSave(d); res.json({ ok: true });
});
app.delete('/admin/forecast/data/sinonimo/:desde', requireAdmin, (req, res) => {
  const d = forecastDataLoad(); delete d.sinonimos[decodeURIComponent(req.params.desde)]; forecastDataSave(d); res.json({ ok: true });
});
app.put('/admin/forecast/data/lote-estilo', requireAdmin, (req, res) => {
  const b = req.body || {}; const lote = costosStr(b.lote, 60), estilo = costosStr(b.estilo, 60);
  if (!lote || !estilo) return res.status(400).json({ error: 'Falta el lote o el estilo comercial.' });
  const d = forecastDataLoad(); d.loteEstilo[lote] = estilo; forecastDataSave(d); res.json({ ok: true });
});
app.delete('/admin/forecast/data/lote-estilo/:lote', requireAdmin, (req, res) => {
  const d = forecastDataLoad(); delete d.loteEstilo[decodeURIComponent(req.params.lote)]; forecastDataSave(d); res.json({ ok: true });
});
app.delete('/admin/forecast/data/:list/:id', requireAdmin, (req, res) => {
  const list = req.params.list;
  if (!FORECAST_LISTS.includes(list)) return res.status(400).json({ error: 'Lista inválida.' });
  const d = forecastDataLoad(); d[list] = d[list].filter(e => e.id !== req.params.id); forecastDataSave(d);
  res.json({ ok: true });
});

// ─── Forecast Operacional · Fase 2: motor de pronóstico (capas 1–3) ────────
// "Prompt maestro", sección 4: descomposición de serie, driver externo, cascada
// a estilo. Verificado con datos sintéticos antes de conectarlo a datos reales
// (promedio móvil, índice estacional, R² y detección de pedido de apertura dan
// los valores esperados). Nunca rellena huecos con promedios ni proyecta con
// <24 meses de estacionalidad propia — ver reglas 5.1/5.2 del documento.
function forecastMedian(arr){
  const s = arr.slice().sort((a, b) => a - b); const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
// Regla 5.1: excluye el pedido de apertura de tendencia/estacionalidad si el
// primer mes con venta es >3x la mediana de los 3 meses siguientes.
function forecastDetectarApertura(serie){
  const first = serie.findIndex(p => p.litros > 0);
  if (first < 0 || first + 3 >= serie.length) return -1;
  const next3 = serie.slice(first + 1, first + 4).map(p => p.litros);
  const med = forecastMedian(next3);
  return (med > 0 && serie[first].litros > med * 3) ? first : -1;
}
function forecastPromedioMovil12(serie, excluirIdx){
  const out = new Array(serie.length).fill(null);
  for (let i = 11; i < serie.length; i++){
    let sum = 0, n = 0;
    for (let j = i - 11; j <= i; j++){ if (j === excluirIdx) continue; sum += serie[j].litros; n++; }
    out[i] = n ? sum / n : null;
  }
  return out;
}
function forecastIndiceEstacional(serie, pm, excluirIdx){
  const porMes = {};
  for (let i = 0; i < serie.length; i++){
    if (i === excluirIdx || pm[i] == null || pm[i] === 0) continue;
    const mesNum = Number(serie[i].mes.slice(5, 7));
    (porMes[mesNum] = porMes[mesNum] || []).push(serie[i].litros / pm[i]);
  }
  const idx = {};
  for (let m = 1; m <= 12; m++){ const arr = porMes[m] || []; idx[m] = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
  const vals = Object.values(idx).filter(v => v != null);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  for (const m of Object.keys(idx)) if (idx[m] != null) idx[m] = idx[m] / avg;
  return idx;
}
function forecastRegresionLineal(ys, excluirSet){
  const pts = []; ys.forEach((y, i) => { if (y != null && !excluirSet.has(i)) pts.push([i, y]); });
  const n = pts.length;
  if (n < 2) return { pendiente: 0, intercepto: pts[0] ? pts[0][1] : 0, r2: 0 };
  const sumX = pts.reduce((a, p) => a + p[0], 0), sumY = pts.reduce((a, p) => a + p[1], 0);
  const meanX = sumX / n, meanY = sumY / n;
  let num = 0, den = 0;
  pts.forEach(([x, y]) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2; });
  const pendiente = den ? num / den : 0, intercepto = meanY - pendiente * meanX;
  let ssRes = 0, ssTot = 0;
  pts.forEach(([x, y]) => { const pred = intercepto + pendiente * x; ssRes += (y - pred) ** 2; ssTot += (y - meanY) ** 2; });
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { pendiente, intercepto, r2 };
}
function forecastStdDev(arr){
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
}
// Capa 1 — mínimo 24 meses limpios para estacionalidad PROPIA (nunca se calcula
// con menos; ver forecastResolverEstacionalidad para el préstamo de análogo).
function forecastDecompose(serie){
  if (serie.length < 24) return { ok: false, reason: 'serie_corta', mesesDisponibles: serie.length };
  const aperturaIdx = forecastDetectarApertura(serie);
  const pm = forecastPromedioMovil12(serie, aperturaIdx);
  const indiceEstacional = forecastIndiceEstacional(serie, pm, aperturaIdx);
  const excluirSet = new Set(aperturaIdx >= 0 ? [aperturaIdx] : []);
  const tendencia = forecastRegresionLineal(pm, excluirSet);
  const residuos = pm.map((v, i) => (v != null && !excluirSet.has(i)) ? v - (tendencia.intercepto + tendencia.pendiente * i) : null).filter(v => v != null);
  return {
    ok: true, mesesUsados: serie.length, aperturaExcluida: aperturaIdx >= 0 ? serie[aperturaIdx].mes : null,
    promedioMovil: pm, indiceEstacional, tendencia, desviacionResiduos: forecastStdDev(residuos),
  };
}
// N meses de litros (fecha→canal→estilo ya normalizado) hasta hastaMes inclusive,
// agregados por mes. estilo=null agrega TODOS los estilos del canal.
async function forecastSerieMensual(canal, estilo, hastaMes, nMeses, data){
  const d = data || forecastDataLoad();
  const out = []; const mesesConError = [];
  const [y0, m0] = hastaMes.split('-').map(Number);
  for (let i = nMeses - 1; i >= 0; i--){
    const dt = new Date(y0, m0 - 1 - i, 1);
    const mes = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    const { rows, error } = await forecastVentasDelMes(mes, d);
    if (error) { mesesConError.push({ mes, error }); out.push({ mes, litros: null }); continue; }
    const filtradas = rows.filter(r => r.canal === canal && (estilo == null || r.estilo === estilo));
    out.push({ mes, litros: filtradas.reduce((a, r) => a + r.litros, 0) });
  }
  return { serie: out, mesesConError };
}
// Regla 5.2: serie corta (<24m) toma prestada la estacionalidad de un análogo
// DECLARADO (nunca el promedio de la empresa) — si no hay análogo declarado,
// falla ruidosamente en vez de inventar un patrón.
async function forecastResolverEstacionalidad(canal, estilo, hastaMes, data, profundidad){
  const d = data || forecastDataLoad();
  const { serie, mesesConError } = await forecastSerieMensual(canal, estilo, hastaMes, 30, d);
  const serieLimpia = serie.filter(p => p.litros != null);
  const dec = forecastDecompose(serieLimpia);
  if (dec.ok) return { ...dec, fuente: 'propia', canal, estilo, serie, mesesConError };
  if ((profundidad || 0) > 1) return { ok: false, reason: 'analogo_circular', mesesDisponibles: serieLimpia.length };
  const analogo = (d.analogos || []).find(a => a.canal === canal && (a.estilo || null) === (estilo || null));
  if (!analogo) return { ok: false, reason: 'sin_analogo', mesesDisponibles: serieLimpia.length, canal, estilo, serie, mesesConError };
  const prestada = await forecastResolverEstacionalidad(analogo.analogoCanal, analogo.analogoEstilo || null, hastaMes, d, (profundidad || 0) + 1);
  if (!prestada.ok) return { ok: false, reason: 'analogo_sin_datos', mesesDisponibles: serieLimpia.length, analogoIntentado: analogo, canal, estilo, serie, mesesConError };
  return { ok: true, fuente: 'analogo', analogoUsado: { canal: analogo.analogoCanal, estilo: analogo.analogoEstilo || null }, indiceEstacional: prestada.indiceEstacional, tendencia: forecastRegresionLineal(forecastPromedioMovil12(serieLimpia, forecastDetectarApertura(serieLimpia)), new Set()), mesesUsados: serieLimpia.length, desviacionResiduos: prestada.desviacionResiduos, canal, estilo, serie, mesesConError };
}
// Capa 2 — participación de Kairos en Grupo Mil Sabores (driver externo, dato
// manual), suavizada 3m; alerta si el último mes se desvía >2 desv. estándar.
async function forecastDriverExterno(hastaMes, data){
  const d = data || forecastDataLoad();
  const { serie } = await forecastSerieMensual('cd_kairos', null, hastaMes, 24, d);
  const driverPorMes = {}; (d.driverExterno || []).forEach(e => { driverPorMes[e.mes] = e.litrosMilSabores; });
  const puntos = serie.filter(p => p.litros != null && driverPorMes[p.mes] > 0).map(p => ({ mes: p.mes, ratio: p.litros / driverPorMes[p.mes] }));
  if (puntos.length < 3) return { ok: false, reason: 'sin_datos_suficientes', mesesConDriver: puntos.length };
  const suavizado = puntos.map((p, i) => { const w = puntos.slice(Math.max(0, i - 2), i + 1); return w.reduce((a, x) => a + x.ratio, 0) / w.length; });
  const ratios = puntos.map(p => p.ratio);
  const std = forecastStdDev(ratios);
  const ultimo = ratios[ratios.length - 1], ultimoSuavizado = suavizado[suavizado.length - 2] ?? suavizado[suavizado.length - 1];
  const desviado = std > 0 && Math.abs(ultimo - ultimoSuavizado) > 2 * std;
  return { ok: true, puntos, suavizado, desviacionEstandar: Math.round(std * 1000) / 1000, ultimoRatio: Math.round(ultimo * 1000) / 1000, alertaDesviacion: desviado };
}
// Capa 3 — mix por estilo dentro de un canal, calculado AL VUELO (nunca
// persistido). Umbral 8% de participación anual + 18 meses de dato para que un
// estilo tenga estacionalidad propia; si no, usa el patrón estacional del canal.
async function forecastMixEstiloCanal(canal, hastaMes, data){
  const d = data || forecastDataLoad();
  const { serie: serieMeses } = await forecastSerieMensual(canal, null, hastaMes, 12, d);
  const totalCanal = serieMeses.filter(p => p.litros != null).reduce((a, p) => a + p.litros, 0);
  // Recompone por estilo pidiendo cada mes de nuevo (los hechos no traen desglose
  // por estilo pre-agregado a nivel de forecastSerieMensual cuando estilo=null).
  const porEstilo = {};
  const [y0, m0] = hastaMes.split('-').map(Number);
  for (let i = 11; i >= 0; i--){
    const dt = new Date(y0, m0 - 1 - i, 1);
    const mes = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    const { rows, error } = await forecastVentasDelMes(mes, d);
    if (error) continue;
    rows.filter(r => r.canal === canal).forEach(r => { porEstilo[r.estilo] = (porEstilo[r.estilo] || 0) + r.litros; });
  }
  const mix = Object.entries(porEstilo).map(([estilo, litros]) => ({ estilo, litros, pct: totalCanal ? Math.round((litros / totalCanal) * 1000) / 10 : 0 })).sort((a, b) => b.litros - a.litros);
  return { canal, totalCanal, mix };
}
// Backtesting walk-forward: para cada mes de prueba, entrena SOLO con lo
// anterior a ese mes (ventana expansiva, mínimo 24), pronostica y compara
// contra el real. MAPE/sesgo — sesgo consistente en el tiempo delata un
// supuesto malo, no ruido (ver sección 9 del documento).
async function forecastBacktestSerie(canal, estilo, hastaMes, nMesesTest, data){
  const d = data || forecastDataLoad();
  const total = await forecastSerieMensual(canal, estilo, hastaMes, 24 + nMesesTest, d);
  const serieCompleta = total.serie;
  if (serieCompleta.filter(p => p.litros != null).length < 24 + nMesesTest) {
    return { ok: false, reason: 'historia_insuficiente', mesesDisponibles: serieCompleta.filter(p => p.litros != null).length, mesesNecesarios: 24 + nMesesTest };
  }
  const pares = [];
  for (let k = nMesesTest; k >= 1; k--){
    const idxCorte = serieCompleta.length - k; // primer mes NO visto por el modelo
    const entreno = serieCompleta.slice(0, idxCorte).filter(p => p.litros != null);
    if (entreno.length < 24) continue;
    const dec = forecastDecompose(entreno);
    if (!dec.ok) continue;
    const mesObjetivo = serieCompleta[idxCorte];
    if (mesObjetivo.litros == null) continue;
    const mesNum = Number(mesObjetivo.mes.slice(5, 7));
    const idxPred = entreno.length; // siguiente punto en la serie de entrenamiento
    const tendenciaVal = dec.tendencia.intercepto + dec.tendencia.pendiente * idxPred;
    const idxEst = dec.indiceEstacional[mesNum] != null ? dec.indiceEstacional[mesNum] : 1;
    const pronostico = Math.max(0, tendenciaVal * idxEst);
    pares.push({ mes: mesObjetivo.mes, real: mesObjetivo.litros, pronostico: Math.round(pronostico) });
  }
  if (!pares.length) return { ok: false, reason: 'sin_pares_validos', mesesDisponibles: serieCompleta.filter(p => p.litros != null).length };
  const validos = pares.filter(p => p.real > 0);
  const mape = validos.length ? validos.reduce((a, p) => a + Math.abs((p.pronostico - p.real) / p.real), 0) / validos.length : null;
  const sesgo = validos.length ? validos.reduce((a, p) => a + (p.pronostico - p.real) / p.real, 0) / validos.length : null;
  return { ok: true, pares, mape: mape != null ? Math.round(mape * 1000) / 10 : null, sesgo: sesgo != null ? Math.round(sesgo * 1000) / 10 : null, n: validos.length };
}
function forecastMesActualStr(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
const FORECAST_PROY_CANALES = ['cd_kairos', 'ventas_cruzada', 'garden', 'badass', 'antofagasta'];
app.get('/admin/forecast/canales', requireAdmin, (req, res) => { res.json({ canales: FORECAST_PROY_CANALES }); });
app.get('/admin/forecast/proyeccion', requireAdmin, async (req, res) => {
  const canal = String(req.query.canal || '');
  if (!FORECAST_PROY_CANALES.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });
  const estilo = req.query.estilo ? costosStr(req.query.estilo, 60) : null;
  const horizonte = Math.min(12, Math.max(1, parseInt(req.query.horizonte, 10) || 6));
  const hastaMes = /^\d{4}-\d{2}$/.test(String(req.query.hasta)) ? String(req.query.hasta) : forecastMesActualStr();
  try {
    const d = forecastDataLoad();
    const res1 = await forecastResolverEstacionalidad(canal, estilo, hastaMes, d, 0);
    if (!res1.ok) return res.json({ ok: false, canal, estilo, reason: res1.reason, mesesDisponibles: res1.mesesDisponibles, serie: res1.serie || [], mesesConError: res1.mesesConError || [], analogoIntentado: res1.analogoIntentado || null });
    const puntos = [];
    const [y0, m0] = hastaMes.split('-').map(Number);
    const nBase = res1.mesesUsados;
    for (let h = 1; h <= horizonte; h++){
      const dt = new Date(y0, m0 - 1 + h, 1);
      const mes = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
      const mesNum = dt.getMonth() + 1;
      const idx = nBase - 1 + h;
      const tendenciaVal = res1.tendencia.intercepto + res1.tendencia.pendiente * idx;
      const idxEst = res1.indiceEstacional[mesNum] != null ? res1.indiceEstacional[mesNum] : 1;
      const central = Math.max(0, tendenciaVal * idxEst);
      const banda = 1.28 * (res1.desviacionResiduos || 0) * Math.sqrt(h);
      puntos.push({ mes, central: Math.round(central), bandaBaja: Math.round(Math.max(0, central - banda)), bandaAlta: Math.round(central + banda) });
    }
    let confiabilidad = 'dato_real';
    if (res1.fuente === 'analogo') confiabilidad = 'estacionalidad_prestada';
    else if (res1.tendencia.r2 < 0.3) confiabilidad = 'tendencia_no_confiable';
    res.json({ ok: true, canal, estilo, fuente: res1.fuente, analogoUsado: res1.analogoUsado || null, confiabilidad, r2: Math.round(res1.tendencia.r2 * 1000) / 1000, aperturaExcluida: res1.aperturaExcluida || null, mesesUsados: res1.mesesUsados, mesesConError: res1.mesesConError, puntos });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
app.get('/admin/forecast/mix-estilo', requireAdmin, async (req, res) => {
  const canal = String(req.query.canal || '');
  if (!FORECAST_PROY_CANALES.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });
  const hastaMes = /^\d{4}-\d{2}$/.test(String(req.query.hasta)) ? String(req.query.hasta) : forecastMesActualStr();
  try { res.json(await forecastMixEstiloCanal(canal, hastaMes, forecastDataLoad())); }
  catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
app.get('/admin/forecast/precision', requireAdmin, async (req, res) => {
  const canal = String(req.query.canal || '');
  if (!FORECAST_PROY_CANALES.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });
  const estilo = req.query.estilo ? costosStr(req.query.estilo, 60) : null;
  const hastaMes = /^\d{4}-\d{2}$/.test(String(req.query.hasta)) ? String(req.query.hasta) : forecastMesActualStr();
  const nMesesTest = Math.min(12, Math.max(3, parseInt(req.query.meses, 10) || 6));
  try { res.json(await forecastBacktestSerie(canal, estilo, hastaMes, nMesesTest, forecastDataLoad())); }
  catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});

// ─── Forecast Operacional · Fase 3: plan de producción y factibilidad (capas 4-5) ───
// Requerimiento neto = pronóstico + stock de seguridad − inventario disponible −
// producción en tránsito, redondeado al lote mínimo factible del estilo (el que
// ya existe en Operacional — no se duplica). SS = z·σ_error·√(leadTime/30), con
// σ_error salido del backtesting REAL (Fase 2), nunca un supuesto fijo.
async function forecastRequerimientoNeto(canal, estilo, mesObjetivo, data){
  const d = data || forecastDataLoad();
  const hastaMes = opShiftMonth(mesObjetivo, 1); // mes anterior al objetivo = último dato de entrenamiento
  const res1 = await forecastResolverEstacionalidad(canal, estilo, hastaMes, d, 0);
  if (!res1.ok) return { ok: false, reason: res1.reason, mesesDisponibles: res1.mesesDisponibles };
  const mesNum = Number(mesObjetivo.slice(5, 7));
  const idx = res1.mesesUsados;
  const tendenciaVal = res1.tendencia.intercepto + res1.tendencia.pendiente * idx;
  const idxEst = res1.indiceEstacional[mesNum] != null ? res1.indiceEstacional[mesNum] : 1;
  const central = Math.max(0, tendenciaVal * idxEst);

  const bt = await forecastBacktestSerie(canal, estilo, hastaMes, 6, d);
  let sigmaError = null, sigmaFuente = 'sin_datos';
  if (bt.ok && bt.pares.length >= 3) { sigmaError = forecastStdDev(bt.pares.map(p => p.pronostico - p.real)); sigmaFuente = 'backtest'; }

  const z = forecastParamVigente('z_nivelServicio', estilo, d, 1.65);
  const leadTimePlanDias = forecastParamVigente('leadTimePlanDias', estilo, d, 21);
  const stockSeguridad = sigmaError != null ? z * sigmaError * Math.sqrt(leadTimePlanDias / 30) : null;

  // Inventario disponible: manual (no hay tracking automático de cerveza terminada — ver Paso 0).
  const invEntry = (d.inventarioActual || []).filter(e => e.estilo === estilo).sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
  const inventarioDisponible = invEntry ? invEntry.litros : 0;

  // Producción en tránsito: lotes REALES del estilo que aún no completaron envasado.
  const prod = prodLoad();
  const enTransito = (prod.lotes || []).filter(l => (l.estilo || '') === estilo && !l.fechaEnvasado)
    .reduce((a, l) => a + Math.max(0, prodVolumenBase(l) - prodLitrosEnvasados(l)), 0);

  const neto = Math.max(0, central + (stockSeguridad || 0) - inventarioDisponible - enTransito);
  const opCfg = (operacionalLoad().estilos || {})[estilo] || {};
  const loteMinL = Math.max(1, Number(opCfg.tamanoLoteMinL) || 500);
  const loteRedondeado = Math.ceil(neto / loteMinL) * loteMinL;

  return {
    ok: true, canal, estilo, mesObjetivo,
    pronosticoCentral: Math.round(central), fuenteProyeccion: res1.fuente, r2: Math.round(res1.tendencia.r2 * 1000) / 1000,
    sigmaError: sigmaError != null ? Math.round(sigmaError) : null, sigmaFuente, z, leadTimePlanDias,
    stockSeguridad: stockSeguridad != null ? Math.round(stockSeguridad) : null,
    inventarioDisponible, inventarioFecha: invEntry ? invEntry.fecha : null,
    produccionEnTransito: Math.round(enTransito),
    requerimientoNeto: Math.round(neto), tamanoLoteMinL: loteMinL, loteRedondeado,
  };
}
// Regla 5.4: si el lote mínimo excede la demanda ANUAL proyectada del estilo, no
// se programa automático — 3 opciones cuantificadas (nunca un plan imposible).
async function forecastRegla54(canal, estilo, mesObjetivo, data){
  const d = data || forecastDataLoad();
  const hastaMes = opShiftMonth(mesObjetivo, 1);
  const res1 = await forecastResolverEstacionalidad(canal, estilo, hastaMes, d, 0);
  if (!res1.ok) return { aplica: false };
  const opCfg = (operacionalLoad().estilos || {})[estilo] || {};
  const loteMinL = Math.max(1, Number(opCfg.tamanoLoteMinL) || 500);
  let demandaAnual = 0, mesPeak = null, valorPeak = -1;
  for (let h = 1; h <= 12; h++){
    const dt = opShiftMonth(mesObjetivo, -(h - 1));
    const mesNum = Number(dt.slice(5, 7));
    const idx = res1.mesesUsados - 1 + h;
    const val = Math.max(0, (res1.tendencia.intercepto + res1.tendencia.pendiente * idx) * (res1.indiceEstacional[mesNum] != null ? res1.indiceEstacional[mesNum] : 1));
    demandaAnual += val;
    if (val > valorPeak) { valorPeak = val; mesPeak = dt; }
  }
  if (loteMinL <= demandaAnual) return { aplica: false };
  let precioLt = null;
  try { const est = await estadoResolve(hastaMes, null); precioLt = est.precios.cerveza; } catch (e) {}
  const sobrante = loteMinL - demandaAnual;
  return {
    aplica: true, loteMinL: Math.round(loteMinL), demandaAnual: Math.round(demandaAnual), mesPeak,
    opciones: {
      producirEstimarMerma: { litrosSobrantes: Math.round(sobrante), mermaAdicionalPct: Number(opCfg.mermaPct) || 0 },
      concentrarAntesDelPeak: { mesRecomendado: mesPeak },
      descontinuar: { litrosVentaAnual: Math.round(demandaAnual), valorAnualEstimado: precioLt != null ? Math.round(demandaAnual * precioLt) : null, notaValor: 'valorizado al precio de transferencia interno, no es margen neto' },
    },
  };
}
// Capa 5 — factibilidad contra 4 restricciones EN ORDEN: fermentación (real),
// cámara de frío (manual, por instalación separada — nunca se suman sedes
// distintas), flota de barriles (sin trazabilidad hoy — ver Paso 0), envasado
// (manual). Nunca entrega un plan imposible sin decir qué restricción se ató.
function forecastFactibilidad(litrosAProducir, mesObjetivo, data){
  const d = data || forecastDataLoad();
  const prod = prodLoad();
  const porSede = {};
  (prod.tanques || []).forEach(t => { porSede[t.sede] = (porSede[t.sede] || 0) + (Number(t.capacidadL) || 0); });
  const fermentacion = Object.entries(porSede).map(([sede, cap]) => ({ sede, capacidadL: cap }));
  const capFermentacionTotal = fermentacion.reduce((a, f) => a + f.capacidadL, 0);
  const usoFermentacionPct = capFermentacionTotal ? Math.round((litrosAProducir / capFermentacionTotal) * 1000) / 10 : null;

  const fechaRef = mesObjetivo + '-15';
  const camaraSedes = [...new Set((d.capacidad || []).filter(c => c.tipo === 'camara_frio').map(c => c.sede))];
  const capCamaraTotal = camaraSedes.reduce((a, sede) => { const v = forecastVigente(d.capacidad, x => x.tipo === 'camara_frio' && x.sede === sede, fechaRef); return v ? a + v.valor : a; }, 0);
  const camaraOk = camaraSedes.length > 0 && capCamaraTotal > 0;
  const usoCamaraPct = camaraOk ? Math.round((litrosAProducir / capCamaraTotal) * 1000) / 10 : null;

  const barrilesManual = (prod.inventario && prod.inventario.barriles) || null;

  const envasadoSedes = [...new Set((d.capacidad || []).filter(c => c.tipo === 'envasado').map(c => c.sede))];
  const turnosPorMes = forecastParamVigente('turnosEnvasadoPorMes', null, d, 20);
  const capEnvasadoTotal = envasadoSedes.reduce((a, sede) => { const v = forecastVigente(d.capacidad, x => x.tipo === 'envasado' && x.sede === sede, fechaRef); return v ? a + v.valor : a; }, 0) * turnosPorMes;
  const envasadoOk = envasadoSedes.length > 0 && capEnvasadoTotal > 0;
  const usoEnvasadoPct = envasadoOk ? Math.round((litrosAProducir / capEnvasadoTotal) * 1000) / 10 : null;

  const restricciones = [
    { id: 'fermentacion', label: 'Fermentación', ok: capFermentacionTotal > 0, capacidadL: capFermentacionTotal || null, usoPct: usoFermentacionPct, excedida: usoFermentacionPct != null && usoFermentacionPct > 100, detalle: fermentacion },
    { id: 'camara_frio', label: 'Cámara de frío', ok: camaraOk, capacidadL: camaraOk ? capCamaraTotal : null, usoPct: usoCamaraPct, excedida: usoCamaraPct != null && usoCamaraPct > 100 },
    { id: 'flota_barriles', label: 'Flota de barriles', ok: false, sinDatos: true, notaManual: barrilesManual },
    { id: 'envasado', label: 'Envasado', ok: envasadoOk, capacidadL: envasadoOk ? capEnvasadoTotal : null, usoPct: usoEnvasadoPct, excedida: usoEnvasadoPct != null && usoEnvasadoPct > 100, turnosPorMes },
  ];
  const excedidas = restricciones.filter(r => r.excedida);
  return { restricciones, factible: excedidas.length === 0, restriccionesExcedidas: excedidas.map(r => r.id) };
}
// Regla 5.6: se planifica con leadTimePlanDias (21 por defecto) pero se MIDE la
// ocupación real de estanque (fermentación→envasado) de los lotes ya cerrados —
// la brecha es un indicador de eficiencia de envasado, no un error a esconder.
function forecastBrechaOcupacion(estilo, data){
  const d = data || forecastDataLoad();
  const prod = prodLoad();
  const cerrados = (prod.lotes || []).filter(l => (!estilo || l.estilo === estilo) && l.fechaEnvasado && l.fechaFermInicio);
  if (!cerrados.length) return { ok: false, reason: 'sin_lotes_completos' };
  const dias = cerrados.map(l => prodDiasOcup(l));
  const promedioReal = dias.reduce((a, b) => a + b, 0) / dias.length;
  const leadTimePlanDias = forecastParamVigente('leadTimePlanDias', estilo, d, 21);
  return { ok: true, n: cerrados.length, promedioReal: Math.round(promedioReal * 10) / 10, leadTimePlanDias, brechaDias: Math.round((promedioReal - leadTimePlanDias) * 10) / 10 };
}
app.get('/admin/forecast/plan-produccion', requireAdmin, async (req, res) => {
  const canal = String(req.query.canal || '');
  if (!FORECAST_PROY_CANALES.includes(canal)) return res.status(400).json({ error: 'Canal inválido.' });
  const estilo = costosStr(req.query.estilo, 60);
  if (!estilo) return res.status(400).json({ error: 'Falta el estilo — el plan de producción es por estilo, no agregado.' });
  const mesObjetivo = /^\d{4}-\d{2}$/.test(String(req.query.mes)) ? String(req.query.mes) : opShiftMonth(forecastMesActualStr(), -1);
  try {
    const d = forecastDataLoad();
    const req1 = await forecastRequerimientoNeto(canal, estilo, mesObjetivo, d);
    if (!req1.ok) return res.json({ ok: false, canal, estilo, mesObjetivo, reason: req1.reason, mesesDisponibles: req1.mesesDisponibles });
    const [regla54, brecha] = await Promise.all([forecastRegla54(canal, estilo, mesObjetivo, d), Promise.resolve(forecastBrechaOcupacion(estilo, d))]);
    const factibilidad = forecastFactibilidad(req1.loteRedondeado, mesObjetivo, d);
    const costoPetPorLitro = forecastParamVigente('costoPetPorLitro', null, d, null);
    res.json({ ok: true, ...req1, regla54, factibilidad, brechaOcupacion: brecha, costoPetPorLitro });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});

// ─── Forecast Operacional · Fase 4: flota de barriles y tableros (alertas, inventario) ───
const FORECAST_CANAL_LBL_SRV = { cd_kairos: 'CD Kairos', ventas_cruzada: 'Ventas Cruzada (500 Sabores)', garden: 'Garden Vespucio', badass: 'Badass', antofagasta: 'Antofagasta' };
// Ciclo real de barriles por punto de venta: empareja cada despacho con el
// retorno más próximo posterior de ESE punto de venta (FIFO) — nunca asumido,
// solo trazabilidad manual real cargada (no existe trazabilidad automática hoy).
function forecastCicloBarriles(data){
  const d = data || forecastDataLoad();
  const eventos = (d.barrilesEventos || []).slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
  const porPV = {};
  eventos.forEach(e => { (porPV[e.puntoVenta] = porPV[e.puntoVenta] || []).push(e); });
  const resultados = [];
  for (const [pv, evs] of Object.entries(porPV)) {
    const cola = []; const ciclos = [];
    for (const e of evs) {
      if (e.tipo === 'despacho') { for (let i = 0; i < e.cantidad; i++) cola.push(e.fecha); }
      else { for (let i = 0; i < e.cantidad && cola.length; i++) { const fD = cola.shift(); const dias = Math.round((new Date(e.fecha) - new Date(fD)) / 86400000); if (dias >= 0) ciclos.push(dias); } }
    }
    if (ciclos.length) resultados.push({ puntoVenta: pv, ciclosMedidos: ciclos.length, promedioDias: Math.round(ciclos.reduce((a, b) => a + b, 0) / ciclos.length * 10) / 10 });
  }
  return resultados.sort((a, b) => b.promedioDias - a.promedioDias);
}
// Dimensionamiento: flota_necesaria = peak_mensual_barril × factor_cobertura
// (recomendado 2,0–2,5x). Peak = pico REAL de litros/mes de los últimos 12
// meses (todos los canales medidos), no un supuesto. Flota actual = único dato
// real disponible hoy (conteo manual agregado sucios+limpios de Producción).
async function forecastFlotaDimensionamiento(data){
  const d = data || forecastDataLoad();
  const hastaMes = forecastMesActualStr();
  const porMes = {}; const mesesConError = [];
  for (const canal of FORECAST_PROY_CANALES) {
    const { serie, mesesConError: mce } = await forecastSerieMensual(canal, null, hastaMes, 12, d);
    mesesConError.push(...mce);
    serie.forEach(p => { if (p.litros != null) porMes[p.mes] = (porMes[p.mes] || 0) + p.litros; });
  }
  const valores = Object.values(porMes);
  if (!valores.length) return { ok: false, reason: 'sin_datos', mesesConError: mesesConError.length };
  const peakLitrosMes = Math.max(...valores);
  const tamanoBarrilL = forecastParamVigente('tamanoBarrilPromedioL', null, d, 25);
  const peakMensualBarril = peakLitrosMes / tamanoBarrilL;
  const factorCobertura = forecastParamVigente('factorCoberturaFlota', null, d, 2);
  const flotaNecesariaUnidades = Math.ceil(peakMensualBarril * factorCobertura);
  const prod = prodLoad();
  const flotaActualUnidades = (prod.inventario && prod.inventario.barriles) ? (Number(prod.inventario.barriles.sucios) || 0) + (Number(prod.inventario.barriles.limpios) || 0) : 0;
  const coberturaActualFactor = peakMensualBarril ? Math.round((flotaActualUnidades / peakMensualBarril) * 100) / 100 : null;
  return {
    ok: true, peakLitrosMes: Math.round(peakLitrosMes), tamanoBarrilL, peakMensualBarril: Math.round(peakMensualBarril * 10) / 10,
    factorCobertura, flotaNecesariaUnidades, flotaActualUnidades, coberturaActualFactor,
    deficitUnidades: Math.max(0, flotaNecesariaUnidades - flotaActualUnidades), mesesConError: mesesConError.length,
  };
}
// Regla 5.5 — PET como variable de holgura CON COSTO (nunca como capacidad):
// solo se puede costear si hay déficit real de flota Y los parámetros de costo
// están cargados; si no, se declara qué falta en vez de omitir en silencio.
function forecastPetComparativa(dimension, data){
  const d = data || forecastDataLoad();
  if (!dimension.ok || dimension.deficitUnidades <= 0) return { aplica: false };
  const costoPetPorLitro = forecastParamVigente('costoPetPorLitro', null, d, null);
  const costoBarrilNuevo = forecastParamVigente('costoBarrilNuevoUnidad', null, d, null);
  const litrosDeficitMes = dimension.deficitUnidades * dimension.tamanoBarrilL;
  return {
    aplica: true, deficitUnidades: dimension.deficitUnidades, litrosDeficitMes: Math.round(litrosDeficitMes),
    costoPetPorLitro, costoBarrilNuevo,
    costoPetMensual: costoPetPorLitro != null ? Math.round(litrosDeficitMes * costoPetPorLitro) : null,
    costoComprarFlotaUnaVez: costoBarrilNuevo != null ? Math.round(dimension.deficitUnidades * costoBarrilNuevo) : null,
  };
}
app.get('/admin/forecast/flota', requireAdmin, async (req, res) => {
  try {
    const d = forecastDataLoad();
    const dimension = await forecastFlotaDimensionamiento(d);
    const ciclos = forecastCicloBarriles(d);
    const pet = forecastPetComparativa(dimension, d);
    res.json({ dimension, ciclos, pet });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
// Vencimiento por estilo anclado a lotes REALES de Producción (fechaEnvasado),
// no al conteo manual de inventario — el lote más antiguo vivo manda.
function forecastVencimientoEstilo(estilo, data){
  const d = data || forecastDataLoad();
  const prod = prodLoad();
  const vidaUtilDias = forecastParamVigente('vidaUtilDias', estilo, d, 180);
  const lotes = (prod.lotes || []).filter(l => l.estilo === estilo && l.fechaEnvasado);
  if (!lotes.length) return null;
  const hoy = Date.now();
  const conEdad = lotes.map(l => ({ codigo: l.codigo || l.id, dias: Math.round((hoy - new Date(l.fechaEnvasado).getTime()) / 86400000) })).filter(l => l.dias >= 0).sort((a, b) => b.dias - a.dias);
  if (!conEdad.length) return null;
  const masAntiguo = conEdad[0];
  return { loteMasAntiguo: masAntiguo.codigo, diasDesdeEnvasado: masAntiguo.dias, diasParaVencer: vidaUtilDias - masAntiguo.dias, vidaUtilDias };
}
app.get('/admin/forecast/inventario-camara', requireAdmin, (req, res) => {
  try {
    const d = forecastDataLoad();
    const porEstilo = {};
    (d.inventarioActual || []).forEach(e => { if (!porEstilo[e.estilo] || e.fecha > porEstilo[e.estilo].fecha) porEstilo[e.estilo] = e; });
    const filas = Object.values(porEstilo).map(e => ({ estilo: e.estilo, litros: e.litros, fechaConteo: e.fecha, vencimiento: forecastVencimientoEstilo(e.estilo, d) }));
    const totalLitros = filas.reduce((a, f) => a + f.litros, 0);
    const camaraSedes = [...new Set((d.capacidad || []).filter(c => c.tipo === 'camara_frio').map(c => c.sede))];
    const capCamaraTotal = camaraSedes.reduce((a, sede) => { const v = forecastVigente(d.capacidad, x => x.tipo === 'camara_frio' && x.sede === sede); return v ? a + v.valor : a; }, 0);
    const ocupacionPct = capCamaraTotal ? Math.round((totalLitros / capCamaraTotal) * 1000) / 10 : null;
    res.json({ filas, totalLitros, capCamaraTotal: capCamaraTotal || null, ocupacionPct, camarasCargadas: camaraSedes.length > 0 });
  } catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});
// Alertas — agrega lo que YA calculan los demás motores (driver externo,
// backtesting) más 2 chequeos directos sobre datos reales de Producción (vida
// útil y sobre-estadía en fermentador). Misma escala semántica del resto del
// admin (ok/warn/err), nunca solo color.
async function forecastAlertas(data){
  const d = data || forecastDataLoad();
  const alertas = [];
  const hastaMes = forecastMesActualStr();
  const driver = await forecastDriverExterno(hastaMes, d);
  if (driver.ok && driver.alertaDesviacion) {
    alertas.push({ tipo: 'driver_externo', severidad: 'warn', mensaje: `La participación de CD Kairos en Grupo Mil Sabores se desvió más de 2 desviaciones estándar del promedio suavizado (último ratio: ${driver.ultimoRatio}).` });
  }
  const prod = prodLoad();
  const hoy = Date.now();
  const vidaUtilDefault = forecastParamVigente('vidaUtilDias', null, d, 180);
  (prod.lotes || []).filter(l => l.fechaEnvasado).forEach(l => {
    const dias = Math.round((hoy - new Date(l.fechaEnvasado).getTime()) / 86400000);
    if (dias < 0) return;
    const vidaUtil = forecastParamVigente('vidaUtilDias', l.estilo, d, vidaUtilDefault);
    if (dias > vidaUtil) alertas.push({ tipo: 'vida_util', severidad: 'err', mensaje: `Lote ${l.codigo || l.id} (${l.estilo || 'sin estilo'}) envasado hace ${dias} días — excede la vida útil de ${vidaUtil} días.` });
    else if (dias > vidaUtil - 30) alertas.push({ tipo: 'vida_util', severidad: 'warn', mensaje: `Lote ${l.codigo || l.id} (${l.estilo || 'sin estilo'}) vence en ${vidaUtil - dias} días.` });
  });
  const leadTimeDefault = forecastParamVigente('leadTimePlanDias', null, d, 21);
  (prod.lotes || []).filter(l => l.fechaFermInicio && !l.fechaEnvasado).forEach(l => {
    const dias = prodDiasOcup(l);
    const leadTime = forecastParamVigente('leadTimePlanDias', l.estilo, d, leadTimeDefault);
    if (dias > leadTime * 1.5) alertas.push({ tipo: 'sobreestadia', severidad: 'warn', mensaje: `Lote ${l.codigo || l.id} (${l.estilo || 'sin estilo'}) lleva ${dias} días en el estanque — el plan es ${leadTime} días.` });
  });
  for (const canal of FORECAST_PROY_CANALES) {
    const bt = await forecastBacktestSerie(canal, null, hastaMes, 3, d);
    if (bt.ok && bt.pares.length >= 2) {
      const ultimos2 = bt.pares.slice(-2);
      const fueraBanda = ultimos2.every(p => p.real > 0 && Math.abs((p.pronostico - p.real) / p.real) > 0.25);
      if (fueraBanda) alertas.push({ tipo: 'error_pronostico', severidad: 'err', mensaje: `El pronóstico de ${FORECAST_CANAL_LBL_SRV[canal] || canal} viene fuera de banda (>25% de error) los últimos 2 meses medidos — revisar supuestos.` });
    }
  }
  return { alertas, generadoEn: new Date().toISOString() };
}
app.get('/admin/forecast/alertas', requireAdmin, async (req, res) => {
  try { res.json(await forecastAlertas(forecastDataLoad())); }
  catch (e) { res.status(500).json({ error: 'Error: ' + String(e.message || e).slice(0, 200) }); }
});

// ─── HOME · Resumen (4 cuadros con datos reales) ────────────────────────────
// TODO: restringir por rol si se requiere — hoy visible para todos los usuarios
// autenticados del panel (se pidió así explícitamente).
// Todo lo de acá abajo es SOLO LECTURA / agregación sobre datos que el ERP ya
// registra (Ingreso por Venta, Costos, Gastos, Gestión de Personas, litros de
// Forecast Operacional). No se crea ni modifica ningún registro.
const DASH_MARCAS = [
  { id: 'kairos', label: 'Kairos Brewing' },
  { id: 'banny', label: 'Banny' },
  { id: 'firulais', label: 'Firulais' },
];
// Litros por día y por marca (HORECA + Hospitality, únicos canales medidos en
// litros hoy). Retail/web queda fuera: no hay mapeo SKU→volumen de envase.
async function opLitrosPorDiaMarca(month, rango, opEstilos){
  const serieDia = {};
  const zero = () => ({ kairos: 0, banny: 0, firulais: 0, sinMapear: 0, total: 0 });
  const add = (fecha, estilo, litros) => {
    const lt = Number(litros) || 0;
    if (!fecha || !lt) return;
    const marcaRaw = (opEstilos[estilo] || {}).marca;
    const key = ['kairos', 'banny', 'firulais'].includes(marcaRaw) ? marcaRaw : 'sinMapear';
    if (!serieDia[fecha]) serieDia[fecha] = zero();
    serieDia[fecha][key] += lt; serieDia[fecha].total += lt;
  };
  try {
    const est = await estadoResolve(month, rango || null);
    (est.ingresos.horeca.pedidos || []).forEach(p => (p.detalle || []).forEach(d => add(p.fecha, d.estilo, d.litros)));
    (est.ingresos.hospitality.garden.pedidos || []).forEach(p => (p.lineas || []).forEach(l => add(p.fecha, l.estilo, l.litros)));
    (est.ingresos.hospitality.badass.pedidos || []).forEach(p => (p.lineas || []).forEach(l => add(p.fecha, l.estilo, l.litros)));
  } catch (e) { /* mes sin datos de Shopify: serie queda vacía */ }
  return serieDia;
}
// Resuelve el selector de período del dashboard a {month, rango, label}. "month"
// ancla la tabla de precios de transferencia (se guarda por mes calendario en
// Ingreso por Venta); para rangos que no calzan con un mes completo se usa el
// mes que contiene el fin del rango — mismo criterio que ya usa Ingreso por
// Venta con su propio selector de rango personalizado.
function dashResolvePeriodo(tipo, fromQ, toQ){
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const monthOf = (s) => s.slice(0, 7);
  const today = new Date();
  if (tipo === 'mes_pasado') {
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const month = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    return { tipo, month, rango: null, label: 'Mes pasado' };
  }
  if (tipo === '30d') {
    const to = new Date(today), from = new Date(today); from.setDate(from.getDate() - 29);
    const toS = ymd(to), fromS = ymd(from);
    return { tipo, month: monthOf(toS), rango: { from: fromS, to: toS }, label: 'Últimos 30 días' };
  }
  if (tipo === 'custom') {
    const d = /^\d{4}-\d{2}-\d{2}$/;
    if (!d.test(fromQ || '') || !d.test(toQ || '') || fromQ > toQ) return null;
    return { tipo, month: monthOf(toQ), rango: { from: fromQ, to: toQ }, label: 'Rango personalizado' };
  }
  const month = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
  return { tipo: 'mes_actual', month, rango: null, label: 'Mes actual' };
}
async function dashboardCompute(periodo, marcaFiltro){
  const { month, rango } = periodo;
  const opEstilos = operacionalLoad().estilos;
  const [pnl, est, litrosPorDiaMarca] = await Promise.all([
    pnlCompute(month, rango),
    estadoResolve(month, rango),
    opLitrosPorDiaMarca(month, rango, opEstilos),
  ]);

  // Cuadro A: ventas en el tiempo (serie diaria ya calculada por estadoResolve/cdShopifyMonth).
  const serieA = Object.entries(est.porDia).sort((a, b) => a[0].localeCompare(b[0])).map(([fecha, total]) => ({ fecha, total: Math.round(total) }));
  const cuadroA = { serie: serieA, total: Math.round(serieA.reduce((a, r) => a + r.total, 0)) };

  // Cuadro B: ratios como % (valores base para el tooltip/subtítulo). Costos Totales
  // = costo directo + costo indirecto. Gasto de RRHH = costo empresa de la nómina
  // (Gestión de Personas), dividido en la venta total del período — tal como se
  // confirmó con el usuario.
  const ventaTotal = pnl.ingresos.total;
  const costosTotalesMonto = pnl.costos.costoDirecto + pnl.costos.costoIndirecto;
  const pct = (v) => ventaTotal ? Math.round((v / ventaTotal) * 1000) / 10 : 0;
  const cuadroB = {
    ventaTotal: Math.round(ventaTotal),
    costosTotales: { monto: Math.round(costosTotalesMonto), pct: pct(costosTotalesMonto) },
    gastosMarketing: { monto: Math.round(pnl.costos.gastosMarketing), pct: pnl.ratios.gastosMarketing },
    gastoRRHH: { monto: Math.round(pnl.costos.gastoPersonal), pct: pnl.ratios.gastoPersonal },
  };

  // Cuadro C: global + por marca (tabla densa).
  const gastoTotalGlobal = pnl.costos.gastosOper + pnl.costos.gastosAdmin + pnl.costos.gastosMarketing + pnl.costos.gastoPersonal;
  const cd = costosLoad();
  const entradasPeriodo = (rango && rango.from && rango.to)
    ? costosEnRango(cd.entradas, rango.from, rango.to)
    : cd.entradas.filter(e => costosMes(e.fecha) === month);
  // Costo/Gasto por marca: usa el campo marca/marcaDetalle que ya trae cada entrada
  // (prorratea "algunas" por su %). Las entradas marcadas "todas" son transversales
  // a las 3 marcas y NO se reparten (no hay una regla definida para hacerlo sin
  // inventar el dato) — solo quedan reflejadas en el Global.
  const cgPorMarca = { kairos: { costo: 0, gasto: 0 }, banny: { costo: 0, gasto: 0 }, firulais: { costo: 0, gasto: 0 } };
  let huboEntradasTodas = false;
  for (const e of entradasPeriodo) {
    const tipo = COSTOS_CAT_TIPO[e.categoria];
    if (tipo !== 'costo' && tipo !== 'gasto') continue;
    const v = costosValorEfectivo(e);
    if (e.marca === 'todas') { huboEntradasTodas = true; continue; }
    if (e.marca === 'algunas' && Array.isArray(e.marcaDetalle)) {
      for (const d of e.marcaDetalle) { if (cgPorMarca[d.marca]) cgPorMarca[d.marca][tipo] += Math.round(v * ((Number(d.pct) || 0) / 100)); }
    } else if (cgPorMarca[e.marca]) {
      cgPorMarca[e.marca][tipo] += v;
    }
  }
  // Venta por marca: retail/web (cobrado) + walmart (original) + hospitality (valorizado
  // a precio de transferencia por línea de pedido — no se usa la tabla agregada por
  // estilo porque esa tabla no incluye los pedidos "seed" pre-Shopify), todas ya
  // atribuidas por marca. HORECA (Kairos Mall + Ventas Cruzadas) NO se incluye: esos
  // pedidos no capturan ingreso por línea de producto, así que no hay forma de saber
  // cuánto corresponde a cada marca.
  const ventaPorMarca = { kairos: 0, banny: 0, firulais: 0 };
  const provMarca = { 'Kairos Brewing': 'kairos', Firulais: 'firulais', Banny: 'banny' };
  for (const [prov, info] of Object.entries(est.ingresos.ventas_web.porProveedor || {})) { const m = provMarca[prov]; if (m) ventaPorMarca[m] += info.total || 0; }
  for (const [prov, info] of Object.entries(est.ingresos.walmart.porProveedor || {})) { const m = provMarca[prov]; if (m) ventaPorMarca[m] += info.total || 0; }
  const addHospPedidos = (pedidos) => (pedidos || []).forEach(p => (p.lineas || []).forEach(l => {
    const m = (opEstilos[l.estilo] || {}).marca; if (ventaPorMarca[m] == null) return;
    const lt = Number(l.litros) || 0;
    ventaPorMarca[m] += lt * (est.precios[l.tipo] || est.precios.cerveza) + est.precios.despacho * lt;
  }));
  addHospPedidos(est.ingresos.hospitality.garden.pedidos); addHospPedidos(est.ingresos.hospitality.badass.pedidos);
  // Litros por marca (HORECA + Hospitality): se suma directamente la serie diaria ya
  // calculada (misma fuente pedido a pedido, incluye seeds pre-Shopify).
  const litrosPorMarca = { kairos: 0, banny: 0, firulais: 0, sinMapear: 0 };
  for (const dia of Object.values(litrosPorDiaMarca)) {
    litrosPorMarca.kairos += dia.kairos; litrosPorMarca.banny += dia.banny; litrosPorMarca.firulais += dia.firulais; litrosPorMarca.sinMapear += dia.sinMapear;
  }
  const porMarca = DASH_MARCAS.map(m => ({
    marca: m.id, label: m.label,
    ventaTotal: Math.round(ventaPorMarca[m.id] || 0),
    litrosTotales: Math.round((litrosPorMarca[m.id] || 0) * 10) / 10,
    costoTotal: Math.round((cgPorMarca[m.id] || {}).costo || 0),
    gastoTotal: Math.round((cgPorMarca[m.id] || {}).gasto || 0),
  }));
  const cuadroC = {
    global: { ventaTotal: Math.round(ventaTotal), costoTotal: Math.round(costosTotalesMonto), gastoTotal: Math.round(gastoTotalGlobal) },
    porMarca,
    notas: [
      'La "Venta total" por marca excluye HORECA (Kairos Mall + Ventas Cruzadas): esos pedidos no registran el ingreso por línea de producto, así que no se pueden atribuir a una marca — sí están incluidos en el Global.',
      huboEntradasTodas ? 'Hay costos/gastos del período marcados como "Todas las marcas": no se reparten entre marcas (no hay una regla definida para hacerlo) — solo suman al Global.' : null,
      litrosPorMarca.sinMapear > 0.5 ? `Hay ${Math.round(litrosPorMarca.sinMapear)} L vendidos en estilos sin marca asignada en Forecast Operacional — no están en ninguna fila de marca.` : null,
    ].filter(Boolean),
  };

  // Cuadro D: litros vendidos por marca en el tiempo (mismo universo de Cuadro C: HORECA + Hospitality).
  const serieD = Object.entries(litrosPorDiaMarca).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fecha, v]) => ({ fecha, litros: Math.round(((marcaFiltro !== 'all' ? (v[marcaFiltro] || 0) : v.total)) * 10) / 10 }));
  const cuadroD = {
    marcas: DASH_MARCAS, marcaFiltro,
    serie: serieD,
    total: Math.round((marcaFiltro !== 'all' ? (litrosPorMarca[marcaFiltro] || 0) : (litrosPorMarca.kairos + litrosPorMarca.banny + litrosPorMarca.firulais + litrosPorMarca.sinMapear)) * 10) / 10,
    nota: 'Incluye HORECA y Hospitality (litros ya medidos hoy). No incluye venta retail/web: no existe un mapeo de SKU a volumen de envase para convertir latas/unidades a litros.',
  };

  const r = rango || cdMonthRange(month);
  return {
    periodo: { tipo: periodo.tipo, from: r.from, to: r.to, label: periodo.label, month },
    shopifyOk: est.shopifyOk,
    cuadroA, cuadroB, cuadroC, cuadroD,
  };
}
app.get('/admin/home/dashboard', requireAdmin, async (req, res) => {
  const tipo = ['mes_actual', 'mes_pasado', '30d', 'custom'].includes(String(req.query.period)) ? String(req.query.period) : 'mes_actual';
  const periodo = dashResolvePeriodo(tipo, String(req.query.from || ''), String(req.query.to || ''));
  if (!periodo) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  const marcaFiltro = ['kairos', 'banny', 'firulais'].includes(String(req.query.marca)) ? String(req.query.marca) : 'all';
  try { res.json(await dashboardCompute(periodo, marcaFiltro)); }
  catch (e) { res.status(500).json({ error: 'Error calculando el resumen: ' + String(e.message || e).slice(0, 300) }); }
});

// ─── GESTIÓN DE PERSONAS (nómina) ───────────────────────────────────────────
// Nómina de trabajadores + costo empresa (editable a mano). El costo empresa
// resta como "gasto de personal" en el Estado de Resultado.
const NOMINA_FILE = join(PROMPTS_EFFECTIVE_DIR, 'nomina.json');
const NOMINA_CONTRATOS = ['Indefinido', 'Plazo fijo'];
const NOMINA_COSTO_DEFAULT = 28500000;
const NOMINA_SEED = [
  { rut: '', nombre: 'Alvarado Fernandez Jesus Jhonatthan Michael', ingreso: '2024-06-11', cargo: 'BODEGUERO(A)', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'fonasa' },
  { rut: '', nombre: 'Conejeros Bravo Sebastian Andres', ingreso: '2025-05-14', cargo: 'MARKETING_MANAGER', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'cuprum', salud: 'colmena' },
  { rut: '', nombre: 'Cupamo Hernandez Richard Alexander', ingreso: '2025-12-01', cargo: 'BODEGUERO(A)', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'fonasa' },
  { rut: '', nombre: 'Gajardo Rivera Tomas Ignacio', ingreso: '2025-07-07', cargo: 'Sommelier Ejecutivo', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'planvital', salud: 'colmena' },
  { rut: '', nombre: 'Luque Quintero Andres Emilio', ingreso: '2025-10-01', cargo: 'BODEGUERO(A)', jornada: '42', contrato: 'Plazo fijo', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'fonasa' },
  { rut: '', nombre: 'Mundaca Zenteno David Antonio', ingreso: '2024-04-01', cargo: 'AYUDANTE DE PRODUCCION', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'planvital', salud: 'banco_estado' },
  { rut: '', nombre: 'Mundaca Zenteno Julio Andres', ingreso: '2024-06-03', cargo: 'ENCARGADO DE PRODUCCION', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'modelo', salud: 'banco_estado' },
  { rut: '', nombre: 'Nudman Risnik Diego', ingreso: '2024-04-02', cargo: 'GERENTE DE OPERACIONES Y FINANZAS', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'colmena' },
  { rut: '', nombre: 'Quezada Oropeza Luis Francisco', ingreso: '2023-01-03', cargo: 'ENCARGADO DE ADMINISTRACION Y LOGÍSTICA', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'planvital', salud: 'fonasa' },
  { rut: '', nombre: 'Reyes Pinto Vicente Andres', ingreso: '2026-01-05', cargo: 'AYUDANTE DE PRODUCCION', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'modelo', salud: 'fonasa' },
  { rut: '', nombre: 'Rojas Ureta Carlos Sebastian', ingreso: '2023-03-01', cargo: 'ENCARGADO DE PRODUCCION', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'provida', salud: 'banmedica' },
  { rut: '', nombre: 'Tello Allende Matias Hernan', ingreso: '2023-05-01', cargo: 'ADMINISTRADOR VENTA Y PRODUCTOS', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'planvital', salud: 'fonasa' },
  { rut: '', nombre: 'Zuñiga Ibarra Valentin Ignacio', ingreso: '2026-04-09', cargo: 'CONTENT CREATOR', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'fonasa' },
  { rut: '', nombre: 'Fernandez Zuñiga Vicente', ingreso: '2026-04-01', cargo: 'ENCARGADO DE VENTAS', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'modelo', salud: 'fonasa' },
  { rut: '', nombre: 'Finkelstein Dorfman Arie Jean', ingreso: '2025-12-04', cargo: 'ACCOUNT MANAGER', jornada: '42', contrato: 'Indefinido', centroCosto: 'BEER GARDEN KAIROS', afp: 'uno', salud: 'Masvida' },
];
function nominaPersonaNorm(p, id){
  return {
    id: id || costosNewId('per'),
    rut: costosStr(p.rut, 20), nombre: costosStr(p.nombre, 120), ingreso: costosStr(p.ingreso, 20),
    cargo: costosStr(p.cargo, 80), jornada: costosStr(p.jornada, 20),
    contrato: NOMINA_CONTRATOS.includes(costosStr(p.contrato, 40)) ? costosStr(p.contrato, 40) : 'Indefinido',
    centroCosto: costosStr(p.centroCosto, 80), afp: costosStr(p.afp, 40), salud: costosStr(p.salud, 40),
  };
}
// Categorías del EERR a las que puede imputar una boleta de honorarios.
const NOMINA_BOLETA_CATS = [
  { id: 'gastos_operativos', label: 'Operativos' },
  { id: 'gastos_admin_venta', label: 'Administración y venta' },
  { id: 'marketing_publicidad', label: 'Marketing y publicidad' },
];
const NOMINA_BOLETA_CAT_IDS = NOMINA_BOLETA_CATS.map(c => c.id);
function nominaBoletaNorm(b, id){
  return {
    id: id || costosNewId('bol'), rut: costosStr(b.rut, 20), nombre: costosStr(b.nombre, 120),
    fecha: costosStr(b.fecha, 20), monto: costosNum(b.monto),
    categoria: NOMINA_BOLETA_CAT_IDS.includes(costosStr(b.categoria, 40)) ? costosStr(b.categoria, 40) : '',
  };
}
function nominaLoad(){
  let data = { costoEmpresa: NOMINA_COSTO_DEFAULT, costoEmpresaPorMes: {}, personas: [], boletas: [] };
  try { if (existsSync(NOMINA_FILE)) { const p = JSON.parse(readFileSync(NOMINA_FILE, 'utf-8'));
    if (Array.isArray(p.personas)) data.personas = p.personas;
    if (Number.isFinite(Number(p.costoEmpresa))) data.costoEmpresa = Math.round(Number(p.costoEmpresa));
    if (p.costoEmpresaPorMes && typeof p.costoEmpresaPorMes === 'object') data.costoEmpresaPorMes = p.costoEmpresaPorMes;
    if (Array.isArray(p.boletas)) data.boletas = p.boletas;
    data._saved = true; } }
  catch (e) { console.warn('nomina load:', e.message); }
  // IDs deterministas para la semilla (estables entre cargas mientras no se guarde,
  // así editar/eliminar una persona semilla funciona antes del primer guardado).
  if (!data._saved && !data.personas.length) data.personas = NOMINA_SEED.map((p, i) => nominaPersonaNorm(p, 'per_seed_' + i));
  delete data._saved;
  return data;
}
function nominaSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(NOMINA_FILE, JSON.stringify(d, null, 2)); }
// Costo empresa del mes: valor específico del mes si existe; si no, el global (legacy).
function nominaCostoEmpresaMes(month){ const d = nominaLoad(); const m = d.costoEmpresaPorMes || {}; return Number.isFinite(Number(m[month])) ? Math.round(Number(m[month])) : (Number(d.costoEmpresa) || 0); }
// Boletas de honorarios de un mes, sumadas por categoría del EERR (suman como costo empresa).
function nominaBoletasDelMes(month){ const d = nominaLoad(); const out = {}; for (const b of (d.boletas || [])) { if (costosMes(b.fecha) !== month) continue; out[b.categoria] = (out[b.categoria] || 0) + (Number(b.monto) || 0); } return out; }
app.get('/admin/nomina', requireAdmin, (req, res) => {
  const d = nominaLoad();
  res.json({ costoEmpresa: d.costoEmpresa, costoEmpresaPorMes: d.costoEmpresaPorMes || {}, personas: d.personas, boletas: d.boletas || [], contratos: NOMINA_CONTRATOS, boletaCats: NOMINA_BOLETA_CATS });
});
app.put('/admin/nomina/costo', requireAdmin, (req, res) => {
  const v = costosNum(req.body && req.body.costoEmpresa);
  if (v < 0) return res.status(400).json({ error: 'Valor inválido.' });
  const month = /^\d{4}-\d{2}$/.test(String(req.body && req.body.month)) ? String(req.body.month) : null;
  const d = nominaLoad();
  if (month) { d.costoEmpresaPorMes = d.costoEmpresaPorMes || {}; d.costoEmpresaPorMes[month] = v; }
  else d.costoEmpresa = v; // legacy: valor global por defecto
  nominaSave(d); res.json({ ok: true, costoEmpresa: v, month });
});
app.post('/admin/nomina/boleta', requireAdmin, (req, res) => {
  const b = nominaBoletaNorm(req.body || {});
  if (!b.nombre) return res.status(400).json({ error: 'Ingresa el nombre completo.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha)) return res.status(400).json({ error: 'Ingresa la fecha de la boleta.' });
  if (!b.monto) return res.status(400).json({ error: 'Ingresa el monto.' });
  if (!b.categoria) return res.status(400).json({ error: 'Elige la categoría del Estado de Resultado.' });
  const d = nominaLoad(); d.boletas = d.boletas || []; d.boletas.push(b); nominaSave(d); res.json({ ok: true, boleta: b });
});
app.delete('/admin/nomina/boleta/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id); const d = nominaLoad(); d.boletas = d.boletas || [];
  const n = d.boletas.length; d.boletas = d.boletas.filter(b => b.id !== id);
  if (d.boletas.length === n) return res.status(404).json({ error: 'No se encontró la boleta.' });
  nominaSave(d); res.json({ ok: true });
});
app.post('/admin/nomina/persona', requireAdmin, (req, res) => {
  const p = nominaPersonaNorm(req.body || {});
  if (!p.nombre) return res.status(400).json({ error: 'Ingresá el nombre completo.' });
  const d = nominaLoad(); d.personas.push(p); nominaSave(d); res.json({ ok: true, persona: p });
});
app.put('/admin/nomina/persona/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id); const d = nominaLoad();
  const idx = d.personas.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: 'No se encontró la persona.' });
  const upd = nominaPersonaNorm(req.body || {}, id);
  if (!upd.nombre) return res.status(400).json({ error: 'Ingresá el nombre completo.' });
  d.personas[idx] = upd; nominaSave(d); res.json({ ok: true, persona: upd });
});
app.delete('/admin/nomina/persona/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id); const d = nominaLoad();
  const n = d.personas.length; d.personas = d.personas.filter(p => p.id !== id);
  if (d.personas.length === n) return res.status(404).json({ error: 'No se encontró la persona.' });
  nominaSave(d); res.json({ ok: true });
});
// Descarga del Excel de la nómina (mismas columnas que el proceso de sueldos).
function nominaSheetRows(d){
  const S = { title: 5, header: 1, sec: 2 };
  const H = (v) => ({ v: v == null ? '' : String(v), s: S.header });
  const T = (v) => ({ v: v == null ? '' : String(v) });
  const N = (v) => ({ v: Number(v) || 0, t: 'n' });
  const rows = [];
  rows.push([H('RUT'), H('NOMBRE'), H('INGRESO'), H('CARGO'), H('JORNADA'), H('CONTRATO'), H('CENTRO DE COSTO'), H('AFP'), H('SALUD'), H('DIAS TRAB.'), H('DIAS LICENCIAS'), H('AUSENTISMO')]);
  for (const p of d.personas) {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(p.ingreso) ? p.ingreso.split('-').reverse().join('-') : (p.ingreso || '');
    rows.push([T(p.rut), T(p.nombre), T(fecha), T(p.cargo), N(p.jornada || 42), T(p.contrato), T(p.centroCosto), T(p.afp), T(p.salud), N(30), N(0), N(0)]);
  }
  return rows;
}
app.get('/admin/nomina/export.xlsx', requireAdmin, (req, res) => {
  try {
    const d = nominaLoad();
    const buf = xlsxPackage([{ name: 'PROCESO DE SUELDOS', rows: nominaSheetRows(d) }]);
    sendXlsx(res, buf, 'Proceso_de_sueldos_KAIROS.xlsx');
  } catch (e) { res.status(500).send('Error: ' + String(e.message || e).slice(0, 200)); }
});

// ─── PRODUCCIÓN & OEE (Fase 1: núcleo de registro) ──────────────────────────
// Tablero de tanques + lotes (cocción por etapas) + envasado + limpiezas +
// paradas. Todo editable. Persistencia JSON. El OEE (Fase 2) se calcula sobre
// estos registros. Diseñado para uso en planta: inicio/fin, pocos toques.
const PROD_FILE = join(PROMPTS_EFFECTIVE_DIR, 'produccion.json');
const PROD_ETAPAS = ['Molienda', 'Maceración', 'Separación/lavado', 'Hervido', 'Whirlpool', 'Enfriamiento'];
const PROD_LIMPIEZA_TIPOS = ['CIP_fermentador', 'brewhouse', 'general', 'tanques'];
const PROD_CENTROS = ['brewhouse', 'fermentacion', 'envasado'];
const PROD_PARADA_CAT = ['falla', 'espera', 'insumo', 'energia', 'otro'];
// Sedes físicas de producción ("Centros de Producción"). Vespucio es la única
// CD propia, con el flujo completo de lotes/OEE ya construido; Lampa y
// Franklin son maquila y por ahora solo se muestran como tablero de tanques
// (Franklin es destilería: RTD y destilados, no fermentación de cerveza).
const PROD_SEDES = [
  { id: 'vespucio', nombre: 'CD Vespucio', modo: 'Propia', tipo: 'cerveceria' },
  { id: 'lampa', nombre: 'CD Lampa', modo: 'Maquila', tipo: 'cerveceria' },
  { id: 'franklin', nombre: 'CD Franklin', modo: 'Maquila', tipo: 'destileria' },
];
const PROD_INV_CATS = ['lata', 'tapa', 'etiqueta'];
// Paleta oficial de color de cerveza (30 tonos, de pálido a casi negro — escala
// tipo SRM). El color de un lote/tanque de cervecería SIEMPRE debe ser uno de
// estos. Aproximación visual del cartel de referencia — ajustable acá si algún
// tono no calza.
const PROD_COLORES_CERVEZA = [
  '#FFE699', '#FFDD85', '#FFD275', '#FDC766', '#FCBB57',
  '#FAAE49', '#F5A03D', '#F09232', '#EB8628', '#E37A1E',
  '#DB6F17', '#D26411', '#C95A0C', '#C05008', '#B64606',
  '#AC3D04', '#A23503', '#982D02', '#8D2602', '#831F01',
  '#791901', '#6F1400', '#651000', '#5C0C00', '#530900',
  '#4A0700', '#420600', '#3A0500', '#330400', '#2C0300',
];
// Un tanque de destilería no fermenta cerveza — solo puede estar "en blanco"
// (destilado/RTD sin madurar) o "en café" (madurando/madurado en barrica).
const PROD_COLORES_DESTILADO = [
  { id: 'blanco', label: 'Blanco', hex: '#F2EFE4' },
  { id: 'cafe', label: 'Café (barrica)', hex: '#6B4226' },
];
function prodColorValido(hex, tipo){
  const h = String(hex || '').toUpperCase();
  if (tipo === 'destileria') return PROD_COLORES_DESTILADO.some(c => c.hex.toUpperCase() === h);
  return PROD_COLORES_CERVEZA.some(c => c.toUpperCase() === h);
}
const PROD_CONFIG_DEF = {
  horasPorSemana: 40, nTrabajadores: 4, velNominalBarrilLh: 1000, velNominalLataLh: 83, cicloCoccionEstandarH: 4.2, leadTimeMinDias: 27, incluirLimpiezaEnDisponibilidad: true,
  // Fase 2 (prompt #2): fecha proyectada de envasado + velocidades por formato + integración ERP.
  leadTimeObjetivoDias: 27, leadTimeObjetivoPorEstilo: {}, coloresPorEstilo: {},
  velNominalBarril20: 1000, velNominalBarril30: 1000, velNominalLata: 83,
  erpBaseUrl: 'https://www.gestioncervecera.com', erpUsuario: '', erpClave: '', erpLastSync: null, erpLastStatus: '', erpAutoSyncMin: 15,
};
// Lead time objetivo de un estilo (o el global). Base para la fecha proyectada de envasado.
function prodLeadObjetivo(cfg, estilo){
  const porEst = (cfg.leadTimeObjetivoPorEstilo || {})[String(estilo || '').toLowerCase().trim()];
  return prodNum(porEst) || prodNum(cfg.leadTimeObjetivoDias) || 27;
}
// Tanques de Vespucio: F1–F14. F2, F6, F7 y F9 son de 4000 L; el resto 1000 L.
const PROD_TANQUES_4000 = ['F2', 'F6', 'F7', 'F9'];
const prodCapTanque = (id) => PROD_TANQUES_4000.includes(id) ? 4000 : 1000;
function prodSeedTanques(){
  const t = [];
  for (let i = 1; i <= 14; i++) { const id = 'F' + i; t.push({ id, capacidadL: prodCapTanque(id), estado: 'vacio', loteActualId: null, sede: 'vespucio' }); }
  [10000, 7000, 7000, 3500].forEach((cap, i) => t.push({ id: 'LAM' + (i + 1), capacidadL: cap, estado: 'vacio', loteActualId: null, sede: 'lampa' }));
  for (let i = 1; i <= 4; i++) t.push({ id: 'FRK' + i, capacidadL: 500, estado: 'vacio', loteActualId: null, sede: 'franklin' });
  return t;
}
// Reconcilia los tanques de Vespucio al set real (F1–F14 + capacidades), sin tocar
// Lampa/Franklin ni perder tanques con lote asignado. Quita los T1–T4 viejos vacíos.
function prodNormalizeTanques(d){
  let changed = false;
  for (let i = 1; i <= 14; i++) {
    const id = 'F' + i; const cap = prodCapTanque(id);
    let t = (d.tanques || []).find(x => x.id === id);
    if (!t) { d.tanques.push({ id, capacidadL: cap, estado: 'vacio', loteActualId: null, sede: 'vespucio' }); changed = true; }
    else { if (t.capacidadL !== cap) { t.capacidadL = cap; changed = true; } if (!t.sede) { t.sede = 'vespucio'; changed = true; } }
  }
  const usados = new Set((d.lotes || []).map(l => l.tanqueId).filter(Boolean));
  const antes = d.tanques.length;
  d.tanques = d.tanques.filter(t => !/^T[1-4]$/.test(t.id) || usados.has(t.id)); // T1–T4 viejos → fuera si no tienen lote
  if (d.tanques.length !== antes) changed = true;
  const sedeRank = { vespucio: 0, lampa: 1, franklin: 2 };
  d.tanques.sort((a, b) => { const sa = sedeRank[a.sede] != null ? sedeRank[a.sede] : 9, sb = sedeRank[b.sede] != null ? sedeRank[b.sede] : 9; if (sa !== sb) return sa - sb; const na = /^F(\d+)$/.exec(a.id), nb = /^F(\d+)$/.exec(b.id); if (na && nb) return +na[1] - +nb[1]; return a.id.localeCompare(b.id); });
  return changed;
}
// Backfill de `sede` en tanques guardados antes de "Centros de Producción" +
// alta de los tanques de Lampa/Franklin si el archivo persistido no los tiene.
// Solo muta en memoria; el caller decide si vale la pena persistir.
function prodMigrarSedesTanques(d){
  let changed = false;
  for (const t of d.tanques) { if (!t.sede) { t.sede = 'vespucio'; changed = true; } }
  for (const seed of prodSeedTanques()) {
    if (seed.sede === 'vespucio') continue; // esos ya existen en cualquier archivo previo
    if (!d.tanques.some(t => t.id === seed.id)) { d.tanques.push(seed); changed = true; }
  }
  return changed;
}
function prodInventarioDefaults(){
  return { barriles: { sucios: 0, limpios: 0, actualizado: null, origen: 'manual' }, insumos: [] };
}
const prodStr = (v, m = 200) => String(v == null ? '' : v).trim().slice(0, m);
const prodNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const prodTs = (v) => { const s = prodStr(v, 40); return s || null; }; // ISO timestamp del cliente
function prodLoad(){
  let d = { config: { ...PROD_CONFIG_DEF }, tanques: prodSeedTanques(), lotes: [], limpiezas: [], paradas: [], recetas: [], inventario: prodInventarioDefaults() };
  try {
    if (existsSync(PROD_FILE)) {
      const p = JSON.parse(readFileSync(PROD_FILE, 'utf-8'));
      d.config = { ...PROD_CONFIG_DEF, ...(p.config || {}) };
      if (Array.isArray(p.tanques) && p.tanques.length) d.tanques = p.tanques;
      if (Array.isArray(p.lotes)) d.lotes = p.lotes;
      if (Array.isArray(p.limpiezas)) d.limpiezas = p.limpiezas;
      if (Array.isArray(p.paradas)) d.paradas = p.paradas;
      if (Array.isArray(p.recetas)) d.recetas = p.recetas;
      if (p.inventario && typeof p.inventario === 'object') d.inventario = { ...prodInventarioDefaults(), ...p.inventario, barriles: { ...prodInventarioDefaults().barriles, ...(p.inventario.barriles || {}) } };
    }
  } catch (e) { console.warn('produccion load:', e.message); }
  prodMigrarSedesTanques(d);
  return d;
}
function prodSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(PROD_FILE, JSON.stringify(d, null, 2)); }
function prodNewId(pfx){ COSTOS_ID_SEQ = (COSTOS_ID_SEQ + 1) % 100000; return pfx + '_' + Date.now().toString(36) + '_' + COSTOS_ID_SEQ.toString(36); }
// Días de ocupación de un tanque por su lote (hoy − fechaFermInicio, o fechaEnvasado − fechaFermInicio).
function prodDiasOcup(lote){
  if (!lote || !lote.fechaFermInicio) return 0;
  const ini = new Date(lote.fechaFermInicio).getTime();
  const fin = lote.fechaEnvasado ? new Date(lote.fechaEnvasado).getTime() : Date.now();
  if (!Number.isFinite(ini)) return 0;
  return Math.max(0, Math.round((fin - ini) / 86400000));
}
// Litros ya envasados de un lote (suma de líneas de envasado, buenos + rechazados).
// Es lo que salió del tanque: buenos + rechazados dejan el fermentador.
function prodLitrosEnvasados(lote){ return (lote.envasados || []).reduce((a, e) => a + (prodNum(e.litrosBuenos) + prodNum(e.litrosRechazados)), 0); }
// Formatos de envasado (C · split): barril 20 L, barril 30 L y lata. Cada uno con
// su velocidad nominal (config). Los barriles llenan rápido; la lata es manual (lento).
const PROD_FORMATOS = ['barril20', 'barril30', 'lata'];
const prodFormatoOk = (f) => PROD_FORMATOS.includes(f) ? f : 'barril20';
function prodVelNominal(cfg, formato){
  if (formato === 'lata') return prodNum(cfg.velNominalLata) || prodNum(cfg.velNominalLataLh) || 83;
  if (formato === 'barril30') return prodNum(cfg.velNominalBarril30) || prodNum(cfg.velNominalBarrilLh) || 1000;
  return prodNum(cfg.velNominalBarril20) || prodNum(cfg.velNominalBarrilLh) || 1000; // barril20 (default)
}
// Volumen base del lote: el real medido si está, sino el esperado (receta / ERP).
function prodVolumenBase(lote){ return prodNum(lote.volumenRealL) || prodNum(lote.volumenEsperadoL) || 0; }
// Rendimiento de envasado de un lote, ponderado por litros de cada formato (0..1) o
// null si no hay datos. Por línea: velReal = litrosBuenos/duraciónH; rend = min(1, velReal/velNominal).
function prodRendEnvasado(lote, cfg){
  let num = 0, den = 0;
  for (const ev of (lote.envasados || [])) {
    const durH = (ev.inicio && ev.fin) ? (new Date(ev.fin) - new Date(ev.inicio)) / 3600000 : 0;
    const buenos = prodNum(ev.litrosBuenos);
    if (durH <= 0 || buenos <= 0) continue;
    const fmt = ev.formato || (ev.canal === 'lata' ? 'lata' : 'barril20'); // compat líneas viejas
    const velNom = prodVelNominal(cfg, fmt);
    if (velNom <= 0) continue;
    const rend = Math.min(1, (buenos / durH) / velNom);
    num += rend * buenos; den += buenos;
  }
  return den > 0 ? num / den : null;
}
// ── Recetas: forma normalizada (id + complemento local) y merge con el ERP ──
function prodEnsureRecetaShape(r){
  if (!r.id) r.id = prodNewId('rec');
  r.origen = r.origen || (r.erpId ? 'erp' : 'local');
  r.tipo = r.tipo === 'destileria' ? 'destileria' : 'cerveceria';
  if (r.color == null) r.color = '';
  if (!r.tiemposEstandar || typeof r.tiemposEstandar !== 'object') r.tiemposEstandar = {};
  if (!r.litrosEsperadosPorFormato || typeof r.litrosEsperadosPorFormato !== 'object') r.litrosEsperadosPorFormato = {};
  return r;
}
// Merge de las recetas del ERP con las que ya hay: refresca datos de origen ERP,
// preserva el complemento local (tiempos/litros por formato) y las recetas manuales.
function prodMergeRecetas(prev, scraped){
  const out = [];
  for (const s of scraped) {
    const ex = prev.find(x => x.erpId && String(x.erpId) === String(s.erpId));
    if (ex) out.push({ ...ex, nombre: s.nombre, estilo: s.estilo, litros: s.litros, og: s.og, abv: s.abv, origen: 'erp' });
    else out.push(prodEnsureRecetaShape({ origen: 'erp', ...s }));
  }
  for (const p of prev) if (!p.erpId) out.push(prodEnsureRecetaShape(p)); // recetas cargadas a mano
  return out;
}
// Asegura id/forma de todas las recetas. Devuelve true si mutó algo (para persistir).
function prodNormalizeRecetas(d){
  let changed = false;
  for (const r of (d.recetas || [])) { const hadId = !!r.id; prodEnsureRecetaShape(r); if (!hadId) changed = true; }
  return changed;
}
function prodDecorate(d){
  const cfg = d.config; const byId = Object.fromEntries(d.lotes.map(l => [l.id, l]));
  const recetaById = Object.fromEntries((d.recetas || []).map(r => [r.id, r]));
  const sedeById = Object.fromEntries(PROD_SEDES.map(s => [s.id, s]));
  const DAY = 86400000;
  const tanques = d.tanques.map(t => {
    const sede = sedeById[t.sede || 'vespucio'] || sedeById.vespucio;
    const lote = t.loteActualId ? byId[t.loteActualId] : null;
    let li = null;
    if (lote) {
      const cap = t.capacidadL;
      const litrosBase = prodNum(lote.volumenRealL) || prodNum(lote.volumenEsperadoL) || 0;
      const litrosActuales = Math.max(0, litrosBase - prodLitrosEnvasados(lote));
      const lead = prodLeadObjetivo(cfg, lote.estilo);
      const proy = lote.fechaCoccion ? new Date(new Date(lote.fechaCoccion).getTime() + lead * DAY) : null;
      const diasRestantes = proy ? Math.ceil((proy.getTime() - Date.now()) / DAY) : null;
      const sobreEstadia = (proy && !lote.fechaEnvasado && Date.now() > proy.getTime()) ? Math.floor((Date.now() - proy.getTime()) / DAY) : 0;
      // El color ya no se elige por lote/tanque: viene siempre de la receta
      // vinculada (recetaId) — cerveza o destilado. Sin receta, cae al mapa
      // de color por estilo (compat) y si no hay nada queda sin color.
      const receta = lote.recetaId ? recetaById[lote.recetaId] : null;
      li = {
        id: lote.id, codigo: lote.codigo, producto: lote.producto, estilo: lote.estilo, estado: lote.estado, recetaId: lote.recetaId || '',
        diasOcup: prodDiasOcup(lote), volumenEsperadoL: lote.volumenEsperadoL, litrosActuales, litrosRestantes: litrosActuales, nivelPct: cap ? Math.round(litrosActuales / cap * 100) : 0,
        color: (receta && receta.color) || (cfg.coloresPorEstilo || {})[String(lote.estilo || '').toLowerCase().trim()] || '',
        fechaCoccion: lote.fechaCoccion, fechaProyEnvasado: proy ? proy.toISOString() : null, diasRestantes, sobreEstadia, leadObjetivo: lead,
      };
    }
    return { ...t, sede: sede.id, tipo: sede.tipo, estado: t.loteActualId ? 'ocupado' : (t.sucio ? 'sucio' : 'vacio'), lote: li };
  });
  const lotes = d.lotes.map(l => { const base = prodVolumenBase(l); const env = prodLitrosEnvasados(l); return { ...l, diasOcup: prodDiasOcup(l), volumenBaseL: base, litrosEnvasados: env, litrosRestantes: Math.max(0, base - env), rendEnvasado: prodRendEnvasado(l, cfg), leadTimeDias: (l.fechaEnvasado && l.fechaCoccion) ? Math.max(0, Math.round((new Date(l.fechaEnvasado) - new Date(l.fechaCoccion)) / DAY)) : null }; });
  return { config: prodConfigSafe(cfg), tanques, lotes, limpiezas: d.limpiezas, paradas: d.paradas, recetas: d.recetas || [], inventario: prodDecorarInventario(d.inventario), meta: { etapas: PROD_ETAPAS, limpiezaTipos: PROD_LIMPIEZA_TIPOS, centros: PROD_CENTROS, paradaCategorias: PROD_PARADA_CAT, formatos: PROD_FORMATOS, sedes: PROD_SEDES, invCategorias: PROD_INV_CATS, coloresCerveza: PROD_COLORES_CERVEZA, coloresDestilado: PROD_COLORES_DESTILADO } };
}
// Suma valorTotal (cantidad × costo unitario) por ítem y totales por categoría.
function prodDecorarInventario(inv){
  const base = inv || prodInventarioDefaults();
  const insumos = (base.insumos || []).map(x => ({ ...x, valorTotal: Math.round(prodNum(x.cantidad) * prodNum(x.costoUnitario) * 100) / 100 }));
  const totalesPorCategoria = {};
  for (const cat of PROD_INV_CATS) totalesPorCategoria[cat] = Math.round(insumos.filter(x => x.categoria === cat).reduce((a, x) => a + x.valorTotal, 0) * 100) / 100;
  const valorTotalInsumos = Math.round(insumos.reduce((a, x) => a + x.valorTotal, 0) * 100) / 100;
  return { barriles: base.barriles || prodInventarioDefaults().barriles, insumos, totalesPorCategoria, valorTotalInsumos };
}
// Config para el front: la clave del ERP nunca se envía, solo si está configurada.
function prodConfigSafe(cfg){ const c = { ...cfg }; c.erpUsuarioSet = !!(cfg.erpUsuario || process.env.GC_USUARIO); c.erpClaveSet = !!(cfg.erpClave || process.env.GC_CLAVE); c.erpApiKeySet = !!(cfg.erpApiKey || process.env.GESTION_CERVECERA_API_KEY); c.erpUsuario = cfg.erpUsuario || ''; delete c.erpClave; delete c.erpApiKey; return c; }
app.get('/admin/produccion', requireAdmin, (req, res) => {
  const d = prodLoad();
  let changed = prodNormalizeRecetas(d);
  if (prodMigrarSedesTanques(d)) changed = true;
  if (prodNormalizeTanques(d)) { prodSyncTanques(d); changed = true; }
  if (changed) prodSave(d);
  res.json(prodDecorate(d));
});
app.put('/admin/produccion/config', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad(); const c = { ...d.config };
  const numOr = (v, def) => prodNum(v) || def;
  c.horasPorSemana = numOr(b.horasPorSemana, PROD_CONFIG_DEF.horasPorSemana);
  c.nTrabajadores = numOr(b.nTrabajadores, c.nTrabajadores || PROD_CONFIG_DEF.nTrabajadores);
  c.velNominalBarrilLh = numOr(b.velNominalBarrilLh, PROD_CONFIG_DEF.velNominalBarrilLh);
  c.velNominalLataLh = numOr(b.velNominalLataLh, PROD_CONFIG_DEF.velNominalLataLh);
  c.velNominalBarril20 = numOr(b.velNominalBarril20, c.velNominalBarril20 || PROD_CONFIG_DEF.velNominalBarril20);
  c.velNominalBarril30 = numOr(b.velNominalBarril30, c.velNominalBarril30 || PROD_CONFIG_DEF.velNominalBarril30);
  c.velNominalLata = numOr(b.velNominalLata, c.velNominalLata || PROD_CONFIG_DEF.velNominalLata);
  c.cicloCoccionEstandarH = numOr(b.cicloCoccionEstandarH, PROD_CONFIG_DEF.cicloCoccionEstandarH);
  c.leadTimeMinDias = numOr(b.leadTimeMinDias, PROD_CONFIG_DEF.leadTimeMinDias);
  c.leadTimeObjetivoDias = numOr(b.leadTimeObjetivoDias, PROD_CONFIG_DEF.leadTimeObjetivoDias);
  if (b.incluirLimpiezaEnDisponibilidad !== undefined) c.incluirLimpiezaEnDisponibilidad = b.incluirLimpiezaEnDisponibilidad !== false;
  if (b.leadTimeObjetivoPorEstilo && typeof b.leadTimeObjetivoPorEstilo === 'object') c.leadTimeObjetivoPorEstilo = b.leadTimeObjetivoPorEstilo;
  if (b.coloresPorEstilo && typeof b.coloresPorEstilo === 'object') {
    // Solo se guardan los valores que están en la paleta oficial de cerveza.
    c.coloresPorEstilo = Object.fromEntries(Object.entries(b.coloresPorEstilo).filter(([, hex]) => prodColorValido(hex, 'cerveceria')));
  }
  if (b.erpBaseUrl != null) c.erpBaseUrl = prodStr(b.erpBaseUrl, 300);
  if (b.erpUsuario != null) c.erpUsuario = prodStr(b.erpUsuario, 120);
  // La clave solo se actualiza si viene un valor no vacío; si mandan '' se deja como está.
  if (typeof b.erpClave === 'string' && b.erpClave.trim()) c.erpClave = b.erpClave.trim().slice(0, 200);
  if (b.erpClave === null) c.erpClave = ''; // null explícito = borrar
  if (typeof b.erpApiKey === 'string' && b.erpApiKey.trim()) c.erpApiKey = b.erpApiKey.trim().slice(0, 300);
  if (b.erpApiKey === null) c.erpApiKey = '';
  if (b.erpAutoSyncMin !== undefined) c.erpAutoSyncMin = Math.max(0, Math.min(1440, prodNum(b.erpAutoSyncMin)));
  d.config = c; prodSave(d); res.json({ ok: true, config: prodConfigSafe(c) });
});
// Marcar limpieza de un tanque desde su tarjeta: registra un CIP y lo deja "vacío".
app.post('/admin/produccion/tanque/:id/limpiar', requireAdmin, (req, res) => {
  const d = prodLoad(); const t = d.tanques.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Tanque no encontrado.' });
  const now = new Date().toISOString();
  d.limpiezas.push({ id: prodNewId('cip'), tipo: 'CIP_fermentador', centroTrabajo: 'fermentacion', ref: t.id, inicio: now, fin: now, editadoManual: false });
  t.sucio = false; prodSyncTanques(d); prodSave(d); res.json({ ok: true });
});
// ── Integración ERP "Gestión Cervecera" (login + scraping de páginas) ──
// El ERP NO tiene API: son páginas web tras login. Zorbo se loguea con usuario/clave
// del ERP (guardados en el servidor, la clave nunca se envía al front), baja /Receta
// y /Lote, y parsea las tablas HTML. La sync NUNCA pisa datos manuales (merge por
// número/erpId). Se prueba en Railway; desde el sandbox el firewall bloquea el ERP.
const ERP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
function erpCreds(cfg){ return { usuario: cfg.erpUsuario || process.env.GC_USUARIO || '', clave: cfg.erpClave || process.env.GC_CLAVE || '', apiKey: cfg.erpApiKey || process.env.GESTION_CERVECERA_API_KEY || '', base: String(cfg.erpBaseUrl || 'https://www.gestioncervecera.com').replace(/\/$/, '') }; }
// Diagnóstico de la API del ERP: prueba combinaciones de URL base / auth / endpoint
// con la API key + usuario y reporta qué responde. Corre en Railway (que sí alcanza
// el ERP). Read-only (GET). Sirve para descubrir el contrato real de la API.
async function erpApiProbe(cfg){
  const { usuario, apiKey, base } = erpCreds(cfg);
  if (!apiKey) return { ok: false, error: 'No hay API key (GESTION_CERVECERA_API_KEY).', resultados: [] };
  const host = base.replace(/^https?:\/\/(www\.)?/, '');
  const bases = [...new Set([base, base + '/api', 'https://api.' + host, 'https://app.' + host + '/api'])];
  const paths = ['/recetas', '/lotes'];
  const auths = [
    { label: 'Bearer', headers: { Authorization: 'Bearer ' + apiKey } },
    { label: 'X-API-Key', headers: { 'X-API-Key': apiKey } },
    { label: 'apikey-header', headers: { apikey: apiKey } },
    { label: 'query', query: true },
  ];
  const jobs = [];
  for (const b of bases) for (const p of paths) for (const a of auths) jobs.push({ b, p, a });
  const run = async ({ b, p, a }) => {
    let url = b + p; const headers = { 'User-Agent': ERP_UA, Accept: 'application/json', ...(a.headers || {}) };
    if (a.query) { const qs = new URLSearchParams({ apiKey, api_key: apiKey, token: apiKey, usuario: usuario || '', user: usuario || '' }); url += (url.includes('?') ? '&' : '?') + qs.toString(); }
    const label = a.label + ' ' + b + p;
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal });
      clearTimeout(to);
      const ct = r.headers.get('content-type') || '';
      let body = ''; try { body = (await r.text()).slice(0, 400); } catch {}
      const esJson = /json/i.test(ct) || /^[\s]*[[{]/.test(body);
      const esLogin = /type=["']?password|iniciar sesión|login/i.test(body);
      return { label, url: url.replace(apiKey, '‹key›'), status: r.status, contentType: ct.slice(0, 60), esJson, esLogin, snippet: body.replace(apiKey, '‹key›').replace(/\s+/g, ' ').slice(0, 220) };
    } catch (e) { return { label, url: url.replace(apiKey, '‹key›'), status: 0, error: String(e.name === 'AbortError' ? 'timeout' : e.message).slice(0, 80) }; }
  };
  // Concurrencia acotada (6 a la vez).
  const results = []; const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => { let j; while ((j = queue.shift())) results.push(await run(j)); }));
  // Ordenar: 2xx+JSON primero, después 2xx, después el resto.
  const score = (x) => (x.status >= 200 && x.status < 300 && x.esJson ? 0 : x.status >= 200 && x.status < 300 ? 1 : x.status >= 300 && x.status < 400 ? 2 : x.status >= 400 && x.status < 500 ? 3 : 4);
  results.sort((a, b) => score(a) - score(b));
  const ganadores = results.filter(x => x.status >= 200 && x.status < 300 && x.esJson && !x.esLogin);
  return { ok: true, apiKeySet: true, usuarioSet: !!usuario, base, ganadores, resultados: results };
}
app.post('/admin/produccion/erp/diag', requireAdmin, async (req, res) => {
  try { const cfg = prodLoad().config; res.json(await erpApiProbe(cfg)); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// Diagnóstico del LOGIN (scraping): entra al ERP y dumpea la estructura real del
// formulario de login (campos, action, Google/captcha, y en qué paso falla el login).
// Corre en Railway (que alcanza el ERP). Sirve para arreglar el scraper con precisión.
async function erpLoginDiag(cfg){
  const { usuario, clave, base } = erpCreds(cfg);
  const rep = { base, usuarioSet: !!usuario, claveSet: !!clave, forms: [], rutas: [] };
  const jar = {};
  // 1. Página de login (/login) — estructura + ¿es SPA (JS)?
  let html = '';
  try {
    const r = await erpGet(base + '/login', jar, base);
    html = await r.text();
    const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 8);
    const esSPA = (/<div\s+id=["'](app|root|__nuxt|__next)["']/i.test(html) || (!/<form/i.test(html) && scripts.length > 0));
    rep.login = {
      status: r.status, urlFinal: r.url || (base + '/login'),
      titulo: (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [, ''])[1].trim().slice(0, 80),
      tieneForm: /<form/i.test(html), tienePassword: /type=["']?password/i.test(html),
      esSPA, scripts, setCookie: (r.headers.getSetCookie && r.headers.getSetCookie().map(c => c.split(';')[0].split('=')[0])) || [],
      len: html.length,
    };
  } catch (e) { rep.login = { error: String(e.message).slice(0, 140) }; }
  // Forms encontrados en el HTML (si los hay).
  rep.forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(f0 => { const f = f0[0]; return {
    action: (/\baction=["']([^"']*)["']/i.exec(f) || [, ''])[1], method: ((/\bmethod=["']([^"']*)["']/i.exec(f) || [, 'get'])[1]).toUpperCase(),
    tienePassword: /type=["']?password/i.test(f),
    inputs: [...f.matchAll(/<input\b[^>]*>/gi)].map(im => ({ name: (/\bname=["']([^"']+)["']/i.exec(im[0]) || [, ''])[1], type: ((/\btype=["']([^"']+)["']/i.exec(im[0]) || [, 'text'])[1]).toLowerCase() })).filter(x => x.name),
  }; });
  // 2. Rutas candidatas (solo GET, read-only — no intentamos login para no bloquear la cuenta).
  const rutas = ['/login', '/Lote', '/Receta', '/api/lotes', '/api/recetas', '/api/lote', '/api/receta', '/api/login', '/api/auth/login'];
  await Promise.all(rutas.map(async (p) => {
    try {
      const j2 = {}; const r = await erpFetch(base + p, { method: 'GET', headers: { Accept: 'application/json' } }, j2);
      const ct = r.headers.get('content-type') || ''; let body = ''; try { body = (await r.text()).slice(0, 200); } catch {}
      rep.rutas.push({ ruta: p, status: r.status, tipo: /json/i.test(ct) ? 'JSON' : (/html/i.test(ct) ? 'HTML' : ct.slice(0, 30)), snippet: body.replace(/\s+/g, ' ').slice(0, 120) });
    } catch (e) { rep.rutas.push({ ruta: p, status: 0, error: String(e.message).slice(0, 60) }); }
  }));
  rep.rutas.sort((a, b) => a.ruta.localeCompare(b.ruta));
  // 3. Login real (POST /Home/Login con md5) y prueba de páginas de datos autenticadas.
  try {
    const login = await erpLogin(cfg);
    rep.login.loginReal = { ok: login.ok, error: login.error || null, stage: login.stage || null };
    if (login.ok && login.jar) {
      rep.rutasAuth = [];
      const dp = ['/Lote', '/Receta', '/Lotes', '/Recetas', '/Home/Lote', '/Home/Receta'];
      rep.muestras = {};
      await Promise.all(dp.map(async (p) => {
        try {
          const r = await erpGet(base + p, login.jar, base); const h = await r.text();
          rep.rutasAuth.push({ ruta: p, status: r.status, filas: (h.match(/<tr\b/gi) || []).length, tieneEditLote: /Lote\/Edit\?id=/i.test(h), tieneExportar: /class=["']exportar["']/i.test(h), len: h.length });
          // Muestra de la estructura de la tabla + los scripts que la cargan (ajax).
          if (r.status === 200 && /<tr\b/i.test(h) && (p === '/Lote' || p === '/Receta')) { rep.muestras[p] = erpTablaMuestra(h); (rep.scripts = rep.scripts || {})[p] = erpScriptDump(h); }
        } catch (e) { rep.rutasAuth.push({ ruta: p, status: 0, error: String(e.message).slice(0, 60) }); }
      }));
      rep.rutasAuth.sort((a, b) => a.ruta.localeCompare(b.ruta));
      // Probar los endpoints de datos reales (POST /{Controlador}/GetActivos|GetAll,
      // body vacío, con la cookie de sesión). Dumpea el JSON para mapear los campos.
      rep.dataProbe = [];
      const dataEps = ['/Lote/GetActivos', '/Lote/GetAll', '/Receta/GetActivos', '/Receta/GetAll', '/Receta/GetActivas', '/Batch/GetActivos', '/Recipe/GetAll'];
      await Promise.all(dataEps.map(async (ep) => {
        try {
          const r = await erpFetch(base + ep, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': base + '/Lote', 'Origin': base }, body: '' }, login.jar);
          const ct = r.headers.get('content-type') || ''; let t = ''; try { t = await r.text(); } catch {}
          const isJson = /json/i.test(ct) || /^\s*[[{]/.test(t);
          rep.dataProbe.push({ ep, status: r.status, isJson, len: t.length, snippet: t.replace(/\s+/g, ' ').slice(0, 900) });
        } catch (e) { rep.dataProbe.push({ ep, status: 0, error: String(e.message).slice(0, 60) }); }
      }));
      rep.dataProbe.sort((a, b) => ((b.isJson && b.len > 50) ? 1 : 0) - ((a.isJson && a.len > 50) ? 1 : 0));
      // Detalle real de la receta: GetTareas (id) + MPsTipo (idReceta+tipo) — endpoints
      // confirmados por captura de red. Dumpea el JSON para mapear los campos.
      try {
        const rec = await erpApiGetAll(base, '/Receta/GetAll', login.jar, '/Receta');
        const first = (rec.data || [])[0]; const rid = first && (first.id != null ? first.id : first.idProducto);
        rep.recetaDetalle = { idProbado: rid, resultados: [] };
        if (rid != null) {
          const push = async (ep, body) => {
            try {
              const r = await erpFetch(base + ep, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': base + '/Receta/Ver?id=' + rid, 'Origin': base }, body }, login.jar);
              let t = ''; try { t = await r.text(); } catch {}
              rep.recetaDetalle.resultados.push({ ep, body, status: r.status, len: t.length, snippet: t.replace(/\s+/g, ' ').slice(0, 1600) });
            } catch (e) { rep.recetaDetalle.resultados.push({ ep, body, error: String(e.message).slice(0, 50) }); }
          };
          try { await erpGet(base + '/Receta/Ver?id=' + rid, login.jar, base); } catch (e) { } // fija la receta en la sesión
          await push('/Receta/GetTareas', 'id=' + rid);
          for (const tipo of [1, 2, 3, 4, 5, 6]) await push('/Receta/MPsTipo', 'idReceta=' + rid + '&tipo=' + tipo);
        }
      } catch (e) { rep.recetaDetalle = { error: String(e.message).slice(0, 100) }; }
    }
  } catch (e) { rep.login.loginReal = { ok: false, error: String(e.message).slice(0, 120) }; }
  return rep;
}
app.post('/admin/produccion/erp/diaglogin', requireAdmin, async (req, res) => {
  try { const cfg = prodLoad().config; res.json(await erpLoginDiag(cfg)); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// Cookie jar mínimo (Node fetch no maneja cookies solo).
function erpSetCookies(jar, res){ const sc = (res.headers.getSetCookie && res.headers.getSetCookie()) || []; for (const line of sc) { const m = /^([^=]+)=([^;]*)/.exec(line); if (m) jar[m[1].trim()] = m[2]; } }
function erpCookieHeader(jar){ return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '); }
async function erpFetch(url, opts, jar){
  const headers = { 'User-Agent': ERP_UA, 'Accept': 'text/html,application/xhtml+xml', ...(opts.headers || {}) };
  const ck = erpCookieHeader(jar); if (ck) headers['Cookie'] = ck;
  const r = await fetch(url, { ...opts, headers, redirect: 'manual' });
  erpSetCookies(jar, r);
  return r;
}
// Sigue redirects manualmente conservando cookies (máx 5 saltos).
async function erpGet(url, jar, base){
  for (let i = 0; i < 6; i++) {
    const r = await erpFetch(url, { method: 'GET' }, jar);
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (!loc) return r; url = loc.startsWith('http') ? loc : base + (loc.startsWith('/') ? loc : '/' + loc); continue; }
    return r;
  }
  throw new Error('demasiados redirects');
}
const erpMd5 = (s) => createHash('md5').update(String(s == null ? '' : s), 'utf8').digest('hex');
// Muestra compacta de la estructura de una tabla HTML: thead + primeras 2 filas con
// datos (conserva atributos de <tr>/<td>, que es lo que el parser necesita).
function erpTablaMuestra(html){
  // Escanear TODO el HTML por filas con <td> (datos reales), no solo la 1a tabla.
  const rows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  const dataRows = rows.filter(r => /<td\b/i.test(r));
  const theadRow = rows.find(r => /<th\b/i.test(r)) || '';
  if (dataRows.length) return ('[' + dataRows.length + ' filas de datos]\n' + theadRow + '\n' + dataRows.slice(0, 2).join('\n')).replace(/\s{2,}/g, ' ').trim().slice(0, 4200);
  return '[0 filas de datos en el HTML → la tabla se llena por AJAX. Hacé la captura de red (DevTools) del pedido de datos.] thead: ' + theadRow.replace(/\s{2,}/g, ' ').trim().slice(0, 1200);
}
// Vuelca los <script> inline relevantes (DataTables / ajax / url) de una página,
// para descubrir la URL AJAX que carga las filas de la tabla.
function erpScriptDump(html){
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const rel = scripts.filter(s => /DataTable|ajax|\.load\(|Listar|Listado|Datos|GetData|Grid|\/Lote|\/Receta|url\s*:/i.test(s));
  return rel.join('\n/* --- */\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 4500);
}
// Login real del ERP (Gestión Cervecera es ASP.NET + jQuery): jsLogin() hace
// POST /Home/Login con { usuario, password: md5(clave) } y espera JSON {message:'ok'}.
// La clave viaja HASHEADA en MD5 (así lo hace la propia página). Setea cookie de sesión.
async function erpLogin(cfg){
  const { usuario, clave, base } = erpCreds(cfg);
  if (!usuario || !clave) return { ok: false, jar: null, error: 'Faltan usuario o clave del ERP.', stage: 'config' };
  const jar = {};
  try { await erpGet(base + '/login', jar, base); } catch (e) { /* cookies iniciales, no crítico */ }
  const body = new URLSearchParams({ usuario, password: erpMd5(clave) }).toString();
  let pr, txt = '';
  try {
    pr = await erpFetch(base + '/Home/Login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Referer': base + '/login', 'Origin': base }, body }, jar);
    txt = await pr.text();
  } catch (e) { return { ok: false, jar, error: 'No pude conectar al ERP: ' + String(e.message).slice(0, 100), stage: 'post' }; }
  let result = {}; try { result = JSON.parse(txt); } catch { }
  const msg = String((result && result.message) || '').toLowerCase();
  if (msg && msg !== 'ok') return { ok: false, jar, error: 'Login rechazado por el ERP: ' + String(result.message).slice(0, 120), stage: 'login-msg' };
  if (!msg && pr.status >= 400) return { ok: false, jar, error: 'El ERP respondió ' + pr.status + ' al login.', stage: 'login-http', debug: txt.slice(0, 140) };
  // Confirmar sesión pidiendo una página protegida: no debe volver al login.
  const chk = await erpGet(base + '/Lote', jar, base);
  const chkHtml = await chk.text();
  if (/id=["']frmLogin["']|\/Home\/Login|placeholder=["']?Contrase/i.test(chkHtml)) return { ok: false, jar, error: 'Login no tomó (sigue pidiendo credenciales). Revisá usuario/clave.', stage: 'login-check', debug: (pr.status + ' ' + txt.slice(0, 100)) };
  return { ok: true, jar, error: null, loteHtml: chkHtml };
}
const erpTxt = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ').replace(/\s+/g, ' ').trim();
// El ERP usa "." como separador DECIMAL (ej. ABV 4.5, litros 795.664) y "," como
// miles → sacamos las comas y parseamos con el punto decimal.
const erpNumCl = (s) => { const t = erpTxt(s).replace(/,/g, '').replace(/[^\d.-]/g, ''); const n = parseFloat(t); return Number.isFinite(n) ? n : 0; };
// Parsea la fecha "22/5/2026 16:18" → ISO.
function erpFecha(s){ const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(erpTxt(s)); if (!m) return null; const [, d, mo, y, h, mi] = m; return new Date(Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0))).toISOString(); }
// Parsea la tabla de Recetas (checkbox+data-id, Nombre, Estilo, Litros, OG, ABV).
function erpParseRecetas(html){
  const out = [];
  for (const rm of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rm[1]; if (/dataTables_empty/.test(row)) continue;
    const id = (/class=["']exportar["'][^>]*data-id=["'](\d+)["']|data-id=["'](\d+)["'][^>]*class=["']exportar/i.exec(row) || [])[1];
    const tds = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (!id || tds.length < 6) continue;
    out.push({ erpId: id, nombre: erpTxt(tds[1]), estilo: erpTxt(tds[2]), litros: erpNumCl(tds[3]), og: erpNumCl(tds[4]), abv: erpNumCl(tds[5]) });
  }
  return out;
}
// Parsea la tabla de Lotes (Fecha cocción, Número, Descripción, Litros disp, Barril,
// Envases, Estado, Etapa <select>, Tanque <select>, + idreceta/cantcocciones).
function erpParseLotes(html){
  const out = [];
  for (const rm of html.matchAll(/<tr\b[^>]*role=["']row["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rm[1]; if (/dataTables_empty|sorting_asc|<th/i.test(row)) continue;
    const edit = /Lote\/Edit\?id=(\d+)/i.exec(row); if (!edit) continue;
    const erpId = edit[1];
    const tds = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    const numero = erpTxt((tds[1] || '').replace(/<[^>]+>/g, m => '')) || erpTxt(tds[1]);
    const descripcion = erpTxt(tds[2] || '');
    const litrosDisp = (/data-litrosdisponibles=["']([\d.,]+)["']/i.exec(row) || [])[1];
    const estado = erpTxt((/class=["']estado[^"']*["'][^>]*>([^<]*)</i.exec(row) || [])[1] || tds[5] || '');
    const etapa = erpTxt((/<option[^>]*selected[^>]*>([^<]*)<\/option>/i.exec((/class=["']etapa["'][\s\S]*?<\/select>/i.exec(row) || [''])[0]) || [])[1] || '');
    const tanqSel = (/class=["']tanque["'][\s\S]*?<\/select>/i.exec(row) || [''])[0];
    const tanque = erpTxt((/<option[^>]*selected[^>]*data-capacidad=["'](\d+)["']>([^<]*)<\/option>/i.exec(tanqSel) || [, , ''])[2] || (/<option[^>]*selected[^>]*>([^<]*)<\/option>/i.exec(tanqSel) || [, ''])[1] || '');
    const capacidad = prodNum((/<option[^>]*selected[^>]*data-capacidad=["'](\d+)["']/i.exec(tanqSel) || [])[1]);
    const idReceta = (/data-idreceta=["'](\d+)["']/i.exec(row) || [])[1] || '';
    const cantCocciones = prodNum((/data-cantcocciones=["'](\d+)["']/i.exec(row) || [])[1]) || 1;
    out.push({ erpId, numero, descripcion, fechaCoccion: erpFecha(tds[0]), litrosDisponibles: erpNumCl(litrosDisp || tds[3]), estado, etapa, tanque, capacidad, idReceta, cantCocciones });
  }
  return out;
}
// Mapea etapa/estado del ERP → estado interno de Zorbo.
function erpEstadoZorbo(etapa, estado){
  const e = (etapa || '').toLowerCase(), s = (estado || '').toLowerCase();
  if (/finaliz|envas/.test(e) || /finaliz|envas/.test(s)) return 'envasado';
  if (/filtr|madur/.test(e)) return 'maduracion';
  if (/ferment/.test(e)) return 'fermentacion';
  return 'coccion';
}
// ── API de datos del ERP (JSON) ── Gestión Cervecera sirve las grillas por
// POST /{Controlador}/GetAll (body vacío, cookie de sesión) → { data:[...] }.
async function erpApiGetAll(base, path, jar, referer){
  const r = await erpFetch(base + path, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': base + (referer || '/Lote'), 'Origin': base }, body: '' }, jar);
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { }
  const data = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
  return { status: r.status, data };
}
// POST autenticado a un endpoint del ERP con body form-encoded → JSON parseado.
async function erpApiPost(base, path, body, jar, referer){
  const r = await erpFetch(base + path, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': base + (referer || '/Receta'), 'Origin': base }, body: body || '' }, jar);
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { }
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.tareas) ? j.tareas : []));
  return { status: r.status, json: j, arr };
}
// Catálogo de materias primas (id → nombre/tipo/marca/unidad), cacheado 5 min.
let erpMPCat = { at: 0, map: {} };
async function erpMPCatalogo(base, jar){
  if (Date.now() - erpMPCat.at < 300000 && Object.keys(erpMPCat.map).length) return erpMPCat.map;
  const r = await erpApiGetAll(base, '/MateriaPrima/GetAll', jar, '/Receta');
  const map = {};
  for (const m of (r.data || [])) map[String(m.id)] = { nombre: m.nombre, tipo: m.tipo, marca: m.marca, unidad: m.unidad };
  erpMPCat = { at: Date.now(), map };
  return map;
}
// La opción <option ... selected ...>Texto</option> de un <select> (etapa/tanque).
function erpOptSel(html){
  for (const m of String(html || '').matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)) {
    if (/\bselected\b/i.test(m[1])) return { text: erpTxt(m[2]), capacidad: prodNum((/data-capacidad=["'](\d+)["']/i.exec(m[1]) || [])[1]) };
  }
  return { text: '', capacidad: 0 };
}
// Recetas desde /Receta/GetAll (JSON): {id, Nombre, estilo, litros, OG, FG, ABV, IBU, SRM}.
function erpRecetasFromJson(arr){
  return (arr || []).map(r => ({
    erpId: String(r.id != null ? r.id : (r.idProducto != null ? r.idProducto : '')),
    nombre: erpTxt(r.Nombre || r.nombre || ''), estilo: erpTxt(r.estilo || ''),
    litros: erpNumCl(r.litros), og: erpNumCl(r.OG != null ? r.OG : r.og), abv: erpNumCl(r.ABV != null ? r.ABV : r.abv),
    fg: erpNumCl(r.FG), ibu: erpNumCl(r.IBU), srm: erpNumCl(r.SRM),
  })).filter(r => r.erpId || r.nombre);
}
// Lotes desde /Lote/GetAll (JSON): campos con HTML embebido (numero/descripcion en
// <a>, estado en <span>, etapa/tanque en <select>) → se limpian a texto.
function erpLotesFromJson(arr){
  return (arr || []).map(l => {
    const et = erpOptSel(l.etapa); const tq = erpOptSel(l.tanque);
    return {
      erpId: String(l.id != null ? l.id : ''),
      numero: erpTxt(l.numero), descripcion: erpTxt(l.descripcion),
      fechaCoccion: erpFecha(l.fecha),
      litrosDisponibles: erpNumCl(l.litros != null ? l.litros : l.litrosAsignados),
      estado: erpTxt(l.estado), etapa: et.text, tanque: tq.text, capacidad: tq.capacidad,
      idReceta: String(l.idReceta != null ? l.idReceta : (l.idCerve != null ? l.idCerve : '')), cantCocciones: prodNum(l.cantCocciones) || 1,
    };
  }).filter(l => l.erpId);
}
app.get('/admin/produccion/erp/estado', requireAdmin, (req, res) => {
  const cfg = prodLoad().config; const cr = erpCreds(cfg);
  res.json({ configurado: !!(cr.usuario && cr.clave), baseUrl: cr.base, usuario: cr.usuario, ultimaSync: cfg.erpLastSync || null, ultimoEstado: cfg.erpLastStatus || '' });
});
let erpSyncRunning = false;
// Ejecuta una sincronización completa (login + /Receta/GetAll + /Lote/GetAll + merge
// que nunca pisa datos manuales). Reutilizada por el botón y por el auto-sync.
async function erpRunSync(origen){
  if (erpSyncRunning) return { ok: false, estado: 'Ya hay una sincronización en curso.', ultimaSync: null };
  erpSyncRunning = true;
  const d = prodLoad(); const cfg = d.config; const cr = erpCreds(cfg);
  let msg = '';
  try {
    if (!cr.usuario || !cr.clave) throw new Error('Falta usuario o clave del ERP (Config).');
    const login = await erpLogin(cfg);
    if (!login.ok) throw new Error(login.error + (login.stage ? ' [' + login.stage + ']' : ''));
    // Recetas (API JSON: POST /Receta/GetAll).
    const recRes = await erpApiGetAll(cr.base, '/Receta/GetAll', login.jar, '/Receta');
    const recetas = erpRecetasFromJson(recRes.data);
    if (recetas.length) d.recetas = prodMergeRecetas(d.recetas || [], recetas);
    // Lotes (API JSON: POST /Lote/GetAll).
    const loteRes = await erpApiGetAll(cr.base, '/Lote/GetAll', login.jar, '/Lote');
    const lotes = erpLotesFromJson(loteRes.data);
    if (!recetas.length && !lotes.length) throw new Error('Login OK pero la API no devolvió datos (Receta:' + recRes.status + ' /Lote:' + loteRes.status + ').');
    let nuevos = 0, act = 0;
    for (const rl of lotes) {
      if (!rl.numero && !rl.erpId) continue;
      if (rl.tanque && !d.tanques.find(t => t.id === rl.tanque)) d.tanques.push({ id: rl.tanque, capacidadL: /^F([1-9]|1[0-4])$/.test(rl.tanque) ? prodCapTanque(rl.tanque) : (rl.capacidad || 1000), estado: 'vacio', loteActualId: null, sede: 'vespucio', sucio: false });
      const ex = d.lotes.find(x => x.erpId === rl.erpId || x.codigo === rl.numero);
      const estadoZ = erpEstadoZorbo(rl.etapa, rl.estado);
      if (!ex) {
        d.lotes.push({ id: prodNewId('lote'), erpId: rl.erpId, origen: 'erp', codigo: rl.numero, producto: rl.descripcion, estilo: rl.descripcion, familia: '', color: '',
          tanqueId: rl.tanque || '', nBatches: rl.cantCocciones || 1, volumenEsperadoL: rl.litrosDisponibles, volumenRealL: 0, idReceta: rl.idReceta,
          fechaCoccion: rl.fechaCoccion, fechaFermInicio: (estadoZ !== 'coccion' ? rl.fechaCoccion : null), fechaMadInicio: null, fechaEnvasado: null,
          estado: estadoZ, etapaErp: rl.etapa, estadoErp: rl.estado,
          etapas: PROD_ETAPAS.map(nombre => ({ nombre, inicio: null, fin: null, editadoManual: false })), envasados: [] });
        nuevos++;
      } else {
        ex.erpId = rl.erpId; ex.idReceta = rl.idReceta; ex.etapaErp = rl.etapa; ex.estadoErp = rl.estado;
        if (rl.descripcion) { ex.producto = ex.producto || rl.descripcion; ex.estilo = ex.estilo || rl.descripcion; }
        if (rl.fechaCoccion) ex.fechaCoccion = rl.fechaCoccion;
        if (rl.tanque) ex.tanqueId = rl.tanque;
        if (rl.litrosDisponibles) ex.volumenEsperadoL = ex.volumenEsperadoL || rl.litrosDisponibles;
        const orden = { coccion: 0, fermentacion: 1, maduracion: 2, listo: 3, envasado: 4 };
        if ((orden[estadoZ] || 0) > (orden[ex.estado] || 0)) { ex.estado = estadoZ; if (estadoZ !== 'coccion' && !ex.fechaFermInicio) ex.fechaFermInicio = rl.fechaCoccion; }
        act++;
      }
    }
    prodSyncTanques(d);
    msg = 'OK · ' + recetas.length + ' recetas · lotes: ' + nuevos + ' nuevos, ' + act + ' actualizados' + (origen === 'auto' ? ' (auto)' : '');
  } catch (e) { msg = 'Error: ' + String(e.message || e).slice(0, 180); }
  cfg.erpLastSync = new Date().toISOString(); cfg.erpLastStatus = msg; prodSave(d);
  erpSyncRunning = false;
  return { ok: !/^Error|^Falta/.test(msg), ultimaSync: cfg.erpLastSync, estado: msg };
}
// Auto-sync en segundo plano: cada minuto revisa si toca sincronizar según
// erpAutoSyncMin (0 = desactivado). Corre en Railway (alcanza el ERP).
setInterval(async () => {
  try {
    const cfg = prodLoad().config; const cr = erpCreds(cfg);
    const cada = prodNum(cfg.erpAutoSyncMin);
    if (!cada || cada <= 0 || !cr.usuario || !cr.clave || erpSyncRunning) return;
    const last = cfg.erpLastSync ? new Date(cfg.erpLastSync).getTime() : 0;
    if (Date.now() - last >= cada * 60000) await erpRunSync('auto');
  } catch (e) { /* no romper el loop */ }
}, 60000).unref?.();
app.post('/admin/produccion/erp/sync', requireAdmin, async (req, res) => {
  const r = await erpRunSync('manual');
  res.json(r);
});
// Crear lote (cocción). Ocupa el tanque destino recién al cerrar la cocción.
app.post('/admin/produccion/lote', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad();
  const codigo = prodStr(b.codigo, 40);
  if (!codigo) return res.status(400).json({ error: 'Ingresá el código del lote.' });
  const tanqueId = prodStr(b.tanqueId, 10);
  const tanque = d.tanques.find(t => t.id === tanqueId);
  if (tanqueId && !tanque) return res.status(400).json({ error: 'Tanque inválido.' });
  // D · enlace con receta: si se elige una, pre-rellena estilo/producto/volumen esperado.
  const recetaId = prodStr(b.recetaId, 40);
  const receta = recetaId ? (d.recetas || []).find(r => r.id === recetaId) : null;
  const lote = {
    id: prodNewId('lote'), codigo, recetaId: receta ? receta.id : '',
    producto: prodStr(b.producto, 80) || (receta ? receta.nombre : ''), estilo: prodStr(b.estilo, 60) || (receta ? receta.estilo : ''), familia: prodStr(b.familia, 40),
    tanqueId: tanqueId || '', nBatches: Math.max(1, Math.min(3, prodNum(b.nBatches) || 1)),
    volumenEsperadoL: prodNum(b.volumenEsperadoL) || (receta ? prodNum(receta.litros) : 0), volumenRealL: 0,
    fechaCoccion: prodTs(b.fechaCoccion) || new Date().toISOString(), fechaFermInicio: null, fechaMadInicio: null, fechaEnvasado: null,
    estado: 'coccion', viabilidadLevaduraPct: null,
    etapas: PROD_ETAPAS.map(nombre => ({ nombre, inicio: null, fin: null, editadoManual: false })),
    envasados: [], notas: prodStr(b.notas, 300),
  };
  d.lotes.push(lote); prodSave(d); res.json({ ok: true, lote });
});
// Actualizar lote (etapas, fechas, estado, volumen, notas). El front manda el lote completo.
app.put('/admin/produccion/lote/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const idx = d.lotes.findIndex(l => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Lote no encontrado.' });
  const cur = d.lotes[idx]; const b = req.body || {};
  const merged = { ...cur };
  ['codigo', 'producto', 'estilo', 'familia', 'notas'].forEach(k => { if (b[k] != null) merged[k] = prodStr(b[k], 80); });
  if (b.recetaId != null) merged.recetaId = prodStr(b.recetaId, 40);
  if (b.tanqueId != null) merged.tanqueId = prodStr(b.tanqueId, 10);
  if (b.nBatches != null) merged.nBatches = Math.max(1, Math.min(3, prodNum(b.nBatches)));
  if (b.volumenEsperadoL != null) merged.volumenEsperadoL = prodNum(b.volumenEsperadoL);
  if (b.volumenRealL != null) merged.volumenRealL = prodNum(b.volumenRealL);
  ['fechaCoccion', 'fechaFermInicio', 'fechaMadInicio', 'fechaEnvasado'].forEach(k => { if (b[k] !== undefined) merged[k] = prodTs(b[k]); });
  if (b.estado != null) merged.estado = prodStr(b.estado, 20);
  if (b.viabilidadLevaduraPct != null) merged.viabilidadLevaduraPct = prodNum(b.viabilidadLevaduraPct);
  if (Array.isArray(b.etapas)) merged.etapas = b.etapas.map((e, i) => ({ nombre: prodStr(e.nombre, 40) || (PROD_ETAPAS[i] || 'Etapa'), inicio: prodTs(e.inicio), fin: prodTs(e.fin), editadoManual: !!e.editadoManual }));
  if (Array.isArray(b.envasados)) merged.envasados = b.envasados.map(ev => {
    // Compat: líneas viejas traían `canal` barril|lata → mapear a formato.
    const formato = PROD_FORMATOS.includes(ev.formato) ? ev.formato : (ev.canal === 'lata' ? 'lata' : 'barril20');
    return {
      id: ev.id || prodNewId('env'), formato, inicio: prodTs(ev.inicio), fin: prodTs(ev.fin),
      litrosBuenos: prodNum(ev.litrosBuenos), litrosRechazados: prodNum(ev.litrosRechazados), unidades: prodNum(ev.unidades),
      latasNivelBajo: prodNum(ev.latasNivelBajo), mermaTapas: prodNum(ev.mermaTapas), editadoManual: !!ev.editadoManual,
    };
  });
  // C · Validación: la suma envasada (buenos + rechazados de todas las líneas) no
  // puede superar el volumen del lote. El resto queda en el tanque (envasado parcial).
  {
    const base = prodVolumenBase(merged);
    const sum = (merged.envasados || []).reduce((a, ev) => a + prodNum(ev.litrosBuenos) + prodNum(ev.litrosRechazados), 0);
    if (base > 0 && sum > base + 0.5) return res.status(400).json({ error: `Los litros envasados (${Math.round(sum)} L) superan el volumen del lote (${Math.round(base)} L). Ajustá las líneas.` });
  }
  d.lotes[idx] = merged;
  // El tanque queda "Sucio" recién al CERRAR el envasado (vaciado → fechaEnvasado).
  // Mientras se envasa de a poco sigue "Ocupado" (queda cerveza adentro).
  if (merged.fechaEnvasado && !cur.fechaEnvasado && merged.tanqueId) { const t = d.tanques.find(x => x.id === merged.tanqueId); if (t) t.sucio = true; }
  prodSyncTanques(d);
  prodSave(d); res.json({ ok: true, lote: merged });
});
app.delete('/admin/produccion/lote/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const n = d.lotes.length; d.lotes = d.lotes.filter(l => l.id !== req.params.id);
  if (d.lotes.length === n) return res.status(404).json({ error: 'Lote no encontrado.' });
  prodSyncTanques(d); prodSave(d); res.json({ ok: true });
});
// Recalcula qué tanque ocupa cada lote: ocupado si el lote está en ferm/mad/listo
// (no envasado). Un lote envasado deja el tanque "sucio" hasta que se registre su CIP.
function prodSyncTanques(d){
  d.tanques.forEach(t => { t.loteActualId = null; });
  for (const l of d.lotes) {
    if (!l.tanqueId) continue;
    const t = d.tanques.find(x => x.id === l.tanqueId); if (!t) continue;
    // Un lote ocupa el tanque en ferm/mad/listo, y también mientras se envasa de a
    // poco (estado 'envasado' sin cierre): queda cerveza adentro hasta vaciarse.
    const drenado = l.fechaEnvasado != null; // envasado cerrado = tanque vaciado
    const ocupa = ['fermentacion', 'maduracion', 'listo'].includes(l.estado) || (l.estado === 'envasado' && !drenado);
    if (ocupa && !t.loteActualId) t.loteActualId = l.id;
  }
  // El flag t.sucio es persistente: se prende al cerrar el envasado y se apaga con el CIP.
  d.tanques.forEach(t => { t.estado = t.loteActualId ? 'ocupado' : (t.sucio ? 'sucio' : 'vacio'); });
}
// Limpiezas (paradas planificadas).
app.post('/admin/produccion/limpieza', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad();
  const limp = { id: prodNewId('cip'), tipo: PROD_LIMPIEZA_TIPOS.includes(prodStr(b.tipo)) ? prodStr(b.tipo) : 'general', centroTrabajo: PROD_CENTROS.includes(prodStr(b.centroTrabajo)) ? prodStr(b.centroTrabajo) : 'brewhouse', ref: prodStr(b.ref, 40), inicio: prodTs(b.inicio) || new Date().toISOString(), fin: prodTs(b.fin), editadoManual: !!b.editadoManual };
  d.limpiezas.push(limp); prodSave(d); res.json({ ok: true, limpieza: limp });
});
app.put('/admin/produccion/limpieza/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const it = d.limpiezas.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'No encontrada.' });
  const b = req.body || {}; if (b.tipo != null) it.tipo = prodStr(b.tipo); if (b.centroTrabajo != null) it.centroTrabajo = prodStr(b.centroTrabajo); if (b.ref != null) it.ref = prodStr(b.ref, 40); if (b.inicio !== undefined) it.inicio = prodTs(b.inicio); if (b.fin !== undefined) it.fin = prodTs(b.fin); it.editadoManual = true;
  prodSave(d); res.json({ ok: true, limpieza: it });
});
app.delete('/admin/produccion/limpieza/:id', requireAdmin, (req, res) => { const d = prodLoad(); const n = d.limpiezas.length; d.limpiezas = d.limpiezas.filter(x => x.id !== req.params.id); if (d.limpiezas.length === n) return res.status(404).json({ error: 'No encontrada.' }); prodSave(d); res.json({ ok: true }); });
// Paradas (no planificadas — fallas/esperas). Completan la disponibilidad real.
app.post('/admin/produccion/parada', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad();
  const par = { id: prodNewId('par'), centroTrabajo: PROD_CENTROS.includes(prodStr(b.centroTrabajo)) ? prodStr(b.centroTrabajo) : 'brewhouse', equipo: prodStr(b.equipo, 60), causa: prodStr(b.causa, 120), categoria: PROD_PARADA_CAT.includes(prodStr(b.categoria)) ? prodStr(b.categoria) : 'otro', inicio: prodTs(b.inicio) || new Date().toISOString(), fin: prodTs(b.fin), editadoManual: !!b.editadoManual };
  d.paradas.push(par); prodSave(d); res.json({ ok: true, parada: par });
});
app.put('/admin/produccion/parada/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const it = d.paradas.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'No encontrada.' });
  const b = req.body || {}; ['centroTrabajo', 'equipo', 'causa', 'categoria'].forEach(k => { if (b[k] != null) it[k] = prodStr(b[k], 120); }); if (b.inicio !== undefined) it.inicio = prodTs(b.inicio); if (b.fin !== undefined) it.fin = prodTs(b.fin); it.editadoManual = true;
  prodSave(d); res.json({ ok: true, parada: it });
});
app.delete('/admin/produccion/parada/:id', requireAdmin, (req, res) => { const d = prodLoad(); const n = d.paradas.length; d.paradas = d.paradas.filter(x => x.id !== req.params.id); if (d.paradas.length === n) return res.status(404).json({ error: 'No encontrada.' }); prodSave(d); res.json({ ok: true }); });
// ── Inventario de producción: barriles (sucios/limpios) + insumos de envasado
// (latas, tapas, etiquetas por diseño) con cantidad y valor monetario. Los
// barriles hoy se cuentan a mano — queda pendiente la lectura en vivo desde
// Gestión Cervecera (ERP), que aún no expone esa data.
app.put('/admin/produccion/inventario/barriles', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad(); d.inventario = d.inventario || prodInventarioDefaults();
  d.inventario.barriles = { sucios: Math.max(0, Math.round(prodNum(b.sucios))), limpios: Math.max(0, Math.round(prodNum(b.limpios))), actualizado: new Date().toISOString(), origen: 'manual' };
  prodSave(d); res.json({ ok: true, barriles: d.inventario.barriles });
});
app.post('/admin/produccion/inventario/insumo', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad(); d.inventario = d.inventario || prodInventarioDefaults();
  const nombre = prodStr(b.nombre, 80); if (!nombre) return res.status(400).json({ error: 'Falta el nombre/diseño.' });
  const it = { id: prodNewId('ins'), categoria: PROD_INV_CATS.includes(prodStr(b.categoria)) ? prodStr(b.categoria) : 'lata', nombre, cantidad: Math.max(0, Math.round(prodNum(b.cantidad))), costoUnitario: Math.max(0, prodNum(b.costoUnitario)) };
  d.inventario.insumos.push(it); prodSave(d); res.json({ ok: true, insumo: it });
});
app.put('/admin/produccion/inventario/insumo/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); d.inventario = d.inventario || prodInventarioDefaults();
  const it = d.inventario.insumos.find(x => x.id === req.params.id); if (!it) return res.status(404).json({ error: 'No encontrado.' });
  const b = req.body || {};
  if (b.categoria != null && PROD_INV_CATS.includes(prodStr(b.categoria))) it.categoria = prodStr(b.categoria);
  if (b.nombre != null) it.nombre = prodStr(b.nombre, 80);
  if (b.cantidad != null) it.cantidad = Math.max(0, Math.round(prodNum(b.cantidad)));
  if (b.costoUnitario != null) it.costoUnitario = Math.max(0, prodNum(b.costoUnitario));
  prodSave(d); res.json({ ok: true, insumo: it });
});
app.delete('/admin/produccion/inventario/insumo/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); d.inventario = d.inventario || prodInventarioDefaults();
  const n = d.inventario.insumos.length; d.inventario.insumos = d.inventario.insumos.filter(x => x.id !== req.params.id);
  if (d.inventario.insumos.length === n) return res.status(404).json({ error: 'No encontrado.' });
  prodSave(d); res.json({ ok: true });
});
// ── Recetas teóricas (D) ── ERP (scraping/sync) + complemento local. La receta
// define litros esperados por formato y tiempos estándar por etapa → base de la
// Calidad (merma = 1 − real/esperado) y del Rendimiento teórico. Enlace por recetaId.
function prodRecetaClean(b, base){
  const r = base || {};
  if (b.nombre != null) r.nombre = prodStr(b.nombre, 120);
  if (b.estilo != null) r.estilo = prodStr(b.estilo, 80);
  if (b.tipo != null) r.tipo = b.tipo === 'destileria' ? 'destileria' : 'cerveceria';
  if (b.color != null) { const hex = prodStr(b.color, 20); if (!hex) r.color = ''; else if (prodColorValido(hex, r.tipo || 'cerveceria')) r.color = hex; }
  if (b.litros != null) r.litros = prodNum(b.litros);
  if (b.og != null) r.og = prodNum(b.og);
  if (b.abv != null) r.abv = prodNum(b.abv);
  if (b.notas != null) r.notas = prodStr(b.notas, 400);
  if (b.tiemposEstandar && typeof b.tiemposEstandar === 'object') { const t = {}; for (const [k, v] of Object.entries(b.tiemposEstandar)) t[prodStr(k, 40)] = prodNum(v); r.tiemposEstandar = t; }
  if (b.litrosEsperadosPorFormato && typeof b.litrosEsperadosPorFormato === 'object') { const f = { ...(r.litrosEsperadosPorFormato || {}) }; for (const fm of PROD_FORMATOS) if (b.litrosEsperadosPorFormato[fm] != null) f[fm] = prodNum(b.litrosEsperadosPorFormato[fm]); r.litrosEsperadosPorFormato = f; }
  return r;
}
app.post('/admin/produccion/receta', requireAdmin, (req, res) => {
  const b = req.body || {}; const d = prodLoad();
  const nombre = prodStr(b.nombre, 120); if (!nombre) return res.status(400).json({ error: 'Ingresá el nombre de la receta.' });
  const r = prodEnsureRecetaShape(prodRecetaClean(b, { origen: 'local' })); r.nombre = nombre;
  d.recetas = d.recetas || []; d.recetas.push(r); prodSave(d); res.json({ ok: true, receta: r });
});
app.put('/admin/produccion/receta/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const r = (d.recetas || []).find(x => x.id === req.params.id || (x.erpId && String(x.erpId) === req.params.id));
  if (!r) return res.status(404).json({ error: 'Receta no encontrada.' });
  prodEnsureRecetaShape(r); prodRecetaClean(req.body || {}, r); prodSave(d); res.json({ ok: true, receta: r });
});
app.post('/admin/produccion/receta/:id/duplicar', requireAdmin, (req, res) => {
  const d = prodLoad(); const src = (d.recetas || []).find(x => x.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Receta no encontrada.' });
  const copy = prodEnsureRecetaShape({ ...JSON.parse(JSON.stringify(src)), id: null, erpId: null, origen: 'local', nombre: (src.nombre || 'Receta') + ' (copia)' });
  d.recetas.push(copy); prodSave(d); res.json({ ok: true, receta: copy });
});
app.delete('/admin/produccion/receta/:id', requireAdmin, (req, res) => {
  const d = prodLoad(); const n = (d.recetas || []).length; d.recetas = (d.recetas || []).filter(x => x.id !== req.params.id);
  if ((d.recetas || []).length === n) return res.status(404).json({ error: 'Receta no encontrada.' });
  prodSave(d); res.json({ ok: true });
});
// Export a Excel de las recetas (nombre, estilo, litros, OG, ABV + litros esperados por formato).
app.get('/admin/produccion/recetas/export.xlsx', requireAdmin, (req, res) => {
  try {
    const d = prodLoad(); prodNormalizeRecetas(d);
    const H = 1; // header en negrita (estilo del styleSheet reusado)
    const rows = [[{ v: 'Nombre', s: H }, { v: 'Estilo', s: H }, { v: 'Litros', s: H }, { v: 'OG', s: H }, { v: 'ABV %', s: H }, { v: 'Barril 20 L', s: H }, { v: 'Barril 30 L', s: H }, { v: 'Lata', s: H }, { v: 'Origen', s: H }]];
    for (const r of (d.recetas || [])) {
      const f = r.litrosEsperadosPorFormato || {};
      rows.push([{ v: r.nombre || '' }, { v: r.estilo || '' }, { v: prodNum(r.litros), t: 'n' }, { v: prodNum(r.og), t: 'n' }, { v: prodNum(r.abv), t: 'n' }, { v: prodNum(f.barril20), t: 'n' }, { v: prodNum(f.barril30), t: 'n' }, { v: prodNum(f.lata), t: 'n' }, { v: r.origen || 'local' }]);
    }
    sendXlsx(res, xlsxPackage([{ name: 'Recetas', rows }]), 'Recetas_Kairos.xlsx');
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Detalle completo de una receta desde el ERP (ingredientes por tipo + tareas del
// proceso), on-demand. Cruza los ingredientes con el catálogo de materias primas.
// POST /Receta/GetTareas (id) + POST /Receta/MPsTipo (idReceta+tipo, 1 por tipo).
const ERP_MP_TIPOS = [{ tipo: 1, nombre: 'Maltas / Granos' }, { tipo: 2, nombre: 'Lúpulos' }, { tipo: 3, nombre: 'Levaduras' }, { tipo: 4, nombre: 'Adjuntos / Otros' }, { tipo: 5, nombre: 'Agua / Sales' }, { tipo: 6, nombre: 'Varios' }];
// Elige de un objeto el primer campo presente de una lista de nombres posibles.
const erpPick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
app.get('/admin/produccion/receta/:id/detalle', requireAdmin, async (req, res) => {
  try {
    const d = prodLoad(); const receta = (d.recetas || []).find(r => r.id === req.params.id || (r.erpId && String(r.erpId) === req.params.id));
    if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });
    if (!receta.erpId) return res.json({ ok: true, soloLocal: true, nombre: receta.nombre, grupos: [], tareas: [] });
    const cfg = d.config; const cr = erpCreds(cfg);
    const login = await erpLogin(cfg);
    if (!login.ok) return res.status(502).json({ error: 'No pude entrar al ERP: ' + (login.error || '') + (login.stage ? ' [' + login.stage + ']' : '') });
    const rid = receta.erpId;
    const cat = await erpMPCatalogo(cr.base, login.jar);
    const ref = '/Receta/Ver?id=' + rid;
    // Abrir la página de la receta primero: fija la "receta actual" en la sesión del
    // ERP; recién ahí GetTareas/MPsTipo devuelven datos (igual que hace el navegador).
    try { await erpGet(cr.base + ref, login.jar, cr.base); } catch (e) { }
    const tareasR = await erpApiPost(cr.base, '/Receta/GetTareas', 'id=' + encodeURIComponent(rid), login.jar, ref);
    const tareas = (tareasR.arr || []).map((t, i) => ({
      orden: erpPick(t, ['orden', 'Orden', 'nro', 'numero']) || (i + 1),
      titulo: erpTxt(erpPick(t, ['titulo', 'Titulo', 'nombre', 'Nombre', 'tarea', 'Tarea', 'descripcion', 'Descripcion']) || ''),
      detalle: erpTxt(erpPick(t, ['detalle', 'Detalle', 'descripcion', 'Descripcion', 'observacion', 'nota']) || ''),
      _raw: t,
    }));
    const grupos = [];
    for (const { tipo, nombre } of ERP_MP_TIPOS) {
      const mp = await erpApiPost(cr.base, '/Receta/MPsTipo', 'idReceta=' + encodeURIComponent(rid) + '&tipo=' + tipo, login.jar, ref);
      const items = (mp.arr || []).map(it => {
        const idMP = String(erpPick(it, ['idMP', 'idMateriaPrima', 'IdMP', 'idmp', 'idMateriaprima']) || '');
        const c = cat[idMP] || {};
        return {
          nombre: erpTxt(erpPick(it, ['nombre', 'Nombre', 'nombreMP', 'materiaPrima']) || c.nombre || ('MP ' + idMP)),
          marca: erpTxt(erpPick(it, ['marca', 'Marca']) || c.marca || ''),
          cantidad: erpNumCl(erpPick(it, ['cantidad', 'Cantidad', 'cant', 'kilos', 'kg', 'gramos', 'litros']) || 0),
          unidad: erpTxt(erpPick(it, ['unidad', 'Unidad', 'unidadMedida']) || c.unidad || ''),
          _raw: it,
        };
      });
      if (items.length) grupos.push({ tipo, nombre, items });
    }
    res.json({ ok: true, erpId: rid, nombre: receta.nombre, estilo: receta.estilo, litros: receta.litros, og: receta.og, abv: receta.abv, grupos, tareas, catalogoSize: Object.keys(cat).length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ═══ MOTOR DE OEE (Fase 2) ═══════════════════════════════════════════════════
// OEE = Disponibilidad × Rendimiento × Calidad, por centro (envasado/brewhouse/
// planta) y periodo. Cada factor en [0,1]. Se muestran SIEMPRE los números crudos
// (trazabilidad). El OEE solo existe si los tres factores existen. No se mezclan
// centros. Rendimiento clamp a 100%. Calidad excluye lotes no envasados.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const H_MS = 3600000, DAY_MS = 86400000;
// Horas de solape entre [ini,fin] de un registro y la ventana [desde,hasta].
// fin abierto (null) cuenta hasta ahora (o hasta el fin de la ventana).
function prodOverlapH(iniISO, finISO, desde, hasta){
  const ini = iniISO ? new Date(iniISO).getTime() : NaN;
  if (!Number.isFinite(ini)) return 0;
  let fin = finISO ? new Date(finISO).getTime() : Date.now();
  if (!Number.isFinite(fin)) fin = Date.now();
  const a = Math.max(ini, desde.getTime()), b = Math.min(fin, hasta.getTime());
  return b > a ? (b - a) / H_MS : 0;
}
// ¿El instante `ts` cae dentro de la ventana?
function prodInWin(tsISO, desde, hasta){
  if (!tsISO) return false;
  const t = new Date(tsISO).getTime();
  return Number.isFinite(t) && t >= desde.getTime() && t <= hasta.getTime();
}
// Banda de color del OEE (rojo <40, ámbar 40–60, verde 60–85, azul >85).
function prodBandaOee(v){ if (v == null) return 'na'; const p = v * 100; return p < 40 ? 'rojo' : p < 60 ? 'ambar' : p < 85 ? 'verde' : 'azul'; }
const prodCentroStop = (centro, x) => centro === 'planta' ? true : (x.centroTrabajo === centro);
// Disponibilidad = (TiempoPlanificado − Paradas) / TiempoPlanificado. Paradas =
// limpiezas (si el toggle) + paradas no planificadas del centro y periodo.
function prodDisponibilidad(d, cfg, centro, desde, hasta, incluirLimpieza){
  const semanas = Math.max(0, (hasta.getTime() - desde.getTime()) / (7 * DAY_MS));
  const tpH = (prodNum(cfg.horasPorSemana) || 40) * semanas; // fallback: 40 h/sem × semanas
  let limpH = 0, parH = 0, nPar = 0;
  for (const l of (d.limpiezas || [])) if (prodCentroStop(centro, l)) limpH += prodOverlapH(l.inicio, l.fin, desde, hasta);
  for (const p of (d.paradas || [])) if (prodCentroStop(centro, p)) { const h = prodOverlapH(p.inicio, p.fin, desde, hasta); if (h > 0) { parH += h; nPar++; } }
  const paradasH = (incluirLimpieza ? limpH : 0) + parH;
  const valor = tpH > 0 ? clamp01((tpH - paradasH) / tpH) : null;
  return { valor, tiempoPlanificadoH: Math.round(tpH * 10) / 10, limpiezasH: Math.round(limpH * 10) / 10, paradasNoPlanH: Math.round(parH * 10) / 10, paradasH: Math.round(paradasH * 10) / 10, incluirLimpieza, nParadas: nPar, esTecho: nPar === 0 };
}
// Rendimiento en envasado, ponderado por litros buenos. velReal = buenos/durH;
// rendLínea = min(1, velReal/velNominal(formato)). R = Σ(rend×buenos)/Σ(buenos).
function prodRendimientoEnv(d, cfg, desde, hasta){
  let num = 0, den = 0, nLineas = 0, sumVelReal = 0;
  for (const lote of (d.lotes || [])) for (const ev of (lote.envasados || [])) {
    const ts = ev.fin || ev.inicio; if (!prodInWin(ts, desde, hasta)) continue;
    const durH = (ev.inicio && ev.fin) ? (new Date(ev.fin) - new Date(ev.inicio)) / H_MS : 0;
    const buenos = prodNum(ev.litrosBuenos);
    if (durH <= 0 || buenos <= 0) continue;
    const fmt = ev.formato || (ev.canal === 'lata' ? 'lata' : 'barril20');
    const velNom = prodVelNominal(cfg, fmt); if (velNom <= 0) continue;
    const velReal = buenos / durH;
    num += Math.min(1, velReal / velNom) * buenos; den += buenos; nLineas++; sumVelReal += velReal;
  }
  return { valor: den > 0 ? clamp01(num / den) : null, litrosBuenos: Math.round(den), nLineas, velRealProm: nLineas ? Math.round(sumVelReal / nLineas) : null, base: 'envasado (ponderado por litros)' };
}
// Rendimiento opcional de brewhouse = cicloEstándar / cicloReal promedio (clamp 1).
function prodRendimientoBrew(d, cfg, desde, hasta){
  const est = prodNum(cfg.cicloCoccionEstandarH) || 4.2; const ciclos = [];
  for (const lote of (d.lotes || [])) {
    const timed = (lote.etapas || []).filter(e => e.inicio && e.fin);
    if (!timed.length) continue;
    const ts = timed[timed.length - 1].fin || lote.fechaCoccion; if (!prodInWin(ts, desde, hasta)) continue;
    const real = timed.reduce((a, e) => a + (new Date(e.fin) - new Date(e.inicio)) / H_MS, 0);
    if (real > 0) ciclos.push(real);
  }
  const avg = ciclos.length ? ciclos.reduce((a, b) => a + b, 0) / ciclos.length : null;
  return { valor: avg ? clamp01(est / avg) : null, cicloEstandarH: est, cicloRealPromH: avg ? Math.round(avg * 100) / 100 : null, nCiclos: ciclos.length, base: 'brewhouse (ciclo estándar / real)' };
}
// Calidad = litrosBuenos / (litrosBuenos + litrosRechazados) de las líneas del
// periodo. Excluye lotes no envasados (no hay líneas → no contribuye). Latas nivel
// bajo y merma tapas se reportan como pérdidas adicionales (unidades, no litros).
function prodCalidad(d, desde, hasta){
  let buenos = 0, rech = 0, latasBajo = 0, tapas = 0, nLineas = 0;
  for (const lote of (d.lotes || [])) for (const ev of (lote.envasados || [])) {
    const ts = ev.fin || ev.inicio; if (!prodInWin(ts, desde, hasta)) continue;
    const b = prodNum(ev.litrosBuenos), r = prodNum(ev.litrosRechazados);
    if (b <= 0 && r <= 0) continue;
    buenos += b; rech += r; latasBajo += prodNum(ev.latasNivelBajo); tapas += prodNum(ev.mermaTapas); nLineas++;
  }
  const tot = buenos + rech;
  return { valor: tot > 0 ? clamp01(buenos / tot) : null, litrosBuenos: Math.round(buenos), litrosRechazados: Math.round(rech), latasNivelBajo: latasBajo, mermaTapas: tapas, nLineas };
}
// OEE de un centro para una ventana. Brewhouse: R por ciclo, C = null (la calidad
// se mide al envasar). Envasado y planta: R y C por líneas de envasado.
function prodComputeOEE(d, cfg, centro, desde, hasta, incluirLimpieza){
  const disp = prodDisponibilidad(d, cfg, centro, desde, hasta, incluirLimpieza);
  let rend, cal;
  if (centro === 'brewhouse') { rend = prodRendimientoBrew(d, cfg, desde, hasta); cal = { valor: null, nota: 'La calidad se mide en envasado.' }; }
  else { rend = prodRendimientoEnv(d, cfg, desde, hasta); cal = prodCalidad(d, desde, hasta); }
  const D = disp.valor, R = rend.valor, C = cal.valor;
  const oee = (D != null && R != null && C != null) ? clamp01(D * R * C) : null;
  return { centro, desde: desde.toISOString(), hasta: hasta.toISOString(), disponibilidad: disp, rendimiento: rend, calidad: cal, oee, banda: prodBandaOee(oee) };
}
// Buckets de tendencia: n periodos de tamaño `bucket` terminando en `hasta`.
function prodTrendBuckets(bucket, n, hasta){
  const out = []; const end = new Date(hasta.getTime());
  for (let i = n - 1; i >= 0; i--) {
    let bDesde, bHasta, label;
    if (bucket === 'mes') {
      const ref = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
      bDesde = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
      bHasta = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
      label = ('' + (ref.getUTCMonth() + 1)).padStart(2, '0') + '/' + String(ref.getUTCFullYear()).slice(2);
    } else {
      const span = bucket === 'dia' ? DAY_MS : 7 * DAY_MS;
      bHasta = new Date(end.getTime() - i * span); bDesde = new Date(bHasta.getTime() - span);
      label = bucket === 'dia' ? (('' + bDesde.getUTCDate()).padStart(2, '0') + '/' + ('' + (bDesde.getUTCMonth() + 1)).padStart(2, '0'))
        : ('sem ' + ('' + bDesde.getUTCDate()).padStart(2, '0') + '/' + ('' + (bDesde.getUTCMonth() + 1)).padStart(2, '0'));
    }
    out.push({ label, desde: bDesde, hasta: bHasta });
  }
  return out;
}
// ── Datos complementarios del dashboard ──
// Pareto de paradas: causas (y limpiezas por tipo) que más tiempo consumen.
function prodParetoParadas(d, centro, desde, hasta, incluirLimpieza){
  const m = {};
  for (const p of (d.paradas || [])) if (prodCentroStop(centro, p)) { const h = prodOverlapH(p.inicio, p.fin, desde, hasta); if (h > 0) { const k = (p.causa || p.categoria || 'otro'); m[k] = (m[k] || 0) + h; } }
  if (incluirLimpieza) for (const l of (d.limpiezas || [])) if (prodCentroStop(centro, l)) { const h = prodOverlapH(l.inicio, l.fin, desde, hasta); if (h > 0) { const k = 'Limpieza · ' + (l.tipo || 'general'); m[k] = (m[k] || 0) + h; } }
  return Object.entries(m).map(([k, v]) => ({ causa: k, horas: Math.round(v * 100) / 100 })).sort((a, b) => b.horas - a.horas).slice(0, 12);
}
// Pareto de tiempos de cocción: en qué etapa se va el ciclo (~4,2 h).
function prodParetoCoccion(d, desde, hasta){
  const m = {};
  for (const lote of (d.lotes || [])) for (const e of (lote.etapas || [])) {
    if (!e.inicio || !e.fin) continue; const ts = e.fin; if (!prodInWin(ts, desde, hasta)) continue;
    const h = (new Date(e.fin) - new Date(e.inicio)) / H_MS; if (h > 0) m[e.nombre] = (m[e.nombre] || 0) + h;
  }
  return Object.entries(m).map(([k, v]) => ({ etapa: k, horas: Math.round(v * 100) / 100 })).sort((a, b) => b.horas - a.horas);
}
// Lead time por estilo (lotes envasados en el periodo): min = piso biológico, el
// resto es permanencia extra en tanque. Muestra la variabilidad intra-estilo.
function prodLeadPorEstilo(d, desde, hasta){
  const m = {};
  for (const lote of (d.lotes || [])) {
    if (!lote.fechaEnvasado || !lote.fechaCoccion) continue;
    if (!prodInWin(lote.fechaEnvasado, desde, hasta)) continue;
    const dias = Math.max(0, Math.round((new Date(lote.fechaEnvasado) - new Date(lote.fechaCoccion)) / DAY_MS));
    const est = (lote.estilo || '(sin estilo)').trim() || '(sin estilo)';
    (m[est] = m[est] || []).push({ codigo: lote.codigo, dias });
  }
  return Object.entries(m).map(([estilo, arr]) => { const ds = arr.map(x => x.dias); return { estilo, n: arr.length, min: Math.min(...ds), max: Math.max(...ds), prom: Math.round(ds.reduce((a, b) => a + b, 0) / ds.length), lotes: arr }; }).sort((a, b) => b.n - a.n);
}
// Barril vs lata: litros, horas, velocidad y % del tiempo de envasado.
function prodBarrilVsLata(d, cfg, desde, hasta){
  const g = { barril: { litros: 0, horas: 0 }, lata: { litros: 0, horas: 0 } };
  for (const lote of (d.lotes || [])) for (const ev of (lote.envasados || [])) {
    const ts = ev.fin || ev.inicio; if (!prodInWin(ts, desde, hasta)) continue;
    const fmt = ev.formato || (ev.canal === 'lata' ? 'lata' : 'barril20');
    const fam = fmt === 'lata' ? 'lata' : 'barril';
    const durH = (ev.inicio && ev.fin) ? (new Date(ev.fin) - new Date(ev.inicio)) / H_MS : 0;
    g[fam].litros += prodNum(ev.litrosBuenos); g[fam].horas += Math.max(0, durH);
  }
  const totH = g.barril.horas + g.lata.horas;
  const pack = (o) => ({ litros: Math.round(o.litros), horas: Math.round(o.horas * 100) / 100, velLh: o.horas > 0 ? Math.round(o.litros / o.horas) : null, pctTiempo: totH > 0 ? Math.round(o.horas / totH * 100) : 0 });
  return { barril: pack(g.barril), lata: pack(g.lata), totalHoras: Math.round(totH * 100) / 100 };
}
// Merma por lote (solo envasados): merma = 1 − litrosBuenos / litrosEsperados.
function prodMermaPorLote(d, desde, hasta){
  const out = [];
  for (const lote of (d.lotes || [])) {
    if (!lote.fechaEnvasado || !prodInWin(lote.fechaEnvasado, desde, hasta)) continue;
    const buenos = (lote.envasados || []).reduce((a, e) => a + prodNum(e.litrosBuenos), 0);
    const esperado = prodNum(lote.volumenRealL) || prodNum(lote.volumenEsperadoL) || 0;
    if (esperado <= 0 || buenos <= 0) continue;
    out.push({ codigo: lote.codigo, estilo: lote.estilo || '', fechaEnvasado: lote.fechaEnvasado, esperado: Math.round(esperado), buenos: Math.round(buenos), mermaPct: Math.round((1 - buenos / esperado) * 1000) / 10 });
  }
  return out.sort((a, b) => new Date(a.fechaEnvasado) - new Date(b.fechaEnvasado));
}
// Ocupación de tanques: utilización % (tanque-días ocupados / disponibles) y lotes
// en sobre-estadía (pasan la fecha proyectada de envasado sin envasarse).
function prodOcupacion(d, cfg, desde, hasta){
  // El OEE de fermentadores mide solo la CD propia (Vespucio); Lampa/Franklin
  // son maquila y no forman parte de este flujo de lotes.
  const nT = (d.tanques || []).filter(t => (t.sede || 'vespucio') === 'vespucio').length || 1;
  const winDias = Math.max(0.01, (hasta.getTime() - desde.getTime()) / DAY_MS);
  const disponiblesTD = nT * winDias;
  let ocupadosTD = 0;
  for (const lote of (d.lotes || [])) {
    if (!lote.tanqueId || !lote.fechaFermInicio) continue;
    const finOcup = lote.fechaEnvasado || new Date().toISOString();
    ocupadosTD += prodOverlapH(lote.fechaFermInicio, finOcup, desde, hasta) / 24;
  }
  // Sobre-estadía: lotes activos que pasaron su fecha proyectada de envasado.
  const sobre = [];
  for (const lote of (d.lotes || [])) {
    if (lote.fechaEnvasado || !lote.fechaCoccion || !lote.tanqueId) continue;
    if (!['fermentacion', 'maduracion', 'listo', 'envasado'].includes(lote.estado)) continue;
    const lead = prodLeadObjetivo(cfg, lote.estilo);
    const proy = new Date(lote.fechaCoccion).getTime() + lead * DAY_MS;
    if (Date.now() > proy) sobre.push({ codigo: lote.codigo, estilo: lote.estilo || '', tanqueId: lote.tanqueId, diasSobre: Math.floor((Date.now() - proy) / DAY_MS), leadObjetivo: lead });
  }
  return { utilizacionPct: Math.round(ocupadosTD / disponiblesTD * 100), ocupadosTD: Math.round(ocupadosTD * 10) / 10, disponiblesTD: Math.round(disponiblesTD * 10) / 10, nTanques: nT, sobreEstadia: sobre.sort((a, b) => b.diasSobre - a.diasSobre) };
}
// Complementarias (NO son OEE): utilización de fermentadores y carga vs capacidad.
function prodComplementarias(d, cfg, desde, hasta){
  const ocup = prodOcupacion(d, cfg, desde, hasta);
  const semanas = Math.max(0.01, (hasta.getTime() - desde.getTime()) / (7 * DAY_MS));
  const nTrab = prodNum(cfg.nTrabajadores) || 4;
  const capacidadH = (prodNum(cfg.horasPorSemana) || 40) * nTrab * semanas;
  let coccionH = 0, limpiezaH = 0, envasadoH = 0;
  for (const lote of (d.lotes || [])) for (const e of (lote.etapas || [])) if (e.inicio && e.fin && prodInWin(e.fin, desde, hasta)) coccionH += Math.max(0, (new Date(e.fin) - new Date(e.inicio)) / H_MS);
  for (const l of (d.limpiezas || [])) limpiezaH += prodOverlapH(l.inicio, l.fin, desde, hasta);
  for (const lote of (d.lotes || [])) for (const ev of (lote.envasados || [])) { const ts = ev.fin || ev.inicio; if (prodInWin(ts, desde, hasta) && ev.inicio && ev.fin) envasadoH += Math.max(0, (new Date(ev.fin) - new Date(ev.inicio)) / H_MS); }
  const demandaH = coccionH + limpiezaH + envasadoH;
  return {
    utilizacionFermentadores: { pct: ocup.utilizacionPct, ocupadosTD: ocup.ocupadosTD, disponiblesTD: ocup.disponiblesTD, nTanques: ocup.nTanques },
    cargaVsCapacidad: { demandaH: Math.round(demandaH * 10) / 10, capacidadH: Math.round(capacidadH * 10) / 10, pct: capacidadH > 0 ? Math.round(demandaH / capacidadH * 100) : null, coccionH: Math.round(coccionH * 10) / 10, limpiezaH: Math.round(limpiezaH * 10) / 10, envasadoH: Math.round(envasadoH * 10) / 10, nTrabajadores: nTrab },
  };
}
// Parseo de la ventana desde los query params (default: últimos 30 días).
function prodWindow(q){
  const now = Date.now();
  let hasta = q.hasta ? new Date(q.hasta) : new Date(now);
  let desde = q.desde ? new Date(q.desde) : new Date(hasta.getTime() - 30 * DAY_MS);
  if (isNaN(hasta)) hasta = new Date(now); if (isNaN(desde)) desde = new Date(hasta.getTime() - 30 * DAY_MS);
  if (desde.getTime() > hasta.getTime()) { const t = desde; desde = hasta; hasta = t; }
  return { desde, hasta };
}
// Endpoint único del dashboard de OEE: factores + crudos + tendencia + todos los
// gráficos, para el centro y periodo pedidos.
app.get('/admin/produccion/oee', requireAdmin, (req, res) => {
  try {
    const d = prodLoad(); const cfg = d.config; const q = req.query || {};
    const centro = ['envasado', 'brewhouse', 'planta'].includes(q.centro) ? q.centro : 'envasado';
    const { desde, hasta } = prodWindow(q);
    const incluirLimpieza = q.incluirLimpieza != null ? (q.incluirLimpieza === '1' || q.incluirLimpieza === 'true') : (cfg.incluirLimpiezaEnDisponibilidad !== false);
    const bucket = ['dia', 'semana', 'mes'].includes(q.bucket) ? q.bucket : 'semana';
    const nBuckets = Math.max(1, Math.min(24, prodNum(q.n) || (bucket === 'dia' ? 14 : bucket === 'mes' ? 6 : 8)));
    const actual = prodComputeOEE(d, cfg, centro, desde, hasta, incluirLimpieza);
    const tendencia = prodTrendBuckets(bucket, nBuckets, hasta).map(b => {
      const o = prodComputeOEE(d, cfg, centro, b.desde, b.hasta, incluirLimpieza);
      return { label: b.label, oee: o.oee, d: o.disponibilidad.valor, r: o.rendimiento.valor, c: o.calidad.valor };
    });
    res.json({
      centro, incluirLimpieza, bucket, desde: desde.toISOString(), hasta: hasta.toISOString(),
      ...actual, tendencia,
      paretoParadas: prodParetoParadas(d, centro, desde, hasta, incluirLimpieza),
      paretoCoccion: prodParetoCoccion(d, desde, hasta),
      leadPorEstilo: prodLeadPorEstilo(d, desde, hasta),
      barrilVsLata: prodBarrilVsLata(d, cfg, desde, hasta),
      mermaPorLote: prodMermaPorLote(d, desde, hasta),
      ocupacion: prodOcupacion(d, cfg, desde, hasta),
      complementarias: prodComplementarias(d, cfg, desde, hasta),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ═══ CONTROL DE CALIDAD (Fase 3) ═════════════════════════════════════════════
// Historial de calidad por cerveza (nombre de fantasía): competencias + medallas,
// retroalimentación y memorias (defectos). Todo enlazado por cervezaId (slug del
// nombre). Se conecta con el componente Calidad del OEE (las memorias son datos de
// calidad). Reutiliza el catálogo existente (Shopify + recetas) para los selectores.
const CALIDAD_FILE = join(PROMPTS_EFFECTIVE_DIR, 'calidad.json');
const CALIDAD_CATS = ['apariencia', 'sabor', 'sensacion_boca', 'aroma'];
const CALIDAD_RESULTADOS = ['oro', 'plata', 'bronce', 'sin_medalla'];
const prodSlug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const calUplOk = (u) => (/^\/uploads\/[\w.-]+$/.test(String(u || '')) ? String(u) : '');
function calidadDefaults(){
  // Competencias preconfiguradas (catálogo reusable). Las medallas PNG se cargan luego.
  return {
    competencias: [
      { id: 'comp_capital', nombre: 'Capital Cervecera', tipo: 'nacional', medallaOroPng: '', medallaPlataPng: '', medallaBroncePng: '' },
      { id: 'comp_conquistadores', nombre: 'Desafío Conquistadores', tipo: 'nacional', medallaOroPng: '', medallaPlataPng: '', medallaBroncePng: '' },
      { id: 'comp_wba', nombre: 'World Beer Awards', tipo: 'internacional', medallaOroPng: '', medallaPlataPng: '', medallaBroncePng: '' },
    ],
    registros: [], retros: [], memorias: [], cervezas: {}, resumenes: {},
  };
}
function calidadLoad(){
  let d = calidadDefaults();
  try {
    if (existsSync(CALIDAD_FILE)) {
      const p = JSON.parse(readFileSync(CALIDAD_FILE, 'utf-8'));
      if (Array.isArray(p.competencias)) d.competencias = p.competencias;
      for (const k of ['registros', 'retros', 'memorias']) if (Array.isArray(p[k])) d[k] = p[k];
      if (p.cervezas && typeof p.cervezas === 'object') d.cervezas = p.cervezas;
      if (p.resumenes && typeof p.resumenes === 'object') d.resumenes = p.resumenes;
    }
  } catch (e) { console.warn('calidad load:', e.message); }
  return d;
}
function calidadSave(d){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(CALIDAD_FILE, JSON.stringify(d, null, 2)); }
function calidadCleanResumen(x){ x = x || {}; const s = (v) => prodStr(v, 800); return { apariencia: s(x.apariencia), aroma: s(x.aroma), sabor: s(x.sabor), sensacionBoca: s(x.sensacionBoca), conclusion: s(x.conclusion) }; }
// Catálogo fijo de Calidad: los únicos productos que Producción elabora hoy.
// Es la fuente de verdad (ya no se arma matcheando texto contra Shopify, que
// daba falsos positivos/negativos) — nombre/estilo/imagen se editan desde
// Competencias → "Agregar cerveza", que también sirve para sumar productos
// nuevos el día que se necesite.
// shopifyTitle: título EXACTO del producto en Shopify (mapeo explícito hecho a
// mano — no es matching automático/difuso, que ya se probó y se descartó por
// falsos positivos/negativos). Se usa solo para traer la imagen real y el link
// a la ficha del producto; si no matchea o Shopify no está disponible, no
// rompe nada — sigue funcionando con la imagen manual como hasta ahora.
const PROD_CALIDAD_SEED = [
  { nombre: 'Nada Personal', estilo: 'Pils', shopifyTitle: 'Nada Personal Pils - Lata 473cc' },
  { nombre: 'Galactic Mission', estilo: 'Golden', shopifyTitle: 'Galactic Golden - Lata 473cc' },
  { nombre: 'Alerta Roja', estilo: 'Red', shopifyTitle: 'Alerta Roja Red ALE - Lata 473cc' },
  { nombre: 'Secret Lab', estilo: 'APA', shopifyTitle: 'Secret Lab APA - Lata 473cc' },
  { nombre: 'Imperio Perdido', estilo: 'Session NEIPA', shopifyTitle: 'Imperio Perdido NEIPA - Lata 473cc' },
  { nombre: 'Obertura', estilo: 'Stout', shopifyTitle: '473cc Mayorista Obertura (Stout)' },
  { nombre: 'Kenny Bell', estilo: 'Amber', shopifyTitle: '473cc Mayorista Kenny Bell (American Amber Ale)' },
  { nombre: 'Hoyo en Uno', estilo: 'Hoppy Lager', shopifyTitle: '473cc Mayorista Hoyo en uno (Hoppy Lager)' },
  { nombre: 'Samba', estilo: 'IPA', shopifyTitle: '473cc Mayorista Samba (IPA)' },
  { nombre: 'Ritual de la Banana', estilo: 'Weizen', shopifyTitle: '473cc Mayorista Ritual De La Banana (Weizen)' },
  { nombre: 'Goodbye My Lover', estilo: 'Colección de Artista', shopifyTitle: '(LATA cm3) Good Bye My Lover' },
  { nombre: 'Goat Father', estilo: 'Colección de Artista', shopifyTitle: '(Lata cm3) Goatfather' },
  { nombre: 'Gin Banny Contemporáneo', estilo: 'Gin' },
  { nombre: 'Gin Banny London Dry', estilo: 'Gin' },
  { nombre: 'Rey de Copas Carta Blanca', estilo: 'Ron' },
];
const shopifyProductUrl = (handle) => `https://${(process.env.SHOPIFY_STORE_DOMAIN || 'kairos-brewing.myshopify.com').trim()}/products/${handle}`;
// Catálogo de cervezas: parte del listado fijo (PROD_CALIDAD_SEED) + overrides
// manuales (nombre/estilo/imagen — incluye altas nuevas vía "Agregar cerveza")
// + enriquecido best-effort con recetas/historial (sin sumar productos nuevos
// desde ahí). Clave = slug del nombre.
async function prodCatalogoCervezas(cd){
  const map = new Map();
  const add = (nombre, estilo, imagen, crearSiNoExiste, shopifyTitle) => {
    const id = prodSlug(nombre); if (!id) return;
    const ex = map.get(id);
    if (!ex) { if (!crearSiNoExiste) return; map.set(id, { cervezaId: id, nombre, estilo: estilo || '', imagen: imagen || '', shopifyTitle: shopifyTitle || '', origen: 'manual' }); return; }
    if (!ex.nombre) ex.nombre = nombre;
    if (estilo && !ex.estilo) ex.estilo = estilo;
    if (imagen && !ex.imagen) ex.imagen = imagen;
    if (shopifyTitle && !ex.shopifyTitle) ex.shopifyTitle = shopifyTitle;
  };
  for (const s of PROD_CALIDAD_SEED) add(s.nombre, s.estilo, '', true, s.shopifyTitle);
  const pd = prodLoad();
  for (const r of (pd.recetas || [])) add(r.nombre, r.estilo, '', false); // solo enriquece, no suma productos
  for (const arr of [cd.registros, cd.retros, cd.memorias]) for (const x of (arr || [])) add((cd.cervezas[x.cervezaId] && cd.cervezas[x.cervezaId].nombre) || x.cervezaNombre || x.cervezaId, x.estilo, '', false);
  for (const [id, ov] of Object.entries(cd.cervezas || {})) { const ex = map.get(id) || { cervezaId: id, nombre: ov.nombre || id, estilo: '', imagen: '', shopifyTitle: '', origen: 'manual' }; if (ov.nombre) ex.nombre = ov.nombre; if (ov.estilo) ex.estilo = ov.estilo; if (ov.imagen) ex.imagen = ov.imagen; if (ov.shopifyTitle != null) ex.shopifyTitle = ov.shopifyTitle; map.set(id, ex); }
  // Enriquecimiento best-effort con Shopify: solo para cervezas con shopifyTitle
  // configurado (mapeo explícito, no matching difuso). Si Shopify no responde o
  // el título no matchea, no rompe nada — sigue con la imagen manual/placeholder.
  try {
    const prods = await loadProductsCache();
    if (prods && prods.length) {
      const byTitle = new Map(prods.map(p => [String(p.title || '').trim().toLowerCase(), p]));
      for (const ex of map.values()) {
        if (!ex.shopifyTitle) continue;
        const p = byTitle.get(ex.shopifyTitle.trim().toLowerCase());
        if (!p) continue;
        if (!ex.imagen && p.image) ex.imagen = p.image;
        if (p.handle) ex.shopifyUrl = shopifyProductUrl(p.handle);
      }
    }
  } catch (e) { /* Shopify no disponible: se sigue con imagen manual/placeholder */ }
  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}
// Resumen consolidado + semáforo por cerveza. Regla del estado:
//  · sólida       → tiene medallas y sin defectos recientes (≤180 d)
//  · debe_mejorar → defectos recurrentes (≥2 en una categoría) o ≥2 defectos recientes
//  · a_observar   → intermedio
function calidadResumenCerveza(cd, cervezaId){
  const regs = cd.registros.filter(r => r.cervezaId === cervezaId);
  const retros = cd.retros.filter(r => r.cervezaId === cervezaId);
  const mems = cd.memorias.filter(m => m.cervezaId === cervezaId);
  const medallas = regs.filter(r => r.resultado && r.resultado !== 'sin_medalla').map(r => ({ resultado: r.resultado, competencia: r.competenciaNombre, fecha: r.fecha }));
  const now = Date.now(), RECIENTE = 180 * DAY_MS;
  const memsRec = mems.filter(m => { const t = new Date(m.fecha).getTime(); return Number.isFinite(t) && (now - t) < RECIENTE; });
  const catCount = {}; mems.forEach(m => { catCount[m.categoria] = (catCount[m.categoria] || 0) + 1; });
  const recurrente = Object.values(catCount).some(n => n >= 2);
  let estado;
  if (recurrente || memsRec.length >= 2) estado = 'debe_mejorar';
  else if (medallas.length && !memsRec.length) estado = 'solida';
  else estado = 'a_observar';
  return { cervezaId, medallas, nMedallas: medallas.length, nRetros: retros.length, nMemorias: mems.length, memsRecientes: memsRec.length, recurrente, catConteo: catCount, estado, resumenIA: cd.resumenes[cervezaId] || null };
}
// GET del módulo completo (galería + catálogo + historiales).
app.get('/admin/produccion/calidad', requireAdmin, async (req, res) => {
  try {
    const cd = calidadLoad();
    const cervezas = await prodCatalogoCervezas(cd);
    const resumenes = {}; for (const c of cervezas) resumenes[c.cervezaId] = calidadResumenCerveza(cd, c.cervezaId);
    res.json({ cervezas, competencias: cd.competencias, registros: cd.registros, retros: cd.retros, memorias: cd.memorias, resumenes, meta: { categorias: CALIDAD_CATS, resultados: CALIDAD_RESULTADOS } });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Subida de archivos de calidad (PDF de feedback, PNG de medallas, imagen de memoria).
app.post('/admin/produccion/calidad/upload', requireAdmin, (req, res) => {
  const { filename = '', contentType = '', dataBase64 = '' } = req.body || {};
  if (typeof dataBase64 !== 'string' || !dataBase64) return res.status(400).json({ error: 'Falta el archivo.' });
  const ext = UPLOAD_TYPES[String(contentType).toLowerCase()];
  if (!ext) return res.status(415).json({ error: 'Tipo no permitido (PDF, PNG, JPG, WEBP, GIF).' });
  let buf; try { buf = Buffer.from(dataBase64, 'base64'); } catch { return res.status(400).json({ error: 'Archivo inválido.' }); }
  if (!buf.length) return res.status(400).json({ error: 'Archivo vacío.' });
  if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'Máximo 8 MB por archivo.' });
  try { const safeName = randomUUID() + '.' + ext; writeFileSync(join(UPLOADS_DIR, safeName), buf); res.json({ ok: true, url: '/uploads/' + safeName, name: String(filename || ('archivo.' + ext)).slice(0, 200), ext }); }
  catch (e) { res.status(500).json({ error: 'Error guardando archivo: ' + e.message }); }
});
// Catálogo de competencias (reusable). Crear / editar (medallas PNG) / borrar.
app.post('/admin/produccion/calidad/competencia', requireAdmin, (req, res) => {
  const b = req.body || {}; const cd = calidadLoad();
  const nombre = prodStr(b.nombre, 120); if (!nombre) return res.status(400).json({ error: 'Ingresá el nombre de la competencia.' });
  const c = { id: prodNewId('comp'), nombre, tipo: b.tipo === 'internacional' ? 'internacional' : 'nacional', medallaOroPng: calUplOk(b.medallaOroPng), medallaPlataPng: calUplOk(b.medallaPlataPng), medallaBroncePng: calUplOk(b.medallaBroncePng) };
  cd.competencias.push(c); calidadSave(cd); res.json({ ok: true, competencia: c });
});
app.put('/admin/produccion/calidad/competencia/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const c = cd.competencias.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Competencia no encontrada.' });
  const b = req.body || {}; if (b.nombre != null) c.nombre = prodStr(b.nombre, 120); if (b.tipo != null) c.tipo = b.tipo === 'internacional' ? 'internacional' : 'nacional';
  for (const k of ['medallaOroPng', 'medallaPlataPng', 'medallaBroncePng']) if (b[k] != null) c[k] = calUplOk(b[k]);
  calidadSave(cd); res.json({ ok: true, competencia: c });
});
app.delete('/admin/produccion/calidad/competencia/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const n = cd.competencias.length; cd.competencias = cd.competencias.filter(x => x.id !== req.params.id);
  if (cd.competencias.length === n) return res.status(404).json({ error: 'No encontrada.' }); calidadSave(cd); res.json({ ok: true });
});
// IA — resumen estructurado del feedback (PDFs) con las 5 categorías fijas.
app.post('/admin/produccion/calidad/resumir', requireAdmin, async (req, res) => {
  const b = req.body || {}; const pdfs = (Array.isArray(b.pdfs) ? b.pdfs : []).filter(f => calUplOk(f && f.url)).slice(0, 5);
  if (!pdfs.length) return res.status(400).json({ error: 'No hay PDFs para resumir. Podés escribir el resumen a mano.' });
  try {
    const docs = [];
    for (const f of pdfs) { const p = join(UPLOADS_DIR, f.url.replace('/uploads/', '')); if (existsSync(p)) docs.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: readFileSync(p).toString('base64') } }); }
    if (!docs.length) return res.status(400).json({ error: 'No pude leer los PDFs.' });
    const sys = 'Sos un juez cervecero experto (BJCP). Te paso el feedback de una competencia. Resumilo en JSON con EXACTAMENTE estas claves y en español, cada una 1-2 frases concretas:\n' +
      '- "apariencia": color, claridad/turbidez, espuma.\n- "aroma": malta, lúpulo, fermentación (levadura) y/o defectos.\n- "sabor": equilibrio, amargor, perfil de fermentación.\n- "sensacionBoca": cuerpo, carbonatación, astringencia / sensación alcohólica.\n- "conclusion": en 1-2 frases, si la cerveza debe mejorar y en qué específicamente.\n' +
      'Respondé SOLO el JSON, sin texto adicional ni markdown.';
    const msg = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1200, system: sys, messages: [{ role: 'user', content: [...docs, { type: 'text', text: 'Resumí el feedback de estos PDFs en el JSON pedido.' }] }] });
    let txt = (msg.content || []).map(c => c.text || '').join('').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed = {}; try { parsed = JSON.parse(txt); } catch { const m = /\{[\s\S]*\}/.exec(txt); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    res.json({ ok: true, resumenIA: calidadCleanResumen(parsed) });
  } catch (e) { res.status(502).json({ error: 'IA no disponible: ' + String(e.message || e).slice(0, 160) }); }
});
// Resumen consolidado de la galería con IA (2-3 líneas). Cachea en cd.resumenes.
app.post('/admin/produccion/calidad/resumen/:cervezaId', requireAdmin, async (req, res) => {
  const cd = calidadLoad(); const cid = req.params.cervezaId;
  const r = calidadResumenCerveza(cd, cid);
  const cerv = cd.cervezas[cid] || {};
  // Si nunca se editó a mano, el nombre de fantasía viene del catálogo fijo
  // (evita mandarle a la IA el slug, ej. "nada-personal", como si fuera nombre).
  const seedNombre = (PROD_CALIDAD_SEED.find(s => prodSlug(s.nombre) === cid) || {}).nombre;
  const nombre = cerv.nombre || seedNombre || cid;
  const regs = cd.registros.filter(x => x.cervezaId === cid).slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const mems = cd.memorias.filter(x => x.cervezaId === cid);
  const retros = cd.retros.filter(x => x.cervezaId === cid);
  try {
    const ctx = { cerveza: nombre, medallas: r.medallas, defectosPorCategoria: r.catConteo, memorias: mems.map(m => ({ categoria: m.categoria, texto: m.texto, fecha: m.fecha })), retros: retros.map(x => ({ texto: x.texto, fecha: x.fecha })), evaluacionesSensoriales: regs.map(x => ({ competencia: x.competenciaNombre, resultado: x.resultado, fecha: x.fecha, ...x.resumenIA })) };
    const sys = 'Sos el maestro cervecero. En español, escribí UN PÁRRAFO (5-8 frases) que resuma la EVOLUCIÓN de las evaluaciones sensoriales de esta cerveza a través del tiempo, usando "evaluacionesSensoriales" (cada una trae apariencia/aroma/sabor/sensacionBoca/conclusion + fecha + resultado de esa participación, están ordenadas de la más reciente a la más antigua). Recorré cómo fue cambiando (mejoras, defectos que se repiten o se corrigieron), mencionando las competencias/medallas relevantes de "medallas" donde corresponda, y CERRÁ el párrafo poniendo el foco específicamente en la evaluación MÁS RECIENTE (la primera de la lista): cómo está la cerveza hoy. Si solo hay una evaluación, describí esa nomás, sin inventar evolución. Si no hay ninguna evaluación sensorial, decilo brevemente y no inventes datos. Tono de juez cervecero (BJCP), directo, sin relleno ni frases genéricas.';
    const msg = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 700, system: sys, messages: [{ role: 'user', content: 'Datos de la cerveza (JSON):\n' + JSON.stringify(ctx).slice(0, 8000) }] });
    const texto = (msg.content || []).map(c => c.text || '').join('').trim();
    cd.resumenes[cid] = { texto, generadoEn: new Date().toISOString() }; calidadSave(cd);
    res.json({ ok: true, resumen: cd.resumenes[cid] });
  } catch (e) { res.status(502).json({ error: 'IA no disponible: ' + String(e.message || e).slice(0, 160) }); }
});
// Registro de competencia (participación de una cerveza).
app.post('/admin/produccion/calidad/registro', requireAdmin, (req, res) => {
  const b = req.body || {}; const cd = calidadLoad();
  const cervezaNombre = prodStr(b.cervezaNombre, 120); const cervezaId = prodStr(b.cervezaId, 80) || prodSlug(cervezaNombre);
  if (!cervezaId) return res.status(400).json({ error: 'Elegí la cerveza evaluada.' });
  const comp = cd.competencias.find(c => c.id === prodStr(b.competenciaId, 80));
  const reg = {
    id: prodNewId('rc'), cervezaId, cervezaNombre: cervezaNombre || cervezaId, estilo: prodStr(b.estilo, 80),
    competenciaId: comp ? comp.id : '', competenciaNombre: comp ? comp.nombre : prodStr(b.competenciaNombre, 120),
    tipo: b.tipo === 'internacional' ? 'internacional' : (b.tipo === 'nacional' ? 'nacional' : (comp ? comp.tipo : 'nacional')),
    fecha: prodTs(b.fecha) || new Date().toISOString(),
    resultado: CALIDAD_RESULTADOS.includes(b.resultado) ? b.resultado : 'sin_medalla',
    pdfs: (Array.isArray(b.pdfs) ? b.pdfs : []).slice(0, 5).map(f => ({ url: calUplOk(f && f.url), name: prodStr(f && f.name, 200) })).filter(f => f.url),
    resumenIA: calidadCleanResumen(b.resumenIA), resumenEditable: !!b.resumenEditable,
  };
  cd.registros.push(reg); calidadSave(cd); res.json({ ok: true, registro: reg });
});
app.put('/admin/produccion/calidad/registro/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const r = cd.registros.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Registro no encontrado.' });
  const b = req.body || {}; if (b.resultado != null && CALIDAD_RESULTADOS.includes(b.resultado)) r.resultado = b.resultado;
  if (b.fecha !== undefined) r.fecha = prodTs(b.fecha) || r.fecha;
  if (b.resumenIA != null) { r.resumenIA = calidadCleanResumen(b.resumenIA); r.resumenEditable = true; }
  calidadSave(cd); res.json({ ok: true, registro: r });
});
app.delete('/admin/produccion/calidad/registro/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const n = cd.registros.length; cd.registros = cd.registros.filter(x => x.id !== req.params.id);
  if (cd.registros.length === n) return res.status(404).json({ error: 'No encontrado.' }); calidadSave(cd); res.json({ ok: true });
});
// Retroalimentación (texto ≤500).
app.post('/admin/produccion/calidad/retro', requireAdmin, (req, res) => {
  const b = req.body || {}; const cd = calidadLoad();
  const cervezaNombre = prodStr(b.cervezaNombre, 120); const cervezaId = prodStr(b.cervezaId, 80) || prodSlug(cervezaNombre);
  const autor = prodStr(b.autor, 120), texto = prodStr(b.texto, 500);
  if (!cervezaId) return res.status(400).json({ error: 'Elegí la cerveza.' });
  if (!autor) return res.status(400).json({ error: 'Ingresá quién deja la retroalimentación.' });
  if (!texto) return res.status(400).json({ error: 'Escribí la retroalimentación.' });
  const r = { id: prodNewId('fb'), cervezaId, cervezaNombre: cervezaNombre || cervezaId, estilo: prodStr(b.estilo, 80), autor, texto, fecha: new Date().toISOString() };
  cd.retros.push(r); calidadSave(cd); res.json({ ok: true, retro: r });
});
app.delete('/admin/produccion/calidad/retro/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const n = cd.retros.length; cd.retros = cd.retros.filter(x => x.id !== req.params.id);
  if (cd.retros.length === n) return res.status(404).json({ error: 'No encontrada.' }); calidadSave(cd); res.json({ ok: true });
});
// Memoria (defecto/problema — dato de calidad).
app.post('/admin/produccion/calidad/memoria', requireAdmin, (req, res) => {
  const b = req.body || {}; const cd = calidadLoad();
  const cervezaNombre = prodStr(b.cervezaNombre, 120); const cervezaId = prodStr(b.cervezaId, 80) || prodSlug(cervezaNombre);
  const texto = prodStr(b.texto, 500);
  if (!cervezaId) return res.status(400).json({ error: 'Elegí la cerveza.' });
  if (!texto) return res.status(400).json({ error: 'Describí el problema.' });
  const m = {
    id: prodNewId('mem'), cervezaId, cervezaNombre: cervezaNombre || cervezaId, estilo: prodStr(b.estilo, 80),
    ubicacion: prodStr(b.ubicacion, 120), canalVenta: prodStr(b.canalVenta, 120),
    categoria: CALIDAD_CATS.includes(b.categoria) ? b.categoria : 'sabor', texto,
    imagen: (b.imagen && calUplOk(b.imagen.url)) ? { url: calUplOk(b.imagen.url), name: prodStr(b.imagen.name, 200) } : null,
    fecha: new Date().toISOString(),
  };
  cd.memorias.push(m); calidadSave(cd); res.json({ ok: true, memoria: m });
});
app.delete('/admin/produccion/calidad/memoria/:id', requireAdmin, (req, res) => {
  const cd = calidadLoad(); const n = cd.memorias.length; cd.memorias = cd.memorias.filter(x => x.id !== req.params.id);
  if (cd.memorias.length === n) return res.status(404).json({ error: 'No encontrada.' }); calidadSave(cd); res.json({ ok: true });
});
// Cerveza: override/alta manual (estilo + imagen de lata) para el catálogo.
app.post('/admin/produccion/calidad/cerveza', requireAdmin, (req, res) => {
  const b = req.body || {}; const cd = calidadLoad();
  const nombre = prodStr(b.nombre, 120); const cervezaId = prodStr(b.cervezaId, 80) || prodSlug(nombre);
  if (!cervezaId) return res.status(400).json({ error: 'Ingresá el nombre de la cerveza.' });
  const ov = cd.cervezas[cervezaId] || {};
  if (nombre) ov.nombre = nombre; if (b.estilo != null) ov.estilo = prodStr(b.estilo, 80); if (b.imagen != null) ov.imagen = calUplOk(b.imagen && b.imagen.url ? b.imagen.url : b.imagen);
  if (b.shopifyTitle != null) ov.shopifyTitle = prodStr(b.shopifyTitle, 200);
  cd.cervezas[cervezaId] = ov; calidadSave(cd); res.json({ ok: true, cervezaId, cerveza: ov });
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

// ─── Pack Mundialero (planilla en /admin → "Mundial") ───────────────────────
// Cada compra que incluye un pack mundialero queda lista en una tabla tipo
// Excel: nombre, contacto y las predicciones (1er/2do/3er lugar + goleador) que
// el cliente llenó al comprar. Se lee EN VIVO desde las órdenes de Shopify, así
// cualquier persona nueva que compre se agrega sola en la próxima carga.

function isMundialLine(li){
  return /mundial/i.test(li.title || '');
}

// Saca de la nota el ruido de la boleta electrónica / iDTE (lo escribe la app de
// facturación) y deja solo lo útil del Mundial (ej. el detalle de cervezas).
function cleanMundialNote(note){
  if (!note) return '';
  let s = String(note);
  s = s.replace(/https?:\/\/\S+/gi, '');                 // cualquier URL (iDTE, Flapp, etc.)
  s = s.replace(/iDTE\s*Boleta\s*Nro:?\s*\d+/gi, '');
  s = s.replace(/Boleta\s*\d+\s*Generada\s*Correctamente/gi, '');
  s = s.replace(/Fecha\s*documento:?\s*[\d/.\-]+/gi, '');
  s = s.replace(/Etiqueta\s*Flapp:?/gi, '');
  return s.split('·')
    .map(x => x.replace(/^[\s:.\-]+|[\s:.\-]+$/g, '').trim())
    .filter(x => /[a-z0-9]/i.test(x))
    .join(' · ');
}

// Clave normalizada (sin tildes, sin signos) para matchear atributos flexibles.
function normAttrKey(k){
  return String(k || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Extrae las 4 predicciones desde los atributos/propiedades del pedido. No
// sabemos los nombres EXACTOS de los campos del pack mundialero, así que
// matcheamos por palabras clave. Lo que no calce en ninguna de las 4 columnas
// se devuelve en `extra` para no perder nada de lo que el cliente escribió.
function extractMundialPicks(attrs){
  const list = (attrs || []).filter(a => String(a.value || '').trim() && !/^_/.test(String(a.key||'')));
  const used = new Set();
  const pick = (re) => {
    const idx = list.findIndex((a, i) => !used.has(i) && re.test(normAttrKey(a.key)));
    if (idx < 0) return '';
    used.add(idx);
    return String(list[idx].value).trim();
  };
  const picks = {
    primero:  pick(/\b(primer|1er|1ro|campeon|oro|ganador|first|champion)\b/),
    segundo:  pick(/\b(segundo|2do|2da|subcampeon|plata|finalista|second)\b/),
    tercero:  pick(/\b(tercer|3er|3ro|bronce|third)\b/),
    goleador: pick(/(golead|scorer|goal|pichichi|max\s*gol|bota)/),
  };
  const extra = list
    .filter((_, i) => !used.has(i))
    .map(a => `${a.key}: ${String(a.value).trim()}`)
    .join(' · ');
  return { ...picks, extra };
}

app.get('/admin/mundial', requireAdmin, async (req, res) => {
  const result = await loadOrders(String(req.query.refresh || '') === '1');
  if (!result.available) {
    return res.json({ available: false, reason: result.reason });
  }
  const rows = [];
  for (const o of result.orders) {
    const mundialLines = (o.lineItems || []).filter(isMundialLine);
    if (!mundialLines.length) continue;
    const nombre = [o.customerFirstName, o.customerLastName].filter(Boolean).join(' ').trim();
    // Una fila POR pack. Si alguien compra 2 packs con predicciones distintas,
    // Shopify los guarda como 2 líneas separadas (cada una con sus propiedades),
    // así que cada una queda en su propia fila.
    const soloUna = mundialLines.length === 1;
    for (const li of mundialLines) {
      // Predicciones de la línea; si la línea no trae propiedades y es el único
      // pack del pedido, caemos a los atributos/nota a nivel orden.
      const attrs = (li.properties && li.properties.length)
        ? li.properties
        : (soloUna ? (o.attributes || []) : []);
      const picks = extractMundialPicks(attrs);
      const nota = [cleanMundialNote(o.note), picks.extra || ''].filter(Boolean).join(' · ');
      const refProp = (li.properties || []).find(p => /^_?zorbo_ref$/i.test(p.key || ''));
      rows.push({
        order: o.name || '',
        date: o.createdAt,
        nombre,
        email: o.customerEmail || '',
        telefono: o.customerPhone || '',
        ref: refProp ? String(refProp.value || '').trim() : '',
        pack: (li.title || '') + (li.qty > 1 ? ` (x${li.qty})` : ''),
        primero: picks.primero,
        segundo: picks.segundo,
        tercero: picks.tercero,
        goleador: picks.goleador,
        nota,
        fromBackup: false,
      });
    }
  }

  // Fusión con el BACKUP server-side: si un pedido perdió las predicciones (iDTE
  // pisó los atributos), las recuperamos del backup matcheando por email y el
  // pedido más cercano en el tiempo (consumiendo un backup por pack).
  const backups = [...loadMundialBackups(), ...loadMundialRecovery()];
  const byRef = new Map();   // match exacto por referencia oculta (no requiere email)
  const byOrder = new Map(); // match exacto por número de pedido (recuperación)
  const byEmail = new Map();
  for (const b of backups) {
    if (b.ref) byRef.set(String(b.ref), b);
    if (b.order) {
      const k = String(b.order).trim();
      if (!byOrder.has(k)) byOrder.set(k, []);
      byOrder.get(k).push(b);
    }
    const e = normEmail(b.email);
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(b);
  }
  const usedByOrder = new Map();
  const takeByOrder = (orderName) => {
    const list = byOrder.get(String(orderName || '').trim());
    if (!list || !list.length) return null;
    const used = usedByOrder.get(orderName) || new Set();
    usedByOrder.set(orderName, used);
    const idx = list.findIndex((_, i) => !used.has(i));
    if (idx < 0) return null;
    used.add(idx);
    return list[idx];
  };
  const usedByEmail = new Map();
  const takeBackup = (email, orderDate) => {
    const list = byEmail.get(email);
    if (!list || !list.length) return null;
    const used = usedByEmail.get(email) || new Set();
    usedByEmail.set(email, used);
    let best = -1, bestDelta = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(new Date(list[i].createdAt) - new Date(orderDate));
      if (d < bestDelta) { bestDelta = d; best = i; }
    }
    if (best < 0) return null;
    used.add(best);
    return list[best];
  };
  const usedRefs = new Set();
  let recovered = 0;
  // Aplica un backup: sólo PISA los campos que el backup trae no vacíos, así un
  // registro parcial (ej. sólo goleador) corrige ese campo y deja el resto.
  const applyBackup = (row, bk) => {
    if (bk.primero)  row.primero = bk.primero;
    if (bk.segundo)  row.segundo = bk.segundo;
    if (bk.tercero)  row.tercero = bk.tercero;
    if (bk.goleador) row.goleador = bk.goleador;
    const packTxt = packToText(bk.pack);
    if (packTxt) row.nota = [row.nota, packTxt].filter(Boolean).join(' · ');
    if (bk.nombre && !row.nombre) row.nombre = bk.nombre;
    if (bk.telefono && !row.telefono) row.telefono = bk.telefono;
    row.fromBackup = true;
    if (row.primero || row.segundo || row.tercero || row.goleador) recovered++;
  };
  // Paso 1 — match EXACTO (referencia oculta o número de pedido): la
  // recuperación/backup es la fuente de verdad y PISA lo que venga de Shopify.
  for (const row of rows) {
    if (row.ref && byRef.has(row.ref) && !usedRefs.has(row.ref)) {
      usedRefs.add(row.ref);
      applyBackup(row, byRef.get(row.ref));
      continue;
    }
    const bkO = takeByOrder(row.order);
    if (bkO) applyBackup(row, bkO);
  }
  // Paso 2 — sólo los que quedaron SIN predicciones: rellenar por email.
  for (const row of rows) {
    if (row.fromBackup) continue;
    const empty = !row.primero && !row.segundo && !row.tercero && !row.goleador;
    if (!empty) continue;
    const bk = takeBackup(normEmail(row.email), row.date);
    if (bk) applyBackup(row, bk);
  }

  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ available: true, count: rows.length, recovered, backups: backups.length, rows });
});

// ─── Distribuidora / Proveedores ────────────────────────────────────────────
// Zorbo también opera como distribuidora: le COMPRA a marcas (propias y de
// terceros) y revende a locales. Shopify registra el sell-out (ventas) pero NO
// lo que Zorbo le compra a los proveedores ni los costos. Toda esa data se carga
// manual acá y se persiste en distribuidora.json (en el volumen DATA_DIR).
const DISTRI_FILE = join(PROMPTS_EFFECTIVE_DIR, 'distribuidora.json');

// Categorías canónicas → definen el margen. label para la UI.
const DISTRI_CATEGORIES = [
  { key: 'cerveza',     label: 'Cerveza' },
  { key: 'licores',     label: 'Licores' },
  { key: 'rtd',         label: 'RTD (ready to drink)' },
  { key: 'funcionales', label: 'Bebidas y funcionales' },
];
const DISTRI_DEFAULT_MARGINS = { cerveza: 25, licores: 40, rtd: 30, funcionales: 30 };

// Marcas conocidas para sembrar la primera vez (propias + terceros actuales).
const DISTRI_SEED_SUPPLIERS = [
  { name: 'Kairos Brewing',       type: 'propia',  category: 'cerveza'     },
  { name: 'Firulais',             type: 'propia',  category: 'rtd'         },
  { name: 'Banny',                type: 'propia',  category: 'licores'     },
  { name: 'Kombucha Biloba',      type: 'tercero', category: 'funcionales' },
  { name: 'Cervecería del Puerto',type: 'tercero', category: 'cerveza'     },
  { name: 'Destilería Zunda',     type: 'tercero', category: 'licores'     },
];

function distriDefaults(){
  const now = new Date().toISOString();
  return {
    version: 1,
    suppliers: DISTRI_SEED_SUPPLIERS.map(s => ({
      id: randomUUID(),
      name: s.name,
      type: s.type,
      category: s.category,
      contactName: '', email: '', phone: '', address: '',
      notes: '',
      createdAt: now, updatedAt: now,
    })),
    margins: { ...DISTRI_DEFAULT_MARGINS },
    productCosts: {},   // productId → { cost, category, dispatch, updatedAt }
    purchaseOrders: [], // { id, supplierId, supplierName, date, status, items:[], total, notes, ... }
    salesPoints: [],    // puntos de venta cargados a mano (locales) → { id, name, country, region, city, address, number, phone, email, customerId, lat, lng, createdAt }
  };
}

function loadDistri(){
  try {
    if (!existsSync(DISTRI_FILE)) {
      const seeded = distriDefaults();
      saveDistri(seeded);
      return seeded;
    }
    const parsed = JSON.parse(readFileSync(DISTRI_FILE, 'utf-8'));
    // normaliza estructura por si falta alguna llave
    return {
      version: 1,
      suppliers: Array.isArray(parsed.suppliers) ? parsed.suppliers : [],
      margins: { ...DISTRI_DEFAULT_MARGINS, ...(parsed.margins || {}) },
      productCosts: (parsed.productCosts && typeof parsed.productCosts === 'object') ? parsed.productCosts : {},
      purchaseOrders: Array.isArray(parsed.purchaseOrders) ? parsed.purchaseOrders : [],
      salesPoints: Array.isArray(parsed.salesPoints) ? parsed.salesPoints : [],
    };
  } catch (e) {
    console.warn('distribuidora load:', e.message);
    return distriDefaults();
  }
}
function saveDistri(data){
  if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) {
    mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
  }
  writeFileSync(DISTRI_FILE, JSON.stringify(data, null, 2));
}

function isDistriCategory(k){ return DISTRI_CATEGORIES.some(c => c.key === k); }
const distriStr = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);

// Estado completo del módulo (config). Las tablas que derivan de productos
// Shopify (costos, inventario, comercialización) usan /admin/distribuidora/products.
function sanitizeSupplier(s){
  const { portal, ...rest } = s;
  return { ...rest, portalUser: portal?.user || '', hasAccess: !!(portal && portal.user) };
}
app.get('/admin/distribuidora', requireAdmin, (_req, res) => {
  const d = loadDistri();
  res.json({ ...d, suppliers: d.suppliers.map(sanitizeSupplier), categories: DISTRI_CATEGORIES });
});

// ── Proveedores (CRUD) ──
app.post('/admin/distribuidora/suppliers', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = distriStr(b.name, 120);
  if (!name) return res.status(400).json({ error: 'El nombre de la marca es obligatorio.' });
  const type = b.type === 'tercero' ? 'tercero' : 'propia';
  const category = isDistriCategory(b.category) ? b.category : 'cerveza';
  const now = new Date().toISOString();
  const supplier = {
    id: randomUUID(),
    name, type, category,
    contactName: distriStr(b.contactName, 120),
    email: distriStr(b.email, 160),
    phone: distriStr(b.phone, 60),
    address: distriStr(b.address, 240),
    // Datos para la orden de compra (se autocompletan al elegir el proveedor).
    razonSocial: distriStr(b.razonSocial, 160),
    nombreFantasia: distriStr(b.nombreFantasia, 160),
    rut: distriStr(b.rut, 40),
    ciudad: distriStr(b.ciudad, 80),
    banco: distriStr(b.banco, 80),
    tipoCuenta: distriStr(b.tipoCuenta, 60),
    nroCuenta: distriStr(b.nroCuenta, 60),
    condicionesPago: distriStr(b.condicionesPago, 80),
    notes: distriStr(b.notes, 2000),
    createdAt: now, updatedAt: now,
  };
  const d = loadDistri();
  d.suppliers.push(supplier);
  saveDistri(d);
  res.json({ ok: true, supplier });
});

app.put('/admin/distribuidora/suppliers/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const b = req.body || {};
  const d = loadDistri();
  const s = d.suppliers.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  if (b.name !== undefined) { const n = distriStr(b.name, 120); if (!n) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' }); s.name = n; }
  if (b.type !== undefined) s.type = b.type === 'tercero' ? 'tercero' : 'propia';
  if (b.category !== undefined && isDistriCategory(b.category)) s.category = b.category;
  if (b.contactName !== undefined) s.contactName = distriStr(b.contactName, 120);
  if (b.email !== undefined) s.email = distriStr(b.email, 160);
  if (b.phone !== undefined) s.phone = distriStr(b.phone, 60);
  if (b.address !== undefined) s.address = distriStr(b.address, 240);
  if (b.razonSocial !== undefined) s.razonSocial = distriStr(b.razonSocial, 160);
  if (b.nombreFantasia !== undefined) s.nombreFantasia = distriStr(b.nombreFantasia, 160);
  if (b.rut !== undefined) s.rut = distriStr(b.rut, 40);
  if (b.ciudad !== undefined) s.ciudad = distriStr(b.ciudad, 80);
  if (b.banco !== undefined) s.banco = distriStr(b.banco, 80);
  if (b.tipoCuenta !== undefined) s.tipoCuenta = distriStr(b.tipoCuenta, 60);
  if (b.nroCuenta !== undefined) s.nroCuenta = distriStr(b.nroCuenta, 60);
  if (b.condicionesPago !== undefined) s.condicionesPago = distriStr(b.condicionesPago, 80);
  if (b.notes !== undefined) s.notes = distriStr(b.notes, 2000);
  s.updatedAt = new Date().toISOString();
  saveDistri(d);
  res.json({ ok: true, supplier: s });
});

app.delete('/admin/distribuidora/suppliers/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const d = loadDistri();
  const before = d.suppliers.length;
  d.suppliers = d.suppliers.filter(x => x.id !== id);
  if (d.suppliers.length === before) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  saveDistri(d);
  res.json({ ok: true });
});

// ── Acceso al PORTAL del proveedor (credenciales que asigna el admin) ──
// Guardamos la contraseña hasheada (scrypt + salt), nunca en claro.
function hashPortalPassword(password, salt){
  return scryptSync(String(password), salt, 32).toString('hex');
}
app.put('/admin/distribuidora/suppliers/:id/portal', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const b = req.body || {};
  const user = distriStr(b.user, 60).toLowerCase();
  const password = String(b.password == null ? '' : b.password);
  const d = loadDistri();
  const s = d.suppliers.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  if (!user) return res.status(400).json({ error: 'El usuario es obligatorio.' });
  if (!/^[a-z0-9._-]{3,60}$/.test(user)) return res.status(400).json({ error: 'Usuario inválido (3-60: letras, números, . _ -).' });
  // Usuario único entre proveedores
  const taken = d.suppliers.some(x => x.id !== id && x.portal && x.portal.user === user);
  if (taken) return res.status(409).json({ error: 'Ese usuario ya está en uso por otro proveedor.' });
  const hadPass = !!(s.portal && s.portal.hash);
  if (!password && !hadPass) return res.status(400).json({ error: 'Definí una contraseña.' });
  if (password && password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const salt = (password || !hadPass) ? randomBytes(16).toString('hex') : s.portal.salt;
  const hash = password ? hashPortalPassword(password, salt) : s.portal.hash;
  s.portal = { user, salt, hash, updatedAt: new Date().toISOString() };
  saveDistri(d);
  res.json({ ok: true, portalUser: user });
});
app.delete('/admin/distribuidora/suppliers/:id/portal', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const d = loadDistri();
  const s = d.suppliers.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Proveedor no encontrado.' });
  delete s.portal;
  saveDistri(d);
  res.json({ ok: true });
});

// ── Márgenes por categoría ──
app.put('/admin/distribuidora/margins', requireAdmin, (req, res) => {
  const b = req.body || {};
  const d = loadDistri();
  for (const c of DISTRI_CATEGORIES) {
    if (b[c.key] !== undefined) {
      const n = Number(b[c.key]);
      if (!Number.isFinite(n) || n < 0 || n > 500) {
        return res.status(400).json({ error: `Margen inválido para ${c.label} (0–500%).` });
      }
      d.margins[c.key] = Math.round(n * 100) / 100;
    }
  }
  saveDistri(d);
  res.json({ ok: true, margins: d.margins });
});

// ── Costo de compra por producto (carga manual) ──
// body: { cost, category, dispatch }. Mandar cost vacío/null borra el registro.
app.put('/admin/distribuidora/costs/:productId', requireAdmin, (req, res) => {
  const pid = String(req.params.productId);
  const b = req.body || {};
  const d = loadDistri();
  // Actualización PARCIAL: sólo tocamos los campos presentes en el body, así el
  // ILA (que se carga desde Productos) no pisa el costo/categoría/despacho.
  const rec = { cost: null, precioNeto: null, category: '', dispatch: 0, ilaPct: 0, ...(d.productCosts[pid] || {}) };
  const numOrNull = (v) => (v === '' || v == null) ? null : Number(v);
  if (b.cost !== undefined) rec.cost = numOrNull(b.cost);
  if (b.precioNeto !== undefined) rec.precioNeto = numOrNull(b.precioNeto);
  if (b.dispatch !== undefined) rec.dispatch = numOrNull(b.dispatch) || 0;
  if (b.ilaPct !== undefined) rec.ilaPct = numOrNull(b.ilaPct) || 0;
  if (b.category !== undefined) rec.category = isDistriCategory(b.category) ? b.category : '';
  if (rec.cost !== null && (!Number.isFinite(rec.cost) || rec.cost < 0)) return res.status(400).json({ error: 'Costo inválido.' });
  if (rec.precioNeto !== null && (!Number.isFinite(rec.precioNeto) || rec.precioNeto < 0)) return res.status(400).json({ error: 'Precio neto inválido.' });
  if (!Number.isFinite(rec.dispatch) || rec.dispatch < 0) return res.status(400).json({ error: 'Despacho inválido.' });
  if (!Number.isFinite(rec.ilaPct) || rec.ilaPct < 0 || rec.ilaPct > 100) return res.status(400).json({ error: 'ILA inválido (0–100%).' });
  if (rec.cost === null && rec.precioNeto === null && !rec.category && !rec.dispatch && !rec.ilaPct) {
    delete d.productCosts[pid];
  } else {
    rec.updatedAt = new Date().toISOString();
    d.productCosts[pid] = rec;
  }
  saveDistri(d);
  res.json({ ok: true, cost: d.productCosts[pid] || null });
});

// ── Órdenes de compra (sell in) — Zorbo le compra a un proveedor ──
// Replica el formato de la Orden de Compra de 500 Sabores (Excel/PDF MCC).
const OC_BUYER = {
  nombre: '500 SABORES SpA',
  rut: '77.528.378-5',
  direccion: 'Av. Vicuña Mackenna 7110 B201 / Froilan Roa 7205 - La Florida - Santiago, Chile (8240000)',
  giro: 'Compra y venta de bebidas alcohólicas y no alcohólicas al por mayor y por menor',
  telefono: '(+) 56 9 6688 4494',
  contacto: 'Benjamin Rifo',
};
const clp = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function normalizeOCItems(raw){
  return (Array.isArray(raw) ? raw : [])
    .map(it => ({
      articulo: distriStr(it.articulo ?? it.title, 200),
      cantidad: Math.max(0, Number(it.cantidad ?? it.qty) || 0),
      precioUnitario: Math.max(0, Math.round(Number(it.precioUnitario ?? it.unitCost) || 0)),
      // ILA (Impuesto a las bebidas alcohólicas) por producto. Se calcula sobre el
      // NETO (sin despacho).
      ilaPct: Math.max(0, Number(it.ilaPct) || 0),
      // Despacho por unidad. NO paga ILA, pero SÍ entra en la base del IVA.
      despachoUnitario: Math.max(0, Math.round(Number(it.despachoUnitario ?? it.dispatch) || 0)),
    }))
    .filter(it => it.articulo && it.cantidad > 0)
    .map(it => {
      const precioTotal = Math.round(it.cantidad * it.precioUnitario);
      const despachoTotal = Math.round(it.cantidad * it.despachoUnitario);
      return { ...it, precioTotal, despachoTotal, ilaMonto: Math.round(precioTotal * it.ilaPct / 100) };
    });
}
function computeOCTotals(items, descuentoPct){
  const subtotal = items.reduce((s, it) => s + it.precioTotal, 0);           // NETO
  const despachoTotal = items.reduce((s, it) => s + (it.despachoTotal || 0), 0); // no paga ILA, sí IVA
  const dPct = Math.min(100, Math.max(0, Number(descuentoPct) || 0));
  const descuento = Math.round(subtotal * dPct / 100);                        // descuento solo sobre el neto
  const subtotalConDescuento = subtotal - descuento;
  const ilaBruto = items.reduce((s, it) => s + (it.ilaMonto || 0), 0);
  const ila = Math.round(ilaBruto * (1 - dPct / 100));                        // ILA sobre neto
  const iva = Math.round((subtotalConDescuento + despachoTotal) * 0.19);      // IVA sobre neto + despacho
  return { subtotal, despachoTotal, descuentoPct: dPct, descuento, subtotalConDescuento, ila, iva, total: subtotalConDescuento + despachoTotal + ila + iva };
}
function buildOCFromBody(b, supplier){
  const items = normalizeOCItems(b.items);
  const t = computeOCTotals(items, b.descuentoPct);
  return {
    supplierId: supplier.id, supplierName: supplier.name,
    proveedor: {
      razonSocial: distriStr(b.provRazonSocial, 160) || supplier.razonSocial || supplier.name,
      rut:       distriStr(b.provRut, 40) || supplier.rut || '',
      direccion: distriStr(b.provDireccion, 240) || supplier.address || '',
      ciudad:    distriStr(b.provCiudad, 80) || supplier.ciudad || '',
      contacto:  distriStr(b.provContacto, 160) || supplier.contactName || '',
      telefono:  distriStr(b.provTelefono, 60) || supplier.phone || '',
      correo:    distriStr(b.provCorreo, 160) || supplier.email || '',
    },
    transfer: {
      razonSocial: distriStr(b.trfRazonSocial, 160) || distriStr(b.provRazonSocial, 160) || supplier.name,
      rut:       distriStr(b.trfRut, 40) || distriStr(b.provRut, 40) || supplier.rut || '',
      banco:     distriStr(b.trfBanco, 80) || supplier.banco || '',
      tipoCuenta:distriStr(b.trfTipoCuenta, 60) || supplier.tipoCuenta || '',
      nroCuenta: distriStr(b.trfNroCuenta, 60) || supplier.nroCuenta || '',
      correo:    distriStr(b.trfCorreo, 160) || distriStr(b.provCorreo, 160) || supplier.email || '',
    },
    fecha:        distriStr(b.fecha, 20) || todayISO(),
    entrega:      distriStr(b.entrega, 40) || 'A CONVENIR',
    plazoEntrega: distriStr(b.plazoEntrega, 40) || 'A CONVENIR',
    pago:         distriStr(b.pago, 40) || supplier.condicionesPago || '',
    motivo:       distriStr(b.motivo, 240),
    area:         distriStr(b.area, 60),
    centroCostos: distriStr(b.centroCostos, 40),
    items, ...t,
    notes: distriStr(b.notes, 2000),
    status: b.status === 'recibida' ? 'recibida' : 'pendiente',
  };
}

app.post('/admin/distribuidora/purchase-orders', requireAdmin, (req, res) => {
  const b = req.body || {};
  const d = loadDistri();
  const supplier = d.suppliers.find(s => s.id === b.supplierId);
  if (!supplier) return res.status(400).json({ error: 'Elegí un proveedor válido.' });
  const built = buildOCFromBody(b, supplier);
  if (!built.items.length) return res.status(400).json({ error: 'Agregá al menos un artículo con cantidad.' });
  const now = new Date().toISOString();
  const seq = (d.purchaseOrders.reduce((m, po) => {
    const n = parseInt(String(po.number || '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0)) + 1;
  const po = { id: randomUUID(), number: String(seq), ...built, createdAt: now, updatedAt: now };
  d.purchaseOrders.push(po);
  saveDistri(d);
  res.json({ ok: true, purchaseOrder: po });
});
app.put('/admin/distribuidora/purchase-orders/:id', requireAdmin, (req, res) => {
  const d = loadDistri();
  const po = d.purchaseOrders.find(x => x.id === String(req.params.id));
  if (!po) return res.status(404).json({ error: 'Orden no encontrada.' });
  const b = req.body || {};
  // Actualización parcial de estado (toggle rápido)
  if (Object.keys(b).length === 1 && b.status !== undefined) {
    po.status = b.status === 'recibida' ? 'recibida' : 'pendiente';
    po.updatedAt = new Date().toISOString();
    saveDistri(d);
    return res.json({ ok: true, purchaseOrder: po });
  }
  const supplier = d.suppliers.find(s => s.id === (b.supplierId || po.supplierId)) || { id: po.supplierId, name: po.supplierName };
  const built = buildOCFromBody({ ...po, ...b }, supplier);
  if (!built.items.length) return res.status(400).json({ error: 'Agregá al menos un artículo con cantidad.' });
  Object.assign(po, built, { updatedAt: new Date().toISOString() });
  saveDistri(d);
  res.json({ ok: true, purchaseOrder: po });
});
app.delete('/admin/distribuidora/purchase-orders/:id', requireAdmin, (req, res) => {
  const d = loadDistri();
  const before = d.purchaseOrders.length;
  d.purchaseOrders = d.purchaseOrders.filter(x => x.id !== String(req.params.id));
  if (d.purchaseOrders.length === before) return res.status(404).json({ error: 'Orden no encontrada.' });
  saveDistri(d);
  res.json({ ok: true });
});

// ── PDF de la orden de compra (formato 500 Sabores) ──
function buildPurchaseOrderPdf(po){
  const W = 595.28, H = 841.89, M = 30, CW = W - 2 * M;
  const ops = [];
  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const cw = (c, b) => { const n = "ijl.,:;'|!ift()[]/ "; const wi = "mwMW@"; const up = "ABCDEFGHIJKLNOPQRSTUVXYZ0123456789"; let w = n.includes(c) ? .30 : wi.includes(c) ? .86 : up.includes(c) ? .70 : .52; return w * (b ? 1.04 : 1); };
  const tw = (s, sz, b) => [...String(s)].reduce((a, c) => a + cw(c, b), 0) * sz;
  const rect = (x, y, w, h, col, fill) => { const [r, g, bl] = col; ops.push(`${r} ${g} ${bl} ${fill ? 'rg' : 'RG'} ${fill ? '' : '0.6 w '}${x.toFixed(1)} ${(H - y - h).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re ${fill ? 'f' : 'S'}`); };
  const txt = (x, y, s, sz, col, b, align, maxw) => {
    let str = String(s == null ? '' : s);
    if (maxw) { while (str.length > 1 && tw(str, sz, b) > maxw) str = str.slice(0, -1); }
    let xx = x; const width = tw(str, sz, b);
    if (align === 'r') xx = x - width; else if (align === 'c') xx = x - width / 2;
    const [r, g, bl] = col; const f = b ? 'F2' : 'F1';
    ops.push(`BT /${f} ${sz} Tf ${r} ${g} ${bl} rg ${xx.toFixed(1)} ${(H - y - sz).toFixed(1)} Td (${esc(str)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, col) => { const [r, g, bl] = col; ops.push(`${r} ${g} ${bl} RG 0.6 w ${x1.toFixed(1)} ${(H - y1).toFixed(1)} m ${x2.toFixed(1)} ${(H - y2).toFixed(1)} l S`); };
  const GOLD = [0.63, 0.37, 0], DARK = [0.1, 0.1, 0.1], GREY = [0.4, 0.4, 0.4], LINE = [0.8, 0.8, 0.8], HEAD = [0.93, 0.9, 0.82];

  let y = M;
  // Encabezado
  txt(M, y, OC_BUYER.nombre, 17, GOLD, true);
  txt(W - M, y + 1, 'ORDEN DE COMPRA', 13, DARK, true, 'r');
  txt(W - M, y + 18, 'N° ' + po.number, 12, GOLD, true, 'r');
  y += 22;
  txt(M, y, 'RUT: ' + OC_BUYER.rut + '   ·   ' + OC_BUYER.telefono, 8, GREY, false, null, CW * 0.62);
  y += 11;
  txt(M, y, OC_BUYER.direccion, 7.5, GREY, false, null, CW);
  y += 10;
  txt(M, y, 'Giro: ' + OC_BUYER.giro, 7.5, GREY, false, null, CW);
  y += 16;

  // Fila de datos de la orden (4 celdas)
  const cell = (x, w, h, label, value) => {
    rect(x, y, w, h, LINE);
    txt(x + 5, y + 4, label, 6.5, GREY, true);
    txt(x + 5, y + 13, value || '—', 9, DARK, true, null, w - 10);
  };
  const cw4 = CW / 4, ch = 30;
  cell(M, cw4, ch, 'FECHA', po.fecha);
  cell(M + cw4, cw4, ch, 'ENTREGA', po.entrega);
  cell(M + cw4 * 2, cw4, ch, 'PLAZO ENTREGA', po.plazoEntrega);
  cell(M + cw4 * 3, cw4, ch, 'PAGO', po.pago);
  y += ch + 10;

  // Datos del proveedor
  txt(M, y, 'DATOS DEL PROVEEDOR', 9, DARK, true); y += 13;
  const pv = po.proveedor || {};
  const prow = (label, value) => { rect(M, y, CW, 15, LINE); txt(M + 5, y + 4, label, 6.5, GREY, true); txt(M + 130, y + 4, value || '—', 8.5, DARK, false, null, CW - 140); y += 15; };
  prow('RAZÓN SOCIAL', pv.razonSocial);
  prow('RUT', pv.rut);
  prow('DIRECCIÓN', pv.direccion);
  prow('CIUDAD', pv.ciudad);
  prow('TELÉFONO', pv.telefono);
  prow('CORREO', pv.correo);
  y += 12;

  // Tabla de artículos
  const cN = M, cA = M + 24, cCant = M + CW - 210, cPU = M + CW - 140, cPT = M + CW - 70;
  rect(M, y, CW, 16, HEAD, true);
  txt(cN + 3, y + 5, 'N°', 7.5, DARK, true);
  txt(cA, y + 5, 'ARTÍCULO', 7.5, DARK, true);
  txt(cCant + 60, y + 5, 'CANTIDAD', 7.5, DARK, true, 'r');
  txt(cPU + 62, y + 5, 'P. UNITARIO', 7.5, DARK, true, 'r');
  txt(M + CW - 4, y + 5, 'P. TOTAL', 7.5, DARK, true, 'r');
  y += 16;
  (po.items || []).forEach((it, i) => {
    rect(M, y, CW, 15, LINE);
    txt(cN + 3, y + 4.5, String(i + 1), 8, GREY);
    txt(cA, y + 4.5, it.articulo, 8.5, DARK, false, null, cCant - cA - 6);
    txt(cCant + 60, y + 4.5, String(it.cantidad).replace(/\B(?=(\d{3})+(?!\d))/g, '.'), 8.5, DARK, false, 'r');
    txt(cPU + 62, y + 4.5, clp(it.precioUnitario), 8.5, DARK, false, 'r');
    txt(M + CW - 4, y + 4.5, clp(it.precioTotal), 8.5, DARK, true, 'r');
    y += 15;
  });
  y += 10;

  // Totales (bloque derecho)
  const tX = M + CW - 220, tW = 220;
  const trow = (label, value, bold) => {
    rect(tX, y, tW, 16, LINE);
    txt(tX + 6, y + 5, label, 8, bold ? DARK : GREY, bold);
    txt(tX + tW - 6, y + 5, value, bold ? 9.5 : 8.5, bold ? GOLD : DARK, bold, 'r');
    y += 16;
  };
  trow('SUB-TOTAL', clp(po.subtotal));
  trow('DESCUENTO (' + (po.descuentoPct || 0) + '%)', '-' + clp(po.descuento));
  trow('SUB-TOTAL C/DESC.', clp(po.subtotalConDescuento));
  trow('ILA', clp(po.ila || 0));
  if (po.despachoTotal) trow('DESPACHO', clp(po.despachoTotal));
  trow('IVA (19%)', clp(po.iva));
  trow('TOTAL', clp(po.total), true);
  y += 12;

  // Datos de transferencia
  txt(M, y, 'DATOS DE TRANSFERENCIA DEL PROVEEDOR', 9, DARK, true); y += 13;
  const tr = po.transfer || {};
  const half = CW / 2;
  const tcell = (x, w, label, value) => { rect(x, y, w, 15, LINE); txt(x + 5, y + 4, label, 6.5, GREY, true); txt(x + 95, y + 4, value || '—', 8.5, DARK, false, null, w - 100); };
  tcell(M, half, 'RAZÓN SOCIAL', tr.razonSocial); tcell(M + half, half, 'RUT', tr.rut); y += 15;
  tcell(M, half, 'BANCO', tr.banco); tcell(M + half, half, 'TIPO DE CUENTA', tr.tipoCuenta); y += 15;
  tcell(M, half, 'N° DE CUENTA', tr.nroCuenta); tcell(M + half, half, 'CORREO', tr.correo); y += 15;

  // Ensamblar PDF
  const content = ops.join('\n');
  const objs = {};
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[5] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[6] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 5 0 R >>`;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count 1 /Kids [6 0 R] >>';
  let buf = '%PDF-1.4\n'; const off = {};
  for (let i = 1; i <= 6; i++) { off[i] = buf.length; buf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = buf.length;
  buf += `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) buf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  buf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(buf, 'latin1');
}
function sendPOPdf(res, po){
  const pdf = buildPurchaseOrderPdf(po);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Orden_de_Compra_${po.number}.pdf"`);
  res.send(pdf);
}
app.get('/admin/distribuidora/purchase-orders/:id/pdf', requireAdmin, (req, res) => {
  const po = loadDistri().purchaseOrders.find(x => x.id === String(req.params.id));
  if (!po) return res.status(404).send('Orden no encontrada.');
  sendPOPdf(res, po);
});

// Categoría sugerida para un producto según el proveedor cuyo nombre matchea el
// vendor de Shopify (así el costo arranca con una categoría razonable).
function supplierCategoryForVendor(suppliers, vendor){
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const nv = norm(vendor);
  if (!nv) return '';
  for (const s of suppliers) {
    const ns = norm(s.name);
    if (ns && (nv === ns || nv.includes(ns) || ns.includes(nv))) return s.category || '';
  }
  return '';
}

// Productos de Shopify + costo manual + cálculo de comercialización. Alimenta
// las tablas de Costos, Inventario y Comercialización.
app.get('/admin/distribuidora/products', requireAdmin, async (req, res) => {
  if (!process.env.SHOPIFY_ADMIN_TOKEN) {
    return res.json({ available: false, reason: 'Shopify no conectado (falta SHOPIFY_ADMIN_TOKEN).' });
  }
  try {
    const all = await loadProductsCache(String(req.query.refresh || '') === '1');
    if (!all) return res.json({ available: false, reason: 'No se pudieron cargar los productos.' });
    const d = loadDistri();
    const customBrands = getCustomBrands();
    const products = all.map(p => {
      const pid = String(p.id);
      const c = d.productCosts[pid] || null;
      const variants = p.variants || [];
      const stock = variants.reduce((sum, v) => sum + (Number.isFinite(v.stock) ? v.stock : 0), 0);
      const price = variants[0]?.price != null ? Number(variants[0].price) : null;
      const category = (c && c.category) || supplierCategoryForVendor(d.suppliers, p.vendor) || '';
      const cost = c && c.cost != null ? Number(c.cost) : null;
      const precioNeto = c && c.precioNeto != null ? Number(c.precioNeto) : null;
      const ilaPct = c && Number.isFinite(c.ilaPct) ? Number(c.ilaPct) : 0;
      const dispatch = c && Number.isFinite(c.dispatch) ? Number(c.dispatch) : 0;
      const marginPct = category && d.margins[category] != null ? Number(d.margins[category]) : null;
      let finalPrice = null;
      if (cost != null && marginPct != null) {
        finalPrice = Math.round(cost * (1 + marginPct / 100) + dispatch);
      }
      return {
        id: pid,
        title: p.title,
        vendor: p.vendor || '',
        brand: brandFromProduct(p, customBrands),
        sku: variants[0]?.sku || '',
        status: String(p.status || 'ACTIVE').toUpperCase(),
        image: p.image || null,
        price, stock,
        cost, precioNeto, ilaPct, category, dispatch, marginPct, finalPrice,
        hasManualCategory: !!(c && c.category),
      };
    });
    res.json({ available: true, products, margins: d.margins, categories: DISTRI_CATEGORIES });
  } catch (e) {
    res.status(500).json({ error: 'Error cargando productos: ' + (e.message || e) });
  }
});

// ─── Puntos de venta (Comercialización) ─────────────────────────────────────
// Locales donde están los productos de Zorbo, agregados por cliente, con la
// venta de cada uno. Sale de las órdenes de Shopify (dirección de despacho).
app.get('/admin/puntos-venta', requireAdmin, async (req, res) => {
  const result = await loadOrders(String(req.query.refresh || '') === '1');
  const ordersReason = result.available ? '' : (result.reason || '');
  const map = new Map();
  for (const o of (result.available ? result.orders : [])) {
    const sa = o.shippingAddress;
    const key = o.customerId
      || (o.customerEmail ? 'e:' + normEmail(o.customerEmail) : null)
      || (sa ? 'a:' + [sa.address1, sa.city].filter(Boolean).join('|').toLowerCase() : null);
    if (!key) continue;
    let p = map.get(key);
    if (!p) { p = { customerId:o.customerId||null, name:'', email:o.customerEmail||'', total:0, units:0, orders:0, lastDate:0, address:null, brands:new Set(), b2b:false }; map.set(key, p); }
    p.total += Number(o.total || 0);
    p.orders += 1;
    let isB2B = false;
    for (const li of (o.lineItems || [])) {
      p.units += Number(li.qty || 0);
      if (li.vendor) p.brands.add(li.vendor);
      if (isMayoristaLine(li)) isB2B = true;
    }
    if (isB2B) p.b2b = true;
    const t = new Date(o.createdAt).getTime();
    if (t >= p.lastDate) {
      p.lastDate = t;
      p.name = (sa && sa.company)
        || [o.customerFirstName, o.customerLastName].filter(Boolean).join(' ').trim()
        || o.customerEmail || 'Sin nombre';
      if (sa) p.address = sa;
    }
  }
  const points = [...map.values()].map(p => ({
    _customerId: p.customerId,
    name: p.name, email: p.email, total: Math.round(p.total), units: p.units, orders: p.orders,
    b2b: p.b2b, brands: [...p.brands].slice(0, 6),
    address: p.address ? [p.address.address1, p.address.city, p.address.province].filter(Boolean).join(', ') : '',
    city: p.address?.city || '',
    lat: p.address?.lat ?? null, lng: p.address?.lng ?? null,
    lastOrder: p.lastDate ? new Date(p.lastDate).toISOString() : null,
  })).sort((a, b) => b.total - a.total);
  // Fusiona los puntos de venta cargados a mano (locales sin ventas todavía o
  // ya registrados como cliente). Si el punto manual tiene customerId que ya
  // aparece en las ventas, lo enriquece; si no, lo agrega como punto nuevo.
  const d = loadDistri();
  for (const sp of (d.salesPoints || [])) {
    const addr = [sp.address, sp.number].filter(Boolean).join(' ');
    const fullAddr = [addr, sp.city, sp.region, sp.country].filter(Boolean).join(', ');
    const existing = sp.customerId
      ? points.find(p => p._customerId === sp.customerId)
      : points.find(p => p.name.toLowerCase() === String(sp.name||'').toLowerCase());
    if (existing) {
      if (sp.lat != null && existing.lat == null) { existing.lat = sp.lat; existing.lng = sp.lng; }
      if (!existing.address) existing.address = fullAddr;
      existing.manualId = sp.id;
    } else {
      points.push({
        name: sp.name || 'Sin nombre', email: sp.email || '', total: 0, units: 0, orders: 0,
        b2b: true, brands: [], address: fullAddr, city: sp.city || '',
        lat: sp.lat ?? null, lng: sp.lng ?? null, lastOrder: null,
        manual: true, manualId: sp.id, customerId: sp.customerId || null,
      });
    }
  }
  points.sort((a, b) => b.total - a.total);

  res.json({
    available: true,
    ordersReason,
    count: points.length,
    totalVenta: points.reduce((a, p) => a + p.total, 0),
    withCoords: points.filter(p => p.lat != null).length,
    points: points.map(({ _customerId, ...rest }) => rest),
  });
});

// Crear un punto de venta a mano y registrarlo como cliente en Shopify.
app.post('/admin/puntos-venta/create', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = distriStr(b.name, 160);
  if (!name) return res.status(400).json({ error: 'El nombre del local es obligatorio.' });
  const country = distriStr(b.country, 80) || 'Chile';
  const region  = distriStr(b.region, 120);
  const city    = distriStr(b.city, 120);
  const address = distriStr(b.address, 200);
  const number  = distriStr(b.number, 40);
  const phone   = distriStr(b.phone, 60);
  const email   = normEmail(b.email);
  const address1 = [address, number].filter(Boolean).join(' ');

  let customerId = null, shopifyOk = false, shopifyMsg = '';
  if (process.env.SHOPIFY_ADMIN_TOKEN) {
    try {
      if (email) {
        const existing = await shopifyGetCustomerByEmail(email);
        if (existing) { customerId = stripGid(existing.id, 'Customer'); shopifyOk = true; shopifyMsg = 'Ya existía un cliente con ese email; se reutilizó.'; }
      }
      if (!customerId) {
        const payload = { customer: {
          first_name: name,
          tags: 'PUNTO_VENTA, MAYORISTA',
          note: 'Punto de venta cargado desde el panel',
          send_email_welcome: false,
          addresses: [{
            company: name, address1, city, province: region, country, phone: phone || null,
          }],
        } };
        if (email) payload.customer.email = email;
        if (phone) payload.customer.phone = phone;
        const r = await shopifyAdminFetch('/customers.json', { method: 'POST', body: JSON.stringify(payload) });
        if (r.customer && r.customer.id) { customerId = String(r.customer.id); shopifyOk = true; }
        else shopifyMsg = 'Shopify no devolvió el cliente.';
      }
    } catch (e) {
      shopifyMsg = 'No se pudo crear en Shopify (' + String(e.message || e).slice(0, 140) + '). El punto quedó guardado igual.';
    }
  } else {
    shopifyMsg = 'Shopify no conectado: el punto quedó guardado solo en el panel.';
  }

  const point = {
    id: randomUUID(), name, country, region, city, address, number, phone, email,
    customerId, lat: null, lng: null, createdAt: new Date().toISOString(),
  };
  const d = loadDistri();
  d.salesPoints.push(point);
  saveDistri(d);
  res.json({ ok: true, point, shopifyOk, shopifyMsg });
});

// Eliminar un punto de venta cargado a mano (no borra el cliente de Shopify).
app.delete('/admin/puntos-venta/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const d = loadDistri();
  const before = d.salesPoints.length;
  d.salesPoints = d.salesPoints.filter(x => x.id !== id);
  if (d.salesPoints.length === before) return res.status(404).json({ error: 'Punto no encontrado.' });
  saveDistri(d);
  res.json({ ok: true });
});

// ─── Top clientes por producto (histórico Shopify) ──────────────────────────
// Busca en los line items de TODOS los pedidos los que matchean el texto y
// rankea por cliente: cuántas unidades compró, cuánto gastó y el detalle de
// cada pedido. Función compartida por el JSON y el export a Excel.
async function topClientesData(q, refresh){
  q = String(q || '').trim().toLowerCase();
  if (!q) return { available: true, query: '', count: 0, totalUnits: 0, totalPedidos: 0, matchedProducts: [], rows: [] };
  const result = await loadOrders(refresh === true || refresh === '1');
  if (!result.available) return { available: false, reason: result.reason };
  const map = new Map();
  const matchedTitles = new Set();
  for (const o of result.orders) {
    let units = 0, spent = 0, matched = false;
    const lineas = [];
    for (const li of (o.lineItems || [])) {
      if (String(li.title || '').toLowerCase().includes(q)) {
        units += Number(li.qty || 0);
        spent += Number(li.amount || 0);
        matched = true;
        if (li.title) matchedTitles.add(li.title);
        lineas.push({ title: li.title, variante: li.variantTitle || '', qty: Number(li.qty || 0), amount: Math.round(Number(li.amount || 0)) });
      }
    }
    if (!matched) continue;
    const key = o.customerId || (o.customerEmail ? 'e:' + normEmail(o.customerEmail) : 'o:' + o.id);
    let p = map.get(key);
    if (!p) { p = { nombre: '', email: o.customerEmail || '', telefono: o.customerPhone || '', units: 0, spent: 0, orders: 0, last: 0, pedidos: [] }; map.set(key, p); }
    p.units += units; p.spent += spent; p.orders += 1;
    // Detalle de este pedido (solo las líneas que matchean el producto buscado).
    p.pedidos.push({ pedido: o.name || ('#' + o.id), fecha: o.createdAt, units, monto: Math.round(spent), estado: o.status || '', lineas });
    const nm = (o.shippingAddress && o.shippingAddress.company) || [o.customerFirstName, o.customerLastName].filter(Boolean).join(' ').trim();
    if (nm && !p.nombre) p.nombre = nm;
    const t = new Date(o.createdAt).getTime();
    if (t > p.last) p.last = t;
  }
  const rows = [...map.values()]
    .map(p => ({
      nombre: p.nombre, email: p.email, telefono: p.telefono,
      units: p.units, spent: Math.round(p.spent), orders: p.orders,
      lastOrder: p.last ? new Date(p.last).toISOString() : null,
      pedidos: p.pedidos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)),
    }))
    .sort((a, b) => b.units - a.units);
  return {
    available: true, query: q, count: rows.length,
    totalUnits: rows.reduce((s, p) => s + p.units, 0),
    totalPedidos: rows.reduce((s, p) => s + p.orders, 0),
    matchedProducts: [...matchedTitles].slice(0, 12),
    rows,
  };
}
app.get('/admin/top-clientes', requireAdmin, async (req, res) => {
  const d = await topClientesData(req.query.q, req.query.refresh);
  res.json(d);
});
// Export a Excel del ranking + detalle pedido por pedido. Dos hojas: "Ranking"
// (un cliente por fila) y "Detalle pedidos" (una fila por línea de pedido).
app.get('/admin/top-clientes/export.xlsx', requireAdmin, async (req, res) => {
  const d = await topClientesData(req.query.q, req.query.refresh);
  if (!d.available) return res.status(400).json({ error: d.reason || 'No disponible.' });
  if (!d.rows.length) return res.status(404).json({ error: 'Sin resultados para exportar.' });
  const S = { header: 2, money: 3, num: 0 };
  const fdate = (iso) => { if (!iso) return ''; const dt = new Date(iso); return isNaN(dt) ? '' : `${String(dt.getDate()).padStart(2,'0')}-${String(dt.getMonth()+1).padStart(2,'0')}-${dt.getFullYear()}`; };
  // Hoja 1: ranking por cliente
  const rank = [];
  rank.push([{ v: `Producto: "${d.query}"`, s: 1 }]);
  rank.push([{ v: `${d.count} clientes · ${d.totalUnits} unidades · ${d.totalPedidos} pedidos`, s: 0 }]);
  rank.push([]);
  rank.push(['#', 'Cliente', 'Teléfono', 'Email', 'Unidades', 'Gasto', 'Pedidos', 'Última compra'].map(v => ({ v, s: S.header })));
  d.rows.forEach((p, i) => rank.push([
    { v: i + 1, t: 'n' }, { v: p.nombre || '—' }, { v: p.telefono || '' }, { v: p.email || '' },
    { v: p.units, t: 'n' }, { v: p.spent, t: 'n', s: S.money }, { v: p.orders, t: 'n' }, { v: fdate(p.lastOrder) },
  ]));
  // Hoja 2: detalle pedido por pedido (una fila por línea)
  const det = [];
  det.push(['Cliente', 'Pedido', 'Fecha', 'Producto', 'Variante', 'Unidades', 'Monto'].map(v => ({ v, s: S.header })));
  d.rows.forEach(p => (p.pedidos || []).forEach(o => {
    const lins = (o.lineas && o.lineas.length) ? o.lineas : [{ title: d.query, variante: '', qty: o.units, amount: o.monto }];
    lins.forEach(l => det.push([
      { v: p.nombre || '—' }, { v: o.pedido }, { v: fdate(o.fecha) },
      { v: l.title || '' }, { v: l.variante || '' }, { v: l.qty, t: 'n' }, { v: l.amount, t: 'n', s: S.money },
    ]));
  }));
  const buf = xlsxPackage([{ name: 'Ranking', rows: rank }, { name: 'Detalle pedidos', rows: det }]);
  const safe = d.query.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'producto';
  sendXlsx(res, buf, `top-clientes-${safe}.xlsx`);
});

// ─── Centro de Ads (Marketing) ──────────────────────────────────────────────
// Analiza y recomienda sobre las campañas de Google Ads y Meta Ads. NO crea ni
// edita campañas (eso se hace en las plataformas). Presupuesto mensual editable
// (default $2.000.000 CLP) que la IA usa para repartir.
const ADS_FILE = join(PROMPTS_EFFECTIVE_DIR, 'ads.json');
const ADS_DEFAULT_BUDGET = 2000000;
function loadAdsConfig(){
  try {
    if (!existsSync(ADS_FILE)) return { monthlyBudget: ADS_DEFAULT_BUDGET };
    const p = JSON.parse(readFileSync(ADS_FILE, 'utf-8'));
    return { monthlyBudget: Number(p.monthlyBudget) > 0 ? Number(p.monthlyBudget) : ADS_DEFAULT_BUDGET };
  } catch { return { monthlyBudget: ADS_DEFAULT_BUDGET }; }
}
function saveAdsConfig(d){
  if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true });
  writeFileSync(ADS_FILE, JSON.stringify(d, null, 2));
}

app.get('/admin/ads/config', requireAdmin, (_req, res) => {
  res.json({ ...loadAdsConfig(), currency: 'CLP' });
});
app.put('/admin/ads/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  const monthlyBudget = Number(b.monthlyBudget);
  if (!Number.isFinite(monthlyBudget) || monthlyBudget < 0 || monthlyBudget > 1e10) {
    return res.status(400).json({ error: 'Presupuesto inválido.' });
  }
  const cfg = { monthlyBudget: Math.round(monthlyBudget) };
  saveAdsConfig(cfg);
  res.json({ ok: true, ...cfg });
});

// ── Google Ads ──
// Usa la API REST (sin librerías): refresh_token → access_token → searchStream.
// Si el usuario fija GOOGLE_ADS_API_VERSION la respetamos; si no, probamos de
// la más nueva a la más vieja hasta que una no devuelva 404 (Google va
// sacando versiones viejas con el tiempo).
const GOOGLE_ADS_VERSIONS = process.env.GOOGLE_ADS_API_VERSION
  ? [process.env.GOOGLE_ADS_API_VERSION]
  : ['v21', 'v20', 'v19', 'v18', 'v17'];
function googleAdsConfigured(){
  return !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    && process.env.GOOGLE_ADS_CLIENT_ID
    && process.env.GOOGLE_ADS_CLIENT_SECRET
    && process.env.GOOGLE_ADS_REFRESH_TOKEN
    && process.env.GOOGLE_ADS_CUSTOMER_ID);
}
async function googleAdsAccessToken(){
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(j.error_description || j.error || 'No se pudo autenticar con Google (revisá el refresh token).');
  return j.access_token;
}
// Semáforo de rendimiento por campaña (criterio: priorizar conversiones/ROAS
// sobre métricas de vanidad; cortar lo que gasta sin convertir).
function adLight(c){
  if (c.convValue > 0 && c.spend > 0) {
    if (c.roas >= 3) return 'green';
    if (c.roas >= 1.5) return 'yellow';
    return 'red';
  }
  if (c.conversions > 0) {
    return c.ctr >= 2 ? 'green' : 'yellow';
  }
  if (c.clicks >= 40 && c.conversions === 0) return 'red'; // gasta y no convierte
  return 'yellow';
}
const isAdsDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
async function loadGoogleAdsCampaigns(from, to){
  const token = await googleAdsAccessToken();
  const cid = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, '');
  const dateClause = (isAdsDate(from) && isAdsDate(to))
    ? `segments.date BETWEEN '${from}' AND '${to}'`
    : `segments.date DURING LAST_30_DAYS`;
  const query = `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr,
           metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion,
           metrics.conversions_value
    FROM campaign
    WHERE campaign.status = 'ENABLED' AND ${dateClause}`;
  const headers = {
    Authorization: 'Bearer ' + token,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');
  }
  let resp = null;
  for (const v of GOOGLE_ADS_VERSIONS) {
    const r = await fetch(`https://googleads.googleapis.com/${v}/customers/${cid}/googleAds:searchStream`, {
      method: 'POST', headers, body: JSON.stringify({ query }),
    });
    const text = await r.text();
    // 404 con HTML genérico = versión inexistente → probar la siguiente.
    if (r.status === 404 && !/^\s*[\[{]/.test(text)) { resp = { status: r.status, ok: false, text }; continue; }
    resp = { status: r.status, ok: r.ok, text }; break;
  }
  if (!resp) throw new Error('No se pudo contactar la API de Google Ads.');
  if (resp.status === 404) {
    throw new Error('Ninguna versión de la API de Google Ads respondió (probá fijar GOOGLE_ADS_API_VERSION con una versión vigente).');
  }
  if (!resp.ok) {
    let msg = resp.text;
    try { const j = JSON.parse(resp.text); msg = j.error?.message || j[0]?.error?.message || resp.text; } catch {}
    if (/developer token|test account|not approved|DEVELOPER_TOKEN/i.test(msg)) {
      throw new Error('El developer token todavía está en acceso de prueba (Google aún no aprueba el acceso básico). Apenas lo aprueben, recargá y aparecen las campañas.');
    }
    throw new Error(msg.slice(0, 240));
  }
  const text = resp.text;
  let chunks; try { chunks = JSON.parse(text); } catch { chunks = []; }
  const byId = new Map();
  for (const chunk of (Array.isArray(chunks) ? chunks : [])) {
    for (const row of (chunk.results || [])) {
      const id = row.campaign?.id;
      const m = row.metrics || {};
      const spend = Number(m.costMicros || 0) / 1e6;
      const clicks = Number(m.clicks || 0);
      const impressions = Number(m.impressions || 0);
      const conversions = Number(m.conversions || 0);
      const convValue = Number(m.conversionsValue || 0);
      let c = byId.get(id);
      if (!c) {
        c = { id, name: row.campaign?.name || '(sin nombre)', channel: row.campaign?.advertisingChannelType || '',
              spend: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0 };
        byId.set(id, c);
      }
      c.spend += spend; c.impressions += impressions; c.clicks += clicks;
      c.conversions += conversions; c.convValue += convValue;
    }
  }
  const campaigns = [...byId.values()].map(c => {
    const ctr = c.impressions ? (c.clicks / c.impressions) * 100 : 0;
    const cpc = c.clicks ? c.spend / c.clicks : 0;
    const cpa = c.conversions ? c.spend / c.conversions : 0;
    const roas = c.spend ? c.convValue / c.spend : 0;
    const out = { ...c, spend: Math.round(c.spend), convValue: Math.round(c.convValue),
      ctr: +ctr.toFixed(2), cpc: Math.round(cpc), cpa: Math.round(cpa), roas: +roas.toFixed(2) };
    out.light = adLight(out);
    return out;
  }).sort((a, b) => b.spend - a.spend);
  const totals = campaigns.reduce((t, c) => ({
    spend: t.spend + c.spend, impressions: t.impressions + c.impressions, clicks: t.clicks + c.clicks,
    conversions: t.conversions + c.conversions, convValue: t.convValue + c.convValue,
  }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0 });
  return { campaigns, totals };
}

app.get('/admin/ads/google', requireAdmin, async (req, res) => {
  if (!googleAdsConfigured()) {
    return res.json({
      connected: false,
      reason: 'Falta conectar Google Ads (variables de entorno en Railway).',
      envVars: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID (opcional, MCC)'],
    });
  }
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  const range = (isAdsDate(from) && isAdsDate(to)) ? `${from} a ${to}` : 'últimos 30 días';
  try {
    const data = await loadGoogleAdsCampaigns(from, to);
    res.json({ connected: true, currency: 'CLP', range, ...data });
  } catch (e) {
    res.json({ connected: true, error: 'Google Ads respondió un error: ' + String(e.message || e).slice(0, 240) });
  }
});

// ── Meta Ads (Facebook / Instagram) ──
// Graph API de Marketing. Con un token de larga duración + el ID de la cuenta
// publicitaria alcanza para LEER insights (no creamos ni editamos campañas).
const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
function metaConfigured(){
  return !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}
// Tipos de acción de "compra" en Meta — tomamos el primero presente para no
// contar la misma conversión dos veces.
const META_PURCHASE_PRIORITY = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
function metaPickAction(actions){
  if (!Array.isArray(actions)) return 0;
  for (const t of META_PURCHASE_PRIORITY) {
    const a = actions.find(x => x.action_type === t);
    if (a) return Number(a.value || 0);
  }
  return 0;
}
async function loadMetaCampaigns(from, to){
  const acct = String(process.env.META_AD_ACCOUNT_ID).replace(/^act_/, '');
  const fields = 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,frequency,actions,action_values';
  const period = (isAdsDate(from) && isAdsDate(to))
    ? `&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}`
    : `&date_preset=last_30d`;
  const url = `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/insights`
    + `?level=campaign${period}&limit=200`
    + `&fields=${encodeURIComponent(fields)}`
    + `&access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || 'Error de Meta');
  const rows = Array.isArray(j.data) ? j.data : [];
  const campaigns = rows.map(row => {
    const spend = Number(row.spend || 0);
    const impressions = Number(row.impressions || 0);
    const reach = Number(row.reach || 0);
    const clicks = Number(row.clicks || 0);
    const conversions = metaPickAction(row.actions);
    const convValue = metaPickAction(row.action_values);
    const ctr = row.ctr != null ? Number(row.ctr) : (impressions ? clicks / impressions * 100 : 0);
    const cpc = row.cpc != null ? Number(row.cpc) : (clicks ? spend / clicks : 0);
    const frequency = row.frequency != null ? Number(row.frequency) : 0;
    const cpa = conversions ? spend / conversions : 0;
    const roas = spend ? convValue / spend : 0;
    const c = {
      id: row.campaign_id, name: row.campaign_name || '(sin nombre)',
      spend: Math.round(spend), impressions, reach, clicks,
      conversions, convValue: Math.round(convValue),
      ctr: +ctr.toFixed(2), cpc: Math.round(cpc), frequency: +frequency.toFixed(2),
      cpa: Math.round(cpa), roas: +roas.toFixed(2),
    };
    c.light = adLight(c);
    return c;
  }).sort((a, b) => b.spend - a.spend);
  const totals = campaigns.reduce((t, c) => ({
    spend: t.spend + c.spend, impressions: t.impressions + c.impressions, reach: t.reach + c.reach,
    clicks: t.clicks + c.clicks, conversions: t.conversions + c.conversions, convValue: t.convValue + c.convValue,
  }), { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, convValue: 0 });
  return { campaigns, totals };
}

app.get('/admin/ads/meta', requireAdmin, async (req, res) => {
  if (!metaConfigured()) {
    return res.json({
      connected: false,
      reason: 'Falta conectar Meta Ads (variables de entorno en Railway).',
      envVars: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_APP_ID (opcional)', 'META_APP_SECRET (opcional)'],
    });
  }
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  const range = (isAdsDate(from) && isAdsDate(to)) ? `${from} a ${to}` : 'últimos 30 días';
  try {
    const data = await loadMetaCampaigns(from, to);
    res.json({ connected: true, currency: 'CLP', range, ...data });
  } catch (e) {
    res.json({ connected: true, error: 'Meta respondió un error: ' + String(e.message || e).slice(0, 240) });
  }
});

// ── Recomendaciones con IA (reparto del presupuesto) ──
async function gatherAdsData(){
  const out = {};
  if (googleAdsConfigured()) {
    try { out.google = await loadGoogleAdsCampaigns(); } catch (e) { out.googleError = String(e.message || e); }
  }
  if (metaConfigured()) {
    try { out.meta = await loadMetaCampaigns(); } catch (e) { out.metaError = String(e.message || e); }
  }
  return out;
}

app.post('/admin/ads/recommendations', requireAdmin, async (_req, res) => {
  const data = await gatherAdsData();
  const gCamps = (data.google && data.google.campaigns) || [];
  const mCamps = (data.meta && data.meta.campaigns) || [];
  if (!gCamps.length && !mCamps.length) {
    return res.json({
      available: false,
      reason: data.googleError || data.metaError
        ? 'Las plataformas todavía no devuelven datos (puede faltar la aprobación de Google o revisar las credenciales).'
        : 'No hay campañas conectadas todavía. Conectá Google Ads o Meta Ads para que la IA pueda analizar.',
    });
  }
  const budget = loadAdsConfig().monthlyBudget;
  const slim = [
    ...gCamps.map(c => ({ plataforma:'Google', campana:c.name, gasto:c.spend, impresiones:c.impressions, clicks:c.clicks, ctr:c.ctr, cpc:c.cpc, conversiones:c.conversions, cpa:c.cpa, roas:c.roas })),
    ...mCamps.map(c => ({ plataforma:'Meta', campana:c.name, gasto:c.spend, alcance:c.reach, impresiones:c.impressions, frecuencia:c.frequency, clicks:c.clicks, ctr:c.ctr, cpc:c.cpc, conversiones:c.conversions, cpa:c.cpa, roas:c.roas })),
  ];

  const schema = `{
  "resumen": "2 o 3 frases en lenguaje simple sobre cómo viene la inversión",
  "allocation": [ { "campana": "nombre exacto", "plataforma": "Google" o "Meta", "gasto_actual": numero, "sugerido": numero, "accion": "subir|bajar|mantener|pausar", "porque": "una frase simple" } ],
  "abrir": ["ideas de campañas nuevas a evaluar, o [] si no aplica"],
  "hacer": ["acciones concretas a hacer ya"],
  "no_hacer": ["errores a evitar"]
}`;

  const sys = `Sos el estratega de medios pagados (paid ads) de Zorbo, la plataforma de Kairos Brewing. Analizás datos REALES de campañas de Google Ads y Meta Ads y recomendás cómo repartir el presupuesto mensual para vender más sin malgastar plata. Hablás en español de Chile, simple y directo, para alguien que NO es experto en ads. NUNCA uses signos de apertura (¿ ¡), solo los de cierre.

Criterios (mejores prácticas de paid ads):
- Lo que importa son las CONVERSIONES y el ROAS, no las impresiones ni los clicks (esas son métricas de vanidad).
- Cortá rápido lo que gasta y no convierte (ROAS bajo o conversiones en cero con gasto alto): pausar o bajar presupuesto.
- Escalá de a poco lo que rinde (ROAS alto): subir presupuesto, pero no más de ~20-30% por vez para no romper el aprendizaje de la campaña.
- No dejes plata en campañas con CPA mayor a lo que deja la venta.
- En Meta, si la frecuencia es alta (mayor a 3 o 4) hay fatiga de audiencia: recomendá refrescar el creativo, no solo subir plata.
- La suma de los montos "sugerido" de las campañas que NO pausás debe acercarse al presupuesto total mensual.
- NO prometas viralidad ni resultados garantizados. Basate SOLO en los datos entregados; si hay poca data, decilo.

Devolvé SOLO un JSON válido, sin texto extra y sin markdown, con esta forma EXACTA:
${schema}
Los montos van en pesos chilenos enteros (sin puntos ni símbolos). "accion" debe ser uno de: subir, bajar, mantener, pausar.`;

  const userMsg = `Presupuesto mensual total a repartir: ${budget} (CLP).\n\nCampañas activas (datos reales, últimos 30 días):\n${JSON.stringify(slim, null, 1)}\n\nDevolvé SOLO el JSON pedido.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2500, system: sys,
      messages: [{ role: 'user', content: userMsg }],
    });
    let txt = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    if (!parsed) return res.json({ available: true, budget, generatedAt: new Date().toISOString(), raw: txt });
    res.json({ available: true, budget, generatedAt: new Date().toISOString(), ...parsed });
  } catch (e) {
    res.status(500).json({ error: 'Error generando recomendaciones: ' + String(e.message || e).slice(0, 200) });
  }
});

// ─── Costeo de carta (cocina / restaurante) ─────────────────────────────────
// 3 niveles encadenados: insumos → recetas base (RB) → platos. Todo se calcula
// en cascada al vuelo (los precios derivados no se guardan, se resuelven en GET).
const COSTEO_FILE = join(PROMPTS_EFFECTIVE_DIR, 'costeo.json');
const costeoStr = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const COSTEO_UNITS = ['litro', 'kilogramo', 'unidad'];
function costeoUnit(u){ u = String(u || '').toLowerCase(); if (COSTEO_UNITS.includes(u)) return u; return /lit/.test(u) ? 'litro' : /kil/.test(u) ? 'kilogramo' : 'unidad'; }
const costeoNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Normalización "suelta" para cruzar nombres de la carta contra los platos
// costeados: además de acentos/mayúsculas, ignora guiones y puntuación (así
// "Mil-Amores" calza con "mil amores", "Kung-fu Chicken" con "kung fu chicken").
const costeoNormLoose = (s) => costeoNorm(s).replace(/[^a-z0-9]+/g, ' ').trim();

const COSTEO_CATS_DEFAULT = ['Rolls', 'Burgers', 'Papas', 'Ceviches/Tiraditos/Ensaladas', 'Principales', 'Huella del chef'];
// Construye un doc completo (insumos + RB + platos) desde un archivo de semilla.
// Las RB y los platos referencian por nombre; se resuelven a ids. Mismo modelo
// de cálculo para todos los restaurantes (la protección 10% se aplica una sola
// vez a nivel de plato, no dentro de cada RB).
function costeoBuildFromSeed(seedFile){
  let seed = { insumos: [], recetasBase: [], platos: [] };
  try { seed = JSON.parse(readFileSync(join(__dirname, seedFile), 'utf-8')); } catch {}
  const insumos = (seed.insumos || []).map(x => ({
    id: randomUUID(), descripcion: costeoStr(x.descripcion, 200),
    precioNeto: Number(x.precioNeto) || 0, unidad: costeoUnit(x.unidad),
    rendimiento: (Number(x.rendimiento) > 0 && Number(x.rendimiento) <= 1) ? Number(x.rendimiento) : null,
    // Barra: volumen/formato de botella. Precio por litro/unidad = precioNeto ÷ volumen.
    volumen: (Number(x.volumen) > 0) ? Number(x.volumen) : null,
  }));
  const byName = new Map(); insumos.forEach(i => byName.set(costeoNorm(i.descripcion), i.id));
  const rbs = (seed.recetasBase || []).map(x => ({ id: randomUUID(), nombre: costeoStr(x.nombre, 200), unidad: costeoUnit(x.unidad || 'unidad'), produccion: Number(x.produccion) || 0, _raw: x.lineas || [] }));
  const rbByName = new Map(); rbs.forEach(rb => rbByName.set(costeoNorm(rb.nombre), rb.id));
  rbs.forEach(rb => {
    rb.lineas = rb._raw.map(l => {
      const k = costeoNorm(l.ref);
      if (rbByName.has(k) && rbByName.get(k) !== rb.id) return { refType: 'rb', refId: rbByName.get(k), cantidad: Number(l.cantidad) || 0 };
      if (byName.has(k)) return { refType: 'insumo', refId: byName.get(k), cantidad: Number(l.cantidad) || 0 };
      return null;
    }).filter(Boolean);
    delete rb._raw;
  });
  // Platos (Nivel 3): las lineas referencian insumos o RB por nombre. RB tiene
  // prioridad (los "RB SHARI" del Excel son recetas base).
  const platos = (seed.platos || []).map(x => {
    const lineas = (x.lineas || []).map(l => {
      const k = costeoNorm(l.ref);
      if (rbByName.has(k)) return { refType: 'rb', refId: rbByName.get(k), cantidad: Number(l.cantidad) || 0 };
      if (byName.has(k)) return { refType: 'insumo', refId: byName.get(k), cantidad: Number(l.cantidad) || 0 };
      return null;
    }).filter(Boolean);
    const m = Number(x.margenPct); const margenPct = (m > 0 && m <= 100) ? m : 30;
    const precioReal = (Number(x.precioReal) > 0) ? Math.round(Number(x.precioReal)) : null;
    const iva = (x.iva === false) ? false : (x.iva === true ? true : undefined);
    const p = { id: randomUUID(), nombre: costeoStr(x.nombre, 200), categoria: costeoStr(x.categoria, 120) || 'Sin categoría', margenPct, lineas, precioReal };
    if (iva !== undefined) p.iva = iva;
    return p;
  });
  // Categorías: explícitas del seed (barra) > orden de aparición de platos > set base.
  const cats = []; platos.forEach(p => { if (p.categoria && !cats.includes(p.categoria)) cats.push(p.categoria); });
  const categorias = (Array.isArray(seed.categorias) && seed.categorias.length)
    ? seed.categorias.map(c => costeoStr(c, 120)).filter(Boolean)
    : (cats.length ? cats : COSTEO_CATS_DEFAULT.slice());
  return { version: 1, insumos, recetasBase: rbs, platos, categorias };
}
function costeoDefaults(){ return costeoBuildFromSeed('costeo-seed.json'); }
function costeoDefaultsBadass(){ return costeoBuildFromSeed('costeo-seed-badass.json'); }
function costeoDefaultsBarra(rest){ return costeoBuildFromSeed(costeoRestKey(rest) === 'badass' ? 'costeo-barra-seed-badass.json' : 'costeo-barra-seed-garden.json'); }
// El costeo es POR RESTAURANTE (garden / badass). Garden se siembra del Excel;
// Badass arranca vacío. Archivo: { garden:{...}, badass:{...} }.
const COSTEO_RESTS = ['garden', 'badass'];
const costeoRestKey = (r) => (r === 'badass' ? 'badass' : 'garden');
// Servicio dentro de cada restaurante: comida (default) o barra (tragos). Son 4
// conjuntos de datos independientes: garden, badass, garden_barra, badass_barra.
const costeoSvcKey = (s) => (s === 'barra' ? 'barra' : 'comida');
const costeoDocKey = (rest, svc) => costeoSvcKey(svc) === 'barra' ? costeoRestKey(rest) + '_barra' : costeoRestKey(rest);
function costeoEmpty(){ return { version: 1, insumos: [], recetasBase: [], platos: [], categorias: ['Rolls', 'Burgers', 'Papas', 'Ceviches/Tiraditos/Ensaladas', 'Principales', 'Huella del chef'] }; }
// REVENTA (solo barra): productos que se compran hechos y se revenden (cervezas,
// vinos, destilados, bebidas). NO llevan receta ni insumo: cada uno es
// { nombre, precioVenta, precioCompra }. El % de costo = compra ÷ venta y se
// calcula al vuelo. Estructura paralela al costeo con receta, no lo toca.
function costeoNumOrNull(v){ const n = Number(v); return (Number.isFinite(n) && n > 0) ? Math.round(n) : null; }
function costeoNormalizeReventa(r){
  r = r || {};
  const secciones = Array.isArray(r.secciones) ? r.secciones.map(s => ({
    id: costeoStr(s && s.id, 60) || randomUUID(),
    nombre: costeoStr(s && s.nombre, 120) || 'Sección',
    productos: Array.isArray(s && s.productos) ? s.productos.map(p => ({
      id: costeoStr(p && p.id, 60) || randomUUID(),
      nombre: costeoStr(p && p.nombre, 200) || 'Producto',
      precioVenta: costeoNumOrNull(p && p.precioVenta),
      precioCompra: costeoNumOrNull(p && p.precioCompra),
    })).filter(p => p.nombre) : [],
  })) : [];
  const v = Number.isFinite(r.v) ? r.v : 0;
  return { v, secciones };
}
function costeoNormalizeDoc(p){
  p = p || {};
  return {
    version: 1,
    insumos: Array.isArray(p.insumos) ? p.insumos : [],
    recetasBase: Array.isArray(p.recetasBase) ? p.recetasBase : [],
    platos: Array.isArray(p.platos) ? p.platos : [],
    categorias: (Array.isArray(p.categorias) && p.categorias.length) ? p.categorias : costeoEmpty().categorias,
    carta: costeoNormalizeCarta(p.carta),
    reventa: costeoNormalizeReventa(p.reventa),
  };
}
// Estructura de la CARTA real (Nivel 4): secciones ordenadas tal cual salen del
// menú público (gour.media), cada una con sus ítems (nombres de platos, incluso
// los que todavía no están costeados). El precio que se muestra SIEMPRE sale del
// costeo, la carta pública solo aporta el orden y las secciones.
//   asignaciones: platoId → seccionId (override manual). Valor '' = forzado a
//   "Sin asignar"; sin clave = auto-match por nombre.
function costeoNormalizeCarta(c){
  c = c || {};
  const secciones = Array.isArray(c.secciones) ? c.secciones.map(s => ({
    id: costeoStr(s && s.id, 60) || randomUUID(),
    nombre: costeoStr(s && s.nombre, 120) || 'Sección',
    reventa: !!(s && s.reventa), // secciones de reventa (cervezas, botellas, etc.): sin costeo
    items: Array.isArray(s && s.items) ? s.items
      .map(it => ({ nombre: costeoStr(typeof it === 'string' ? it : (it && it.nombre), 200) }))
      .filter(it => it.nombre) : [],
  })) : [];
  const asignaciones = (c.asignaciones && typeof c.asignaciones === 'object' && !Array.isArray(c.asignaciones)) ? { ...c.asignaciones } : {};
  const v = Number.isFinite(c.v) ? c.v : 0;   // versión del sembrado de secciones (migra una sola vez)
  const pv = Number.isFinite(c.pv) ? c.pv : 0; // versión de la migración de platos (renombres + categorías)
  const rv = Number.isFinite(c.rv) ? c.rv : 0; // versión del sembrado de precios de venta reales
  const biv = Number.isFinite(c.biv) ? c.biv : 0; // versión: barra bruto → neto+ILA (quita IVA)
  const cv = Number.isFinite(c.cv) ? c.cv : 0;   // versión: secciones reales + tragos de barra
  const smv = Number.isFinite(c.smv) ? c.smv : 0; // versión: override 100% carne RB SMASH
  const urv = Number.isFinite(c.urv) ? c.urv : 0; // versión: quitar flag "reventa" (todo se costea)
  const rvb = Number.isFinite(c.rvb) ? c.rvb : 0; // versión: sembrar productos de reventa de barra (destilados)
  return { v, pv, rv, biv, cv, smv, urv, rvb, secciones, asignaciones };
}
// Carta por defecto: agrupa los platos ya costeados por su categoría (respetando
// el orden de doc.categorias). Deja la pestaña Carta usable de una, antes de
// cargar el orden real del menú público.
function costeoDefaultCarta(doc){
  const order = (doc.categorias && doc.categorias.length) ? doc.categorias.slice() : [];
  const byCat = new Map();
  (doc.platos || []).forEach(p => {
    const c = costeoStr(p.categoria, 120) || 'Sin categoría';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p.nombre);
  });
  const cats = [...order.filter(c => byCat.has(c)), ...[...byCat.keys()].filter(c => !order.includes(c))];
  return { secciones: cats.map(c => ({ id: randomUUID(), nombre: c, items: byCat.get(c).map(n => ({ nombre: n })) })), asignaciones: {} };
}
// Secciones REALES del menú público (gour.media), en el orden en que aparecen en
// la carta. Cada sección lista los nombres de sus platos (incluso los que todavía
// no están costeados → se muestran como "sin costear"). Las secciones sin platos
// quedan vacías a propósito, para completarlas después con el reasignador manual.
// El precio mostrado SIEMPRE sale del costeo; esto solo aporta orden y secciones.
const COSTEO_CARTA_SEED = {
  garden: [
    { nombre: 'Almuerzo Silvestre (12:30-16:00)', items: ['Easy Lunch', 'Full Lunch'] },
    { nombre: 'Para Comenzar', items: ['goldmember mechada', 'Goldenmember Salmón', 'Gyosas Toad', 'Tiradito en la playa', 'Camarón que se duerme', 'Tartar del garden', 'Tartar Spicy Beef'] },
    { nombre: 'Para Compartir', items: ['Black Mamba Acevichado', 'Back in Black Anticuchero', 'Ostiones Batayaki', 'Empanadas de Lomo Salteado', 'El huerto de Antonella', 'Pollo Coronel Sanders', 'Mechada Elisa', 'Chorrillana Richard 55', 'Entraña de la madriguera'] },
    { nombre: 'Platos Principales', items: ['Poke', 'Lasagna bolognese di chef coniglio', 'Gnocchi Di Zucca', 'Mil-Amores', 'Costillitas del amor', 'Lomo liso del rancho', 'Mila-Nona'] },
    { nombre: 'La Huella del Chef', items: ['Salteado Cremoso Di Zucca', 'Fetuccini salteado', 'Salmon Fiorentina', 'Pepper Steak Cremoso'] },
    { nombre: 'Ensaladas', items: [] },
    { nombre: 'Ceviches', items: [] },
    { nombre: 'Makis', items: [] },
    { nombre: 'Entre panes (Burgers)', items: [] },
    { nombre: 'Guarniciones', items: [] },
    { nombre: 'Postres', items: [] },
    { nombre: 'Para tomar 0,0°', items: [] },
    { nombre: 'Banny dips', items: [] },
    { nombre: 'Agregados', items: [] },
  ],
  badass: [
    { nombre: 'Wild Lunch (12:30-16:00)', items: ['Easy Lunch', 'Big Lunch'] },
    { nombre: 'Para Empezar', items: ['Gyosas Fungi', 'The Boneless'] },
    { nombre: 'Para compartir', items: ['Goldmember', 'Tiradito Summer', 'Sexy Ceviche', 'Tartar Spicy Love', 'Pollo Coronel Sanders', 'Mechada Elisa', 'Lomo Liso Del Bigotudo'] },
    { nombre: 'La Huella Del Chef', items: ['Salmon Fiorentina', 'Salmon mediterraneo', 'Salmon Risotto Fungi', 'Salteado Cremoso Di Zucca', 'Pepper Steak Cremoso'] },
    { nombre: 'Platos Principales', items: ['Poke', 'Kung-fu Chicken', 'Pollito al Velador', 'Filete Chào Fan', 'Mil-Amores', 'Mila-Nona', 'Mila-gro al Pesto'] },
    { nombre: 'Ensaladas', items: ['Ensalada de Atún', 'Ensalada de Pollo', 'Ensalada de salmón', 'Ensalada de camarón'] },
    { nombre: 'Makis', items: ['Midori Veggi', 'Avocado Ganja Tare', 'Panko Roll It Baby', 'Crispy Chicken', 'Avocado Koopa Troopa'] },
    { nombre: 'Entre panes (Burgers)', items: [] },
    { nombre: 'Menu de niños', items: [] },
    { nombre: 'Postres', items: [] },
    { nombre: 'Guarniciones', items: [] },
    { nombre: 'Banny Dips', items: [] },
    { nombre: 'Para Tomar 0.0', items: [] },
  ],
};
// Versión del sembrado de secciones. Al subirla, la migración vuelve a plantar
// las secciones reales una vez por restaurante (sin pisar reasignaciones futuras
// hechas sobre esta misma versión).
const CARTA_REAL_V = 2;
// Deja el doc con las secciones REALES del menú (COSTEO_CARTA_SEED) si todavía no
// está en la versión actual. Reemplaza las secciones viejas (las que se armaban
// por categorías del Excel) y limpia las asignaciones manuales, porque apuntaban a
// secciones que ya no existen. Corre una sola vez por restaurante. Devuelve true
// si mutó el doc.
function costeoEnsureRealCarta(doc, rest){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  const key = costeoRestKey(rest);
  const seed = COSTEO_CARTA_SEED[key];
  if (seed) {
    if (doc.carta.v >= CARTA_REAL_V) return false;
    doc.carta.secciones = seed.map((s, i) => ({ id: `${key}-s${i + 1}`, nombre: s.nombre, items: (s.items || []).map(n => ({ nombre: n })) }));
    doc.carta.asignaciones = {};
    doc.carta.v = CARTA_REAL_V;
    return true;
  }
  // Restaurante sin seed real: default por categorías, una sola vez.
  if (!doc.carta.secciones.length && doc.platos && doc.platos.length) {
    doc.carta.secciones = costeoDefaultCarta(doc).secciones;
    return true;
  }
  return false;
}

// ── Migración de platos al vocabulario de la carta real (Nivel 3 + Carta) ──
// 1) Renombra platos que son la misma comida con distinta escritura, usando el
//    nombre de la carta pública como el correcto (así calzan solos).
// 2) Recategoriza cada plato a su sección de carta.
// 3) Deja las categorías del Nivel 3 = secciones reales del menú.
// Corre una sola vez (PLATOS_MIG_V) y NO toca las reasignaciones manuales ni las
// secciones (eso lo maneja costeoEnsureRealCarta / la versión v).
const PLATOS_MIG_V = 1;
// Renombres por restaurante: { nombreViejoDelCosteo: NombreDeLaCarta }. El match
// es por nombre normalizado suelto, así que da igual mayúsculas/acentos.
const COSTEO_PLATO_RENAMES = {
  garden: {
    'gnocchi di zuca': 'Gnocchi Di Zucca',
    'Salmon florentina': 'Salmon Fiorentina',
    'SALTEADO CREMOSO dizuca con lomo': 'Salteado Cremoso Di Zucca',
  },
  badass: {
    'milamores': 'Mil-Amores',
    'milagro al pesto': 'Mila-gro al Pesto',
    'Salmon florentina': 'Salmon Fiorentina',
    'Salmon risoto fungi': 'Salmon Risotto Fungi',
    'Rissoto dizuca con lomo': 'Salteado Cremoso Di Zucca',
    'ENSALADA SALMON': 'Ensalada de salmón',
  },
};
// Reglas por palabra clave (se aplican solo si esa sección existe en el restaurante).
const COSTEO_CAT_KEYWORDS = {
  garden: [{ re: /ensalada|cesar/, sec: 'Ensaladas' }, { re: /ceviche|tiradito|carpaccio/, sec: 'Ceviches' }],
  badass: [{ re: /ensalada/, sec: 'Ensaladas' }],
};
// Mapeo de las categorías viejas (Excel) → secciones de la carta real.
const COSTEO_OLDCAT_MAP = {
  garden: { 'Rolls': 'Makis', 'Burgers': 'Entre panes (Burgers)', 'Papas': 'Guarniciones', 'Ceviches/Tiraditos/Ensaladas': 'Ceviches', 'Principales': 'Platos Principales', 'Huella del chef': 'La Huella del Chef' },
  badass: { 'Rolls': 'Makis', 'Burgers': 'Entre panes (Burgers)', 'Entradas': 'Para Empezar', 'Principales': 'Platos Principales', 'Guarniciones': 'Guarniciones' },
};
function costeoMigratePlatos(doc, rest){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.pv >= PLATOS_MIG_V) return false;
  const key = costeoRestKey(rest);
  const seed = COSTEO_CARTA_SEED[key];
  if (!seed) { doc.carta.pv = PLATOS_MIG_V; return true; }
  // 1) Renombres.
  const renameByNorm = new Map(Object.entries(COSTEO_PLATO_RENAMES[key] || {}).map(([from, to]) => [costeoNormLoose(from), to]));
  (doc.platos || []).forEach(p => { const t = renameByNorm.get(costeoNormLoose(p.nombre)); if (t) p.nombre = t; });
  // 2) Recategorización a secciones reales.
  const sectionNames = seed.map(s => s.nombre);
  const sectionSet = new Set(sectionNames);
  const itemIndex = [];
  seed.forEach(s => (s.items || []).forEach(it => itemIndex.push({ sec: s.nombre, norm: costeoNormLoose(it) })));
  const asign = doc.carta.asignaciones || {};
  const secNameById = new Map(doc.carta.secciones.map(s => [s.id, s.nombre]));
  const kw = COSTEO_CAT_KEYWORDS[key] || [];
  const oldMap = COSTEO_OLDCAT_MAP[key] || {};
  (doc.platos || []).forEach(p => {
    // a) reasignación manual válida (respeta el trabajo manual del usuario)
    const man = asign[p.id];
    if (man && secNameById.has(man)) { p.categoria = secNameById.get(man); return; }
    const pn = costeoNormLoose(p.nombre);
    // b) match por ítem de la carta
    let hit = itemIndex.find(it => it.norm === pn) || itemIndex.find(it => it.norm && (it.norm.includes(pn) || pn.includes(it.norm)));
    if (hit) { p.categoria = hit.sec; return; }
    // c) palabra clave
    const k = kw.find(x => x.re.test(pn));
    if (k && sectionSet.has(k.sec)) { p.categoria = k.sec; return; }
    // d) mapa categoría vieja → sección
    const m = oldMap[p.categoria];
    if (m && sectionSet.has(m)) { p.categoria = m; return; }
    // e) fallback: si ya es una sección válida se deja; si no, primera sección real
    if (!sectionSet.has(p.categoria)) p.categoria = sectionNames[0];
  });
  // 3) Categorías del Nivel 3 = secciones reales del menú.
  doc.categorias = sectionNames.slice();
  doc.carta.pv = PLATOS_MIG_V;
  return true;
}

// ── Precios de venta REALES (los que se cobran al público) ──────────────────
// El precio real es un campo editable por plato (p.precioReal). La pestaña Carta
// lo muestra y calcula el % de costo real = Costo Final ÷ precio real. Acá se
// siembran los precios reales de las cartas actuales, una sola vez (PRECIO_REAL_V),
// matcheando por nombre. NO pisa un precio que el usuario ya haya cargado.
const PRECIO_REAL_V = 1;
const PRECIO_REAL_SEED = {
  garden: {
    'Easy Lunch': 8990, 'Full Lunch': 9990,
    'Goldenmember Salmón': 7970, 'Gyosas Toad': 8970, 'Tiradito en la playa': 12470, 'Camarón que se duerme': 10990, 'Tartar del garden': 12990, 'Tartar Spicy Beef': 14470,
    'Black Mamba Acevichado': 7970, 'Back in Black Anticuchero': 9470, 'Ostiones Batayaki': 9970, 'Empanadas de Lomo Salteado': 9970, 'El huerto de Antonella': 13990, 'Pollo Coronel Sanders': 16470, 'Mechada Elisa': 16970, 'Chorrillana Richard 55': 16970, 'Entraña de la madriguera': 19990,
    'Poke': 7990, 'Lasagna bolognese di chef coniglio': 11990, 'Gnocchi Di Zucca': 11990, 'Mil-Amores': 13970, 'Costillitas del amor': 16970, 'Lomo liso del rancho': 18470, 'Mila-Nona': 16970,
    'Salteado Cremoso Di Zucca': 14970, 'Fetuccini salteado': 15990, 'Salmon Fiorentina': 17970, 'Pepper Steak Cremoso': 19990,
  },
  badass: {
    'Easy Lunch': 8970, 'Big Lunch': 10970,
    'Gyosas Fungi': 8970, 'The Boneless': 9970,
    'Goldmember': 9970, 'Tiradito Summer': 12470, 'Sexy Ceviche': 14970, 'Tartar Spicy Love': 14970, 'Pollo Coronel Sanders': 16470, 'Mechada Elisa': 16970, 'Lomo Liso Del Bigotudo': 18470,
    'Salmon Fiorentina': 19970, 'Salmon mediterraneo': 19970, 'Salmon Risotto Fungi': 18970, 'Salteado Cremoso Di Zucca': 19970, 'Pepper Steak Cremoso': 19970,
    'Poke': 8970, 'Kung-fu Chicken': 12470, 'Pollito al Velador': 13470, 'Filete Chào Fan': 13970, 'Mil-Amores': 15970, 'Mila-Nona': 16970, 'Mila-gro al Pesto': 16970,
    'Ensalada de Atún': 11970, 'Ensalada de Pollo': 11970, 'Ensalada de salmón': 11970, 'Ensalada de camarón': 11970,
    'Midori Veggi': 4970, 'Avocado Ganja Tare': 4970, 'Panko Roll It Baby': 4970, 'Crispy Chicken': 5470, 'Avocado Koopa Troopa': 4970,
  },
};
function costeoSeedPreciosReales(doc, rest){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.rv >= PRECIO_REAL_V) return false;
  const map = PRECIO_REAL_SEED[costeoRestKey(rest)] || {};
  const entries = Object.entries(map).map(([n, price]) => ({ norm: costeoNormLoose(n), price }));
  (doc.platos || []).forEach(p => {
    if (p.precioReal != null) return; // no pisar lo que el usuario ya cargó
    const pn = costeoNormLoose(p.nombre);
    if (!pn) return;
    let e = entries.find(x => x.norm === pn);
    if (!e) e = entries.find(x => x.norm && (pn.includes(x.norm) || x.norm.includes(pn)));
    if (e) p.precioReal = e.price;
  });
  doc.carta.rv = PRECIO_REAL_V;
  return true;
}
// Migración de platos: el archivo costeo.json ya existía (con insumos/RB guardados)
// antes de que existiera el Nivel 3, así que la semilla nunca inyectó los platos.
// Acá se siembran los 75 platos del seed resolviendo cada línea POR NOMBRE contra
// los insumos/RB reales del doc (no contra los ids del seed). Solo corre una vez:
// si el doc tiene insumos pero 0 platos. Devuelve true si mutó el doc.
function costeoSeedPlatosInto(doc){
  if (!doc || (doc.platos && doc.platos.length) || !(doc.insumos && doc.insumos.length)) return false;
  let seed = { platos: [] };
  try { seed = JSON.parse(readFileSync(join(__dirname, 'costeo-seed.json'), 'utf-8')); } catch { return false; }
  if (!Array.isArray(seed.platos) || !seed.platos.length) return false;
  const byName = new Map(); doc.insumos.forEach(i => byName.set(costeoNorm(i.descripcion), i.id));
  const rbByName = new Map(); (doc.recetasBase || []).forEach(r => rbByName.set(costeoNorm(r.nombre), r.id));
  doc.platos = seed.platos.map(x => {
    const lineas = (x.lineas || []).map(l => {
      const k = costeoNorm(l.ref);
      if (rbByName.has(k)) return { refType: 'rb', refId: rbByName.get(k), cantidad: Number(l.cantidad) || 0 };
      if (byName.has(k)) return { refType: 'insumo', refId: byName.get(k), cantidad: Number(l.cantidad) || 0 };
      return null;
    }).filter(Boolean);
    const m = Number(x.margenPct); const margenPct = (m > 0 && m <= 100) ? m : 30;
    return { id: randomUUID(), nombre: costeoStr(x.nombre, 200), categoria: costeoStr(x.categoria, 120) || 'Sin categoría', margenPct, lineas };
  });
  return true;
}
const costeoDocEmpty = (doc) => !doc || (!(doc.insumos && doc.insumos.length) && !(doc.recetasBase && doc.recetasBase.length) && !(doc.platos && doc.platos.length));
const costeoSeccionesFromCategorias = (cats) => (cats || []).map(c => ({ id: randomUUID(), nombre: c, items: [] }));
// Barra: la carta usa las categorías como secciones (los tragos se agrupan por
// categoría, igual que comida por su sección). Siembra las secciones una vez.
function costeoEnsureBarraCarta(doc){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.secciones.length) return false;
  if (!(doc.categorias && doc.categorias.length)) return false;
  doc.carta.secciones = costeoSeccionesFromCategorias(doc.categorias);
  return true;
}
// Migración de precios de barra: el valor cargado era BRUTO (con IVA e ILA). Se
// pasa a NETO + ILA quitando el IVA (÷1,19) y el ILA por insumo arranca en 0. Así
// el costo del trago usa (neto+ILA)÷volumen y el IVA queda a nivel de trago. Corre
// una sola vez por doc de barra (biv). Devuelve true si mutó.
const BARRA_ILA_V = 1;
function costeoMigrateBarraIla(doc){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.biv >= BARRA_ILA_V) return false;
  (doc.insumos || []).forEach(i => {
    if (i.volumen && i.volumen > 0) {
      i.precioNeto = Math.round((Number(i.precioNeto) || 0) / 1.19);
      if (i.ila == null) i.ila = 0;
    }
  });
  doc.carta.biv = BARRA_ILA_V;
  return true;
}
const costeoBarraSeedFile = (rest) => costeoRestKey(rest) === 'badass' ? 'costeo-barra-seed-badass.json' : 'costeo-barra-seed-garden.json';
// Siembra los TRAGOS de barra desde el seed, resolviendo cada línea POR NOMBRE contra
// los insumos/RB del doc (como costeoSeedPlatosInto, pero con precioReal/iva/categoría).
// Solo corre si el doc no tiene platos todavía. Devuelve true si mutó.
function costeoSeedBarraTragosInto(doc, rest){
  if (!doc || (doc.platos && doc.platos.length)) return false;
  let seed; try { seed = JSON.parse(readFileSync(join(__dirname, costeoBarraSeedFile(rest)), 'utf-8')); } catch { return false; }
  if (!Array.isArray(seed.platos) || !seed.platos.length) return false;
  const byName = new Map(); (doc.insumos || []).forEach(i => byName.set(costeoNorm(i.descripcion), i.id));
  const rbByName = new Map(); (doc.recetasBase || []).forEach(r => rbByName.set(costeoNorm(r.nombre), r.id));
  doc.platos = seed.platos.map(x => {
    const lineas = (x.lineas || []).map(l => {
      const k = costeoNorm(l.ref);
      if (rbByName.has(k)) return { refType: 'rb', refId: rbByName.get(k), cantidad: Number(l.cantidad) || 0 };
      if (byName.has(k)) return { refType: 'insumo', refId: byName.get(k), cantidad: Number(l.cantidad) || 0 };
      return null;
    }).filter(Boolean);
    const m = Number(x.margenPct); const margenPct = (m > 0 && m <= 100) ? m : 30;
    const precioReal = (Number(x.precioReal) > 0) ? Math.round(Number(x.precioReal)) : null;
    const p = { id: randomUUID(), nombre: costeoStr(x.nombre, 200), categoria: costeoStr(x.categoria, 120) || 'Sin categoría', margenPct, lineas, precioReal };
    if (x.iva === false) p.iva = false; else if (x.iva === true) p.iva = true;
    return p;
  });
  return true;
}
// Migración de la CARTA de barra (Nivel 4): planta las secciones reales del menú de
// tragos (orden + reventa) desde el seed, categorías = secciones, y siembra los tragos.
// Una vez por doc de barra (carta.cv). No pisa reasignaciones porque las viejas
// apuntaban a secciones que ya no existen.
const BARRA_CARTA_V = 1;
function costeoMigrateBarraCarta(doc, rest){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.cv >= BARRA_CARTA_V) return false;
  let seed; try { seed = JSON.parse(readFileSync(join(__dirname, costeoBarraSeedFile(rest)), 'utf-8')); } catch { return false; }
  const secs = Array.isArray(seed.cartaSecciones) ? seed.cartaSecciones : (seed.categorias || []).map(n => ({ nombre: n }));
  const key = costeoRestKey(rest);
  doc.carta.secciones = secs.map((sc, i) => ({ id: `${key}-b${i + 1}`, nombre: costeoStr(typeof sc === 'string' ? sc : sc.nombre, 120), reventa: false, items: [] }));
  doc.carta.asignaciones = {};
  doc.categorias = doc.carta.secciones.map(s => s.nombre);
  costeoSeedBarraTragosInto(doc, rest);
  doc.carta.cv = BARRA_CARTA_V;
  return true;
}
// Aplica una sola vez override de rendimiento 100% (sin merma) a las líneas de carne
// de la RB SMASH: la carne se muele entera, no se limpia. Corre por doc de comida.
const SMASH_REND_V = 1;
function costeoApplySmashOverride(doc){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.smv >= SMASH_REND_V) return false;
  (doc.recetasBase || []).forEach(rb => {
    if (!/smash/i.test(rb.nombre || '')) return;
    (rb.lineas || []).forEach(l => {
      if (l.refType !== 'insumo' || l.rend != null) return;
      const ins = (doc.insumos || []).find(i => i.id === l.refId);
      if (ins && /tapapecho|sobrecostilla|carne|posta/i.test(ins.descripcion || '')) l.rend = 1;
    });
  });
  doc.carta.smv = SMASH_REND_V;
  return true;
}
// Quita el flag "reventa" de las secciones de barra ya existentes: ahora todo se
// costea (cervezas, botellas, destilados, etc. también llevan costo y precio).
const BARRA_UNREVENTA_V = 1;
function costeoUnreventaBarra(doc){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.urv >= BARRA_UNREVENTA_V) return false;
  (doc.carta.secciones || []).forEach(s => { s.reventa = false; });
  doc.carta.urv = BARRA_UNREVENTA_V;
  return true;
}
// Siembra los productos de REVENTA de barra (destilados: cortos + botellas) desde
// el bloque seed.reventa (hoja PRECIO CORTOS del Excel). Cada marca → un insumo
// (precio por litro NETO = precioPromedio÷1,19, ILA en 0 como el resto de barra) y
// uno o dos productos: corto (60/45ml) y botella (0,7L). Dedupe de insumos por
// nombre para no duplicar los que ya existen. Corre una vez por doc (carta.rvb).
// Solo Garden trae seed.reventa; Badass no → no-op. Devuelve true si mutó.
const BARRA_REVENTA_V = 1;
function costeoSeedReventaBarra(doc, rest){
  if (!doc) return false;
  doc.carta = costeoNormalizeCarta(doc.carta);
  if (doc.carta.rvb >= BARRA_REVENTA_V) return false;
  let seed; try { seed = JSON.parse(readFileSync(join(__dirname, costeoBarraSeedFile(rest)), 'utf-8')); } catch { seed = null; }
  const rev = seed && seed.reventa;
  if (rev && Array.isArray(rev.insumos) && rev.insumos.length) {
    const byName = new Map(); (doc.insumos || []).forEach(i => byName.set(costeoNorm(i.descripcion), i.id));
    rev.insumos.forEach(ri => {
      const desc = costeoStr(ri.descripcion, 200); if (!desc) return;
      const k = costeoNorm(desc); if (byName.has(k)) return;
      const id = randomUUID();
      doc.insumos.push({ id, descripcion: desc, precioNeto: Math.round(Number(ri.precioNeto) || 0), unidad: costeoUnit(ri.unidad || 'litro'), volumen: (Number(ri.volumen) > 0) ? Number(ri.volumen) : 1, ila: Number(ri.ila) || 0, despacho: 0, rendimiento: null });
      byName.set(k, id);
    });
    (rev.productos || []).forEach(rp => {
      const lineas = (rp.lineas || []).map(l => { const id = byName.get(costeoNorm(l.ref)); return id ? { refType: 'insumo', refId: id, cantidad: Number(l.cantidad) || 0 } : null; }).filter(Boolean);
      if (!lineas.length) return;
      const m = Number(rp.margenPct); const margenPct = (m > 0 && m <= 100) ? m : 30;
      doc.platos.push({ id: randomUUID(), nombre: costeoStr(rp.nombre, 200), categoria: costeoStr(rp.categoria, 120) || 'Sin categoría', margenPct, lineas, precioReal: null, iva: false });
    });
  }
  doc.carta.rvb = BARRA_REVENTA_V;
  return true;
}
// Asegura los 2 docs de barra (garden_barra / badass_barra): los siembra desde el
// Excel de barra si están vacíos y planta sus secciones de carta. Devuelve true si mutó.
function costeoEnsureBarraDocs(all){
  let ch = false;
  for (const [key, rest] of [['garden_barra', 'garden'], ['badass_barra', 'badass']]) {
    all[key] = costeoNormalizeDoc(all[key]);
    if (costeoDocEmpty(all[key])) { all[key] = costeoDefaultsBarra(rest); ch = true; }
    if (costeoEnsureBarraCarta(all[key])) ch = true;
    if (costeoMigrateBarraIla(all[key])) ch = true;
    if (costeoMigrateBarraCarta(all[key], rest)) ch = true;
    if (costeoUnreventaBarra(all[key])) ch = true;
    if (costeoSeedReventaBarra(all[key], rest)) ch = true;
  }
  return ch;
}
function loadCosteoAll(){
  try {
    if (!existsSync(COSTEO_FILE)) { const all = { garden: costeoDefaults(), badass: costeoDefaultsBadass() }; costeoEnsureRealCarta(all.garden, 'garden'); costeoEnsureRealCarta(all.badass, 'badass'); costeoMigratePlatos(all.garden, 'garden'); costeoMigratePlatos(all.badass, 'badass'); costeoSeedPreciosReales(all.garden, 'garden'); costeoSeedPreciosReales(all.badass, 'badass'); costeoEnsureBarraDocs(all); costeoApplySmashOverride(all.garden); costeoApplySmashOverride(all.badass); saveCosteoAll(all); return all; }
    const p = JSON.parse(readFileSync(COSTEO_FILE, 'utf-8'));
    // Migración: archivo viejo con la data en la raíz → pasa a "garden".
    if (Array.isArray(p.insumos)) { const g = costeoNormalizeDoc(p); costeoSeedPlatosInto(g); costeoEnsureRealCarta(g, 'garden'); costeoMigratePlatos(g, 'garden'); costeoSeedPreciosReales(g, 'garden'); const all = { garden: g, badass: costeoDefaultsBadass() }; costeoEnsureRealCarta(all.badass, 'badass'); costeoMigratePlatos(all.badass, 'badass'); costeoSeedPreciosReales(all.badass, 'badass'); costeoEnsureBarraDocs(all); costeoApplySmashOverride(all.garden); costeoApplySmashOverride(all.badass); saveCosteoAll(all); return all; }
    const all = { garden: costeoNormalizeDoc(p.garden), badass: costeoNormalizeDoc(p.badass), garden_barra: p.garden_barra, badass_barra: p.badass_barra };
    let changed = false;
    if (costeoSeedPlatosInto(all.garden)) changed = true;
    // Badass: si está completamente vacío, se siembra full desde el Excel de Badass.
    if (costeoDocEmpty(all.badass)) { all.badass = costeoDefaultsBadass(); changed = true; }
    // Carta (Nivel 4): planta/actualiza las secciones REALES del menú (una vez por versión).
    if (costeoEnsureRealCarta(all.garden, 'garden')) changed = true;
    if (costeoEnsureRealCarta(all.badass, 'badass')) changed = true;
    // Migración de platos: renombres + categorías = secciones reales (una vez).
    if (costeoMigratePlatos(all.garden, 'garden')) changed = true;
    if (costeoMigratePlatos(all.badass, 'badass')) changed = true;
    // Precios de venta reales: seed inicial (una vez), sin pisar lo que el usuario cargó.
    if (costeoSeedPreciosReales(all.garden, 'garden')) changed = true;
    if (costeoSeedPreciosReales(all.badass, 'badass')) changed = true;
    // Barra: siembra los 2 conjuntos de tragos (una vez). Comida queda intacta.
    if (costeoEnsureBarraDocs(all)) changed = true;
    // Override 100% en la carne de RB SMASH (una vez por doc de comida).
    if (costeoApplySmashOverride(all.garden)) changed = true;
    if (costeoApplySmashOverride(all.badass)) changed = true;
    if (changed) saveCosteoAll(all);
    return all;
  } catch (e) { console.warn('costeo load:', e.message); const all = { garden: costeoDefaults(), badass: costeoDefaultsBadass() }; costeoEnsureBarraDocs(all); return all; }
}
function saveCosteoAll(all){ if (PROMPTS_OVERRIDE_DIR && !existsSync(PROMPTS_OVERRIDE_DIR)) mkdirSync(PROMPTS_OVERRIDE_DIR, { recursive: true }); writeFileSync(COSTEO_FILE, JSON.stringify(all, null, 2)); }
function loadCosteo(rest, svc){ return loadCosteoAll()[costeoDocKey(rest, svc)]; }
function saveCosteo(rest, svc, doc){ const all = loadCosteoAll(); all[costeoDocKey(rest, svc)] = doc; saveCosteoAll(all); }
// Precio por unidad usado en el costeo. Barra: (precio neto + ILA) ÷ volumen de
// botella (= precio por litro, sin IVA — el IVA se aplica a nivel de trago).
// Comida: precioNeto ÷ rendimiento (o precioNeto). El ILA solo aplica a barra.
// Un rendimiento override (0<r<=1) por línea pisa el del insumo SOLO para esa línea
// (ej: carne molida de smash → 100%, sin merma). El precio neto sigue viviendo en el
// insumo; el override solo cambia el divisor de rendimiento. No aplica a barra (volumen).
function insumoPrecioReal(i, rendOverride){
  if (i.volumen && i.volumen > 0) {
    // (neto + ILA) + despacho (el despacho es neto, sin ILA), todo ÷ volumen.
    const conIla = (Number(i.precioNeto) || 0) * (1 + (Number(i.ila) || 0) / 100) + (Number(i.despacho) || 0);
    return Math.round(conIla / i.volumen);
  }
  // Comida: precio por unidad = (neto ÷ formato) ÷ rendimiento. El formato es la
  // cantidad que cubre el precio neto (ej: $500 por 0,5 kg → $1.000/kg). Default 1.
  const base = (Number(i.formato) > 0) ? (Number(i.precioNeto) || 0) / Number(i.formato) : (Number(i.precioNeto) || 0);
  const rend = (Number(rendOverride) > 0 && Number(rendOverride) <= 1) ? Number(rendOverride) : i.rendimiento;
  return (rend && rend > 0) ? Math.round(base / rend) : Math.round(base);
}
// ¿El rendimiento/override aplica a esta línea? Solo si referencia un insumo de comida
// (sin volumen) que tenga rendimiento cargado.
function costeoRendAplica(ins){ return !!(ins && !(ins.volumen > 0) && Number(ins.rendimiento) > 0); }
const costeoRendOv = (r) => (Number(r) > 0 && Number(r) <= 1) ? Number(r) : null;

// Resuelve todo en cascada (RB con memo + guard de ciclos). Un cambio de precio
// de insumo se propaga solo porque nada derivado está guardado.
function resolveCosteo(d){
  const insById = new Map(d.insumos.map(i => [i.id, i]));
  const rbById = new Map(d.recetasBase.map(r => [r.id, r]));
  const insReal = new Map(d.insumos.map(i => [i.id, insumoPrecioReal(i)]));
  const rbMemo = new Map();
  // rendOv: override de rendimiento de la línea (0<r<=1) — solo afecta insumos de comida.
  const priceOf = (refType, refId, stack, rendOv) => {
    if (refType === 'insumo') {
      const ins = insById.get(refId); if (!ins) return 0;
      return (rendOv != null && costeoRendAplica(ins)) ? insumoPrecioReal(ins, rendOv) : (insReal.get(refId) || 0);
    }
    if (refType === 'rb') { const r = rbById.get(refId); return r ? rbUnit(r, stack) : 0; }
    return 0;
  };
  function rbUnit(rb, stack){
    if (rbMemo.has(rb.id)) return rbMemo.get(rb.id);
    if (stack.includes(rb.id)) return 0;
    const s = [...stack, rb.id];
    let costo = 0;
    for (const l of (rb.lineas || [])) costo += (Number(l.cantidad) || 0) * priceOf(l.refType, l.refId, s, l.rend);
    const pu = rb.produccion > 0 ? Math.round(costo / rb.produccion) : 0;
    rbMemo.set(rb.id, pu);
    rb._costoTotal = Math.round(costo); rb._precioUnidad = pu;
    return pu;
  }
  d.recetasBase.forEach(rb => rbUnit(rb, []));
  const ingredientes = [
    ...d.insumos.map(i => ({ type: 'insumo', id: i.id, nombre: i.descripcion, unidad: i.unidad, precio: insReal.get(i.id), rendimiento: costeoRendAplica(i) ? i.rendimiento : null, base100: insumoPrecioReal(i, 1) })),
    ...d.recetasBase.map(r => ({ type: 'rb', id: r.id, nombre: r.nombre, unidad: r.unidad, precio: r._precioUnidad || 0, rendimiento: null, base100: null })),
  ];
  const insumos = d.insumos.map(i => ({ ...i, precioReal: insReal.get(i.id) }));
  // Salida de una línea con toda la info de rendimiento (para la UI y el override).
  const lineOut = (l) => {
    const ins = l.refType === 'insumo' ? insById.get(l.refId) : null;
    const ing = ins || (l.refType === 'rb' ? rbById.get(l.refId) : null);
    const rendAplica = costeoRendAplica(ins);
    const rend = rendAplica ? costeoRendOv(l.rend) : null;
    const precio = priceOf(l.refType, l.refId, [], l.rend);
    return {
      refType: l.refType, refId: l.refId, nombre: ing ? (ing.descripcion || ing.nombre) : '(eliminado)',
      unidad: ing ? ing.unidad : '', precio, cantidad: l.cantidad, costo: Math.round((Number(l.cantidad) || 0) * precio),
      rendAplica, rendInsumo: rendAplica ? ins.rendimiento : null, rend, base100: (ins && rendAplica) ? insumoPrecioReal(ins, 1) : null,
    };
  };
  const recetasBase = d.recetasBase.map(rb => ({
    id: rb.id, nombre: rb.nombre, unidad: rb.unidad, produccion: rb.produccion,
    costoTotal: rb._costoTotal || 0, precioUnidad: rb._precioUnidad || 0,
    lineas: (rb.lineas || []).map(lineOut),
  }));
  // Platos (Nivel 3): cadena de costo exacta.
  // CostoTotal insumos → Protección 10% → IVA 19% sobre (CostoTotal+Protección)
  // → Costo Final → Precio Venta = Costo Final / margen → % costo = CostoFinal / PrecioVenta.
  const platos = (d.platos || []).map(p => {
    const lineas = (p.lineas || []).map(lineOut);
    const costoTotal = lineas.reduce((a, l) => a + l.costo, 0);
    const proteccion = costoTotal * 0.10;
    // IVA opcional por producto (barra: algunos tragos no llevan IVA). Default: sí.
    const ivaAplica = (p.iva === false) ? false : true;
    const iva = ivaAplica ? (costoTotal + proteccion) * 0.19 : 0;
    const costoFinal = costoTotal + proteccion + iva;
    const margenPct = (Number(p.margenPct) > 0 && Number(p.margenPct) <= 100) ? Number(p.margenPct) : 30;
    const precioVenta = margenPct > 0 ? costoFinal / (margenPct / 100) : 0;
    const precioVentaRedondeado = precioVenta > 0 ? Math.round(precioVenta / 100) * 100 : 0;
    const pctCosto = precioVenta > 0 ? (costoFinal / precioVenta) * 100 : 0;
    const precioReal = (Number(p.precioReal) > 0) ? Math.round(Number(p.precioReal)) : null;
    // % de costo REAL (contra el precio de venta que se cobra); null si no hay precio real cargado.
    const pctCostoReal = precioReal ? Math.round((costoFinal / precioReal) * 1000) / 10 : null;
    return {
      id: p.id, nombre: p.nombre, categoria: p.categoria || 'Sin categoría', margenPct, lineas,
      costoTotal: Math.round(costoTotal), proteccion: Math.round(proteccion), iva: Math.round(iva),
      costoFinal: Math.round(costoFinal), precioVenta: Math.round(precioVenta),
      precioVentaRedondeado, pctCosto: Math.round(pctCosto * 10) / 10,
      precioReal, pctCostoReal, ivaAplica,
    };
  });
  return { insumos, recetasBase, ingredientes, platos, categorias: d.categorias };
}

app.get('/admin/costeo', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const svc = costeoSvcKey(req.query.svc);
  res.json({ restaurante: rest, servicio: svc, ...resolveCosteo(loadCosteo(rest, svc)) });
});

// ── Insumos (Nivel 1) ──
app.post('/admin/costeo/insumos', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {}; const desc = costeoStr(b.descripcion, 200);
  if (!desc) return res.status(400).json({ error: 'La descripción es obligatoria.' });
  const d = loadCosteo(rest, req.query.svc);
  const volumen = (Number(b.volumen) > 0) ? Number(b.volumen) : null;
  const ila = (Number(b.ila) > 0) ? Number(b.ila) : (volumen ? 0 : null);
  const despacho = (Number(b.despacho) > 0) ? Math.round(Number(b.despacho)) : (volumen ? 0 : null);
  const formato = (Number(b.formato) > 0) ? Number(b.formato) : null;
  d.insumos.push({ id: randomUUID(), descripcion: desc, precioNeto: Number(b.precioNeto) || 0, unidad: costeoUnit(b.unidad), rendimiento: (Number(b.rendimiento) > 0 && Number(b.rendimiento) <= 1) ? Number(b.rendimiento) : null, formato, volumen, ila, despacho });
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
app.put('/admin/costeo/insumos/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const i = d.insumos.find(x => x.id === String(req.params.id));
  if (!i) return res.status(404).json({ error: 'Insumo no encontrado.' });
  const b = req.body || {};
  if (b.descripcion !== undefined) { const v = costeoStr(b.descripcion, 200); if (!v) return res.status(400).json({ error: 'Descripción vacía.' }); i.descripcion = v; }
  if (b.precioNeto !== undefined) i.precioNeto = Number(b.precioNeto) || 0;
  if (b.unidad !== undefined) i.unidad = costeoUnit(b.unidad);
  if (b.rendimiento !== undefined) i.rendimiento = (Number(b.rendimiento) > 0 && Number(b.rendimiento) <= 1) ? Number(b.rendimiento) : null;
  if (b.formato !== undefined) i.formato = (Number(b.formato) > 0) ? Number(b.formato) : null;
  if (b.volumen !== undefined) i.volumen = (Number(b.volumen) > 0) ? Number(b.volumen) : null;
  if (b.ila !== undefined) i.ila = (Number(b.ila) > 0) ? Number(b.ila) : 0;
  if (b.despacho !== undefined) i.despacho = (Number(b.despacho) > 0) ? Math.round(Number(b.despacho)) : 0;
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
app.delete('/admin/costeo/insumos/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const before = d.insumos.length;
  d.insumos = d.insumos.filter(x => x.id !== String(req.params.id));
  if (d.insumos.length === before) return res.status(404).json({ error: 'Insumo no encontrado.' });
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});

// ── Recetas base (Nivel 2) ──
function normalizeRBLineas(raw){
  return (Array.isArray(raw) ? raw : []).map(l => {
    const out = { refType: l.refType === 'rb' ? 'rb' : 'insumo', refId: String(l.refId || ''), cantidad: Number(l.cantidad) || 0 };
    // Override de rendimiento por línea (0<r<=1). Solo se guarda si viene válido.
    const rend = Number(l.rend);
    if (rend > 0 && rend <= 1) out.rend = rend;
    return out;
  }).filter(l => l.refId);
}
app.post('/admin/costeo/recetas', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {}; const nombre = costeoStr(b.nombre, 200);
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const d = loadCosteo(rest, req.query.svc);
  d.recetasBase.push({ id: randomUUID(), nombre, unidad: costeoUnit(b.unidad), produccion: Number(b.produccion) || 0, lineas: normalizeRBLineas(b.lineas) });
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
app.put('/admin/costeo/recetas/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const rb = d.recetasBase.find(x => x.id === String(req.params.id));
  if (!rb) return res.status(404).json({ error: 'Receta no encontrada.' });
  const b = req.body || {};
  if (b.nombre !== undefined) { const v = costeoStr(b.nombre, 200); if (!v) return res.status(400).json({ error: 'Nombre vacío.' }); rb.nombre = v; }
  if (b.unidad !== undefined) rb.unidad = costeoUnit(b.unidad);
  if (b.produccion !== undefined) rb.produccion = Number(b.produccion) || 0;
  if (b.lineas !== undefined) rb.lineas = normalizeRBLineas(b.lineas);
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
app.delete('/admin/costeo/recetas/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const before = d.recetasBase.length;
  d.recetasBase = d.recetasBase.filter(x => x.id !== String(req.params.id));
  if (d.recetasBase.length === before) return res.status(404).json({ error: 'Receta no encontrada.' });
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});

// ── Platos (Nivel 3) ──
// Mismo modelo de lineas que RB: cada linea referencia un insumo o una RB + gramaje.
function costeoMargen(v){ const m = Number(v); return (m > 0 && m <= 100) ? m : 30; }
app.post('/admin/costeo/platos', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {}; const nombre = costeoStr(b.nombre, 200);
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  const d = loadCosteo(rest, req.query.svc);
  const categoria = costeoStr(b.categoria, 120) || (d.categorias[0] || 'Sin categoría');
  const precioReal = (Number(b.precioReal) > 0) ? Math.round(Number(b.precioReal)) : null;
  const plato = { id: randomUUID(), nombre, categoria, margenPct: costeoMargen(b.margenPct), precioReal, lineas: normalizeRBLineas(b.lineas) };
  if (b.iva === false || b.iva === true) plato.iva = b.iva;
  d.platos.push(plato);
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
app.put('/admin/costeo/platos/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const p = d.platos.find(x => x.id === String(req.params.id));
  if (!p) return res.status(404).json({ error: 'Plato no encontrado.' });
  const b = req.body || {};
  if (b.nombre !== undefined) { const v = costeoStr(b.nombre, 200); if (!v) return res.status(400).json({ error: 'Nombre vacío.' }); p.nombre = v; }
  if (b.categoria !== undefined) p.categoria = costeoStr(b.categoria, 120) || p.categoria;
  if (b.margenPct !== undefined) p.margenPct = costeoMargen(b.margenPct);
  if (b.precioReal !== undefined) p.precioReal = (Number(b.precioReal) > 0) ? Math.round(Number(b.precioReal)) : null;
  if (b.iva !== undefined) p.iva = (b.iva === false) ? false : true;
  if (b.lineas !== undefined) p.lineas = normalizeRBLineas(b.lineas);
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
// Editar el precio de venta REAL de un plato (desde la pestaña Carta). '' / 0 → sin precio.
app.post('/admin/costeo/carta/precio-real', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {};
  const platoId = String(b.platoId || ''); if (!platoId) return res.status(400).json({ error: 'Falta platoId.' });
  const d = loadCosteo(rest, req.query.svc); const p = (d.platos || []).find(x => x.id === platoId);
  if (!p) return res.status(404).json({ error: 'Plato no encontrado.' });
  p.precioReal = (Number(b.precioReal) > 0) ? Math.round(Number(b.precioReal)) : null;
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true, precioReal: p.precioReal });
});
app.delete('/admin/costeo/platos/:id', requireAdmin, (req, res) => {
  const rest = req.query.rest; const d = loadCosteo(rest, req.query.svc); const before = d.platos.length;
  d.platos = d.platos.filter(x => x.id !== String(req.params.id));
  if (d.platos.length === before) return res.status(404).json({ error: 'Plato no encontrado.' });
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});

// ── Carta (Nivel 4): platos costeados organizados por las secciones del menú ──
// Cruza los platos costeados (con su precio de venta sugerido) contra la
// estructura de secciones/ítems del menú público. El match es por nombre
// normalizado; la asignación manual (asignaciones) siempre gana.
function resolveCarta(doc){
  const resolved = resolveCosteo(doc);
  const carta = costeoNormalizeCarta(doc.carta);
  const asign = carta.asignaciones || {};
  const platos = resolved.platos;
  const secIds = new Set(carta.secciones.map(s => s.id));
  // Índice de secciones por NOMBRE (para calzar por la categoría del plato) y de
  // ítems del menú (para el auto-match por nombre). Todo con normalización suelta.
  const secByName = new Map(carta.secciones.map(s => [costeoNormLoose(s.nombre), s.id]));
  const itemIndex = [];
  carta.secciones.forEach(s => (s.items || []).forEach(it => itemIndex.push({ seccionId: s.id, norm: costeoNormLoose(it.nombre) })));
  // Sección resuelta de cada plato: manual > categoría = sección > auto por nombre > (sin asignar).
  const platoSection = new Map();
  platos.forEach(p => {
    const manual = asign[p.id];
    if (manual !== undefined) { if (manual && secIds.has(manual)) platoSection.set(p.id, manual); return; }
    const cat = secByName.get(costeoNormLoose(p.categoria));
    if (cat) { platoSection.set(p.id, cat); return; }
    const pn = costeoNormLoose(p.nombre);
    if (!pn) return;
    let hit = itemIndex.find(it => it.norm === pn);
    if (!hit) hit = itemIndex.find(it => it.norm && (it.norm.includes(pn) || pn.includes(it.norm)));
    if (hit) platoSection.set(p.id, hit.seccionId);
  });
  // La Carta usa el precio de venta REAL y el % de costo contra ese real.
  const slim = (p) => ({ id: p.id, nombre: p.nombre, categoria: p.categoria, precioReal: p.precioReal, precioSugerido: p.precioVentaRedondeado, costo: p.costoFinal, pctCosto: p.pctCostoReal });
  const secciones = carta.secciones.map(s => {
    const platosSec = platos.filter(p => platoSection.get(p.id) === s.id).map(slim).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const secNorms = platosSec.map(p => costeoNormLoose(p.nombre));
    // Ítem "sin costear" = nombre del menú que ningún plato costeado de la sección cubre.
    const sinCostear = (s.items || []).filter(it => {
      const n = costeoNormLoose(it.nombre);
      return n && !secNorms.some(pn => pn === n || pn.includes(n) || n.includes(pn));
    }).map(it => it.nombre);
    return { id: s.id, nombre: s.nombre, reventa: !!s.reventa, platos: platosSec, sinCostear };
  });
  const sinAsignar = platos.filter(p => !platoSection.has(p.id)).map(slim).sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { secciones, sinAsignar, meta: { totalPlatos: platos.length, totalSecciones: carta.secciones.length } };
}

app.get('/admin/costeo/carta', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const svc = costeoSvcKey(req.query.svc);
  res.json({ restaurante: rest, servicio: svc, ...resolveCarta(loadCosteo(rest, svc)) });
});
// Reasignar un plato a otra sección. seccionId: id válido → esa sección;
// '' → forzar "Sin asignar"; '__auto__' → volver al auto-match por nombre.
app.post('/admin/costeo/carta/asignar', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {};
  const platoId = String(b.platoId || ''); if (!platoId) return res.status(400).json({ error: 'Falta platoId.' });
  const d = loadCosteo(rest, req.query.svc); d.carta = costeoNormalizeCarta(d.carta);
  const seccionId = String(b.seccionId == null ? '' : b.seccionId);
  if (seccionId === '__auto__') delete d.carta.asignaciones[platoId];
  else d.carta.asignaciones[platoId] = seccionId;
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});
// Reemplaza la estructura de secciones/ítems (para cargar el orden real del menú).
app.put('/admin/costeo/carta/secciones', requireAdmin, (req, res) => {
  const rest = req.query.rest; const b = req.body || {};
  if (!Array.isArray(b.secciones)) return res.status(400).json({ error: 'Falta secciones (array).' });
  const d = loadCosteo(rest, req.query.svc); d.carta = costeoNormalizeCarta(d.carta);
  d.carta.secciones = costeoNormalizeCarta({ secciones: b.secciones }).secciones;
  saveCosteo(rest, req.query.svc, d); res.json({ ok: true });
});

// ── Export de la Carta a Excel (.xlsx) ──────────────────────────────────────
// Genera un .xlsx real (OOXML) SIN dependencias: arma el ZIP a mano con entradas
// STORE (sin compresión) + las partes XML mínimas. Una hoja por restaurante, con
// las secciones y por plato: Plato | Precio de venta | Costo | % de costo.
const CRC_TABLE = (() => { const t = new Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf){ let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files){
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // flag: UTF-8
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
// cell: { v, t:'s'|'n', s:styleIndex }
function xlsxSheetXml(rows){
  const rowXml = rows.map((cells, r) => {
    const cs = cells.map((c, ci) => {
      if (c == null) return '';
      const ref = colLetter(ci) + (r + 1);
      const s = c.s ? ` s="${c.s}"` : '';
      if (c.t === 'n') return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="46"/><col min="2" max="3" width="16"/><col min="4" max="4" width="12"/></cols><sheetData>${rowXml}</sheetData></worksheet>`;
}
const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF5E6C8"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/><xf numFmtId="165" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
// Filas de una hoja a partir de la carta resuelta.
function cartaSheetRows(carta){
  const S = { title: 5, header: 1, sec: 2, money: 3, pct: 4, secMoney: 6, secPct: 7 };
  const rows = [];
  rows.push([{ v: 'Plato', s: S.header }, { v: 'Precio de venta', s: S.header }, { v: 'Costo', s: S.header }, { v: '% de costo', s: S.header }]);
  const avg = (arr) => arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null;
  const pushSec = (nombre, platos, sinCostear) => {
    if (!platos.length && !(sinCostear && sinCostear.length)) return;
    rows.push([]); // fila en blanco
    // Promedios de la sección (en la misma fila del nombre), sobre los platos con
    // precio real cargado, así precio · costo · % quedan coherentes entre sí.
    const conPrecio = platos.filter(p => p.precioReal != null);
    const avgPrecio = avg(conPrecio.map(p => p.precioReal));
    const avgCosto = avg(conPrecio.map(p => Number(p.costo) || 0));
    const avgPct = avg(conPrecio.filter(p => p.pctCosto != null).map(p => Number(p.pctCosto) || 0));
    rows.push([
      { v: nombre, s: S.sec },
      avgPrecio != null ? { v: Math.round(avgPrecio), t: 'n', s: S.secMoney } : { v: '', s: S.sec },
      avgCosto != null ? { v: Math.round(avgCosto), t: 'n', s: S.secMoney } : { v: '', s: S.sec },
      avgPct != null ? { v: avgPct / 100, t: 'n', s: S.secPct } : { v: '', s: S.sec },
    ]);
    platos.forEach(p => {
      // Precio de venta REAL (el que se cobra). % de costo = costo ÷ precio real.
      const precioCell = (p.precioReal != null) ? { v: p.precioReal, t: 'n', s: S.money } : { v: 'sin precio' };
      const pctCell = (p.precioReal != null && p.pctCosto != null) ? { v: (Number(p.pctCosto) || 0) / 100, t: 'n', s: S.pct } : { v: '' };
      rows.push([{ v: p.nombre }, precioCell, { v: p.costo, t: 'n', s: S.money }, pctCell]);
    });
    (sinCostear || []).forEach(n => rows.push([{ v: n + '  (sin costear)' }]));
  };
  carta.secciones.forEach(s => pushSec(s.nombre, s.platos, s.sinCostear));
  pushSec('Sin asignar', carta.sinAsignar, []);
  return rows;
}
// Empaqueta N hojas [{name, rows}] en un .xlsx (OOXML) y devuelve el Buffer.
function xlsxPackage(sheets){
  const files = [];
  const overrides = sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  const sheetTags = sheets.map((s, i) => `<sheet name="${xmlEsc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>` });
  const wbRels = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: XLSX_STYLES });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xlsxSheetXml(s.rows) }));
  return zipStore(files);
}
function sendXlsx(res, buf, fname){
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
}
const REST_LABELS = { garden: 'Kairos Garden', badass: 'Badass' };
const svcSheetLabel = (rest, svc) => REST_LABELS[costeoRestKey(rest)] + (costeoSvcKey(svc) === 'barra' ? ' — Barra' : '');

// Filas de la hoja de Recetas base: por cada RB, un bloque con el desglose de sus
// insumos/RB (Insumo/RB · Unidad · Precio · Cantidad · Costo) + producción y totales.
function rbSheetRows(doc){
  const S = { header: 1, sec: 2, money: 3, secMoney: 6 };
  const rows = [];
  (doc.recetasBase || []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach(r => {
    rows.push([
      { v: r.nombre, s: S.sec }, { v: `Producción: ${r.produccion} ${r.unidad || ''}`.trim(), s: S.sec }, { v: '', s: S.sec },
      { v: 'Costo x unidad', s: S.sec }, { v: r.precioUnidad, t: 'n', s: S.secMoney },
    ]);
    rows.push([{ v: 'Insumo/RB', s: S.header }, { v: 'Unidad', s: S.header }, { v: 'Precio', s: S.header }, { v: 'Cantidad', s: S.header }, { v: 'Costo', s: S.header }]);
    (r.lineas || []).forEach(l => rows.push([
      { v: l.nombre }, { v: l.unidad || '' }, { v: l.precio, t: 'n', s: S.money }, { v: l.cantidad, t: 'n' }, { v: l.costo, t: 'n', s: S.money },
    ]));
    rows.push([{ v: '' }, { v: '' }, { v: '' }, { v: 'Costo total', s: S.header }, { v: r.costoTotal, t: 'n', s: S.money }]);
    rows.push([]);
  });
  return rows;
}
// Filas de la hoja de Platos / Tragos (agrupados por categoría, con la cadena de costo).
function platosSheetRows(doc){
  const S = { header: 1, sec: 2, money: 3, pct: 4 };
  const rows = [[{ v: 'Plato', s: S.header }, { v: 'Costo total', s: S.header }, { v: 'Protección', s: S.header }, { v: 'IVA', s: S.header }, { v: 'Costo final', s: S.header }, { v: 'Margen', s: S.header }, { v: 'Precio sugerido', s: S.header }, { v: '% costo', s: S.header }, { v: 'Precio real', s: S.header }, { v: '% costo real', s: S.header }]];
  const cats = doc.categorias || [];
  const byCat = new Map();
  (doc.platos || []).forEach(p => { const c = p.categoria || 'Sin categoría'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(p); });
  const order = [...cats.filter(c => byCat.has(c)), ...[...byCat.keys()].filter(c => !cats.includes(c))];
  order.forEach(cat => {
    rows.push([]);
    rows.push([{ v: cat, s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }, { v: '', s: S.sec }]);
    byCat.get(cat).slice().sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach(p => {
      const real = (p.precioReal != null) ? { v: p.precioReal, t: 'n', s: S.money } : { v: 'sin precio' };
      const pctReal = (p.precioReal != null && p.pctCostoReal != null) ? { v: (Number(p.pctCostoReal) || 0) / 100, t: 'n', s: S.pct } : { v: '' };
      rows.push([
        { v: p.nombre },
        { v: p.costoTotal, t: 'n', s: S.money }, { v: p.proteccion, t: 'n', s: S.money }, { v: p.iva, t: 'n', s: S.money }, { v: p.costoFinal, t: 'n', s: S.money },
        { v: (Number(p.margenPct) || 0) / 100, t: 'n', s: S.pct }, { v: p.precioVentaRedondeado, t: 'n', s: S.money }, { v: (Number(p.pctCosto) || 0) / 100, t: 'n', s: S.pct },
        real, pctReal,
      ]);
    });
  });
  return rows;
}

// Filas de la hoja de Insumos: mismas columnas que la tabla maestra de la UI
// (varían según barra/comida) + las recetas base (RB) que también aparecen ahí.
function insumosSheetRows(doc, svc){
  const barra = costeoSvcKey(svc) === 'barra';
  const S = { header: 1, money: 3, pct: 4 };
  const rows = [barra
    ? [{ v: 'Descripción', s: S.header }, { v: 'Precio neto', s: S.header }, { v: 'ILA', s: S.header }, { v: 'Despacho', s: S.header }, { v: 'Neto + ILA + Desp.', s: S.header }, { v: 'Volumen bot.', s: S.header }, { v: 'Precio 1L', s: S.header }]
    : [{ v: 'Descripción', s: S.header }, { v: 'Precio neto', s: S.header }, { v: 'Formato', s: S.header }, { v: 'Unidad', s: S.header }, { v: '% Rend.', s: S.header }, { v: 'Precio real', s: S.header }]];
  (doc.insumos || []).slice().sort((a, b) => a.descripcion.localeCompare(b.descripcion)).forEach(i => {
    if (barra) {
      const netoIla = (Number(i.precioNeto) || 0) * (1 + (Number(i.ila) || 0) / 100) + (Number(i.despacho) || 0);
      rows.push([
        { v: i.descripcion }, { v: Number(i.precioNeto) || 0, t: 'n', s: S.money }, { v: (Number(i.ila) || 0) / 100, t: 'n', s: S.pct },
        { v: Number(i.despacho) || 0, t: 'n', s: S.money }, { v: Math.round(netoIla), t: 'n', s: S.money },
        { v: i.volumen || '' }, { v: Number(i.precioReal) || 0, t: 'n', s: S.money },
      ]);
    } else {
      const rendCell = i.rendimiento != null ? { v: i.rendimiento, t: 'n', s: S.pct } : { v: '' };
      rows.push([
        { v: i.descripcion }, { v: Number(i.precioNeto) || 0, t: 'n', s: S.money }, { v: i.formato || '' }, { v: i.unidad || '' },
        rendCell, { v: Number(i.precioReal) || 0, t: 'n', s: S.money },
      ]);
    }
  });
  const rbList = (doc.recetasBase || []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (rbList.length) {
    rows.push([]);
    rows.push([{ v: 'Recetas base (RB)', s: S.header }]);
    rbList.forEach(r => rows.push(barra
      ? [{ v: r.nombre }, { v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: '' }, { v: Number(r.precioUnidad) || 0, t: 'n', s: S.money }]
      : [{ v: r.nombre }, { v: '' }, { v: '' }, { v: r.unidad || '' }, { v: '' }, { v: Number(r.precioUnidad) || 0, t: 'n', s: S.money }]));
  }
  return rows;
}

app.get('/admin/costeo/carta/export.xlsx', requireAdmin, (req, res) => {
  const scope = String(req.query.rest || 'garden');
  const svc = costeoSvcKey(req.query.svc);
  const rests = scope === 'both' ? ['garden', 'badass'] : [costeoRestKey(scope)];
  const sheets = rests.map(rt => ({ name: svcSheetLabel(rt, svc), rows: [[{ v: svcSheetLabel(rt, svc), s: 5 }], []].concat(cartaSheetRows(resolveCarta(loadCosteo(rt, svc)))) }));
  const sfx = svc === 'barra' ? '-barra' : '';
  const fname = scope === 'both' ? `carta${sfx}-zorbo.xlsx` : `carta${sfx}-${costeoRestKey(scope)}.xlsx`;
  sendXlsx(res, xlsxPackage(sheets), fname);
});
// Export de Insumos a Excel (listado maestro: insumos editables + recetas base).
app.get('/admin/costeo/insumos/export.xlsx', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const svc = costeoSvcKey(req.query.svc);
  const doc = resolveCosteo(loadCosteo(rest, svc));
  const rows = [[{ v: svcSheetLabel(rest, svc) + ' · Insumos', s: 5 }], []].concat(insumosSheetRows(doc, svc));
  const sfx = svc === 'barra' ? '-barra' : '';
  sendXlsx(res, xlsxPackage([{ name: svcSheetLabel(rest, svc), rows }]), `insumos${sfx}-${rest}.xlsx`);
});
// Export de Recetas base a Excel.
app.get('/admin/costeo/recetas/export.xlsx', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const svc = costeoSvcKey(req.query.svc);
  const doc = resolveCosteo(loadCosteo(rest, svc));
  const rows = [[{ v: svcSheetLabel(rest, svc) + ' · Recetas base', s: 5 }], []].concat(rbSheetRows(doc));
  const sfx = svc === 'barra' ? '-barra' : '';
  sendXlsx(res, xlsxPackage([{ name: svcSheetLabel(rest, svc), rows }]), `recetas-base${sfx}-${rest}.xlsx`);
});
// Export de Platos / Tragos a Excel.
app.get('/admin/costeo/platos/export.xlsx', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const svc = costeoSvcKey(req.query.svc);
  const prod = svc === 'barra' ? 'Tragos' : 'Platos';
  const doc = resolveCosteo(loadCosteo(rest, svc));
  const rows = [[{ v: svcSheetLabel(rest, svc) + ' · ' + prod, s: 5 }], []].concat(platosSheetRows(doc));
  const sfx = svc === 'barra' ? '-barra' : '';
  sendXlsx(res, xlsxPackage([{ name: svcSheetLabel(rest, svc), rows }]), `${prod.toLowerCase()}${sfx}-${rest}.xlsx`);
});

// ── Export de la Carta a PDF (multipágina, sin dependencias) ─────────────────
// Mismo contenido que el Excel: por restaurante, secciones con Plato · Precio de
// venta (real) · Costo · % de costo, más "sin costear" y "Sin asignar".
function buildCartaPdf(bloques){
  const W = 595.28, H = 841.89, M = 42, CW = W - 2 * M;
  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const cw = (c, b) => { const n = "ijl.,:;'|!ift()[]/ "; const wi = "mwMW@"; const up = "ABCDEFGHIJKLNOPQRSTUVXYZ0123456789"; let w = n.includes(c) ? .30 : wi.includes(c) ? .86 : up.includes(c) ? .70 : .52; return w * (b ? 1.04 : 1); };
  const tw = (s, sz, b) => [...String(s)].reduce((a, c) => a + cw(c, b), 0) * sz;
  const GOLD = [0.63, 0.37, 0], DARK = [0.12, 0.12, 0.12], GREY = [0.45, 0.45, 0.45], LINE = [0.82, 0.82, 0.82];
  const pages = []; let ops = []; let y = 0;
  const txt = (x, yy, s, sz, col, b, align, maxw) => {
    let str = String(s == null ? '' : s);
    if (maxw) { while (str.length > 1 && tw(str, sz, b) > maxw) str = str.slice(0, -1); }
    let xx = x; const width = tw(str, sz, b);
    if (align === 'r') xx = x - width; else if (align === 'c') xx = x - width / 2;
    const [r, g, bl] = col; const f = b ? 'F2' : 'F1';
    ops.push(`BT /${f} ${sz} Tf ${r} ${g} ${bl} rg ${xx.toFixed(1)} ${(H - yy - sz).toFixed(1)} Td (${esc(str)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, col) => { const [r, g, bl] = col; ops.push(`${r} ${g} ${bl} RG 0.6 w ${x1.toFixed(1)} ${(H - y1).toFixed(1)} m ${x2.toFixed(1)} ${(H - y2).toFixed(1)} l S`); };
  const startPage = () => { if (ops.length) pages.push(ops); ops = []; y = M; };
  const ensure = (h) => { if (y + h > H - M) startPage(); };
  // Columnas (derecha): % costo · costo · precio de venta.
  const cPct = W - M, cCosto = W - M - 70, cPrecio = W - M - 150;
  const rowPlato = (nombre, precio, costo, pct) => {
    ensure(16);
    txt(M + 4, y, nombre, 10, DARK, false, null, cPrecio - M - 60);
    txt(cPrecio, y, precio, 10.5, GOLD, true, 'r');
    txt(cCosto, y, costo, 9, GREY, false, 'r');
    txt(cPct, y, pct, 9, DARK, false, 'r');
    y += 15;
  };
  bloques.forEach((bl, bi) => {
    if (bi > 0) startPage(); else startPage();
    txt(M, y, bl.titulo, 19, GOLD, true); y += 24;
    txt(M, y, 'Precio de venta al público · costo y % de costo del costeo. Uso interno.', 9, GREY, false); y += 6;
    line(M, y + 6, W - M, y + 6, GOLD); y += 20;
    const sections = [...bl.carta.secciones, { nombre: 'Sin asignar', platos: bl.carta.sinAsignar || [], sinCostear: [] }];
    sections.forEach(s => {
      if (!(s.platos && s.platos.length) && !(s.sinCostear && s.sinCostear.length)) return;
      ensure(40);
      txt(M, y, String(s.nombre).toUpperCase() + '  (' + (s.platos ? s.platos.length : 0) + ')', 12.5, DARK, true); y += 4;
      line(M, y + 6, W - M, y + 6, LINE); y += 15;
      txt(cPrecio, y, 'Precio', 7, GREY, true, 'r'); txt(cCosto, y, 'Costo', 7, GREY, true, 'r'); txt(cPct, y, '% costo', 7, GREY, true, 'r'); y += 11;
      (s.platos || []).forEach(p => {
        const precio = (p.precioReal != null) ? clp(p.precioReal) : 'sin precio';
        const pct = (p.precioReal != null && p.pctCosto != null) ? (p.pctCosto + '%') : '—';
        rowPlato(p.nombre, precio, clp(p.costo), pct);
      });
      (s.sinCostear || []).forEach(n => { ensure(15); txt(M + 4, y, n + '  (sin costear)', 9, GREY, false, null, CW - 40); y += 14; });
      y += 12;
    });
  });
  startPage();
  const objs = {}; let n = 4;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const kids = [];
  pages.forEach(pOps => {
    const content = pOps.join('\n');
    const contentId = ++n; objs[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    const pageId = ++n; objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    kids.push(`${pageId} 0 R`);
  });
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`;
  let buf = '%PDF-1.4\n'; const off = {};
  for (let i = 1; i <= n; i++) { off[i] = buf.length; buf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = buf.length;
  buf += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) buf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  buf += `trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(buf, 'latin1');
}
app.get('/admin/costeo/carta/export.pdf', requireAdmin, (req, res) => {
  const scope = String(req.query.rest || 'garden');
  const svc = costeoSvcKey(req.query.svc);
  const rests = scope === 'both' ? ['garden', 'badass'] : [costeoRestKey(scope)];
  const bloques = rests.map(rt => ({ titulo: 'Carta · ' + svcSheetLabel(rt, svc), carta: resolveCarta(loadCosteo(rt, svc)) }));
  const sfx = svc === 'barra' ? '-barra' : '';
  const fname = scope === 'both' ? `carta${sfx}-zorbo.pdf` : `carta${sfx}-${costeoRestKey(scope)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
  res.send(buildCartaPdf(bloques));
});

// ─── REVENTA de barra (venta directa: sin receta) ───────────────────────────
// Siembra las secciones/productos de reventa desde el seed versionado. En un bump
// de versión reemplaza el catálogo pero CONSERVA el precio de compra que el usuario
// ya cargó (match por sección+nombre normalizados). Solo aplica a barra.
const REVENTA_SEED_V = 1;
const reventaSeedFile = (rest) => costeoRestKey(rest) === 'badass' ? 'costeo-reventa-seed-badass.json' : 'costeo-reventa-seed-garden.json';
function costeoSeedReventa(doc, rest){
  if (!doc) return false;
  doc.reventa = costeoNormalizeReventa(doc.reventa);
  if (doc.reventa.v >= REVENTA_SEED_V) return false;
  let seed; try { seed = JSON.parse(readFileSync(join(__dirname, reventaSeedFile(rest)), 'utf-8')); } catch { return false; }
  if (!seed || !Array.isArray(seed.secciones)) return false;
  const key = costeoRestKey(rest);
  const old = doc.reventa.secciones || [];
  // Índice del precio de compra ya cargado: "seccion||producto" → precioCompra.
  const prevCompra = new Map();
  old.forEach(s => (s.productos || []).forEach(p => { if (p.precioCompra != null) prevCompra.set(costeoNorm(s.nombre) + '||' + costeoNorm(p.nombre), p.precioCompra); }));
  const seedSecNorms = new Set(seed.secciones.map(s => costeoNorm(s.nombre)));
  const built = seed.secciones.map((s, si) => {
    const secNorm = costeoNorm(s.nombre);
    const seedNorms = new Set((s.productos || []).map(p => costeoNorm(p.nombre)));
    const productos = (s.productos || []).map(p => {
      const nombre = costeoStr(p.nombre, 200) || 'Producto';
      const carry = prevCompra.get(secNorm + '||' + costeoNorm(nombre));
      return { id: randomUUID(), nombre, precioVenta: costeoNumOrNull(p.precioVenta), precioCompra: carry != null ? carry : null };
    });
    // Productos que el usuario agregó a mano en esta sección (no vienen del seed): se conservan.
    const oldSec = old.find(o => costeoNorm(o.nombre) === secNorm);
    if (oldSec) (oldSec.productos || []).forEach(p => { if (!seedNorms.has(costeoNorm(p.nombre))) productos.push({ id: p.id || randomUUID(), nombre: p.nombre, precioVenta: costeoNumOrNull(p.precioVenta), precioCompra: p.precioCompra }); });
    return { id: `${key}-r${si + 1}`, nombre: costeoStr(s.nombre, 120) || 'Sección', productos };
  });
  // Secciones que el usuario agregó a mano (no están en el seed): se conservan al final.
  old.forEach(s => { if (!seedSecNorms.has(costeoNorm(s.nombre))) built.push({ id: s.id || randomUUID(), nombre: s.nombre, productos: s.productos || [] }); });
  doc.reventa.secciones = built;
  doc.reventa.v = REVENTA_SEED_V;
  return true;
}
// Carga la reventa de un restaurante (siempre barra), sembrando si hace falta.
function loadReventa(rest){
  const doc = loadCosteo(rest, 'barra');
  if (costeoSeedReventa(doc, rest)) saveCosteo(rest, 'barra', doc);
  return doc;
}
function resolveReventa(doc){
  const secciones = (doc.reventa.secciones || []).map(s => ({
    id: s.id, nombre: s.nombre,
    productos: (s.productos || []).map(p => ({
      id: p.id, nombre: p.nombre, precioVenta: p.precioVenta, precioCompra: p.precioCompra,
      pctCosto: (p.precioVenta && p.precioCompra != null) ? Math.round((p.precioCompra / p.precioVenta) * 1000) / 10 : null,
    })),
  }));
  const totalProd = secciones.reduce((a, s) => a + s.productos.length, 0);
  return { secciones, meta: { totalSecciones: secciones.length, totalProductos: totalProd } };
}
app.get('/admin/costeo/reventa', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest);
  res.json({ restaurante: rest, ...resolveReventa(loadReventa(rest)) });
});
// Editar un producto de reventa (precio de compra / venta / nombre).
app.put('/admin/costeo/reventa/producto/:id', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const b = req.body || {};
  const doc = loadReventa(rest); const id = String(req.params.id);
  let prod = null; (doc.reventa.secciones || []).forEach(s => (s.productos || []).forEach(p => { if (p.id === id) prod = p; }));
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (b.nombre !== undefined) { const v = costeoStr(b.nombre, 200); if (v) prod.nombre = v; }
  if (b.precioVenta !== undefined) prod.precioVenta = costeoNumOrNull(b.precioVenta);
  if (b.precioCompra !== undefined) prod.precioCompra = costeoNumOrNull(b.precioCompra);
  saveCosteo(rest, 'barra', doc); res.json({ ok: true });
});
// Agregar un producto a una sección de reventa.
app.post('/admin/costeo/reventa/producto', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const b = req.body || {};
  const nombre = costeoStr(b.nombre, 200); if (!nombre) return res.status(400).json({ error: 'Falta el nombre.' });
  const doc = loadReventa(rest);
  const s = (doc.reventa.secciones || []).find(x => x.id === String(b.seccionId));
  if (!s) return res.status(404).json({ error: 'Sección no encontrada.' });
  s.productos.push({ id: randomUUID(), nombre, precioVenta: costeoNumOrNull(b.precioVenta), precioCompra: costeoNumOrNull(b.precioCompra) });
  saveCosteo(rest, 'barra', doc); res.json({ ok: true });
});
app.delete('/admin/costeo/reventa/producto/:id', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const doc = loadReventa(rest); const id = String(req.params.id);
  let found = false;
  (doc.reventa.secciones || []).forEach(s => { const n = s.productos.length; s.productos = s.productos.filter(p => p.id !== id); if (s.productos.length !== n) found = true; });
  if (!found) return res.status(404).json({ error: 'Producto no encontrado.' });
  saveCosteo(rest, 'barra', doc); res.json({ ok: true });
});
// Agregar una sección de reventa (para las que no venían en el seed).
app.post('/admin/costeo/reventa/seccion', requireAdmin, (req, res) => {
  const rest = costeoRestKey(req.query.rest); const nombre = costeoStr((req.body || {}).nombre, 120);
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la sección.' });
  const doc = loadReventa(rest);
  doc.reventa.secciones.push({ id: randomUUID(), nombre, productos: [] });
  saveCosteo(rest, 'barra', doc); res.json({ ok: true });
});

// ─── PORTAL DEL PROVEEDOR (Fase 2) ──────────────────────────────────────────
// Portal SEPARADO del /admin. Cada marca entra con su propio login y ve SOLO su
// data. Sesión con cookie propia (zprov), distinta a la del admin (zadm).
const PORTAL_COOKIE = 'zprov';
const PORTAL_TTL_MS = 12 * 60 * 60 * 1000;
const PORTAL_SESSIONS = new Map(); // token → { supplierId, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of PORTAL_SESSIONS) if (s.expiresAt < now) PORTAL_SESSIONS.delete(t);
}, 60 * 60 * 1000).unref?.();

function portalSessionFor(req){
  const token = parseCookies(req)[PORTAL_COOKIE];
  if (!token) return null;
  const s = PORTAL_SESSIONS.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { PORTAL_SESSIONS.delete(token); return null; }
  return { token, ...s };
}
// Devuelve el proveedor logueado (objeto completo desde distribuidora.json).
function portalSupplier(req){
  const sess = portalSessionFor(req);
  if (!sess) return null;
  const d = loadDistri();
  return d.suppliers.find(x => x.id === sess.supplierId) || null;
}
function requirePortal(req, res, next){
  if (portalSupplier(req)) return next();
  if (wantsHtml(req)) return res.redirect(302, '/proveedores/login');
  return res.status(401).json({ error: 'No autorizado. Iniciá sesión en /proveedores/login.' });
}

// ¿La línea de venta pertenece a este proveedor? Match por vendor de Shopify.
function lineMatchesSupplier(li, supplier){
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const ns = norm(supplier.name);
  if (!ns) return false;
  const nv = norm(li.vendor);
  if (nv && (nv === ns || nv.includes(ns) || ns.includes(nv))) return true;
  const tags = (li.tags || []).map(norm);
  return tags.some(t => t === ns);
}

// Buckets de los últimos N meses → [{ key:'2026-06', label:'jun 26', value:0 }]
function monthlyBuckets(n = 12){
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    out.push({ key, label: `${monthLabel(d.getMonth())} ${String(d.getFullYear()).slice(2)}`, value: 0, units: 0 });
  }
  return out;
}
function bucketKey(iso){
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// ── Rutas del portal ──
app.get('/proveedores/login', (req, res) => {
  if (portalSupplier(req)) return res.redirect(302, '/proveedores');
  res.sendFile(join(__dirname, 'portal-views', 'login.html'));
});
app.post('/proveedores/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Faltan credenciales.' });
  }
  const user = username.trim().toLowerCase();
  const d = loadDistri();
  const s = d.suppliers.find(x => x.portal && x.portal.user === user);
  await new Promise(r => setTimeout(r, 250)); // anti fuerza bruta
  let ok = false;
  if (s && s.portal && s.portal.hash) {
    const cand = hashPortalPassword(password, s.portal.salt);
    const A = Buffer.from(cand, 'hex'), B = Buffer.from(s.portal.hash, 'hex');
    ok = A.length === B.length && timingSafeEqual(A, B);
  }
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + PORTAL_TTL_MS;
  PORTAL_SESSIONS.set(token, { supplierId: s.id, expiresAt });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${PORTAL_COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${Math.floor(PORTAL_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok: true });
});
app.post('/proveedores/logout', (req, res) => {
  const sess = portalSessionFor(req);
  if (sess) PORTAL_SESSIONS.delete(sess.token);
  res.setHeader('Set-Cookie', `${PORTAL_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/proveedores', requirePortal, (_req, res) => {
  res.sendFile(join(__dirname, 'portal-views', 'portal.html'));
});
app.get('/portal/me', requirePortal, (req, res) => {
  const s = portalSupplier(req);
  res.json({ id: s.id, name: s.name, type: s.type, category: s.category });
});

// Dashboard básico: sell-in (órdenes de compra de Fase 1) + sell-out (Shopify).
app.get('/portal/dashboard', requirePortal, async (req, res) => {
  const s = portalSupplier(req);
  const d = loadDistri();

  // SELL IN — lo que Zorbo le compró (órdenes de compra del proveedor)
  const sellInBuckets = monthlyBuckets(12);
  const sellInByKey = new Map(sellInBuckets.map(b => [b.key, b]));
  let sellInTotal = 0, sellInUnits = 0;
  for (const po of d.purchaseOrders) {
    if (po.supplierId !== s.id) continue;
    const amount = Number(po.total || 0);
    const units = (po.items || []).reduce((a, it) => a + (Number(it.qty) || 0), 0);
    sellInTotal += amount; sellInUnits += units;
    const b = sellInByKey.get(bucketKey(po.date || po.createdAt));
    if (b) { b.value += amount; b.units += units; }
  }

  // SELL OUT — ventas de su marca en Shopify (filtrado por vendor)
  let sellOut = { available: false, reason: '', total: 0, units: 0, orders: 0, monthly: [] };
  const result = await loadOrders(false);
  if (!result.available) {
    sellOut.reason = result.reason || 'Ventas no disponibles.';
  } else {
    const buckets = monthlyBuckets(12);
    const byKey = new Map(buckets.map(b => [b.key, b]));
    let total = 0, units = 0; const orderIds = new Set();
    for (const o of result.orders) {
      let matched = false;
      for (const li of (o.lineItems || [])) {
        if (!lineMatchesSupplier(li, s)) continue;
        matched = true;
        total += Number(li.amount || 0);
        units += Number(li.qty || 0);
        const b = byKey.get(bucketKey(o.createdAt));
        if (b) { b.value += Number(li.amount || 0); b.units += Number(li.qty || 0); }
      }
      if (matched) orderIds.add(o.id);
    }
    sellOut = { available: true, reason: '', total: Math.round(total), units, orders: orderIds.size, monthly: buckets };
  }

  res.json({
    supplier: { name: s.name, type: s.type, category: s.category },
    sellIn: { total: Math.round(sellInTotal), units: sellInUnits, monthly: sellInBuckets },
    sellOut,
  });
});

// Órdenes de compra que Zorbo le hizo a este proveedor (con PDF).
app.get('/portal/ordenes', requirePortal, (req, res) => {
  const s = portalSupplier(req);
  const d = loadDistri();
  const orders = d.purchaseOrders
    .filter(po => po.supplierId === s.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(po => ({
      id: po.id, number: po.number, fecha: po.fecha, status: po.status, total: po.total,
      entrega: po.entrega, plazoEntrega: po.plazoEntrega, pago: po.pago,
      items: (po.items || []).map(it => ({ articulo: it.articulo, cantidad: it.cantidad, precioUnitario: it.precioUnitario, precioTotal: it.precioTotal })),
    }));
  res.json({ orders });
});
app.get('/portal/ordenes/:id/pdf', requirePortal, (req, res) => {
  const s = portalSupplier(req);
  const po = loadDistri().purchaseOrders.find(x => x.id === String(req.params.id));
  if (!po || po.supplierId !== s.id) return res.status(404).send('Orden no encontrada.');
  sendPOPdf(res, po);
});

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
  const from          = req.body.from || req.query.from;
  const mayorista     = req.body.mayorista === true;
  const customerEmail = mayorista ? normEmail(req.body.customerEmail) : '';

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
        ...getCustomBrands().map(b => readPromptFileSafe(customBrandFile(b.key))).filter(Boolean),
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

  // ── Flujo de compra: 3 vías ──────────────────────────────────────────────
  //  A) "pasame el link / pagar / checkout" → abre el carrito directo.
  //  B) "agrégalo / quiero un X / lo llevo" → si se identifica el producto
  //     en lo que el bot recomendó, agrega al carrito. Si NO, deja pasar a
  //     Claude (que recomienda y pregunta).
  //  C) Cualquier otra cosa → Claude normal.
  const isB2BContext = detect(message, B2B_KW);
  // ¿Es una sesión mayorista? Entonces el flujo de compra usa el catálogo
  // MAYORISTA (o la colección EX), nunca el B2C.
  const mayo = mayorista || session.isB2B;

  // A) CHECKOUT_OPEN: abrir carrito directo (chequeamos PRIMERO para que
  // "quiero pagar" no matchee "quiero" de ADD_NOW por accidente).
  if ((mayo || !isB2BContext) && detect(message, CHECKOUT_OPEN_KW)) {
    session.purchaseIntent = true;
    session.messages.push({ role: 'user',      content: message,      timestamp: new Date().toISOString() });
    session.messages.push({ role: 'assistant', content: CHECKOUT_MSG, timestamp: new Date().toISOString() });
    saveSession(session);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
    res.write(`data: ${JSON.stringify({ delta: CHECKOUT_MSG })}\n\n`);
    res.write(`data: ${JSON.stringify({ action: 'openCart' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // B) ADD_NOW: agregar al carrito SI se identifica el producto.
  // Si NO se identifica:
  //  - Si dio pack-size pero hay múltiples → server lista las opciones y pregunta.
  //  - Si no dio pack-size → cae a Claude (con prompt anti-mentira).
  if ((mayo || !isB2BContext) && (detect(message, ADD_NOW_KW) || isShorthandAddIntent(message) || isSoftSelection(message) || isQtyFormatOrder(message))) {
    let cartItems = [];
    let clarifyMsg = null;
    const normMsg = normalizeShorthand(message);
    const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant');
    if (process.env.SHOPIFY_ADMIN_TOKEN) {
      try {
        const all = await loadProductsCache(false);
        const active = (all || []).filter(p => String(p.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
        // Catálogo según el tipo de cliente: mayorista (tag MAYORISTA o, si es
        // MAYORISTA1, solo la colección EX) o B2C (tag ZORBO). Así "agrégalo"
        // nunca matchea un producto fuera del catálogo que ve el cliente.
        let shopCatalog;
        if (mayo) {
          const level = customerEmail ? await getCustomerMayoLevel(customerEmail) : null;
          if (level === 'ex') {
            const ex = await loadMayoExProductIds(false);
            const ids = (ex.available && ex.found) ? ex.ids : new Set();
            shopCatalog = active.filter(p => ids.has(String(p.id)));
          } else {
            shopCatalog = active.filter(p => isMayoristaProduct(p));
          }
        } else {
          shopCatalog = active.filter(p => (p.tags || []).map(t => String(t).trim().toUpperCase()).includes('ZORBO'));
        }
        // 1) Intentar matchear desde lo que el bot recomendó previamente.
        if (lastAssistant) cartItems = findMentionedProducts(lastAssistant.content, shopCatalog, normMsg);
        // 2) Fallback: el cliente puede haber nombrado el producto él mismo.
        if (!cartItems.length) cartItems = findMentionedProducts(message, shopCatalog, normMsg);
        // 3) Fallback: si dio pack-size y hay un único producto con ese pack,
        //    lo usamos. Si hay varios, server pide aclaración (no Claude).
        if (!cartItems.length) {
          const u = String(normMsg).toLowerCase();
          const pack = parsePackSize(u);
          if (pack) {
            const inTitle = new RegExp('(^|\\s|\\b)' + pack.size + '\\s*[- ]?pack', 'i');
            const matches = shopCatalog.filter(p => inTitle.test(String(p.title || '')));
            if (matches.length === 1) {
              const p = matches[0];
              const v = (p.variants || [])[0];
              if (v) {
                const qty = parseQty(u.replace(pack.rx, ' '));
                cartItems = [{
                  productData: {
                    name: p.title, brand: p.vendor || '', emoji: '🍺', style: '', desc: '',
                    price: parseFloat(v.price) || 0, variantId: String(v.id),
                    image: v.image || p.image || (p.images && p.images[0]) || null,
                  }, qty,
                }];
              }
            } else if (matches.length > 1) {
              const list = matches.slice(0, 4).map(p => `**${p.title}**`).join(', ');
              clarifyMsg = `Tengo varias opciones de ${pack.size} pack: ${list}. Decime cuál querés y te lo sumo al carrito 🛒.`;
            }
          }
        }
      } catch (e) { console.warn('add-now catalog:', e.message); }
    }
    // 1) Items identificados → agrego al carrito.
    if (cartItems.length) {
      session.purchaseIntent = true;
      const replyMsg = cartItems.length === 1
        ? `Listo! 🛒 Te sumé **${cartItems[0].productData.name}** (x${cartItems[0].qty}) al carrito. Decime "pasame el link" cuando quieras ir a pagar.`
        : `Listo! 🛒 Te sumé ${cartItems.length} productos al carrito. Decime "pasame el link" cuando quieras ir a pagar.`;
      session.messages.push({ role: 'user',      content: message,  timestamp: new Date().toISOString() });
      session.messages.push({ role: 'assistant', content: replyMsg, timestamp: new Date().toISOString() });
      saveSession(session);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: replyMsg })}\n\n`);
      res.write(`data: ${JSON.stringify({ action: 'addToCart', items: cartItems })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // 2) Pidió un pack y hay varias opciones → aclaración del server.
    if (clarifyMsg) {
      session.messages.push({ role: 'user',      content: message,    timestamp: new Date().toISOString() });
      session.messages.push({ role: 'assistant', content: clarifyMsg, timestamp: new Date().toISOString() });
      saveSession(session);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: clarifyMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // 3) Sin info útil → cae a Claude (el prompt le prohíbe decir "te agrego").
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
        // Cliente MAYORISTA1 → el bot SOLO puede recomendar de la colección
        // "MAYORISTA EX". Resolvemos el nivel por email (cacheado).
        const mayoLevel = (isB2B && customerEmail) ? await getCustomerMayoLevel(customerEmail) : null;
        const active = all.filter(p => String(p.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
        if (isB2B && mayoLevel === 'ex') {
          const ex = await loadMayoExProductIds(false);
          const inEx = (ex.available && ex.found) ? ex.ids : new Set();
          liveCatalog = active
            .filter(p => inEx.has(String(p.id)))
            .map(p => ({ id: String(p.id), title: p.title, type: p.type, vendor: p.vendor }));
        } else {
          const tagFilter = isB2B ? 'MAYORISTA' : 'ZORBO';
          liveCatalog = active
            .filter(p => (p.tags || []).map(t => String(t).trim().toUpperCase()).includes(tagFilter))
            .map(p => ({ id: String(p.id), title: p.title, type: p.type, vendor: p.vendor }));
        }
      }
    } catch (e) { console.warn('liveCatalog warm:', e.message); }
  }

  // Historial de compra del mayorista (recompra proactiva). loadOrders está
  // cacheado, así que esto no golpea Shopify en cada mensaje. Si el token no
  // tiene read_orders, lastOrderInfo queda en null y el bot sigue normal.
  let lastOrderInfo = null;
  if (mayorista && customerEmail) {
    try {
      const info = await getLastOrderItemsForEmail(customerEmail);
      if (info && info.available) lastOrderInfo = info;
    } catch (e) { console.warn('reorder ctx:', e.message); }
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
      system: buildSystemPrompt(promptBase, session, liveCatalog, lastOrderInfo),
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

    const level = mayoLevelFromTags(customer.tags); // 'all' | 'ex' | null
    const isMayorista = !!level;
    // Refrescamos la caché de nivel para que el bot/catálogo lo tengan al toque.
    if (customer.email) custLevelCache.set(normEmail(customer.email), { level, at: Date.now() });
    return res.json({
      ok: true,
      isMayorista,
      level,
      status: isMayorista ? 'approved' : 'pending',
      // Token de cliente Shopify → asocia el carrito a su cuenta en el checkout
      // (queda "iniciado sesión" en Shopify, con su pricing/condiciones).
      customerAccessToken: result.customerAccessToken.accessToken,
      tokenExpiresAt: result.customerAccessToken.expiresAt,
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

// ─── POST /mayorista/last-order — último pedido del cliente para recompra ────
// Palanca de recompra (Prioridad 1): el frontend lo usa para el botón
// "Repetir último pedido". Si el token no tiene read_orders, responde
// { available:false } y el frontend muestra un fallback elegante.
app.post('/mayorista/last-order', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'Email requerido.' });
  try {
    const info = await getLastOrderItemsForEmail(email);
    return res.json(info);
  } catch (e) {
    console.error('last-order error:', e.message);
    return res.status(500).json({ available: false, reason: 'Error consultando tu último pedido.' });
  }
});

// ─── POST /mayorista/recover — recuperación de contraseña vía Shopify ────────
// Dispara el email nativo de Shopify (customerRecover) con el link de reset.
// No revela si el correo existe o no (evita enumeración de cuentas).
app.post('/mayorista/recover', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ingresa un correo válido.' });
  if (!process.env.SHOPIFY_STOREFRONT_TOKEN) {
    return res.status(503).json({ error: 'Recuperación no configurada. Falta SHOPIFY_STOREFRONT_TOKEN.' });
  }
  try {
    const data = await shopifyStorefrontFetch(`
      mutation recover($email: String!) {
        customerRecover(email: $email) {
          customerUserErrors { code field message }
        }
      }`, { email });
    const errs = data?.data?.customerRecover?.customerUserErrors || [];
    // Errores de throttling sí los devolvemos; el resto se trata como éxito
    // genérico para no filtrar si el correo existe.
    const throttled = errs.find(e => /throttl|too many/i.test(e.message || ''));
    if (throttled) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos y prueba de nuevo.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('recover error:', e.message);
    return res.status(500).json({ error: 'No pudimos enviar el correo. Intenta de nuevo en un momento.' });
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

    // Solo el tag MAYORISTA_PENDIENTE. El canal queda en la nota del cliente.
    const tags = ['MAYORISTA_PENDIENTE'];

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
    const leadData = {
      nombre: first_name + (last_name ? ' ' + last_name : ''),
      local: local || '', comuna: comuna || '', canal: canal || '',
      email, telefono: phone || '',
    };
    appendLog(LEADS_LOG, {
      timestamp: new Date().toISOString(),
      ...leadData, welcomeCode,
      shopifyCustomerId: r.customer ? r.customer.id : null,
    });

    // Avisar al equipo por email + WhatsApp con todos los datos del inscrito.
    notifyWaitlist(leadData);

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
      message: 'Listo! Quedaste en la waitlist mayorista. Te contactamos en las próximas 48 horas hábiles.',
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

// ─── Manejo de errores centralizado ────────────────────────────────────────
// Sin esto, cualquier error que no capture una ruta puntual (el body-parser
// rechazando un request por tamaño, una excepción no atrapada, etc.) cae en
// la página de error HTML por defecto de Express — y el admin panel (que
// siempre espera JSON de sus fetch) explota con "Unexpected token '<'".
// Con esto, cualquier endpoint de API (la inmensa mayoría) devuelve JSON
// pase lo que pase; solo una navegación real de página (Accept: text/html)
// recibe texto plano en vez de un dump HTML de la excepción.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Error no manejado en', req.method, req.path, ':', (err && err.stack) || err);
  const status = (err && (err.status || err.statusCode)) || 500;
  const msg = (err && err.message) || 'Error interno del servidor.';
  if (wantsHtml(req)) return res.status(status).type('text/plain').send('Error ' + status + ': ' + msg);
  res.status(status).json({ error: msg });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zorbot escuchando en http://localhost:${PORT}`));
