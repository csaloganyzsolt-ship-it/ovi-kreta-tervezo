'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stripeService = require('./stripeService');
const invoiceService = require('./invoiceService');
const mailService = require('./mailService');
const sheetsService = require('./sheetsService');
const { PaymentError } = stripeService;

const API_HOSTS = { test: 'https://api.test.barion.com', live: 'https://api.barion.com' };
const GATEWAY_PATTERN = /^https:\/\/secure(\.test)?\.barion\.com\//;
const SESSION_PREFIX = 'barion_';
const SESSION_PATTERN = /^barion_[0-9a-f]{24}$/;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;

// A Barion státuszai: ezek a végleges, nem fizetett kimenetek; minden más (Prepared, Started, InProgress, Waiting, Reserved, Authorized) még függőben van.
const FAILED_STATUSES = new Set(['Canceled', 'Failed', 'Expired']);

function posKey(env = process.env) {
  return String(env[`BARION_POS_KEY_${stripeService.profileSuffix(env)}`] || env.BARION_POS_KEY || '').trim();
}

function isTestMode(env = process.env) {
  return String(env.BARION_TEST_MODE || '').trim().toLowerCase() === 'true';
}

function apiBase(env = process.env) {
  return isTestMode(env) ? API_HOSTS.test : API_HOSTS.live;
}

// A Payee a Barion-bolt regisztrált e-mail címe; külön megadható, különben az ügyfélszolgálati cím.
function payeeEmail(env = process.env) {
  return String(env.BARION_PAYEE_EMAIL || '').trim() || invoiceService.supportEmail(env);
}

function isSessionId(id) {
  return SESSION_PATTERN.test(String(id || ''));
}

// A Barion a hívónak a saját, publikus címét nem ismeri: a visszahívási URL a backend nyilvános címe.
function callbackUrl(env = process.env, req) {
  const configured = String(env.BACKEND_URL || env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  const origin = configured || (req ? `${req.protocol}://${req.get('host')}` : '');
  return `${origin}/api/webhook/barion`;
}

// ---------- Fizetések tárolása (fájl; újraindítás után is megvan a vásárló és a csomag) ----------

function storeFile(env = process.env) {
  return path.join(invoiceService.storageDir(env), 'barion-payments.json');
}

function readStore(env) {
  try {
    return JSON.parse(fs.readFileSync(storeFile(env), 'utf8'));
  } catch (_error) {
    return {};
  }
}

function writeStore(env, data) {
  const file = storeFile(env);
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, record] of Object.entries(data)) if (record.createdAt < cutoff) delete data[id];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getRecord(sessionId, env = process.env) {
  return readStore(env)[sessionId] || null;
}

function findByPaymentId(paymentId, env = process.env) {
  const id = String(paymentId || '').trim();
  if (!id) return null;
  return Object.values(readStore(env)).find((record) => record.paymentId === id) || null;
}

function saveRecord(record, env) {
  const store = readStore(env);
  store[record.sessionId] = record;
  writeStore(env, store);
}

// ---------- Számlázási adatok ----------

const BILLING_ZIP_PATTERN = /^[0-9A-Za-z][0-9A-Za-z -]{2,9}$/;

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A Számlázz.hu számlához kötelező vevői adatok; a Barion nem ad számlázási címet, ezért a kliens küldi. Hiány esetén 400.
function parseBilling(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const billing = { name: cleanText(raw.name, 120), zip: cleanText(raw.zip, 10), city: cleanText(raw.city, 80), address: cleanText(raw.address, 120) };
  const missing = [['name', 'számlázási név'], ['zip', 'irányítószám'], ['city', 'település'], ['address', 'utca, házszám']]
    .filter(([key]) => !billing[key]).map(([, label]) => label);
  if (missing.length) throw new PaymentError(`A számlázási adatok hiányosak: ${missing.join(', ')}.`, 400);
  if (billing.name.length < 2 || billing.city.length < 2 || billing.address.length < 3 || !BILLING_ZIP_PATTERN.test(billing.zip)) {
    throw new PaymentError('A számlázási adatok érvénytelenek: ellenőrizd a nevet, az irányítószámot, a települést és az utcát, házszámot.', 400);
  }
  return billing;
}

// ---------- Barion API ----------

function requireKey(env) {
  const key = posKey(env);
  if (!key) {
    throw new PaymentError(`A Barion fizetés jelenleg nem érhető el: a BARION_POS_KEY_${stripeService.profileSuffix(env)} (vagy a közös BARION_POS_KEY) nincs beállítva.`, 503);
  }
  return key;
}

