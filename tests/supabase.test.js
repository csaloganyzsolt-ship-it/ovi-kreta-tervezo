const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { makePlan } = require('./fixtures');
const server = require('../backend/server');
const planStore = require('../backend/services/planStore');
const coupons = require('../backend/services/coupons');
const supabase = require('../backend/services/supabaseService');
const mailService = require('../backend/services/mailService');
const stripeService = require('../backend/services/stripeService');
const invoiceService = require('../backend/services/invoiceService');
const orders = require('../backend/services/orderService');
const barionService = require('../backend/services/barionService');

const PAYMENT_ID = '4a1b2c3d4e5f60718293a4b5c6d7e8f9';
const BILLING = { name: 'Minta Óvoda', zip: '9021', city: 'Győr', address: 'Fő utca 12/B.' };

// Mockolt Supabase kliens: memóriabeli táblák, a használt lekérdezés-láncokkal (select/eq/maybeSingle, count, insert, upsert, JSON-útvonal szűrő).
function fakeSupabase(seed = {}) {
  const tables = { coupons: [], coupon_redemptions: [], documents: [], orders: [], ...seed };
  const failures = {};
  const readPath = (row, column) => column.replace(/->>/g, '->').split('->').reduce((value, key) => (value == null ? value : value[key]), row);
  const client = {
    tables,
    failures,
    from(name) {
      // A rendszerbeállítások és e-mail sablonok táblái üresek: az alapértékek érvényesek.
      if (name === 'system_settings' || name === 'email_templates') return { select: async () => ({ data: [], error: null }) };
      const filters = [];
      let pendingUpdate = null;
      const matching = () => tables[name].filter((row) => filters.every(([column, value]) => readPath(row, column) === value));
      const builder = {
        select() { return builder; },
        eq(column, value) { filters.push([column, value]); return builder; },
        update(fields) { pendingUpdate = fields; return builder; },
        maybeSingle() {
          if (failures[name]) return Promise.resolve({ data: null, error: { message: failures[name] } });
          return Promise.resolve({ data: matching()[0] || null, error: null });
        },
        // head-count lekérdezés vagy update: await builder
        then(resolve, reject) {
          if (pendingUpdate) {
            if (failures[`${name}.update`]) return Promise.resolve({ data: null, error: { message: failures[`${name}.update`] } }).then(resolve, reject);
            const rows = matching();
            rows.forEach((row) => Object.assign(row, pendingUpdate));
            return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null }).then(resolve, reject);
          }
          return Promise.resolve(failures[name] ? { count: null, error: { message: failures[name] } } : { count: matching().length, error: null }).then(resolve, reject);
        },
        insert(row) {
          if (failures[`${name}.insert`]) return Promise.resolve({ error: { message: failures[`${name}.insert`] } });
          tables[name].push({ id: tables[name].length + 1, used_at: new Date().toISOString(), ...row });
          return Promise.resolve({ error: null });
        },
        upsert(row, options) {
          if (failures[`${name}.upsert`]) return Promise.resolve({ error: { message: failures[`${name}.upsert`] } });
          const key = options?.onConflict || 'document_id';
          const existing = tables[name].find((item) => item[key] === row[key]);
          if (existing) Object.assign(existing, row);
          else tables[name].push({ created_at: new Date().toISOString(), ...(name === 'orders' ? { delivery_count: 0 } : {}), ...row });
          return Promise.resolve({ error: null });
        }
      };
      return builder;
    }
  };
  return client;
}

function useSupabase(t, client) {
  supabase.setClient(client);
  coupons.resetSessions();
  t.after(() => { supabase.setClient(null); coupons.resetSessions(); });
  return client;
}

const couponRow = (overrides = {}) => ({ code: 'OVI50', discount_percent: 50, max_uses: null, valid_until: null, is_active: true, note: '', created_at: '2026-01-01T00:00:00Z', ...overrides });

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

function trapPaymentProviders(t) {
  const calls = [];
  const original = { checkout: stripeService.createCheckoutSession, invoice: invoiceService.issueInvoice };
  stripeService.createCheckoutSession = async () => { calls.push('stripe'); throw new Error('Stripe nem hívható'); };
  invoiceService.issueInvoice = async () => { calls.push('invoice'); throw new Error('Számlázz.hu nem hívható'); };
  t.after(() => { stripeService.createCheckoutSession = original.checkout; invoiceService.issueInvoice = original.invoice; });
  return calls;
}

