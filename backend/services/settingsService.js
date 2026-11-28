'use strict';

// Adatbázis-vezérelt rendszerbeállítások (árak, AI, karbantartás, szezonális javaslatok) és e-mail sablonok.
// A beállítások 5 percig gyorsítótárban élnek; az admin módosítása azonnal frissíti a gyorsítótárat.
// Adatbázis-kliens nélkül (teszt, helyi fejlesztés) a beégetett alapértékek érvényesek; konfigurált, de hibázó adatbázisnál a hiba nem rejtődik el.
const supabase = require('./supabaseService');
const { setActiveBillingProfile } = require('./siteConstants');
const plannerConfig = require('./plannerConfigDefaults');
const auditLog = require('./auditLog');

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYSTEM_PROMPT = require('./defaultSystemPrompt');
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isValidModelName = (value) => typeof value === 'string' && MODEL_NAME_PATTERN.test(value);
const BILLING_PROFILE_TYPES = Object.freeze(['ev', 'kft']);
const PAYMENT_PROVIDERS = Object.freeze(['barion', 'stripe']);
// daily: napi ár; weekly_summary: heti összesítő alapára (a csomag alapja is); weekly_extra_day: kidolgozott napi terv felára csomagban (Ft / nap, lehet 0).
const PRICE_TIERS = Object.freeze(['daily', 'weekly_summary', 'weekly_extra_day', 'academic_daily', 'academic_weekly']);
const ZERO_ALLOWED_TIERS = Object.freeze(['weekly_extra_day']);
const MAX_EXTRA_DAY_PRICE_HUF = 50000;
const maxPriceFor = (tier) => (tier === 'weekly_extra_day' ? MAX_EXTRA_DAY_PRICE_HUF : MAX_PRICE_HUF);
const minPriceFor = (tier) => (ZERO_ALLOWED_TIERS.includes(tier) ? 0 : 1);
const isValidPrice = (tier, value) => Number.isInteger(value) && value >= minPriceFor(tier) && value <= maxPriceFor(tier);
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
const MAX_PROMPT_LENGTH = 100000;
const MAX_TEMPLATE_LENGTH = 100000;

