'use strict';

// Adatbázis-vezérelt rendszerbeállítások (árak, AI, karbantartás, szezonális javaslatok) és e-mail sablonok.
// A beállítások 5 percig gyorsítótárban élnek; az admin módosítása azonnal frissíti a gyorsítótárat.
// Adatbázis-kliens nélkül (teszt, helyi fejlesztés) a beégetett alapértékek érvényesek; konfigurált, de hibázó adatbázisnál a hiba nem rejtődik el.
const supabase = require('./supabaseService');
const { setActiveBillingProfile } = require('./siteConstants');

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYSTEM_PROMPT = require('./defaultSystemPrompt');
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isValidModelName = (value) => typeof value === 'string' && MODEL_NAME_PATTERN.test(value);
const BILLING_PROFILE_TYPES = Object.freeze(['ev', 'kft']);
const PAYMENT_PROVIDERS = Object.freeze(['barion', 'stripe']);
const PRICE_TIERS = Object.freeze(['daily', 'weekly', 'academic_daily', 'academic_weekly']);
const LINK_KEYS = Object.freeze(['cloudflare', 'google_analytics', 'search_console', 'barion', 'szamlazz']);
const DEFAULT_DAILY_GENERATION_CAP = 250;
const MAX_DAILY_GENERATION_CAP = 100000;
const MAX_ANNOUNCEMENT_LENGTH = 200;
const MAX_LINK_LENGTH = 500;
// Beépített rendszersablonok: nem törölhetők. Az ezeken kívüli azonosítók az Adminban létrehozott egyedi sablonok.
const TEMPLATE_IDS = Object.freeze(['base_layout', 'welcome_email', 'payment_success', 'feedback_request', 'password_reset', 'invoice_only']);
const CUSTOM_TEMPLATE_ID = /^[a-z][a-z0-9_]{2,39}$/;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_PRICE_HUF = 100000;
const MAX_HINTS = 12;
const MAX_HINT_LENGTH = 120;
const MAX_PROMPT_LENGTH = 8000;
const MAX_TEMPLATE_LENGTH = 100000;

