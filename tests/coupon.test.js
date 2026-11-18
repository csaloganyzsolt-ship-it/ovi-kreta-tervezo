const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { makePayload, makePlan, readPage } = require('./fixtures');
const server = require('../server');
const planStore = require('../services/planStore');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const mailService = require('../services/mailService');
const coupons = require('../services/coupons');

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function setEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

function stubGemini(t, plan) {
  const realFetch = global.fetch;
  setEnv(t, { GEMINI_API_KEY: 'local-test-key' });
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') return realFetch(url, options);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(plan) }] } }], usageMetadata: { totalTokenCount: 1 } });
  };
  t.after(() => { global.fetch = realFetch; });
}

// A hívásszámláló csapda: a kupon sosem érintheti a fizetési szolgáltatót és a számlázást.
function trapPaymentProviders(t) {
  const calls = [];
  const original = { checkout: stripeService.createCheckoutSession, retrieve: stripeService.retrieveCheckoutSession, invoice: invoiceService.issueInvoice };
  stripeService.createCheckoutSession = async () => { calls.push('stripe-checkout'); throw new Error('Stripe nem hívható'); };
  stripeService.retrieveCheckoutSession = async () => { calls.push('stripe-retrieve'); throw new Error('Stripe nem hívható'); };
  invoiceService.issueInvoice = async () => { calls.push('invoice'); throw new Error('Számlázz.hu nem hívható'); };
  t.after(() => { stripeService.createCheckoutSession = original.checkout; stripeService.retrieveCheckoutSession = original.retrieve; invoiceService.issueInvoice = original.invoice; });
  return calls;
}

const SECRET = 'Titkos kuponos foglalkozási lépés';
const file = (name) => ({ name, base64: Buffer.from('x').toString('base64') });

// ---------- Kuponkódok ----------

test('TEST100 is the built-in 100% code, matched case-insensitively, and COUPON_CODES replaces or disables the list', () => {
  assert.deepEqual(coupons.couponCodes({}), ['TEST100']);
  for (const code of ['TEST100', 'test100', '  Test100 ']) assert.equal(coupons.isValidCode(code, {}), true, code);
  for (const code of ['', undefined, null, 'TEST10', 'TEST1000', 'x'.repeat(500), {}, ['TEST100']]) assert.equal(coupons.isValidCode(code, {}), false, String(code));
  assert.deepEqual(coupons.couponCodes({ COUPON_CODES: ' ovi50 , Tanar100 ,, ' }), ['OVI50', 'TANAR100']);
  assert.equal(coupons.isValidCode('TEST100', { COUPON_CODES: 'MASIK' }), false, 'a beállított lista felülírja az alapértelmezettet');
  assert.equal(coupons.isValidCode('MASIK', { COUPON_CODES: 'MASIK' }), true);
  assert.equal(coupons.isValidCode('TEST100', { COUPON_CODES: '' }), false, 'üres lista kikapcsolja a kuponokat');
});

// ---------- /api/apply-coupon ----------

async function generateLocked(t, base) {
  const plan = makePlan(6);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [SECRET];
  stubGemini(t, plan);
  const response = await post(base, '/api/generate', { ...makePayload(), preview: true });
  const data = await response.json();
  assert.equal(data.locked_meta.is_locked, true);
  assert.equal(JSON.stringify(data).includes(SECRET), false);
  return data.generationId;
}

