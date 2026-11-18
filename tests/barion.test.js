const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { makePayload, makePlan, makeAcademicPayload, makeAcademicResponse, makeThematicPayload, makeThematicResponse, readPage } = require('./fixtures');
const server = require('../server');
const planStore = require('../services/planStore');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const { PRODUCTS, resolveProductKey, productFor } = require('../services/pricing');
const { barionPixelId, DEFAULT_BARION_PIXEL_ID, CONTENT_SECURITY_POLICY } = require('../services/siteConstants');

const ROOT = path.join(__dirname, '..');
const PIXEL_ID = 'BP-U0p5Sp7I1Q-EF';

// ---------- Árazás: egy forrás, a planMode dönti el az összeget ----------

test('the price table is one source: standard 390/890 Ft, academic 690 Ft for daily and weekly', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PRODUCTS).map(([key, product]) => [key, product.amountHuf])), {
    daily: 390, weekly: 390, weekly_detailed: 890, academic_daily: 690, academic_weekly: 690
  });
  assert.equal(stripeService.PRODUCTS, PRODUCTS, 'a Stripe, a számlázás és a Barion ugyanazt a táblát használja');
  for (const product of Object.values(PRODUCTS)) assert.equal(product.planMode, product.key.startsWith('academic_') ? 'academic' : 'standard');
  assert.ok(PRODUCTS.academic_daily.invoiceName.includes('oktatási célú'));
});

test('planMode decides the product: academic never pays a standard price, unknown plans are rejected', () => {
  for (const [plan, mode, expected] of [
    ['daily', 'standard', 'daily'], ['weekly', 'standard', 'weekly'], ['weekly_detailed', 'standard', 'weekly_detailed'], ['daily', undefined, 'daily'],
    ['daily', 'academic', 'academic_daily'], ['weekly', 'academic', 'academic_weekly'], ['weekly_detailed', 'academic', 'academic_weekly'],
    ['academic_daily', 'standard', 'academic_daily'], ['academic_weekly', undefined, 'academic_weekly'], ['academic_weekly', 'academic', 'academic_weekly']
  ]) assert.equal(resolveProductKey(plan, mode), expected, `${plan}/${mode}`);
  for (const bad of ['', undefined, 'monthly', '__proto__', 'constructor', 'academic']) assert.equal(resolveProductKey(bad, 'academic'), null, String(bad));
  assert.equal(productFor('daily', 'academic').amountHuf, 690);
  assert.equal(productFor('daily', 'standard').amountHuf, 390);
  assert.throws(() => stripeService.parsePlan('monthly', 'academic'), (error) => error.status === 400 && /academic_daily/.test(error.message));
});

test('Stripe charges 690 Ft for the academic plans and 390/890 Ft for the standard ones, from the plan mode', async () => {
  const charge = async (plan, planMode) => {
    let params;
    const client = { checkout: { sessions: { create: async (p) => { params = p; return { id: 'cs_test_1', url: 'https://stripe/x' }; } } } };
    const result = await stripeService.createCheckoutSession({ plan, planMode, email: 'a@b.hu', generationId: 'g1' }, { env: { STRIPE_SECRET_KEY: 'sk_test_x' }, client });
    return { params, result };
  };
  for (const [plan, mode, key, huf] of [
    ['daily', 'academic', 'academic_daily', 690], ['weekly', 'academic', 'academic_weekly', 690], ['weekly_detailed', 'academic', 'academic_weekly', 690],
    ['academic_daily', 'standard', 'academic_daily', 690], ['daily', 'standard', 'daily', 390], ['weekly_detailed', 'standard', 'weekly_detailed', 890]
  ]) {
    const { params, result } = await charge(plan, mode);
    assert.equal(params.line_items[0].price_data.unit_amount, huf * 100, `${plan}/${mode}`);
    assert.equal(params.metadata.plan, key);
    assert.equal(params.metadata.planMode, huf === 690 ? 'academic' : 'standard');
    assert.equal(result.amountHuf, huf);
    assert.equal(result.plan, key);
  }
  const { params } = await charge('daily', 'academic');
  assert.match(params.line_items[0].price_data.product_data.name, /oktatási célú napi tervezet/);
});

