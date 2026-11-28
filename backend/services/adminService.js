'use strict';

// Az Admin Központ adatrétege (csak a service-role Supabase klienssel hívható, az útvonalakat a requireAdmin védi).
// A hibák AdminError-ként érkeznek: a 4xx üzenete a kliensnek szól, az 5xx részleteit az útvonal naplózza, de nem adja ki.
const crypto = require('node:crypto');
const { CODE_PATTERN, normalizeCode } = require('./coupons');
const { normalizeEmail } = require('../utils/email');
const settingsService = require('./settingsService');
const auditLog = require('./auditLog');
const { countThemes, topThemes } = require('./themeStats');

class AdminError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_STATUSES = ['pending', 'paid', 'failed', 'cancelled'];
const MAX_ORDER_ROWS = 5000;
const REDEMPTION_LOG_SIZE = 50;

function dbError(error, context) {
  return new AdminError(`${context}: ${error?.message || 'adatbázishiba'}`, 500);
}

// Az API oldalanként legfeljebb 1000 sort ad, ezért stabil rendezéssel lapozunk.
async function fetchAll(build, context, maxRows = PAGE_SIZE * MAX_PAGES) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw dbError(error, context);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// A regisztrált felhasználók az auth.users táblában vannak (megerősítés időpontja, regisztráció dátuma).
async function listAuthUsers(client) {
  const users = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw dbError(error, 'A felhasználók lekérdezése sikertelen');
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return users;
}

const isConfirmed = (user) => Boolean(user?.email_confirmed_at);
const sum = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);

// ---------- Statisztika ----------

async function getStats(client, now = Date.now()) {
  const [orders, documents, authUsers, subscribed] = await Promise.all([
    fetchAll(() => client.from('orders').select('order_number, amount, created_at').eq('status', 'paid').order('order_number', { ascending: true }), 'A rendelések lekérdezése sikertelen'),
    fetchAll(() => client.from('documents').select('document_id, plan_mode, unlocked, request:data->plan->request').order('document_id', { ascending: true }), 'A tervezetek lekérdezése sikertelen'),
    listAuthUsers(client),
    fetchAll(() => client.from('newsletter_subscribers').select('email, user_id').eq('subscribed', true).order('email', { ascending: true }), 'A feliratkozók lekérdezése sikertelen')
  ]);

  const since = now - 30 * DAY_MS;
  const recent = orders.filter((order) => Date.parse(order.created_at) >= since);
  const confirmedIds = new Set(authUsers.filter(isConfirmed).map((user) => String(user.id)));

  // Háromrészes bontás: az oktatási célú (napi és heti), a heti csomag és a többi (napi standard) tervezet együtt adja a teljes számot.
  const breakdown = { standard: 0, academic: 0, weekly: 0 };
  for (const doc of documents) {
    if (doc.plan_mode === 'academic') breakdown.academic += 1;
    else if (doc.request?.duration === 'Heti') breakdown.weekly += 1;
    else breakdown.standard += 1;
  }
  const unlocked = documents.filter((doc) => doc.unlocked === true).length;

  return {
    revenue: { total: sum(orders, (o) => o.amount), last30Days: sum(recent, (o) => o.amount) },
    paidOrders: orders.length,
    registeredUsers: authUsers.length,
    confirmedSubscribers: subscribed.filter((row) => row.user_id && confirmedIds.has(String(row.user_id))).length,
    documents: {
      total: documents.length,
      unlocked,
      breakdown,
      topThemes: topThemes(countThemes(documents.map((doc) => doc.request?.theme))),
      conversionRate: documents.length ? Math.round((unlocked / documents.length) * 1000) / 10 : 0
    }
  };
}

// ---------- Kuponok ----------

const COUPON_COLUMNS = 'code, discount_percent, max_uses, valid_until, is_active, note, created_at';
const REDEMPTION_COLUMNS = 'id, coupon_code, user_email, document_id, plan_mode, original_price, discount_amount, final_price, used_at';

const couponView = (row, usage = {}) => ({
  code: row.code,
  discountPercent: row.discount_percent,
  maxUses: row.max_uses ?? null,
  validUntil: row.valid_until ?? null,
  isActive: row.is_active === true,
  note: row.note || '',
  createdAt: row.created_at,
  uses: usage.uses || 0,
  totalDiscount: usage.totalDiscount || 0
});

