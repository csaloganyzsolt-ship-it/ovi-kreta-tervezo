'use strict';

const { getBillingProfile } = require('./siteConstants');

const { PRODUCTS, productFor } = require('./pricing');
const settingsService = require('./settingsService');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOCK_PREFIX = 'cs_mock_';
const mockSessions = new Map();
const MAX_MOCK_SESSIONS = 1000;
const MOCK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function pruneMockSessions(now = Date.now()) {
  for (const [id, session] of mockSessions.entries()) {
    if (now - session.createdAt > MOCK_SESSION_TTL_MS) mockSessions.delete(id);
  }
  while (mockSessions.size > MAX_MOCK_SESSIONS) mockSessions.delete(mockSessions.keys().next().value);
}

setInterval(pruneMockSessions, MOCK_SESSION_TTL_MS / 24).unref();

class PaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Profilfüggő kulcsok: az aktív profil (Admin Központ, tartalékként a BILLING_PROFILE) szerint a *_EV / *_KFT változat, ennek hiányában a közös név.
// A profileType megadásával (pl. a rendelésen rögzített profil) a kulcs kifejezetten az adott profilhoz oldódik fel.
function profileSuffix(env, profileType) {
  return getBillingProfile(env, profileType).type === 'kft' ? 'KFT' : 'EV';
}

function stripeSecretKey(env = process.env, profileType) {
  return String(env[`STRIPE_SECRET_KEY_${profileSuffix(env, profileType)}`] || env.STRIPE_SECRET_KEY || '').trim();
}

function stripeWebhookSecret(env = process.env, profileType) {
  return String(env[`STRIPE_WEBHOOK_SECRET_${profileSuffix(env, profileType)}`] || env.STRIPE_WEBHOOK_SECRET || '').trim();
}

function stripePublishableKey(env = process.env, profileType) {
  return String(env[`STRIPE_PUBLISHABLE_KEY_${profileSuffix(env, profileType)}`] || env.STRIPE_PUBLISHABLE_KEY || '').trim();
}

// Hibaüzenethez: pontosan melyik változót kell megadni az aktív profilhoz.
function keyName(base, env) {
  return `${base}_${profileSuffix(env)} (vagy a közös ${base})`;
}

function isLive(env = process.env) {
  return Boolean(stripeSecretKey(env));
}

// sk_test_ kulccsal a Stripe tesztmódban fut: nincs valódi terhelés.
function isTestMode(env = process.env) {
  return stripeSecretKey(env).startsWith('sk_test_');
}

// A mock mód kizárólag NODE_ENV=test alatt él; kulcs nélkül máshol mindig hiba, hogy soha ne tűnjön sikeresnek egy ki nem fizetett rendelés.
function assertPaymentsAvailable(env = process.env) {
  if (!isLive(env) && env.NODE_ENV !== 'test') {
    throw new PaymentError(`A fizetés jelenleg nem érhető el: a(z) ${keyName('STRIPE_SECRET_KEY', env)} nincs beállítva (aktív profil: ${getBillingProfile(env).type}).`, 503);
  }
}

// A fizetés utáni visszatérési cím: FRONTEND_URL (pl. GitHub Pages teszt vagy localhost), ennek hiányában BASE_URL.
function getBaseUrl(env = process.env) {
  const configured = String(env.FRONTEND_URL || '').trim() || String(env.BASE_URL || '').trim();
  const fallback = env.NODE_ENV === 'production' ? 'https://ovitervezo.hu' : 'http://localhost:4000';
  return (configured || fallback).replace(/\/+$/, '');
}