test('the invoice for an academic plan is 690 Ft AAM: net equals gross, no VAT, with its own line item name', () => {
  const env = { SZAMLAZZ_API_KEY_EV: 'agent-ev' };
  for (const plan of ['academic_daily', 'academic_weekly']) {
    const xml = invoiceService.buildInvoiceXml({ plan, orderId: 'cs_test_1', customer: { email: 'a@b.hu' } }, env);
    assert.match(xml, /<afakulcs>AAM<\/afakulcs>/);
    assert.match(xml, /<nettoEgysegar>690<\/nettoEgysegar>/);
    assert.match(xml, /<nettoErtek>690<\/nettoErtek>/);
    assert.match(xml, /<afaErtek>0<\/afaErtek>/);
    assert.match(xml, /<bruttoErtek>690<\/bruttoErtek>/);
    assert.match(xml, /oktatási célú/);
    assert.doesNotMatch(xml, /szamlaszamElotag/);
  }
  assert.match(invoiceService.buildInvoiceXml({ plan: 'daily', orderId: 'cs_test_1', customer: { email: 'a@b.hu' } }, env), /<bruttoErtek>390<\/bruttoErtek>/);
});

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function cleanPaymentEnv(t) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|NODE_ENV|BARION_)/.test(key)) delete process.env[key];
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
}

const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the server takes the plan mode from the stored plan, so an academic plan cannot be bought at the standard price', async (t) => {
  cleanPaymentEnv(t);
  planStore.savePlan('gen_barion_academic', { planMode: 'academic', tema: 'x', request: { planMode: 'academic', duration: 'Napi' } });
  planStore.savePlan('gen_barion_thematic', { is_thematic: true, planMode: 'academic', hetek: [], request: { planMode: 'academic', duration: 'Heti' } });
  planStore.savePlan('gen_barion_standard', { tema: 'x', request: { planMode: 'standard', duration: 'Napi' } });
  const base = await listen(t);
  const checkout = async (body) => (await post(base, '/api/create-checkout-session', { email: 'a@b.hu', ...body })).json();

  const cheat = await checkout({ plan: 'daily', planMode: 'standard', generationId: 'gen_barion_academic' });
  assert.equal(cheat.plan, 'academic_daily');
  assert.equal(cheat.amountHuf, 690);
  const thematic = await checkout({ plan: 'weekly', planMode: 'standard', generationId: 'gen_barion_thematic' });
  assert.equal(thematic.plan, 'academic_weekly');
  assert.equal(thematic.amountHuf, 690);
  const standard = await checkout({ plan: 'daily', planMode: 'academic', generationId: 'gen_barion_standard' });
  assert.equal(standard.plan, 'daily', 'a tárolt standard terv a standard áron marad');
  assert.equal(standard.amountHuf, 390);
  const unknown = await checkout({ plan: 'daily', planMode: 'academic', generationId: 'gen_nincs_ilyen' });
  assert.equal(unknown.plan, 'academic_daily', 'tárolt terv nélkül a kliens planMode-ja érvényes');
  const weekly = await checkout({ plan: 'weekly_detailed', generationId: 'gen_barion_standard' });
  assert.equal(weekly.amountHuf, 890);
  const invalid = await post(base, '/api/create-checkout-session', { plan: 'monthly', planMode: 'academic', email: 'a@b.hu' });
  assert.equal(invalid.status, 400);
});

// ---------- Barion Base Pixel ----------

test('the Barion pixel id comes from BARION_PIXEL_ID with a safe default and can be switched off or fixed by an invalid value', () => {
  assert.equal(DEFAULT_BARION_PIXEL_ID, PIXEL_ID);
  assert.equal(barionPixelId({}), PIXEL_ID);
  assert.equal(barionPixelId({ BARION_PIXEL_ID: 'BP-Masik-123456' }), 'BP-Masik-123456');
  assert.equal(barionPixelId({ BARION_PIXEL_ID: '' }), '', 'üres érték kikapcsolja a Pixelt');
  assert.equal(barionPixelId({ BARION_PIXEL_ID: '  ' }), '');
  for (const bad of ['<script>', 'BP-"x', 'xyz', 'BP-', 'BP-a b c d']) assert.equal(barionPixelId({ BARION_PIXEL_ID: bad }), '', bad);
});

function runPixel(config) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost:8000', runScripts: 'outside-only' });
  if (config !== undefined) dom.window.APP_CONFIG = config;
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'barion-pixel.js'), 'utf8'));
  return dom.window;
}

