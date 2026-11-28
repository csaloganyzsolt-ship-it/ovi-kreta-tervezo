const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');
const { BILLING_PROFILES, getBillingProfile, publicCompany } = require('../backend/services/siteConstants');
const invoiceService = require('../backend/services/invoiceService');
const stripeService = require('../backend/services/stripeService');
const { buildEmailContent } = require('../backend/services/mailService');

const ROOT = path.join(__dirname, '..');
const order = (plan, amountHuf = 390, extra = {}) => ({ plan, amountHuf, orderId: 'cs_1', customer: { email: 'a@b.hu' }, ...extra });

test('BILLING_PROFILE selects ev by default and kft only for the exact value kft', () => {
  assert.equal(getBillingProfile({}).type, 'ev');
  assert.equal(getBillingProfile({ BILLING_PROFILE: '' }).type, 'ev');
  assert.equal(getBillingProfile({ BILLING_PROFILE: 'ev' }).type, 'ev');
  assert.equal(getBillingProfile({ BILLING_PROFILE: 'valami' }).type, 'ev');
  assert.equal(getBillingProfile({ BILLING_PROFILE: 'KFT' }).type, 'ev');
  assert.equal(getBillingProfile({ BILLING_PROFILE: 'kft' }).type, 'kft');
});

test('both profiles carry the exact company data', () => {
  assert.deepEqual({ ...BILLING_PROFILES.ev }, {
    type: 'ev',
    name: 'Csalogány Zsolt egyéni vállalkozó',
    taxId: '68274568-1-28',
    regLabel: 'EV nyilvántartási szám',
    regNo: '51507048',
    court: '',
    address: '9153 Öttevény, Kossuth Lajos utca 26.',
    vatRate: 'AAM',
    vatNote: 'Alanyi adómentes (AAM) értékesítés, az árak 0 Ft ÁFÁ-t tartalmaznak.',
    invoicePrefix: ''
  });
  assert.deepEqual({ ...BILLING_PROFILES.kft }, {
    type: 'kft',
    name: 'CSB-Villamosság Kft.',
    taxId: '27891788-2-08',
    regLabel: 'Cégjegyzékszám',
    regNo: '08 09 031727',
    court: 'Győri Törvényszék Cégbírósága',
    address: '9153 Öttevény, Arany János utca 10.',
    vatRate: '27',
    vatNote: 'Az árak magyar forintban (HUF) értendők, és tartalmazzák a 27%-os általános forgalmi adót (ÁFA).',
    invoicePrefix: ''
  });
  assert.equal('vatRate' in publicCompany({}), false);
  assert.equal(publicCompany({ BILLING_PROFILE: 'kft' }).court, 'Győri Törvényszék Cégbírósága');
});

test('ev profile issues AAM invoices: net equals gross (the order amount), VAT is 0 Ft', () => {
  for (const [plan, gross] of [['daily', 390], ['weekly_summary', 590], ['weekly', 590], ['weekly_package', 890], ['weekly_detailed', 1090]]) {
    const xml = invoiceService.buildInvoiceXml(order(plan, gross, { selectedDayCount: 3 }), { SZAMLAZZ_KEY: 'k' });
    assert.match(xml, /<afakulcs>AAM<\/afakulcs>/);
    assert.match(xml, new RegExp(`<nettoEgysegar>${gross}</nettoEgysegar>`));
    assert.match(xml, new RegExp(`<nettoErtek>${gross}</nettoErtek>`));
    assert.match(xml, /<afaErtek>0<\/afaErtek>/);
    assert.match(xml, new RegExp(`<bruttoErtek>${gross}</bruttoErtek>`));
  }
});

test('kft profile issues 27% invoices from the order amount', () => {
  const env = { SZAMLAZZ_KEY: 'k', BILLING_PROFILE: 'kft' };
  const daily = invoiceService.buildInvoiceXml(order('daily'), env);
  assert.match(daily, /<afakulcs>27<\/afakulcs>/);
  assert.match(daily, /<nettoErtek>307<\/nettoErtek>/);
  assert.match(daily, /<afaErtek>83<\/afaErtek>/);
  assert.match(daily, /<bruttoErtek>390<\/bruttoErtek>/);
  const detailed = invoiceService.buildInvoiceXml(order('weekly_detailed', 890, { selectedDayCount: 3 }), env);
  assert.match(detailed, /<bruttoErtek>890<\/bruttoErtek>/);
  assert.match(detailed, /<afaErtek>189<\/afaErtek>/);
});

