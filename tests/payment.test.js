const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const stripeService = require('../backend/services/stripeService');
const invoiceService = require('../backend/services/invoiceService');
const mailService = require('../backend/services/mailService');
const { makePayload, makePlan, readPage } = require('./fixtures');

const devEnv = { NODE_ENV: 'test', BASE_URL: 'https://ovitervezo.hu' };

test('stripe mock mode answers clearly without keys, only under NODE_ENV=test', async () => {
  const mock = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: devEnv });
  assert.equal(mock.mock, true);
  assert.match(mock.url, /^https:\/\/ovitervezo\.hu\/tervezo\.html\?payment=success&session_id=cs_mock_/);
  await assert.rejects(stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { NODE_ENV: 'production' } }), (error) => error.status === 503);
  await assert.rejects(stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: {} }), (error) => error.status === 503);
  await assert.rejects(stripeService.retrieveCheckoutSession('cs_mock_unknown1', { env: { NODE_ENV: 'production' } }), (error) => error.status === 503);
  await assert.rejects(stripeService.retrieveCheckoutSession('cs_mock_unknown1', { env: devEnv }), (error) => error.status === 404);
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
    { SZAMLAZZ_KEY: 'key', SZAMLAZZ_VAT_RATE: '27' }
  );
  assert.match(xml, /A &amp; &lt;B&gt;/);
  assert.match(xml, /<bruttoErtek>390<\/bruttoErtek>/);
  assert.match(xml, /<nettoErtek>307<\/nettoErtek>/);
});

test('issueInvoice keeps no state: the PDF is only returned in memory and a retry asks Számlázz.hu again', async () => {
  const env = { SZAMLAZZ_KEY: 'key' };
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-2025-1']]), arrayBuffer: async () => Buffer.from('%PDF-1.4 test') }; };
  const order = { orderId: 'cs_test_1', plan: 'daily', customer: { email: 'a@b.hu' } };
  const first = await invoiceService.issueInvoice(order, { env, fetch });
  assert.equal(first.invoiceNumber, 'E-2025-1');
  assert.match(first.pdf.toString(), /^%PDF/);
  assert.equal(calls, 1);
  assert.equal(require('node:fs').existsSync(path.join(__dirname, '..', 'data')), false, 'nem jön létre helyi data/ mappa');
});

test('invoice errors from Számlázz.hu are surfaced', async () => {
  const env = { SZAMLAZZ_KEY: 'key' };
  const fetch = async () => ({ ok: true, headers: new Map([['szlahu_error', 'Hib%C3%A1s']]) });
  await assert.rejects(invoiceService.issueInvoice({ orderId: 'x', plan: 'daily', customer: { email: 'a@b.hu' } }, { env, fetch }), /Hibás/);
});

test('webhook rejects calls without valid configuration or signature', async () => {
  const { app } = require('../backend/server');
  const saved = {};
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) { saved[key] = process.env[key]; delete process.env[key]; }
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

// Generálás után az előnézet kész és látható; csak ekkor jelenhet meg a fizetési felület.
function markPreviewReady(window) {
  window.eval('previewReady = true');
  window.renderPreview();
  window.updateExportLock();
}

test('paywall shows a teaser with the unlock button and blocks exports until unlocked', async (t) => {
  const window = await loadLockedApp(t);
  window.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'g1' });
  markPreviewReady(window);
  const document = window.document;
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  assert.ok(document.querySelector('.locked-mirror-text'));
  assert.match(document.querySelector('.locked-boundary-text').textContent, /1 részletes táblázat és 8 kidolgozott tevékenységi egység vár feloldásra/);
  assert.match(document.getElementById('lockedFloatingText').textContent, /1 részletes táblázat és 8 kidolgozott tevékenységi egység vár feloldásra/);
  assert.match(document.getElementById('unlockBtn').textContent, /390 Ft/);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, true);

  window.unlockGeneration('g1');
  window.renderResultDocument(window.lastResult);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  assert.equal(document.querySelector('.locked-mirror-text'), null);
  assert.equal(document.getElementById('unlockBtn'), null);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
});

test('footer shows the operator and legal links open modals', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  assert.match(document.getElementById('siteFooter').textContent, /Csalogány Zsolt egyéni vállalkozó/);
  document.querySelector('[data-legal="terms"]').click();
  assert.ok(document.getElementById('legalModal').classList.contains('open'));
});

test('sk_test key runs live checkout in test mode with return URLs', async () => {
  let params;
  const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_test_1', url: 'https://stripe/t' }; } } } };
  const result = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { ...devEnv, STRIPE_SECRET_KEY: 'sk_test_x' }, client });
  assert.equal(result.testMode, true);
  assert.equal(result.mock, false);
  assert.equal(params.success_url, 'https://ovitervezo.hu/tervezo.html?payment=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://ovitervezo.hu/tervezo.html?payment=cancel');
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
  // A Stripe jelvény csak Stripe módban látszik; Barion módban rejtett marad.
  assert.ok(window.document.querySelector('[data-stripe-badge]').hidden);
  window.document.querySelectorAll('[data-stripe-badge]').forEach((node) => node.remove());
  const footer = window.document.getElementById('siteFooter').textContent;
  assert.match(footer, /68274568-1-28/);
  assert.match(footer, /EV nyilvántartási szám: 51507048/);
  assert.match(footer, /Öttevény/);
  assert.doesNotMatch(window.document.body.innerHTML, /kitöltendő/);
  window.document.querySelector('[data-legal="privacy"]').click();
  assert.match(window.document.getElementById('legalModalBody').textContent, /Barion Base Pixel/);
  const expected = {
    terms: [/Nethely Kft\./, /Alanyi adómentes/, /kellékszavatossági/, /nem váltják ki a pedagógus szakmai felelősségét/, /nincs|nem terheli meg/i, /bekelteto\.testulet@gymsmkik\.hu/],
    privacy: [/Render Services/, /Google Ireland/, /GYERMEKEK SZEMÉLYES ADATAIT/, /Barion Payment Zrt\./, /csalásmegelőzési \(fraud prevention\) célból/, /NAIH/, /8 évig/],
    billing: [/nincs havidíj/, /KBOSS\.hu Kft\./, /PCI-DSS/, /Barion/]
  };
  for (const [key, patterns] of Object.entries(expected)) {
    window.document.querySelector(`[data-legal="${key}"]`).click();
    const body = window.document.getElementById('legalModalBody').textContent;
    for (const p of patterns) assert.match(body, p, `${key}: ${p}`);
    assert.doesNotMatch(body, /Stripe/, `${key}: nincs Stripe-utalás`);
  }
  assert.match(footer, /Barion Payment – biztonságos bankkártyás fizetés/);
  assert.doesNotMatch(footer, /Stripe/);
});

