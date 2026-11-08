const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const { makePayload, makePlan } = require('./fixtures');

const devEnv = { BASE_URL: 'https://ovitervezo.hu' };

test('stripe mock mode answers clearly without keys and is refused in production', async () => {
  const mock = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: devEnv });
  assert.equal(mock.mock, true);
  assert.match(mock.url, /^https:\/\/ovitervezo\.hu\/\?checkout_session=cs_mock_/);
  await assert.rejects(
    stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { NODE_ENV: 'production' } }),
    (error) => error.status === 503
  );
});

test('checkout validates plan and email', async () => {
  await assert.rejects(stripeService.createCheckoutSession({ plan: 'x', email: 'a@b.hu' }, { env: devEnv }), (e) => e.status === 400);
  await assert.rejects(stripeService.createCheckoutSession({ plan: 'daily', email: 'nem-email' }, { env: devEnv }), (e) => e.status === 400);
});

test('live checkout sends HUF minor units and metadata to Stripe', async () => {
  let params;
  const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_live_1', url: 'https://stripe/x' }; } } } };
  const result = await stripeService.createCheckoutSession(
    { plan: 'weekly', email: 'a@b.hu', generationId: 'g1' },
    { env: { ...devEnv, STRIPE_SECRET_KEY: 'sk_test' }, client }
  );
  assert.equal(result.url, 'https://stripe/x');
  assert.equal(params.line_items[0].price_data.unit_amount, 89000);
  assert.equal(params.line_items[0].price_data.currency, 'huf');
  assert.equal(params.metadata.plan, 'weekly');
});

test('invoice XML escapes input and splits VAT', () => {
  const xml = invoiceService.buildInvoiceXml(
    { plan: 'daily', orderId: 'cs_1', customer: { name: 'A & <B>', email: 'a@b.hu', zip: '1111', city: 'Bp', address: 'Fő u. 1' } },
    { SZAMLAZZ_KEY: 'key', SZAMLAZZ_AFA: '27' }
  );
  assert.match(xml, /A &amp; &lt;B&gt;/);
  assert.match(xml, /<bruttoErtek>390<\/bruttoErtek>/);
  assert.match(xml, /<nettoErtek>307<\/nettoErtek>/);
});

test('invoice is issued once per Stripe session', async () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')), 's.json');
  const env = { SZAMLAZZ_KEY: 'key', INVOICE_STORE_PATH: store };
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-2025-1']]) }; };
  const order = { orderId: 'cs_1', plan: 'daily', customer: { email: 'a@b.hu' } };
  assert.equal((await invoiceService.issueInvoice(order, { env, fetch })).invoiceNumber, 'E-2025-1');
  assert.equal((await invoiceService.issueInvoice(order, { env, fetch })).duplicate, true);
  assert.equal(calls, 1);
});

test('invoice errors from Számlázz.hu are surfaced', async () => {
  const env = { SZAMLAZZ_KEY: 'key', INVOICE_STORE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inv-')), 's.json') };
  const fetch = async () => ({ ok: true, headers: new Map([['szlahu_error', 'Hib%C3%A1s']]) });
  await assert.rejects(invoiceService.issueInvoice({ orderId: 'x', plan: 'daily', customer: { email: 'a@b.hu' } }, { env, fetch }), /Hibás/);
});

test('webhook rejects calls without valid configuration or signature', async () => {
  const { app } = require('../server');
  const saved = {};
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NODE_ENV']) { saved[key] = process.env[key]; delete process.env[key]; }
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/webhook/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok([400, 503].includes(response.status));
    const mock = await fetch(`http://127.0.0.1:${port}/api/create-checkout-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'weekly', email: 'a@b.hu' })
    });
    assert.equal(mock.status, 200);
    assert.equal((await mock.json()).mock, true);
    const exposed = await fetch(`http://127.0.0.1:${port}/server.js`);
    assert.equal(exposed.status, 404);
    const env = await fetch(`http://127.0.0.1:${port}/.env`);
    assert.equal(env.status, 404);
  } finally {
    server.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

async function loadLockedApp(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'), {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.APP_CONFIG = { paywallEnabled: true, apiBaseUrl: 'same-origin' };
    }
  });
  t.after(() => dom.window.close());
  dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
  return dom.window;
}

test('paywall shows a teaser with the unlock button and blocks exports until unlocked', async (t) => {
  const window = await loadLockedApp(t);
  window.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'g1' });
  const document = window.document;
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 2);
  assert.match(document.getElementById('unlockBtn').textContent, /390 Ft/);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, true);

  window.unlockGeneration('g1');
  window.renderResultDocument(window.lastResult);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  assert.equal(document.getElementById('unlockBtn'), null);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
});