test('barion-pixel.js loads the Barion script with the configured id and never breaks without one', () => {
  const window = runPixel({ barionPixelId: PIXEL_ID });
  assert.equal(typeof window.bp, 'function');
  assert.equal(window.barion_pixel_id, PIXEL_ID);
  assert.deepEqual(Array.from(window.bp.q[0]), ['init', 'addBarionPixelId', PIXEL_ID]);
  const script = window.document.head.querySelector('script[src^="https://pixel.barion.com/"]');
  assert.equal(script.src, 'https://pixel.barion.com/bp.js');
  assert.equal(script.async, true);

  for (const config of [undefined, {}, { barionPixelId: '' }, { barionPixelId: null }, { barionPixelId: '<img onerror=1>' }, { barionPixelId: 'rossz' }]) {
    const quiet = runPixel(config);
    assert.equal(quiet.bp, undefined, JSON.stringify(config));
    assert.equal(quiet.document.head.querySelector('script'), null);
  }
});

test('both pages carry the deferred Barion pixel script in the head, and every config source hands over the id', async (t) => {
  for (const page of ['tervezo.html', 'index.html']) {
    const source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const head = source.slice(source.indexOf('<head>'), source.indexOf('</head>'));
    assert.match(head, /<script src="barion-pixel\.js" defer><\/script>/, page);
    assert.doesNotMatch(source, /pixel\.barion\.com/, `${page}: nincs beágyazott Pixel-kód (CSP)`);
    assert.ok(source.indexOf('src="config.js"') > 0);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'), new RegExp(`barionPixelId: '${PIXEL_ID}'`));

  const saved = process.env.BARION_PIXEL_ID;
  t.after(() => { if (saved === undefined) delete process.env.BARION_PIXEL_ID; else process.env.BARION_PIXEL_ID = saved; });
  const base = await listen(t);
  const served = async () => JSON.parse((await (await fetch(`${base}/config.js`)).text()).replace(/^window\.APP_CONFIG = /, '').replace(/;\s*$/, ''));
  delete process.env.BARION_PIXEL_ID;
  assert.equal((await served()).barionPixelId, PIXEL_ID);
  process.env.BARION_PIXEL_ID = 'BP-Masik-123456';
  assert.equal((await served()).barionPixelId, 'BP-Masik-123456');
  process.env.BARION_PIXEL_ID = '';
  assert.equal((await served()).barionPixelId, '');
  assert.equal(JSON.stringify(await served()).includes('sk_'), false);
});

test('the CSP allows the Barion pixel host for scripts, beacons and the tracking image, and nothing wider', () => {
  const directive = (name) => CONTENT_SECURITY_POLICY.split('; ').find((part) => part.startsWith(`${name} `));
  for (const name of ['script-src', 'connect-src', 'img-src', 'frame-src']) assert.ok(directive(name).includes('https://pixel.barion.com'), name);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /\*\.barion\.com|unsafe-eval/);
  assert.ok(fs.readFileSync(path.join(ROOT, '.htaccess'), 'utf8').includes(CONTENT_SECURITY_POLICY));
});

// ---------- Fizetési felület: jelölőnégyzet, gombok, logók ----------

const plannerHtml = readPage('tervezo.html');

async function loadPlanner(t, config = { paywallEnabled: true, apiBaseUrl: 'same-origin' }) {
  const dom = new JSDOM(plannerHtml, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.APP_CONFIG = config;
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
  return dom.window;
}

const academicResult = (payload = makeAcademicPayload({ dateValue: '2026-11-03' })) => ({
  ...server.normalizeResponse(JSON.stringify(makeAcademicResponse()), payload), request: payload, generationId: 'gen_ui_academic'
});
const thematicResult = (payload = makeThematicPayload()) => ({
  ...server.normalizeResponse(JSON.stringify(makeThematicResponse()), payload), request: payload, generationId: 'gen_ui_thematic'
});
const standardResult = (overrides = {}) => ({ ...makePlan(3), request: makePayload(overrides), generationId: 'gen_ui_standard' });

const fill = (window, { terms = true, digital = true, email = 'vevo@example.com' } = {}) => {
  const { document } = window;
  document.getElementById('checkoutEmail').value = email;
  document.getElementById('consentTerms').checked = terms;
  document.getElementById('consentDigital').checked = digital;
  for (const id of ['consentTerms', 'consentDigital']) document.getElementById(id).dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('checkoutEmail').dispatchEvent(new window.Event('input', { bubbles: true }));
};

test('the payment form has the mandatory consent above both payment buttons and the buttons stay disabled until it is ticked', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  window.renderResultDocument(standardResult());
  window.openCheckoutModal();

  const consent = document.getElementById('consentTerms');
  const label = consent.closest('label');
  assert.equal(label.textContent.replace(/\s+/g, ' ').trim(), 'Elolvastam és elfogadom az ÁSZF-et és az Adatvédelmi tájékoztatót.');
  assert.equal(label.querySelector('a[data-legal="terms"]').textContent, 'ÁSZF');
  assert.equal(label.querySelector('a[data-legal="privacy"]').textContent, 'Adatvédelmi tájékoztatót');

  const stripe = document.getElementById('checkoutSubmit');
  const barion = document.getElementById('checkoutBarion');
  assert.equal(consent.checked, false);
  assert.equal(stripe.disabled, true);
  assert.equal(barion.disabled, true);
  const position = (node) => Array.from(document.getElementById('checkoutForm').querySelectorAll('*')).indexOf(node);
  assert.ok(position(consent) < position(stripe) && position(consent) < position(barion), 'a jelölőnégyzet a gombok fölött van');

  fill(window);
  assert.equal(stripe.disabled, false);
  assert.equal(barion.disabled, false);
  fill(window, { terms: false });
  assert.equal(stripe.disabled, true);
  assert.equal(barion.disabled, true);
});

