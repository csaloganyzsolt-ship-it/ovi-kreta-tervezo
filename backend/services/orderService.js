'use strict';

// Rendeléstörténet és fizetési állapot (Supabase `orders` tábla): ez az egyetlen igazságforrás a Barion/Stripe fizetésekhez, a számlázás idempotenciájához
// (provider_payment_id, invoice_number) és a kézbesítéshez (delivery_count). Írni csak a backend tud (titkos kulccsal); a böngésző RLS-sel csak a saját sorait olvashatja.
// Supabase nélkül (teszt, helyi fejlesztés) memóriabeli tábla működik, mint a tervezeteknél; élesben (NODE_ENV=production) kliens nélkül 503-as hiba van, nincs csendes tartalék.
const supabase = require('./supabaseService');
const invoiceService = require('./invoiceService');

const STATUSES = new Set(['pending', 'paid', 'failed', 'cancelled']);
const LIST_COLUMNS = 'order_number, document_id, plan_mode, plan_key, amount, coupon_code, payment_method, status, invoice_number, created_at';
const MAX_LISTED_ORDERS = 100;

// camelCase mező → oszlopnév.
const FIELDS = Object.freeze({
  orderNumber: 'order_number', sessionId: 'session_id', userId: 'user_id', email: 'user_email', documentId: 'document_id',
  planMode: 'plan_mode', planKey: 'plan_key', amount: 'amount', listPrice: 'list_price', couponCode: 'coupon_code', couponPercent: 'coupon_percent',
  paymentMethod: 'payment_method', status: 'status', invoiceNumber: 'invoice_number', invoiceStatus: 'invoice_status', invoiceIssuedAt: 'invoice_issued_at',
  provider: 'provider', providerPaymentId: 'provider_payment_id', providerStatus: 'provider_status', billingProfile: 'billing_profile', billing: 'billing',
  title: 'title', paidAt: 'paid_at', deliveryCount: 'delivery_count', deliveredAt: 'delivered_at', redemptionLogged: 'redemption_logged',
  documentSynced: 'document_synced', createdAt: 'created_at'
});
const ALL_COLUMNS = [...Object.values(FIELDS), 'updated_at'].join(', ');
// Hibamezők: külön kezelve, hogy a kód a migráció (last_error, last_error_at) lefuttatása előtt is működjön.
const ERROR_COLUMNS = 'last_error, last_error_at';
const memory = new Map();
const alertedErrors = new Map();
let errorColumns = null;

const isMissingErrorColumn = (error) => /last_error/.test(String(error?.message || ''));

// A számlán és a levelekben is szereplő rendelésszám (OVI-ÉÉHHNN-XXXXXX).
function orderNumberFor(sessionId, created = new Date()) {
  return invoiceService.orderNumber(sessionId, created);
}

// Üres értékek (undefined, ''-ra egyenlő) kimaradnak; null megadásával az oszlop törölhető.
function toRow(order) {
  const row = {};
  for (const [field, column] of Object.entries(FIELDS)) {
    let value = order[field];
    if (value === undefined || value === '') continue;
    if (field === 'email' && value !== null) value = String(value).trim().toLowerCase();
    row[column] = value;
  }
  return row;
}

function fromRow(row) {
  if (!row) return null;
  const order = {};
  for (const [field, column] of Object.entries(FIELDS)) order[field] = row[column] ?? null;
  order.deliveryCount = Number(row.delivery_count) || 0;
  order.redemptionLogged = row.redemption_logged === true;
  order.documentSynced = row.document_synced === true;
  order.lastError = row.last_error || null;
  order.lastErrorAt = row.last_error_at || null;
  return order;
}

// Kliens, vagy null (memóriabeli tábla). Élesben kliens nélkül hiba.
function storage() {
  const client = supabase.getClient();
  if (client) return client;
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error('A rendelések tárolása nincs beállítva (SUPABASE_URL / SUPABASE_SECRET_KEY).'), { status: 503 });
  }
  return null;
}

function resetMemory() {
  memory.clear();
  alertedErrors.clear();
  errorColumns = null;
}

function memoryInsert(row) {
  const existing = memory.get(row.order_number);
  const merged = existing
    ? { ...existing, ...row }
    : { delivery_count: 0, redemption_logged: false, document_synced: false, created_at: new Date().toISOString(), ...row };
  memory.set(row.order_number, merged);
  return merged;
}

async function upsertOrder(order) {
  if (!order?.orderNumber || !Number.isInteger(order.amount) || order.amount < 0 || !STATUSES.has(order.status)) {
    throw new Error('A rendelés adatai hiányosak vagy érvénytelenek.');
  }
  const client = storage();
  const row = { ...toRow(order), updated_at: new Date().toISOString() };
  if (!client) {
    memoryInsert(row);
    return true;
  }
  const { error } = await client.from('orders').upsert(row, { onConflict: 'order_number' });
  if (error) throw new Error(`A rendelés Supabase-be mentése sikertelen (${order.orderNumber}): ${error.message}`);
  return true;
}