let counter = 0;
function seedPlan(planMode = 'standard') {
  counter += 1;
  const id = `gen_supabase_${counter}`;
  planStore.savePlan(id, planMode === 'academic'
    ? { planMode: 'academic', tema: 'x', request: { planMode: 'academic', duration: 'Napi' } }
    : { ...makePlan(3), request: { planMode: 'standard', duration: 'Napi' } });
  return id;
}

const applyBody = (generationId, extra = {}) => ({ code: 'ovi50 ', plan: 'daily', planMode: 'standard', email: 'vevo@example.com', generationId, ...extra });

// ---------- Kliens és tesztbarát tartalék ----------

test('the Supabase client stays off under NODE_ENV=test or without both variables, so the in-memory flow keeps working', () => {
  assert.equal(supabase.isConfigured({}), false);
  assert.equal(supabase.isConfigured({ SUPABASE_URL: 'https://x.supabase.co' }), false);
  assert.equal(supabase.isConfigured({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret' }), true);
  assert.equal(supabase.getClient({ NODE_ENV: 'test', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret' }), null);
  assert.equal(supabase.getClient({ NODE_ENV: 'production' }), null);
  supabase.resetClient();
  const client = supabase.getClient({ NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret' });
  assert.equal(typeof client.from, 'function');
  supabase.resetClient();
});

// ---------- Kuponellenőrzés ----------

test('coupon lookup is case-insensitive and rejects unknown, inactive, expired and exhausted codes', async (t) => {
  const client = useSupabase(t, fakeSupabase({
    coupons: [
      couponRow(),
      couponRow({ code: 'KIKAPCS', is_active: false }),
      couponRow({ code: 'LEJART', valid_until: '2026-01-01T00:00:00Z' }),
      couponRow({ code: 'JOVO', valid_until: '2999-01-01T00:00:00Z' }),
      couponRow({ code: 'EGYSZER', max_uses: 1 }),
      couponRow({ code: 'ROSSZ', discount_percent: 0 })
    ],
    coupon_redemptions: [{ id: 1, coupon_code: 'EGYSZER' }]
  }));

  assert.deepEqual(await coupons.lookup('  ovi50 '), { code: 'OVI50', percent: 50 });
  assert.deepEqual(await coupons.lookup('jovo'), { code: 'JOVO', percent: 50 });
  const rejected = async (code, pattern) => {
    await assert.rejects(coupons.lookup(code), (error) => error.code === 'INVALID_COUPON' && error.status === 400 && pattern.test(error.message), String(code));
  };
  await rejected('NINCSILYEN', /Érvénytelen kuponkód/);
  await rejected('KIKAPCS', /nem aktív/);
  await rejected('LEJART', /lejárt/);
  await rejected('EGYSZER', /felhasználási kerete elfogyott/);
  await rejected('ROSSZ', /nem használható/);
  for (const bad of [undefined, null, '', {}, ['OVI50'], 'x'.repeat(41), 'OVI50; DROP TABLE']) await rejected(bad, /Érvénytelen kuponkód/);

  client.tables.coupon_redemptions.length = 0;
  assert.equal((await coupons.lookup('EGYSZER')).percent, 50, 'felhasználás nélkül még él');

  client.failures.coupons = 'connection refused';
  await assert.rejects(coupons.lookup('OVI50'), (error) => error.status === 503 && /connection refused/.test(error.message), 'Supabase-hiba nem tűnik érvénytelen kuponnak');
});

test('the discounted price is rounded to whole forints', () => {
  assert.deepEqual(coupons.computeDiscount(390, 50), { originalPrice: 390, percent: 50, discountAmount: 195, finalPrice: 195 });
  assert.deepEqual(coupons.computeDiscount(690, 50), { originalPrice: 690, percent: 50, discountAmount: 345, finalPrice: 345 });
  assert.equal(coupons.computeDiscount(390, 33).finalPrice, 261);
  assert.equal(coupons.computeDiscount(890, 15).finalPrice, 757);
  assert.deepEqual(coupons.computeDiscount(390, 100), { originalPrice: 390, percent: 100, discountAmount: 390, finalPrice: 0 });
});

// ---------- Tervezetek tárolása ----------

test('plans and the unlocked state are saved to the documents table and survive a restart', async (t) => {
  const client = useSupabase(t, fakeSupabase());
  const id = `gen_persist_${Date.now()}`;
  await planStore.savePlan(id, { ...makePlan(3), request: { planMode: 'standard', duration: 'Napi', turnstileToken: 'titok' } });
  const row = client.tables.documents.find((item) => item.document_id === id);
  assert.equal(row.plan_mode, 'standard');
  assert.equal(row.unlocked, false);
  assert.equal(row.data.plan.kidolgozas_tablazat.length, 3);
  assert.equal(row.data.plan.request.turnstileToken, undefined, 'a titkos mező nem kerül a Supabase-be');

  assert.equal(await planStore.updateDocument(id, { unlocked: true, meta: { coupon: { code: 'OVI50' } } }), true);
  assert.equal(row.unlocked, true);
  assert.equal(row.data.meta.coupon.code, 'OVI50');

  planStore.clearPlans();
  assert.equal(planStore.hasPlan(id), false, 'újraindítás után a memória üres');
  const restored = await planStore.loadPlan(id);
  assert.equal(restored.kidolgozas_tablazat.length, 3);
  assert.equal(planStore.hasPlan(id), true);
  assert.deepEqual(planStore.getDocumentState(id), { unlocked: true, coupon: { code: 'OVI50' } });
  assert.equal(await planStore.loadPlan('gen_nincs_ilyen'), null);
  planStore.clearPlans();
});

test('a failed Supabase save is logged and a failed read surfaces as an error', async (t) => {
  const client = useSupabase(t, fakeSupabase());
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = original; });
  client.failures['documents.upsert'] = 'permission denied';
  const id = `gen_fail_${Date.now()}`;
  await planStore.savePlan(id, { ...makePlan(2), request: {} });
  assert.ok(errors.some((line) => /permission denied/.test(line)));
  assert.equal(planStore.hasPlan(id), true, 'a memóriában a terv ettől még elérhető');
  planStore.clearPlans();
  client.failures.documents = 'timeout';
  await assert.rejects(planStore.loadPlan(id), /timeout/);
});

// ---------- 100%-os kupon ----------

test('a failing orders write fails the coupon request with a 5xx and leaves the plan locked instead of swallowing the error', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow({ code: 'OVI100', discount_percent: 100, max_uses: 5 })] }));
  client.failures['orders.upsert'] = 'orders tábla hiányzik';
  setEnv(t, { PAYWALL_ENABLED: 'true' });
  trapPaymentProviders(t);
  const base = await listen(t);
  const id = seedPlan();

  const response = await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(planStore.getDocumentState(id).unlocked, false, 'a mentetlen rendelés után a terv nem marad feloldva');
  assert.equal(client.tables.documents.find((row) => row.document_id === id)?.unlocked, false, 'az adatbázisban sem');
});

test('a failing documents write fails the coupon request and leaves the order table untouched', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow({ code: 'OVI100', discount_percent: 100, max_uses: 5 })] }));
  setEnv(t, { PAYWALL_ENABLED: 'true' });
  trapPaymentProviders(t);
  const base = await listen(t);
  const id = seedPlan();
  await new Promise((resolve) => setImmediate(resolve));
  client.failures['documents.upsert'] = 'documents tábla hiányzik';

  const response = await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }));
  assert.equal(response.status, 500);
  assert.equal(client.tables.orders.length, 0);
  assert.equal(planStore.getDocumentState(id).unlocked, false);
});

