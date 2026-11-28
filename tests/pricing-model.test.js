const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { readPage, TEST_PRICING } = require('./fixtures');
const settingsService = require('../backend/services/settingsService');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const digits = (text) => String(text).replace(/\s|\u00a0/g, '');

// ---------- Statikus alapértékek és a szerver-oldali alapárak egyezése ----------

test('the static landing defaults match the server defaults and the visible FAQ equals the FAQPage JSON-LD', () => {
  const html = read('frontend', 'index.html');
  const defaults = settingsService.DEFAULT_SETTINGS.pricing;
  assert.deepEqual(defaults, TEST_PRICING);

  const expected = { ...defaults, weekly_max: defaults.weekly_summary + 5 * defaults.weekly_extra_day };
  const dom = new JSDOM(html);
  const nodes = [...dom.window.document.querySelectorAll('[data-price]')];
  assert.ok(nodes.length >= 5, 'a főoldalon vannak árak');
  for (const node of nodes) {
    assert.ok(node.dataset.price in expected, `ismeretlen data-price: ${node.dataset.price}`);
    assert.equal(digits(node.textContent), `${expected[node.dataset.price]}Ft`, `a statikus ár eltér: ${node.dataset.price}`);
  }
  assert.deepEqual(new Set(nodes.map((node) => node.dataset.price)), new Set(['daily', 'weekly_summary', 'weekly_extra_day', 'academic_daily', 'academic_weekly', 'weekly_max']));

  const blocks = [...html.matchAll(/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const faq = blocks.find((block) => block['@type'] === 'FAQPage');
  const offers = blocks.find((block) => block['@type'] === 'SoftwareApplication').offers;
  assert.equal(offers['@type'], 'AggregateOffer');
  assert.equal(offers.lowPrice, '390');
  assert.equal(offers.highPrice, '1090');
  assert.equal(Number(offers.offerCount), 4);

  const items = [...dom.window.document.querySelectorAll('details')];
  const norm = (text) => text.replace(/\s+/g, ' ').trim();
  for (const entry of faq.mainEntity) {
    const details = items.find((item) => norm(item.querySelector('summary').textContent) === entry.name);
    assert.ok(details, `a kérdés látható a főoldalon: ${entry.name}`);
    assert.equal(norm(entry.acceptedAnswer.text), norm(details.querySelector('p').textContent), `a JSON-LD válasz szó szerint egyezik a látható szöveggel: ${entry.name}`);
  }
  const priceAnswer = faq.mainEntity.find((entry) => /Mennyibe kerül/.test(entry.name)).acceptedAnswer.text;
  assert.equal(priceAnswer, 'Egyszeri díj, havidíj nélkül: a napi tervezet 390 Ft, a heti összesítő 590 Ft, a teljes heti csomag a heti összesítő árához kidolgozott naponként 100 Ft felárat számít (5 nap esetén 1 090 Ft), az oktatási célú (egyetemi) tervezet napi formában 690 Ft, heti formában 690 Ft, bruttó.');
});

test('the legal texts use price placeholders only, and every price token is defined', () => {
  const source = read('frontend', 'js', 'site.js');
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(readPage('index.html'), { url: 'http://localhost:8000', runScripts: 'dangerously', virtualConsole, beforeParse(window) { window.fetch = async () => { throw new Error('nincs hálózat'); }; } });
  const text = JSON.stringify(dom.window.eval('LEGAL_TEXTS'));
  dom.window.close();
  for (const token of ['PRICE_DAILY', 'PRICE_WEEKLY_SUMMARY', 'PRICE_WEEKLY_EXTRA_DAY', 'PRICE_ACADEMIC_DAILY', 'PRICE_ACADEMIC_WEEKLY']) {
    assert.ok(text.includes(`{{${token}}}`), `hiányzó helyőrző: ${token}`);
    assert.ok(source.includes(`${token}:`), `a ${token} nincs feltöltve az openLegalModal-ban`);
  }
  assert.doesNotMatch(text, /\b(390|590|690|890|1\s?090)\s?Ft/, 'az ÁSZF-ben nincs beégetett ár');
  assert.doesNotMatch(text, /\b(?:390|590|690|890|1090)\b/, 'az ÁSZF-ben nincs beégetett összeg');
});

test('barion-pixel.js and the paywall script carry no hard-coded prices', () => {
  for (const file of ['barion-pixel.js', 'tervezo-paywall.js', 'tervezo-form.js']) {
    const code = read('frontend', 'js', file);
    assert.doesNotMatch(code, /\b(390|590|690|890|1090)\b/, `${file}: beégetett ár`);
  }
  assert.doesNotMatch(read('frontend', 'js', 'tervezo-paywall.js'), /PAYWALL_PRICES/);
});

// ---------- OviPricing és a tervező 1. lépésének árjelzése ----------

function plannerWindow(t, { pricing = true, errors = [] } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(readPage('tervezo.html', { pricing }), {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = async (url) => {
        if (!String(url).endsWith('/api/config') || !pricing) throw new Error(`váratlan kérés: ${url}`);
        return { ok: true, status: 200, json: async () => ({ success: true, pricing: TEST_PRICING, maintenance_mode: false }) };
      };
    }
  });
  t.after(() => dom.window.close());
  return dom.window;
}

test('OviPricing.priceFor returns null and logs a console error while the prices are not loaded', async (t) => {
  const errors = [];
  const window = plannerWindow(t, { pricing: false, errors });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const { OviPricing } = window;
  assert.equal(OviPricing.isLoaded(), false);
  assert.equal(OviPricing.priceFor('daily'), null);
  assert.equal(OviPricing.priceLabel('weekly_package', 3), null);
  assert.ok(errors.some((message) => /árak nem töltődtek be/.test(message)), 'console.error jelzi a hiányzó árakat');

  OviPricing.setPricing(TEST_PRICING);
  assert.equal(OviPricing.isLoaded(), true);
  assert.deepEqual([1, 2, 3, 4, 5].map((days) => OviPricing.priceFor('weekly_package', days)), [690, 790, 890, 990, 1090]);
  assert.equal(OviPricing.priceFor('weekly_summary'), 590);
  assert.equal(OviPricing.priceFor('daily'), 390);
  assert.equal(OviPricing.priceFor('academic_daily'), 690);
  assert.equal(OviPricing.priceFor('academic_weekly'), 690);
});

test('step 1 shows the discreet price hint "590 Ft + 3 × 100 Ft = 890 Ft" for three selected days', async (t) => {
  const window = plannerWindow(t);
  const { document } = window;
  await new Promise((resolve) => setTimeout(resolve, 30));
  window.setDurationSelection('Heti');
  document.querySelector('.segment[data-group="weeklyScope"][data-value="package"]').click();
  document.querySelector('#weeklyDayPicker [data-day="Csütörtök"]').click();
  document.querySelector('#weeklyDayPicker [data-day="Péntek"]').click();
  assert.deepEqual([...window.buildGenerationPayload().selectedDays], ['Hétfő', 'Kedd', 'Szerda']);
  window.updateSummary();

  const hint = document.getElementById('weeklyPriceSummary').textContent.replace(/\s+/g, ' ');
  assert.match(hint, /590 Ft \+ 3 × 100 Ft = 890 Ft/);
  assert.match(document.getElementById('stepPriceNote').textContent, /890 Ft \(590 Ft \+ 3 × 100 Ft\)/);
  assert.match(document.querySelector('[data-price-for="scope-package"]').textContent, /590 Ft \+ 100 Ft \/ nap/);

  document.querySelector('.segment[data-group="weeklyScope"][data-value="summary"]').click();
  window.updateSummary();
  assert.equal(document.getElementById('weeklyPriceSummary').textContent.trim(), '', 'csak összesítőnél nincs csomag-árjelzés');
  assert.match(document.getElementById('stepPriceNote').textContent, /590 Ft/);
});