// Egy meglévő rendelés részleges frissítése (pl. számlaszám, szolgáltatói állapot); nemlétező rendelésnél hiba.
async function patchOrder(orderNumber, fields) {
  const client = storage();
  const row = { ...toRow(fields), updated_at: new Date().toISOString() };
  delete row.order_number;
  if (!client) {
    if (!memory.has(orderNumber)) throw new Error(`A rendelés nem található (${orderNumber}).`);
    memoryInsert({ order_number: orderNumber, ...row });
    return true;
  }
  const { data, error } = await client.from('orders').update(row).eq('order_number', orderNumber).select('order_number');
  if (error) throw new Error(`A rendelés frissítése sikertelen (${orderNumber}): ${error.message}`);
  if (!data?.length) throw new Error(`A rendelés nem található (${orderNumber}).`);
  return true;
}

async function findOrder(column, value) {
  const needle = String(value ?? '').trim();
  if (!needle) return null;
  const client = storage();
  if (!client) return fromRow([...memory.values()].find((row) => row[column] === needle));
  const read = (columns) => client.from('orders').select(columns).eq(column, needle).maybeSingle();
  let { data, error } = await read(errorColumns === false ? ALL_COLUMNS : `${ALL_COLUMNS}, ${ERROR_COLUMNS}`);
  if (error && errorColumns !== false && isMissingErrorColumn(error)) {
    errorColumns = false;
    ({ data, error } = await read(ALL_COLUMNS));
  } else if (!error) {
    errorColumns = errorColumns ?? true;
  }
  if (error) throw new Error(`A rendelés lekérdezése sikertelen: ${error.message}`);
  return fromRow(data);
}

// Fizetett rendelés számlázási/kézbesítési hibájának rögzítése (a rendelés fizetett marad). Soha nem dob: ha az oszlop még nincs meg, csak naplózza.
// Visszatérés: true, ha erről a hibáról még nem ment riasztás (ugyanarra a rendelésre és hibaüzenetre webhook-ismétlődéskor nem küldünk újabb levelet).
async function recordError(orderNumber, kind, message) {
  const text = `${kind}: ${String(message || 'ismeretlen hiba').slice(0, 500)}`;
  const firstTime = alertedErrors.get(orderNumber) !== text;
  alertedErrors.set(orderNumber, text);
  try {
    const existing = await getByOrderNumber(orderNumber).catch(() => null);
    if (existing?.lastError === text) return false;
    await patchError(orderNumber, { last_error: text, last_error_at: new Date().toISOString() });
  } catch (error) {
    console.error(`[orders] A hiba nem menthető (${orderNumber}):`, error.message);
  }
  return firstTime;
}

// Sikeres újrapróbálkozás után a hibamező törlése; a prefix csak az adott fajta hibát törli (Számlázás / Kézbesítés).
async function clearError(orderNumber, kind) {
  alertedErrors.delete(orderNumber);
  try {
    const existing = await getByOrderNumber(orderNumber);
    if (!existing?.lastError || (kind && !existing.lastError.startsWith(`${kind}:`))) return;
    await patchError(orderNumber, { last_error: null, last_error_at: null });
  } catch (error) {
    console.error(`[orders] A hibamező nem törölhető (${orderNumber}):`, error.message);
  }
}

async function patchError(orderNumber, fields) {
  const client = storage();
  if (!client) {
    if (memory.has(orderNumber)) memoryInsert({ order_number: orderNumber, ...fields });
    return;
  }
  const { error } = await client.from('orders').update({ ...fields, updated_at: new Date().toISOString() }).eq('order_number', orderNumber);
  if (error) {
    if (isMissingErrorColumn(error)) errorColumns = false;
    throw new Error(error.message);
  }
  errorColumns = true;
}

const getByOrderNumber = (orderNumber) => findOrder('order_number', orderNumber);
const getBySessionId = (sessionId) => findOrder('session_id', sessionId);
const getByProviderPaymentId = (paymentId) => findOrder('provider_payment_id', paymentId);

// Fizetés indításakor: függőben lévő rendelés.
function createPending(order) {
  return upsertOrder({ ...order, status: 'pending' });
}

// Sikeres fizetéskor (újrahívható: ugyanaz a rendelésszám ugyanazt a sort frissíti). Ismételt híváskor a korábbi fizetési időpontot a hívó adja át (paidAt).
function markPaid(order) {
  return upsertOrder({ ...order, status: 'paid', paidAt: order.paidAt || new Date().toISOString() });
}

// Sikertelen vagy megszakadt fizetés; a már kifizetett rendelést nem írja felül.
async function markClosed(orderNumber, status) {
  if (!['failed', 'cancelled'].includes(status)) throw new Error('Érvénytelen rendelésállapot.');
  const client = storage();
  if (!client) {
    const row = memory.get(orderNumber);
    if (row?.status === 'pending') memoryInsert({ order_number: orderNumber, status, updated_at: new Date().toISOString() });
    return true;
  }
  const { error } = await client.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('order_number', orderNumber).eq('status', 'pending');
  if (error) throw new Error(`A rendelés állapotának frissítése sikertelen (${orderNumber}): ${error.message}`);
  return true;
}