test('a 100% coupon unlocks the plan, skips Stripe and invoicing and logs one redemption row, even when repeated', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow({ code: 'OVI100', discount_percent: 100, max_uses: 1 })] }));
  setEnv(t, { PAYWALL_ENABLED: 'true' });
  const calls = trapPaymentProviders(t);
  const base = await listen(t);
  const id = seedPlan();

  const response = await post(base, '/api/apply-coupon', applyBody(id, { code: ' ovi100' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.paid, true);
  assert.deepEqual(data.coupon, { code: 'OVI100', percent: 100 });
  assert.match(data.sessionId, /^coupon_[0-9a-f]{32}$/);
  assert.equal(data.planData.kidolgozas_tablazat.length, 3);
  assert.deepEqual(calls, []);

  assert.equal(client.tables.coupon_redemptions.length, 1);
  assert.deepEqual(
    { ...client.tables.coupon_redemptions[0], id: undefined, used_at: undefined },
    { id: undefined, used_at: undefined, coupon_code: 'OVI100', user_email: 'vevo@example.com', document_id: id, plan_mode: 'standard', original_price: 390, discount_amount: 390, final_price: 0 }
  );
  const document = client.tables.documents.find((row) => row.document_id === id);
  assert.equal(document.unlocked, true);
  assert.equal(document.data.meta.coupon_session.id, data.sessionId);
  assert.equal(client.tables.orders.length, 1);
  assert.deepEqual(
    { ...client.tables.orders[0], created_at: undefined, updated_at: undefined, paid_at: undefined, delivery_count: undefined },
    { created_at: undefined, updated_at: undefined, paid_at: undefined, delivery_count: undefined, session_id: data.sessionId, order_number: client.tables.orders[0].order_number, user_email: 'vevo@example.com', document_id: id, plan_mode: 'standard', plan_key: 'daily', amount: 0, coupon_code: 'OVI100', payment_method: 'Kupon', status: 'paid' }
  );

  // max_uses=1 már elfogyott, de ugyanaz a terv ugyanazt a munkamenetet kapja, és nem kerül második sor a statisztikába.
  const again = await (await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }))).json();
  assert.equal(again.sessionId, data.sessionId);
  assert.equal(client.tables.coupon_redemptions.length, 1);
  assert.equal(client.tables.orders.length, 1, 'ugyanaz a rendelés nem készül újra');

  // Másik terv már nem használhatja a kimerült kupont.
  const other = await post(base, '/api/apply-coupon', applyBody(seedPlan(), { code: 'OVI100' }));
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /kerete elfogyott/);
  assert.equal(client.tables.coupon_redemptions.length, 1);
});

