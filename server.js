import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHmac, timingSafeEqual, randomBytes, scryptSync } from 'crypto';

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
function serveIndexWithMode(_req, res, next){
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

function wantsHtml(req){
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

// Login ACTIVO por defecto. Para abrir el panel sin login (debug) setear
// ADMIN_AUTH_ENABLED=0.
function requireAdmin(req, res, next){
  if (process.env.ADMIN_AUTH_ENABLED === '0') return next();
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

  const creds = adminCreds();

  // Comparación constante en tiempo para evitar timing attacks
  const eqUser = safeStrEq(username.trim().toLowerCase(), String(creds.user).trim().toLowerCase());
  const eqPass = safeStrEq(password, String(creds.pass));

  // Pequeño delay artificial para frenar fuerza bruta
  await new Promise(r => setTimeout(r, 250));

  if (!eqUser || !eqPass) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_TTL_MS;
  ADMIN_SESSIONS.set(token, { username: creds.user, expiresAt });

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
  if (!s) return res.json({ username: null, expiresAt: null }); // auth deshabilitada
  res.json({ username: s.username, expiresAt: s.expiresAt });
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
      // ILA (Impuesto a las bebidas alcohólicas) por producto. Por ahora 0;
      // más adelante se carga el % que corresponde a cada producto.
      ilaPct: Math.max(0, Number(it.ilaPct) || 0),
    }))
    .filter(it => it.articulo && it.cantidad > 0)
    .map(it => {
      const precioTotal = Math.round(it.cantidad * it.precioUnitario);
      return { ...it, precioTotal, ilaMonto: Math.round(precioTotal * it.ilaPct / 100) };
    });
}
function computeOCTotals(items, descuentoPct){
  const subtotal = items.reduce((s, it) => s + it.precioTotal, 0);
  const dPct = Math.min(100, Math.max(0, Number(descuentoPct) || 0));
  const descuento = Math.round(subtotal * dPct / 100);
  const subtotalConDescuento = subtotal - descuento;
  const ilaBruto = items.reduce((s, it) => s + (it.ilaMonto || 0), 0);
  const ila = Math.round(ilaBruto * (1 - dPct / 100));
  const iva = Math.round(subtotalConDescuento * 0.19);
  return { subtotal, descuentoPct: dPct, descuento, subtotalConDescuento, ila, iva, total: subtotalConDescuento + ila + iva };
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
// rankea por cliente: cuántas unidades compró y cuánto gastó.
app.get('/admin/top-clientes', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ available: true, query: '', count: 0, totalUnits: 0, rows: [] });
  const result = await loadOrders(String(req.query.refresh || '') === '1');
  if (!result.available) return res.json({ available: false, reason: result.reason });
  const map = new Map();
  const matchedTitles = new Set();
  for (const o of result.orders) {
    let units = 0, spent = 0, matched = false;
    for (const li of (o.lineItems || [])) {
      if (String(li.title || '').toLowerCase().includes(q)) {
        units += Number(li.qty || 0);
        spent += Number(li.amount || 0);
        matched = true;
        if (li.title) matchedTitles.add(li.title);
      }
    }
    if (!matched) continue;
    const key = o.customerId || (o.customerEmail ? 'e:' + normEmail(o.customerEmail) : 'o:' + o.id);
    let p = map.get(key);
    if (!p) { p = { nombre: '', email: o.customerEmail || '', telefono: o.customerPhone || '', units: 0, spent: 0, orders: 0, last: 0 }; map.set(key, p); }
    p.units += units; p.spent += spent; p.orders += 1;
    const nm = [o.customerFirstName, o.customerLastName].filter(Boolean).join(' ').trim();
    if (nm && !p.nombre) p.nombre = nm;
    const t = new Date(o.createdAt).getTime();
    if (t > p.last) p.last = t;
  }
  const rows = [...map.values()]
    .map(p => ({ nombre: p.nombre, email: p.email, telefono: p.telefono, units: p.units, spent: Math.round(p.spent), orders: p.orders, lastOrder: p.last ? new Date(p.last).toISOString() : null }))
    .sort((a, b) => b.units - a.units);
  res.json({
    available: true, query: q, count: rows.length,
    totalUnits: rows.reduce((s, p) => s + p.units, 0),
    matchedProducts: [...matchedTitles].slice(0, 12),
    rows,
  });
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
function costeoNormalizeDoc(p){
  p = p || {};
  return {
    version: 1,
    insumos: Array.isArray(p.insumos) ? p.insumos : [],
    recetasBase: Array.isArray(p.recetasBase) ? p.recetasBase : [],
    platos: Array.isArray(p.platos) ? p.platos : [],
    categorias: (Array.isArray(p.categorias) && p.categorias.length) ? p.categorias : costeoEmpty().categorias,
    carta: costeoNormalizeCarta(p.carta),
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
  return { v, pv, rv, biv, cv, smv, secciones, asignaciones };
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
  doc.carta.secciones = secs.map((sc, i) => ({ id: `${key}-b${i + 1}`, nombre: costeoStr(typeof sc === 'string' ? sc : sc.nombre, 120), reventa: !!(sc && sc.reventa), items: [] }));
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

app.get('/admin/costeo/carta/export.xlsx', requireAdmin, (req, res) => {
  const scope = String(req.query.rest || 'garden');
  const svc = costeoSvcKey(req.query.svc);
  const rests = scope === 'both' ? ['garden', 'badass'] : [costeoRestKey(scope)];
  const sheets = rests.map(rt => ({ name: svcSheetLabel(rt, svc), rows: [[{ v: svcSheetLabel(rt, svc), s: 5 }], []].concat(cartaSheetRows(resolveCarta(loadCosteo(rt, svc)))) }));
  const sfx = svc === 'barra' ? '-barra' : '';
  const fname = scope === 'both' ? `carta${sfx}-zorbo.xlsx` : `carta${sfx}-${costeoRestKey(scope)}.xlsx`;
  sendXlsx(res, xlsxPackage(sheets), fname);
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

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zorbot escuchando en http://localhost:${PORT}`));