test('both payment buttons need both declarations and a valid billing e-mail, each one on its own', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  window.renderResultDocument(standardResult());
  window.openCheckoutModal();
  const digital = document.getElementById('consentDigital').closest('label').textContent.replace(/\s+/g, ' ').trim();
  assert.equal(digital, 'Tudomásul veszem és kifejezetten kérem, hogy a digitális tartalom szolgáltatása a sikeres fizetést követően azonnal megkezdődjön, és tudomásul veszem, hogy a teljesítés megkezdésével elveszítem a 14 napos elállási jogomat.');
  const state = () => ['checkoutSubmit', 'checkoutBarion'].map((id) => document.getElementById(id).disabled);

  assert.deepEqual(state(), [true, true], 'induláskor mindkettő letiltva');
  for (const broken of [{ terms: false }, { digital: false }, { terms: false, digital: false }, { email: '' }, { email: 'nem-email' }, { email: 'valaki@' }, { email: 'a@b' }, { email: 'a b@example.com' }]) {
    fill(window, broken);
    assert.deepEqual(state(), [true, true], `letiltva: ${JSON.stringify(broken)}`);
  }
  fill(window, { email: '  vevo@example.com  ' });
  assert.deepEqual(state(), [false, false], 'minden megvan: mindkettő kattintható');

  // Gépelés közben is frissül: az e-mail törlése azonnal letiltja a gombokat.
  const email = document.getElementById('checkoutEmail');
  email.value = '';
  email.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(state(), [true, true]);
  email.value = 'vevo@example.com';
  email.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(state(), [false, false]);
  document.getElementById('consentDigital').checked = false;
  document.getElementById('consentDigital').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(state(), [true, true]);
});

test('the Barion button sits next to the Stripe button with the required label', async (t) => {
  const window = await loadPlanner(t);
  const { document } = window;
  const barion = document.getElementById('checkoutBarion');
  assert.equal(barion.textContent.trim(), 'Fizetés Barionnal (Bankkártya)');
  assert.equal(barion.type, 'button');
  assert.equal(barion.parentElement, document.getElementById('checkoutSubmit').parentElement);
  assert.equal(document.getElementById('checkoutSubmit').type, 'submit');
});

test('a Stripe checkout without the consent is refused even if the form is submitted by script', async (t) => {
  const window = await loadPlanner(t);
  window.renderResultDocument(standardResult());
  window.openCheckoutModal();
  const calls = [];
  window.fetch = async (url) => { calls.push(String(url)); return Response.json({ success: true }); };
  fill(window, { terms: false });
  window.document.getElementById('checkoutForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  assert.match(window.document.getElementById('checkoutError').textContent, /ÁSZF/);
});

// ---------- Barion gomb: indítás és átirányítás ----------

function stubRedirect(window) {
  const targets = [];
  window.redirectTo = (url) => targets.push(url);
  return targets;
}

test('clicking the Barion button starts the payment and sends the user to the GatewayUrl', async (t) => {
  const window = await loadPlanner(t);
  window.renderResultDocument(academicResult());
  window.openCheckoutModal();
  const redirects = stubRedirect(window);
  const calls = [];
  window.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ success: true, paymentId: 'pay123', gatewayUrl: 'https://secure.test.barion.com/Pay?id=pay123', sessionId: 'barion_0123456789abcdef01234567', amountHuf: 690 });
  };
  fill(window);
  const barion = window.document.getElementById('checkoutBarion');
  barion.click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8000/api/checkout-barion');
  assert.deepEqual({ plan: calls[0].body.plan, planMode: calls[0].body.planMode, email: calls[0].body.email, generationId: calls[0].body.generationId },
    { plan: 'academic_daily', planMode: 'academic', email: 'vevo@example.com', generationId: 'gen_ui_academic' });
  assert.deepEqual(redirects, ['https://secure.test.barion.com/Pay?id=pay123']);
  assert.equal(window.localStorage.getItem('oviKretaPendingBarion'), 'barion_0123456789abcdef01234567');
  assert.equal(window.localStorage.getItem('oviKretaPendingCheckout'), 'gen_ui_academic');
  assert.equal(window.document.getElementById('checkoutError').textContent, '');
});