async function listCoupons(client) {
  const [coupons, redemptions] = await Promise.all([
    fetchAll(() => client.from('coupons').select(COUPON_COLUMNS).order('code', { ascending: true }), 'A kuponok lekérdezése sikertelen'),
    fetchAll(() => client.from('coupon_redemptions').select(REDEMPTION_COLUMNS).order('used_at', { ascending: false }), 'A kuponbeváltások lekérdezése sikertelen')
  ]);
  const usage = new Map();
  for (const row of redemptions) {
    const entry = usage.get(row.coupon_code) || { uses: 0, totalDiscount: 0 };
    entry.uses += 1;
    entry.totalDiscount += Number(row.discount_amount) || 0;
    usage.set(row.coupon_code, entry);
  }
  return {
    coupons: coupons.map((row) => couponView(row, usage.get(row.code))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    redemptions: redemptions.slice(0, REDEMPTION_LOG_SIZE).map((row) => ({
      id: row.id,
      code: row.coupon_code,
      email: row.user_email || '',
      documentId: row.document_id || '',
      planMode: row.plan_mode || '',
      originalPrice: row.original_price,
      discountAmount: row.discount_amount,
      finalPrice: row.final_price,
      usedAt: row.used_at
    }))
  };
}

function validationError(message) {
  return new AdminError(message, 400);
}

// A date input értéke (ÉÉÉÉ-HH-NN) a nap végéig érvényes; teljes ISO időpont is elfogadott. Múltbeli lejárat értelmetlen, ezért hiba.
function parseValidUntil(value, now) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) throw validationError('Az érvényesség vége nem érvényes dátum.');
  if (time <= now) throw validationError('Az érvényesség vége nem lehet múltbeli időpont.');
  return new Date(time).toISOString();
}

function parseCouponInput(body = {}, now = Date.now()) {
  const code = normalizeCode(body.code);
  if (!CODE_PATTERN.test(code)) throw validationError('A kuponkód 1–40 karakter lehet: angol betű, szám, kötőjel vagy aláhúzás.');
  const percent = typeof body.discount_percent === 'string' && body.discount_percent.trim() !== '' ? Number(body.discount_percent) : body.discount_percent;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw validationError('A kedvezmény 1 és 100 közötti egész százalék lehet.');
  let maxUses = null;
  if (body.max_uses !== undefined && body.max_uses !== null && body.max_uses !== '') {
    maxUses = typeof body.max_uses === 'string' ? Number(body.max_uses) : body.max_uses;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000000) throw validationError('A felhasználási keret legalább 1 egész szám lehet.');
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw validationError('A megjegyzés szöveges legyen.');
  const note = String(body.note || '').trim();
  if (note.length > 200) throw validationError('A megjegyzés legfeljebb 200 karakter lehet.');
  return { code, discount_percent: percent, max_uses: maxUses, valid_until: parseValidUntil(body.valid_until, now), note: note || null };
}

async function createCoupon(client, body, now = Date.now(), actor = '') {
  const input = parseCouponInput(body, now);
  const { data: existing, error: lookupError } = await client.from('coupons').select('code').eq('code', input.code).maybeSingle();
  if (lookupError) throw dbError(lookupError, 'A kupon ellenőrzése sikertelen');
  if (existing) throw new AdminError('Ilyen kuponkód már létezik.', 409);
  const { data, error } = await client.from('coupons').insert({ ...input, is_active: true }).select(COUPON_COLUMNS).single();
  if (error) {
    if (error.code === '23505') throw new AdminError('Ilyen kuponkód már létezik.', 409);
    throw dbError(error, 'A kupon mentése sikertelen');
  }
  await auditLog.recordChange(client, auditLog.couponKey(data.code), null, auditLog.couponSnapshot(data), actor);
  return couponView(data);
}

function parseCouponPatch(body = {}, now = Date.now()) {
  const patch = {};
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw validationError('Az is_active mező logikai érték (true/false) legyen.');
    patch.is_active = body.is_active;
  }
  if (body.valid_until !== undefined) patch.valid_until = parseValidUntil(body.valid_until, now);
  if (body.max_uses !== undefined) patch.max_uses = parseCouponInput({ code: 'X', discount_percent: 1, max_uses: body.max_uses }, now).max_uses;
  if (body.note !== undefined) patch.note = parseCouponInput({ code: 'X', discount_percent: 1, note: body.note }, now).note;
  if (!Object.keys(patch).length) throw validationError('Az is_active mező logikai érték (true/false) legyen.');
  return patch;
}

// A módosítás előtti állapot a naplóhoz; az olvasási hiba nem akaszthatja meg a műveletet.
async function couponBefore(client, code) {
  try {
    const { data } = await client.from('coupons').select(COUPON_COLUMNS).eq('code', code).maybeSingle();
    return data ? auditLog.couponSnapshot(data) : null;
  } catch (_error) {
    return null;
  }
}

async function updateCoupon(client, rawCode, body, now = Date.now(), actor = '') {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw new AdminError('A kupon nem található.', 404);
  const patch = parseCouponPatch(body, now);
  const before = await couponBefore(client, code);
  const { data, error } = await client.from('coupons').update(patch).eq('code', code).select(COUPON_COLUMNS);
  if (error) throw dbError(error, 'A kupon módosítása sikertelen');
  if (!data?.length) throw new AdminError('A kupon nem található.', 404);
  await auditLog.recordChange(client, auditLog.couponKey(code), before, auditLog.couponSnapshot(data[0]), actor);
  return couponView(data[0]);
}

