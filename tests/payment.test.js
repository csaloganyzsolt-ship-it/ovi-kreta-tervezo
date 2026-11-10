const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const { makePayload, makePlan, readPage } = require('./fixtures');

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
    { plan: 'weekly_detailed', email: 'a@b.hu', generationId: 'g1' },
    { env: { ...devEnv, STRIPE_SECRET_KEY: 'sk_test' }, client }
  );
  assert.equal(result.url, 'https://stripe/x');
  assert.equal(params.line_items[0].price_data.unit_amount, 89000);
  assert.equal(params.line_items[0].price_data.currency, 'huf');
  assert.equal(params.metadata.plan, 'weekly_detailed');
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
  const fetch = async () => { calls += 1; return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-2025-1']]), arrayBuffer: async () => Buffer.from('%PDF-1.4 test') }; };
  const order = { orderId: 'cs_test_1', plan: 'daily', customer: { email: 'a@b.hu' } };
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
  const dom = new JSDOM(readPage('tervezo.html'), {
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
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 0);
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

test('Számlázz.hu sandbox flag still produces a regular e-invoice, not a proforma', () => {
  const order = { plan: 'daily', orderId: 'cs_1', customer: { email: 'a@b.hu' } };
  const sandbox = invoiceService.buildInvoiceXml(order, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_SANDBOX: 'true' });
  assert.match(sandbox, /<dijbekero>false<\/dijbekero>/);
  assert.match(sandbox, /<eszamla>true<\/eszamla>/);
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
  const expected = {
    terms: [/Nethely Kft\./, /Győri Törvényszék Cégbírósága/, /kellékszavatossági/, /nem váltják ki a pedagógus szakmai felelősségét/, /nincs|nem terheli meg/i, /bekelteto\.testulet@gymsmkik\.hu/],
    privacy: [/Render Services/, /Google Ireland/, /GYERMEKEK SZEMÉLYES ADATAIT/, /Stripe Payments Europe/, /NAIH/, /8 évig/],
    billing: [/nincs havidíj/, /KBOSS\.hu Kft\./, /PCI-DSS/]
  };
  for (const [key, patterns] of Object.entries(expected)) {
    window.document.querySelector(`[data-legal="${key}"]`).click();
    const body = window.document.getElementById('legalModalBody').textContent;
    for (const p of patterns) assert.match(body, p, `${key}: ${p}`);
  }
});

test('invoice carries software line items, ovitervezo.hu note and sends an e-invoice', () => {
  const base = { orderId: 'x', customer: { email: 'a@b.hu' } };
  const env = { SZAMLAZZ_KEY: 'k' };
  const daily = invoiceService.buildInvoiceXml({ ...base, plan: 'daily' }, env);
  const weekly = invoiceService.buildInvoiceXml({ ...base, plan: 'weekly' }, env);
  assert.match(daily, /<megnevezes>OviTervező – Online szoftverhasználati díj \(1 alkalom\)<\/megnevezes>/);
  assert.match(weekly, /<megnevezes>OviTervező – Online szoftverhasználati díj – heti alapcsomag<\/megnevezes>/);
  assert.doesNotMatch(daily, /pedagógiai/);
  assert.match(daily, /<megjegyzes>Szolgáltató weboldal: https:\/\/ovitervezo\.hu \| Ügyfélszolgálat: info@csb-vill\.com \| Köszönjük a vásárlást!<\/megjegyzes>/);
  assert.match(daily, /<eszamla>true<\/eszamla>/);
  assert.match(daily, /<sendEmail>false<\/sendEmail>/);
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
      return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-1']]), arrayBuffer: async () => Buffer.from('%PDF-1.4 test') };
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

test('SUPPORT_EMAIL drives the invoice note and reply address, with a working fallback', () => {
  const order = { plan: 'daily', orderId: 'x', customer: { email: 'a@b.hu' } };
  const custom = invoiceService.buildInvoiceXml(order, { SZAMLAZZ_KEY: 'k', SUPPORT_EMAIL: 'segitseg@ovitervezo.hu' });
  assert.match(custom, /Ügyfélszolgálat: segitseg@ovitervezo\.hu/);
  assert.match(custom, /<emailReplyto>segitseg@ovitervezo\.hu<\/emailReplyto>/);
  assert.equal(invoiceService.supportEmail({}), 'info@csb-vill.com');
});

test('Stripe checkout names match the invoice software line items', async () => {
  let params;
  const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_test_n', url: 'u' }; } } } };
  const env = { ...devEnv, STRIPE_SECRET_KEY: 'sk_test_x' };
  await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env, client });
  assert.equal(params.line_items[0].price_data.product_data.name, 'OviTervező – Online szoftverhasználati díj (1 alkalom)');
  await stripeService.createCheckoutSession({ plan: 'weekly', email: 'a@b.hu' }, { env, client });
  assert.equal(params.line_items[0].price_data.product_data.name, 'OviTervező – Online szoftverhasználati díj – heti alapcsomag');
  assert.equal(params.line_items[0].price_data.unit_amount, 39000);
  await stripeService.createCheckoutSession({ plan: 'weekly_detailed', email: 'a@b.hu' }, { env, client });
  assert.equal(params.line_items[0].price_data.product_data.name, 'OviTervező – Online szoftverhasználati díj – heti részletes csomag');
  assert.equal(params.line_items[0].price_data.unit_amount, 89000);
  assert.doesNotMatch(JSON.stringify(params), /pedagógiai/);
});

test('checkout return URLs follow FRONTEND_URL, falling back to BASE_URL', async () => {
  let params;
  const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_test_u', url: 'u' }; } } } };
  const env = { STRIPE_SECRET_KEY: 'sk_test_x', BASE_URL: 'https://ovitervezo.hu', FRONTEND_URL: 'https://pages.example/ovi/' };
  await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env, client });
  assert.equal(params.success_url, 'https://pages.example/ovi/?checkout_session={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://pages.example/ovi/?checkout=cancelled');
  const mock = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { FRONTEND_URL: 'http://localhost:4000' } });
  assert.match(mock.url, /^http:\/\/localhost:4000\/\?checkout_session=cs_mock_/);
});