test('the Barion button refuses a foreign gateway address and shows server errors without redirecting', async (t) => {
  const window = await loadPlanner(t);
  window.renderResultDocument(standardResult());
  window.openCheckoutModal();
  const redirects = stubRedirect(window);
  const answers = [
    Response.json({ success: true, paymentId: 'p', gatewayUrl: 'https://secure.barion.com.evil.example/Pay', sessionId: 'barion_0123456789abcdef01234567' }),
    Response.json({ success: false, error: 'A Barion fizetés indítása sikertelen (ShopIsClosed).' }, { status: 502 })
  ];
  window.fetch = async () => answers.shift();
  fill(window);
  const error = window.document.getElementById('checkoutError');
  const barion = window.document.getElementById('checkoutBarion');

  barion.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(error.textContent, /érvénytelen fizetési címet/);
  barion.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(error.textContent, 'A Barion fizetés nem indítható: A Barion fizetés indítása sikertelen (ShopIsClosed).');
  assert.deepEqual(redirects, []);
  assert.equal(window.localStorage.getItem('oviKretaPendingBarion'), null);
  assert.equal(barion.disabled, false, 'a gomb újra használható');
});

test('a disabled Barion button does nothing, and a forced Barion call with a broken form is refused before any message', async (t) => {
  const window = await loadPlanner(t);
  window.renderResultDocument(standardResult());
  window.openCheckoutModal();
  let calls = 0;
  window.fetch = async () => { calls += 1; return Response.json({ success: true }); };
  const error = window.document.getElementById('checkoutError');
  const barion = window.document.getElementById('checkoutBarion');

  fill(window, { email: 'nem-email', digital: false });
  barion.click();
  assert.equal(error.textContent, '', 'letiltott gombra a kattintás semmit sem csinál');
  window.startBarionCheckout();
  assert.match(error.textContent, /érvényes e-mail/, 'szkriptből hívva is ellenőriz');
  fill(window, { digital: false });
  window.startBarionCheckout();
  assert.match(error.textContent, /mindkét nyilatkozat/);
  assert.equal(calls, 0);
});

test('the Stripe checkout sends the plan and plan mode of the document, and the payment buttons show the right price', async (t) => {
  const window = await loadPlanner(t);
  const cases = [
    [standardResult({ duration: 'Napi' }), 'daily', 'standard', 'Napi tervezet – 390 Ft'],
    [standardResult({ duration: 'Heti' }), 'weekly', 'standard', 'Heti alapcsomag – 390 Ft'],
    [academicResult(), 'academic_daily', 'academic', 'Oktatási célú napi tervezet – 690 Ft'],
    [thematicResult(), 'academic_weekly', 'academic', 'Oktatási célú heti tematikus terv – 690 Ft']
  ];
  for (const [result, plan, planMode, summary] of cases) {
    window.renderResultDocument(result);
    assert.equal(window.planKind(), plan);
    assert.equal(window.currentPlanMode(), planMode);
    window.openCheckoutModal();
    assert.equal(window.document.getElementById('checkoutSummary').textContent, summary);
    const price = plan.startsWith('academic') ? '690' : '390';
    assert.match(window.document.getElementById('unlockBtn')?.textContent || window.document.querySelector('.unlock-cta').textContent, new RegExp(`${price} Ft`), `${plan}: feloldó gomb`);

    let body;
    window.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ success: true, mock: true, message: 'mock', url: 'http://localhost:8000/?x=1' }); };
    fill(window);
    window.document.getElementById('checkoutForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(body.plan, plan);
    assert.equal(body.planMode, planMode);
    window.closeModals();
  }
});

test('the front end price table matches the server price table for every product', async (t) => {
  const window = await loadPlanner(t);
  const frontend = JSON.parse(JSON.stringify(window.eval('PAYWALL_PRICES')));
  assert.deepEqual(frontend, Object.fromEntries(Object.entries(PRODUCTS).map(([key, product]) => [key, product.amountHuf])));
  const labels = JSON.parse(JSON.stringify(window.eval('PLAN_LABELS')));
  assert.deepEqual(Object.keys(labels).sort(), Object.keys(PRODUCTS).sort());
});