test('SZAMLAZZ_VAT_RATE overrides the profile VAT key', () => {
  assert.equal(invoiceService.vatRate({}), 'AAM');
  assert.equal(invoiceService.vatRate({ BILLING_PROFILE: 'kft' }), '27');
  assert.equal(invoiceService.vatRate({ SZAMLAZZ_VAT_RATE: '27' }), '27');
  assert.equal(invoiceService.vatRate({ BILLING_PROFILE: 'kft', SZAMLAZZ_VAT_RATE: 'AAM' }), 'AAM');
  const xml = invoiceService.buildInvoiceXml(order('daily'), { SZAMLAZZ_KEY: 'k', SZAMLAZZ_VAT_RATE: '27' });
  assert.match(xml, /<afakulcs>27<\/afakulcs>/);
  assert.match(xml, /<afaErtek>83<\/afaErtek>/);
});

test('invoice XML has no prefix element in either profile unless SZAMLAZZ_INVOICE_PREFIX is set', () => {
  for (const profile of ['ev', 'kft']) {
    const xml = invoiceService.buildInvoiceXml(order('daily'), { SZAMLAZZ_KEY: 'k', BILLING_PROFILE: profile });
    assert.doesNotMatch(xml, /szamlaszamElotag/, profile);
    assert.equal(invoiceService.invoicePrefix({ BILLING_PROFILE: profile }), '');
  }
  const custom = invoiceService.buildInvoiceXml(order('daily'), { SZAMLAZZ_KEY: 'k', BILLING_PROFILE: 'kft', SZAMLAZZ_INVOICE_PREFIX: 'CSB' });
  assert.doesNotMatch(custom, /szamlaszamElotag|CSB/);
});

test('Számlázz.hu Agent key follows the active profile with shared fallbacks', () => {
  const keys = { SZAMLAZZ_API_KEY_EV: 'ev-key', SZAMLAZZ_API_KEY_KFT: 'kft-key', SZAMLAZZ_API_KEY: 'shared' };
  assert.equal(invoiceService.szamlazzApiKey(keys), 'ev-key');
  assert.equal(invoiceService.szamlazzApiKey({ ...keys, BILLING_PROFILE: 'kft' }), 'kft-key');
  assert.equal(invoiceService.szamlazzApiKey({ SZAMLAZZ_API_KEY: 'shared', SZAMLAZZ_API_KEY_KFT: 'kft-key' }), 'shared');
  assert.equal(invoiceService.szamlazzApiKey({ BILLING_PROFILE: 'kft', SZAMLAZZ_API_KEY: 'shared', SZAMLAZZ_API_KEY_EV: 'ev-key' }), 'shared');
  assert.equal(invoiceService.szamlazzApiKey({ SZAMLAZZ_KEY: 'legacy' }), 'legacy');
  assert.equal(invoiceService.szamlazzApiKey({}), '');
  const xml = invoiceService.buildInvoiceXml(order('daily'), { ...keys, BILLING_PROFILE: 'kft' });
  assert.match(xml, /<szamlaagentkulcs>kft-key<\/szamlaagentkulcs>/);
});

test('Stripe secret and webhook keys follow the active profile with shared fallbacks', () => {
  const env = {
    STRIPE_SECRET_KEY_EV: 'sk_test_ev', STRIPE_SECRET_KEY_KFT: 'sk_live_kft', STRIPE_SECRET_KEY: 'sk_shared',
    STRIPE_WEBHOOK_SECRET_EV: 'whsec_ev', STRIPE_WEBHOOK_SECRET_KFT: 'whsec_kft', STRIPE_WEBHOOK_SECRET: 'whsec_shared'
  };
  assert.equal(stripeService.stripeSecretKey(env), 'sk_test_ev');
  assert.equal(stripeService.stripeWebhookSecret(env), 'whsec_ev');
  assert.equal(stripeService.stripeSecretKey({ ...env, BILLING_PROFILE: 'kft' }), 'sk_live_kft');
  assert.equal(stripeService.stripeWebhookSecret({ ...env, BILLING_PROFILE: 'kft' }), 'whsec_kft');
  assert.equal(stripeService.stripeSecretKey({ STRIPE_SECRET_KEY: 'sk_shared', STRIPE_SECRET_KEY_KFT: 'x' }), 'sk_shared');
  assert.equal(stripeService.stripeWebhookSecret({ STRIPE_WEBHOOK_SECRET: 'whsec_shared' }), 'whsec_shared');
  assert.equal(stripeService.isTestMode(env), true);
  assert.equal(stripeService.isTestMode({ ...env, BILLING_PROFILE: 'kft' }), false);
  assert.equal(stripeService.isLive({}), false);
});