const setCouponActive = (client, rawCode, isActive) => updateCoupon(client, rawCode, { is_active: isActive });

// Idegenkulcs-hivatkozás (rendelés, beváltás) esetén nem törlünk, hanem archiválunk: a kupon inaktív, tegnap lejárt, a megjegyzésben jelölve.
async function deleteCoupon(client, rawCode, now = Date.now(), actor = '') {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw new AdminError('A kupon nem található.', 404);
  const before = await couponBefore(client, code);
  const { data, error } = await client.from('coupons').delete().eq('code', code).select('code');
  if (!error) {
    if (!data?.length) throw new AdminError('A kupon nem található.', 404);
    await auditLog.recordChange(client, auditLog.couponKey(code), before || { code }, null, actor);
    return { deleted: true, archived: false, code };
  }
  if (error.code !== '23503') throw dbError(error, 'A kupon törlése sikertelen');
  const archive = { is_active: false, valid_until: new Date(now - 24 * 60 * 60 * 1000).toISOString(), note: '[Archiválva/Törölve]' };
  const { data: updated, error: archiveError } = await client.from('coupons').update(archive).eq('code', code).select(COUPON_COLUMNS);
  if (archiveError) throw dbError(archiveError, 'A kupon archiválása sikertelen');
  if (!updated?.length) throw new AdminError('A kupon nem található.', 404);
  await auditLog.recordChange(client, auditLog.couponKey(code), before, auditLog.couponSnapshot(updated[0]), actor);
  return { deleted: false, archived: true, code, coupon: couponView(updated[0]) };
}

// ---------- Rendszernapló és ügyfélszolgálat ----------

// ---------- Közös lapozás- és szűrő-segédek ----------

const PAGE_SIZES = [20, 50, 100];
const FILTER_MAX = 100;

function parsePaging(query = {}) {
  const page = Number.parseInt(query.page, 10);
  const pageSize = Number.parseInt(query.pageSize, 10);
  if (query.pageSize !== undefined && query.pageSize !== '' && !PAGE_SIZES.includes(pageSize)) throw validationError(`Az oldalméret ${PAGE_SIZES.join(', ')} lehet.`);
  return { page: Number.isInteger(page) && page > 0 ? page : 1, pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : PAGE_SIZES[0] };
}

function pageMeta(total, { page, pageSize }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { total, page: Math.min(page, totalPages), pageSize, totalPages };
}

function parseDay(value, endOfDay, label) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) throw validationError(`A(z) ${label} dátuma ÉÉÉÉ-HH-NN formátumú legyen.`);
  return `${text}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`;
}

function parseDateRange(query = {}) {
  const from = parseDay(query.dateFrom, false, 'kezdő');
  const to = parseDay(query.dateTo, true, 'záró');
  if (from && to && from > to) throw validationError('A kezdő dátum nem lehet későbbi a záró dátumnál.');
  return { from, to };
}

function filterText(value) {
  return String(value ?? '').trim().slice(0, FILTER_MAX);
}

// Az idő oszlop keresése: ÉÉÉÉ, ÉÉÉÉ-HH vagy ÉÉÉÉ-HH-NN előtag, amely időtartománnyá alakul.
function timePrefixRange(value) {
  const text = filterText(value);
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (!match) throw validationError('Az időpont szűrő ÉÉÉÉ, ÉÉÉÉ-HH vagy ÉÉÉÉ-HH-NN formátumú legyen.');
  const [, year, month, day] = match;
  const start = new Date(Date.UTC(Number(year), month ? Number(month) - 1 : 0, day ? Number(day) : 1));
  if (Number.isNaN(start.getTime())) throw validationError('Az időpont szűrő érvénytelen.');
  const end = new Date(start);
  if (day) end.setUTCDate(end.getUTCDate() + 1); else if (month) end.setUTCMonth(end.getUTCMonth() + 1); else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

const contains = (haystack, needle) => String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());

// ---------- Rendszernapló ----------

const LOG_LEVELS = { info: 'info', warn: 'warning', warning: 'warning', error: 'error' };
const LOG_CATEGORIES = {
  payment: ['barion_payment', 'stripe_payment', 'payment', 'coupon'],
  invoice: ['invoice', 'email_delivery'],
  ai: ['ai_generation', 'generation_failed', 'ai'],
  auth: ['auth', 'profile', 'guest_claim'],
  settings: ['settings', 'admin_settings', 'admin_support'],
  system: ['system', 'planStore', 'newsletter']
};