test('invoice request disables Számlázz.hu mailing and asks for the PDF; the PDF is kept per session', async () => {
  const xml = invoiceService.buildInvoiceXml({ plan: 'daily', orderId: 'cs_test_9', customer: { email: 'a@b.hu' } }, { SZAMLAZZ_KEY: 'k' });
  assert.match(xml, /<szamlaLetoltes>true<\/szamlaLetoltes>/);
  assert.match(xml, /<sendEmail>false<\/sendEmail>/);
  const env = { SZAMLAZZ_KEY: 'k', INVOICE_STORE_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 's.json') };
  const fetch = async () => ({ ok: true, headers: new Map([['szlahu_szamlaszam', 'E-7']]), arrayBuffer: async () => Buffer.from('%PDF-1.4 invoice') });
  await invoiceService.issueInvoice({ orderId: 'cs_test_9', plan: 'daily', customer: { email: 'a@b.hu' } }, { env, fetch });
  assert.match(invoiceService.getInvoicePdf('cs_test_9', env).toString(), /^%PDF/);
  assert.equal(invoiceService.getInvoicePdf('cs_test_other', env), null);
});

test('one combined purchase email carries the plan files and the invoice PDF', async () => {
  const mailService = require('../services/mailService');
  let message;
  const transport = { sendMail: async (m) => { message = m; return { messageId: 'x' }; } };
  const attachments = mailService.sanitizeAttachments([
    { name: 'Napi.pdf', base64: Buffer.from('%PDF').toString('base64') },
    { name: '../evil/Napi.docx', base64: Buffer.from('PK').toString('base64') }
  ]);
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', attachments, invoicePdf: Buffer.from('%PDF-inv') }, { env: { SUPPORT_EMAIL: 's@x.hu' }, transport });
  assert.equal(message.to, 'vevo@example.com');
  assert.equal(message.replyTo, 's@x.hu');
  assert.deepEqual(message.attachments.map((a) => a.filename), ['Napi.pdf', 'Napi.docx', 'szamla.pdf', 'ovitervezo-logo.png']);
  assert.throws(() => mailService.sanitizeAttachments([{ name: 'x.exe', base64: 'AAAA' }]), /melléklettípus/);
  assert.equal(mailService.isConfigured({}), false);
  assert.equal(mailService.isConfigured({ SMTP_HOST: 'smtp.x' }), true);
});

test('activities toggle is locked before payment and opens only for the paid plan', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  const box = document.querySelector('[data-export-section="activities"]');
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  assert.equal(document.getElementById('activitiesLockNote').hidden, false);

  window.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'g1' });
  assert.equal(box.disabled, true);
  assert.equal(document.getElementById('downloadInvoiceBtn').hidden, true);

  window.unlockGeneration('g1', 'cs_test_paid1');
  window.renderResultDocument(window.lastResult);
  assert.equal(box.disabled, false);
  assert.equal(box.checked, true);
  assert.equal(document.getElementById('activitiesLockNote').hidden, true);
  assert.equal(document.getElementById('downloadInvoiceBtn').hidden, false);
});

test('editing a field keeps the paid plan unlocked and only brings back the generate button', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'g2' });
  window.unlockGeneration('g2', 'cs_test_paid2');
  window.renderResultDocument(window.lastResult);
  assert.equal(document.getElementById('nextBtn').hidden, true);

  const topic = document.querySelector('input[data-field="group-name"]');
  topic.value = `${topic.value}módosítva`;
  topic.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(window.isPlanLocked(), false);
  assert.equal(document.getElementById('nextBtn').hidden, false);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
});