test('invoice carries software line items, ovitervezo.hu note and sends an e-invoice', () => {
  const base = { orderId: 'x', customer: { email: 'a@b.hu' } };
  const env = { SZAMLAZZ_KEY: 'k' };
  const daily = invoiceService.buildInvoiceXml({ ...base, plan: 'daily' }, env);
  const weekly = invoiceService.buildInvoiceXml({ ...base, plan: 'weekly' }, env);
  assert.match(daily, /<megnevezes>OviTervező – Online szoftverhasználati díj \(1 alkalom\)<\/megnevezes>/);
  assert.match(weekly, /<megnevezes>OviTervező – Online szoftverhasználati díj – heti alapcsomag<\/megnevezes>/);
  assert.doesNotMatch(daily, /pedagógiai/);
  assert.match(daily, /<megjegyzes>Szolgáltató weboldal: https:\/\/ovitervezo\.hu \| Ügyfélszolgálat: info@ovitervezo\.hu \| Köszönjük a vásárlást!<\/megjegyzes>/);
  assert.match(daily, /<eszamla>true<\/eszamla>/);
  assert.match(daily, /<sendEmail>false<\/sendEmail>/);
  assert.match(daily, /<dijbekero>false<\/dijbekero>/);
});

test('signed checkout.session.completed webhook issues the invoice with the new line item', async () => {
  const Stripe = require('stripe');
  const saved = {};
  const set = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SZAMLAZZ_KEY: 'k', SZAMLAZZ_SANDBOX: 'false' };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  const realFetch = global.fetch;
  let sentXml = '';
  const { app } = require('../backend/server');
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
      data: { object: { id: 'cs_test_wh', payment_status: 'paid', amount_total: 39000, metadata: { plan: 'daily' }, customer_details: { name: 'Teszt', email: 'vevo@example.com', address: { postal_code: '1111', city: 'Bp', line1: 'Fő u. 1' } } } }
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
  assert.equal(invoiceService.supportEmail({}), 'info@ovitervezo.hu');
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
  assert.equal(params.success_url, 'https://pages.example/ovi/tervezo.html?payment=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://pages.example/ovi/tervezo.html?payment=cancel');
  const mock = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { NODE_ENV: 'test', FRONTEND_URL: 'http://localhost:4000' } });
  assert.match(mock.url, /^http:\/\/localhost:4000\/tervezo\.html\?payment=success&session_id=cs_mock_/);
});

test('invoice request disables Számlázz.hu mailing and asks for the PDF; the PDF is fetched live by invoice number', async () => {
  const xml = invoiceService.buildInvoiceXml({ plan: 'daily', orderId: 'cs_test_9', customer: { email: 'a@b.hu' } }, { SZAMLAZZ_KEY: 'k' });
  assert.match(xml, /<szamlaLetoltes>true<\/szamlaLetoltes>/);
  assert.match(xml, /<sendEmail>false<\/sendEmail>/);
  const env = { SZAMLAZZ_KEY: 'k' };
  let form;
  const fetch = async (url, options) => { form = options.body; return { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from('%PDF-1.4 invoice') }; };
  const pdf = await invoiceService.fetchInvoicePdf({ invoiceNumber: 'E-7' }, { env, fetch });
  assert.match(pdf.toString(), /^%PDF/);
  const request = await form.get('action-szamla_agent_pdf').text();
  assert.match(request, /<szamlaszam>E-7<\/szamlaszam>/);
  assert.match(request, /<szamlaagentkulcs>k<\/szamlaagentkulcs>/);
  const failing = async () => ({ ok: true, headers: new Map([['szlahu_error', 'Nincs%20ilyen']]) });
  await assert.rejects(invoiceService.fetchInvoicePdf({ invoiceNumber: 'E-8' }, { env, fetch: failing }), /Nincs ilyen/);
});