test('the TEST100 coupon unlocks the stored plan without touching Stripe or the invoicing, and repeating it returns the same session', async (t) => {
  setEnv(t, { PAYWALL_ENABLED: 'true', COUPON_CODES: undefined });
  const calls = trapPaymentProviders(t);
  const base = await listen(t);
  const generationId = await generateLocked(t, base);
  const apply = (body) => post(base, '/api/apply-coupon', { code: 'TEST100', plan: 'daily', planMode: 'standard', email: 'vevo@example.com', generationId, ...body });

  const response = await apply({ code: 'test100' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.paid, true);
  assert.deepEqual(data.coupon, { code: 'TEST100', percent: 100 });
  assert.match(data.sessionId, /^coupon_[0-9a-f]{32}$/);
  assert.equal(data.generationId, generationId);
  assert.equal(data.planData.kidolgozas_tablazat[0].tevekenyseg_menete[0], SECRET, 'a feloldott terv a valódi tartalmat adja');
  assert.deepEqual(calls, [], 'sem a Stripe, sem a Számlázz.hu nem hívódott');

  const again = await (await apply({})).json();
  assert.equal(again.sessionId, data.sessionId, 'ugyanarra a tervre ugyanaz a munkamenet');
  assert.deepEqual(calls, []);
});

test('the coupon endpoint refuses wrong codes, bad e-mails, unknown plans and a disabled coupon list', async (t) => {
  setEnv(t, { PAYWALL_ENABLED: 'true', COUPON_CODES: undefined });
  const calls = trapPaymentProviders(t);
  const base = await listen(t);
  const generationId = await generateLocked(t, base);
  const apply = (body) => post(base, '/api/apply-coupon', { code: 'TEST100', plan: 'daily', email: 'vevo@example.com', generationId, ...body });

  let response = await apply({ code: 'NEMJO' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { success: false, code: 'INVALID_COUPON', error: 'Érvénytelen kuponkód.' });
  for (const code of [undefined, '', 'TEST100 ; DROP', { $ne: 1 }]) assert.equal((await apply({ code })).status, 400, JSON.stringify(code));
  for (const email of [undefined, '', 'nem-email', 'a@b']) assert.equal((await apply({ email })).status, 400, `email: ${email}`);
  assert.equal((await apply({ generationId: 'gen_nincs_ilyen' })).status, 404);
  assert.equal((await apply({ generationId: undefined })).status, 404);
  assert.equal((await apply({ plan: 'monthly' })).status, 400);
  assert.equal((await fetch(`${base}/api/apply-coupon`)).status, 404, 'csak POST');

  setEnv(t, { COUPON_CODES: '' });
  assert.equal((await apply({})).status, 400, 'kikapcsolt kuponlista mellett a TEST100 sem él');
  setEnv(t, { COUPON_CODES: 'UJKOD' });
  assert.equal((await apply({})).status, 400);
  assert.equal((await apply({ code: 'ujkod' })).status, 200);
  assert.deepEqual(calls, []);
});

test('an academic plan redeemed by coupon keeps its plan mode from the stored plan', async (t) => {
  setEnv(t, { COUPON_CODES: undefined });
  planStore.savePlan('gen_coupon_academic', { planMode: 'academic', tema: 'x', request: { planMode: 'academic', duration: 'Napi' } });
  const base = await listen(t);
  const data = await (await post(base, '/api/apply-coupon', { code: 'TEST100', plan: 'daily', planMode: 'standard', email: 'vevo@example.com', generationId: 'gen_coupon_academic' })).json();
  assert.equal(data.plan, 'academic_daily');
  assert.equal(coupons.getSession(data.sessionId).planMode, 'academic');
});

// ---------- Kézbesítés kuponos munkamenettel ----------

test('delivery of a coupon session sends the files without an invoice, once, and never asks Stripe', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-coupon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setEnv(t, { PAYWALL_ENABLED: 'true', COUPON_CODES: undefined, SMTP_HOST: 'smtp.invalid.example', INVOICE_STORE_PATH: path.join(dir, 'invoiced-sessions.json') });
  const calls = trapPaymentProviders(t);
  const base = await listen(t);
  const generationId = await generateLocked(t, base);
  const { sessionId } = await (await post(base, '/api/apply-coupon', { code: 'TEST100', plan: 'daily', email: 'vevo@example.com', generationId })).json();

  mailService.mockOutbox.length = 0;
  const deliver = () => post(base, `/api/deliver/${sessionId}`, { files: [file('terv.pdf'), file('terv.docx')], title: 'Őszi erdő', planMode: 'standard' });
  const first = await deliver();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { success: true, sent: true, coupon: true });
  assert.equal(mailService.mockOutbox.length, 1);
  const mail = mailService.mockOutbox[0];
  assert.equal(mail.to, 'vevo@example.com');
  assert.match(mail.subject, /kuponnal feloldott/);
  assert.deepEqual(mail.attachments.filter((name) => /\.(pdf|docx)$/.test(name)), ['terv.pdf', 'terv.docx'], 'számla nincs a mellékletek között');

  assert.deepEqual(await (await deliver()).json(), { success: true, sent: false, reason: 'already_sent' });
  assert.equal(mailService.mockOutbox.length, 1, 'másodszor nem megy ki levél');
  assert.deepEqual(calls, []);

  const unknown = await post(base, '/api/deliver/coupon_00000000000000000000000000000000', { files: [file('a.pdf')] });
  assert.ok(unknown.status >= 400, 'ismeretlen kuponmunkamenet nem kézbesít');
  assert.equal(mailService.mockOutbox.length, 1);
});