test('checkout uses the profile Stripe client key', async () => {
  const seen = [];
  const client = { checkout: { sessions: { create: async (p) => { seen.push(p); return { id: 'cs_test_1', url: 'https://stripe/t' }; } } } };
  const result = await stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env: { STRIPE_SECRET_KEY_KFT: 'sk_test_k', BILLING_PROFILE: 'kft' }, client });
  assert.equal(result.mock, false);
  assert.equal(result.testMode, true);
  assert.equal(seen[0].line_items[0].price_data.unit_amount, 39000);
});

test('the mail footer shows the active profile registration label', () => {
  const ev = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true }, {});
  assert.match(ev.html, /Csalogány Zsolt egyéni vállalkozó/);
  assert.match(ev.html, /EV nyilvántartási szám: 51507048/);
  assert.doesNotMatch(ev.html, /CSB-Villamosság|27891788/);
  const kft = buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true }, { BILLING_PROFILE: 'kft' });
  assert.match(kft.html, /CSB-Villamosság Kft\./);
  assert.match(kft.html, /Cégjegyzékszám: 08 09 031727/);
});

function evalConfig(code) {
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.APP_CONFIG));
}

test('/config.js serves the active profile company data', async (t) => {
  const { app } = require('../backend/server');
  const saved = process.env.BILLING_PROFILE;
  t.after(() => { if (saved === undefined) delete process.env.BILLING_PROFILE; else process.env.BILLING_PROFILE = saved; });
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const read = async () => evalConfig(await (await fetch(`http://127.0.0.1:${instance.address().port}/js/config.js`)).text()).company;

  delete process.env.BILLING_PROFILE;
  assert.deepEqual(await read(), { ...publicCompany({}), email: 'info@ovitervezo.hu', stripeTestMode: stripeService.isTestMode(process.env) });
  process.env.BILLING_PROFILE = 'kft';
  const kft = await read();
  assert.equal(kft.name, 'CSB-Villamosság Kft.');
  assert.equal(kft.regLabel, 'Cégjegyzékszám');
  assert.equal(kft.court, 'Győri Törvényszék Cégbírósága');
  assert.equal('vatRate' in kft, false);
});

test('both build scripts pass the active profile and rename the static publisher', () => {
  for (const [script, dir] of [['scripts/build-nethely.js', 'dist-nethely']]) {
    const run = (profile) => {
      execFileSync('node', [script], { cwd: ROOT, env: { ...process.env, BILLING_PROFILE: profile } });
      return {
        cfg: evalConfig(fs.readFileSync(path.join(ROOT, dir, 'js', 'config.js'), 'utf8')),
        index: fs.readFileSync(path.join(ROOT, dir, 'index.html'), 'utf8')
      };
    };
    const ev = run('');
    assert.equal(ev.cfg.company.type, 'ev', script);
    assert.equal(ev.cfg.company.regNo, '51507048');
    assert.equal(ev.cfg.company.email, 'info@ovitervezo.hu');
    assert.match(ev.index, /"publisher":\{"@type":"Organization","name":"Csalogány Zsolt egyéni vállalkozó"\}/);
    const kft = run('kft');
    assert.equal(kft.cfg.company.type, 'kft', script);
    assert.equal(kft.cfg.company.name, 'CSB-Villamosság Kft.');
    assert.equal(kft.cfg.company.court, 'Győri Törvényszék Cégbírósága');
    assert.match(kft.index, /"publisher":\{"@type":"Organization","name":"CSB-Villamosság Kft\."\}/);
    assert.doesNotMatch(kft.index, /Csalogány Zsolt/);
  }
  execFileSync('node', ['scripts/build-nethely.js'], { cwd: ROOT, env: { ...process.env, BILLING_PROFILE: '' } });
});