test('navigating between steps never relocks a paid plan', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'gn1' });
  window.unlockGeneration('gn1', 'cs_test_gn1');
  window.renderResultDocument(window.lastResult);
  for (const step of ['0', '1', '2', '3']) document.querySelector(`.wizard-item[data-step="${step}"]`).click();
  assert.equal(window.isPlanLocked(), false);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
  assert.equal(document.getElementById('nextBtn').hidden, true);
});

test('preview container stays hidden until a plan exists and on steps 1-3', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  const panel = document.getElementById('previewPanel');
  assert.equal(panel.hidden, true);
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'gv1' });
  document.querySelector('.wizard-item[data-step="1"]').click();
  assert.equal(panel.hidden, true);
});

test('unrelated export settings do not revoke the unlock', async (t) => {
  const window = await loadLockedApp(t);
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'g3' });
  window.unlockGeneration('g3', 'cs_test_paid3');
  window.renderResultDocument(window.lastResult);
  const margin = window.document.querySelector('[data-export="margin"]');
  margin.value = 'compact';
  margin.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.isPlanLocked(), false);
});

test('locked preview renders no activity section at all and shows the unlock notice', async (t) => {
  const window = await loadLockedApp(t);
  const plan = makePlan(8);
  const secret = 'RÉSZLETES-FOGLALKOZÁSMENET';
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [secret];
  plan.kidolgozas_tablazat[0].modszerek_megjegyzesek = 'TITKOS-MODSZER';
  window.renderResultDocument({ ...plan, request: makePayload(), generationId: 'g9' });
  const host = window.document.getElementById('resultDocument');
  assert.equal(host.querySelectorAll('.official-table tbody tr').length, 0);
  assert.ok(!host.textContent.includes(secret));
  assert.doesNotMatch(host.textContent, /TITKOS-MODSZER/);
  assert.match(host.textContent, /A részletes tevékenységmenet kidolgozása és a Kréta-letöltés a terv feloldása után érhető el\./);

  window.unlockGeneration('g9', 'cs_test_g9');
  window.renderResultDocument(window.lastResult);
  const full = window.document.getElementById('resultDocument').textContent;
  assert.ok(full.includes(secret));
  assert.match(full, /TITKOS-MODSZER/);
});

test('plan kinds map to the three price tiers', async (t) => {
  const window = await loadLockedApp(t);
  assert.equal(window.planKind({ request: { duration: 'Napi' } }), 'daily');
  assert.equal(window.planKind({ request: { duration: 'Heti', includeDailyBreakdown: false } }), 'weekly');
  assert.equal(window.planKind({ is_weekly: true, request: { duration: 'Heti', includeDailyBreakdown: true } }), 'weekly_detailed');
  const price = (result) => { window.renderResultDocument({ ...makePlan(8), ...result, generationId: 'gp' + Math.random() }); return window.document.getElementById('unlockBtn').textContent; };
  assert.match(price({ request: { ...makePayload(), duration: 'Napi' } }), /390 Ft/);
  assert.match(price({ request: { ...makePayload(), duration: 'Heti' } }), /390 Ft/);
});

test('unlock buttons appear in all places while locked and give way to the Feloldva badge', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  const ids = ['unlockNavBtn', 'unlockTopBtn', 'unlockBottomBtn', 'unlockBtn'];
  assert.ok(ids.every((id) => !document.getElementById(id) || document.getElementById(id).hidden));
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'g10' });
  for (const id of ids) {
    const button = document.getElementById(id);
    assert.ok(button && !button.hidden, id);
    assert.match(button.textContent, /390 Ft/);
  }
  document.getElementById('unlockTopBtn').click();
  assert.ok(document.getElementById('checkoutModal').classList.contains('open'));
  window.unlockGeneration('g10', 'cs_test_g10');
  window.renderResultDocument(window.lastResult);
  for (const id of ['unlockNavBtn', 'unlockTopBtn', 'unlockBottomBtn']) assert.equal(document.getElementById(id).hidden, true);
  assert.equal(document.getElementById('unlockBtn'), null);
  assert.equal(document.getElementById('unlockedBadge').hidden, false);
});

test('generation disables the button, shows progress text, scrolls to the loader and restores afterwards', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  let scrolled = null;
  document.getElementById('generationLoader').scrollIntoView = function scroll() { scrolled = this.id; };
  let release;
  window.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: false, status: 500, text: async () => '{"success":false,"error":"x"}', json: async () => ({ success: false, error: 'x' }) }); });
  const pending = window.generatePlan();
  const button = document.getElementById('nextBtn');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /Tervezet generálása folyamatban/);
  assert.equal(scrolled, 'generationLoader');
  release();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Tervezet elkészítése');
});

