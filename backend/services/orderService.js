'use strict';

// Rendeléstörténet (Supabase `orders` tábla). Írni csak a backend tud (titkos kulccsal); a böngésző RLS-sel csak a saját sorait olvashatja.
// Supabase nélkül (vendég/fejlesztői üzem) a függvények nem csinálnak semmit, és false-t adnak vissza.
const supabase = require('./supabaseService');
const invoiceService = require('./invoiceService');

const STATUSES = new Set(['pending', 'paid', 'failed', 'cancelled']);
const LIST_COLUMNS = 'order_number, document_id, plan_mode, plan_key, amount, coupon_code, payment_method, status, invoice_number, created_at';
const MAX_LISTED_ORDERS = 100;

// A számlán és a levelekben is szereplő rendelésszám (OVI-ÉÉHHNN-XXXXXX).
function orderNumberFor(sessionId, created = new Date()) {
  return invoiceService.orderNumber(sessionId, created);
}

function toRow(order) {
  const row = {
    order_number: order.orderNumber,
    user_id: order.userId || undefined,
    user_email: order.email ? String(order.email).trim().toLowerCase() : undefined,
    document_id: order.documentId || undefined,
    plan_mode: order.planMode || undefined,
    plan_key: order.planKey || undefined,
    amount: order.amount,
    coupon_code: order.couponCode || undefined,
    payment_method: order.paymentMethod || undefined,
    status: order.status,
    invoice_number: order.invoiceNumber || undefined
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

async function upsertOrder(order) {
  const client = supabase.getClient();
  if (!client) return false;
  if (!order?.orderNumber || !Number.isInteger(order.amount) || order.amount < 0 || !STATUSES.has(order.status)) {
    throw new Error('A rendelés adatai hiányosak vagy érvénytelenek.');
  }
  const { error } = await client.from('orders').upsert(toRow(order), { onConflict: 'order_number' });
  if (error) throw new Error(`A rendelés Supabase-be mentése sikertelen (${order.orderNumber}): ${error.message}`);
  return true;
}

// Fizetés indításakor: függőben lévő rendelés.
function createPending(order) {
  return upsertOrder({ ...order, status: 'pending' });
}

// Sikeres Barion- vagy kuponos fizetéskor (újrahívható: ugyanaz a rendelésszám ugyanazt a sort frissíti).
function markPaid(order) {
  return upsertOrder({ ...order, status: 'paid' });
}

// Sikertelen vagy megszakadt fizetés; a már kifizetett rendelést nem írja felül.
async function markClosed(orderNumber, status) {
  if (!['failed', 'cancelled'].includes(status)) throw new Error('Érvénytelen rendelésállapot.');
  const client = supabase.getClient();
  if (!client) return false;
  const { error } = await client.from('orders').update({ status }).eq('order_number', orderNumber).eq('status', 'pending');
  if (error) throw new Error(`A rendelés állapotának frissítése sikertelen (${orderNumber}): ${error.message}`);
  return true;
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

module.exports = { orderNumberFor, createPending, markPaid, markClosed, listUserOrders };