async function listLogs(client, query = {}) {
  const paging = parsePaging(query);
  const level = filterText(query.level);
  const category = filterText(query.category);
  if (level && !LOG_LEVELS[level]) throw validationError('Ismeretlen naplószint.');
  if (category && !LOG_CATEGORIES[category]) throw validationError('Ismeretlen naplókategória.');
  const range = parseDateRange(query);
  const time = filterText(query.time) ? timePrefixRange(query.time) : null;
  const from = [range.from, time?.from].filter(Boolean).sort().pop() || null;
  const to = [range.to, time?.to].filter(Boolean).sort()[0] || null;

  let request = client.from('system_logs').select('id, level, context, message, user_email, created_at', { count: 'exact' });
  if (level) request = request.eq('level', LOG_LEVELS[level]);
  if (category) request = request.in('context', LOG_CATEGORIES[category]);
  if (from) request = request.gte('created_at', from);
  if (to) request = request.lte('created_at', to);
  for (const [param, column] of [['context', 'context'], ['message', 'message'], ['email', 'user_email']]) {
    const text = filterText(query[param]);
    if (text) request = request.ilike(column, `%${escapeLike(text)}%`);
  }
  const offset = (paging.page - 1) * paging.pageSize;
  const { data, error, count } = await request.order('created_at', { ascending: false }).range(offset, offset + paging.pageSize - 1);
  if (error) throw dbError(error, 'A rendszernapló lekérdezése sikertelen');
  const logs = (data || []).map((row) => ({ id: row.id, level: row.level, context: row.context, message: row.message, email: row.user_email, createdAt: row.created_at }));
  return { logs, ...pageMeta(Number.isInteger(count) ? count : logs.length, paging) };
}

// ---------- Beállítások változásai (audit napló) ----------

const SETTING_LABELS = {
  pricing: 'Árak',
  daily_generation_cap: 'Napi generálási keret',
  announcement_bar: 'Bejelentősáv',
  external_links: 'Külső eszközök linkjei',
  tracking_config: 'Analitika és pixelek',
  ai_config: 'AI beállítások (modell és prompt)',
  maintenance_mode: 'Karbantartási mód',
  notification_email: 'Rendszerértesítési e-mail',
  billing_notification_email: 'Számlázási értesítési e-mail',
  error_notification_email: 'Hibaértesítési e-mail',
  billing_profile: 'Számlázási profil',
  payment_provider: 'Fizetési szolgáltató',
  seasonal_hints: 'Szezonális ötletek',
  invoice_e_invoice: 'E-számla kapcsoló',
  planner_config: 'Tervező űrlap (szövegek és opciók)'
};
const TEMPLATE_KEY_PREFIX = 'email_template:';
const SECRET_NAME = /key|secret|token|password|authorization/i;

function settingLabel(key) {
  const text = String(key || '');
  if (text.startsWith(TEMPLATE_KEY_PREFIX)) return `E-mail sablon: ${text.slice(TEMPLATE_KEY_PREFIX.length)}`;
  return SETTING_LABELS[text] || text;
}

// Titkos nevű beállítások és objektum-tulajdonságok értéke maszkolva kerül a felületre.
function maskValue(value, key = '') {
  if (value === null || value === undefined) return value ?? null;
  if (SECRET_NAME.test(key)) return value === '' ? '' : '••••••••';
  if (Array.isArray(value)) return value.map((item) => maskValue(item));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskValue(item, name)]));
  return value;
}

async function listAudit(client, query = {}) {
  const paging = parsePaging(query);
  const range = parseDateRange(query);
  const type = filterText(query.type);
  if (type && !['setting', 'template', 'theme', 'coupon'].includes(type)) throw validationError('Ismeretlen beállítás-típus.');
  let request = client.from('system_settings_history').select('id, setting_key, old_value, new_value, changed_at, changed_by', { count: 'exact' });
  if (type === 'template') request = request.ilike('setting_key', `${TEMPLATE_KEY_PREFIX}%`);
  if (type === 'theme') request = request.ilike('setting_key', `${auditLog.THEME_KEY_PREFIX}%`);
  if (type === 'coupon') request = request.ilike('setting_key', `${auditLog.COUPON_KEY_PREFIX}%`);
  if (type === 'setting') request = request.in('setting_key', Object.keys(settingsService.DEFAULT_SETTINGS));
  if (range.from) request = request.gte('changed_at', range.from);
  if (range.to) request = request.lte('changed_at', range.to);
  const who = filterText(query.changedBy);
  if (who) request = request.ilike('changed_by', `%${escapeLike(who)}%`);
  const setting = filterText(query.setting);
  if (setting) {
    const known = Object.keys(SETTING_LABELS).filter((key) => contains(key, setting) || contains(SETTING_LABELS[key], setting));
    request = known.length && !contains('e-mail sablon', setting) ? request.in('setting_key', known) : request.ilike('setting_key', `%${escapeLike(setting)}%`);
  }
  const offset = (paging.page - 1) * paging.pageSize;
  const { data, error, count } = await request.order('changed_at', { ascending: false }).range(offset, offset + paging.pageSize - 1);
  if (error) throw dbError(error, 'A beállítások naplója nem olvasható');
  const entries = (data || []).map((row) => ({
    id: row.id,
    key: row.setting_key,
    label: auditLog.isThemeKey(row.setting_key) ? `Téma-ajánló: ${(row.new_value || row.old_value || {}).title || row.setting_key.slice(auditLog.THEME_KEY_PREFIX.length)}` : auditLog.isCouponKey(row.setting_key) ? `Kupon: ${row.setting_key.slice(auditLog.COUPON_KEY_PREFIX.length)}` : settingLabel(row.setting_key),
    kind: String(row.setting_key).startsWith(TEMPLATE_KEY_PREFIX) ? 'template' : auditLog.isThemeKey(row.setting_key) ? 'theme' : auditLog.isCouponKey(row.setting_key) ? 'coupon' : 'setting',
    summary: auditLog.describeChange(row.setting_key, row.old_value, row.new_value),
    restorable: auditLog.isRestorableKey(row.setting_key),
    changedAt: row.changed_at,
    changedBy: row.changed_by || '',
    oldValue: maskValue(row.old_value),
    newValue: maskValue(row.new_value)
  }));
  return { entries, ...pageMeta(Number.isInteger(count) ? count : entries.length, paging) };
}

