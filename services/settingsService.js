'use strict';

// Adatbázis-vezérelt rendszerbeállítások (árak, AI, karbantartás, szezonális javaslatok) és e-mail sablonok.
// A beállítások 5 percig gyorsítótárban élnek; az admin módosítása azonnal frissíti a gyorsítótárat.
// Adatbázis-kliens nélkül (teszt, helyi fejlesztés) a beégetett alapértékek érvényesek; konfigurált, de hibázó adatbázisnál a hiba nem rejtődik el.
const supabase = require('./supabaseService');

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYSTEM_PROMPT = require('./defaultSystemPrompt');
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isValidModelName = (value) => typeof value === 'string' && MODEL_NAME_PATTERN.test(value);
const PRICE_TIERS = Object.freeze(['standard', 'academic', 'weekly']);
const TEMPLATE_IDS = Object.freeze(['base_layout', 'welcome_email', 'payment_success', 'password_reset']);
const MAX_PRICE_HUF = 100000;
const MAX_HINTS = 12;
const MAX_HINT_LENGTH = 120;
const MAX_PROMPT_LENGTH = 8000;
const MAX_TEMPLATE_LENGTH = 100000;

const DEFAULT_SETTINGS = Object.freeze({
  pricing: Object.freeze({ standard: 390, academic: 690, weekly: 890 }),
  ai_config: Object.freeze({
    model: 'gemini-3.1-pro-preview',
    system_prompt: DEFAULT_SYSTEM_PROMPT
  }),
  maintenance_mode: false,
  seasonal_hints: Object.freeze(['őszi falevelek gyűjtése', 'Márton-napi lámpáskészítés', 'farsangi mulatság'])
});

class SettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

let cache = null;
let cachedAt = 0;
let inflight = null;
let templateCache = null;
let templateCachedAt = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaults() {
  return clone(DEFAULT_SETTINGS);
}

// A hiányzó vagy hibás kulcsok alapértéket kapnak; az adatbázis tartalma így sem tud érvénytelen alakot adni.
function normalizeRows(rows) {
  const out = defaults();
  for (const row of rows || []) {
    if (!row || !(row.key in out)) continue;
    out[row.key] = row.key === 'pricing' || row.key === 'ai_config' ? { ...out[row.key], ...(row.value && typeof row.value === 'object' ? row.value : {}) } : row.value;
  }
  out.maintenance_mode = out.maintenance_mode === true;
  if (!Array.isArray(out.seasonal_hints)) out.seasonal_hints = defaults().seasonal_hints;
  return out;
}

function dbError(message, error) {
  const wrapped = new SettingsError(`${message}: ${error.message}`, 503);
  wrapped.cause = error;
  return wrapped;
}

async function fetchSettings(client) {
  const { data, error } = await client.from('system_settings').select('key, value');
  if (error) throw dbError('A rendszerbeállítások nem olvashatók', error);
  return normalizeRows(data);
}

// Gyorsítótárazott lekérés. Lejárt gyorsítótárnál újratölt; ha az adatbázis hibázik, a hiba felszínre kerül (nincs csendes tartalék).
async function getSettings({ force = false } = {}) {
  const client = supabase.getClient();
  if (!client) return cache || defaults();
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchSettings(client)
      .then((settings) => { cache = settings; cachedAt = Date.now(); return settings; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Szinkron betekintés az utolsó ismert értékre (a lekérés előtt az alapértékek).
function peek() {
  return cache || defaults();
}

function invalidate() {
  cache = null;
  cachedAt = 0;
  templateCache = null;
  templateCachedAt = 0;
}

function pricingTierFor(productKey) {
  if (productKey === 'weekly_detailed') return 'weekly';
  if (String(productKey).startsWith('academic_')) return 'academic';
  return 'standard';
}

function publicConfig(settings) {
  return {
    pricing: { ...settings.pricing },
    maintenance_mode: settings.maintenance_mode === true,
    seasonal_hints: [...settings.seasonal_hints]
  };
}

// Az AI-modell a beállításból jön (szabad szöveg); érvénytelen név hangos figyelmeztetéssel a szerver alapmodelljére esik vissza.
function resolveAiModel(settings, fallbackModel) {
  const model = settings?.ai_config?.model;
  if (isValidModelName(model)) return model;
  console.warn(`[settings] A beállított AI-modell (${String(model).slice(0, 60)}) érvénytelen, a ${fallbackModel} használt.`);
  return fallbackModel;
}

// ---------- Validáció ----------

function parsePrice(value, label) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < 1 || number > MAX_PRICE_HUF) {
    throw new SettingsError(`A(z) ${label} ár egész szám legyen 1 és ${MAX_PRICE_HUF} Ft között.`);
  }
  return number;
}

function parseHints(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(';');
  const hints = [...new Set(list.map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (hints.length > MAX_HINTS) throw new SettingsError(`Legfeljebb ${MAX_HINTS} szezonális javaslat adható meg.`);
  if (hints.some((hint) => hint.length > MAX_HINT_LENGTH)) throw new SettingsError(`Egy javaslat legfeljebb ${MAX_HINT_LENGTH} karakter lehet.`);
  return hints;
}

// A részleges módosítás (PATCH) csak az ismert kulcsokat engedi, és az összevont értéket validálja.
function validatePatch(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('A módosításnak JSON objektumnak kell lennie.');
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULT_SETTINGS));
  if (unknown.length) throw new SettingsError(`Ismeretlen beállítás: ${unknown.slice(0, 3).join(', ')}.`);
  const updates = {};
  if ('pricing' in patch) {
    const source = patch.pricing;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SettingsError('Az árazás JSON objektum legyen.');
    const extra = Object.keys(source).filter((key) => !PRICE_TIERS.includes(key));
    if (extra.length) throw new SettingsError(`Ismeretlen csomag: ${extra.slice(0, 3).join(', ')}.`);
    updates.pricing = {};
    for (const tier of PRICE_TIERS) updates.pricing[tier] = parsePrice(tier in source ? source[tier] : current.pricing[tier], tier);
  }
  if ('ai_config' in patch) {
    const source = patch.ai_config;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SettingsError('Az AI-beállítás JSON objektum legyen.');
    const model = 'model' in source ? source.model : current.ai_config.model;
    const prompt = 'system_prompt' in source ? source.system_prompt : current.ai_config.system_prompt;
    if (!isValidModelName(model)) throw new SettingsError('Érvénytelen modellnév. Betűk, számok, pont, kötőjel és alsóvonás használható (pl. gemini-1.5-flash).');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) throw new SettingsError(`A rendszerprompt kötelező, legfeljebb ${MAX_PROMPT_LENGTH} karakter.`);
    updates.ai_config = { model, system_prompt: prompt.trim() };
  }
  if ('maintenance_mode' in patch) {
    if (typeof patch.maintenance_mode !== 'boolean') throw new SettingsError('A karbantartás mód igaz/hamis érték legyen.');
    updates.maintenance_mode = patch.maintenance_mode;
  }
  if ('seasonal_hints' in patch) updates.seasonal_hints = parseHints(patch.seasonal_hints);
  if (!Object.keys(updates).length) throw new SettingsError('Nincs módosítandó beállítás.');
  return updates;
}