test('the 100% coupon session survives a server restart: re-applying and the e-mail delivery use the stored session', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow({ code: 'OVI100', discount_percent: 100 })] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-supabase-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setEnv(t, { PAYWALL_ENABLED: 'true', SMTP_HOST: 'smtp.invalid.example', INVOICE_STORE_PATH: path.join(dir, 'invoiced-sessions.json') });
  trapPaymentProviders(t);
  const base = await listen(t);
  const id = seedPlan();
  const first = await (await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }))).json();

  planStore.clearPlans();
  coupons.resetSessions();
  mailService.mockOutbox.length = 0;
  const file = { name: 'terv.pdf', base64: Buffer.from('x').toString('base64') };
  const delivery = await post(base, `/api/deliver/${first.sessionId}`, { files: [file], title: 'Őszi erdő', planMode: 'standard' });
  assert.equal(delivery.status, 200);
  assert.deepEqual(await delivery.json(), { success: true, sent: true, coupon: true });
  assert.equal(mailService.mockOutbox[0].to, 'vevo@example.com');

  planStore.clearPlans();
  coupons.resetSessions();
  const again = await (await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }))).json();
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(client.tables.coupon_redemptions.length, 1);
});

test('a failed redemption log blocks the 100% unlock instead of granting it uncounted', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow({ code: 'OVI100', discount_percent: 100 })] }));
  client.failures['coupon_redemptions.insert'] = 'db down';
  setEnv(t, { PAYWALL_ENABLED: 'true' });
  const base = await listen(t);
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const id = seedPlan();
  const response = await post(base, '/api/apply-coupon', applyBody(id, { code: 'OVI100' }));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /db down/);
  assert.equal(coupons.sessionFor(id), null);
});

test('the endpoint refuses expired, inactive and exhausted Supabase coupons and ignores the COUPON_CODES list', async (t) => {
  useSupabase(t, fakeSupabase({
    coupons: [couponRow({ code: 'LEJART', valid_until: '2020-01-01T00:00:00Z' }), couponRow({ code: 'KIKAPCS', is_active: false }), couponRow({ code: 'KERET', max_uses: 2 })],
    coupon_redemptions: [{ id: 1, coupon_code: 'KERET' }, { id: 2, coupon_code: 'KERET' }]
  }));
  setEnv(t, { PAYWALL_ENABLED: 'true', COUPON_CODES: 'TEST100' });
  const base = await listen(t);
  const id = seedPlan();
  for (const [code, pattern] of [['LEJART', /lejárt/], ['KIKAPCS', /nem aktív/], ['KERET', /elfogyott/], ['TEST100', /Érvénytelen/]]) {
    const response = await post(base, '/api/apply-coupon', applyBody(id, { code }));
    assert.equal(response.status, 400, code);
    const body = await response.json();
    assert.equal(body.code, 'INVALID_COUPON');
    assert.match(body.error, pattern);
  }
});

