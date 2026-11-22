const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { makePayload, makePlan } = require('./fixtures');
const server = require('../server');
const planStore = require('../services/planStore');
const supabase = require('../services/supabaseService');
const authService = require('../services/authService');

const ALICE = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const BOB = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const UNCONFIRMED = { id: '33333333-3333-4333-8333-333333333333', email: 'new@example.com', email_confirmed_at: null };
const TOKENS = { 'token-alice': ALICE, 'token-bob': BOB, 'token-new': UNCONFIRMED };

const SECRET = 'Szigorúan bizalmas foglalkozási lépés a gyerekekkel';

function docRow(id, overrides = {}) {
  const plan = { ...makePlan(3), request: { theme: `Téma ${id}`, duration: 'Napi' }, generationId: id };
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [SECRET];
  return { document_id: id, plan_mode: 'standard', unlocked: false, user_id: null, user_email: null, data: { plan, meta: {} }, created_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-01T10:00:00Z', ...overrides };
}

// Mockolt Supabase kliens: auth.getUser(token) és a documents tábla használt lekérdezés-láncai (select/update/upsert, eq/is/in, order, limit).
function fakeAccounts(documents = [], extra = {}) {
  const tables = { documents, profiles: [], orders: [], ...extra };
  const failures = {};
  const calls = { getUser: [], deleteUser: [] };
  const read = (row, column) => (column === 'request' ? row.data?.plan?.request : row[column]);
  return {
    tables,
    failures,
    calls,
    auth: {
      async getUser(token) {
        calls.getUser.push(token);
        if (failures.auth) return { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: failures.auth } };
        const user = TOKENS[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' } };
      },
      admin: {
        async deleteUser(id) {
          calls.deleteUser.push(id);
          return failures.deleteUser ? { data: null, error: { message: failures.deleteUser } } : { data: {}, error: null };
        }
      }
    },
    from(name) {
      const filters = [];
      let patch = null;
      let removing = false;
      let order = null;
      let max = Infinity;
      const run = () => {
        if (failures[name]) return { data: null, error: { message: failures[name] } };
        let rows = tables[name].filter((row) => filters.every((matches) => matches(row)));
        if (patch) rows.forEach((row) => Object.assign(row, patch));
        if (removing) tables[name] = tables[name].filter((row) => !rows.includes(row));
        if (order) rows = [...rows].sort((a, b) => (order.ascending ? 1 : -1) * String(read(a, order.column)).localeCompare(String(read(b, order.column))));
        return { data: rows.slice(0, max).map((row) => ({ ...row, request: row.data?.plan?.request })), error: null };
      };
      const builder = {
        select() { return builder; },
        update(values) { patch = values; return builder; },
        delete() { removing = true; return builder; },
        eq(column, value) { filters.push((row) => read(row, column) === value); return builder; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return builder; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
        order(column, options) { order = { column, ascending: options?.ascending !== false }; return builder; },
        limit(count) { max = count; return builder; },
        maybeSingle() {
          const { data, error } = run();
          return Promise.resolve({ data: data?.[0] || null, error });
        },
        upsert(row, options = {}) {
          const outcome = (data, error) => ({
            select() { return { single: () => Promise.resolve({ data, error }) }; },
            then(resolve, reject) { return Promise.resolve({ data, error }).then(resolve, reject); }
          });
          if (failures[name]) return outcome(null, { message: failures[name] });
          const key = options.onConflict || 'document_id';
          let stored = tables[name].find((item) => item[key] === row[key]);
          if (stored) {
            if (!options.ignoreDuplicates) Object.assign(stored, row);
          } else {
            stored = { created_at: new Date().toISOString(), ...row };
            tables[name].push(stored);
          }
          return outcome({ ...stored }, null);
        },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
      };
      return builder;
    }
  };
}

function useClient(t, client) {
  supabase.setClient(client);
  planStore.clearPlans();
  t.after(() => { supabase.setClient(null); planStore.clearPlans(); });
  return client;
}

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function call(base, route, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

function stubGemini(t, plan) {
  const realFetch = global.fetch;
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'local-test-key';
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') return realFetch(url, options);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(plan) }] } }], usageMetadata: { totalTokenCount: 3000 } });
  };
  t.after(() => {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
  });
}

// ---------- Hitelesítés ----------

test('protected account endpoints demand a valid bearer token', async (t) => {
  const client = useClient(t, fakeAccounts([docRow('gen_a', { user_id: ALICE.id })]));
  const base = await listen(t);

  for (const [route, options] of [['/api/my-documents', {}], ['/api/my-documents/gen_a', {}], ['/api/sync-documents', { method: 'POST', body: { documentIds: [] } }], ['/api/profile', {}], ['/api/profile', { method: 'POST', body: { full_name: 'X' } }], ['/api/my-orders', {}], ['/api/delete-account', { method: 'POST', body: { confirm: true } }]]) {
    const missing = await call(base, route, options);
    assert.equal(missing.status, 401, route);
    assert.equal((await missing.json()).code, 'AUTH_REQUIRED');
    const invalid = await call(base, route, { ...options, token: 'forged-token' });
    assert.equal(invalid.status, 401, route);
    assert.equal((await invalid.json()).code, 'AUTH_INVALID');
  }
  assert.deepEqual(client.calls.getUser.every((token) => token === 'forged-token'), true, 'a token nélküli kérés nem jut el a Supabase-ig');

  const unconfirmed = await call(base, '/api/my-documents', { token: 'token-new' });
  assert.equal(unconfirmed.status, 401, 'megerősítetlen e-mail címmel nem azonosítható a felhasználó');
});

test('account endpoints report 503 instead of silently falling back when Supabase is unavailable', async (t) => {
  supabase.setClient(null);
  const base = await listen(t);
  const response = await call(base, '/api/my-documents', { token: 'token-alice' });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, 'AUTH_UNAVAILABLE');

  const client = useClient(t, fakeAccounts());
  client.failures.auth = 'hálózati hiba';
  const outage = await call(base, '/api/my-documents', { token: 'token-alice' });
  assert.equal(outage.status, 503, 'a Supabase Auth kiesése nem 401');
});

// ---------- GET /api/my-documents ----------

test('GET /api/my-documents lists own documents and unlocked purchases by e-mail, newest first, and nothing else', async (t) => {
  useClient(t, fakeAccounts([
    docRow('gen_own_locked', { user_id: ALICE.id, created_at: '2026-03-01T10:00:00Z' }),
    docRow('gen_own_unlocked', { user_id: ALICE.id, unlocked: true, created_at: '2026-03-05T10:00:00Z' }),
    docRow('gen_email_unlocked', { user_email: ALICE.email, unlocked: true, created_at: '2026-03-03T10:00:00Z' }),
    docRow('gen_email_locked', { user_email: ALICE.email, unlocked: false, created_at: '2026-03-04T10:00:00Z' }),
    docRow('gen_bob', { user_id: BOB.id, user_email: BOB.email, unlocked: true }),
    docRow('gen_guest', { unlocked: true })
  ]));
  const base = await listen(t);

  const response = await call(base, '/api/my-documents', { token: 'token-alice' });
  assert.equal(response.status, 200);
  const { success, documents } = await response.json();
  assert.equal(success, true);
  assert.deepEqual(documents.map((doc) => doc.id), ['gen_own_unlocked', 'gen_email_unlocked', 'gen_own_locked']);
  assert.equal(documents[0].title, 'Téma gen_own_unlocked');
  assert.equal(documents[0].unlocked, true);
  assert.equal(documents[0].owned, true);
  assert.equal(documents[1].owned, false);
  assert.equal(documents[2].unlocked, false);
  assert.equal(JSON.stringify(documents).includes(SECRET), false, 'a lista nem tartalmazhat dokumentumszöveget');

  const bob = await (await call(base, '/api/my-documents', { token: 'token-bob' })).json();
  assert.deepEqual(bob.documents.map((doc) => doc.id), ['gen_bob']);
});

test('a database failure surfaces as an error response, not an empty list', async (t) => {
  const client = useClient(t, fakeAccounts());
  client.failures.documents = 'connection refused';
  const base = await listen(t);
  const response = await call(base, '/api/my-documents', { token: 'token-alice' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).success, false);
});

// ---------- GET /api/my-documents/:id ----------

test('GET /api/my-documents/:id opens full unlocked plans, mirrors locked ones and hides foreign documents', async (t) => {
  useClient(t, fakeAccounts([
    docRow('gen_unlocked', { user_id: ALICE.id, unlocked: true }),
    docRow('gen_locked', { user_id: ALICE.id }),
    docRow('gen_bought', { user_email: ALICE.email, unlocked: true }),
    docRow('gen_bought_locked', { user_email: ALICE.email }),
    docRow('gen_bob', { user_id: BOB.id, unlocked: true })
  ]));
  const base = await listen(t);

  const unlocked = await (await call(base, '/api/my-documents/gen_unlocked', { token: 'token-alice' })).json();
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.plan.generationId, 'gen_unlocked');
  assert.equal(unlocked.plan.kidolgozas_tablazat[0].tevekenyseg_menete[0], SECRET);

  const locked = await (await call(base, '/api/my-documents/gen_locked', { token: 'token-alice' })).json();
  assert.equal(locked.unlocked, false);
  assert.equal(locked.plan.locked_meta.is_locked, true);
  assert.equal(JSON.stringify(locked).includes(SECRET), false, 'a zárolt terv szövege nem szivároghat');

  assert.equal((await (await call(base, '/api/my-documents/gen_bought', { token: 'token-alice' })).json()).unlocked, true);
  assert.equal((await call(base, '/api/my-documents/gen_bought_locked', { token: 'token-alice' })).status, 404, 'e-mail alapján csak a feloldott tervek érhetők el');
  assert.equal((await call(base, '/api/my-documents/gen_bob', { token: 'token-alice' })).status, 404);
  assert.equal((await call(base, '/api/my-documents/nincs_ilyen', { token: 'token-alice' })).status, 404);
  assert.equal((await call(base, '/api/my-documents/' + encodeURIComponent('gen_a,user_id.eq.x'), { token: 'token-alice' })).status, 404);
});

