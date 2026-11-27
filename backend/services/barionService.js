'use strict';

const crypto = require('node:crypto');
const stripeService = require('./stripeService');
const { normalizeHuTaxNumber } = require('../utils/taxNumber');
const invoiceService = require('./invoiceService');
const mailService = require('./mailService');
const sheetsService = require('./sheetsService');
const planStore = require('./planStore');
const coupons = require('./coupons');
const settingsService = require('./settingsService');
const orders = require('./orderService');
const { getBillingProfile } = require('./siteConstants');
const logger = require('../utils/logger');
const { PaymentError } = stripeService;

const API_HOSTS = { test: 'https://api.test.barion.com', live: 'https://api.barion.com' };
const GATEWAY_PATTERN = /^https:\/\/secure(\.test)?\.barion\.com\//;
const SESSION_PREFIX = 'barion_';
const SESSION_PATTERN = /^barion_[0-9a-f]{24}$/;
const REQUEST_TIMEOUT_MS = 15000;

// A Barion státuszai: ezek a végleges, nem fizetett kimenetek; minden más (Prepared, Started, InProgress, Waiting, Reserved, Authorized) még függőben van.
const FAILED_STATUSES = new Set(['Canceled', 'Failed', 'Expired']);

// A POS kulcs az aktív profilhoz (Admin Központ; tartalék: BILLING_PROFILE) tartozik; a profileType a rendelésen rögzített profilt adja.
function posKey(env = process.env, profileType) {
  return String(env[`BARION_POS_KEY_${stripeService.profileSuffix(env, profileType)}`] || env.BARION_POS_KEY || '').trim();
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

// ---------- Fizetések tárolása: a Supabase `orders` tábla (nincs helyi fájl) ----------

// A Barion-rendelés a sessionId (PaymentRequestId) alapján; más szolgáltató rendelését nem adja vissza.
async function getOrder(sessionId) {
  const order = await orders.getBySessionId(sessionId);
  return order && order.provider === 'barion' ? order : null;
}

async function findByPaymentId(paymentId) {
  const id = String(paymentId || '').trim();
  if (!id) return null;
  const order = await orders.getByProviderPaymentId(id);
  return order && order.provider === 'barion' ? order : null;
}

function createdSeconds(order) {
  const parsed = Date.parse(order.createdAt);
  return Math.floor((Number.isFinite(parsed) ? parsed : Date.now()) / 1000);
}

// A rendelés frissítése az adatbázisban és a memóriabeli példányon is.
async function updateOrder(order, fields) {
  await orders.patchOrder(order.orderNumber, fields);
  Object.assign(order, fields);
  return order;
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
  const taxNumber = normalizeHuTaxNumber(raw.taxNumber);
  if (taxNumber === null) throw new PaymentError('Az adószám érvénytelen. Adj meg 8 jegyű törzsszámot vagy teljes adószámot (pl. 12345678-1-23), vagy hagyd üresen magánszemélyként.', 400);
  const missing = [['name', 'számlázási név'], ['zip', 'irányítószám'], ['city', 'település'], ['address', 'utca, házszám']]
    .filter(([key]) => !billing[key]).map(([, label]) => label);
  if (missing.length) throw new PaymentError(`A számlázási adatok hiányosak: ${missing.join(', ')}.`, 400);
  if (billing.name.length < 2 || billing.city.length < 2 || billing.address.length < 3 || !BILLING_ZIP_PATTERN.test(billing.zip)) {
    throw new PaymentError('A számlázási adatok érvénytelenek: ellenőrizd a nevet, az irányítószámot, a települést és az utcát, házszámot.', 400);
  }
  return taxNumber ? { ...billing, taxNumber } : billing;
}

// ---------- Barion API ----------

function requireKey(env, profileType) {
  const key = posKey(env, profileType);
  if (!key) {
    throw new PaymentError(`A Barion fizetés jelenleg nem érhető el: a BARION_POS_KEY_${stripeService.profileSuffix(env, profileType)} (vagy a közös BARION_POS_KEY) nincs beállítva.`, 503);
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

// A Barion Payment/Start hívása: az összeg a mentett csomagból (részleges kuponnál a szerver által ellenőrzött kedvezménnyel csökkentve), a documentId az OrderNumber mezőben utazik.
async function startPayment({ plan, planMode, email, billing, generationId, title, coupon, user, req }, deps = {}) {
  const env = deps.env || process.env;
  await settingsService.getSettings();
  const product = stripeService.parsePlan(plan, planMode);
  const discount = coupon ? coupons.computeDiscount(product.amountHuf, coupon.percent) : null;
  const amountHuf = discount ? discount.finalPrice : product.amountHuf;
  if (amountHuf <= 0) throw new PaymentError('A 100%-os kupon fizetés nélkül váltható be, a Barion fizetés nem indítható.', 400);
  const itemName = discount ? `${product.invoiceName} (kupon: -${coupon.percent}%)` : product.invoiceName;
  const payer = stripeService.parseEmail(email);
  const customer = parseBilling(billing);
  const profileType = getBillingProfile(env).type;
  const key = requireKey(env, profileType);
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
      Total: amountHuf,
      Comment: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || product.name,
      Items: [{ Name: itemName, Description: itemName, Quantity: 1, Unit: 'db', UnitPrice: amountHuf, ItemTotal: amountHuf, SKU: product.key }]
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

  // A rendelés az állapotforrás: ha nem menthető, a vevő nem kap fizetési címet (a Barion-fizetés lejár, nem terheli senkit).
  const created = new Date();
  try {
    await orders.createPending({
      orderNumber: orders.orderNumberFor(sessionId, created),
      sessionId,
      provider: 'barion',
      providerPaymentId: payload.PaymentId,
      providerStatus: payload.Status || 'Prepared',
      billingProfile: profileType,
      billing: customer,
      title: body.Transactions[0].Comment,
      userId: user?.id,
      email: payer,
      documentId,
      planMode: product.planMode,
      planKey: product.key,
      amount: amountHuf,
      listPrice: discount ? product.amountHuf : undefined,
      couponCode: discount ? coupon.code : undefined,
      couponPercent: discount ? coupon.percent : undefined,
      paymentMethod: 'Barion',
      createdAt: created.toISOString()
    });
  } catch (error) {
    logger.error('barion_payment', `A rendelés rögzítése sikertelen, a fizetés nem indítható: ${error.message}`, { email: payer, details: { sessionId } });
    throw new PaymentError('A fizetés jelenleg nem indítható (a rendelés nem menthető). Próbáld újra később.', error.status || 503);
  }
  return { sessionId, paymentId: payload.PaymentId, gatewayUrl: payload.GatewayUrl, plan: product.key, amountHuf, ...(discount ? { originalAmountHuf: product.amountHuf, couponPercent: coupon.percent } : {}) };
}

async function fetchPaymentState(paymentId, deps = {}, profileType) {
  const env = deps.env || process.env;
  const url = `${apiBase(env)}/v2/Payment/GetPaymentState?${new URLSearchParams({ POSKey: requireKey(env, profileType), PaymentId: paymentId })}`;
  const { response, payload } = await callBarion(url, { method: 'GET' }, deps);
  if (!response.ok || (Array.isArray(payload?.Errors) && payload.Errors.length) || !payload?.Status) {
    throw barionError('A Barion fizetési állapota nem kérdezhető le', payload, response.status);
  }
  return payload;
}

// Egy fizetésenként egyszerre egy lezárás fut (a webhook és a visszatérő oldal lekérdezése egyszerre érkezhet).
const settling = new Map();

async function settleOrder(order, deps) {
  const env = deps.env || process.env;
  const state = await fetchPaymentState(order.providerPaymentId, deps, order.billingProfile);
  const latest = (await getOrder(order.sessionId)) || order;
  if (latest.providerStatus !== state.Status) await updateOrder(latest, { providerStatus: state.Status });
  if (state.Status !== 'Succeeded') {
    if (FAILED_STATUSES.has(state.Status) && latest.status === 'pending') {
      logger.warning('barion_payment', `A Barion fizetés nem sikerült (${state.Status})`, { email: latest.email, details: { sessionId: latest.sessionId, status: state.Status } });
      await orders.markClosed(latest.orderNumber, state.Status === 'Canceled' ? 'cancelled' : 'failed');
      latest.status = state.Status === 'Canceled' ? 'cancelled' : 'failed';
    }
    return latest;
  }
  // A Barion válasza a mérvadó: csak a saját kérésünkhöz tartozó, a mentett csomag árával egyező, forintos fizetés számít sikeresnek.
  const total = Number(state.Total ?? state.Transactions?.[0]?.Total);
  if ((state.PaymentRequestId && state.PaymentRequestId !== latest.sessionId) || total !== latest.amount || (state.Currency && state.Currency !== 'HUF')) {
    logger.error('barion_payment', `Eltérő fizetési adatok: összeg ${total} / várt ${latest.amount}, pénznem ${state.Currency}`, { email: latest.email, details: { sessionId: latest.sessionId } });
    throw new PaymentError('A Barion fizetés adatai nem egyeznek a rendeléssel, a terv nem oldható fel.', 409);
  }
  if (latest.status !== 'paid') await updateOrder(latest, { status: 'paid', paidAt: latest.paidAt || new Date().toISOString() });
  await finalizePaid(latest);
  if (!latest.invoiceNumber && latest.invoiceStatus !== 'mock') await issueOrderInvoice(latest, deps, env);
  return latest;
}

async function issueOrderInvoice(order, deps, env) {
  const billing = order.billing || {};
  try {
    const result = await (deps.issueInvoice || invoiceService.issueInvoice)({
      orderId: order.sessionId,
      created: createdSeconds(order),
      plan: order.planKey,
      amountHuf: order.amount,
      couponPercent: order.couponPercent || undefined,
      paymentMethod: 'Barion',
      billingProfile: order.billingProfile || undefined,
      customer: { name: billing.name || '', email: order.email, zip: billing.zip || '', city: billing.city || '', address: billing.address || '', taxNumber: billing.taxNumber || '' }
    }, { env, fetch: deps.fetch });
    await updateOrder(order, result.mock
      ? { invoiceStatus: 'mock' }
      : { invoiceNumber: result.invoiceNumber, invoiceStatus: 'issued', invoiceIssuedAt: new Date().toISOString() });
    if (!result.mock) notifyPurchase(order, result.invoiceNumber, result.pdf, deps);
    if (!result.mock) await orders.clearError(order.orderNumber, 'Számlázás');
  } catch (invoiceErr) {
    logger.error('barion_payment', `Számlázás sikertelen: ${invoiceErr.message}`, { email: order.email, details: { sessionId: order.sessionId, plan: order.planKey } });
    // A rendelés fizetett marad; a hiba a rendelésen is rögzül, a riasztás ugyanarra a hibára csak egyszer megy ki.
    const firstTime = await orders.recordError(order.orderNumber, 'Számlázás', invoiceErr.message);
    if (firstTime) {
      mailService.sendAdminErrorAlert({
        operation: 'Számlázás (Barion fizetés)',
        error: invoiceErr,
        email: order.email,
        documentId: order.documentId || order.sessionId,
        details: { sessionId: order.sessionId, orderNumber: order.orderNumber, plan: order.planKey }
      }, { env }).catch((e) => console.warn('Admin error alert failed:', e.message));
    }
    if (!order.invoiceNumber) await orders.patchOrder(order.orderNumber, { invoiceStatus: 'failed' }).catch(() => {});
    throw invoiceErr;
  }
}

// Sikeres fizetés után: a kuponbeváltás statisztikai sora és a dokumentum feloldott állapota. A fizetés ettől már nem változik, ezért a hiba csak naplózódik, és a következő lezáráskor újra próbálja.
async function finalizePaid(order) {
  if (order.couponCode && !order.redemptionLogged) {
    try {
      await coupons.logRedemption({
        code: order.couponCode,
        email: order.email,
        generationId: order.documentId,
        planMode: order.planMode,
        originalPrice: order.listPrice,
        discountAmount: order.listPrice - order.amount,
        finalPrice: order.amount
      });
      await updateOrder(order, { redemptionLogged: true });
    } catch (error) {
      console.error('[barion]', error.message);
    }
  }
  if (order.documentSynced !== true) {
    try {
      await planStore.updateDocument(order.documentId, {
        unlocked: true,
        meta: { payment: { provider: 'barion', sessionId: order.sessionId, plan: order.planKey, amountHuf: order.amount, couponCode: order.couponCode || null, billing: order.billing } }
      });
      await updateOrder(order, { documentSynced: true });
    } catch (error) {
      console.error('[barion]', error.message);
    }
  }
}

// A lezárás akkor kész, ha a számla kiállt, a kuponbeváltás naplózva van, és a dokumentum feloldott állapota mentve van.
function isSettled(order) {
  return order.status === 'paid' && Boolean(order.invoiceNumber || order.invoiceStatus === 'mock') && !(order.couponCode && !order.redemptionLogged) && order.documentSynced === true;
}

// Mint a Stripe webhooknál: rendszergazdai levél és Google Táblázat-sor, nem várjuk meg; a hibájuk nem érinti a fizetést. A levél némítása (NODE_ENV=test) a mailService-ben él.
// A számla PDF csak memóriában utazik (a kiállításkor kapott puffer).
function notifyPurchase(order, invoiceNumber, invoicePdf, deps) {
  const env = deps.env || process.env;
  const billing = order.billing || {};
  const customer = { name: billing.name || '', email: order.email, zip: billing.zip || '', city: billing.city || '', address: billing.address || '', taxNumber: billing.taxNumber || '' };
  const created = createdSeconds(order);
  const session = { id: order.sessionId, created, metadata: { plan: order.planKey, title: order.title, amountHuf: order.amount } };
  sheetsService.recordPurchase({ session, invoiceNumber, invoicePdf, customer }, { env, fetch: deps.sheetsFetch }).catch(() => {});
  mailService.sendAdminNotification({
    customer: { name: customer.name, email: customer.email },
    plan: order.planKey,
    title: order.title,
    orderNumber: order.orderNumber,
    invoiceNumber,
    invoicePdf,
    paymentMethod: 'Barion'
  }, { env }).catch((error) => logger.error('email_delivery', `Rendszergazdai értesítő sikertelen: ${error.message}`, { email: order.email, details: { sessionId: order.sessionId } }));
}

// Lekérdezi a Barion aktuális állapotát és (siker esetén, egyszer) lezárja a fizetést: feloldás + számla.
async function refreshPayment(order, deps = {}) {
  if (isSettled(order)) return order;
  if (settling.has(order.sessionId)) return settling.get(order.sessionId);
  const task = settleOrder(order, deps).finally(() => settling.delete(order.sessionId));
  settling.set(order.sessionId, task);
  return task;
}

// A Stripe-munkamenet alakjával megegyező nézet a közös /api/checkout-session, /api/deliver és /api/invoice végpontokhoz.
async function retrieveSession(sessionId, deps = {}) {
  const order = await getOrder(sessionId);
  if (!order) throw new PaymentError('Ismeretlen Barion fizetési azonosító.', 404);
  let current = order;
  if (!isSettled(order)) {
    try {
      current = await refreshPayment(order, deps);
    } catch (error) {
      // A már kifizetett terv a számlázási hiba miatt sem záródhat vissza; a hiba a webhook újrapróbálásakor jön elő.
      current = await getOrder(sessionId);
      if (current?.status !== 'paid') throw error;
      console.error(`[barion] Kifizetett rendelés (${sessionId}), de a lezárás hibás:`, error.message);
    }
  }
  const paid = current.status === 'paid';
  return {
    mock: false,
    paid,
    unlocked: paid,
    pending: current.status === 'pending',
    status: current.providerStatus,
    provider: 'barion',
    plan: current.planKey,
    amountHuf: current.amount,
    generationId: current.documentId,
    created: createdSeconds(current),
    email: current.email,
    orderNumber: current.orderNumber,
    billingProfile: current.billingProfile
  };
}

// A Barion visszahívása (IPN): csak a paymentId számít, az állapotot mindig a Barion API-tól kérdezzük le.
async function handleCallback(paymentId, deps = {}) {
  await settingsService.getSettings();
  const order = await findByPaymentId(paymentId);
  if (!order) return { known: false };
  const current = await refreshPayment(order, deps);
  return { known: true, sessionId: current.sessionId, status: current.providerStatus, paid: current.status === 'paid' };
}

module.exports = {
  SESSION_PREFIX, GATEWAY_PATTERN, posKey, isTestMode, apiBase, payeeEmail, isSessionId, callbackUrl,
  getOrder, findByPaymentId, parseBilling, startPayment, fetchPaymentState, refreshPayment, retrieveSession, handleCallback
};