// Egykattintásos visszaállítás: a naplózott „régi érték” visszaíródik (a visszaállítás is új naplóbejegyzés lesz).
async function restoreAudit(client, id, actor = '') {
  const { data: row, error } = await client.from('system_settings_history').select('id, setting_key, old_value, new_value').eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'A naplóbejegyzés nem olvasható');
  if (!row) throw new AdminError('A naplóbejegyzés nem található.', 404);
  if (!auditLog.isRestorableKey(row.setting_key)) throw new AdminError('Ez a módosítás nem állítható vissza innen.', 400);
  if (row.setting_key === 'planner_config') {
    const settings = await settingsService.updateSettings(client, { planner_config: row.old_value || {} }, actor, { replace: true });
    return { key: row.setting_key, restored: true, planner_config: settings.planner_config };
  }
  if (!auditLog.isThemeKey(row.setting_key)) {
    if (row.old_value === null || row.old_value === undefined) throw new AdminError('Ehhez a bejegyzéshez nincs korábbi érték, ezért nem állítható vissza.', 409);
    let previous = row.old_value;
    // A régi (heti csomagár-mezős) árazás naplóbejegyzése csak az ismert árkulcsokra szűkül; a hiányzó új kulcsok a jelenlegi értéken maradnak.
    if (row.setting_key === 'pricing' && previous && typeof previous === 'object') previous = Object.fromEntries(Object.entries(previous).filter(([tier]) => settingsService.PRICE_TIERS.includes(tier)));
    try {
      const settings = await settingsService.updateSettings(client, { [row.setting_key]: previous }, actor);
      return { key: row.setting_key, restored: true, value: maskValue(settings[row.setting_key], row.setting_key) };
    } catch (error) {
      if (error instanceof settingsService.SettingsError) throw new AdminError(`A régi érték már nem érvényes, nem állítható vissza: ${error.message}`, 409);
      throw error;
    }
  }
  const themeId = row.setting_key.slice(auditLog.THEME_KEY_PREFIX.length);
  const themes = require('./themeSuggestionsService');
  const result = await themes.restoreSuggestion(client, themeId, row.old_value, actor);
  return { key: row.setting_key, restored: true, ...result };
}

const SUPPORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function supportCode() {
  const bytes = crypto.randomBytes(6);
  return `SORRY-${Array.from(bytes, (byte) => SUPPORT_CODE_ALPHABET[byte % SUPPORT_CODE_ALPHABET.length]).join('')}`;
}

// Kárpótlási kupon: egyszer használatos, 100%-os; a címzett e-mail címe a megjegyzésben marad, hogy az admin a kuponlistában is lássa, kié.
async function createSupportCoupon(client, body = {}, now = Date.now()) {
  const email = normalizeEmail(body.email);
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw validationError('Érvényes felhasználói e-mail cím szükséges.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const coupon = await createCoupon(client, { code: supportCode(), discount_percent: 100, max_uses: 1, note: `Kárpótlás: ${email}` }, now);
      return { ...coupon, email };
    } catch (error) {
      if (!(error instanceof AdminError) || error.status !== 409) throw error;
    }
  }
  throw new AdminError('A kuponkód generálása nem sikerült, kérjük, próbáld újra.', 500);
}

// ---------- Rendelések ----------

const ORDER_COLUMNS = 'order_number, user_id, user_email, document_id, plan_mode, plan_key, amount, coupon_code, payment_method, status, invoice_number, billing, created_at';
const ORDER_ERROR_COLUMNS = `${ORDER_COLUMNS}, last_error, last_error_at`;

async function fetchProfiles(client, ids, columns) {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows = [];
  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await client.from('profiles').select(columns).in('id', unique.slice(index, index + 200));
    if (error) throw dbError(error, 'A profilok lekérdezése sikertelen');
    rows.push(...(data || []));
  }
  return rows;
}