// ---------- POST /api/sync-documents ----------

test('POST /api/sync-documents links only unowned local plans to the account', async (t) => {
  const client = useClient(t, fakeAccounts([
    docRow('gen_free_1'),
    docRow('gen_free_2'),
    docRow('gen_mine', { user_id: ALICE.id }),
    docRow('gen_bobs', { user_id: BOB.id, user_email: BOB.email })
  ]));
  const base = await listen(t);

  const response = await call(base, '/api/sync-documents', {
    token: 'token-alice',
    method: 'POST',
    body: { documentIds: ['gen_free_1', 'gen_free_2', 'gen_bobs', 'gen_mine', 'gen_missing', 'rossz azonosító', 42, 'gen_free_1'] }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).claimed.sort(), ['gen_free_1', 'gen_free_2']);

  const byId = Object.fromEntries(client.tables.documents.map((row) => [row.document_id, row]));
  assert.equal(byId.gen_free_1.user_id, ALICE.id);
  assert.equal(byId.gen_free_1.user_email, ALICE.email);
  assert.equal(byId.gen_free_2.user_id, ALICE.id);
  assert.equal(byId.gen_bobs.user_id, BOB.id, 'más fiókjához tartozó terv nem vehető át');
  assert.equal(byId.gen_bobs.user_email, BOB.email);

  const bad = await call(base, '/api/sync-documents', { token: 'token-alice', method: 'POST', body: { documentIds: 'gen_free_1' } });
  assert.equal(bad.status, 400);
  const empty = await (await call(base, '/api/sync-documents', { token: 'token-alice', method: 'POST', body: { documentIds: [] } })).json();
  assert.deepEqual(empty.claimed, []);
});