test('invoice prefix defaults to OVITE, comes from SZAMLAZZ_PREFIX and can be disabled with an empty value', () => {
  const base = { orderId: 'x', plan: 'daily', customer: { email: 'a@b.hu' } };
  assert.match(invoiceService.buildInvoiceXml(base, { SZAMLAZZ_KEY: 'k' }), /<szamlaszamElotag>OVITE<\/szamlaszamElotag>/);
  assert.match(invoiceService.buildInvoiceXml(base, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_PREFIX: 'ABC' }), /<szamlaszamElotag>ABC<\/szamlaszamElotag>/);
  assert.match(invoiceService.buildInvoiceXml(base, { SZAMLAZZ_KEY: 'k', SZAMLA_PREFIX: 'OLD' }), /<szamlaszamElotag>OLD<\/szamlaszamElotag>/);
  assert.doesNotMatch(invoiceService.buildInvoiceXml(base, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_PREFIX: '' }), /szamlaszamElotag/);
});

test('invoice shows a short friendly order number instead of the Stripe session id', () => {
  const sessionId = 'cs_live_a1oHW2xOQfzz8abc7TTU12';
  const created = Date.UTC(2026, 10, 8, 12) / 1000;
  assert.equal(invoiceService.orderNumber(sessionId, created), 'OVI-261108-7TTU12');
  const xml = invoiceService.buildInvoiceXml({ orderId: sessionId, created, plan: 'daily', customer: { email: 'a@b.hu' } }, { SZAMLAZZ_KEY: 'k' });
  assert.match(xml, /<rendelesSzam>OVI-261108-7TTU12<\/rendelesSzam>/);
  assert.doesNotMatch(xml, /cs_live_/);
  const { buildEmailContent } = require('../services/mailService');
  const mail = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, test: false, orderNumber: 'OVI-261108-7TTU12' }, {});
  assert.match(mail.html, /OVI-261108-7TTU12/);
  assert.match(mail.text, /Rendelésszám: OVI-261108-7TTU12/);
});

test('unlock buttons are hidden on steps 1-3 and shown only on step 4 after generation', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'gs1' });
  const ids = ['unlockNavBtn', 'unlockTopBtn', 'unlockBottomBtn'];
  assert.ok(ids.every((id) => !document.getElementById(id).hidden));
  document.querySelector('.wizard-item[data-step="1"]').click();
  assert.ok(ids.every((id) => document.getElementById(id).hidden));
  document.querySelector('.wizard-item[data-step="3"]').click();
  assert.ok(ids.every((id) => !document.getElementById(id).hidden));
});

test('generate button hides after payment, returns on edit, and regeneration needs confirmation', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  const next = document.getElementById('nextBtn');
  let generated = 0;
  window.fetch = async () => { generated += 1; return { ok: false, status: 500, text: async () => '{}', json: async () => ({}) }; };
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'gc1' });
  assert.equal(next.hidden, false);
  window.unlockGeneration('gc1', 'cs_test_gc1');
  window.renderResultDocument(window.lastResult);
  assert.equal(next.hidden, true);

  const field = document.querySelector('input[data-field="group-name"]');
  field.value = `${field.value}x`;
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(next.hidden, false);
  assert.equal(window.isPlanLocked(), false);

  next.click();
  assert.ok(document.getElementById('confirmRegenModal').classList.contains('open'));
  assert.match(document.getElementById('confirmRegenModal').textContent, /felülírásra kerül/);
  assert.equal(generated, 0);
  document.getElementById('confirmRegenNo').click();
  assert.ok(!document.getElementById('confirmRegenModal').classList.contains('open'));
  assert.equal(generated, 0);
  next.click();
  document.getElementById('confirmRegenYes').click();
  assert.equal(generated, 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('footer has three organised columns and checkout modal has the new title', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  assert.equal(document.querySelectorAll('#siteFooter .footer-col').length, 3);
  assert.equal(document.getElementById('checkoutTitle').textContent, 'Teljes tervezet és Kréta-letöltés feloldása');
});

test('CORS allows ovitervezo.hu, www and localhost but rejects other origins', () => {
  const { corsOrigin } = require('../server');
  const check = (origin, env = {}) => { let allowed; corsOrigin(origin, (_e, ok) => { allowed = ok; }, env); return allowed; };
  assert.equal(check('https://ovitervezo.hu'), true);
  assert.equal(check('https://www.ovitervezo.hu'), true);
  assert.equal(check('http://localhost:4000'), true);
  assert.equal(check(undefined), true);
  assert.equal(check('https://evil.example'), false);
  assert.equal(check('https://staging.example', { CORS_ORIGINS: 'https://staging.example/' }), true);
});