const DEFAULT_SETTINGS = Object.freeze({
  pricing: Object.freeze({ daily: 390, weekly: 890, academic_daily: 690, academic_weekly: 690 }),
  daily_generation_cap: DEFAULT_DAILY_GENERATION_CAP,
  announcement_bar: Object.freeze({ enabled: false, text: '' }),
  external_links: Object.freeze({
    cloudflare: 'https://dash.cloudflare.com/',
    google_analytics: 'https://analytics.google.com/',
    search_console: 'https://search.google.com/search-console',
    barion: 'https://secure.barion.com/',
    szamlazz: 'https://www.szamlazz.hu/szamla/login'
  }),
  ai_config: Object.freeze({
    model: 'gemini-3.1-pro-preview',
    system_prompt: DEFAULT_SYSTEM_PROMPT
  }),
  maintenance_mode: false,
  notification_email: '',
  billing_notification_email: '',
  error_notification_email: '',
  billing_profile: process.env.BILLING_PROFILE === 'kft' ? 'kft' : 'ev',
  payment_provider: 'barion',
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

const OBJECT_SETTINGS = Object.freeze(['pricing', 'ai_config', 'announcement_bar', 'external_links']);

// A régi 3 szintű árazás (standard / academic / weekly) a 4 csomagos alakra képeződik; az új kulcsok előnyben vannak.
function migrateLegacyPricing(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const mapped = {};
  if ('standard' in value) mapped.daily = value.standard;
  if ('weekly' in value) mapped.weekly = value.weekly;
  if ('academic' in value) { mapped.academic_daily = value.academic; mapped.academic_weekly = value.academic; }
  const out = { ...mapped };
  for (const tier of PRICE_TIERS) if (tier in value) out[tier] = value[tier];
  return out;
}

function isValidHttpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_LINK_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// A hiányzó vagy hibás kulcsok alapértéket kapnak; az adatbázis tartalma így sem tud érvénytelen alakot adni.
function normalizeRows(rows) {
  const out = defaults();
  for (const row of rows || []) {
    if (!row || !(row.key in out)) continue;
    const value = row.key === 'pricing' ? migrateLegacyPricing(row.value) : row.value;
    out[row.key] = OBJECT_SETTINGS.includes(row.key) ? { ...out[row.key], ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) } : row.value;
  }
  for (const tier of PRICE_TIERS) if (!Number.isInteger(out.pricing[tier]) || out.pricing[tier] < 1) out.pricing[tier] = DEFAULT_SETTINGS.pricing[tier];
  out.pricing = Object.fromEntries(PRICE_TIERS.map((tier) => [tier, out.pricing[tier]]));
  if (!Number.isInteger(out.daily_generation_cap) || out.daily_generation_cap < 1 || out.daily_generation_cap > MAX_DAILY_GENERATION_CAP) out.daily_generation_cap = DEFAULT_DAILY_GENERATION_CAP;
  out.announcement_bar = { enabled: out.announcement_bar.enabled === true, text: typeof out.announcement_bar.text === 'string' ? out.announcement_bar.text : '' };
  out.external_links = Object.fromEntries(LINK_KEYS.map((key) => [key, isValidHttpsUrl(out.external_links[key]) ? out.external_links[key] : '']));
  out.maintenance_mode = out.maintenance_mode === true;
  if (!BILLING_PROFILE_TYPES.includes(out.billing_profile)) out.billing_profile = defaults().billing_profile;
  if (!PAYMENT_PROVIDERS.includes(out.payment_provider)) out.payment_provider = defaults().payment_provider;
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
  const settings = normalizeRows(data);
  // Csak a ténylegesen elmentett érték írja felül a BILLING_PROFILE környezeti változót.
  const stored = (data || []).find((row) => row?.key === 'billing_profile');
  setActiveBillingProfile(stored ? settings.billing_profile : null);
  return settings;
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
  setActiveBillingProfile(null);
  cache = null;
  cachedAt = 0;
  templateCache = null;
  templateCachedAt = 0;
}

// Az árak nem változnak a 4 kategóriára állításkor: a heti alapcsomag a „Napi ovis”, a heti részletes (komplex) csomag a „Heti ovis” árat használja.
function pricingTierFor(productKey) {
  if (productKey === 'weekly') return 'daily';
  return productKey === 'weekly_detailed' ? 'weekly' : String(productKey);
}

const isValidEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(value);

// Üzemeltetői értesítési cím: az adminban mentett érték, ennek hiányában a környezeti változók (csak tartalék). A vevői levelek ettől függetlenül a vevőhöz mennek.
// kind: 'billing' (számlázási/rendelési) | 'error' (hiba-, tesztelési, visszajelzési) | nincs (közös cím). Sorrend: típusspecifikus admin-érték > közös admin-érték > env.
function resolveNotificationEmail(settings, env = process.env, kind = '') {
  const specificKey = kind === 'billing' ? 'billing_notification_email' : kind === 'error' ? 'error_notification_email' : '';
  for (const key of [specificKey, 'notification_email']) {
    const stored = key ? String(settings?.[key] || '').trim() : '';
    if (stored && isValidEmail(stored)) return stored;
  }
  const specificEnv = kind === 'billing' ? 'BILLING_NOTIFICATION_EMAIL' : kind === 'error' ? 'ERROR_NOTIFICATION_EMAIL' : 'NOTIFICATION_EMAIL';
  for (const name of [specificEnv, 'NOTIFICATION_EMAIL', 'ADMIN_NOTIFICATION_EMAIL', 'ADMIN_EMAIL', 'SUPPORT_EMAIL']) {
    const value = String(env?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

// A napi plafon a beállításból jön (érvénytelen vagy hiányzó értéknél 250).
function dailyGenerationCapOf(settings) {
  const cap = settings?.daily_generation_cap;
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_DAILY_GENERATION_CAP;
}

function publicConfig(settings) {
  return {
    pricing: { ...settings.pricing },
    announcement_bar: { ...settings.announcement_bar },
    maintenance_mode: settings.maintenance_mode === true,
    billing_profile: settings.billing_profile,
    payment_provider: settings.payment_provider,
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
  if ('billing_profile' in patch) {
    if (!BILLING_PROFILE_TYPES.includes(patch.billing_profile)) throw new SettingsError('A számlázási profil „ev” vagy „kft” lehet.');
    updates.billing_profile = patch.billing_profile;
  }
  if ('payment_provider' in patch) {
    if (!PAYMENT_PROVIDERS.includes(patch.payment_provider)) throw new SettingsError('A fizetési szolgáltató „barion” vagy „stripe” lehet.');
    updates.payment_provider = patch.payment_provider;
  }
  if ('notification_email' in patch) {
    if (typeof patch.notification_email !== 'string') throw new SettingsError('Az értesítési e-mail cím szöveg legyen.');
    const email = patch.notification_email.trim();
    if (email && !isValidEmail(email)) throw new SettingsError('Az értesítési e-mail cím érvénytelen. Üresen hagyva a környezeti változók érvényesek.');
    updates.notification_email = email;
  }
  for (const [key, label] of [['billing_notification_email', 'számlázási/rendelési értesítési'], ['error_notification_email', 'hibariasztási/tesztelési/visszajelzési']]) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'string') throw new SettingsError(`A ${label} e-mail cím szöveg legyen.`);
    const email = patch[key].trim();
    if (email && !isValidEmail(email)) throw new SettingsError(`A ${label} e-mail cím érvénytelen. Üresen hagyva a közös cím, majd a környezeti változók érvényesek.`);
    updates[key] = email;
  }
  if ('daily_generation_cap' in patch) {
    const raw = typeof patch.daily_generation_cap === 'string' && patch.daily_generation_cap.trim() !== '' ? Number(patch.daily_generation_cap) : patch.daily_generation_cap;
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_DAILY_GENERATION_CAP) throw new SettingsError(`A napi generálási plafon egész szám legyen 1 és ${MAX_DAILY_GENERATION_CAP} között.`);
    updates.daily_generation_cap = raw;
  }
  if ('announcement_bar' in patch) {
    const source = patch.announcement_bar;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SettingsError('Az akciós sáv JSON objektum legyen.');
    const enabled = 'enabled' in source ? source.enabled : current.announcement_bar.enabled;
    const rawText = 'text' in source ? source.text : current.announcement_bar.text;
    if (typeof enabled !== 'boolean') throw new SettingsError('Az akciós sáv bekapcsolása igaz/hamis érték legyen.');
    if (typeof rawText !== 'string') throw new SettingsError('Az akciós sáv szövege szöveg legyen.');
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) throw new SettingsError(`Az akciós sáv szövege legfeljebb ${MAX_ANNOUNCEMENT_LENGTH} karakter lehet.`);
    if (enabled && !text) throw new SettingsError('Bekapcsolt akciós sávhoz szöveg megadása kötelező.');
    updates.announcement_bar = { enabled, text };
  }
  if ('external_links' in patch) {
    const source = patch.external_links;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SettingsError('A külső linkek JSON objektum legyenek.');
    const extra = Object.keys(source).filter((key) => !LINK_KEYS.includes(key));
    if (extra.length) throw new SettingsError(`Ismeretlen link: ${extra.slice(0, 3).join(', ')}.`);
    updates.external_links = {};
    for (const key of LINK_KEYS) {
      const value = key in source ? source[key] : current.external_links[key];
      const url = typeof value === 'string' ? value.trim() : null;
      if (url === null) throw new SettingsError(`A(z) ${key} link szöveg legyen.`);
      if (url && !isValidHttpsUrl(url)) throw new SettingsError(`A(z) ${key} link érvényes https:// címet tartalmazzon (legfeljebb ${MAX_LINK_LENGTH} karakter).`);
      updates.external_links[key] = url;
    }
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
  if ('billing_profile' in updates) setActiveBillingProfile(updates.billing_profile);
  return cache;
}

// ---------- E-mail sablonok ----------

// Az értékeléskérő blokk alapértelmezett sablonja ({{stars}}: a csillag-linkek, {{feedback_url}}: az 5 csillagos link); a mentett sablon felülírja.
const DEFAULT_FEEDBACK_REQUEST_HTML = `<div style="margin:22px 0 0;padding:16px 18px;background:#f9fbf9;border:1px solid #d9ebe0;border-radius:14px;text-align:center;">
<p style="margin:0 0 10px;font-size:13.5px;line-height:1.5;color:#4a5953;font-weight:600;">Hogy sikerült a tervezet? Kattints a csillagokra, és írd meg 1 percben a véleményed:</p>
<div style="display:inline-block;text-align:center;">
{{stars}}
</div>
</div>`;
// A „Csak számla küldése” levél: csak a számla PDF mellékletével, tervezet-melléklet és Word-tipp nélkül ({{invoiceNumber}}, {{topic}}, {{orderId}}, {{site_url}}).
const DEFAULT_INVOICE_ONLY_SUBJECT = 'Számlája elkészült – OviTervező ({{invoiceNumber}})';
const DEFAULT_INVOICE_ONLY_HTML = `<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – mellékelten küldjük a vásárlásáról kiállított számlát PDF formátumban.</p>
<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Megrendelés témája:</strong> {{topic}}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;font-size:14px;line-height:1.7;color:#2d3b36;">
<div>Rendelésszám: <strong>{{orderId}}</strong></div>
<div>Számlaszám: <strong>{{invoiceNumber}}</strong></div>
<div style="margin-top:6px;color:#1f5f52;font-weight:600;">📎 Csatolmány: Számla (PDF)</div>
</td></tr></table>
<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">A számla elektronikus úton továbbított, nyomtatás nélkül is könyvelhető bizonylat. Kérjük, őrizze meg saját nyilvántartása számára.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{site_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>`;
const DEFAULT_TEMPLATES = Object.freeze({
  feedback_request: Object.freeze({ id: 'feedback_request', subject: 'Értékeléskérő blokk (a kézbesítő levélben)', bodyHtml: DEFAULT_FEEDBACK_REQUEST_HTML }),
  invoice_only: Object.freeze({ id: 'invoice_only', subject: DEFAULT_INVOICE_ONLY_SUBJECT, bodyHtml: DEFAULT_INVOICE_ONLY_HTML })
});

// A name / is_system oszlopokat a 20261201090000 migráció adja; nélkülük a kód a régi sémával is működik.
function isMissingColumn(error) {
  return error?.code === '42703' || error?.code === 'PGRST204' || /column .*(does not exist|schema cache)|could not find the/i.test(String(error?.message || ''));
}

function templateRow(row) {
  const custom = !TEMPLATE_IDS.includes(row.id);
  return { id: row.id, name: row.name || '', subject: row.subject || '', bodyHtml: row.body_html || '', custom, hasDefault: row.id in DEFAULT_TEMPLATES };
}

async function listTemplates(client) {
  let result = await client.from('email_templates').select('id, subject, body_html, name');
  if (result.error && isMissingColumn(result.error)) result = await client.from('email_templates').select('id, subject, body_html');
  if (result.error) throw dbError('Az e-mail sablonok nem olvashatók', result.error);
  const rows = (result.data || []).map(templateRow);
  // A még nem mentett, de beépített alapértékkel rendelkező sablon is szerkeszthető.
  for (const [id, fallback] of Object.entries(DEFAULT_TEMPLATES)) {
    if (!rows.some((row) => row.id === id)) rows.push({ ...fallback, name: '', custom: false, hasDefault: true });
  }
  return rows;
}

const HISTORY_LIMIT = 50;

// A módosítási napló (system_settings_history, trigger tölti), időrendben csökkenve.
async function listHistory(client, key) {
  if (!(key in DEFAULT_SETTINGS)) throw new SettingsError('Ismeretlen beállítás.', 404);
  const { data, error } = await client.from('system_settings_history').select('id, setting_key, old_value, new_value, changed_at')
    .eq('setting_key', key).order('changed_at', { ascending: false }).limit(HISTORY_LIMIT);
  if (error) throw dbError('A beállítás előzményei nem olvashatók', error);
  return (data || []).map((row) => ({ id: row.id, key: row.setting_key, oldValue: row.old_value, newValue: row.new_value, changedAt: row.changed_at }));
}

function validateTemplateContent(id, body) {
  const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').trim() : null;
  const bodyHtml = typeof body.bodyHtml === 'string' ? body.bodyHtml : null;
  if (subject === null || bodyHtml === null) throw new SettingsError('A tárgy és a HTML-szöveg megadása kötelező.');
  if (subject.length > 200) throw new SettingsError('A tárgy legfeljebb 200 karakter lehet.');
  if (!bodyHtml.trim() || bodyHtml.length > MAX_TEMPLATE_LENGTH) throw new SettingsError(`A HTML-szöveg kötelező, legfeljebb ${MAX_TEMPLATE_LENGTH} karakter.`);
  if (id === 'base_layout' && !bodyHtml.includes('{{content}}')) throw new SettingsError('A base_layout sablonnak tartalmaznia kell a {{content}} helyőrzőt.');
  if (id === 'feedback_request' && !/\{\{\s*(stars|feedback_url)\s*\}\}/.test(bodyHtml)) throw new SettingsError('Az értékeléskérő sablonnak tartalmaznia kell a {{stars}} vagy a {{feedback_url}} helyőrzőt.');
  return { subject, bodyHtml };
}

function validateTemplateName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > MAX_TEMPLATE_NAME_LENGTH) throw new SettingsError(`A sablon megjelenített neve kötelező, legfeljebb ${MAX_TEMPLATE_NAME_LENGTH} karakter.`);
  return name;
}

