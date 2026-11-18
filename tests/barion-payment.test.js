const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { makePlan } = require('./fixtures');
const server = require('../server');
const planStore = require('../services/planStore');
const barionService = require('../services/barionService');
const mailService = require('../services/mailService');

const POS_KEY = 'pos-key-very-secret';
const PAYMENT_ID = '4a1b2c3d4e5f60718293a4b5c6d7e8f9';
const GATEWAY_URL = `https://secure.test.barion.com/Pay?id=${PAYMENT_ID}`;

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

// Barion + Számlázz.hu csapda: minden külső hívás ide fut be, valódi hálózat nélkül.
function stubExternal(t, { start, state, invoice } = {}) {
  const realFetch = global.fetch;
  const calls = { start: [], state: [], invoice: 0, invoiceXml: [] };
  global.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (/^api(\.test)?\.barion\.com$/.test(target.hostname)) {
      if (target.pathname === '/v2/Payment/Start') {
        const body = JSON.parse(options.body);
        calls.start.push({ url: String(url), body });
        const answer = start ? start(body) : { PaymentId: PAYMENT_ID, PaymentRequestId: body.PaymentRequestId, Status: 'Prepared', GatewayUrl: GATEWAY_URL, Errors: [] };
        return Response.json(answer.json ?? answer, { status: answer.status || 200 });
      }
      if (target.pathname === '/v2/Payment/GetPaymentState') {
        calls.state.push({ url: String(url), key: target.searchParams.get('POSKey'), paymentId: target.searchParams.get('PaymentId') });
        const answer = state();
        return Response.json(answer.json ?? answer, { status: answer.status || 200 });
      }
    }
    if (target.hostname === 'www.szamlazz.hu') {
      calls.invoice += 1;
      const xml = await options.body.get('action-xmlagentxmlfile').text();
      calls.invoiceXml.push(xml);
      if (invoice) return invoice();
      return new Response(Buffer.from('%PDF-1.4 barion teszt'), { status: 200, headers: { szlahu_szamlaszam: 'OVITE-2026-77' } });
    }
    return realFetch(url, options);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

function barionEnv(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-barion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setEnv(t, {
    BARION_POS_KEY_EV: POS_KEY, BARION_POS_KEY: undefined, BARION_TEST_MODE: 'true', BARION_PAYEE_EMAIL: 'bolt@ovitervezo.hu',
    FRONTEND_URL: 'https://ovitervezo.hu', BACKEND_URL: 'https://api.ovitervezo.test', BILLING_PROFILE: undefined,
    SZAMLAZZ_API_KEY_EV: 'agent-key', SZAMLAZZ_API_KEY: undefined, SZAMLAZZ_KEY: undefined, INVOICE_STORE_PATH: path.join(dir, 'invoiced-sessions.json'),
    ...extra
  });
  return dir;
}

const succeeded = (total, sessionId, extra = {}) => ({ PaymentId: PAYMENT_ID, PaymentRequestId: sessionId, Status: 'Succeeded', Total: total, Currency: 'HUF', Errors: [], ...extra });

async function startBarion(base, body = {}) {
  const response = await post(base, '/api/checkout-barion', { plan: 'daily', planMode: 'standard', email: 'vevo@example.com', generationId: 'gen_barion_std', title: 'Őszi erdő', ...body });
  return { response, data: await response.json() };
}

function seedPlans() {
  planStore.savePlan('gen_barion_std', { ...makePlan(3), request: { planMode: 'standard', duration: 'Napi' } });
  planStore.savePlan('gen_barion_acad', { planMode: 'academic', tema: 'x', request: { planMode: 'academic', duration: 'Napi' } });
}

// ---------- POST /api/checkout-barion ----------

test('checkout-barion starts a Barion payment with the stored plan mode price, the documentId as OrderNumber and returns PaymentId and GatewayUrl', async (t) => {
  barionEnv(t);
  seedPlans();
  const calls = stubExternal(t);
  const base = await listen(t);

  const { response, data } = await startBarion(base);
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.paymentId, PAYMENT_ID);
  assert.equal(data.gatewayUrl, GATEWAY_URL);
  assert.match(data.sessionId, /^barion_[0-9a-f]{24}$/);
  assert.equal(data.amountHuf, 390);
  assert.equal(JSON.stringify(data).includes(POS_KEY), false, 'a titkos kulcs nem szivárog a válaszba');

  assert.equal(calls.start.length, 1);
  const { url, body } = calls.start[0];
  assert.equal(url, 'https://api.test.barion.com/v2/Payment/Start', 'BARION_TEST_MODE=true a teszt API-t hívja');
  assert.equal(body.POSKey, POS_KEY);
  assert.equal(body.PaymentType, 'Immediate');
  assert.equal(body.Currency, 'HUF');
  assert.equal(body.OrderNumber, 'gen_barion_std', 'a documentId az OrderNumber mezőben utazik');
  assert.equal(body.PaymentRequestId, data.sessionId);
  assert.equal(body.PayerHint, 'vevo@example.com');
  assert.equal(body.RedirectUrl, `https://ovitervezo.hu/tervezo.html?payment=barion&session_id=${data.sessionId}`);
  assert.equal(body.CallbackUrl, 'https://api.ovitervezo.test/api/webhook/barion');
  assert.equal(body.Transactions.length, 1);
  assert.equal(body.Transactions[0].Payee, 'bolt@ovitervezo.hu');
  assert.equal(body.Transactions[0].Total, 390);
  assert.equal(body.Transactions[0].Items[0].UnitPrice, 390);
  assert.equal(body.Transactions[0].Items[0].ItemTotal, 390);
  assert.match(body.Transactions[0].Items[0].Name, /OviTervező/);

  const stored = barionService.getRecord(data.sessionId);
  assert.deepEqual({ paymentId: stored.paymentId, generationId: stored.generationId, paid: stored.paid, amountHuf: stored.amountHuf }, { paymentId: PAYMENT_ID, generationId: 'gen_barion_std', paid: false, amountHuf: 390 });
});