const DEFAULT_SETTINGS = Object.freeze({
  // Az árak egyetlen alapérték-forrása; minden más felület ezt (vagy az Admin-értéket) használja.
  pricing: Object.freeze({ daily: 390, weekly_summary: 590, weekly_extra_day: 100, academic_daily: 690, academic_weekly: 690 }),
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
  // Nyilvános követőkódok (a böngészőben is láthatók, nem titkosak); a betöltésüket a látogatói hozzájárulás vezérli.
  tracking_config: Object.freeze({ barion_pixel_id: 'BP-U0p5Sp7I1Q-EF', ga4_measurement_id: 'G-P47M4MVRM6', meta_pixel_id: '' }),
  maintenance_mode: false,
  notification_email: '',
  billing_notification_email: '',
  error_notification_email: '',
  billing_profile: process.env.BILLING_PROFILE === 'kft' ? 'kft' : 'ev',
  payment_provider: 'barion',
  // Csak az alapértéktől eltérő rész tárolódik (lásd plannerConfigDefaults.js).
  planner_config: Object.freeze({ texts: Object.freeze({}), optionLists: Object.freeze({}) })
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

const OBJECT_SETTINGS = Object.freeze(['pricing', 'ai_config', 'announcement_bar', 'external_links', 'tracking_config']);

const TRACKING_FIELDS = Object.freeze({
  barion_pixel_id: { pattern: /^BP-[A-Za-z0-9]{6,25}-[A-Za-z0-9]{1,6}$/, label: 'Barion Pixel azonosító', example: 'BP-xxxxxxxxxx-XX' },
  ga4_measurement_id: { pattern: /^G-[A-Z0-9]{6,20}$/, label: 'GA4 mérési azonosító', example: 'G-XXXXXXXXXX' },
  meta_pixel_id: { pattern: /^[0-9]{10,20}$/, label: 'Meta Pixel azonosító', example: '1234567890123456' }
});
const TRACKING_KEYS = Object.freeze(Object.keys(TRACKING_FIELDS));
const isValidTrackingValue = (key, value) => typeof value === 'string' && (value === '' || TRACKING_FIELDS[key].pattern.test(value));

// A régi árazások ({ standard, academic, weekly } és { daily, weekly, academic_* }) az új 5 elemű alakra képeződnek: az egyedi daily / academic_* érték megmarad,
// a régi „weekly” (teljes csomag fix ár) kimarad, a hiányzó weekly_summary / weekly_extra_day az alapértékből töltődik (lásd normalizeRows).
function migrateLegacyPricing(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const mapped = {};
  if ('standard' in value) mapped.daily = value.standard;
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
    if (row.key === 'planner_config') {
      out.planner_config = plannerConfig.diffFromDefaults(plannerConfig.mergePlannerConfig(row.value));
      continue;
    }
    out[row.key] = OBJECT_SETTINGS.includes(row.key) ? { ...out[row.key], ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) } : row.value;
  }
  for (const tier of PRICE_TIERS) if (!isValidPrice(tier, out.pricing[tier])) out.pricing[tier] = DEFAULT_SETTINGS.pricing[tier];
  out.pricing = Object.fromEntries(PRICE_TIERS.map((tier) => [tier, out.pricing[tier]]));
  if (!Number.isInteger(out.daily_generation_cap) || out.daily_generation_cap < 1 || out.daily_generation_cap > MAX_DAILY_GENERATION_CAP) out.daily_generation_cap = DEFAULT_DAILY_GENERATION_CAP;
  out.announcement_bar = { enabled: out.announcement_bar.enabled === true, text: typeof out.announcement_bar.text === 'string' ? out.announcement_bar.text : '' };
  out.external_links = Object.fromEntries(LINK_KEYS.map((key) => [key, isValidHttpsUrl(out.external_links[key]) ? out.external_links[key] : '']));
  out.tracking_config = Object.fromEntries(TRACKING_KEYS.map((key) => [key, isValidTrackingValue(key, out.tracking_config[key]) ? out.tracking_config[key] : DEFAULT_SETTINGS.tracking_config[key]]));
  out.maintenance_mode = out.maintenance_mode === true;
  if (!BILLING_PROFILE_TYPES.includes(out.billing_profile)) out.billing_profile = defaults().billing_profile;
  if (!PAYMENT_PROVIDERS.includes(out.payment_provider)) out.payment_provider = defaults().payment_provider;
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

// Az árkulcs és a beállításkulcs egyezik (a heti csomag ára a weekly_summary + napok × weekly_extra_day képletből jön, lásd pricing.js).
function pricingTierFor(productKey) {
  const key = String(productKey);
  return key === 'weekly' || key === 'weekly_detailed' || key === 'weekly_package' ? 'weekly_summary' : key;
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
    tracking_config: { ...settings.tracking_config },
    maintenance_mode: settings.maintenance_mode === true,
    billing_profile: settings.billing_profile,
    payment_provider: settings.payment_provider,
    planner_config: plannerConfig.publicView(settings.planner_config)
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
  if (!isValidPrice(label, number)) {
    throw new SettingsError(`A(z) ${label} ár egész szám legyen ${minPriceFor(label)} és ${maxPriceFor(label)} Ft között.`);
  }
  return number;
}

// A részleges módosítás (PATCH) csak az ismert kulcsokat engedi, és az összevont értéket validálja.
function validatePatch(patch, current, options = {}) {
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
  if ('tracking_config' in patch) {
    const source = patch.tracking_config;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SettingsError('A követőkódok JSON objektum legyenek.');
    const extra = Object.keys(source).filter((key) => !TRACKING_KEYS.includes(key));
    if (extra.length) throw new SettingsError(`Ismeretlen követőkód: ${extra.slice(0, 3).join(', ')}.`);
    updates.tracking_config = {};
    for (const key of TRACKING_KEYS) {
      const raw = key in source ? source[key] : current.tracking_config[key];
      if (typeof raw !== 'string') throw new SettingsError(`A(z) ${TRACKING_FIELDS[key].label} szöveg legyen.`);
      const value = raw.trim();
      if (!isValidTrackingValue(key, value)) throw new SettingsError(`Érvénytelen ${TRACKING_FIELDS[key].label} (formátum: ${TRACKING_FIELDS[key].example}). Üresen hagyva kikapcsolt.`);
      updates.tracking_config[key] = value;
    }
  }
  if ('planner_config' in patch) {
    try {
      updates.planner_config = plannerConfig.applyPatch(plannerConfig.mergePlannerConfig(current.planner_config), patch.planner_config, { replace: options.replace === true });
    } catch (error) {
      if (error instanceof plannerConfig.PlannerConfigError) throw new SettingsError(error.message);
      throw error;
    }
  }
  if (!Object.keys(updates).length) throw new SettingsError('Nincs módosítandó beállítás.');
  return updates;
}

// A módosító (admin e-mail) az updated_by oszlopba kerül, abból tölti a history.changed_by mezőt a trigger (20261203090000 migráció); nélküle is ment.
async function updateSettings(client, patch, actor = '', options = {}) {
  const current = await getSettings({ force: true });
  const updates = validatePatch(patch, current, options);
  const stamp = new Date().toISOString();
  const by = String(actor || '').trim().slice(0, 254);
  const rows = Object.entries(updates).map(([key, value]) => ({ key, value, updated_at: stamp }));
  let { error } = await client.from('system_settings').upsert(by ? rows.map((row) => ({ ...row, updated_by: by })) : rows, { onConflict: 'key' });
  if (error && by && isMissingColumn(error)) ({ error } = await client.from('system_settings').upsert(rows, { onConflict: 'key' }));
  if (error) throw dbError('A beállítások mentése sikertelen', error);
  cache = normalizeRows([...Object.entries(current).map(([key, value]) => ({ key, value })), ...rows]);
  cachedAt = Date.now();
  if ('billing_profile' in updates) setActiveBillingProfile(updates.billing_profile);
  if ('planner_config' in updates) await auditLog.recordChange(client, 'planner_config', current.planner_config, updates.planner_config, by);
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
// A kézbesítő levél (payment_success) és a közös keret (base_layout) hivatalos alapértéke: a ténylegesen kiküldött, értékeléskérő blokkot ({{feedback_block}}) is tartalmazó HTML.
const DEFAULT_BASE_LAYOUT_SUBJECT = 'OviTervező';
const DEFAULT_BASE_LAYOUT_HTML = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><img src="{{logo_src}}" width="52" height="52" alt="OT" style="display:block;border:0;border-radius:12px;"></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
{{content}}
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
{{unsubscribe_link}}
<strong>Kibocsátó:</strong> {{company_legal}}.<br>
<a href="{{site_url}}" style="color:#7a8480;">Adatkezelési tájékoztató</a> · <a href="{{site_url}}" style="color:#7a8480;">ÁSZF</a> – <a href="{{site_url}}" style="color:#7a8480;">{{site_url}}</a><br>
Ez a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.
</td></tr>
</table></td></tr></table></body></html>`;
const DEFAULT_PAYMENT_SUCCESS_SUBJECT = 'OviTervező – a megvásárolt tervezet és a számla';
const DEFAULT_PAYMENT_SUCCESS_HTML = `<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – és köszönjük az elhivatott munkát, amellyel nap mint nap a gyerekek mellett áll.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Reméljük, hogy a kész tervezet sok időt spórol Önnek, így több jut a legfontosabbra: a közös játékra és felfedezésre.</p>
<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Tervezet témája:</strong> {{topic}}</p>
{{plan_type_block}}
<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Rendelésszám: <strong>{{orderId}}</strong></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#1f5f52;margin-bottom:4px;">📎 Mellékletek</div>
<table role="presentation" cellpadding="0" cellspacing="0">{{attachments_rows}}</table>
</td></tr></table>
<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Tipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{site_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>
{{feedback_block}}`;
const DEFAULT_TEMPLATES = Object.freeze({
  base_layout: Object.freeze({ id: 'base_layout', subject: DEFAULT_BASE_LAYOUT_SUBJECT, bodyHtml: DEFAULT_BASE_LAYOUT_HTML }),
  payment_success: Object.freeze({ id: 'payment_success', subject: DEFAULT_PAYMENT_SUCCESS_SUBJECT, bodyHtml: DEFAULT_PAYMENT_SUCCESS_HTML }),
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

// E-mail sablon módosítás naplózása a beállítások előzményei közé (setting_key = 'email_template:<id>'); a napló hibája nem akadályozza a mentést.
async function logTemplateChange(client, id, before, after, actor) {
  const view = (row) => (row ? { name: row.name || '', subject: row.subject || '', bodyHtml: row.bodyHtml || '' } : null);
  const row = { setting_key: `email_template:${id}`, old_value: view(before), new_value: view(after), changed_by: String(actor || '').slice(0, 254) || null };
  try {
    let { error } = await client.from('system_settings_history').insert(row);
    if (error && isMissingColumn(error)) {
      const { changed_by: _by, ...legacy } = row;
      ({ error } = await client.from('system_settings_history').insert(legacy));
    }
    if (error) throw new Error(error.message);
  } catch (error) {
    console.warn(`[settings] A sablonmódosítás naplózása sikertelen: ${error.message}`);
  }
}

async function findTemplate(client, id) {
  return (await listTemplates(client)).find((row) => row.id === id) || null;
}

async function updateTemplate(client, id, body = {}, actor = '') {
  const custom = !TEMPLATE_IDS.includes(id);
  if (custom && (!CUSTOM_TEMPLATE_ID.test(id) || !(await listTemplates(client)).some((row) => row.id === id))) throw new SettingsError('Ismeretlen e-mail sablon.', 404);
  const { subject, bodyHtml } = validateTemplateContent(id, body);
  const row = { id, subject, body_html: bodyHtml };
  const result = { id, subject, bodyHtml };
  if (custom && 'name' in body) {
    row.name = validateTemplateName(body.name);
    result.name = row.name;
  }
  const before = await findTemplate(client, id);
  await saveTemplateRow(client, row);
  templateCache = null;
  await logTemplateChange(client, id, before, { ...before, ...result }, actor);
  return { ...result, custom, hasDefault: id in DEFAULT_TEMPLATES };
}

// Új egyedi sablon: kisbetűs azonosító (slug), a rendszersablonok azonosítói foglaltak.
async function createTemplate(client, body = {}, actor = '') {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!CUSTOM_TEMPLATE_ID.test(id)) throw new SettingsError('Az azonosító 3–40 karakter lehet: kisbetű, szám és alsó vonás, betűvel kezdődően.');
  if (TEMPLATE_IDS.includes(id)) throw new SettingsError('Ez az azonosító egy beépített rendszersablonhoz tartozik.', 409);
  const name = validateTemplateName(body.name);
  const { subject, bodyHtml } = validateTemplateContent(id, body);
  await saveTemplateRow(client, { id, name, subject, body_html: bodyHtml, is_system: false }, { insertOnly: true });
  templateCache = null;
  await logTemplateChange(client, id, null, { name, subject, bodyHtml }, actor);
  return { id, name, subject, bodyHtml, custom: true, hasDefault: false };
}

// Csak egyedi sablon törölhető; a rendszersablon alapértékre állítható vissza.
async function deleteTemplate(client, id, actor = '') {
  if (TEMPLATE_IDS.includes(id)) throw new SettingsError('A rendszersablon nem törölhető, csak alapértékre állítható vissza.', 409);
  if (!CUSTOM_TEMPLATE_ID.test(String(id)) || !(await listTemplates(client)).some((row) => row.id === id)) throw new SettingsError('Ismeretlen e-mail sablon.', 404);
  const before = await findTemplate(client, id);
  const { error } = await client.from('email_templates').delete().eq('id', id);
  if (error) throw dbError('Az e-mail sablon törlése sikertelen', error);
  templateCache = null;
  await logTemplateChange(client, id, before, null, actor);
  return { id };
}

// A beépített alapértékkel rendelkező rendszersablon (jelenleg: invoice_only, feedback_request) visszaállítása.
async function resetTemplate(client, id, actor = '') {
  const fallback = DEFAULT_TEMPLATES[id];
  if (!fallback) throw new SettingsError('Ennek a sablonnak nincs beépített alapértéke.', 409);
  const before = await findTemplate(client, id);
  await saveTemplateRow(client, { id, subject: fallback.subject, body_html: fallback.bodyHtml });
  templateCache = null;
  await logTemplateChange(client, id, before, { ...before, subject: fallback.subject, bodyHtml: fallback.bodyHtml }, actor);
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
  isValidModelName, TRACKING_KEYS, PRICE_TIERS, LINK_KEYS, BILLING_PROFILE_TYPES, PAYMENT_PROVIDERS, TEMPLATE_IDS, DEFAULT_SETTINGS, DEFAULT_DAILY_GENERATION_CAP, CACHE_TTL_MS, SettingsError,
  MAX_PROMPT_LENGTH, validatePatch, getSettings, peek, invalidate, updateSettings, publicConfig, pricingTierFor, dailyGenerationCapOf, resolveNotificationEmail, isValidEmail, resolveAiModel,
  listTemplates, listHistory, updateTemplate, createTemplate, deleteTemplate, resetTemplate, DEFAULT_TEMPLATES, getTemplates, fillPlaceholders, composeEmail, plannerConfig
};
