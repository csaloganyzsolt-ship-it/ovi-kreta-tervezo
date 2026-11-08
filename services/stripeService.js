'use strict';

// Egy tervezet ára forintban. A szerver az egyetlen igazságforrás: a böngészőtől csak a csomag kulcsa fogadható el.
const PRODUCTS = Object.freeze({
  daily: Object.freeze({ key: 'daily', name: 'OviTervező – 1 db napi tervezet', amountHuf: 390 }),
  weekly: Object.freeze({ key: 'weekly', name: 'OviTervező – 1 db heti csomag (keretterv + 5 napi tervezet)', amountHuf: 890 })
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOCK_PREFIX = 'cs_mock_';

class PaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function isLive(env = process.env) {
  return Boolean(String(env.STRIPE_SECRET_KEY || '').trim());
}

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

// Kulcs nélkül fejlesztői (mock) mód van; élesben ez tiltott, hogy soha ne tűnjön sikeresnek egy ki nem fizetett rendelés.
function assertPaymentsAvailable(env = process.env) {
  if (!isLive(env) && isProduction(env)) {
    throw new PaymentError('A fizetés jelenleg nem érhető el: a STRIPE_SECRET_KEY nincs beállítva.', 503);
  }
}

function getBaseUrl(env = process.env) {
  return String(env.BASE_URL || 'http://localhost:4000').trim().replace(/\/+$/, '');
}

function parsePlan(value) {
  const product = PRODUCTS[String(value || '').trim()];
  if (!product) throw new PaymentError('Ismeretlen csomag. Elfogadott értékek: daily, weekly.');
  return product;
}

function parseEmail(value) {
  const email = String(value || '').trim();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new PaymentError('Adj meg egy érvényes számlázási e-mail címet.');
  }
  return email;
}

// A Stripe a HUF-ot két tizedesjegyes pénznemként kezeli: 390 Ft = 39000 egység.
function toStripeAmount(amountHuf) {
  return Math.round(amountHuf * 100);
}

let cachedClient = null;
let cachedKey = '';

function getClient(env = process.env, deps = {}) {
  if (deps.client) return deps.client;
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!cachedClient || cachedKey !== key) {
    const Stripe = require('stripe');
    cachedClient = new Stripe(key);
    cachedKey = key;
  }
  return cachedClient;
}

async function createCheckoutSession({ plan, email, generationId } = {}, deps = {}) {
  const env = deps.env || process.env;
  const product = parsePlan(plan);
  const customerEmail = parseEmail(email);
  assertPaymentsAvailable(env);
  const baseUrl = getBaseUrl(env);

  if (!isLive(env)) {
    const id = `${MOCK_PREFIX}${Date.now().toString(36)}`;
    return {
      mock: true,
      id,
      plan: product.key,
      amountHuf: product.amountHuf,
      url: `${baseUrl}/?checkout_session=${id}`,
      message: 'Fejlesztői (mock) mód: nincs STRIPE_SECRET_KEY, valódi fizetés nem történt.'
    };
  }

  const session = await getClient(env, deps).checkout.sessions.create({
    mode: 'payment',
    customer_email: customerEmail,
    billing_address_collection: 'required',
    locale: 'hu',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'huf',
        unit_amount: toStripeAmount(product.amountHuf),
        product_data: { name: product.name }
      }
    }],
    metadata: { plan: product.key, generationId: String(generationId || '').slice(0, 100) },
    success_url: `${baseUrl}/?checkout_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled`
  });
  return { mock: false, id: session.id, plan: product.key, amountHuf: product.amountHuf, url: session.url };
}

async function retrieveCheckoutSession(sessionId, deps = {}) {
  const env = deps.env || process.env;
  const id = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9_]{6,200}$/.test(id)) throw new PaymentError('Érvénytelen fizetési azonosító.');
  assertPaymentsAvailable(env);

  if (!isLive(env)) {
    if (!id.startsWith(MOCK_PREFIX)) throw new PaymentError('Ismeretlen fizetési azonosító (mock mód).', 404);
    return { mock: true, paid: true, plan: null, email: null };
  }
  const session = await getClient(env, deps).checkout.sessions.retrieve(id);
  return {
    mock: false,
    paid: session.payment_status === 'paid',
    plan: session.metadata?.plan || null,
    email: session.customer_details?.email || session.customer_email || null
  };
}

function constructWebhookEvent(rawBody, signature, deps = {}) {
  const env = deps.env || process.env;
  const secret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!isLive(env) || !secret) {
    throw new PaymentError('A Stripe webhook nincs beállítva (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET).', 503);
  }
  try {
    return getClient(env, deps).webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    throw new PaymentError(`Érvénytelen Stripe aláírás: ${error.message}`, 400);
  }
}

module.exports = {
  PRODUCTS, PaymentError, MOCK_PREFIX, isLive, getBaseUrl, parsePlan, parseEmail, toStripeAmount,
  createCheckoutSession, retrieveCheckoutSession, constructWebhookEvent
};