const BARION_PNG_DIR = path.join(ROOT, 'assets', 'Barion adatok', 'png');

test('the official Barion banner files (light and dark, three sizes) are in the project as real PNGs', () => {
  for (const mode of ['Light', 'Dark']) {
    for (const size of ['Small', 'Medium', 'Large']) {
      const file = path.join(BARION_PNG_DIR, mode, `${size}-nobg-${mode.toLowerCase()}.png`);
      const data = fs.readFileSync(file);
      assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
      const [width, height] = [data.readUInt32BE(16), data.readUInt32BE(20)];
      assert.ok(width / height > 5 && width / height < 6, `${file}: eredeti, széles logósor-arány (${width}x${height})`);
    }
  }
});

test('every Barion strip uses the official light and dark banner in three sizes, with no size attributes that could distort it', () => {
  const pages = { 'tervezo.html': 2, 'index.html': 1 };
  for (const [page, expectedStrips] of Object.entries(pages)) {
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, page), 'utf8'));
    const strips = Array.from(dom.window.document.querySelectorAll('[data-barion-strip]'));
    assert.equal(strips.length, expectedStrips, page);
    for (const strip of strips) {
      for (const mode of ['light', 'dark']) {
        const picture = strip.querySelector(`picture.barion-pic-${mode}`);
        assert.ok(picture, `${page}: ${mode} változat`);
        const folder = mode === 'light' ? 'Light' : 'Dark';
        const sources = Array.from(picture.querySelectorAll('source')).map((source) => [source.getAttribute('media'), source.getAttribute('srcset')]);
        assert.deepEqual(sources, [
          ['(max-width: 380px)', `assets/Barion%20adatok/png/${folder}/Small-nobg-${mode}.png`],
          ['(max-width: 640px)', `assets/Barion%20adatok/png/${folder}/Medium-nobg-${mode}.png`]
        ], `${page}: kisebb képernyőn kisebb banner`);
        const img = picture.querySelector('img.barion-logo');
        assert.equal(img.getAttribute('src'), `assets/Barion%20adatok/png/${folder}/Large-nobg-${mode}.png`);
        for (const attribute of ['width', 'height', 'style']) assert.equal(img.hasAttribute(attribute), false, `${page}: nincs ${attribute} attribútum`);
        assert.match(img.getAttribute('alt'), /Barion Payment.*Barion, Mastercard, Visa, Apple Pay, Google Pay/);
        for (const reference of [img.getAttribute('src'), ...sources.map(([, srcset]) => srcset)]) {
          assert.ok(fs.existsSync(path.join(ROOT, decodeURI(reference))), `${page}: hiányzó fájl ${reference}`);
        }
      }
    }
  }
  assert.ok(new JSDOM(fs.readFileSync(path.join(ROOT, 'tervezo.html'), 'utf8')).window.document.querySelector('#checkoutForm [data-barion-strip]'), 'a fizetési ablakban');
  assert.ok(new JSDOM(fs.readFileSync(path.join(ROOT, 'tervezo.html'), 'utf8')).window.document.querySelector('#siteFooter [data-barion-strip]'), 'a láblécben');
});

test('the Barion strip CSS keeps the aspect ratio, adds no effects, keeps at least 8px around it and follows the theme', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const rule = (selector) => {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `hiányzó szabály: ${selector}`);
    return match[1];
  };
  const logo = rule('.barion-logo');
  assert.match(logo, /height:\s*auto/);
  assert.match(logo, /width:\s*min\(100%,\s*\d+px\)/, 'arányosan zsugorodik, de nem nyúlik');
  assert.doesNotMatch(logo, /background|border|box-shadow|filter|opacity|object-fit|max-height|clip|transform|overflow/, 'a logó nem módosítható');
  const padding = Number(rule('.barion-strip').match(/padding:\s*(\d+)px/)?.[1]);
  assert.ok(padding >= 8, `legalább 8px padding (${padding}px)`);
  assert.ok(Number(rule('.barion-strip').match(/margin:\s*(\d+)px/)?.[1]) >= 8, 'legalább 8px távolság a szomszédos elemektől');
  assert.match(css, /@media \(max-width: 640px\) \{ \.barion-logo \{ width: min\(100%, 300px\); \} \}/);
  assert.match(css, /@media \(max-width: 380px\) \{ \.barion-logo \{ width: min\(100%, 260px\); \} \}/);
  assert.match(rule('.barion-pic-dark'), /display:\s*none/);
  assert.match(css, /html\[data-theme="dark"\] \.barion-pic-light \{ display: none; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.barion-pic-dark \{ display: block; \}/);
  assert.match(rule('.checkout-box .barion-strip'), /position:\s*sticky;\s*bottom:\s*-26px/, 'a fizetési ablakban görgetés nélkül is látszik');
  assert.doesNotMatch(css, /barion-card-strip|logo-missing|barion-strip-text/);
});