// ---------- Tulajdonos mentése, vendég mód ----------

test('generating while logged in stores user_id and user_email; guests and bad tokens stay anonymous', async (t) => {
  const client = useClient(t, fakeAccounts());
  stubGemini(t, makePlan(4));
  const base = await listen(t);
  const generate = (token) => call(base, '/api/generate', { token, method: 'POST', body: makePayload({ preview: true }) });

  const loggedIn = await (await generate('token-alice')).json();
  assert.equal(loggedIn.success, true);
  await new Promise((resolve) => setImmediate(resolve));
  const row = client.tables.documents.find((doc) => doc.document_id === loggedIn.generationId);
  assert.equal(row.user_id, ALICE.id);
  assert.equal(row.user_email, ALICE.email);

  for (const token of [undefined, 'forged-token']) {
    const guest = await (await generate(token)).json();
    assert.equal(guest.success, true, 'érvénytelen token sem akadályozza a vendég módú generálást');
    await new Promise((resolve) => setImmediate(resolve));
    const guestRow = client.tables.documents.find((doc) => doc.document_id === guest.generationId);
    assert.equal('user_id' in guestRow, false);
    assert.equal('user_email' in guestRow, false);
  }
});

test('guest mode works without any Supabase client: generation, planStore and optional auth', async (t) => {
  supabase.setClient(null);
  planStore.clearPlans();
  stubGemini(t, makePlan(4));
  const base = await listen(t);
  const data = await (await call(base, '/api/generate', { method: 'POST', body: makePayload({ preview: true }), token: 'token-alice' })).json();
  assert.equal(data.success, true);
  assert.ok(planStore.getPlan(data.generationId));
  assert.equal(await authService.optionalUser({ headers: { authorization: 'Bearer token-alice' } }), null, 'Supabase nélkül a token figyelmen kívül marad');
  assert.equal(await authService.optionalUser({ headers: {} }), null);
});

test('setOwner keeps an existing user_id and lets a purchase e-mail mark only ownerless plans', async (t) => {
  const client = useClient(t, fakeAccounts());
  planStore.savePlan('gen_o1', { ...makePlan(2), request: { theme: 'x' } });
  planStore.savePlan('gen_o2', { ...makePlan(2), request: { theme: 'y' } }, { userId: BOB.id, email: BOB.email });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await planStore.setOwner('gen_o1', { email: 'Vevo@Example.com' }), true);
  assert.equal(client.tables.documents.find((doc) => doc.document_id === 'gen_o1').user_email, 'vevo@example.com');
  assert.equal(client.tables.documents.find((doc) => doc.document_id === 'gen_o1').user_id, undefined);

  await planStore.setOwner('gen_o2', { userId: ALICE.id, email: ALICE.email });
  await planStore.setOwner('gen_o2', { email: 'masvalaki@example.com' });
  const kept = client.tables.documents.find((doc) => doc.document_id === 'gen_o2');
  assert.equal(kept.user_id, BOB.id);
  assert.equal(kept.user_email, BOB.email);

  assert.equal(await planStore.setOwner('gen_unknown', { userId: ALICE.id }), false);
});

// ---------- Profil, rendeléstörténet, fióktörlés ----------

function relaxLimits(t) {
  const saved = { ACCOUNT_RATE_LIMIT: process.env.ACCOUNT_RATE_LIMIT, ACCOUNT_DELETE_RATE_LIMIT: process.env.ACCOUNT_DELETE_RATE_LIMIT };
  process.env.ACCOUNT_RATE_LIMIT = '1000';
  process.env.ACCOUNT_DELETE_RATE_LIMIT = '1000';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const orderRow = (number, overrides = {}) => ({
  order_number: `OVI-260301-${number}`, user_id: null, user_email: null, document_id: 'gen_x', plan_mode: 'standard', plan_key: 'daily',
  amount: 390, coupon_code: null, payment_method: 'Barion', status: 'paid', invoice_number: 'OVITE-2026-1', created_at: '2026-03-01T10:00:00Z', ...overrides
});

test('GET /api/profile returns the own profile and creates the missing row without leaking other users', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([], { profiles: [{ id: BOB.id, email: BOB.email, billing_name: 'Bob Óvoda', full_name: 'Bob' }] }));
  const base = await listen(t);

  const fresh = await (await call(base, '/api/profile', { token: 'token-alice' })).json();
  assert.equal(fresh.success, true);
  assert.deepEqual(fresh.profile, {
    email: ALICE.email, full_name: '', billing_name: '', billing_zip: '', billing_city: '', billing_address: '', billing_tax_id: '', kindergarten_name: '', group_name: ''
  });
  assert.equal(client.tables.profiles.filter((row) => row.id === ALICE.id).length, 1, 'a hiányzó profilsor létrejön');

  const bob = await (await call(base, '/api/profile', { token: 'token-bob' })).json();
  assert.equal(bob.profile.billing_name, 'Bob Óvoda');
  const again = await (await call(base, '/api/profile', { token: 'token-alice' })).json();
  assert.equal(again.profile.billing_name, '', 'Alice nem látja Bob adatait');
  assert.equal(client.tables.profiles.filter((row) => row.id === ALICE.id).length, 1);
});