const PAYMENT_METHODS = ['Barion', 'Stripe', 'Kupon'];
const INVOICE_FILTERS = ['has', 'missing', 'error'];
const FAILED_PREVIEW = 20;

// A regisztrált vevő neve a profiljából (számlázási név, ennek hiányában teljes név), a vendégé a rendelés számlázási adataiból (billing.name) származik.
// A státusz / fizetési mód / időszak az adatbázisban szűr, az oszlopkeresések a (legfeljebb MAX_ORDER_ROWS soros) találati halmazon, a lapozás szerveroldali.
async function listOrders(client, query = {}) {
  const wantedStatus = filterText(query.status);
  if (wantedStatus && !ORDER_STATUSES.includes(wantedStatus)) throw validationError('Ismeretlen rendelési státusz.');
  const method = filterText(query.paymentMethod);
  if (method && !PAYMENT_METHODS.includes(method)) throw validationError('Ismeretlen fizetési mód.');
  const invoice = filterText(query.invoice);
  if (invoice && !INVOICE_FILTERS.includes(invoice)) throw validationError('Ismeretlen számlaállapot-szűrő.');
  const paging = parsePaging(query);
  const range = parseDateRange(query);
  const load = (columns) => fetchAll(() => {
    let request = client.from('orders').select(columns);
    if (wantedStatus) request = request.eq('status', wantedStatus);
    if (method) request = request.eq('payment_method', method);
    if (range.from) request = request.gte('created_at', range.from);
    if (range.to) request = request.lte('created_at', range.to);
    return request.order('created_at', { ascending: false });
  }, 'A rendelések lekérdezése sikertelen', MAX_ORDER_ROWS);
  // A title (téma) és a hibamezők (last_error) a migráció előtt még hiányozhatnak: ilyenkor azok nélkül, de működik a lista.
  const rows = await load(`${ORDER_ERROR_COLUMNS}, title`).catch(() => load(ORDER_ERROR_COLUMNS)).catch(() => load(ORDER_COLUMNS));

  const profiles = await fetchProfiles(client, rows.map((row) => row.user_id), 'id, full_name, billing_name');
  const names = new Map(profiles.map((profile) => [String(profile.id), profile.billing_name || profile.full_name || '']));
  const all = rows.map((row) => ({
    orderNumber: row.order_number,
    createdAt: row.created_at,
    email: row.user_email || '',
    name: names.get(String(row.user_id)) || String(row.billing?.name || ''),
    topic: row.title || '',
    planKey: row.plan_key || '',
    planMode: row.plan_mode || '',
    amount: Number(row.amount) || 0,
    couponCode: row.coupon_code || '',
    paymentMethod: row.payment_method || '',
    status: row.status,
    invoiceNumber: row.invoice_number || '',
    lastError: row.last_error || '',
    lastErrorAt: row.last_error_at || null,
    documentId: row.document_id || ''
  }));

  const needle = filterText(query.q);
  const columns = {
    orderNumber: filterText(query.orderNumber),
    customer: filterText(query.customer),
    topic: filterText(query.topic),
    amount: filterText(query.amount).replace(/\D/g, ''),
    coupon: filterText(query.coupon),
    invoiceNumber: filterText(query.invoiceNumber)
  };
  const failedOf = (order) => order.status === 'paid' && Boolean(order.lastError);
  const filtered = all.filter((order) => {
    if (needle && ![order.orderNumber, order.email, order.name, order.couponCode, order.invoiceNumber, order.documentId, order.topic].some((value) => contains(value, needle))) return false;
    if (columns.orderNumber && !contains(order.orderNumber, columns.orderNumber)) return false;
    if (columns.customer && !contains(order.name, columns.customer) && !contains(order.email, columns.customer)) return false;
    if (columns.topic && !contains(order.topic, columns.topic)) return false;
    if (columns.amount && !String(order.amount).includes(columns.amount)) return false;
    if (columns.coupon && !contains(order.couponCode, columns.coupon)) return false;
    if (columns.invoiceNumber && !contains(order.invoiceNumber, columns.invoiceNumber)) return false;
    if (invoice === 'has') return Boolean(order.invoiceNumber);
    if (invoice === 'error') return failedOf(order);
    if (invoice === 'missing') return failedOf(order) || (order.status === 'paid' && order.amount > 0 && !order.invoiceNumber);
    return true;
  });
  const meta = pageMeta(filtered.length, paging);
  const start = (meta.page - 1) * meta.pageSize;
  return {
    orders: filtered.slice(start, start + meta.pageSize),
    ...meta,
    truncated: rows.length >= MAX_ORDER_ROWS,
    failedCount: all.filter(failedOf).length,
    failed: all.filter(failedOf).slice(0, FAILED_PREVIEW).map((order) => ({ orderNumber: order.orderNumber, lastError: order.lastError }))
  };
}

// ---------- Felhasználók ----------

const USER_ROLES = ['admin', 'user'];