// Mentés a bővített sémával; ha a name / is_system oszlop még nincs meg (migráció előtt), a tartalom ezek nélkül is elmentődik.
async function saveTemplateRow(client, row, { insertOnly = false } = {}) {
  const write = (payload) => (insertOnly
    ? client.from('email_templates').insert(payload)
    : client.from('email_templates').upsert(payload, { onConflict: 'id' }));
  let { error } = await write(row);
  if (error && isMissingColumn(error)) {
    const { name: _name, is_system: _system, ...legacy } = row;
    ({ error } = await write(legacy));
  }
  if (error) {
    if (insertOnly && (error.code === '23505' || /duplicate key/i.test(error.message || ''))) throw new SettingsError('Ilyen azonosítójú sablon már létezik.', 409);
    throw dbError('Az e-mail sablon mentése sikertelen', error);
  }
}

async function updateTemplate(client, id, body = {}) {
  const custom = !TEMPLATE_IDS.includes(id);
  if (custom && (!CUSTOM_TEMPLATE_ID.test(id) || !(await listTemplates(client)).some((row) => row.id === id))) throw new SettingsError('Ismeretlen e-mail sablon.', 404);
  const { subject, bodyHtml } = validateTemplateContent(id, body);
  const row = { id, subject, body_html: bodyHtml };
  const result = { id, subject, bodyHtml };
  if (custom && 'name' in body) {
    row.name = validateTemplateName(body.name);
    result.name = row.name;
  }
  await saveTemplateRow(client, row);
  templateCache = null;
  return { ...result, custom, hasDefault: id in DEFAULT_TEMPLATES };
}