test('the server serves the official banner images but never the Barion guide PDF or hidden files', async (t) => {
  const base = await listen(t);
  const image = await fetch(`${base}/assets/Barion%20adatok/png/Light/Large-nobg-light.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal((await image.arrayBuffer()).byteLength, fs.statSync(path.join(BARION_PNG_DIR, 'Light', 'Large-nobg-light.png')).size);
  for (const route of ['/assets/Barion%20adatok/Dev%20guide.pdf', '/assets/.DS_Store', '/assets/Barion%20adatok/.DS_Store', '/assets/..%2Fserver.js', '/assets/', '/assets/nincs.png']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  }
});

test('both builds copy the banner folders recursively and leave out the PDF and hidden files', () => {
  const os = require('node:os');
  const { copyAssets } = require('../scripts/copy-assets');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-assets-'));
  try {
    copyAssets(ROOT, out);
    for (const mode of ['Light', 'Dark']) for (const size of ['Small', 'Medium', 'Large']) {
      assert.ok(fs.existsSync(path.join(out, 'assets', 'Barion adatok', 'png', mode, `${size}-nobg-${mode.toLowerCase()}.png`)));
    }
    const copied = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : copied.push(entry.name)));
    walk(out);
    assert.ok(copied.every((name) => !name.startsWith('.') && !/\.pdf$/i.test(name)), copied.join(', '));
    assert.ok(copied.includes('og-preview.png'));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---------- Barion visszatérés: státuszlekérdezés, feloldás, kézbesítés ----------

const SESSION = 'barion_0123456789abcdef01234567';

async function loadReturn(t, { search = `?payment=barion&session_id=${SESSION}`, answers, pendingKey = true }) {
  const mirror = { ...planStore.createMirrorPlan(makePlan(8)), request: makePayload(), generationId: 'gen_ret1' };
  const calls = [];
  const dom = new JSDOM(plannerHtml, {
    url: `http://localhost:8000/tervezo.html${search}`,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.APP_CONFIG = { paywallEnabled: true, apiBaseUrl: 'same-origin' };
      const realTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms >= 1000 ? 1 : ms, ...args);
      window.localStorage.setItem('oviKreta_lastGeneration', JSON.stringify({ payload: '{}', result: mirror }));
      window.localStorage.setItem('oviKretaPendingCheckout', 'gen_ret1');
      if (pendingKey) window.localStorage.setItem('oviKretaPendingBarion', SESSION);
      window.fetch = async (url, options = {}) => {
        window.buildDeliveryFiles = async () => [{ name: 'terv.pdf', base64: 'eA==' }];
        calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        return answers(String(url), calls);
      };
    }
  });
  t.after(() => dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { window: dom.window, calls, mirror };
}

const sessionCalls = (calls) => calls.filter((call) => call.url.includes('/api/checkout-session/'));

test('returning from Barion polls the status until it is paid, then unlocks the document and starts the /api/deliver/ delivery', async (t) => {
  const full = { ...makePlan(8), request: makePayload(), generationId: 'gen_ret1' };
  const { window, calls } = await loadReturn(t, {
    answers: (url, all) => {
      if (url.includes('/api/checkout-session/')) {
        return sessionCalls(all).length < 3
          ? Response.json({ success: true, paid: false, pending: true, status: 'Started', provider: 'barion' })
          : Response.json({ success: true, paid: true, pending: false, status: 'Succeeded', provider: 'barion', emailEnabled: true, generationId: 'gen_ret1', planData: full });
      }
      return Response.json({ success: true, sent: true });
    }
  });
  const { document } = window;
  assert.equal(sessionCalls(calls).length, 3, 'addig kérdez, amíg a fizetés el nem dől');
  assert.ok(sessionCalls(calls).every((call) => call.url === `http://localhost:8000/api/checkout-session/${SESSION}`));
  assert.equal(window.isPlanLocked(), false);
  assert.equal(document.querySelector('.locked-mirror-text'), null, 'a valódi tartalom látszik');
  assert.equal(document.getElementById('unlockedBadge').hidden, false);
  assert.equal(window.currentPaidSessionId(), SESSION);
  assert.equal(document.getElementById('downloadInvoiceBtn').hidden, false, 'Barion-fizetésnél van számla');
  const deliver = calls.find((call) => call.url.includes('/api/deliver/'));
  assert.equal(deliver.url, `http://localhost:8000/api/deliver/${SESSION}`);
  assert.equal(deliver.method, 'POST');
  assert.deepEqual(deliver.body.files, [{ name: 'terv.pdf', base64: 'eA==' }]);
  assert.equal(window.localStorage.getItem('oviKretaPendingBarion'), null);
  assert.equal(window.localStorage.getItem('oviKretaPendingCheckout'), null);
  assert.equal(window.location.search, '', 'a visszatérési paraméterek törlődnek');
});