test('Nethely build contains only static files and points to the Render API', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  execFileSync('node', ['scripts/build-nethely.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, API_BASE_URL: 'https://api.example.onrender.com' } });
  const dir = path.join(__dirname, '..', 'dist-nethely');
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['.htaccess', 'assets', 'config.js', 'favicon.ico', 'favicon.svg', 'index.html', 'logo.svg', 'robots.txt', 'site.js', 'sitemap.xml', 'styles.css', 'tervezo.html']);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'og-preview.png')));
  const config = fs.readFileSync(path.join(dir, 'config.js'), 'utf8');
  assert.match(config, /"apiBaseUrl": "https:\/\/api\.example\.onrender\.com"/);
  assert.doesNotMatch(config, /sk_|whsec_|GEMINI/);
});

test('Nethely .htaccess does not redirect when the proxy already forwards HTTPS', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const htaccess = fs.readFileSync(path.join(__dirname, '..', 'dist-nethely', '.htaccess'), 'utf8');
  assert.match(htaccess, /RewriteCond %\{HTTP:X-Forwarded-Proto\} !https/);
  assert.match(htaccess, /RewriteRule \^\(\.\*\)\$ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[L,R=301\]/);
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('test delivery endpoint is off by default, origin-bound, rate limited and sends without Stripe', async () => {
  const payment = require('../routes/payment');
  const mailService = require('../services/mailService');
  const original = { send: mailService.sendTestDeliveryEmail, enabled: process.env.TEST_DELIVERY_ENABLED, host: process.env.SMTP_HOST };
  const sent = [];
  mailService.sendTestDeliveryEmail = async (args) => { sent.push(args); return {}; };
  const pdf = { name: 'a.pdf', base64: Buffer.from('x').toString('base64') };
  const req = (origin, body = { email: 'a@b.hu', files: [pdf], plan: 'daily' }) => ({ headers: { origin }, ip: `ip-${Math.random()}`, body });
  try {
    delete process.env.TEST_DELIVERY_ENABLED;
    process.env.SMTP_HOST = 'smtp.example';
    let res = fakeRes();
    await payment.testDeliver(req('https://csaloganyzsolt-ship-it.github.io'), res);
    assert.equal(res.statusCode, 403);

    process.env.TEST_DELIVERY_ENABLED = 'true';
    res = fakeRes();
    await payment.testDeliver(req('https://ovitervezo.hu'), res);
    assert.equal(res.statusCode, 403);

    res = fakeRes();
    await payment.testDeliver(req('https://csaloganyzsolt-ship-it.github.io'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'a@b.hu');

    res = fakeRes();
    await payment.testDeliver(req('https://csaloganyzsolt-ship-it.github.io', { email: 'bad', files: [pdf] }), res);
    assert.equal(res.statusCode, 400);

    const same = req('https://csaloganyzsolt-ship-it.github.io');
    let last;
    for (let i = 0; i < 11; i += 1) { last = fakeRes(); await payment.testDeliver({ ...same }, last); }
    assert.equal(last.statusCode, 429);
  } finally {
    mailService.sendTestDeliveryEmail = original.send;
    if (original.enabled === undefined) delete process.env.TEST_DELIVERY_ENABLED; else process.env.TEST_DELIVERY_ENABLED = original.enabled;
    if (original.host === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = original.host;
  }
});

test('staging build has no paywall and shows the test delivery row; production keeps the paywall', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const cwd = path.join(__dirname, '..');
  execFileSync('node', ['scripts/build-pages.js'], { cwd });
  const staging = fs.readFileSync(path.join(cwd, 'dist-pages', 'config.js'), 'utf8');
  assert.match(staging, /"paywallEnabled": false/);
  assert.match(staging, /"testDelivery": true/);
  assert.match(fs.readFileSync(path.join(cwd, 'dist-pages', 'robots.txt'), 'utf8'), /Disallow: \//);
  execFileSync('node', ['scripts/build-nethely.js'], { cwd });
  assert.match(fs.readFileSync(path.join(cwd, 'dist-nethely', 'config.js'), 'utf8'), /"paywallEnabled": true/);
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'dist-nethely', 'config.js'), 'utf8'), /testDelivery/);
});

test('test delivery row appears only in the staging config after generation', async (t) => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const path = require('node:path');
  const html = readPage('tervezo.html');
  const load = async (config) => {
    const dom = new JSDOM(html, { url: 'http://localhost:8000/', pretendToBeVisual: true, runScripts: 'dangerously',
      beforeParse(window) { window.HTMLElement.prototype.scrollIntoView = () => {}; window.scrollTo = () => {}; window.APP_CONFIG = config; } });
    t.after(() => dom.window.close());
    dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
    return dom.window;
  };
  const staging = await load({ paywallEnabled: false, testDelivery: true, apiBaseUrl: 'same-origin' });
  assert.equal(staging.document.getElementById('testDeliverRow').hidden, true);
  staging.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'st1' });
  staging.document.querySelector('.wizard-item[data-step="3"]').click();
  assert.equal(staging.document.getElementById('testDeliverRow').hidden, false);
  assert.equal(staging.isPlanLocked(), false);
  const prod = await load({ paywallEnabled: true, apiBaseUrl: 'same-origin' });
  prod.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'pr1' });
  prod.document.querySelector('.wizard-item[data-step="3"]').click();
  assert.equal(prod.document.getElementById('testDeliverRow').hidden, true);
});