async function loadPage(t, page, company) {
  const dom = new JSDOM(readPage(page), {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.APP_CONFIG = { paywallEnabled: true, apiBaseUrl: 'same-origin', company: company && { ...company, email: 'info@ovitervezo.hu' } };
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  return dom.window;
}

function legalText(window, key) {
  window.document.querySelector(`[data-legal="${key}"]`).click();
  return window.document.getElementById('legalModalBody').textContent;
}

for (const page of ['index.html', 'tervezo.html']) {
  test(`${page} footer and legal texts follow the ev profile`, async (t) => {
    for (const company of [publicCompany({}), undefined]) {
      const window = await loadPage(t, page, company);
      const doc = window.document;
      assert.equal(doc.getElementById('footerRegLabel').textContent, 'EV nyilvántartási szám');
      assert.equal(doc.getElementById('footerRegNo').textContent, '51507048');
      assert.equal(doc.getElementById('footerCourtRow').hidden, true);
      const footer = doc.getElementById('siteFooter').textContent;
      assert.match(footer, /EV nyilvántartási szám: 51507048/);
      assert.match(footer, /68274568-1-28/);
      assert.match(footer, /9153 Öttevény, Kossuth Lajos utca 26\./);
      assert.doesNotMatch(footer, /CSB-Villamosság|Cégjegyzékszám/);

      const terms = legalText(window, 'terms');
      assert.match(terms, /Szolgáltató neve: Csalogány Zsolt egyéni vállalkozó/);
      assert.match(terms, /EV nyilvántartási szám: 51507048/);
      assert.match(terms, /Adószám: 68274568-1-28/);
      assert.match(terms, /Alanyi adómentes \(AAM\) értékesítés, az árak 0 Ft ÁFÁ-t tartalmaznak\./);
      assert.match(terms, /info@ovitervezo\.hu/);
      assert.doesNotMatch(terms, /27%|CSB-Villamosság|Győri Törvényszék/);
      for (const key of ['privacy', 'billing']) {
        const text = legalText(window, key);
        assert.doesNotMatch(text, /CSB-Villamosság|Cégjegyzékszám|27%|\{\{/, key);
        assert.match(text, /Csalogány Zsolt egyéni vállalkozó/, key);
      }
      assert.match(legalText(window, 'privacy'), /Székhely: 9153 Öttevény, Kossuth Lajos utca 26\./);
    }
  });

  test(`${page} footer and legal texts follow the kft profile`, async (t) => {
    const window = await loadPage(t, page, publicCompany({ BILLING_PROFILE: 'kft' }));
    const doc = window.document;
    assert.equal(doc.getElementById('footerRegLabel').textContent, 'Cégjegyzékszám');
    assert.equal(doc.getElementById('footerCourtRow').hidden, false);
    const footer = doc.getElementById('siteFooter').textContent;
    assert.match(footer, /Cégjegyzékszám: 08 09 031727/);
    assert.match(footer, /Cégbíróság: Győri Törvényszék Cégbírósága/);
    assert.match(footer, /27891788-2-08/);
    assert.match(footer, /CSB-Villamosság Kft\./);

    const terms = legalText(window, 'terms');
    assert.match(terms, /Szolgáltató neve: CSB-Villamosság Kft\./);
    assert.match(terms, /Cégjegyzékszám: 08 09 031727 \(Győri Törvényszék Cégbírósága\)/);
    assert.match(terms, /tartalmazzák a 27%-os általános forgalmi adót \(ÁFA\)/);
    assert.match(terms, /Székhely: 9153 Öttevény, Arany János utca 10\./);
    assert.doesNotMatch(terms, /Alanyi adómentes|Csalogány Zsolt/);
    assert.match(legalText(window, 'billing'), /A számlát a CSB-Villamosság Kft\. állítja ki/);
    assert.match(legalText(window, 'privacy'), /Adatkezelő: CSB-Villamosság Kft\./);
  });
}

test('site.js carries no hard-coded company data besides the ev fallback that mirrors the profile', () => {
  const site = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'site.js'), 'utf8');
  assert.doesNotMatch(site, /CSB-Villamosság|27891788|08 09 031727|Arany János utca|Győri Törvényszék|27%-os/);
  const ev = BILLING_PROFILES.ev;
  for (const value of [ev.name, ev.taxId, ev.regLabel, ev.regNo, ev.address, ev.vatNote]) assert.ok(site.includes(`'${value}'`), value);
});

test('ertekeles.html loads the shared site script for the company-aware legal texts', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'frontend', 'ertekeles.html'), 'utf8'), /<script src="js\/site\.js"><\/script>/);
});