// Új egyedi sablon: kisbetűs azonosító (slug), a rendszersablonok azonosítói foglaltak.
async function createTemplate(client, body = {}) {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!CUSTOM_TEMPLATE_ID.test(id)) throw new SettingsError('Az azonosító 3–40 karakter lehet: kisbetű, szám és alsó vonás, betűvel kezdődően.');
  if (TEMPLATE_IDS.includes(id)) throw new SettingsError('Ez az azonosító egy beépített rendszersablonhoz tartozik.', 409);
  const name = validateTemplateName(body.name);
  const { subject, bodyHtml } = validateTemplateContent(id, body);
  await saveTemplateRow(client, { id, name, subject, body_html: bodyHtml, is_system: false }, { insertOnly: true });
  templateCache = null;
  return { id, name, subject, bodyHtml, custom: true, hasDefault: false };
}

// Csak egyedi sablon törölhető; a rendszersablon alapértékre állítható vissza.
async function deleteTemplate(client, id) {
  if (TEMPLATE_IDS.includes(id)) throw new SettingsError('A rendszersablon nem törölhető, csak alapértékre állítható vissza.', 409);
  if (!CUSTOM_TEMPLATE_ID.test(String(id)) || !(await listTemplates(client)).some((row) => row.id === id)) throw new SettingsError('Ismeretlen e-mail sablon.', 404);
  const { error } = await client.from('email_templates').delete().eq('id', id);
  if (error) throw dbError('Az e-mail sablon törlése sikertelen', error);
  templateCache = null;
  return { id };
}

// A beépített alapértékkel rendelkező rendszersablon (jelenleg: invoice_only, feedback_request) visszaállítása.
async function resetTemplate(client, id) {
  const fallback = DEFAULT_TEMPLATES[id];
  if (!fallback) throw new SettingsError('Ennek a sablonnak nincs beépített alapértéke.', 409);
  await saveTemplateRow(client, { id, subject: fallback.subject, body_html: fallback.bodyHtml });
  templateCache = null;
  return { ...fallback, name: '', custom: false, hasDefault: true };
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
  isValidModelName, PRICE_TIERS, LINK_KEYS, BILLING_PROFILE_TYPES, PAYMENT_PROVIDERS, TEMPLATE_IDS, DEFAULT_SETTINGS, DEFAULT_DAILY_GENERATION_CAP, CACHE_TTL_MS, SettingsError,
  getSettings, peek, invalidate, updateSettings, publicConfig, pricingTierFor, dailyGenerationCapOf, resolveNotificationEmail, isValidEmail, resolveAiModel,
  listTemplates, listHistory, updateTemplate, createTemplate, deleteTemplate, resetTemplate, DEFAULT_TEMPLATES, getTemplates, fillPlaceholders, composeEmail
};