test('POST /api/profile saves only known fields, merges partial updates and rejects invalid input', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts());
  const base = await listen(t);
  const save = (body, token = 'token-alice') => call(base, '/api/profile', { method: 'POST', token, body });

  const first = await save({ full_name: ' Kovács   Anna ', billing_name: 'Napsugár <b>Óvoda</b>', billing_zip: '9021', billing_city: 'Győr', billing_address: 'Fő utca 12/B.', billing_tax_id: '12345678-1-08', kindergarten_name: 'Napsugár Óvoda', group_name: 'Katica' });
  assert.equal(first.status, 200);
  const profile = (await first.json()).profile;
  assert.equal(profile.full_name, 'Kovács Anna');
  assert.equal(profile.billing_name, 'Napsugár b Óvoda /b', 'a HTML-jelek eltűnnek');
  assert.equal(profile.email, ALICE.email);

  // Részleges mentés: a többi mező változatlan, az üres szöveg töröl.
  const second = await (await save({ group_name: '' })).json();
  assert.equal(second.profile.group_name, '');
  assert.equal(second.profile.billing_city, 'Győr');

  // Ismeretlen vagy védett mezők nem íródnak: az e-mail és az azonosító a tokenből jön.
  const hostile = await save({ email: 'masik@example.com', id: BOB.id, is_admin: true, billing_city: 'Pécs' });
  assert.equal(hostile.status, 200);
  const row = client.tables.profiles.find((item) => item.id === ALICE.id);
  assert.equal(row.email, ALICE.email);
  assert.equal(row.billing_city, 'Pécs');
  assert.equal('is_admin' in row, false);
  assert.equal(client.tables.profiles.some((item) => item.id === BOB.id), false);

  for (const [body, pattern] of [
    [{}, /Nincs menthető/],
    [{ billing_zip: '!!' }, /irányítószám/],
    [{ billing_tax_id: '%%%' }, /adószám/],
    [{ full_name: 42 }, /szöveges/],
    [['x'], /kötelező/]
  ]) {
    const response = await save(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, pattern);
  }
  assert.equal(client.tables.profiles.find((item) => item.id === ALICE.id).billing_city, 'Pécs', 'az érvénytelen kérés nem módosít');
});

test('a profile database failure is a generic 500 without leaking the database message', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts());
  client.failures.profiles = 'relation "profiles" secret detail';
  const base = await listen(t);
  const response = await call(base, '/api/profile', { method: 'POST', token: 'token-alice', body: { full_name: 'Anna' } });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /secret detail/);
  const read = await call(base, '/api/profile', { token: 'token-alice' });
  assert.equal(read.status, 500);
});

test('GET /api/my-orders lists own orders and guest purchases by e-mail, newest first, never other users', async (t) => {
  relaxLimits(t);
  useClient(t, fakeAccounts([], {
    orders: [
      orderRow('AAAAAA', { user_id: ALICE.id, user_email: ALICE.email, created_at: '2026-03-02T10:00:00Z', amount: 890, plan_key: 'weekly' }),
      orderRow('BBBBBB', { user_email: ALICE.email, created_at: '2026-03-05T10:00:00Z', coupon_code: 'OVI50', amount: 195 }),
      orderRow('CCCCCC', { user_id: BOB.id, user_email: BOB.email }),
      orderRow('DDDDDD', { user_email: BOB.email }),
      orderRow('EEEEEE', { user_id: null, user_email: 'harmadik@example.com' })
    ]
  }));
  const base = await listen(t);

  const response = await call(base, '/api/my-orders', { token: 'token-alice' });
  assert.equal(response.status, 200);
  const { orders } = await response.json();
  assert.deepEqual(orders.map((order) => order.orderNumber), ['OVI-260301-BBBBBB', 'OVI-260301-AAAAAA']);
  assert.deepEqual(orders[1], {
    orderNumber: 'OVI-260301-AAAAAA', documentId: 'gen_x', planMode: 'standard', planKey: 'weekly', amount: 890, couponCode: null, paymentMethod: 'Barion', status: 'paid',
    invoiceNumber: 'OVITE-2026-1', createdAt: '2026-03-02T10:00:00Z'
  });
  assert.equal(orders[0].couponCode, 'OVI50');
  assert.equal(JSON.stringify(orders).includes('user_email'), false);

  const bob = await (await call(base, '/api/my-orders', { token: 'token-bob' })).json();
  assert.deepEqual(bob.orders.map((order) => order.orderNumber).sort(), ['OVI-260301-CCCCCC', 'OVI-260301-DDDDDD']);
});