test('the coupon purchase e-mail has no invoice text or attachment, the Stripe one keeps both', () => {
  const free = mailService.buildEmailContent({ planLabel: 'napi tervezet', withInvoice: false, orderNumber: 'ABC123' }, {});
  assert.doesNotMatch(free.html + free.text, /e-számla/i);
  const paid = mailService.buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true }, {});
  assert.match(paid.text, /e-számlát/i);
});

// ---------- Frontend: kuponmező és feloldás ----------

const plannerHtml = readPage('tervezo.html');

async function loadPlanner(t) {
  const dom = new JSDOM(plannerHtml, {
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

function showLockedPreview(window, generationId = 'gen_ui_coupon') {
  const mirror = { ...planStore.createMirrorPlan(makePlan(8)), request: makePayload(), generationId };
  window.renderResultDocument(mirror);
  window.eval('previewReady = true');
  window.renderPreview();
  window.updateExportLock();
  return mirror;
}

const fillCheckout = (window, { email = 'vevo@example.com', consent = true } = {}) => {
  const { document } = window;
  document.getElementById('checkoutEmail').value = email;
  document.getElementById('consentTerms').checked = consent;
  document.getElementById('consentDigital').checked = consent;
};

const CTA_IDS = ['unlockNavBtn', 'unlockTopBtn', 'unlockBottomBtn', 'unlockFloatingBtn'];
const ctaVisible = (window) => CTA_IDS.map((id) => !window.document.getElementById(id).hidden);

test('the checkout form has a coupon field with an Érvényesítés button above the payment button, below the billing fields', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  const form = Array.from(document.getElementById('checkoutForm').querySelectorAll('*'));
  const index = (id) => form.indexOf(document.getElementById(id));
  const input = document.getElementById('couponCode');
  assert.equal(input.type, 'text');
  assert.equal(document.getElementById('couponApply').textContent.trim(), 'Érvényesítés');
  assert.equal(document.getElementById('couponApply').type, 'button', 'nem küldi el a fizetési űrlapot');
  assert.equal(document.querySelector('label[for="couponCode"]').textContent.trim(), 'Kuponkód');
  assert.ok(index('billingAddress') < index('couponCode') && index('couponCode') < index('checkoutBarion') && index('couponApply') < index('checkoutBarion'));
});

test('a valid coupon unlocks the plan, hides the invoice button, closes the form and delivers the files by e-mail', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  const mirror = showLockedPreview(window);
  assert.equal(window.isPlanLocked(), true);
  window.openCheckoutModal();
  fillCheckout(window);
  document.getElementById('couponCode').value = 'TEST100';

  const calls = [];
  const full = { ...makePlan(8), request: mirror.request, generationId: mirror.generationId };
  window.buildDeliveryFiles = async () => [{ name: 'terv.pdf', base64: 'eA==' }];
  window.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/api/apply-coupon')) return Response.json({ success: true, paid: true, sessionId: 'coupon_abcdef0123456789abcdef0123456789', planData: full, emailEnabled: true });
    return Response.json({ success: true, sent: true, coupon: true });
  };
  document.getElementById('couponApply').click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(calls[0].url, 'http://localhost:8000/api/apply-coupon');
  assert.deepEqual({ ...calls[0].body, title: undefined }, { code: 'TEST100', plan: 'daily', planMode: 'standard', email: 'vevo@example.com', generationId: 'gen_ui_coupon', title: undefined });
  assert.equal(window.isPlanLocked(), false);
  assert.equal(document.getElementById('checkoutModal').classList.contains('open'), false);
  assert.equal(document.getElementById('unlockedBadge').hidden, false);
  assert.deepEqual(ctaVisible(window), [false, false, false, false]);
  assert.equal(document.getElementById('downloadPdfBtn').disabled, false);
  assert.equal(document.querySelector('.locked-mirror-text'), null, 'a valódi tartalom látszik');
  assert.equal(document.getElementById('downloadInvoiceBtn').hidden, true, 'kuponnal nincs számla');
  assert.equal(window.currentPaidSessionId(), 'coupon_abcdef0123456789abcdef0123456789');
  assert.equal(calls[1].url, 'http://localhost:8000/api/deliver/coupon_abcdef0123456789abcdef0123456789');
  assert.deepEqual(calls[1].body.files, [{ name: 'terv.pdf', base64: 'eA==' }]);
  assert.match(document.getElementById('purchaseNotice').textContent, /elküldtük/);
  assert.doesNotMatch(document.getElementById('purchaseNotice').textContent, /számla/);
});