test('checkout-barion charges 690 Ft for an academic plan from the stored plan, whatever the client claims, and 890 Ft for the weekly package', async (t) => {
  barionEnv(t);
  seedPlans();
  const calls = stubExternal(t);
  const base = await listen(t);

  const cheat = await startBarion(base, { plan: 'daily', planMode: 'standard', generationId: 'gen_barion_acad' });
  assert.equal(cheat.data.amountHuf, 690);
  assert.equal(calls.start[0].body.Transactions[0].Total, 690);
  const weekly = await startBarion(base, { plan: 'weekly_detailed' });
  assert.equal(weekly.data.amountHuf, 890);
  assert.equal(calls.start[1].body.Transactions[0].Total, 890);
});

test('checkout-barion uses the live API without BARION_TEST_MODE and falls back to the support address as Payee', async (t) => {
  barionEnv(t, { BARION_TEST_MODE: undefined, BARION_PAYEE_EMAIL: undefined, SUPPORT_EMAIL: 'info@ovitervezo.hu', BACKEND_URL: undefined, RENDER_EXTERNAL_URL: 'https://render.example.com/' });
  seedPlans();
  const calls = stubExternal(t, { start: (body) => ({ PaymentId: PAYMENT_ID, Status: 'Prepared', GatewayUrl: `https://secure.barion.com/Pay?id=${PAYMENT_ID}`, Errors: [], PaymentRequestId: body.PaymentRequestId }) });
  const base = await listen(t);
  const { data } = await startBarion(base);
  assert.equal(data.gatewayUrl, `https://secure.barion.com/Pay?id=${PAYMENT_ID}`);
  assert.equal(calls.start[0].url, 'https://api.barion.com/v2/Payment/Start');
  assert.equal(calls.start[0].body.Transactions[0].Payee, 'info@ovitervezo.hu');
  assert.equal(calls.start[0].body.CallbackUrl, 'https://render.example.com/api/webhook/barion');
});