test('POST /api/delete-account needs explicit confirmation, erases documents and the auth user but keeps orders', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([
    docRow('gen_alice1', { user_id: ALICE.id, user_email: ALICE.email }),
    docRow('gen_alice2', { user_id: ALICE.id }),
    docRow('gen_bought', { user_email: ALICE.email, unlocked: true }),
    docRow('gen_bob', { user_id: BOB.id, user_email: BOB.email })
  ], {
    profiles: [{ id: ALICE.id, email: ALICE.email }],
    orders: [orderRow('AAAAAA', { user_id: ALICE.id, user_email: ALICE.email })]
  }));
  const base = await listen(t);

  for (const body of [undefined, {}, { confirm: 'true' }, { confirm: false }]) {
    const refused = await call(base, '/api/delete-account', { method: 'POST', token: 'token-alice', body: body || { x: 1 } });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(client.calls.deleteUser, [], 'megerősítés nélkül semmi nem törlődik');
  assert.equal(client.tables.documents.length, 4);

  const response = await call(base, '/api/delete-account', { method: 'POST', token: 'token-alice', body: { confirm: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(client.calls.deleteUser, [ALICE.id]);
  assert.deepEqual(client.tables.documents.map((row) => row.document_id).sort(), ['gen_bob', 'gen_bought']);
  assert.equal(client.tables.documents.find((row) => row.document_id === 'gen_bought').user_email, null, 'a vásárlói e-mail cím is törlődik');
  assert.equal(client.tables.documents.find((row) => row.document_id === 'gen_bob').user_id, BOB.id);
  assert.equal(client.tables.orders.length, 1, 'a rendelés a számviteli megőrzés miatt megmarad');
});

test('a failed auth user deletion is reported as an error instead of a silent success', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts());
  client.failures.deleteUser = 'admin api secret detail';
  const base = await listen(t);
  const response = await call(base, '/api/delete-account', { method: 'POST', token: 'token-alice', body: { confirm: true } });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /secret detail/);
  assert.match(text, /"success":false/);
});

test('the new account endpoints answer 503 without a Supabase client', async (t) => {
  relaxLimits(t);
  supabase.setClient(null);
  const base = await listen(t);
  for (const [route, options] of [['/api/profile', {}], ['/api/my-orders', {}], ['/api/delete-account', { method: 'POST', body: { confirm: true } }]]) {
    const response = await call(base, route, { ...options, token: 'token-alice' });
    assert.equal(response.status, 503, route);
  }
});

test('the account client files are shipped and the CSP allows the Supabase host', () => {
  const { SITE_ASSETS, CONTENT_SECURITY_POLICY, SUPABASE_PUBLIC_URL, PAGES } = require('../services/siteConstants');
  assert.ok(SITE_ASSETS.includes('auth.js') && SITE_ASSETS.includes('tervezo-history.js') && SITE_ASSETS.includes('profil.js'));
  assert.ok(PAGES.includes('profil.html'));
  assert.match(CONTENT_SECURITY_POLICY, new RegExp(`connect-src[^;]*${SUPABASE_PUBLIC_URL.replace(/\./g, '\\.')}`));
});

// ---------- Böngészős rész (jsdom) ----------

const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');

const pageHtml = readPage('tervezo.html');
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

async function loadPage(t, { withSupabase, page = pageHtml, pageName = 'tervezo.html', search = '', config = {}, routes = {}, local = true }) {
  const state = { listener: null, otp: [], logins: [], signUps: [], resets: [], updates: [], oauth: [], fetches: [], signOuts: [] };
  const dom = new JSDOM(page, {
    url: `http://localhost:8000/${pageName}${search}`,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
      window.APP_CONFIG = { apiBaseUrl: 'same-origin', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ...config };
      if (local) window.localStorage.setItem('oviKretaUnlocked', JSON.stringify(['gen_local1', 'nem-gen']));
      window.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const method = options.method || 'GET';
        state.fetches.push({ path, method, headers: options.headers || {}, body: options.body });
        const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
        if (routes[path]) return json(...[].concat(routes[path](method, options.body ? JSON.parse(options.body) : null)));
        if (path === '/api/sync-documents') return json({ success: true, claimed: ['gen_local1'] });
        if (path === '/api/my-documents') {
          return json({ success: true, documents: [
            { id: 'gen_cloud1', title: 'Őszi <b>erdő</b>', duration: 'Napi', unlocked: true, owned: true, createdAt: '2026-03-01T10:00:00Z' },
            { id: 'gen_cloud2', title: 'Tavaszi nyitás', duration: 'Heti', unlocked: false, owned: true, createdAt: '2026-03-02T10:00:00Z' }
          ] });
        }
        if (path === '/api/my-documents/gen_cloud1') return json({ success: true, unlocked: true, plan: { ...makePlan(3), request: makePayload(), generationId: 'gen_cloud1' } });
        throw new Error(`váratlan kérés: ${path}`);
      };
      if (withSupabase) {
        window.supabase = {
          createClient: () => ({
            auth: {
              onAuthStateChange(callback) { state.listener = callback; return { data: { subscription: {} } }; },
              async signInWithPassword(args) {
                state.logins.push(args);
                return args.password === 'rosszjelszo' ? { error: { message: 'Invalid login credentials' } } : { data: {}, error: null };
              },
              async signUp(args) { state.signUps.push(args); return { data: { session: null, user: {} }, error: null }; },
              async resetPasswordForEmail(email, options) { state.resets.push({ email, options }); return { error: null }; },
              async updateUser(args) { state.updates.push(args); return { error: null }; },
              async signInWithOAuth(args) { state.oauth.push(args); return { error: null }; },
              async signOut(options) { state.signOuts.push(options); state.listener('SIGNED_OUT', null); return { error: null }; }
            }
          })
        };
      }
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  return { window: dom.window, state };
}

const SESSION = { access_token: 'jwt-alice', user: { id: ALICE.id, email: ALICE.email } };

test('guest mode in the browser: no login button, no auth header, no account requests', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: false });
  assert.equal(window.document.getElementById('authBtn').hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(window.authHeaders())), {});
  assert.equal(window.document.getElementById('cloudPlansField').hidden, true);
  await tick();
  assert.deepEqual(state.fetches, []);
});