// Kézbesítés lefoglalása: a delivery_count-ot csak akkor növeli, ha az még a határ alatt van (optimista zárral, így két egyidejű kérés nem küld kétszer).
async function claimDelivery(orderNumber, max = 1) {
  const current = await getByOrderNumber(orderNumber);
  if (!current || current.deliveryCount >= max) return false;
  const client = storage();
  const fields = { delivery_count: current.deliveryCount + 1, delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (!client) {
    memoryInsert({ order_number: orderNumber, ...fields });
    return true;
  }
  const { data, error } = await client.from('orders').update(fields).eq('order_number', orderNumber).eq('delivery_count', current.deliveryCount).select('order_number');
  if (error) throw new Error(`A kézbesítés rögzítése sikertelen (${orderNumber}): ${error.message}`);
  return Boolean(data?.length);
}

// A levélküldés hibájakor a lefoglalt kézbesítés visszavonása, hogy újrapróbálható legyen.
async function releaseDelivery(orderNumber) {
  const current = await getByOrderNumber(orderNumber);
  if (!current || current.deliveryCount < 1) return false;
  return patchOrder(orderNumber, { deliveryCount: current.deliveryCount - 1 });
}

// Pótlólagos számlakiállítás egy kifizetett, még számla nélküli rendelésnél (admin). Duplán nem állít ki; siker esetén törli a hibamezőt, hiba esetén rögzíti.
async function issueInvoiceForOrder(order, deps = {}) {
  if (order.status !== 'paid') throw Object.assign(new Error('Csak kifizetett rendeléshez állítható ki számla.'), { status: 409 });
  if (order.invoiceNumber) throw Object.assign(new Error(`A rendeléshez már tartozik számla (${order.invoiceNumber}).`), { status: 409 });
  if (!Number.isInteger(order.amount) || order.amount <= 0) throw Object.assign(new Error('Ingyenes (kuponos) rendeléshez nem készül számla.'), { status: 409 });
  const billing = order.billing || {};
  const created = Date.parse(order.createdAt);
  try {
    const result = await (deps.issueInvoice || invoiceService.issueInvoice)({
      orderId: order.sessionId || order.orderNumber,
      created: Math.floor((Number.isFinite(created) ? created : Date.now()) / 1000),
      plan: order.planKey,
      amountHuf: order.amount,
      couponPercent: order.couponPercent || undefined,
      paymentMethod: order.paymentMethod || undefined,
      billingProfile: order.billingProfile || undefined,
      customer: { name: billing.name || '', email: order.email, zip: billing.zip || '', city: billing.city || '', address: billing.address || '' }
    }, { env: deps.env, fetch: deps.fetch });
    if (result.mock || !result.invoiceNumber) throw new Error('A Számlázz.hu Agent kulcs nincs beállítva, a számla nem állítható ki.');
    await patchOrder(order.orderNumber, { invoiceNumber: result.invoiceNumber, invoiceStatus: 'issued', invoiceIssuedAt: new Date().toISOString() });
    await clearError(order.orderNumber, 'Számlázás');
    return { invoiceNumber: result.invoiceNumber, pdf: result.pdf };
  } catch (error) {
    await recordError(order.orderNumber, 'Számlázás', error.message);
    throw error;
  }
}

function summarize(row) {
  return {
    orderNumber: row.order_number,
    documentId: row.document_id || null,
    planMode: row.plan_mode === 'academic' ? 'academic' : 'standard',
    planKey: row.plan_key || null,
    amount: row.amount,
    couponCode: row.coupon_code || null,
    paymentMethod: row.payment_method || null,
    status: row.status,
    invoiceNumber: row.invoice_number || null,
    createdAt: row.created_at || null
  };
}

// A felhasználó rendelései: a fiókhoz kötöttek és a megerősített e-mail címére korábban, vendégként leadottak, újabbak elöl.
// Két külön lekérdezés fut (nincs szövegbe épített OR-feltétel, így az e-mail cím nem injektálhat szűrőt).
async function listUserOrders(user) {
  const client = supabase.requireClient();
  const query = () => client.from('orders').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(MAX_LISTED_ORDERS);
  const [owned, guest] = await Promise.all([query().eq('user_id', user.id), query().eq('user_email', user.email).is('user_id', null)]);
  for (const result of [owned, guest]) {
    if (result.error) throw new Error(`A rendelések lekérdezése sikertelen: ${result.error.message}`);
  }
  const byNumber = new Map();
  for (const row of [...(owned.data || []), ...(guest.data || [])]) byNumber.set(row.order_number, row);
  return [...byNumber.values()]
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .slice(0, MAX_LISTED_ORDERS)
    .map(summarize);
}

module.exports = {
  orderNumberFor, createPending, markPaid, markClosed, listUserOrders,
  upsertOrder, patchOrder, getByOrderNumber, getBySessionId, getByProviderPaymentId, claimDelivery, releaseDelivery, recordError, clearError, issueInvoiceForOrder, resetMemory
};