// ---------- Részleges kupon és fizetés ----------

test('a 50% coupon returns the discounted price without unlocking, logging or touching the payment providers', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow()] }));
  setEnv(t, { PAYWALL_ENABLED: 'true' });
  const calls = trapPaymentProviders(t);
  const base = await listen(t);

  const daily = seedPlan();
  const response = await post(base, '/api/apply-coupon', applyBody(daily));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.paid, false);
  assert.deepEqual(data.coupon, { code: 'OVI50', percent: 50 });
  assert.deepEqual({ originalPrice: data.originalPrice, discountAmount: data.discountAmount, finalPrice: data.finalPrice }, { originalPrice: 390, discountAmount: 195, finalPrice: 195 });
  assert.equal(data.planData, undefined, 'fizetés előtt a teljes terv nem adható ki');
  assert.equal(data.sessionId, undefined);
  assert.equal(client.tables.coupon_redemptions.length, 0, 'a statisztikai sor csak sikeres fizetéskor keletkezik');
  const document = client.tables.documents.find((row) => row.document_id === daily);
  assert.equal(document.unlocked, false);
  assert.equal(document.data.meta.coupon.finalPrice, 195);
  assert.deepEqual(calls, []);

  const academic = seedPlan('academic');
  const academicData = await (await post(base, '/api/apply-coupon', applyBody(academic))).json();
  assert.equal(academicData.finalPrice, 345, 'az oktatási célú terv 690 Ft-ból számol, a tárolt terv módja a mérvadó');
});

function stubBarion(t, state) {
  const realFetch = global.fetch;
  const calls = { start: [], invoiceXml: [], sheets: [] };
  global.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === 'api.test.barion.com' && target.pathname === '/v2/Payment/Start') {
      const body = JSON.parse(options.body);
      calls.start.push(body);
      return Response.json({ PaymentId: PAYMENT_ID, PaymentRequestId: body.PaymentRequestId, Status: 'Prepared', GatewayUrl: `https://secure.test.barion.com/Pay?id=${PAYMENT_ID}`, Errors: [] });
    }
    if (target.hostname === 'api.test.barion.com' && target.pathname === '/v2/Payment/GetPaymentState') return Response.json(state());
    if (target.hostname === 'www.szamlazz.hu') {
      calls.invoiceXml.push(await options.body.get('action-xmlagentxmlfile').text());
      return new Response(Buffer.from('%PDF-1.4 teszt'), { status: 200, headers: { szlahu_szamlaszam: 'OVITE-2026-88' } });
    }
    if (target.hostname === 'script.google.com') { calls.sheets.push(JSON.parse(options.body)); return new Response('ok'); }
    return realFetch(url, options);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

function barionEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-supabase-barion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setEnv(t, {
    PAYWALL_ENABLED: 'true', BARION_POS_KEY_EV: 'pos-key', BARION_POS_KEY: undefined, BARION_TEST_MODE: 'true', BARION_PAYEE_EMAIL: 'bolt@ovitervezo.hu',
    FRONTEND_URL: 'https://ovitervezo.hu', BACKEND_URL: 'https://api.ovitervezo.test', BILLING_PROFILE: undefined,
    SZAMLAZZ_API_KEY_EV: 'agent-key', SZAMLAZZ_API_KEY: undefined, SZAMLAZZ_KEY: undefined, INVOICE_STORE_PATH: path.join(dir, 'invoiced-sessions.json'),
    SMTP_HOST: undefined, GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/test/exec', ADMIN_NOTIFICATION_EMAIL: undefined
  });
}