async function listUsers(client, query = {}) {
  const role = filterText(query.role);
  const newsletter = filterText(query.newsletter);
  const hasOrders = filterText(query.hasOrders);
  const account = filterText(query.account);
  if (account && !['registered', 'guest'].includes(account)) throw validationError('Ismeretlen fiókállapot-szűrő.');
  if (role && !USER_ROLES.includes(role)) throw validationError('Ismeretlen szerepkör.');
  if (newsletter && !['subscribed', 'not'].includes(newsletter)) throw validationError('Ismeretlen hírlevél-szűrő.');
  if (hasOrders && !['yes', 'no'].includes(hasOrders)) throw validationError('Ismeretlen rendelés-szűrő.');
  const paging = parsePaging(query);
  const range = parseDateRange(query);

  const [authUsers, profiles, subscriptions, orderRows] = await Promise.all([
    listAuthUsers(client),
    fetchAll(() => client.from('profiles').select('id, email, full_name, billing_name, billing_tax_id, kindergarten_name, group_name, is_admin').order('id', { ascending: true }), 'A profilok lekérdezése sikertelen'),
    fetchAll(() => client.from('newsletter_subscribers').select('email, name, subscribed, subscribed_at, unsubscribed_at').order('email', { ascending: true }), 'A feliratkozók lekérdezése sikertelen'),
    hasOrders ? fetchAll(() => client.from('orders').select('user_id, user_email').eq('status', 'paid').order('order_number', { ascending: true }), 'A rendelések lekérdezése sikertelen') : []
  ]);
  const byId = new Map(profiles.map((profile) => [String(profile.id), profile]));
  const byEmail = new Map(subscriptions.map((row) => [normalizeEmail(row.email), row]));
  const buyerIds = new Set(orderRows.map((row) => String(row.user_id || '')));
  const buyerEmails = new Set(orderRows.map((row) => normalizeEmail(row.user_email)));
  const users = authUsers.map((user) => {
    const profile = byId.get(String(user.id)) || {};
    const email = normalizeEmail(user.email || profile.email);
    const subscription = byEmail.get(email);
    return {
      id: String(user.id),
      email,
      name: profile.full_name || profile.billing_name || '',
      kindergarten: profile.kindergarten_name || '',
      group: profile.group_name || '',
      billingName: profile.billing_name || '',
      taxId: profile.billing_tax_id || '',
      role: profile.is_admin === true ? 'admin' : 'user',
      hasOrders: hasOrders ? buyerIds.has(String(user.id)) || buyerEmails.has(email) : undefined,
      createdAt: user.created_at || null,
      confirmed: isConfirmed(user),
      accountType: 'registered',
      subscribed: subscription?.subscribed === true,
      subscribedAt: subscription?.subscribed_at || null,
      unsubscribedAt: subscription?.unsubscribed_at || null
    };
  });
  // Regisztráció nélküli (vendég) feliratkozók: van hírlevél-soruk, de nincs fiókjuk. A leiratkozott vendég rekordja is megmarad.
  const registeredEmails = new Set(users.map((user) => user.email));
  for (const row of subscriptions) {
    const email = normalizeEmail(row.email);
    if (!email || registeredEmails.has(email)) continue;
    users.push({
      id: '',
      email,
      name: row.name || '',
      kindergarten: '',
      group: '',
      billingName: '',
      taxId: '',
      role: 'user',
      hasOrders: hasOrders ? buyerEmails.has(email) : undefined,
      createdAt: row.subscribed_at || null,
      confirmed: false,
      accountType: 'guest',
      subscribed: row.subscribed === true,
      subscribedAt: row.subscribed_at || null,
      unsubscribedAt: row.unsubscribed_at || null
    });
  }
  users.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const text = { name: filterText(query.name), email: filterText(query.email), kindergarten: filterText(query.kindergarten), group: filterText(query.group), billing: filterText(query.billing) };
  const filtered = users.filter((user) => {
    if (account && user.accountType !== account) return false;
    if (role && user.role !== role) return false;
    if (newsletter && user.subscribed !== (newsletter === 'subscribed')) return false;
    if (hasOrders && user.hasOrders !== (hasOrders === 'yes')) return false;
    const created = user.createdAt ? new Date(user.createdAt).toISOString() : '';
    if (range.from && (!created || created < range.from)) return false;
    if (range.to && (!created || created > range.to)) return false;
    return (!text.name || contains(user.name, text.name)) && (!text.email || contains(user.email, text.email))
      && (!text.kindergarten || contains(user.kindergarten, text.kindergarten)) && (!text.group || contains(user.group, text.group))
      && (!text.billing || contains(user.billingName, text.billing) || contains(user.taxId, text.billing));
  });
  const meta = pageMeta(filtered.length, paging);
  const start = (meta.page - 1) * meta.pageSize;
  return {
    users: filtered.slice(start, start + meta.pageSize).map(({ hasOrders: _unused, ...user }) => user),
    ...meta,
    subscriberCount: users.filter((user) => user.subscribed && (user.confirmed || user.accountType === 'guest')).length
  };
}