function barionError(prefix, payload, status) {
  const errors = Array.isArray(payload?.Errors) ? payload.Errors : [];
  const detail = errors.map((error) => [error.ErrorCode, error.Title || error.Description].filter(Boolean).join(': ')).filter(Boolean).join('; ');
  console.error(`[barion] ${prefix}:`, detail || `HTTP ${status}`);
  return new PaymentError(`${prefix}${detail ? ` (${detail})` : ` (HTTP ${status})`}.`, 502);
}

async function callBarion(url, options, deps) {
  const fetchImpl = deps.fetch || fetch;
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    console.error('[barion] hálózati hiba:', error.message);
    throw new PaymentError(`A Barion nem érhető el: ${error.message}`, 502);
  }
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

// A Barion Payment/Start hívása: az összeg a mentett csomagból, a documentId az OrderNumber mezőben utazik.
async function startPayment({ plan, planMode, email, billing, generationId, title, req }, deps = {}) {
  const env = deps.env || process.env;
  const product = stripeService.parsePlan(plan, planMode);
  const payer = stripeService.parseEmail(email);
  const customer = parseBilling(billing);
  const key = requireKey(env);
  const documentId = String(generationId || '').slice(0, 100);
  const sessionId = `${SESSION_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  const baseUrl = stripeService.getBaseUrl(env);

  const body = {
    POSKey: key,
    PaymentType: 'Immediate',
    GuestCheckout: true,
    FundingSources: ['All'],
    PaymentRequestId: sessionId,
    PayerHint: payer,
    Locale: 'hu-HU',
    OrderNumber: documentId,
    Currency: 'HUF',
    RedirectUrl: `${baseUrl}/tervezo.html?payment=barion&session_id=${sessionId}`,
    CallbackUrl: callbackUrl(env, req),
    Transactions: [{
      POSTransactionId: `${sessionId}-1`,
      Payee: payeeEmail(env),
      Total: product.amountHuf,
      Comment: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || product.name,
      Items: [{ Name: product.invoiceName, Description: product.invoiceName, Quantity: 1, Unit: 'db', UnitPrice: product.amountHuf, ItemTotal: product.amountHuf, SKU: product.key }]
    }]
  };
  const { response, payload } = await callBarion(`${apiBase(env)}/v2/Payment/Start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, deps);
  const failed = !response.ok || (Array.isArray(payload?.Errors) && payload.Errors.length) || !payload?.PaymentId || !payload?.GatewayUrl;
  if (failed) throw barionError('A Barion fizetés indítása sikertelen', payload, response.status);
  if (!GATEWAY_PATTERN.test(payload.GatewayUrl)) {
    console.error('[barion] Váratlan GatewayUrl:', String(payload.GatewayUrl).slice(0, 100));
    throw new PaymentError('A Barion váratlan fizetési címet adott vissza, a fizetés nem indítható.', 502);
  }

  saveRecord({
    sessionId, paymentId: payload.PaymentId, generationId: documentId, email: payer, billing: customer, plan: product.key, planMode: product.planMode,
    amountHuf: product.amountHuf, title: body.Transactions[0].Comment, status: payload.Status || 'Prepared', paid: false, unlocked: false,
    createdAt: Date.now()
  }, env);
  return { sessionId, paymentId: payload.PaymentId, gatewayUrl: payload.GatewayUrl, plan: product.key, amountHuf: product.amountHuf };
}

async function fetchPaymentState(paymentId, deps = {}) {
  const env = deps.env || process.env;
  const url = `${apiBase(env)}/v2/Payment/GetPaymentState?${new URLSearchParams({ POSKey: requireKey(env), PaymentId: paymentId })}`;
  const { response, payload } = await callBarion(url, { method: 'GET' }, deps);
  if (!response.ok || (Array.isArray(payload?.Errors) && payload.Errors.length) || !payload?.Status) {
    throw barionError('A Barion fizetési állapota nem kérdezhető le', payload, response.status);
  }
  return payload;
}

// Egy fizetésenként egyszerre egy lezárás fut (a webhook és a visszatérő oldal lekérdezése egyszerre érkezhet).
const settling = new Map();