async function updateSettings(client, patch) {
  const current = await getSettings({ force: true });
  const updates = validatePatch(patch, current);
  const rows = Object.entries(updates).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  const { error } = await client.from('system_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw dbError('A beállítások mentése sikertelen', error);
  cache = normalizeRows([...Object.entries(current).map(([key, value]) => ({ key, value })), ...rows]);
  cachedAt = Date.now();
  return cache;
}

// ---------- E-mail sablonok ----------

async function listTemplates(client) {
  const { data, error } = await client.from('email_templates').select('id, subject, body_html');
  if (error) throw dbError('Az e-mail sablonok nem olvashatók', error);
  return (data || []).filter((row) => TEMPLATE_IDS.includes(row.id)).map((row) => ({ id: row.id, subject: row.subject || '', bodyHtml: row.body_html || '' }));
}

async function updateTemplate(client, id, body = {}) {
  if (!TEMPLATE_IDS.includes(id)) throw new SettingsError('Ismeretlen e-mail sablon.', 404);
  const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').trim() : null;
  const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : null;
  if (subject === null || bodyHtml === null) throw new SettingsError('A tárgy és a HTML-szöveg megadása kötelező.');
  if (subject.length > 200) throw new SettingsError('A tárgy legfeljebb 200 karakter lehet.');
  if (!bodyHtml.trim() || bodyHtml.length > MAX_TEMPLATE_LENGTH) throw new SettingsError(`A HTML-szöveg kötelező, legfeljebb ${MAX_TEMPLATE_LENGTH} karakter.`);
  if (id === 'base_layout' && !bodyHtml.includes('{{content}}')) throw new SettingsError('A base_layout sablonnak tartalmaznia kell a {{content}} helyőrzőt.');
  const { error } = await client.from('email_templates').upsert({ id, subject, body_html: bodyHtml }, { onConflict: 'id' });
  if (error) throw dbError('Az e-mail sablon mentése sikertelen', error);
  templateCache = null;
  return { id, subject, bodyHtml };
}

// A kiküldéshez használt sablonok (5 perces gyorsítótár); kliens nélkül null, a hívó a beépített levelet használja.
async function getTemplates() {
  const client = supabase.getClient();
  if (!client) return null;
  if (templateCache && Date.now() - templateCachedAt < CACHE_TTL_MS) return templateCache;
  const rows = await listTemplates(client);
  templateCache = Object.fromEntries(rows.map((row) => [row.id, row]));
  templateCachedAt = Date.now();
  return templateCache;
}

// A {{kulcs}} helyőrzőket cseréli; az értékeket a hívó már HTML-biztosan adja át. Ismeretlen helyőrző üres lesz.
function fillPlaceholders(source, values = {}) {
  return String(source).replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => (key in values ? String(values[key]) : ''));
}

// A sablon tartalmát a base_layout {{content}} helyére illeszti.
function composeEmail(templates, id, values = {}) {
  const template = templates?.[id];
  if (!template) throw new SettingsError(`Hiányzik az e-mail sablon: ${id}.`, 503);
  if (id === 'base_layout') return { subject: fillPlaceholders(template.subject, values), html: fillPlaceholders(template.bodyHtml, values) };
  const content = fillPlaceholders(template.bodyHtml, values);
  const layout = templates.base_layout;
  if (!layout) throw new SettingsError('Hiányzik az e-mail sablon: base_layout.', 503);
  return {
    subject: fillPlaceholders(template.subject, values),
    html: fillPlaceholders(layout.bodyHtml, { ...values, content })
  };
}

module.exports = {
  isValidModelName, PRICE_TIERS, TEMPLATE_IDS, DEFAULT_SETTINGS, CACHE_TTL_MS, SettingsError,
  getSettings, peek, invalidate, updateSettings, publicConfig, pricingTierFor, resolveAiModel,
  listTemplates, updateTemplate, getTemplates, fillPlaceholders, composeEmail
};