const submitAuthForm = (window) => window.document.getElementById('authForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
const visible = (window, id) => !window.document.getElementById(id).hidden;
const text = (window, id) => window.document.getElementById(id).textContent;

test('the auth modal offers login and registration tabs, validates the password and shows the Google login as coming soon', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;
  const authBtn = document.getElementById('authBtn');
  assert.equal(authBtn.hidden, false);
  assert.equal(authBtn.textContent, 'Belépés / Regisztráció');
  authBtn.click();
  assert.ok(document.getElementById('authModal').classList.contains('open'));
  assert.equal(text(window, 'authModalTitle'), 'Bejelentkezés');
  assert.equal(visible(window, 'authNameField'), false);
  assert.equal(visible(window, 'authForgot'), true);
  assert.equal(document.getElementById('authGoogle').disabled, true, 'a Google belépés még nincs beállítva');
  assert.ok(text(window, 'authGoogleSoon').includes('Hamarosan'));

  // Hibás e-mail és hiányzó jelszó: nem megy ki hívás.
  document.getElementById('authEmail').value = 'nem-email';
  submitAuthForm(window);
  await tick();
  assert.ok(text(window, 'authError').length > 0);
  document.getElementById('authEmail').value = 'tanar@example.com';
  submitAuthForm(window);
  await tick();
  assert.match(text(window, 'authError'), /jelszav/);
  assert.equal(state.logins.length, 0);

  // Hibás jelszó: magyar hibaüzenet, a modál nyitva marad.
  document.getElementById('authPassword').value = 'rosszjelszo';
  submitAuthForm(window);
  await tick();
  assert.equal(text(window, 'authError'), 'Hibás e-mail cím vagy jelszó.');
  assert.ok(document.getElementById('authModal').classList.contains('open'));

  // Sikeres belépés: a modál bezárul.
  document.getElementById('authPassword').value = 'joJelszo123';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.logins.at(-1))), { email: 'tanar@example.com', password: 'joJelszo123' });
  assert.equal(document.getElementById('authModal').classList.contains('open'), false);

  // Szemecske: a jelszó láthatóvá válik, majd újra elrejtődik.
  authBtn.click();
  const password = document.getElementById('authPassword');
  const toggle = document.getElementById('authPasswordToggle');
  assert.equal(password.type, 'password');
  toggle.click();
  assert.equal(password.type, 'text');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  toggle.click();
  assert.equal(password.type, 'password');

  // Regisztráció: név mező, minimum 8 karakteres jelszó, megerősítő levél.
  document.querySelector('[data-auth-tab="register"]').click();
  assert.equal(text(window, 'authModalTitle'), 'Regisztráció');
  assert.equal(visible(window, 'authNameField'), true);
  assert.equal(visible(window, 'authForgot'), false);
  document.getElementById('authName').value = 'Kovács Anna';
  document.getElementById('authEmail').value = 'anna@example.com';
  password.value = 'rovid';
  submitAuthForm(window);
  await tick();
  assert.match(text(window, 'authError'), /8 karakter/);
  assert.equal(state.signUps.length, 0);
  password.value = 'hosszabbJelszo1';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.signUps)), [{
    email: 'anna@example.com', password: 'hosszabbJelszo1', options: { emailRedirectTo: 'http://localhost:8000/tervezo.html', data: { full_name: 'Kovács Anna' } }
  }]);
  assert.match(text(window, 'authStatus'), /megerősítő levelet/);
  assert.equal(password.value, '', 'a jelszó nem marad a mezőben');
});

test('forgot password sends a reset link and a recovery session opens the new-password form', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;
  document.getElementById('authBtn').click();
  document.getElementById('authForgot').click();
  assert.equal(text(window, 'authModalTitle'), 'Elfelejtett jelszó');
  assert.equal(visible(window, 'authPasswordField'), false);
  assert.equal(visible(window, 'authTabs'), false);
  document.getElementById('authEmail').value = 'tanar@example.com';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.resets)), [{ email: 'tanar@example.com', options: { redirectTo: 'http://localhost:8000/tervezo.html' } }]);
  assert.match(text(window, 'authStatus'), /visszaállító linket/);
  document.getElementById('authBack').click();
  assert.equal(text(window, 'authModalTitle'), 'Bejelentkezés');

  window.closeModals();
  state.listener('PASSWORD_RECOVERY', SESSION);
  await tick();
  assert.ok(document.getElementById('authModal').classList.contains('open'));
  assert.equal(text(window, 'authModalTitle'), 'Új jelszó megadása');
  assert.equal(visible(window, 'authEmailField'), false);
  document.getElementById('authPassword').value = 'rovid';
  submitAuthForm(window);
  await tick();
  assert.equal(state.updates.length, 0);
  document.getElementById('authPassword').value = 'ujJelszo12345';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.updates)), [{ password: 'ujJelszo12345' }]);
  assert.equal(document.getElementById('authModal').classList.contains('open'), false);
});