test('returning from a cancelled or failed Barion payment keeps the document locked and says so', async (t) => {
  for (const status of ['Canceled', 'Failed', 'Expired']) {
    const { window, calls } = await loadReturn(t, { answers: () => Response.json({ success: true, paid: false, pending: false, status, provider: 'barion' }) });
    assert.equal(window.isPlanLocked(), true, status);
    const banner = window.document.getElementById('generationErrorBanner');
    assert.match(banner.textContent, /Barion fizetés megszakadt vagy sikertelen/, status);
    assert.equal(window.localStorage.getItem('oviKretaPendingBarion'), null, status);
    assert.equal(calls.some((call) => call.url.includes('/api/deliver/')), false, status);
    assert.equal(sessionCalls(calls).length, 1, `${status}: végleges állapotnál nincs további lekérdezés`);
  }
});

test('a Barion payment that stays pending after the polling keeps the lock, the pending marker and an honest message', async (t) => {
  const { window, calls } = await loadReturn(t, { answers: () => Response.json({ success: true, paid: false, pending: true, status: 'InProgress', provider: 'barion' }) });
  assert.equal(sessionCalls(calls).length, 20);
  assert.equal(window.isPlanLocked(), true);
  assert.match(window.document.getElementById('generationErrorBanner').textContent, /megerősítése még tart/);
  assert.equal(window.localStorage.getItem('oviKretaPendingBarion'), SESSION, 'a következő betöltéskor újra rákérdez');
});

test('a pending Barion payment is checked once more on the next page load, silently, and unlocks when it was paid', async (t) => {
  const full = { ...makePlan(8), request: makePayload(), generationId: 'gen_ret1' };
  const paid = await loadReturn(t, {
    search: '',
    answers: (url) => (url.includes('/api/checkout-session/')
      ? Response.json({ success: true, paid: true, pending: false, status: 'Succeeded', provider: 'barion', emailEnabled: false, generationId: 'gen_ret1', planData: full })
      : Response.json({ success: true }))
  });
  assert.equal(paid.window.isPlanLocked(), false);
  assert.equal(paid.window.localStorage.getItem('oviKretaPendingBarion'), null);

  const stillPending = await loadReturn(t, { search: '', answers: () => Response.json({ success: true, paid: false, pending: true, status: 'Started', provider: 'barion' }) });
  assert.equal(sessionCalls(stillPending.calls).length, 1, 'újratöltéskor egyetlen lekérdezés');
  assert.equal(stillPending.window.document.getElementById('generationErrorBanner').hidden, true, 'nem zaklat hibaüzenettel');
  assert.equal(stillPending.window.localStorage.getItem('oviKretaPendingBarion'), SESSION);

  const none = await loadReturn(t, { search: '', pendingKey: false, answers: () => Response.json({}) });
  assert.equal(none.calls.length, 0, 'függő fizetés nélkül nincs hálózati hívás');
});

test('the price texts mention the academic price consistently on the landing page, the legal texts and the JSON-LD', () => {
  const landing = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(landing, /oktatási célú \(egyetemi\) tervezet <strong>690 Ft<\/strong>/);
  assert.equal((landing.match(/napi és heti formában is 690 Ft, bruttó/g) || []).length, 2, 'látható GYIK és JSON-LD egyezik');
  assert.match(landing, /"lowPrice":"390","highPrice":"890","offerCount":"3"/);
  const legal = fs.readFileSync(path.join(ROOT, 'site.js'), 'utf8');
  assert.equal((legal.match(/Oktatási célú tervezet \(napi foglalkozásterv vagy heti tematikus terv\): 690 Ft \(bruttó\)/g) || []).length, 2);
});