test('one combined purchase email carries the plan files and the invoice PDF', async () => {
  const mailService = require('../backend/services/mailService');
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

test('downloads are locked before payment and open only for the paid plan', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  assert.equal(document.querySelector('[data-export-section]'), null);

  window.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'g1' });
  assert.equal(document.getElementById('downloadPdfBtn').disabled, true);
  assert.equal(document.getElementById('downloadDocxBtn').disabled, true);
  assert.equal(document.getElementById('downloadInvoiceBtn').hidden, true);

  window.unlockGeneration('g1', 'cs_test_paid1');
  window.renderResultDocument(window.lastResult);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
  assert.equal(document.getElementById('downloadDocxBtn').disabled, false);
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

test('re-rendering and form edits do not revoke the unlock', async (t) => {
  const window = await loadLockedApp(t);
  window.renderResultDocument({ ...makePlan(8), request: makePayload(), generationId: 'g3' });
  window.unlockGeneration('g3', 'cs_test_paid3');
  window.renderResultDocument(window.lastResult);
  window.document.querySelector('[data-field="theme"]').value = 'Másik téma';
  window.document.querySelector('[data-field="theme"]').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.renderResultDocument(window.lastResult);
  assert.equal(window.isPlanLocked(), false);
});

test('locked preview renders 1:1 mirror activity section with blur and shows the unlock notice', async (t) => {
  const window = await loadLockedApp(t);
  const plan = makePlan(8);
  const secret = 'RÉSZLETES-FOGLALKOZÁSMENET';
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [secret];
  plan.kidolgozas_tablazat[0].modszerek_megjegyzesek = 'TITKOS-MODSZER';
  window.renderResultDocument({ ...plan, request: makePayload(), generationId: 'g9' });
  const host = window.document.getElementById('resultDocument');
  assert.equal(host.querySelectorAll('.official-table tbody tr').length, 8);
  assert.ok(host.querySelector('.locked-mirror-text'));
  assert.match(host.textContent, /A teljes dokumentum elkészült: 1 részletes táblázat és 8 kidolgozott tevékenységi egység vár feloldásra\./);

  window.unlockGeneration('g9', 'cs_test_g9');
  window.renderResultDocument(window.lastResult);
  const full = window.document.getElementById('resultDocument').textContent;
  assert.ok(full.includes(secret));
  assert.match(full, /TITKOS-MODSZER/);
  assert.equal(host.querySelector('.locked-mirror-text'), null);
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
  markPreviewReady(window);
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

test('the Számlázz.hu XML never carries a prefix or order number element, even when a prefix env is set (numbering is the account default)', () => {
  const base = { orderId: 'x', plan: 'daily', customer: { email: 'a@b.hu' } };
  for (const env of [{ SZAMLAZZ_KEY: 'k' }, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_PREFIX: 'OVITE' }, { SZAMLAZZ_KEY: 'k', SZAMLAZZ_INVOICE_PREFIX: 'ABC' }]) {
    const xml = invoiceService.buildInvoiceXml(base, env);
    assert.doesNotMatch(xml, /szamlaszamElotag|szamlaElotag|rendelesSzam|rendelesszam/i);
  }
});

test('invoice number order id stays internal: the XML has no OVI order number, the friendly number is still generated for our database', () => {
  const sessionId = 'cs_live_a1oHW2xOQfzz8abc7TTU12';
  const created = Date.UTC(2026, 10, 8, 12) / 1000;
  assert.equal(invoiceService.orderNumber(sessionId, created), 'OVI-261108-7TTU12');
  const xml = invoiceService.buildInvoiceXml({ orderId: sessionId, created, plan: 'daily', customer: { email: 'a@b.hu' } }, { SZAMLAZZ_KEY: 'k' });
  assert.doesNotMatch(xml, /OVI-261108|rendelesSzam/);
  assert.doesNotMatch(xml, /cs_live_/);
  const { buildEmailContent } = require('../backend/services/mailService');
  const mail = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, orderNumber: 'OVI-261108-7TTU12' }, {});
  assert.match(mail.html, /OVI-261108-7TTU12/);
  assert.match(mail.text, /Rendelésszám: OVI-261108-7TTU12/);
});

test('unlock buttons are hidden on steps 1-3 and shown only on step 4 after generation', async (t) => {
  const window = await loadLockedApp(t);
  const document = window.document;
  window.renderResultDocument({ ...makePlan(8), request: window.buildGenerationPayload(), generationId: 'gs1' });
  markPreviewReady(window);
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
  assert.equal(document.getElementById('checkoutTitle').textContent, 'Teljes tervezet és letöltés feloldása');
});

test('CORS allows ovitervezo.hu, www and localhost but rejects other origins', () => {
  const { corsOrigin } = require('../backend/server');
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
  assert.deepEqual(files, ['.htaccess', 'admin.html', 'assets', 'ertekeles.html', 'favicon.ico', 'favicon.svg', 'index.html', 'js', 'leiratkozas.html', 'logo.svg', 'profil.html', 'robots.txt', 'sitemap.xml', 'styles.css', 'tervezo.html']);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'og-preview.png')));
  const config = fs.readFileSync(path.join(dir, 'js', 'config.js'), 'utf8');
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

test('both builds keep the paywall on, so GitHub Pages is paid like production and has no free test delivery', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const cwd = path.join(__dirname, '..');
  execFileSync('node', ['scripts/build-nethely.js'], { cwd });
  assert.match(fs.readFileSync(path.join(cwd, 'dist-nethely', 'js', 'config.js'), 'utf8'), /"paywallEnabled": true/);
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'dist-nethely', 'js', 'config.js'), 'utf8'), /testDelivery/);
  const html = readPage('tervezo.html');
  assert.ok(!html.includes('testDeliver'), 'a tesztkézbesítés felülete kivezetve');
  assert.equal(require('../backend/routes/payment').testDeliver, undefined);
  assert.equal(require('../backend/server').isFreeTestOrigin, undefined);
});

