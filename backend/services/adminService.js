'use strict';

// Az Admin Központ adatrétege (csak a service-role Supabase klienssel hívható, az útvonalakat a requireAdmin védi).
// A hibák AdminError-ként érkeznek: a 4xx üzenete a kliensnek szól, az 5xx részleteit az útvonal naplózza, de nem adja ki.
const crypto = require('node:crypto');
const { CODE_PATTERN, normalizeCode } = require('./coupons');

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
    fetchAll(() => client.from('profiles').select('id').eq('newsletter_subscribed', true).order('id', { ascending: true }), 'A feliratkozók lekérdezése sikertelen')
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
    confirmedSubscribers: subscribed.filter((row) => confirmedIds.has(String(row.id))).length,
    documents: {
      total: documents.length,
      unlocked,
      breakdown,
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

async function createCoupon(client, body, now = Date.now()) {
  const input = parseCouponInput(body, now);
  const { data: existing, error: lookupError } = await client.from('coupons').select('code').eq('code', input.code).maybeSingle();
  if (lookupError) throw dbError(lookupError, 'A kupon ellenőrzése sikertelen');
  if (existing) throw new AdminError('Ilyen kuponkód már létezik.', 409);
  const { data, error } = await client.from('coupons').insert({ ...input, is_active: true }).select(COUPON_COLUMNS).single();
  if (error) {
    if (error.code === '23505') throw new AdminError('Ilyen kuponkód már létezik.', 409);
    throw dbError(error, 'A kupon mentése sikertelen');
  }
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

async function updateCoupon(client, rawCode, body, now = Date.now()) {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw new AdminError('A kupon nem található.', 404);
  const patch = parseCouponPatch(body, now);
  const { data, error } = await client.from('coupons').update(patch).eq('code', code).select(COUPON_COLUMNS);
  if (error) throw dbError(error, 'A kupon módosítása sikertelen');
  if (!data?.length) throw new AdminError('A kupon nem található.', 404);
  return couponView(data[0]);
}

const setCouponActive = (client, rawCode, isActive) => updateCoupon(client, rawCode, { is_active: isActive });

// Idegenkulcs-hivatkozás (rendelés, beváltás) esetén nem törlünk, hanem archiválunk: a kupon inaktív, tegnap lejárt, a megjegyzésben jelölve.
async function deleteCoupon(client, rawCode, now = Date.now()) {
  const code = normalizeCode(rawCode);
  if (!CODE_PATTERN.test(code)) throw new AdminError('A kupon nem található.', 404);
  const { data, error } = await client.from('coupons').delete().eq('code', code).select('code');
  if (!error) {
    if (!data?.length) throw new AdminError('A kupon nem található.', 404);
    return { deleted: true, archived: false, code };
  }
  if (error.code !== '23503') throw dbError(error, 'A kupon törlése sikertelen');
  const archive = { is_active: false, valid_until: new Date(now - 24 * 60 * 60 * 1000).toISOString(), note: '[Archiválva/Törölve]' };
  const { data: updated, error: archiveError } = await client.from('coupons').update(archive).eq('code', code).select(COUPON_COLUMNS);
  if (archiveError) throw dbError(archiveError, 'A kupon archiválása sikertelen');
  if (!updated?.length) throw new AdminError('A kupon nem található.', 404);
  return { deleted: false, archived: true, code, coupon: couponView(updated[0]) };
}

// ---------- Rendszernapló és ügyfélszolgálat ----------

const LOG_LIMIT = 100;

async function listLogs(client) {
  const { data, error } = await client.from('system_logs').select('id, level, context, message, user_email, created_at').order('created_at', { ascending: false }).limit(LOG_LIMIT);
  if (error) throw dbError(error, 'A rendszernapló lekérdezése sikertelen');
  return { logs: (data || []).map((row) => ({ id: row.id, level: row.level, context: row.context, message: row.message, email: row.user_email, createdAt: row.created_at })) };
}

const SUPPORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function supportCode() {
  const bytes = crypto.randomBytes(6);
  return `SORRY-${Array.from(bytes, (byte) => SUPPORT_CODE_ALPHABET[byte % SUPPORT_CODE_ALPHABET.length]).join('')}`;
}

// Kárpótlási kupon: egyszer használatos, 100%-os; a címzett e-mail címe a megjegyzésben marad, hogy az admin a kuponlistában is lássa, kié.
async function createSupportCoupon(client, body = {}, now = Date.now()) {
  const email = String(body.email || '').trim().toLowerCase();
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

// A regisztrált vevő neve a profiljából (számlázási név, ennek hiányában teljes név), a vendégé a rendelés számlázási adataiból (billing.name) származik.
async function listOrders(client, { status, q } = {}) {
  const wantedStatus = String(status || '').trim();
  if (wantedStatus && !ORDER_STATUSES.includes(wantedStatus)) throw validationError('Ismeretlen rendelési státusz.');
  const load = (columns) => fetchAll(() => {
    let query = client.from('orders').select(columns);
    if (wantedStatus) query = query.eq('status', wantedStatus);
    return query.order('created_at', { ascending: false });
  }, 'A rendelések lekérdezése sikertelen', MAX_ORDER_ROWS);
  // A hibamezők (last_error) a migráció előtt még hiányozhatnak: ilyenkor hibamegjelenítés nélkül, de működik a lista.
  const rows = await load(ORDER_ERROR_COLUMNS).catch(() => load(ORDER_COLUMNS));

  const profiles = await fetchProfiles(client, rows.map((row) => row.user_id), 'id, full_name, billing_name');
  const names = new Map(profiles.map((profile) => [String(profile.id), profile.billing_name || profile.full_name || '']));
  const orders = rows.map((row) => ({
    orderNumber: row.order_number,
    createdAt: row.created_at,
    email: row.user_email || '',
    name: names.get(String(row.user_id)) || String(row.billing?.name || ''),
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

  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  const filtered = needle
    ? orders.filter((order) => [order.orderNumber, order.email, order.name, order.couponCode, order.invoiceNumber, order.documentId].some((value) => String(value).toLowerCase().includes(needle)))
    : orders;
  return { orders: filtered, truncated: rows.length >= MAX_ORDER_ROWS, failedCount: orders.filter((order) => order.status === 'paid' && order.lastError).length };
}

// ---------- Felhasználók ----------

async function listUsers(client) {
  const [authUsers, profiles] = await Promise.all([
    listAuthUsers(client),
    fetchAll(() => client.from('profiles').select('id, email, full_name, billing_name, newsletter_subscribed, newsletter_subscribed_at').order('id', { ascending: true }), 'A profilok lekérdezése sikertelen')
  ]);
  const byId = new Map(profiles.map((profile) => [String(profile.id), profile]));
  const users = authUsers.map((user) => {
    const profile = byId.get(String(user.id)) || {};
    return {
      id: String(user.id),
      email: String(user.email || profile.email || '').toLowerCase(),
      name: profile.full_name || profile.billing_name || '',
      createdAt: user.created_at || null,
      confirmed: isConfirmed(user),
      subscribed: profile.newsletter_subscribed === true,
      subscribedAt: profile.newsletter_subscribed_at || null
    };
  });
  users.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { users, subscriberCount: users.filter((user) => user.subscribed && user.confirmed).length };
}

module.exports = {
  AdminError,
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
  createSupportCoupon,
  supportCode,
  listOrders,
  listUsers
};