test('checkout-barion refuses bad input, a missing key, Barion errors and a foreign gateway address with clear JSON errors', async (t) => {
  barionEnv(t);
  seedPlans();
  let mode = 'ok';
  const calls = stubExternal(t, {
    start: (body) => {
      if (mode === 'barion-error') return { status: 400, json: { Errors: [{ ErrorCode: 'ShopIsClosed', Title: 'Shop is closed' }] } };
      if (mode === 'evil-gateway') return { PaymentId: PAYMENT_ID, Status: 'Prepared', GatewayUrl: 'https://secure.barion.com.evil.example/Pay', Errors: [], PaymentRequestId: body.PaymentRequestId };
      return { PaymentId: PAYMENT_ID, Status: 'Prepared', GatewayUrl: GATEWAY_URL, Errors: [], PaymentRequestId: body.PaymentRequestId };
    }
  });
  const base = await listen(t);

  for (const [label, override, status, pattern] of [
    ['bad plan', { plan: 'monthly' }, 400, /Ismeretlen csomag/],
    ['bad e-mail', { email: 'nem-email' }, 400, /e-mail/],
    ['no document', { generationId: undefined }, 404, /már nem érhető el/],
    ['unknown document', { generationId: 'gen_nincs_ilyen' }, 404, /már nem érhető el/]
  ]) {
    const { response, data } = await startBarion(base, override);
    assert.equal(response.status, status, label);
    assert.equal(data.success, false, label);
    assert.match(data.error, pattern, label);
  }
  assert.equal(calls.start.length, 0, 'hibás kérésnél nincs Barion-hívás');
  assert.equal((await fetch(`${base}/api/checkout-barion`)).status, 404, 'csak POST');

  mode = 'barion-error';
  let result = await startBarion(base);
  assert.equal(result.response.status, 502);
  assert.match(result.data.error, /A Barion fizetés indítása sikertelen \(ShopIsClosed: Shop is closed\)/);
  assert.equal(JSON.stringify(result.data).includes(POS_KEY), false);

  mode = 'evil-gateway';
  result = await startBarion(base);
  assert.equal(result.response.status, 502);
  assert.match(result.data.error, /váratlan fizetési címet/);

  setEnv(t, { BARION_POS_KEY_EV: undefined });
  mode = 'ok';
  result = await startBarion(base);
  assert.equal(result.response.status, 503);
  assert.match(result.data.error, /BARION_POS_KEY_EV/);
});

// ---------- POST /api/webhook/barion ----------

async function paidSession(t, base, state, seed = {}) {
  seedPlans();
  const { data } = await startBarion(base, seed);
  assert.equal(data.success, true);
  state.current = () => succeeded(390, data.sessionId);
  return data;
}

test('the webhook asks Barion for the state, unlocks the document, issues the Barion invoice once and sends no e-mail', async (t) => {
  barionEnv(t);
  const holder = {};
  const calls = stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);
  mailService.mockOutbox.length = 0;

  const hook = await fetch(`${base}/api/webhook/barion`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `paymentId=${PAYMENT_ID}` });
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { received: true, status: 'Succeeded', paid: true });
  assert.equal(calls.state.length, 1);
  assert.deepEqual({ key: calls.state[0].key, paymentId: calls.state[0].paymentId }, { key: POS_KEY, paymentId: PAYMENT_ID });
  assert.match(calls.state[0].url, /^https:\/\/api\.test\.barion\.com\/v2\/Payment\/GetPaymentState\?/);

  const stored = barionService.getRecord(session.sessionId);
  assert.equal(stored.paid, true);
  assert.equal(stored.unlocked, true);
  assert.equal(stored.invoiceNumber, 'OVITE-2026-77');
  assert.equal(calls.invoice, 1);
  const xml = calls.invoiceXml[0];
  assert.match(xml, /<fizmod>Barion<\/fizmod>/);
  assert.match(xml, /<afakulcs>AAM<\/afakulcs>/);
  assert.match(xml, /<bruttoErtek>390<\/bruttoErtek>/);
  assert.match(xml, /<email>vevo@example\.com<\/email>/);
  assert.equal(mailService.mockOutbox.length, 0, 'a webhook nem küld levelet');

  // Idempotencia: ismételt és egyidejű visszahívás sem állít ki második számlát.
  const again = await Promise.all([
    fetch(`${base}/api/webhook/barion?paymentId=${PAYMENT_ID}`),
    post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID }),
    post(base, '/api/webhook/barion', { PaymentId: PAYMENT_ID })
  ]);
  for (const response of again) assert.equal(response.status, 200);
  assert.equal(calls.invoice, 1);
  assert.equal(barionService.getRecord(session.sessionId).invoiceNumber, 'OVITE-2026-77');
});