test('the Google login button becomes active only when the provider is enabled in the config', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true, config: { googleAuthEnabled: true } });
  const google = window.document.getElementById('authGoogle');
  assert.equal(google.disabled, false);
  window.document.getElementById('authBtn').click();
  google.click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.oauth)), [{ provider: 'google', options: { redirectTo: 'http://localhost:8000/tervezo.html' } }]);
});

test('logging in syncs local plan ids, lists cloud plans, opens them and logging out clears them', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;

  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(document.getElementById('authBtn').textContent, 'Fiókom');
  assert.ok(document.getElementById('authBtn').title.includes(ALICE.email));

  const sync = state.fetches.find((call) => call.path === '/api/sync-documents');
  assert.deepEqual(JSON.parse(sync.body).documentIds, ['gen_local1'], 'csak a gen_ előtagú helyi azonosítók mennek ki');
  assert.equal(sync.headers.Authorization, 'Bearer jwt-alice');
  const list = state.fetches.find((call) => call.path === '/api/my-documents');
  assert.equal(list.headers.Authorization, 'Bearer jwt-alice');
  assert.ok(state.fetches.indexOf(sync) < state.fetches.indexOf(list), 'előbb a szinkronizálás, aztán a lista');

  assert.equal(document.getElementById('cloudPlansField').hidden, false);
  const cards = document.querySelectorAll('#cloudPlansPanel [data-cloud-id]');
  assert.equal(cards.length, 2);
  assert.ok(cards[0].textContent.includes('Őszi <b>erdő</b>'));
  assert.equal(cards[0].querySelector('b'), null, 'a cím escape-elve jelenik meg');
  assert.ok(cards[0].textContent.includes('Felhőben mentve'));
  assert.ok(cards[0].querySelector('[data-cloud-action="docx"]') && cards[0].querySelector('[data-cloud-action="pdf"]'));
  assert.equal(cards[1].querySelector('[data-cloud-action="docx"]'), null, 'zárolt terv nem tölthető le');

  cards[0].querySelector('[data-cloud-action="open"]').click();
  await tick();
  assert.equal(window.lastResult.generationId, 'gen_cloud1');
  assert.ok(window.getUnlockedIds().includes('gen_cloud1'));
  assert.ok(document.querySelector('#resultDocument .official-table'));
  assert.equal(window.isPlanLocked(), false);

  await window.OviAuth.signOut();
  await tick();
  assert.equal(state.signOuts.length, 1);
  assert.equal(document.getElementById('authBtn').textContent, 'Belépés / Regisztráció');
  assert.equal(document.getElementById('cloudPlansField').hidden, true);
  assert.equal(document.getElementById('cloudPlansPanel').children.length, 0);
});

test('?open=<id> from the profile page opens the plan after login and asks guests to log in first', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true, search: '?open=gen_cloud1' });
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(window.lastResult.generationId, 'gen_cloud1');
  assert.equal(window.location.search, '', 'a paraméter eltűnik a címsorból');

  const guest = await loadPage(t, { withSupabase: true, search: '?open=gen_cloud1' });
  guest.state.listener('INITIAL_SESSION', null);
  await tick();
  assert.ok(guest.window.document.getElementById('authModal').classList.contains('open'));
  assert.equal(guest.window.lastResult, undefined);
});

// ---------- Profil oldal (profil.html, jsdom) ----------

const profilHtml = readPage('profil.html');

function profilRoutes(overrides = {}) {
  const profile = { email: ALICE.email, full_name: 'Kovács Anna', billing_name: '', billing_zip: '', billing_city: '', billing_address: '', billing_tax_id: '', kindergarten_name: 'Napsugár', group_name: '' };
  return {
    '/api/profile': (method, body) => {
      if (method === 'POST') { Object.assign(profile, body); return [{ success: true, profile: { ...profile } }]; }
      return [{ success: true, profile: { ...profile } }];
    },
    '/api/my-documents': () => [{ success: true, documents: [
      { id: 'gen_cloud1', title: 'Őszi <b>erdő</b>', duration: 'Napi', unlocked: true, createdAt: '2026-03-01T10:00:00Z' },
      { id: 'gen_cloud2', title: 'Tavaszi nyitás', duration: 'Heti', unlocked: false, createdAt: '2026-03-02T10:00:00Z' }
    ] }],
    '/api/my-orders': () => [{ success: true, orders: [
      { orderNumber: 'OVI-260301-AAAAAA', planKey: 'weekly_detailed', planMode: 'standard', amount: 890, couponCode: null, status: 'paid', invoiceNumber: 'OVITE-2026-1', createdAt: '2026-03-01T10:00:00Z' },
      { orderNumber: 'OVI-260302-BBBBBB', planKey: 'daily', planMode: 'standard', amount: 390, couponCode: 'OVI50', status: 'failed', invoiceNumber: null, createdAt: '2026-03-02T10:00:00Z' }
    ] }],
    ...overrides
  };
}

const loadProfil = (t, options = {}) => loadPage(t, { withSupabase: true, page: profilHtml, pageName: 'profil.html', local: false, routes: profilRoutes(), ...options });