async function settleRecord(record, deps) {
  const env = deps.env || process.env;
  const state = await fetchPaymentState(record.paymentId, deps);
  const latest = getRecord(record.sessionId, env) || record;
  latest.status = state.Status;
  if (state.Status !== 'Succeeded') {
    saveRecord(latest, env);
    return latest;
  }
  // A Barion válasza a mérvadó: csak a saját kérésünkhöz tartozó, a mentett csomag árával egyező, forintos fizetés számít sikeresnek.
  const total = Number(state.Total ?? state.Transactions?.[0]?.Total);
  if ((state.PaymentRequestId && state.PaymentRequestId !== latest.sessionId) || total !== latest.amountHuf || (state.Currency && state.Currency !== 'HUF')) {
    console.error(`[barion] Eltérő fizetési adatok (${latest.sessionId}): összeg ${total} / várt ${latest.amountHuf}, pénznem ${state.Currency}`);
    throw new PaymentError('A Barion fizetés adatai nem egyeznek a rendeléssel, a terv nem oldható fel.', 409);
  }
  latest.paid = true;
  latest.unlocked = true;
  saveRecord(latest, env);
  if (!latest.invoiceNumber) {
    const billing = latest.billing || {};
    const result = await (deps.issueInvoice || invoiceService.issueInvoice)({
      orderId: latest.sessionId,
      created: Math.floor(latest.createdAt / 1000),
      plan: latest.plan,
      paymentMethod: 'Barion',
      customer: { name: billing.name || '', email: latest.email, zip: billing.zip || '', city: billing.city || '', address: billing.address || '' }
    }, { env, fetch: deps.fetch });
    latest.invoiceNumber = result.invoiceNumber || (result.mock ? 'mock' : 'duplicate');
    saveRecord(latest, env);
    if (!result.duplicate && !result.mock) notifyPurchase(latest, result.invoiceNumber, deps);
  }
  return latest;
}

// Mint a Stripe webhooknál: rendszergazdai levél és Google Táblázat-sor, nem várjuk meg; a hibájuk nem érinti a fizetést. A levél némítása (NODE_ENV=test) a mailService-ben él.
function notifyPurchase(record, invoiceNumber, deps) {
  const env = deps.env || process.env;
  const billing = record.billing || {};
  const customer = { name: billing.name || '', email: record.email, zip: billing.zip || '', city: billing.city || '', address: billing.address || '' };
  const created = Math.floor(record.createdAt / 1000);
  const invoicePdf = invoiceService.getInvoicePdf(record.sessionId, env);
  const session = { id: record.sessionId, created, metadata: { plan: record.plan, title: record.title } };
  sheetsService.recordPurchase({ session, invoiceNumber, invoicePdf, customer }, { env, fetch: deps.sheetsFetch }).catch(() => {});
  mailService.sendAdminNotification({
    customer: { name: customer.name, email: customer.email },
    plan: record.plan,
    title: record.title,
    orderNumber: invoiceService.orderNumber(record.sessionId, new Date(created * 1000)),
    invoiceNumber,
    invoicePdf,
    paymentMethod: 'Barion'
  }, { env }).catch((error) => console.error('[mail] Rendszergazdai értesítő sikertelen:', error.message));
}

// Lekérdezi a Barion aktuális állapotát és (siker esetén, egyszer) lezárja a fizetést: feloldás + számla.
async function refreshPayment(record, deps = {}) {
  if (record.paid && record.invoiceNumber) return record;
  if (settling.has(record.sessionId)) return settling.get(record.sessionId);
  const task = settleRecord(record, deps).finally(() => settling.delete(record.sessionId));
  settling.set(record.sessionId, task);
  return task;
}

// A Stripe-munkamenet alakjával megegyező nézet a közös /api/checkout-session, /api/deliver és /api/invoice végpontokhoz.
async function retrieveSession(sessionId, deps = {}) {
  const env = deps.env || process.env;
  const record = getRecord(sessionId, env);
  if (!record) throw new PaymentError('Ismeretlen Barion fizetési azonosító.', 404);
  let current = record;
  if (!(record.paid && record.invoiceNumber)) {
    try {
      current = await refreshPayment(record, deps);
    } catch (error) {
      // A már kifizetett terv a számlázási hiba miatt sem záródhat vissza; a hiba a webhook újrapróbálásakor jön elő.
      current = getRecord(sessionId, env);
      if (!current?.paid) throw error;
      console.error(`[barion] Kifizetett rendelés (${sessionId}), de a lezárás hibás:`, error.message);
    }
  }
  return {
    mock: false,
    paid: current.paid,
    unlocked: current.unlocked,
    pending: !current.paid && !FAILED_STATUSES.has(current.status),
    status: current.status,
    provider: 'barion',
    plan: current.plan,
    generationId: current.generationId,
    created: Math.floor(current.createdAt / 1000),
    email: current.email
  };
}

// A Barion visszahívása (IPN): csak a paymentId számít, az állapotot mindig a Barion API-tól kérdezzük le.
async function handleCallback(paymentId, deps = {}) {
  const env = deps.env || process.env;
  const record = findByPaymentId(paymentId, env);
  if (!record) return { known: false };
  const current = await refreshPayment(record, deps);
  return { known: true, sessionId: current.sessionId, status: current.status, paid: current.paid };
}

module.exports = {
  SESSION_PREFIX, GATEWAY_PATTERN, posKey, isTestMode, apiBase, payeeEmail, isSessionId, callbackUrl, storeFile,
  getRecord, findByPaymentId, parseBilling, startPayment, fetchPaymentState, refreshPayment, retrieveSession, handleCallback
};