test('after a 50% coupon the Barion payment starts with the reduced amount, the invoice follows it, and the successful payment logs the redemption once', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow()] }));
  barionEnv(t);
  const holder = {};
  const calls = stubBarion(t, () => holder.state());
  const base = await listen(t);
  const id = seedPlan();
  await post(base, '/api/apply-coupon', applyBody(id));

  const started = await (await post(base, '/api/checkout-barion', { plan: 'daily', planMode: 'standard', email: 'vevo@example.com', billing: BILLING, generationId: id, title: 'Őszi erdő', coupon: { code: 'HAMIS', percent: 99 } })).json();
  assert.equal(started.success, true);
  assert.equal(started.amountHuf, 195);
  assert.equal(started.originalAmountHuf, 390);
  const transaction = calls.start[0].Transactions[0];
  assert.equal(transaction.Total, 195);
  assert.equal(transaction.Items[0].UnitPrice, 195);
  assert.equal(transaction.Items[0].ItemTotal, 195);
  assert.match(transaction.Items[0].Name, /kupon: -50%/);
  const record = await orders.getBySessionId(started.sessionId);
  assert.deepEqual({ amountHuf: record.amount, listPriceHuf: record.listPrice, couponCode: record.couponCode }, { amountHuf: 195, listPriceHuf: 390, couponCode: 'OVI50' });
  assert.equal(client.tables.coupon_redemptions.length, 0, 'fizetés előtt nincs statisztikai sor');
  assert.equal(client.tables.orders.length, 1);
  const pendingRow = client.tables.orders[0];
  assert.deepEqual(
    { user_email: pendingRow.user_email, document_id: pendingRow.document_id, plan_mode: pendingRow.plan_mode, plan_key: pendingRow.plan_key, amount: pendingRow.amount, coupon_code: pendingRow.coupon_code, payment_method: pendingRow.payment_method, status: pendingRow.status, provider: pendingRow.provider, provider_payment_id: pendingRow.provider_payment_id, billing_profile: pendingRow.billing_profile, list_price: pendingRow.list_price, coupon_percent: pendingRow.coupon_percent },
    { user_email: 'vevo@example.com', document_id: id, plan_mode: 'standard', plan_key: 'daily', amount: 195, coupon_code: 'OVI50', payment_method: 'Barion', status: 'pending', provider: 'barion', provider_payment_id: PAYMENT_ID, billing_profile: 'ev', list_price: 390, coupon_percent: 50 },
    'a fizetés indításakor függőben lévő rendelés jön létre'
  );

  // A Barion a teljes árat jelző összeggel nem oldhatja fel a kedvezményes rendelést.
  holder.state = () => ({ PaymentId: PAYMENT_ID, PaymentRequestId: started.sessionId, Status: 'Succeeded', Total: 390, Currency: 'HUF', Errors: [] });
  const wrong = await fetch(`${base}/api/webhook/barion?paymentId=${PAYMENT_ID}`);
  assert.equal(wrong.status, 409);
  assert.equal(client.tables.coupon_redemptions.length, 0);
  assert.equal(client.tables.orders[0].status, 'pending');

  holder.state = () => ({ PaymentId: PAYMENT_ID, PaymentRequestId: started.sessionId, Status: 'Succeeded', Total: 195, Currency: 'HUF', Errors: [] });
  const hook = await fetch(`${base}/api/webhook/barion?paymentId=${PAYMENT_ID}`);
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { received: true, status: 'Succeeded', paid: true });

  assert.equal(calls.invoiceXml.length, 1);
  assert.match(calls.invoiceXml[0], /<bruttoErtek>195<\/bruttoErtek>/, 'a számla a kedvezményes összegről szól');
  assert.match(calls.invoiceXml[0], /kupon: -50%/);
  assert.equal(client.tables.coupon_redemptions.length, 1);
  assert.deepEqual(
    { ...client.tables.coupon_redemptions[0], id: undefined, used_at: undefined },
    { id: undefined, used_at: undefined, coupon_code: 'OVI50', user_email: 'vevo@example.com', document_id: id, plan_mode: 'standard', original_price: 390, discount_amount: 195, final_price: 195 }
  );
  const document = client.tables.documents.find((row) => row.document_id === id);
  assert.equal(document.unlocked, true);
  assert.equal(document.data.meta.payment.amountHuf, 195);
  assert.equal(client.tables.orders.length, 1);
  assert.equal(client.tables.orders[0].status, 'paid');
  assert.equal(client.tables.orders[0].invoice_number, 'OVITE-2026-88');

  await fetch(`${base}/api/webhook/barion?paymentId=${PAYMENT_ID}`);
  const session = await (await fetch(`${base}/api/checkout-session/${started.sessionId}`)).json();
  assert.equal(session.paid, true);
  assert.equal(client.tables.coupon_redemptions.length, 1, 'ismételt visszahívás nem naplóz újra');
  assert.equal(calls.invoiceXml.length, 1);
});