test('profil.html shows a login gate for guests and never calls the account API', async (t) => {
  const { window, state } = await loadProfil(t);
  state.listener('INITIAL_SESSION', null);
  await tick();
  assert.equal(visible(window, 'profileGate'), true);
  assert.equal(visible(window, 'profileApp'), false);
  window.document.getElementById('profileLogin').click();
  assert.ok(window.document.getElementById('authModal').classList.contains('open'));
  assert.deepEqual(state.fetches, []);
});

test('profil.html loads the profile, saves billing data, lists documents and orders with escaped content', async (t) => {
  const { window, state } = await loadProfil(t);
  const document = window.document;
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(visible(window, 'profileApp'), true);
  assert.equal(visible(window, 'profileGate'), false);
  assert.equal(document.getElementById('profileFullName').value, 'Kovács Anna');
  assert.equal(document.getElementById('profileEmailField').value, ALICE.email);
  assert.equal(document.getElementById('profileEmailField').readOnly, true);
  assert.equal(state.fetches[0].headers.Authorization, 'Bearer jwt-alice');

  // Részleges számlázási adat nem menthető.
  document.getElementById('profileBillingName').value = 'Napsugár Óvoda';
  document.getElementById('profileForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.match(text(window, 'profileError'), /teljesen/);
  assert.equal(state.fetches.filter((call) => call.method === 'POST').length, 0);

  document.getElementById('profileBillingZip').value = '9021';
  document.getElementById('profileBillingCity').value = 'Győr';
  document.getElementById('profileBillingAddress').value = 'Fő utca 12/B.';
  document.getElementById('profileForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  const post = state.fetches.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/profile');
  assert.deepEqual({ name: JSON.parse(post.body).billing_name, zip: JSON.parse(post.body).billing_zip }, { name: 'Napsugár Óvoda', zip: '9021' });
  assert.equal(text(window, 'profileStatus'), 'Az adatok mentve.');
  assert.equal(document.getElementById('profileBillingCity').value, 'Győr');

  // Dokumentumok fül.
  document.querySelector('[data-profile-tab="documents"]').click();
  await tick();
  assert.equal(visible(window, 'panelDocuments'), true);
  assert.equal(visible(window, 'panelProfile'), false);
  const docs = document.querySelectorAll('#documentsList li');
  assert.equal(docs.length, 2);
  assert.equal(docs[0].querySelector('b'), null, 'a cím escape-elve jelenik meg');
  const hrefs = [...docs[0].querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['tervezo.html?open=gen_cloud1', 'tervezo.html?open=gen_cloud1&download=docx', 'tervezo.html?open=gen_cloud1&download=pdf']);
  assert.deepEqual([...docs[1].querySelectorAll('a')].map((a) => a.getAttribute('href')), ['tervezo.html?open=gen_cloud2'], 'zárolt tervnek nincs letöltés');

  // Rendeléstörténet fül.
  document.querySelector('[data-profile-tab="orders"]').click();
  await tick();
  const orders = [...document.querySelectorAll('#ordersList li')].map((li) => li.textContent);
  assert.equal(orders.length, 2);
  assert.ok(orders[0].includes('Heti részletes csomag') && orders[0].includes('OVI-260301-AAAAAA') && orders[0].includes('OVITE-2026-1') && orders[0].includes('Fizetve'));
  assert.ok(orders[1].includes('Napi tervezet') && orders[1].includes('Kupon: OVI50') && orders[1].includes('Sikertelen'));
});

test('profil.html deletes the account only after the confirmation popup, then shows the final screen and signs out locally', async (t) => {
  const { window, state } = await loadProfil(t, { routes: profilRoutes({ '/api/delete-account': () => [{ success: true }] }) });
  const document = window.document;
  state.listener('INITIAL_SESSION', SESSION);
  await tick();

  document.getElementById('deleteOpen').click();
  assert.ok(document.getElementById('deleteModal').classList.contains('open'));
  assert.equal(state.fetches.some((call) => call.path === '/api/delete-account'), false, 'a gomb önmagában még nem töröl');

  document.getElementById('deleteConfirm').click();
  await tick();
  const call = state.fetches.find((item) => item.path === '/api/delete-account');
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(call.body), { confirm: true });
  assert.equal(visible(window, 'profileDeleted'), true);
  assert.equal(visible(window, 'profileGate'), false, 'a kijelentkezés nem írja felül a végső képernyőt');
  assert.deepEqual(JSON.parse(JSON.stringify(state.signOuts)), [{ scope: 'local' }]);
  assert.equal(document.getElementById('deleteModal').classList.contains('open'), false);
});

test('profil.html keeps the account and shows the server message when the deletion fails', async (t) => {
  const { window, state } = await loadProfil(t, { routes: profilRoutes({ '/api/delete-account': () => [{ success: false, error: 'A fiók törlése sikertelen. Kérjük, próbáld újra később.' }, 500] }) });
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  window.document.getElementById('deleteOpen').click();
  window.document.getElementById('deleteConfirm').click();
  await tick();
  assert.match(text(window, 'deleteError'), /sikertelen/);
  assert.equal(visible(window, 'profileApp'), true);
  assert.equal(visible(window, 'profileDeleted'), false);
  assert.deepEqual(state.signOuts, []);
  assert.equal(window.document.getElementById('deleteConfirm').disabled, false);
});

test('profil.html logout button signs the user out and returns to the login gate', async (t) => {
  const { window, state } = await loadProfil(t);
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  window.document.getElementById('profileLogout').click();
  await tick();
  assert.equal(state.signOuts.length, 1);
  assert.equal(visible(window, 'profileGate'), true);
  assert.equal(visible(window, 'profileApp'), false);
});