test('mail template is warm, lists attachments and carries the legal footer', () => {
  const { buildEmailContent } = require('../services/mailService');
  const daily = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, test: false }, {});
  assert.match(daily.html, /Kedves Kolléganő!/);
  assert.doesNotMatch(daily.html, /🌱|📚|✨|💚|🌿/);
  assert.match(daily.html, /Új tervezet készítése/);
  assert.match(daily.html, /szabadon szerkeszthető/);
  assert.match(daily.html, /válaszoljon közvetlenül erre a levélre/);
  assert.doesNotMatch(daily.html, /Tervezet témája/);
  const titled = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: false, test: false, title: 'Az <őszi> erdő' }, {});
  assert.match(titled.html, /Tervezet témája:<\/strong> Az &lt;őszi&gt; erdő/);
  assert.match(titled.text, /Tervezet témája: Az <őszi> erdő/);
  assert.match(daily.html, /\.docx/);
  assert.match(daily.html, /PDF/);
  assert.match(daily.html, /27891788-2-08/);
  assert.match(daily.html, /automatikus rendszerüzenet/);
  assert.match(daily.text, /Adatkezelési tájékoztató és ÁSZF/);
  const test = buildEmailContent({ planLabel: 'heti csomag', withInvoice: false, test: true }, {});
  assert.match(test.html, /teszt/);
  assert.doesNotMatch(test.html, /E-számla/);
});

