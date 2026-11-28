'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const consentSource = read('frontend', 'js', 'cookie-consent.js');
const trackingSource = read('frontend', 'js', 'tracking.js');
const telemetrySource = read('frontend', 'js', 'telemetry.js');
const settingsService = require('../backend/services/settingsService');
const { computeFunnel } = require('../backend/services/analyticsService');
const { FUNNEL_STEPS, ALLOWED_EVENTS, sanitizeSessionId } = require('../backend/services/telemetryService');
const paymentRoutes = fs.readFileSync(path.join(root, 'backend', 'routes', 'payment.js'), 'utf8');

const PUBLIC_PAGES = ['index.html', 'tervezo.html', 'profil.html', 'ertekeles.html', 'leiratkozas.html'];
const TRACKING = { barion_pixel_id: 'BP-Teszt12345-A', ga4_measurement_id: 'G-TESZT12345', meta_pixel_id: '1234567890123' };
const CONSENT_VERSION = /CONSENT_VERSION = '([^']+)'/.exec(consentSource)[1];

function stored(analytics, marketing) {
  return JSON.stringify({ version: CONSENT_VERSION, necessary: true, analytics, marketing, ts: new Date().toISOString() });
}

// Teljes oldal (HTML), a három hozzájárulás-függő szkripttel; a külső szkriptek nem töltődnek le, csak a beszúrt <script> elemek figyelhetők.
async function loadPage({ page = 'index.html', consent = null, tracking = TRACKING, pathname } = {}) {
  const dom = new JSDOM(read('frontend', page), { url: `https://ovitervezo.test${pathname || (page === 'index.html' ? '/' : `/${page}`)}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const fetches = [];
  window.fetch = (url, options) => { fetches.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null }); return Promise.resolve({ ok: true }); };
  window.APP_CONFIG = { apiBaseUrl: 'https://api.test', trackingConfig: tracking };
  if (consent) window.localStorage.setItem('ovi_cookie_consent', consent);
  window.eval(consentSource);
  window.eval(trackingSource);
  window.eval(telemetrySource);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const scripts = () => [...window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  return { window, fetches, scripts };
}

// ---------- 1. Banner és lábléc ----------

test('a banner megjelenik, három egyenrangú gombbal és adatvédelmi hivatkozással', async () => {
  const { window } = await loadPage();
  const banner = window.document.getElementById('cookieConsent');
  assert.ok(banner, 'banner');
  const buttons = [...banner.querySelectorAll('.cc-btn')];
  const labels = buttons.map((b) => b.textContent.trim());
  assert.deepEqual(labels.slice(0, 3), ['Összes elfogadása', 'Csak a szükségesek', 'Beállítások']);
  assert.equal(new Set(buttons.slice(0, 3).map((b) => b.className)).size, 1, 'azonos stílusosztály');
  assert.ok(banner.querySelector('a[data-legal="privacy"]'));
  assert.equal(banner.getAttribute('role'), 'dialog');
  assert.ok(banner.getAttribute('aria-labelledby'));
});

test('a részletes nézet három kategóriát mutat, az elengedhetetlen mindig bekapcsolt és nem módosítható', async () => {
  const { window } = await loadPage();
  window.document.getElementById('ccSettings').click();
  const text = window.document.getElementById('cookieConsent').textContent;
  for (const label of ['Elengedhetetlen működési és biztonsági sütik', 'Statisztikai és teljesítmény sütik', 'Marketing sütik', 'Kiválasztottak mentése']) assert.ok(text.includes(label), label);
  const disabled = [...window.document.querySelectorAll('#cookieConsent input[type=checkbox]')].filter((i) => i.disabled);
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].checked, true);
});

test('Esc nem számít hozzájárulásnak, a döntés után a banner eltűnik és a lábléc gombja újranyitja', async () => {
  const { window } = await loadPage();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(window.OviConsent.get(), null);
  window.document.getElementById('ccAcceptNecessary').click();
  assert.deepEqual(JSON.parse(JSON.stringify(window.OviConsent.get())).analytics, false);
  assert.equal(window.OviConsent.has('marketing'), false);
  assert.equal(window.document.getElementById('cookieConsent'), null);
  window.document.querySelector('[data-cookie-settings]').click();
  assert.ok(window.document.getElementById('cookieConsent'));
});

test('minden nyilvános oldal tartalmazza a cookie-consent.js szkriptet és a Süti beállítások gombot', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read('frontend', page);
    assert.match(html, /<script src="js\/cookie-consent\.js(\?v=\d+)?"/, page);
    assert.match(html, /<button[^>]*data-cookie-settings[^>]*>Süti beállítások<\/button>/, page);
  }
  assert.doesNotMatch(read('frontend', 'admin.html'), /cookie-consent\.js/);
});

test('a hozzájárulás visszavonásakor a hirdetési és statisztikai sütik, valamint a munkamenet-azonosító törlődik', async () => {
  const { window } = await loadPage({ consent: stored(true, true) });
  window.document.cookie = '_ga=GA1.1.1; path=/';
  window.document.cookie = '_fbp=fb.1.2; path=/';
  window.sessionStorage.setItem('ovi_analytics_sid', 'abcdefghijklmnop1234');
  let event = null;
  window.document.addEventListener('ovi:consent-changed', (e) => { event = e.detail; });
  window.OviConsent.acceptNecessary();
  assert.ok(event);
  assert.equal(window.document.cookie.includes('_ga='), false);
  assert.equal(window.document.cookie.includes('_fbp='), false);
  assert.equal(window.sessionStorage.getItem('ovi_analytics_sid'), null);
});

// ---------- 2. Hozzájárulás-vezérelt követés ----------

test('hozzájárulás nélkül nem indul GA4, Meta Pixel és nincs munkamenetes telemetria', async () => {
  for (const consent of [null, stored(false, false)]) {
    const { window, fetches, scripts } = await loadPage({ consent });
    assert.equal(scripts().some((src) => /googletagmanager|fbevents/.test(src)), false);
    assert.equal(fetches.filter((f) => /\/api\/telemetry/.test(f.url)).length, 0);
    assert.equal(window.sessionStorage.getItem('ovi_analytics_sid'), null);
    window.telemetry.logFunnel('planner_step_1');
    assert.equal(window.OviTracking.track('begin_checkout', { value: 390 }), false);
    assert.equal(fetches.length, 0);
    assert.equal(window.sessionStorage.getItem('ovi_analytics_sid'), null);
  }
});

test('statisztikai hozzájárulással csak a GA4 és a munkamenetes tölcsér indul, a Meta nem', async () => {
  const { window, fetches, scripts } = await loadPage({ consent: stored(true, false) });
  assert.ok(scripts().some((src) => src.includes('googletagmanager.com/gtag/js?id=G-TESZT12345')));
  assert.equal(scripts().some((src) => /fbevents/.test(src)), false);
  const sid = window.sessionStorage.getItem('ovi_analytics_sid');
  assert.match(sid, /^[A-Za-z0-9_-]{16,64}$/);
  const sent = fetches.filter((f) => /\/api\/telemetry/.test(f.url));
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((f) => f.body.sessionId === sid));
  assert.ok(sent.some((f) => f.body.eventName === 'landing_view'));
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(window.dataLayer[0]))), ['consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
});

test('marketing-hozzájárulással a Meta Pixel indul, a GA4 nem', async () => {
  const { window, scripts } = await loadPage({ consent: stored(false, true) });
  assert.ok(scripts().some((src) => src.includes('connect.facebook.net') && src.includes('fbevents.js')));
  assert.equal(scripts().some((src) => /googletagmanager/.test(src)), false);
  assert.equal(typeof window.fbq, 'function');
});

test('oldalbetöltés közben megadott hozzájárulás újratöltés nélkül indítja a követést, a visszavonás leállítja', async () => {
  const { window, fetches, scripts } = await loadPage();
  assert.equal(scripts().some((src) => /googletagmanager|fbevents/.test(src)), false);
  window.document.getElementById('ccAcceptAll').click();
  assert.ok(scripts().some((src) => /googletagmanager/.test(src)));
  assert.ok(scripts().some((src) => /fbevents/.test(src)));
  assert.ok(window.sessionStorage.getItem('ovi_analytics_sid'));
  assert.ok(fetches.some((f) => /\/api\/telemetry/.test(f.url) && f.body.sessionId));
  window.OviConsent.acceptNecessary();
  const before = fetches.length;
  window.telemetry.logFunnel('paywall_opened');
  assert.equal(window.OviTracking.track('begin_checkout', { value: 390 }), false);
  assert.equal(fetches.length, before);
  assert.equal(window.sessionStorage.getItem('ovi_analytics_sid'), null);
});

test('üres azonosítóval a GA4 és a Meta Pixel hozzájárulás mellett sem töltődik be', async () => {
  const { scripts } = await loadPage({ consent: stored(true, true), tracking: { barion_pixel_id: '', ga4_measurement_id: '', meta_pixel_id: '' } });
  assert.equal(scripts().some((src) => /googletagmanager|fbevents/.test(src)), false);
});

// ---------- 5. Vásárlás duplikációvédelem ----------

test('ugyanaz a rendelésszám újratöltés után sem megy ki másodszor (GA4 és Meta)', async () => {
  const first = await loadPage({ consent: stored(true, true) });
  const params = { transaction_id: 'OVITE-2026-1', value: 390, items: [{ item_id: 'daily', price: 390, quantity: 1 }] };
  assert.equal(first.window.OviTracking.track('purchase', params), true);
  assert.equal(first.window.OviTracking.track('purchase', params), false);
  const saved = first.window.localStorage.getItem('ovi_tracked_purchases');
  assert.deepEqual(JSON.parse(saved).sort(), ['ga4:OVITE-2026-1', 'meta:OVITE-2026-1']);
  const purchases = first.window.dataLayer.filter((entry) => entry[0] === 'event' && entry[1] === 'purchase');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0][2].currency, 'HUF');

  const second = await loadPage({ consent: stored(true, true) });
  second.window.localStorage.setItem('ovi_tracked_purchases', saved);
  assert.equal(second.window.OviTracking.track('purchase', params), false);
  assert.equal(second.window.dataLayer.filter((entry) => entry[0] === 'event' && entry[1] === 'purchase').length, 0);
  assert.equal(second.window.OviTracking.track('purchase', { ...params, transaction_id: 'OVITE-2026-2' }), true);
});

// ---------- 3. tracking_config ----------

test('tracking_config alapértékei érvényesek, az üres érték megengedett, a hibás 400-as hibát ad', () => {
  const current = { ...settingsService.DEFAULT_SETTINGS };
  const defaults = settingsService.DEFAULT_SETTINGS.tracking_config;
  assert.deepEqual(settingsService.validatePatch({ tracking_config: defaults }, current).tracking_config, defaults);
  const empty = { barion_pixel_id: '', ga4_measurement_id: '', meta_pixel_id: '' };
  assert.deepEqual(settingsService.validatePatch({ tracking_config: empty }, current).tracking_config, empty);
  const merged = settingsService.validatePatch({ tracking_config: { meta_pixel_id: '1234567890' } }, current).tracking_config;
  assert.deepEqual(merged, { ...defaults, meta_pixel_id: '1234567890' });
  for (const bad of [{ ga4_measurement_id: 'UA-123' }, { ga4_measurement_id: 'g-abc12345' }, { meta_pixel_id: '123' }, { meta_pixel_id: 'abc1234567890' }, { barion_pixel_id: 'XX-123456-A' }, { barion_pixel_id: 'BP-12-A' }, { barion_pixel_id: 'BP-<script>-A' }, { unknown: 'x' }]) {
    assert.throws(() => settingsService.validatePatch({ tracking_config: bad }, current), (error) => error.status === 400, JSON.stringify(bad));
  }
});

// ---------- 4. Tölcsér ----------

test('computeFunnel: elért, továbblépő % és az utolsó lépésnél elakadók', () => {
  const rows = [];
  const add = (sid, ...steps) => steps.forEach((event_name) => rows.push({ session_id: sid, event_name }));
  add('s1', 'landing_view', 'pricing_view', 'planner_step_1');
  add('s2', 'landing_view', 'pricing_view', 'planner_step_1', 'planner_step_2', 'planner_step_3', 'planner_step_4', 'generator_started', 'document_generated', 'paywall_opened', 'checkout_started', 'payment_succeeded');
  add('s3', 'landing_view');
  add('s4', 'planner_step_1', 'planner_step_2');
  add('s4', 'planner_step_1');
  const funnel = computeFunnel(rows);
  const by = Object.fromEntries(funnel.steps.map((s) => [s.step, s]));
  assert.deepEqual(funnel.steps.map((s) => s.step), [...FUNNEL_STEPS]);
  assert.equal(funnel.total_sessions, 4);
  assert.equal(by.landing_view.reached, 3);
  assert.equal(by.landing_view.dropped, 1);
  assert.equal(by.landing_view.continued, 2);
  assert.equal(by.landing_view.continued_pct, 66.7);
  assert.equal(by.pricing_view.reached, 2);
  assert.equal(by.planner_step_1.reached, 3);
  assert.equal(by.planner_step_1.dropped, 1);
  assert.equal(by.planner_step_2.dropped, 1);
  assert.equal(by.payment_succeeded.reached, 1);
  assert.equal(by.payment_succeeded.dropped, 1);
  assert.equal(funnel.steps.reduce((sum, s) => sum + s.dropped, 0), 4, 'minden munkamenet pontosan egy lépésnél ér véget');
  assert.equal(funnel.steps.filter((s) => s.biggest_drop).length, 1);
});

test('computeFunnel üres és idegen eseményeknél sem hibázik', () => {
  assert.equal(computeFunnel([]).total_sessions, 0);
  assert.equal(computeFunnel([{ session_id: 'x', event_name: 'download_docx' }, { session_id: null, event_name: 'landing_view' }]).total_sessions, 0);
});

test('a tölcsér eseményei engedélyezettek és a munkamenet-azonosító formátuma szigorú', () => {
  for (const step of FUNNEL_STEPS) assert.ok(ALLOWED_EVENTS.has(step), step);
  assert.equal(sanitizeSessionId('abcdefghijklmnop'), 'abcdefghijklmnop');
  for (const bad of ['short', 'x'.repeat(65), 'has space 1234567890', '1.2.3.4', null, 42]) assert.equal(sanitizeSessionId(bad), null, String(bad));
});

test('telemetria API: érvényes session_id mentődik, érvénytelen 400, IP/UA soha nem kerül a sorba', async (t) => {
  const server = require('../backend/server');
  const supabase = require('../backend/services/supabaseService');
  const inserted = [];
  supabase.setClient({ from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) });
  t.after(() => supabase.setClient(null));
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const base = `http://127.0.0.1:${instance.address().port}`;
  const post = (body) => fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0' }, body: JSON.stringify(body) });
  const ok = await post({ eventName: 'planner_step_2', sessionId: 'Abcdefgh12345678_-x', ip: '1.2.3.4', userAgent: 'x' });
  assert.equal(ok.status, 200);
  assert.equal(inserted[0].session_id, 'Abcdefgh12345678_-x');
  assert.deepEqual(Object.keys(inserted[0]).sort(), ['category', 'device_type', 'event_name', 'metadata', 'referrer_domain', 'session_id']);
  assert.equal((await post({ eventName: 'planner_step_2', sessionId: 'rövid!' })).status, 400);
  assert.equal(inserted.length, 1);
});

test('az analytics_funnel migráció idempotens és bekerül a RUN_ALL_PENDING_MIGRATIONS fájlba', () => {
  const sql = read('supabase', 'migrations', '20261208090000_analytics_funnel.sql');
  assert.match(sql, /add column if not exists session_id/i);
  assert.match(sql, /\(session_id, created_at\)/);
  assert.doesNotMatch(sql, /\b(ip_address|user_agent)\b/i);
  const all = read('supabase', 'RUN_ALL_PENDING_MIGRATIONS.sql');
  assert.ok(all.includes('-- >>>>>>>>>> 20261208090000_analytics_funnel.sql'));
});

// ---------- 6. Jogi szövegek ----------

test('az adatvédelmi tájékoztató felsorolja az adatfeldolgozókat és a süti-táblázatot', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:8000', runScripts: 'outside-only' });
  const privacy = JSON.stringify(dom.window.eval(`${read('frontend', 'js', 'site.js')}\n;LEGAL_TEXTS`).privacy);
  dom.window.close();
  for (const needle of ['H-EN-I-1064/2013', 'KBOSS.hu', 'Nethely', 'Supabase', 'Render', 'Cloudflare', 'Google Ireland', 'Meta Platforms Ireland', 'ovi_cookie_consent', 'ovi_analytics_sid', '_ga', '_fbp', '_fbc', 'Süti beállítások', 'legal-table']) {
    assert.ok(privacy.includes(needle), needle);
  }
});

test('az EV alapadatai változatlanok, és a jogi ablak az aktív számlázási profilt követi', () => {
  const siteJs = read('frontend', 'js', 'site.js');
  const constants = read('backend', 'services', 'siteConstants.js');
  assert.match(constants, /Kossuth Lajos utca 26\./);
  assert.match(constants, /51507048/);
  assert.match(siteJs, /getCompany\(\)/);
  assert.match(siteJs, /config\.trackingConfig/);
});

test('a hozzájárulás-verzió mindkét helyen azonos és frissebb a korábbinál', () => {
  const server = /CONSENT_VERSION = '([^']+)'/.exec(paymentRoutes)[1];
  assert.equal(server, CONSENT_VERSION);
  assert.ok(server > '2026-11-28');
});