const ALL_KEYS = {
  STRIPE_PUBLISHABLE_KEY_EV: 'pk_ev', STRIPE_SECRET_KEY_EV: 'sk_ev', STRIPE_WEBHOOK_SECRET_EV: 'wh_ev', SZAMLAZZ_API_KEY_EV: 'sz_ev',
  STRIPE_PUBLISHABLE_KEY_KFT: 'pk_kft', STRIPE_SECRET_KEY_KFT: 'sk_kft', STRIPE_WEBHOOK_SECRET_KFT: 'wh_kft', SZAMLAZZ_API_KEY_KFT: 'sz_kft'
};

test('each profile reads only its own keys when both sets are present', () => {
  for (const [profile, suffix] of [['ev', 'ev'], ['kft', 'kft']]) {
    const env = { ...ALL_KEYS, BILLING_PROFILE: profile };
    assert.equal(stripeService.stripePublishableKey(env), `pk_${suffix}`);
    assert.equal(stripeService.stripeSecretKey(env), `sk_${suffix}`);
    assert.equal(stripeService.stripeWebhookSecret(env), `wh_${suffix}`);
    assert.equal(invoiceService.szamlazzApiKey(env), `sz_${suffix}`);
  }
});

test('a missing profile key never falls back to the other profile key', () => {
  const onlyKft = Object.fromEntries(Object.entries(ALL_KEYS).filter(([key]) => key.endsWith('_KFT')));
  const onlyEv = Object.fromEntries(Object.entries(ALL_KEYS).filter(([key]) => key.endsWith('_EV')));
  for (const [env, active] of [[{ ...onlyKft }, 'ev'], [{ ...onlyEv, BILLING_PROFILE: 'kft' }, 'kft']]) {
    const effective = { ...env, BILLING_PROFILE: active === 'kft' ? 'kft' : undefined };
    assert.equal(stripeService.stripePublishableKey(effective), '');
    assert.equal(stripeService.stripeSecretKey(effective), '');
    assert.equal(stripeService.stripeWebhookSecret(effective), '');
    assert.equal(invoiceService.szamlazzApiKey(effective), '');
    assert.equal(stripeService.isLive(effective), false);
  }
});

test('the shared keys are the only fallback, including the publishable key', () => {
  const shared = { STRIPE_PUBLISHABLE_KEY: 'pk_shared', STRIPE_SECRET_KEY: 'sk_shared', STRIPE_WEBHOOK_SECRET: 'wh_shared', SZAMLAZZ_API_KEY: 'sz_shared' };
  for (const profile of ['ev', 'kft']) {
    const env = { ...shared, BILLING_PROFILE: profile };
    assert.equal(stripeService.stripePublishableKey(env), 'pk_shared');
    assert.equal(stripeService.stripeSecretKey(env), 'sk_shared');
    assert.equal(stripeService.stripeWebhookSecret(env), 'wh_shared');
    assert.equal(invoiceService.szamlazzApiKey(env), 'sz_shared');
  }
});

test('a missing key in production gives a clear error naming the active profile and never uses the other key', async () => {
  const env = { NODE_ENV: 'production', STRIPE_SECRET_KEY_KFT: 'sk_live_kft', SZAMLAZZ_API_KEY_KFT: 'sz_kft' };
  await assert.rejects(
    stripeService.createCheckoutSession({ plan: 'daily', email: 'a@b.hu' }, { env }),
    (error) => error.status === 503 && /STRIPE_SECRET_KEY_EV/.test(error.message) && /aktív profil: ev/.test(error.message)
  );
  assert.throws(() => stripeService.constructWebhookEvent('{}', 'sig', { env }), /STRIPE_WEBHOOK_SECRET_EV.*aktív profil: ev/);
  await assert.rejects(
    invoiceService.issueInvoice({ orderId: 'cs_x', plan: 'daily', customer: { email: 'a@b.hu' } }, { env: { ...env }, fetch: async () => { throw new Error('nem hívható'); } }),
    /SZAMLAZZ_API_KEY_EV.*aktív profil: ev/
  );
});