// A planMode és (heti csomagnál) a napok a csomag árát is meghatározzák; a fizetési végpontok a mentett tervezetből adják át a kész terméket.
function parsePlan(value, planMode, options) {
  const product = productFor(value, planMode, undefined, options);
  if (!product) throw new PaymentError(`Ismeretlen csomag. Elfogadott értékek: ${Object.keys(PRODUCTS).join(', ')}.`);
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

function getClient(env = process.env, deps = {}, profileType) {
  if (deps.client) return deps.client;
  const key = stripeSecretKey(env, profileType);
  if (!cachedClient || cachedKey !== key) {
    const Stripe = require('stripe');
    cachedClient = new Stripe(key);
    cachedKey = key;
  }
  return cachedClient;
}

async function createCheckoutSession({ plan, email, generationId, title, planMode, product: resolved, selectedDays } = {}, deps = {}) {
  const env = deps.env || process.env;
  await settingsService.getSettings();
  const product = resolved || parsePlan(plan, planMode, { selectedDays });
  const customerEmail = parseEmail(email);
  assertPaymentsAvailable(env);
  const baseUrl = getBaseUrl(env);

  if (!isLive(env)) {
    const id = `${MOCK_PREFIX}${Date.now().toString(36)}`;
    mockSessions.set(id, { plan: product.key, email: customerEmail, generationId: String(generationId || '').slice(0, 100), createdAt: Date.now() });
    pruneMockSessions();
    return {
      mock: true,
      id,
      plan: product.key,
      amountHuf: product.amountHuf,
      url: `${baseUrl}/tervezo.html?payment=success&session_id=${id}`,
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
        product_data: { name: product.invoiceName, description: product.invoiceName }
      }
    }],
    metadata: { plan: product.key, planMode: product.planMode, selectedDayCount: String(product.selectedDays?.length || 0), billingProfile: getBillingProfile(env).type, generationId: String(generationId || '').slice(0, 100), title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200) },
    success_url: `${baseUrl}/tervezo.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/tervezo.html?payment=cancel`
  });
  return { mock: false, testMode: isTestMode(env), id: session.id, plan: product.key, amountHuf: product.amountHuf, url: session.url };
}

async function retrieveCheckoutSession(sessionId, deps = {}) {
  const env = deps.env || process.env;
  const id = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9_]{6,200}$/.test(id)) throw new PaymentError('Érvénytelen fizetési azonosító.');
  assertPaymentsAvailable(env);

  if (!isLive(env)) {
    if (!id.startsWith(MOCK_PREFIX)) throw new PaymentError('Ismeretlen fizetési azonosító (mock mód).', 404);
    const mock = mockSessions.get(id);
    if (!mock) throw new PaymentError('Ismeretlen fizetési azonosító (mock mód).', 404);
    return { mock: true, paid: true, plan: mock.plan || null, email: mock.email || null, generationId: mock.generationId || null };
  }
  const session = await getClient(env, deps).checkout.sessions.retrieve(id);
  return {
    mock: false,
    paid: session.payment_status === 'paid',
    plan: session.metadata?.plan || null,
    generationId: session.metadata?.generationId || null,
    created: session.created || null,
    email: session.customer_details?.email || session.customer_email || null,
    provider: 'stripe',
    billingProfile: session.metadata?.billingProfile || null,
    amountHuf: Number.isFinite(session.amount_total) ? Math.round(session.amount_total / 100) : null
  };
}

// Az aláírást az aktív profil titkával, ennek sikertelensége esetén a másik profil saját titkával ellenőrizzük
// (profilváltás után a korábban indított fizetések webhookja még a régi fiókból érkezik). A siker a `billingProfile` mezőt is megadja.
function constructWebhookEvent(rawBody, signature, deps = {}) {
  const env = deps.env || process.env;
  const active = getBillingProfile(env).type;
  const other = active === 'kft' ? 'ev' : 'kft';
  const candidates = [{ type: active, secret: stripeWebhookSecret(env, active) }];
  const otherSecret = String(env[`STRIPE_WEBHOOK_SECRET_${other === 'kft' ? 'KFT' : 'EV'}`] || '').trim();
  if (otherSecret) candidates.push({ type: other, secret: otherSecret });
  if (!isLive(env) || !candidates[0].secret) {
    throw new PaymentError(`A Stripe webhook nincs beállítva (${keyName('STRIPE_SECRET_KEY', env)} / ${keyName('STRIPE_WEBHOOK_SECRET', env)}, aktív profil: ${active}).`, 503);
  }
  let lastError;
  for (const candidate of candidates) {
    try {
      const event = getClient(env, deps).webhooks.constructEvent(rawBody, signature, candidate.secret);
      event.billingProfile = candidate.type;
      return event;
    } catch (error) {
      lastError = error;
    }
  }
  throw new PaymentError(`Érvénytelen Stripe aláírás: ${lastError.message}`, 400);
}

module.exports = {
  PRODUCTS, PaymentError, MOCK_PREFIX, profileSuffix, stripePublishableKey, stripeSecretKey, stripeWebhookSecret, isLive, isTestMode, getBaseUrl, parsePlan, parseEmail, toStripeAmount,
  createCheckoutSession, retrieveCheckoutSession, constructWebhookEvent,
  mockSessions, pruneMockSessions, MAX_MOCK_SESSIONS
};