test('an invalid coupon shows a message in the form and keeps the plan locked', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  showLockedPreview(window);
  window.openCheckoutModal();
  fillCheckout(window);
  let calls = 0;
  window.fetch = async () => { calls += 1; return Response.json({ success: false, code: 'INVALID_COUPON', error: 'Érvénytelen kuponkód.' }, { status: 400 }); };
  const status = document.getElementById('couponStatus');
  const apply = document.getElementById('couponApply');

  apply.click();
  assert.match(status.textContent, /Add meg a kuponkódot/);
  assert.equal(calls, 0, 'üres kóddal nincs kérés');

  document.getElementById('couponCode').value = 'NEMJO';
  fillCheckout(window, { email: 'nem-email' });
  apply.click();
  assert.match(document.getElementById('checkoutError').textContent, /érvényes e-mail/);
  assert.equal(calls, 0, 'e-mail nélkül nincs kérés');

  fillCheckout(window);
  apply.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(status.textContent, 'A kupon nem érvényesíthető: Érvénytelen kuponkód.');
  assert.equal(window.isPlanLocked(), true);
  assert.equal(document.getElementById('checkoutModal').classList.contains('open'), true);
  assert.equal(apply.disabled, false, 'a gomb újra használható');
});

test('Enter in the coupon field applies the coupon and never starts the payment', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  showLockedPreview(window);
  window.openCheckoutModal();
  fillCheckout(window);
  document.getElementById('couponCode').value = 'NEMJO';
  const urls = [];
  window.fetch = async (url) => { urls.push(String(url)); return Response.json({ success: false, error: 'Érvénytelen kuponkód.' }, { status: 400 }); };
  document.getElementById('couponCode').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(urls, ['http://localhost:8000/api/apply-coupon']);
});

// ---------- Fizetési doboz csak kész, zárolt előnézetnél ----------

test('the payment box stays hidden while Gemini generates and appears only after the locked preview is in the DOM', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  assert.deepEqual(ctaVisible(window), [false, false, false, false], 'generálás előtt nincs fizetési doboz');

  showLockedPreview(window, 'gen_ui_old');
  assert.deepEqual(ctaVisible(window), [true, true, true, true], 'kész zárolt előnézetnél látszik');
  assert.ok(document.getElementById('paywallGate'));

  let release;
  const bodies = [];
  window.fetch = (url, options) => new Promise((resolve) => {
    bodies.push(JSON.parse(options.body));
    release = () => {
      const mirror = { ...planStore.createMirrorPlan(makePlan(8)), generationId: 'gen_ui_new', success: true };
      const text = JSON.stringify(mirror);
      resolve({ ok: true, status: 200, text: async () => text });
    };
  });
  const pending = window.generatePlan();
  assert.deepEqual(ctaVisible(window), [false, false, false, false], 'generálás közben nincs fizetési doboz');
  assert.equal(document.getElementById('paywallGate'), null);
  assert.equal(document.getElementById('lockedFloatingBar').hidden, true);
  window.openCheckoutModal();
  assert.equal(document.getElementById('checkoutModal').classList.contains('open'), false, 'a fizetési ablak sem nyitható generálás közben');
  window.updateExportLock();
  assert.deepEqual(ctaVisible(window), [false, false, false, false], 'újraszámolás után sem');
  assert.equal(bodies[0].preview, true, 'a kliens zárolt előnézetet kér');

  release();
  await pending;
  assert.ok(document.getElementById('paywallGate'), 'a zárolt előnézet a DOM-ban van');
  assert.deepEqual(ctaVisible(window), [true, true, true, true], 'sikeres generálás után megjelenik');
});

test('a failed generation leaves no payment box behind', async (t) => {
  const window = await loadPlanner(t);
  showLockedPreview(window);
  window.fetch = async () => ({ ok: false, status: 500, text: async () => '{"success":false,"error":"x"}' });
  await window.generatePlan();
  assert.deepEqual(ctaVisible(window), [false, false, false, false]);
  assert.equal(window.document.getElementById('paywallGate'), null);
});