test('sheets webhook payload has all purchase fields and failures never throw', async () => {
  const sheets = require('../services/sheetsService');
  const session = { id: 'cs_live_a1oHW2xOQfzz8abc7TTU12', created: Date.UTC(2026, 10, 10, 8) / 1000, metadata: { plan: 'weekly_detailed', title: 'Őszi erdő' } };
  const customer = { name: 'Teszt Elek', email: 'a@b.hu', zip: '9153', city: 'Öttevény', address: 'Arany J. u. 10.' };
  const payload = sheets.buildPayload({ session, invoiceNumber: 'OVITE-2026-1', customer }, new Date(Date.UTC(2026, 10, 10, 8, 5)));
  assert.deepEqual(payload, {
    datum: '2026-11-10 09:05', rendelesszam: 'OVI-261110-7TTU12', szamlaszam: 'OVITE-2026-1', vevo_neve: 'Teszt Elek', vevo_email: 'a@b.hu',
    szamlazasi_cim: '9153, Öttevény, Arany J. u. 10.', csomag: 'Heti csomag', tervezet_temaja: 'Őszi erdő', fizetett_osszeg_huf: 890, stripe_session_id: session.id
  });
  assert.equal(payload.invoice_pdf_base64, undefined);
  const withPdf = sheets.buildPayload({ session, invoiceNumber: 'OVITE-2026-1', customer, invoicePdf: Buffer.from('%PDF-test') }, new Date(), {});
  assert.equal(withPdf.invoice_pdf_base64, Buffer.from('%PDF-test').toString('base64'));
  assert.equal(withPdf.invoice_pdf_filename, 'OVI-261110-7TTU12 - Teszt Elek - OVITE-2026-1.pdf');
  assert.equal(withPdf.drive_folder_id, '1rubYmBzc-gDt2GkMcMqM7syDAfe4-PT7');
  assert.equal(sheets.buildPayload({ session, customer: { name: 'A/B:C' }, invoicePdf: Buffer.from('x') }, new Date(), { GOOGLE_DRIVE_FOLDER_ID: 'zzz' }).drive_folder_id, 'zzz');
  assert.deepEqual(await sheets.recordPurchase({ session, customer }, { env: {} }), { sent: false, reason: 'not_configured' });
  const env = { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/x/exec' };
  const calls = [];
  const ok = await sheets.recordPurchase({ session, customer }, { env, fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; } });
  assert.equal(ok.sent, true);
  assert.equal(calls[0].body.rendelesszam, 'OVI-261110-7TTU12');
  const down = await sheets.recordPurchase({ session, customer }, { env, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.sent, false);
  const bad = await sheets.recordPurchase({ session, customer }, { env, fetch: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.sent, false);
});

test('purchase e-mail is copied (BCC) to the admin address with all attachments when configured', async () => {
  const mailService = require('../services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  const args = { to: 'v@b.hu', plan: 'daily', attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }], invoicePdf: Buffer.from('%PDF') };
  await mailService.sendPurchaseEmail(args, { transport, env: { ADMIN_NOTIFICATION_EMAIL: 'admin@ovitervezo.hu' } });
  await mailService.sendPurchaseEmail(args, { transport, env: {} });
  assert.equal(sent[0].bcc, 'admin@ovitervezo.hu');
  assert.equal(sent[0].attachments.length, 3);
  assert.equal(sent[1].bcc, undefined);
});

test('index.html is a pure landing page and tervezo.html is the planner only', () => {
  const landing = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const planner = fs.readFileSync(path.join(__dirname, '..', 'tervezo.html'), 'utf8');
  for (const text of ['Tervező indítása', 'Kezdjük a tervezést', '390 Ft', '890 Ft', '1. Csoport adatai', '2. Átgondolt vázlat', '3. Letöltés és másolás', 'Nem merev sablon', '100% szerkeszthető Word', 'Kréta OVI kompatibilis', 'id="seoContent"', 'id="siteFooter"']) assert.ok(landing.includes(text), text);
  assert.equal((landing.match(/href="tervezo\.html"/g) || []).length >= 2, true);
  for (const absent of ['id="wizardList"', 'id="generateBtn"', 'id="previewPanel"', 'id="checkoutModal"', 'html2pdf']) assert.ok(!landing.includes(absent), `landing: ${absent}`);
  for (const text of ['id="wizardList"', 'id="previewPanel"', 'id="checkoutModal"', 'id="siteFooter"', 'href="index.html"']) assert.ok(planner.includes(text), `planner: ${text}`);
  for (const absent of ['id="landing"', 'id="seoContent"', 'landing-hero', 'Egyszeri díj, havidíj nélkül', 'application/ld+json']) assert.ok(!planner.includes(absent), `planner: ${absent}`);
  assert.match(landing, /<a class="brand" href="index\.html"/);
  assert.match(planner, /<a class="brand" href="index\.html"/);
  assert.match(landing, /<meta name="description" content="[^"]*ONAP/);
  assert.match(landing, /policies\.google\.com\/privacy/);
  assert.match(landing, /policies\.google\.com\/terms/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8'), /\.grecaptcha-badge \{ visibility: hidden !important; \}/);
  for (const kw of ['óvodai tervezet készítés', 'óvodai tervezet minta', 'foglalkozásterv minta', 'heti tervezet óvoda', 'ONAP tervezet', 'Milyen óvodai tervezet készíthető', 'leggyorsabb óvodai tervezet készítő']) assert.ok(landing.includes(kw), kw);
  const types = [...landing.matchAll(/"@type":"(FAQPage|SoftwareApplication)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, ['FAQPage', 'SoftwareApplication']);
});

test('landing page footer and legal modal work and the footer is filled from the config', async (t) => {
  const dom = new JSDOM(readPage('index.html'), { url: 'http://localhost:8000/', runScripts: 'dangerously',
    beforeParse(window) { window.APP_CONFIG = { company: { taxId: '11111111-1-11' } }; } });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(document.getElementById('siteFooter').textContent, /11111111-1-11/);
  document.querySelector('[data-legal="terms"]').click();
  assert.ok(document.getElementById('legalModal').classList.contains('open'));
  document.getElementById('themeToggle').click();
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('both builds ship both pages with every local reference resolvable and the Search Console tag on both', () => {
  const { execFileSync } = require('node:child_process');
  const cwd = path.join(__dirname, '..');
  const env = { ...process.env, API_BASE_URL: 'https://api.example.onrender.com', GOOGLE_SITE_VERIFICATION: 'abcDEF1234567890xyz' };
  execFileSync('node', ['scripts/build-nethely.js'], { cwd, env });
  execFileSync('node', ['scripts/build-pages.js'], { cwd, env });
  for (const dir of ['dist-nethely', 'dist-pages']) {
    for (const page of ['index.html', 'tervezo.html']) {
      const html = fs.readFileSync(path.join(cwd, dir, page), 'utf8');
      const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((r) => !/^(https?:|mailto:|data:)/.test(r));
      assert.ok(refs.length > 0);
      for (const ref of refs) {
        assert.ok(!ref.startsWith('/'), `${dir}/${page}: abszolút útvonal ${ref}`);
        assert.ok(fs.existsSync(path.join(cwd, dir, ref.split('?')[0])), `${dir}/${page}: hiányzó fájl ${ref}`);
      }
      assert.doesNotMatch(html, /<!--GOOGLE_SITE_VERIFICATION-->/);
      for (const f of ['styles.css', 'site.js', 'config.js', 'favicon.svg', 'favicon.ico']) assert.match(html, new RegExp(`(?:href|src)="${f.replace('.', '\\.')}\\?v=\\d{12}"`), `${dir}/${page}: ${f} verzió nélkül`);
      assert.doesNotMatch(html, /(?:cdn|stripe)[^"]*\?v=/);
      assert.doesNotMatch(html, /href="(?:index|tervezo)\.html\?v=/);
    }
  }
  for (const page of ['index.html', 'tervezo.html']) {
    assert.match(fs.readFileSync(path.join(cwd, 'dist-nethely', page), 'utf8'), /<meta name="google-site-verification" content="abcDEF1234567890xyz" \/>/);
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'dist-pages', page), 'utf8'), /google-site-verification/);
  }
  const { GOOGLE_SITE_VERIFICATION, ...clean } = env;
  execFileSync('node', ['scripts/build-nethely.js'], { cwd, env: clean });
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'dist-nethely', 'tervezo.html'), 'utf8'), /google-site-verification/);
});

test('landing FAQ questions match the FAQPage JSON-LD and meta follows the SEO brief', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  const app = blocks.find((b) => b['@type'] === 'SoftwareApplication');
  assert.equal(faq.mainEntity.length, 4);
  for (const q of faq.mainEntity) {
    assert.ok(html.includes(`<summary>${q.name}</summary>`), q.name);
    assert.ok(html.includes(q.acceptedAnswer.text), q.name);
  }
  assert.equal(app.name, 'OviTervező');
  assert.equal(app.applicationCategory, 'EducationalApplication');
  assert.equal(app.offers.lowPrice, '390');
  assert.equal(app.offers.highPrice, '890');
  assert.match(html, /<title>Óvodai tervezet készítés gyorsan és egyszerűen \| OviTervező<\/title>/);
  assert.match(html, /name="description" content="Óvodai tervezet készítés az ONAP alapján\. Készíts pedagógiailag átgondolt heti tervezetet és foglalkozásterv mintát percek alatt/);
});

test('both pages use the OT logo and favicon, and both builds ship the icon files', () => {
  const root = path.join(__dirname, '..');
  for (const page of ['index.html', 'tervezo.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="favicon\.svg"/);
    assert.match(html, /class="brand-mark"/);
    assert.match(html, /<span class="brand-text">Ovi<strong>Tervező<\/strong><\/span>/);
    assert.ok(!html.includes('✦'));
  }
  for (const f of ['favicon.svg', 'logo.svg']) assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /^<svg /);
  assert.equal(fs.readFileSync(path.join(root, 'favicon.ico')).readUInt16LE(2), 1);
});

test('purchase and test e-mails embed the OT logo as a CID image in the mint brand header', async () => {
  const mailService = require('../services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { response: 'ok' }; } };
  const base = { to: 'v@b.hu', plan: 'daily', attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }] };
  await mailService.sendPurchaseEmail({ ...base, invoicePdf: Buffer.from('%PDF') }, { env: { SUPPORT_EMAIL: 's@x.hu' }, transport });
  await mailService.sendTestDeliveryEmail(base, { env: { SUPPORT_EMAIL: 's@x.hu' }, transport });
  for (const m of sent) {
    const logo = m.attachments.find((a) => a.cid === 'ovitervezo-logo');
    assert.ok(logo && logo.contentType === 'image/png' && logo.content.subarray(1, 4).toString() === 'PNG');
    assert.match(m.html, /<img src="cid:ovitervezo-logo"/);
    assert.match(m.html, /background:#3fae84/);
    assert.ok(!m.html.includes('#e0885a'));
  }
});

test('GOOGLE_SITE_VERIFICATION is cleaned to the bare token without warnings', () => {
  const { spawnSync } = require('node:child_process');
  const cwd = path.join(__dirname, '..');
  const token = 'abcDEF1234567890abcDEF1234567890abcDEF12345';
  for (const raw of [token, `google-site-verification=${token}`, `"${token}"`, `'${token}'`, `  ${token}\n`, `<meta name="google-site-verification" content="${token}" />`]) {
    const run = spawnSync('node', ['scripts/build-nethely.js'], { cwd, env: { ...process.env, API_BASE_URL: 'https://api.example.onrender.com', GOOGLE_SITE_VERIFICATION: raw }, encoding: 'utf8' });
    assert.equal(run.status, 0, raw);
    assert.ok(!/FIGYELEM/.test(run.stderr + run.stdout), `figyelmeztetés: ${raw}`);
    assert.ok(fs.readFileSync(path.join(cwd, 'dist-nethely', 'index.html'), 'utf8').includes(`<meta name="google-site-verification" content="${token}" />`), raw);
  }
});

test('Nethely .htaccess keeps HTML uncached and versioned assets immutable', () => {
  const ht = fs.readFileSync(path.join(__dirname, '..', 'dist-nethely', '.htaccess'), 'utf8');
  assert.match(ht, /FilesMatch "\\\.html\?\$"[\s\S]*no-cache, no-store, must-revalidate/);
  assert.match(ht, /max-age=31536000, immutable" env=VERSIONED/);
  assert.match(ht, /X-Forwarded-Proto/);
});