test('a coupon that became invalid is dropped at checkout so the full price can be paid, and a plain checkout charges the list price', async (t) => {
  const client = useSupabase(t, fakeSupabase({ coupons: [couponRow()] }));
  barionEnv(t);
  const calls = stubBarion(t, () => ({}));
  const base = await listen(t);
  const id = seedPlan();
  await post(base, '/api/apply-coupon', applyBody(id));
  client.tables.coupons[0].is_active = false;

  const body = { plan: 'daily', planMode: 'standard', email: 'vevo@example.com', billing: BILLING, generationId: id };
  const refused = await post(base, '/api/checkout-barion', body);
  assert.equal(refused.status, 400);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.code, 'INVALID_COUPON');
  assert.equal(calls.start.length, 0);

  const retry = await (await post(base, '/api/checkout-barion', body)).json();
  assert.equal(retry.amountHuf, 390);
  assert.equal(calls.start[0].Transactions[0].Total, 390);
});

test('a persisted 50% coupon is still applied to the payment after a server restart', async (t) => {
  useSupabase(t, fakeSupabase({ coupons: [couponRow()] }));
  barionEnv(t);
  const calls = stubBarion(t, () => ({}));
  const base = await listen(t);
  const id = seedPlan();
  await post(base, '/api/apply-coupon', applyBody(id));

  planStore.clearPlans();
  const started = await (await post(base, '/api/checkout-barion', { plan: 'daily', planMode: 'standard', email: 'vevo@example.com', billing: BILLING, generationId: id })).json();
  assert.equal(started.success, true);
  assert.equal(calls.start[0].Transactions[0].Total, 195);
});

// ---------- Tartalék működés ----------

test('without Supabase the legacy COUPON_CODES flow still works and logs nothing', async (t) => {
  setEnv(t, { PAYWALL_ENABLED: 'true', COUPON_CODES: 'MASIK' });
  assert.equal(supabase.getClient(), null);
  const base = await listen(t);
  const id = seedPlan();
  const response = await post(base, '/api/apply-coupon', applyBody(id, { code: 'masik' }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.paid, true);
  assert.deepEqual(data.coupon, { code: 'MASIK', percent: 100 });
  assert.equal(await coupons.logRedemption({ code: 'MASIK' }), false);
});

// ---------- Frontend: részleges kupon ----------

test('the checkout box shows the discounted price after a partial coupon and the plan stays locked', async (t) => {
  const { JSDOM } = require('jsdom');
  const { makePayload, readPage } = require('./fixtures');
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
  const { window } = dom;
  const { document } = window;
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelector('.wizard-item[data-step="3"]').click();
  const mirror = { ...planStore.createMirrorPlan(makePlan(8)), request: makePayload(), generationId: 'gen_ui_partial' };
  window.renderResultDocument(mirror);
  window.eval('previewReady = true');
  window.renderPreview();
  window.updateExportLock();
  window.openCheckoutModal();
  document.getElementById('checkoutEmail').value = 'vevo@example.com';
  document.getElementById('cb-terms').checked = true;
  document.getElementById('cb-digital').checked = true;
  document.getElementById('couponCode').value = 'OVI50';

  window.fetch = async () => Response.json({ success: true, paid: false, coupon: { code: 'OVI50', percent: 50 }, plan: 'daily', originalPrice: 390, discountAmount: 195, finalPrice: 195, generationId: 'gen_ui_partial' });
  document.getElementById('couponApply').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(document.getElementById('couponStatus').textContent, 'Kupon elfogadva (-50%): fizetendő 195 Ft');
  assert.match(document.getElementById('checkoutSummary').textContent, /195 Ft \(eredeti ár: 390 Ft\)/);
  assert.equal(window.isPlanLocked(), true);
  assert.equal(document.getElementById('checkoutModal').classList.contains('open'), true);

  window.closeModals();
  window.openCheckoutModal();
  assert.equal(document.getElementById('couponStatus').textContent, 'Kupon elfogadva (-50%): fizetendő 195 Ft', 'az újranyitott ablak is a kedvezményes árat mutatja');
});