test('/config.js publishes the publishable key of the active profile only', async (t) => {
  const { app } = require('../backend/server');
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, ALL_KEYS);
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const read = async () => evalConfig(await (await fetch(`http://127.0.0.1:${instance.address().port}/js/config.js`)).text());
  delete process.env.BILLING_PROFILE;
  assert.equal((await read()).stripePublishableKey, 'pk_ev');
  process.env.BILLING_PROFILE = 'kft';
  assert.equal((await read()).stripePublishableKey, 'pk_kft');
});

test('/health reports the active billing profile with booleans only and never leaks a secret', async (t) => {
  const { app } = require('../backend/server');
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|SZAMLAZZ_|BILLING_PROFILE)/.test(key)) delete process.env[key];
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${instance.address().port}/health`);
    const text = await response.text();
    return { body: JSON.parse(text), text };
  };

  let { body } = await health();
  assert.equal(body.ok, true);
  assert.deepEqual({ ...body.billing, modes: undefined, profiles: undefined, supabase: undefined }, {
    profile: 'ev',
    companyName: 'Csalogány Zsolt egyéni vállalkozó',
    vatRate: 'AAM',
    hasInvoicePrefix: false,
    modes: undefined,
    profiles: undefined,
    supabase: undefined,
    keys: { stripePublishable: false, stripeSecret: false, stripeWebhook: false, szamlazzApiKey: false }
  });
  assert.deepEqual(Object.keys(body.billing.supabase).sort(), ['connected', 'keySet', 'keySource', 'urlSet']);
  assert.equal(body.billing.supabase.connected, false);
  assert.deepEqual(Object.keys(body.billing.modes).sort(), ['barion', 'stripe', 'szamlazz']);
  for (const type of ['ev', 'kft']) for (const value of Object.values(body.billing.profiles[type])) assert.equal(typeof value, 'boolean');

  Object.assign(process.env, ALL_KEYS, { BILLING_PROFILE: 'ev', SZAMLAZZ_INVOICE_PREFIX: 'ABC' });
  let result = await health();
  assert.deepEqual(result.body.billing.keys, { stripePublishable: true, stripeSecret: true, stripeWebhook: true, szamlazzApiKey: true });
  assert.equal(result.body.billing.hasInvoicePrefix, true);
  for (const secret of Object.values(ALL_KEYS)) assert.equal(result.text.includes(secret), false, secret);

  process.env.BILLING_PROFILE = 'kft';
  delete process.env.SZAMLAZZ_API_KEY_KFT;
  delete process.env.SZAMLAZZ_INVOICE_PREFIX;
  result = await health();
  assert.equal(result.body.billing.profile, 'kft');
  assert.equal(result.body.billing.companyName, 'CSB-Villamosság Kft.');
  assert.equal(result.body.billing.vatRate, '27');
  assert.equal(result.body.billing.hasInvoicePrefix, false);
  assert.deepEqual(result.body.billing.keys, { stripePublishable: true, stripeSecret: true, stripeWebhook: true, szamlazzApiKey: false });
  for (const secret of Object.values(ALL_KEYS)) assert.equal(result.text.includes(secret), false, secret);
  for (const value of Object.values(result.body.billing.keys)) assert.equal(typeof value, 'boolean');
});

test('EV webhook end to end: _EV keys, AAM, net = gross, no prefix, retry after a Számlázz.hu error', async (t) => {
  const Stripe = require('stripe');
  const { app } = require('../backend/server');
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  for (const key of Object.keys(process.env)) if (/^(STRIPE_|SZAMLAZZ_|BILLING_PROFILE)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    BILLING_PROFILE: 'ev', STRIPE_SECRET_KEY_EV: 'sk_test_ev', STRIPE_WEBHOOK_SECRET_EV: 'whsec_ev', SZAMLAZZ_API_KEY_EV: 'agent-ev',
    STRIPE_SECRET_KEY_KFT: 'sk_test_kft', STRIPE_WEBHOOK_SECRET_KFT: 'whsec_kft', SZAMLAZZ_API_KEY_KFT: 'agent-kft'
  });
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));

  const realFetch = global.fetch;
  let xml = '';
  let failNext = false;
  global.fetch = async (url, options) => {
    if (!String(url).includes('szamlazz.hu')) return realFetch(url, options);
    xml = await options.body.get('action-xmlagentxmlfile').text();
    if (failNext) return { ok: true, headers: new Map([['szlahu_error', 'Hib%C3%A1s'], ['szlahu_error_code', '57']]) };
    return { ok: true, headers: new Map([['szlahu_szamlaszam', 'E-1']]), arrayBuffer: async () => Buffer.from('%PDF-1.4 x') };
  };
  t.after(() => { global.fetch = realFetch; });

  const post = (secret, plan, id) => {
    const payload = JSON.stringify({ id: `evt_${id}`, object: 'event', type: 'checkout.session.completed', data: { object: { id, payment_status: 'paid', amount_total: (plan === 'daily' ? 390 : 890) * 100, metadata: { plan }, customer_details: { name: 'Vevő', email: 'vevo@example.com', address: { postal_code: '1111', city: 'Bp', line1: 'Fő u. 1' } } } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return realFetch(`http://127.0.0.1:${instance.address().port}/api/webhook/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
  };

  assert.equal((await post('whsec_ungessable', 'daily', 'cs_test_badsig')).status, 400, 'ismeretlen titkú webhook elutasítva');
  assert.equal((await post('whsec_kft', 'daily', 'cs_test_kftprofile')).status, 200, 'a másik profil titkával érkezett esemény is elfogadott');
  assert.match(xml, /<szamlaagentkulcs>agent-kft<\/szamlaagentkulcs>/, 'a számla a webhook profiljának kulcsával készül');
  assert.match(xml, /<afakulcs>27<\/afakulcs>/);

  for (const [plan, gross] of [['daily', 390], ['weekly_detailed', 890]]) {
    const response = await post('whsec_ev', plan, `cs_test_${plan}`);
    assert.equal(response.status, 200);
    assert.match(xml, /<szamlaagentkulcs>agent-ev<\/szamlaagentkulcs>/);
    assert.match(xml, /<afakulcs>AAM<\/afakulcs>/);
    assert.match(xml, new RegExp(`<nettoEgysegar>${gross}</nettoEgysegar>`));
    assert.match(xml, new RegExp(`<nettoErtek>${gross}</nettoErtek>`));
    assert.match(xml, /<afaErtek>0<\/afaErtek>/);
    assert.match(xml, new RegExp(`<bruttoErtek>${gross}</bruttoErtek>`));
    assert.doesNotMatch(xml, /szamlaszamElotag/);
    assert.doesNotMatch(xml, /agent-kft/);
  }

  failNext = true;
  const failed = await post('whsec_ev', 'daily', 'cs_test_failing');
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /Számlázz\.hu hiba \(57\): Hibás/);
  failNext = false;
  assert.equal((await post('whsec_ev', 'daily', 'cs_test_failing')).status, 200, 'a Stripe újrapróbálása után kiállítja a számlát');
});