test('concurrent first callbacks still issue exactly one invoice', async (t) => {
  barionEnv(t);
  const holder = {};
  const calls = stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  await paidSession(t, base, holder);
  const responses = await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/webhook/barion?paymentId=${PAYMENT_ID}`)));
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(calls.invoice, 1);
});

test('the return-page status endpoint reports pending, failed and paid payments and returns the unlocked plan only when paid', async (t) => {
  barionEnv(t);
  const holder = {};
  const calls = stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);
  const status = async () => (await fetch(`${base}/api/checkout-session/${session.sessionId}`)).json();
  const secretText = 'Titkos barion lépés';
  const stored = planStore.getPlan('gen_barion_std');
  planStore.savePlan('gen_barion_std', { ...stored, kidolgozas_tablazat: [{ ...stored.kidolgozas_tablazat[0], tevekenyseg_menete: [secretText] }] });

  for (const [barionStatus, pending] of [['Prepared', true], ['Started', true], ['InProgress', true], ['Waiting', true], ['Canceled', false], ['Failed', false], ['Expired', false]]) {
    holder.current = () => ({ PaymentId: PAYMENT_ID, PaymentRequestId: session.sessionId, Status: barionStatus, Total: 390, Currency: 'HUF', Errors: [] });
    const data = await status();
    assert.equal(data.paid, false, barionStatus);
    assert.equal(data.pending, pending, barionStatus);
    assert.equal(data.status, barionStatus);
    assert.equal(data.provider, 'barion');
    assert.equal(data.planData, null, `${barionStatus}: nincs feloldott tartalom`);
  }
  assert.equal(calls.invoice, 0, 'nem fizetett állapotban nincs számla');

  holder.current = () => succeeded(390, session.sessionId);
  const paid = await status();
  assert.equal(paid.paid, true);
  assert.equal(paid.unlocked, true);
  assert.equal(paid.pending, false);
  assert.equal(paid.planData.kidolgozas_tablazat[0].tevekenyseg_menete[0], secretText);
  assert.equal(paid.invoiceReady, true);
  assert.equal(calls.invoice, 1, 'a visszatérő oldal lekérdezése is csak egyszer számláz');
  const callsBefore = calls.state.length;
  await status();
  assert.equal(calls.state.length, callsBefore, 'kifizetett és számlázott rendelésnél nincs újabb Barion-hívás');
});

test('the webhook ignores unknown and malformed payments, refuses a mismatching amount and asks Barion to retry on API errors', async (t) => {
  barionEnv(t);
  const holder = {};
  const calls = stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);

  const unknown = await post(base, '/api/webhook/barion', { paymentId: 'ffffffffffffffffffffffffffffffff' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { received: true, ignored: 'unknown_payment' });
  assert.equal(calls.state.length, 0, 'ismeretlen fizetésnél nincs Barion-hívás');
  for (const body of [{}, { paymentId: '' }, { paymentId: 'x' }, { paymentId: '../../etc/passwd' }]) assert.equal((await post(base, '/api/webhook/barion', body)).status, 400, JSON.stringify(body));
  assert.equal((await fetch(`${base}/api/webhook/barion`, { method: 'PUT' })).status, 404);

  holder.current = () => succeeded(1, session.sessionId);
  const mismatch = await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID });
  assert.equal(mismatch.status, 409);
  assert.equal(barionService.getRecord(session.sessionId).paid, false);
  holder.current = () => ({ ...succeeded(390, 'barion_masik_kereses') });
  assert.equal((await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID })).status, 409, 'más PaymentRequestId nem fogadható el');
  holder.current = () => ({ ...succeeded(390, session.sessionId), Currency: 'EUR' });
  assert.equal((await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID })).status, 409, 'más pénznem sem');
  assert.equal(calls.invoice, 0);

  holder.current = () => ({ status: 500, json: { Errors: [{ ErrorCode: 'InternalError', Title: 'Valami hiba' }] } });
  const down = await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID });
  assert.equal(down.status, 502, 'nem 2xx: a Barion újrapróbálja');
  assert.equal(barionService.getRecord(session.sessionId).paid, false);
});

test('a failed invoice keeps the paid document unlocked, makes the webhook retry, and the retry issues the invoice once', async (t) => {
  barionEnv(t);
  const holder = {};
  let invoiceFails = true;
  const calls = stubExternal(t, {
    state: () => holder.current(),
    invoice: () => (invoiceFails
      ? new Response('', { status: 200, headers: { szlahu_error: 'Hibas+kulcs', szlahu_error_code: '3' } })
      : new Response(Buffer.from('%PDF-1.4 ok'), { status: 200, headers: { szlahu_szamlaszam: 'OVITE-2026-78' } }))
  });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);

  const first = await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID });
  assert.ok(first.status >= 500, 'a Barion újrapróbálja');
  const record = barionService.getRecord(session.sessionId);
  assert.equal(record.paid, true);
  assert.equal(record.invoiceNumber, undefined);
  const status = await (await fetch(`${base}/api/checkout-session/${session.sessionId}`)).json();
  assert.equal(status.paid, true, 'a kifizetett terv a számlázási hiba miatt sem záródik vissza');
  assert.equal(status.invoiceReady, false);

  invoiceFails = false;
  assert.equal((await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID })).status, 200);
  assert.equal(barionService.getRecord(session.sessionId).invoiceNumber, 'OVITE-2026-78');
  assert.equal((await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID })).status, 200);
  assert.equal(calls.invoice, 3, 'két sikertelen (webhook, státuszlekérdezés) és egy sikeres számlázási kísérlet');
});

// ---------- Kézbesítés és számla Barion munkamenettel ----------

test('after a Barion payment the frontend delivery sends the files with the invoice to the payer, once', async (t) => {
  const dir = barionEnv(t, { SMTP_HOST: 'smtp.invalid.example' });
  const holder = {};
  stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);
  await post(base, '/api/webhook/barion', { paymentId: PAYMENT_ID });
  mailService.mockOutbox.length = 0;

  const files = [{ name: 'terv.pdf', base64: Buffer.from('x').toString('base64') }, { name: 'terv.docx', base64: Buffer.from('y').toString('base64') }];
  const deliver = () => post(base, `/api/deliver/${session.sessionId}`, { files, title: 'Őszi erdő', planMode: 'standard' });
  const first = await deliver();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { success: true, sent: true });
  assert.equal(mailService.mockOutbox.length, 1);
  assert.equal(mailService.mockOutbox[0].to, 'vevo@example.com');
  assert.deepEqual(mailService.mockOutbox[0].attachments.filter((name) => /\.(pdf|docx)$/.test(name)), ['terv.pdf', 'terv.docx', 'szamla.pdf']);
  assert.deepEqual(await (await deliver()).json(), { success: true, sent: false, reason: 'already_sent' });
  assert.equal(mailService.mockOutbox.length, 1);

  const invoice = await fetch(`${base}/api/invoice/${session.sessionId}`);
  assert.equal(invoice.status, 200);
  assert.equal(invoice.headers.get('content-type'), 'application/pdf');
  assert.ok(fs.existsSync(path.join(dir, 'invoices', `${session.sessionId}.pdf`)));
});

test('delivery is refused for an unpaid Barion payment and the invoice is not downloadable', async (t) => {
  barionEnv(t, { SMTP_HOST: 'smtp.invalid.example' });
  const holder = {};
  stubExternal(t, { state: () => holder.current() });
  const base = await listen(t);
  const session = await paidSession(t, base, holder);
  holder.current = () => ({ PaymentId: PAYMENT_ID, PaymentRequestId: session.sessionId, Status: 'Started', Total: 390, Currency: 'HUF', Errors: [] });
  mailService.mockOutbox.length = 0;
  const files = [{ name: 'terv.pdf', base64: Buffer.from('x').toString('base64') }];
  assert.equal((await post(base, `/api/deliver/${session.sessionId}`, { files })).status, 402);
  assert.equal((await fetch(`${base}/api/invoice/${session.sessionId}`)).status, 402);
  assert.equal(mailService.mockOutbox.length, 0);
  assert.equal((await post(base, '/api/deliver/barion_000000000000000000000000', { files })).status, 404);
});

test('the Barion session ids and gateway addresses are validated strictly', () => {
  for (const id of ['barion_0123456789abcdef01234567']) assert.equal(barionService.isSessionId(id), true);
  for (const id of ['barion_', 'barion_XYZ', 'cs_test_123456', 'barion_0123456789abcdef0123456789', '../barion_0123456789abcdef01234567', undefined]) assert.equal(barionService.isSessionId(id), false, String(id));
  for (const url of ['https://secure.barion.com/Pay?id=1', 'https://secure.test.barion.com/Pay?id=1']) assert.ok(barionService.GATEWAY_PATTERN.test(url), url);
  for (const url of ['http://secure.barion.com/Pay', 'https://secure.barion.com.evil.example/Pay', 'https://evil.example/https://secure.barion.com/', 'javascript:alert(1)']) assert.equal(barionService.GATEWAY_PATTERN.test(url), false, url);
});