// ---------- Ügyfélértékelések ----------

const REVIEW_STATUSES = ['pending', 'approved', 'rejected'];
const REVIEW_COLUMNS = 'id, order_number, customer_name, customer_email, plan_topic, role_label, rating, comment, status, admin_reply_sent_at, admin_note, created_at';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reviewView(row) {
  return {
    id: row.id,
    orderNumber: row.order_number || '',
    name: row.customer_name || '',
    email: row.customer_email || '',
    topic: row.plan_topic || '',
    roleLabel: row.role_label || '',
    rating: row.rating,
    comment: row.comment || '',
    status: row.status,
    replySentAt: row.admin_reply_sent_at || null,
    adminNote: row.admin_note || '',
    createdAt: row.created_at
  };
}

async function listReviews(client, query = {}) {
  const paging = parsePaging(query);
  const status = filterText(query.status);
  if (status && !REVIEW_STATUSES.includes(status)) throw validationError('Ismeretlen értékelés-státusz.');
  let request = client.from('reviews').select(REVIEW_COLUMNS, { count: 'exact' });
  if (status) request = request.eq('status', status);
  const offset = (paging.page - 1) * paging.pageSize;
  const { data, error, count } = await request.order('created_at', { ascending: false }).range(offset, offset + paging.pageSize - 1);
  if (error) throw dbError(error, 'Az értékelések nem olvashatók');
  const reviews = (data || []).map(reviewView);
  return { reviews, ...pageMeta(Number.isInteger(count) ? count : reviews.length, paging) };
}

async function reviewSummary(client) {
  const { count, error } = await client.from('reviews').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (error) throw dbError(error, 'Az értékelések száma nem olvasható');
  return { pending: Number.isInteger(count) ? count : 0 };
}

async function getReview(client, id) {
  if (!UUID_PATTERN.test(String(id || ''))) throw validationError('Érvénytelen értékelés-azonosító.');
  const { data, error } = await client.from('reviews').select(REVIEW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'Az értékelés nem olvasható');
  if (!data) throw new AdminError('Az értékelés nem található.', 404);
  return data;
}

async function setReviewStatus(client, id, body = {}) {
  const status = String(body.status || '').trim();
  if (!REVIEW_STATUSES.includes(status)) throw validationError('Az értékelés státusza pending, approved vagy rejected lehet.');
  await getReview(client, id);
  const patch = { status };
  if (body.adminNote !== undefined) patch.admin_note = String(body.adminNote ?? '').trim().slice(0, 1000) || null;
  const { data, error } = await client.from('reviews').update(patch).eq('id', id).select(REVIEW_COLUMNS).maybeSingle();
  if (error) throw dbError(error, 'Az értékelés módosítása sikertelen');
  return { review: reviewView(data || { id, ...patch }) };
}

async function deleteReview(client, id) {
  await getReview(client, id);
  const { error } = await client.from('reviews').delete().eq('id', id);
  if (error) throw dbError(error, 'Az értékelés törlése sikertelen');
  return { deleted: id };
}

// Hírlevél-állapot kapcsolása adminból: a rekord megmarad, csak a subscribed/unsubscribed_at változik.
async function setNewsletterSubscription(client, body = {}) {
  const email = normalizeEmail(body.email);
  if (!email || typeof body.subscribed !== 'boolean') throw validationError('Adj meg e-mail címet és a kívánt hírlevél-állapotot.');
  const now = new Date().toISOString();
  const patch = body.subscribed ? { subscribed: true, subscribed_at: now, unsubscribed_at: null } : { subscribed: false, unsubscribed_at: now };
  const found = await client.from('newsletter_subscribers').select('email').eq('email', email).maybeSingle();
  if (found.error) throw new AdminError(`A feliratkozó lekérdezése sikertelen: ${found.error.message}`, 500);
  const write = found.data
    ? await client.from('newsletter_subscribers').update(patch).eq('email', email)
    : body.subscribed ? await client.from('newsletter_subscribers').insert({ email, ...patch }) : { error: null };
  if (write.error) throw new AdminError(`A hírlevél-állapot mentése sikertelen: ${write.error.message}`, 500);
  return { email, subscribed: body.subscribed };
}

module.exports = {
  AdminError,
  setNewsletterSubscription,
  REVIEW_STATUSES,
  listReviews,
  reviewSummary,
  getReview,
  setReviewStatus,
  deleteReview,
  ORDER_STATUSES,
  fetchAll,
  fetchProfiles,
  listAuthUsers,
  isConfirmed,
  getStats,
  listCoupons,
  createCoupon,
  setCouponActive,
  updateCoupon,
  deleteCoupon,
  parseCouponInput,
  listLogs,
  listAudit,
  restoreAudit,
  maskValue,
  settingLabel,
  createSupportCoupon,
  supportCode,
  listOrders,
  listUsers
};