test('index.html shows the announcement bar from /api/config as plain text only when enabled, and only on the landing page', async (t) => {
  const make = async (page, announcement) => {
    const dom = new JSDOM(readPage(page), {
      url: 'http://localhost:8000',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.scrollTo = () => {};
        window.APP_CONFIG = { apiBaseUrl: 'same-origin' };
        window.fetch = async () => Response.json({ success: true, paymentProvider: 'barion', announcement_bar: announcement });
      }
    });
    t.after(() => dom.window.close());
    if (dom.window.document.readyState === 'loading') await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return dom.window.document;
  };
  const on = await make('index.html', { enabled: true, text: 'Őszi <b>akció</b>' });
  const bar = on.getElementById('announcementBar');
  assert.ok(bar && bar.classList.contains('announcement-bar'));
  assert.equal(bar.textContent, 'Őszi <b>akció</b>');
  assert.equal(bar.querySelector('b'), null, 'nincs HTML injektálás');
  assert.equal((await make('index.html', { enabled: false, text: 'Rejtett' })).getElementById('announcementBar'), null);
  assert.equal((await make('tervezo.html', { enabled: true, text: 'Nem itt' })).getElementById('announcementBar'), null);
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'styles.css'), 'utf8');
  assert.match(css, /\.announcement-bar\s*\{/);
  assert.match(css, /\[data-theme="dark"\] \.announcement-bar/);
});