test('mail template is warm, lists attachments and carries the legal footer', () => {
  const { buildEmailContent } = require('../backend/services/mailService');
  const daily = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true }, {});
  assert.match(daily.html, /Kedves Kolléganő!/);
  assert.doesNotMatch(daily.html, /🌱|📚|✨|💚|🌿/);
  assert.match(daily.html, /Új tervezet készítése/);
  assert.match(daily.html, /szabadon szerkeszthető/);
  assert.match(daily.html, /válaszoljon közvetlenül erre a levélre/);
  assert.doesNotMatch(daily.html, /Tervezet témája/);
  const titled = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: false, title: 'Az <őszi> erdő' }, {});
  assert.match(titled.html, /Tervezet témája:<\/strong> Az &lt;őszi&gt; erdő/);
  assert.match(titled.text, /Tervezet témája: Az <őszi> erdő/);
  assert.match(daily.html, /\.docx/);
  assert.match(daily.html, /PDF/);
  assert.match(daily.html, /68274568-1-28/);
  assert.match(daily.html, /EV nyilvántartási szám: 51507048/);
  assert.match(daily.html, /automatikus rendszerüzenet/);
  assert.match(daily.text, /Adatkezelési tájékoztató és ÁSZF/);
  const noInvoice = buildEmailContent({ planLabel: 'heti csomag', withInvoice: false }, {});
  assert.doesNotMatch(noInvoice.html, /E-számla/);
  assert.doesNotMatch(noInvoice.html, /teszt/i);
});