test('footer shows the operator and legal links open modals', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  assert.match(document.getElementById('siteFooter').textContent, /CSB-Villamosság Kft\./);
  document.querySelector('[data-legal="terms"]').click();
  assert.ok(document.getElementById('legalModal').classList.contains('open'));
});

test('sk_test key runs live checkout in test mode with return URLs', async () => {
  let params;
  const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_test_1', url: 'https://stripe/t' }; } } } };
  const result = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { ...devEnv, STRIPE_SECRET_KEY: 'sk_test_x' }, client });
  assert.equal(result.testMode, true);
  assert.equal(result.mock, false);
  assert.equal(params.success_url, 'https://ovitervezo.hu/?checkout_session={CHECKOUT_SESSION_ID}');
});

test('Számlázz.hu sandbox creates a proforma instead of a final invoice', () => {
  const order = { plan: 'daily', orderId: 'cs_1', customer: { email: 'a@b.hu' } };
  const sandbox = invoiceService.buildInvoiceXml(order, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_SANDBOX: 'true' });
  assert.match(sandbox, /<dijbekero>true<\/dijbekero>/);
  assert.match(sandbox, /<fizetve>false<\/fizetve>/);
  const live = invoiceService.buildInvoiceXml(order, { SZAMLAZZ_KEY: 'k' });
  assert.match(live, /<dijbekero>false<\/dijbekero>/);
});

test('footer and legal modals use the real company data without placeholders', async (t) => {
  const window = await loadLockedApp(t);
  const footer = window.document.getElementById('siteFooter').textContent;
  assert.match(footer, /27891788-2-08/);
  assert.match(footer, /08 09 031727/);
  assert.match(footer, /Öttevény/);
  assert.doesNotMatch(window.document.body.innerHTML, /kitöltendő/);
  window.document.querySelector('[data-legal="privacy"]').click();
  assert.match(window.document.getElementById('legalModalBody').textContent, /Stripe/);
});

test('invoice carries software line items, ovitervezo.hu note and sends an e-invoice', () => {
  const base = { orderId: 'x', customer: { email: 'a@b.hu' } };
  const env = { SZAMLAZZ_KEY: 'k' };
  const daily = invoiceService.buildInvoiceXml({ ...base, plan: 'daily' }, env);
  const weekly = invoiceService.buildInvoiceXml({ ...base, plan: 'weekly' }, env);
  assert.match(daily, /<megnevezes>OviTervező – Online szoftverhasználati díj \(1 alkalom\)<\/megnevezes>/);
  assert.match(weekly, /<megnevezes>OviTervező – Heti tervező szoftverelérés<\/megnevezes>/);
  assert.doesNotMatch(daily, /pedagógiai/);
  assert.match(daily, /<megjegyzes>Szolgáltató weboldal: https:\/\/ovitervezo\.hu \| Ügyfélszolgálat: info@ovitervezo\.hu \| Köszönjük a vásárlást!<\/megjegyzes>/);
  assert.match(daily, /<eszamla>true<\/eszamla>/);
  assert.match(daily, /<sendEmail>true<\/sendEmail>/);
  assert.match(daily, /<dijbekero>false<\/dijbekero>/);
});

test('signed checkout.session.completed webhook issues the invoice with the new line item', async () => {
  const Stripe = require('stripe');
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')), 's.json');
  const saved = {};
  const set = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SZAMLAZZ_KEY: 'k', INVOICE_STORE_PATH: store, SZAMLAZZ_SANDBOX: 'false' };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  const realFetch = global.fetch;
  let sentXml = '';
  const { app } = require('../server');
  const server = app.listen(0);
  const port = server.address().port;
  global.fetch = async (url, options) => {
    if (String(url).includes('szamlazz.hu')) {
      sentXml = await options.body.get('action-xmlagentxmlfile').text();
      return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-1']]) };
    }
    return realFetch(url, options);
  };
  try {
    const payload = JSON.stringify({
      id: 'evt_1', object: 'event', type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_wh', payment_status: 'paid', metadata: { plan: 'daily' }, customer_details: { name: 'Teszt', email: 'vevo@example.com', address: { postal_code: '1111', city: 'Bp', line1: 'Fő u. 1' } } } }
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    const response = await realFetch(`http://127.0.0.1:${port}/api/webhook/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
    assert.equal(response.status, 200);
    assert.match(sentXml, /Online szoftverhasználati díj/);
    assert.match(sentXml, /<email>vevo@example\.com<\/email>/);
  } finally {
    global.fetch = realFetch;
    server.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