test('sheets webhook payload has all purchase fields and failures never throw', async () => {
  const sheets = require('../backend/services/sheetsService');
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

test('purchase e-mail is sent to the customer without BCC copying plan attachments to admin', async () => {
  const mailService = require('../backend/services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  const args = { to: 'v@b.hu', plan: 'daily', attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }], invoicePdf: Buffer.from('%PDF') };
  await mailService.sendPurchaseEmail(args, { transport, env: { ADMIN_NOTIFICATION_EMAIL: 'admin@ovitervezo.hu' } });
  assert.equal(sent[0].to, 'v@b.hu');
  assert.equal(sent[0].bcc, undefined);
  assert.equal(sent[0].attachments.length, 3);
});

test('index.html is a pure landing page and tervezo.html is the planner only', () => {
  const landing = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const planner = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'tervezo.html'), 'utf8');
  for (const text of ['Tervező indítása', 'Kezdjük a tervezést', '390 Ft', '890 Ft', '1. Csoport adatai', '2. Átgondolt vázlat', '3. Letöltés és másolás', 'Nem merev sablon', '100% szerkeszthető Word', 'Átlátható, szakmai felépítés', 'id="seoContent"', 'id="siteFooter"']) assert.ok(landing.includes(text), text);
  assert.equal((landing.match(/href="tervezo\.html"/g) || []).length >= 2, true);
  for (const absent of ['id="wizardList"', 'id="generateBtn"', 'id="previewPanel"', 'id="checkoutModal"', 'html2pdf']) assert.ok(!landing.includes(absent), `landing: ${absent}`);
  for (const text of ['id="wizardList"', 'id="previewPanel"', 'id="checkoutModal"', 'id="siteFooter"', 'href="index.html"']) assert.ok(planner.includes(text), `planner: ${text}`);
  for (const absent of ['id="landing"', 'id="seoContent"', 'landing-hero', 'Egyszeri díj, havidíj nélkül', 'application/ld+json']) assert.ok(!planner.includes(absent), `planner: ${absent}`);
  assert.match(landing, /<a class="brand" href="index\.html"/);
  assert.match(planner, /<a class="brand" href="index\.html"/);
  assert.doesNotMatch(landing, /Kréta OVI|Kréta-kompatibilis/);
  assert.doesNotMatch(planner, /Kréta OVI|Kréta-kompatibilis/);
  for (const page of [landing, planner]) {
    assert.match(page, /Cloudflare Turnstile/);
    assert.match(page, /href="https:\/\/www\.cloudflare\.com\/privacypolicy\/"/);
    assert.match(page, /href="https:\/\/www\.cloudflare\.com\/website-terms\/"/);
    assert.doesNotMatch(page, /reCAPTCHA|policies\.google\.com/);
  }
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /grecaptcha|recaptcha/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'site.js'), 'utf8'), /Cloudflare, Inc\. \(USA\) – Turnstile/);
  for (const kw of ['óvodai tervezet készítés', 'óvodai tervezet minta', 'foglalkozásterv minta', 'heti tervezet óvoda', 'Milyen óvodai tervezet készíthető', 'leggyorsabb óvodai tervezet készítő']) assert.ok(landing.includes(kw), kw);
  const types = [...landing.matchAll(/"@type":"(FAQPage|SoftwareApplication)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(types, ['FAQPage', 'SoftwareApplication']);
  for (const reviewText of ['4,9 / 5', 'Óvodapedagógusok visszajelzései alapján', 'Valós használói tapasztalatok',
    'Kovácsné T. Judit', 'Szabó Eszter', 'Varga-Németh Krisztina', 'Tóth Anikó', 'Horváthné Gabi', 'Molnár Dóra']) {
    assert.ok(landing.includes(reviewText), `missing review element: ${reviewText}`);
  }
  const reviewsPos = landing.indexOf('Visszajelzések és vélemények');
  const faqPos = landing.indexOf('Gyakran ismételt kérdések');
  assert.ok(reviewsPos !== -1 && faqPos !== -1 && reviewsPos < faqPos, 'Reviews section must precede FAQ');
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

test('August 20 sample plan modal opens via Mintatervezet megtekintése button and contains required data', async (t) => {
  const dom = new JSDOM(readPage('index.html'), { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const { document, window } = dom.window;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sampleButtons = Array.from(document.querySelectorAll('[data-sample-modal]'));
  assert.ok(sampleButtons.length >= 1, 'Missing sample plan button');
  assert.equal(sampleButtons[0].textContent.trim(), 'Mintatervezet megtekintése');

  const modal = document.getElementById('sampleModal');
  assert.ok(modal, 'Missing sampleModal');
  assert.equal(modal.classList.contains('open'), false);

  sampleButtons[0].click();
  assert.ok(modal.classList.contains('open'));

  // Verify contents
  const text = modal.textContent;
  assert.match(text, /Napsugár Óvoda \(nyári összevont ügyelet\)/);
  assert.match(text, /Süni vegyes csoport \(3–7 évesek\)/);
  assert.match(text, /Kovács Eszter/);
  assert.match(text, /2026\. augusztus 20\. \(csütörtök\)/);
  assert.match(text, /A külső világ tevékeny megismerése/);
  assert.match(text, /Verselés, mesélés/);
  assert.match(text, /Rajzolás, festés, mintázás, kézi munka/);
  assert.match(text, /Az új kenyér ünnepe/);
  assert.match(text, /búzakalász/i);
  assert.doesNotMatch(text, /Szakmai tervezet/);
  assert.doesNotMatch(text, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);

  // Close modal via close button
  modal.querySelector('[data-close-modal]').click();
  assert.equal(modal.classList.contains('open'), false);

  // Re-open and close via Escape key
  sampleButtons[0].click();
  assert.ok(modal.classList.contains('open'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(modal.classList.contains('open'), false);
});

test('both builds ship both pages with every local reference resolvable and the Search Console tag on both', () => {
  const { execFileSync } = require('node:child_process');
  const cwd = path.join(__dirname, '..');
  const env = { ...process.env, API_BASE_URL: 'https://api.example.onrender.com', GOOGLE_SITE_VERIFICATION: 'abcDEF1234567890xyz' };
  execFileSync('node', ['scripts/build-nethely.js'], { cwd, env });
  for (const dir of ['dist-nethely']) {
    for (const page of ['index.html', 'tervezo.html', 'ertekeles.html']) {
      const html = fs.readFileSync(path.join(cwd, dir, page), 'utf8');
      const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((r) => !/^(https?:|mailto:|data:)/.test(r));
      assert.ok(refs.length > 0);
      for (const ref of refs) {
        assert.ok(!ref.startsWith('/'), `${dir}/${page}: abszolút útvonal ${ref}`);
        assert.ok(fs.existsSync(path.join(cwd, dir, decodeURI(ref.split('?')[0]))), `${dir}/${page}: hiányzó fájl ${ref}`);
      }
      assert.doesNotMatch(html, /<!--GOOGLE_SITE_VERIFICATION-->/);
      for (const f of ['styles.css', 'js/site.js', 'js/config.js', 'favicon.svg', 'favicon.ico']) assert.match(html, new RegExp(`(?:href|src)="${f.replace('.', '\\.')}\\?v=\\d{12}"`), `${dir}/${page}: ${f} verzió nélkül`);
      assert.doesNotMatch(html, /(?:cdn|stripe)[^"]*\?v=/);
      assert.doesNotMatch(html, /href="(?:index|tervezo|ertekeles)\.html\?v=/);
    }
  }
  for (const page of ['index.html', 'tervezo.html', 'ertekeles.html']) {
    assert.match(fs.readFileSync(path.join(cwd, 'dist-nethely', page), 'utf8'), /<meta name="google-site-verification" content="abcDEF1234567890xyz" \/>/);
  }
  const { GOOGLE_SITE_VERIFICATION, ...clean } = env;
  execFileSync('node', ['scripts/build-nethely.js'], { cwd, env: clean });
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'dist-nethely', 'tervezo.html'), 'utf8'), /google-site-verification/);
});

test('landing FAQ questions match the FAQPage JSON-LD and meta follows the SEO brief', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  const app = blocks.find((b) => b['@type'] === 'SoftwareApplication');
  assert.equal(faq.mainEntity.length, 5);
  for (const q of faq.mainEntity) {
    assert.ok(html.includes(`<summary>${q.name}</summary>`), q.name);
    assert.ok(html.includes(q.acceptedAnswer.text), q.name);
  }
  assert.equal(app.name, 'OviTervező');
  assert.equal(app.applicationCategory, 'EducationalApplication');
  assert.equal(app.offers.lowPrice, '390');
  assert.equal(app.offers.highPrice, '890');
  assert.match(html, /<title>Óvodai tervezet készítés és óvodai tervező program \| OviTervező<\/title>/);
  assert.match(html, /name="description" content="Szakszerű óvodai tervezet, heti tervek és tematikus foglalkozásterv minták pár perc alatt/);
});

test('both pages use the OT logo and favicon, and both builds ship the icon files', () => {
  const root = path.join(__dirname, '..', 'frontend');
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

test('purchase e-mails with and without an invoice embed the OT logo as a CID image in the mint brand header', async () => {
  const mailService = require('../backend/services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { response: 'ok' }; } };
  const base = { to: 'v@b.hu', plan: 'daily', attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }] };
  await mailService.sendPurchaseEmail({ ...base, invoicePdf: Buffer.from('%PDF') }, { env: { SUPPORT_EMAIL: 's@x.hu' }, transport });
  await mailService.sendPurchaseEmail(base, { env: { SUPPORT_EMAIL: 's@x.hu' }, transport });
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

test('the webhook-side admin notification carries the invoice PDF', async () => {
  const mailService = require('../backend/services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  const result = await mailService.sendAdminNotification({ customer: { name: 'Teszt', email: 'v@b.hu' }, plan: 'daily', orderNumber: 'OVITE-1', invoiceNumber: 'E-1', invoicePdf: Buffer.from('%PDF') }, { transport, env: { SMTP_HOST: 'smtp.test' } });
  assert.equal(result.sent, true);
  assert.equal(sent[0].to, 'info@ovitervezo.hu');
  assert.equal(sent[0].attachments.length, 1);
});

test('feedback signature generation and verification with HMAC-SHA256', () => {
  const mailService = require('../backend/services/mailService');
  const email = 'teszt.ovono@example.com';
  const sig = mailService.createFeedbackSignature(email);
  assert.equal(typeof sig, 'string');
  assert.equal(sig.length, 64);
  assert.equal(mailService.verifyFeedbackSignature(email, sig), true);
  assert.equal(mailService.verifyFeedbackSignature('TESZT.OVONO@EXAMPLE.COM', sig), true);
  assert.equal(mailService.verifyFeedbackSignature('other@example.com', sig), false);
  assert.equal(mailService.verifyFeedbackSignature(email, 'invalid-signature-hex-0000000000000000000000000000000000000000000000'), false);
  assert.equal(mailService.verifyFeedbackSignature(email, ''), false);
  assert.equal(mailService.verifyFeedbackSignature('', sig), false);
});

test('without FEEDBACK_SECRET there is no feedback link and no signature verifies', () => {
  const mailService = require('../backend/services/mailService');
  assert.equal(mailService.createFeedbackSignature('a@b.hu', {}), '');
  assert.equal(mailService.verifyFeedbackSignature('a@b.hu', 'a'.repeat(64), {}), false);
  assert.equal(mailService.buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, to: 'a@b.hu' }, {}).html.includes('ertekeles.html'), false);
});

test('purchase e-mail contains discrete 5-star rating bar with Unicode stars, documentId and HMAC link', () => {
  const mailService = require('../backend/services/mailService');
  const to = 'vasarlo@example.com';
  const mail = mailService.buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, to, documentId: 'gen_test_doc_123' }, { FEEDBACK_SECRET: 'unit-secret' });
  assert.match(mail.html, /Hogy sikerült a tervezet\? Kattints a csillagokra/);
  assert.match(mail.html, /ertekeles\.html\?rating=5&email=vasarlo%40example\.com&sig=[a-f0-9]+&documentId=gen_test_doc_123/);
  assert.match(mail.html, /ertekeles\.html\?rating=1&email=vasarlo%40example\.com&sig=[a-f0-9]+&documentId=gen_test_doc_123/);
  assert.match(mail.html, /⭐/);
  assert.match(mail.text, /ertekeles\.html\?rating=5&email=vasarlo%40example\.com&sig=/);
});

test('sendAdminErrorAlert sends technical alert to admin on critical failure', async () => {
  const mailService = require('../backend/services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  const env = { SMTP_HOST: 'smtp.test', ADMIN_NOTIFICATION_EMAIL: 'admin@ovitervezo.hu' };
  const err = new Error('Gemini API 503 Service Unavailable');
  err.status = 503;
  err.stack = 'Error: Gemini API 503 Service Unavailable\n    at callGemini (/server.js:100:15)';

  const result = await mailService.sendAdminErrorAlert({
    operation: 'Tervezet generálás (Gemini)',
    error: err,
    email: 'pedagogus@ovoda.hu',
    documentId: 'gen_failed_456',
    details: { model: 'gemini-3.1-pro-preview', attempt: 3 }
  }, { env, transport });

  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'admin@ovitervezo.hu');
  assert.match(sent[0].subject, /KRITIKUS HIBA: Tervezet generálás \(Gemini\)/);
  assert.match(sent[0].text, /Tervezet generálás \(Gemini\)/);
  assert.match(sent[0].text, /pedagogus@ovoda\.hu/);
  assert.match(sent[0].text, /gen_failed_456/);
  assert.match(sent[0].text, /Gemini API 503 Service Unavailable/);
  assert.match(sent[0].text, /callGemini/);
  assert.match(sent[0].html, /KRITIKUS RENDSZERHIBA/);
  assert.match(sent[0].html, /gen_failed_456/);
});

test('sendFeedbackNotification sends notification to admin with customer replyTo and zero emojis', async () => {
  const mailService = require('../backend/services/mailService');
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  const env = { SMTP_HOST: 'smtp.test', ADMIN_NOTIFICATION_EMAIL: 'admin@ovitervezo.hu' };
  const result = await mailService.sendFeedbackNotification(env, {
    email: 'vevo@ovoda.hu',
    rating: 5,
    name: 'K. Anna – óvodapedagógus',
    comment: 'Nagyon hasznos volt a heti tervezet, köszönöm!'
  }, { transport });
  assert.equal(result.sent, true);
  assert.equal(sent[0].to, 'admin@ovitervezo.hu');
  assert.equal(sent[0].replyTo, 'vevo@ovoda.hu');
  assert.equal(sent[0].subject, 'OviTervező értékelés: 5/5 csillag – vevo@ovoda.hu');
  assert.match(sent[0].text, /5 \/ 5 csillag/);
  assert.match(sent[0].text, /K\. Anna – óvodapedagógus/);
  assert.match(sent[0].text, /Nagyon hasznos volt/);
  assert.doesNotMatch(sent[0].subject + sent[0].text + sent[0].html, /⭐|🌟|✨/);
});

test('POST /api/feedback validates HMAC signature, rating, comment and sends email', async () => {
  const { app, feedbackLimiter } = require('../backend/server');
  const mailService = require('../backend/services/mailService');
  const email = 'ertekeles.teszt@example.com';
  const sig = mailService.createFeedbackSignature(email, process.env);
  const server = app.listen(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/feedback`;

  try {
    // 1. Missing or invalid email
    const resBadEmail = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nem-email', sig, rating: 5, comment: 'Szuper' })
    });
    assert.equal(resBadEmail.status, 400);

    // 2. Missing sig
    const resNoSig = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, rating: 5, comment: 'Szuper' })
    });
    assert.equal(resNoSig.status, 403);

    // 3. Invalid sig
    const resBadSig = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, sig: 'rossz-alairas', rating: 5, comment: 'Szuper' })
    });
    assert.equal(resBadSig.status, 403);

    // 4. Invalid rating (out of range or not an integer)
    const resBadRating = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, sig, rating: 6, comment: 'Szuper' })
    });
    assert.equal(resBadRating.status, 400);

    // 5. Missing comment
    const resNoComment = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, sig, rating: 5, comment: '' })
    });
    assert.equal(resNoComment.status, 400);

    // 6. Valid submission
    const resOk = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        sig,
        rating: 5,
        name: 'Teszt Eszter',
        comment: 'Kiváló minőségű volt a kidolgozás!'
      })
    });
    assert.equal(resOk.status, 200);
    const dataOk = await resOk.json();
    assert.equal(dataOk.success, true);
    assert.match(dataOk.message, /Köszönjük/);
  } finally {
    server.close();
  }
});

const SHARED = require('../backend/services/siteConstants');
const ROOT = require('node:path').join(__dirname, '..');

test('one shared source defines the public support e-mail and Turnstile site key', () => {
  assert.equal(SHARED.SUPPORT_EMAIL, 'info@ovitervezo.hu');
  assert.equal(SHARED.TURNSTILE_SITE_KEY, '0x4AAAAAAGFSc8Zzow6VmxQ9');
  assert.equal(invoiceService.supportEmail({}), SHARED.SUPPORT_EMAIL);
  assert.equal(mailService.adminEmail({}), SHARED.SUPPORT_EMAIL);
});

test('no file still carries the old customer-service address', () => {
  const fs = require('node:fs');
  for (const file of ['frontend/index.html', 'frontend/tervezo.html', 'frontend/js/site.js', 'backend/server.js', 'backend/services/invoiceService.js', 'backend/services/mailService.js', 'frontend/js/config.js']) {
    assert.doesNotMatch(fs.readFileSync(require('node:path').join(ROOT, file), 'utf8'), /csb-vill\.com/, file);
  }
});

test('static footers and site.js fallback use the shared support e-mail', () => {
  const fs = require('node:fs');
  for (const file of ['frontend/index.html', 'frontend/tervezo.html']) {
    assert.match(fs.readFileSync(require('node:path').join(ROOT, file), 'utf8'), /<a id="footerEmail" href="mailto:info@ovitervezo\.hu">info@ovitervezo\.hu<\/a>/, file);
  }
  const site = fs.readFileSync(require('node:path').join(ROOT, 'frontend', 'js', 'site.js'), 'utf8');
  assert.match(site, new RegExp(`const DEFAULT_SUPPORT_EMAIL = '${SHARED.SUPPORT_EMAIL}';`));
  assert.doesNotMatch(site, /OVITERVEZO_CONFIG/);
});

test('every config source emits the same turnstile key and support e-mail under APP_CONFIG only', async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const evalConfig = (code) => { const sandbox = { window: {} }; vm.runInNewContext(code, sandbox); return sandbox.window; };
  for (const [script, dir] of [['scripts/build-nethely.js', 'dist-nethely']]) {
    execFileSync('node', [script], { cwd: ROOT });
    const code = fs.readFileSync(path.join(ROOT, dir, 'js', 'config.js'), 'utf8');
    assert.doesNotMatch(code, /OVITERVEZO_CONFIG/);
    const cfg = evalConfig(code).APP_CONFIG;
    assert.equal(cfg.turnstileSiteKey, script.includes('pages') ? '' : SHARED.TURNSTILE_SITE_KEY, script);
    assert.equal(cfg.barionPixelId, 'BP-U0p5Sp7I1Q-EF', `${script}: Barion Pixel azonosító`);
    assert.equal(cfg.company.email, SHARED.SUPPORT_EMAIL, script);
  }
  const local = evalConfig(fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'config.js'), 'utf8'));
  assert.equal(local.APP_CONFIG.turnstileSiteKey, SHARED.TURNSTILE_SITE_KEY);
  assert.equal(local.APP_CONFIG.company.email, SHARED.SUPPORT_EMAIL);
  assert.equal(local.OVITERVEZO_CONFIG, undefined);

  const { start } = require('../backend/server');
  const server = start(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/js/config.js`);
    const served = evalConfig(await res.text());
    assert.equal(served.APP_CONFIG.turnstileSiteKey, SHARED.TURNSTILE_SITE_KEY);
    assert.equal(served.APP_CONFIG.company.email, SHARED.SUPPORT_EMAIL);
    assert.equal(served.OVITERVEZO_CONFIG, undefined);
  } finally {
    server.close();
  }
});

test('the planner reads the Turnstile key only from APP_CONFIG', () => {
  const html = readPage('tervezo.html');
  assert.doesNotMatch(html, /OVITERVEZO_CONFIG/);
  assert.doesNotMatch(html, /0x4AAAAAAGFSc8Zzow6VmxQ9/);
});

test('static HTML carries no inline styles except the JS-toggled display:none ones', () => {
  for (const page of ['index.html', 'tervezo.html', 'ertekeles.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'frontend', page), 'utf8').replace(/<script\b[\s\S]*?<\/script>/g, '');
    const inline = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
    for (const style of inline) assert.match(style, /^display:\s*none;$/, `${page}: ${style}`);
  }
  const css = fs.readFileSync(path.join(ROOT, 'frontend', 'styles.css'), 'utf8');
  assert.equal((css.match(/@media print/g) || []).length, 1, 'egyetlen @media print blokk');
});

test('the synchronous theme bootstrap lives in theme-init.js and is shipped everywhere', async () => {
  const { execFileSync } = require('node:child_process');
  const script = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'theme-init.js'), 'utf8');
  for (const [stored, expected] of [['dark', 'dark'], ['light', 'light'], [null, 'light']]) {
    const dom = new JSDOM('<!doctype html><html><head></head></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
    if (stored) dom.window.localStorage.setItem('oviKretaTheme', stored);
    dom.window.eval(script);
    assert.equal(dom.window.document.documentElement.dataset.theme, expected);
    dom.window.close();
  }
  for (const page of ['index.html', 'tervezo.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'frontend', page), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf('<script src="js/theme-init.js"></script>') !== -1 && head.indexOf('<script src="js/theme-init.js"></script>') < head.indexOf('rel="stylesheet"'), `${page}: js/theme-init.js a stíluslap előtt`);
    assert.doesNotMatch(head, /<script>[\s\S]*oviKretaTheme/, `${page}: nincs inline téma-script`);
  }
  execFileSync('node', ['scripts/build-nethely.js'], { cwd: ROOT });
  for (const dir of ['dist-nethely']) {
    assert.ok(fs.existsSync(path.join(ROOT, dir, 'js', 'theme-init.js')), `${dir}: theme-init.js hiányzik`);
    for (const page of ['index.html', 'tervezo.html']) {
      assert.match(fs.readFileSync(path.join(ROOT, dir, page), 'utf8'), /<script src="js\/theme-init\.js\?v=\d{12}"><\/script>/, `${dir}/${page}`);
    }
  }
  const { start } = require('../backend/server');
  const server = start(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/js/theme-init.js`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), script);
  } finally {
    server.close();
  }
});

const PLANNER_SCRIPTS = ['core', 'academic', 'form', 'preview', 'export', 'generate', 'paywall', 'history', 'init'].map((name) => `tervezo-${name}.js`);

test('tervezo.html loads the planner scripts in order and the single static list covers every shipped file', async () => {
  const { SITE_ASSETS, PAGES } = require('../backend/services/siteConstants');
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'tervezo.html'), 'utf8');
  const loaded = [...html.matchAll(/<script src="js\/(tervezo-[a-z]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(loaded, PLANNER_SCRIPTS);
  assert.doesNotMatch(html.replace(/<script src=[^>]*><\/script>/g, ''), /<script\b/, 'nincs beágyazott script a tervezőben');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'frontend', 'js')).filter((f) => /^tervezo-.*\.js$/.test(f)).sort(), [...PLANNER_SCRIPTS].sort());
  for (const f of PLANNER_SCRIPTS) assert.ok(SITE_ASSETS.includes(`js/${f}`), `${f} hiányzik a közös listáról`);

  const { execFileSync } = require('node:child_process');
  execFileSync('node', ['scripts/build-nethely.js'], { cwd: ROOT });
  for (const dir of ['dist-nethely']) {
    const built = fs.readFileSync(path.join(ROOT, dir, 'tervezo.html'), 'utf8');
    const versioned = [...built.matchAll(/<script src="js\/(tervezo-[a-z]+\.js)\?v=\d{12}"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(versioned, PLANNER_SCRIPTS, `${dir}: verziózott tervezo-*.js`);
    for (const file of [...SITE_ASSETS, ...PAGES]) assert.ok(fs.existsSync(path.join(ROOT, dir, file)), `${dir}: ${file} hiányzik`);
  }

  const { start } = require('../backend/server');
  const server = start(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    for (const file of SITE_ASSETS) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/${file}`);
      assert.equal(res.status, 200, `/${file}`);
    }
  } finally {
    server.close();
  }
});

test('in Stripe mode the Barion strip, badge and button are hidden and only the Stripe card payment is offered', async (t) => {
  const window = await loadLockedApp(t);
  const { document } = window;
  window.APP_CONFIG.paymentProvider = 'stripe';
  window.applyPaymentProvider();
  for (const node of document.querySelectorAll('[data-barion-strip], [data-barion-badge], [data-barion-only]')) assert.equal(node.hidden || node.style.display === 'none', true, `${node.outerHTML.slice(0, 60)} rejtett`);
  for (const node of document.querySelectorAll('[data-stripe-badge], [data-stripe-only]')) assert.equal(node.hidden, false);

  window.APP_CONFIG.paymentProvider = 'barion';
  window.applyPaymentProvider();
  for (const node of document.querySelectorAll('[data-barion-only]')) assert.equal(node.hidden, false);
  for (const node of document.querySelectorAll('[data-stripe-badge]')) assert.equal(node.hidden, true);
});

test('orderService.claimDelivery hands out a delivery only up to the limit, release gives it back', async () => {
  const orders = require('../backend/services/orderService');
  orders.resetMemory();
  await orders.markPaid({ orderNumber: 'OVI-CLAIM', sessionId: 'cs_claim', provider: 'stripe', billingProfile: 'ev', email: 'a@b.hu', planMode: 'standard', planKey: 'daily', amount: 390 });
  assert.equal(await orders.claimDelivery('OVI-CLAIM', 1), true);
  assert.equal(await orders.claimDelivery('OVI-CLAIM', 1), false, 'a második kézbesítés elutasítva');
  assert.equal((await orders.getByOrderNumber('OVI-CLAIM')).deliveryCount, 1);
  await orders.releaseDelivery('OVI-CLAIM');
  assert.equal(await orders.claimDelivery('OVI-CLAIM', 1), true, 'sikertelen küldés után újrapróbálható');
  assert.equal(await orders.claimDelivery('OVI-NINCS', 1), false);
  orders.resetMemory();
});
