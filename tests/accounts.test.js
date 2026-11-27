const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { makePayload, makePlan } = require('./fixtures');
const server = require('../backend/server');
const planStore = require('../backend/services/planStore');
const supabase = require('../backend/services/supabaseService');
const authService = require('../backend/services/authService');

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
  const tables = { documents, profiles: [], orders: [], deleted_accounts_archive: [], newsletter_subscribers: [], ...extra };
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
      // A rendszerbeállítások és e-mail sablonok táblái üresek: az alapértékek érvényesek.
      if (name === 'system_settings' || name === 'email_templates') return { select: async () => ({ data: [], error: null }) };
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
        not(column, operator, value) { filters.push((row) => (row[column] ?? null) !== value); return builder; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
        lt(column, value) { filters.push((row) => String(row[column]) < String(value)); return builder; },
        single() {
          const { data, error } = run();
          return Promise.resolve({ data: data?.[0] || null, error });
        },
        insert(row) {
          if (failures[name]) return { select: () => ({ single: () => Promise.resolve({ data: null, error: { message: failures[name] } }) }) };
          const stored = { id: `arch-${tables[name].length + 1}`, deleted_at: new Date().toISOString(), ...row };
          tables[name].push(stored);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: stored.id }, error: null }) }) };
        },
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
    email: ALICE.email, full_name: '', billing_name: '', billing_zip: '', billing_city: '', billing_address: '', billing_tax_id: '', kindergarten_name: '', group_name: '', newsletter_subscribed: false
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

test('POST /api/delete-account needs confirmation, archives profile and document ids first, detaches documents and keeps orders', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([
    docRow('gen_alice1', { user_id: ALICE.id, user_email: ALICE.email }),
    docRow('gen_alice2', { user_id: ALICE.id }),
    docRow('gen_bought', { user_email: ALICE.email, unlocked: true }),
    docRow('gen_bob', { user_id: BOB.id, user_email: BOB.email })
  ], {
    profiles: [{ id: ALICE.id, email: ALICE.email, full_name: 'Kovács Anna', billing_name: 'Napsugár Óvoda', billing_city: 'Győr' }],
    orders: [orderRow('AAAAAA', { user_id: ALICE.id, user_email: ALICE.email })]
  }));
  // Az archív sor már a felhasználó törlése előtt létezik.
  const realDelete = client.auth.admin.deleteUser;
  let archivedBeforeDelete = null;
  client.auth.admin.deleteUser = async (id) => {
    archivedBeforeDelete = client.tables.deleted_accounts_archive.map((row) => ({ ...row }));
    return realDelete(id);
  };
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

  // Soft-archive: profil + saját tervek azonosítói, 30 napos visszaállítási határidővel.
  assert.equal(archivedBeforeDelete.length, 1, 'az archiválás megelőzi a fiók törlését');
  const [archive] = client.tables.deleted_accounts_archive;
  assert.equal(archive.original_user_id, ALICE.id);
  assert.equal(archive.email, ALICE.email);
  assert.equal(archive.profile_data.full_name, 'Kovács Anna');
  assert.equal(archive.profile_data.billing_name, 'Napsugár Óvoda');
  assert.deepEqual([...archive.document_ids].sort(), ['gen_alice1', 'gen_alice2']);
  const days = (Date.parse(archive.restore_until) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30, `a visszaállítási határidő 30 nap (${days})`);

  // A tervezetek nem törlődnek, csak elszakadnak a fióktól és az e-mail címtől.
  assert.deepEqual(client.tables.documents.map((row) => row.document_id).sort(), ['gen_alice1', 'gen_alice2', 'gen_bob', 'gen_bought']);
  for (const id of ['gen_alice1', 'gen_alice2']) {
    const row = client.tables.documents.find((item) => item.document_id === id);
    assert.equal(row.user_id, null, id);
    assert.equal(row.user_email, null, id);
  }
  assert.equal(client.tables.documents.find((row) => row.document_id === 'gen_bought').user_email, null, 'a vásárlói e-mail cím is törlődik');
  assert.equal(client.tables.documents.find((row) => row.document_id === 'gen_bob').user_id, BOB.id);
  assert.equal(client.tables.orders.length, 1, 'a rendelés a számviteli megőrzés miatt megmarad');
});

test('a failed auth user deletion is reported as an error, rolls the archive back and keeps the documents', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([docRow('gen_alice1', { user_id: ALICE.id, user_email: ALICE.email })]));
  client.failures.deleteUser = 'admin api secret detail';
  const base = await listen(t);
  const response = await call(base, '/api/delete-account', { method: 'POST', token: 'token-alice', body: { confirm: true } });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /secret detail/);
  assert.match(text, /"success":false/);
  assert.deepEqual(client.tables.deleted_accounts_archive, [], 'sikertelen törlésnél nem marad archív sor');
  assert.equal(client.tables.documents[0].user_id, ALICE.id);
  assert.equal(client.tables.documents[0].user_email, ALICE.email);
});

test('an archive failure stops the account deletion before anything is removed', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([docRow('gen_alice1', { user_id: ALICE.id })]));
  client.failures.deleted_accounts_archive = 'archive secret detail';
  const base = await listen(t);
  const response = await call(base, '/api/delete-account', { method: 'POST', token: 'token-alice', body: { confirm: true } });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret detail/);
  assert.deepEqual(client.calls.deleteUser, [], 'archiválás nélkül a fiók nem törlődik');
  assert.equal(client.tables.documents[0].user_id, ALICE.id);
});

test('purgeExpiredArchives removes expired archives with their detached documents only', async (t) => {
  const profileService = require('../backend/services/profileService');
  const past = '2026-01-01T00:00:00.000Z';
  const future = new Date(Date.now() + 86400000).toISOString();
  const client = useClient(t, fakeAccounts([
    docRow('gen_expired_detached'),
    docRow('gen_expired_reowned', { user_id: BOB.id }),
    docRow('gen_active_detached'),
    docRow('gen_other')
  ], {
    deleted_accounts_archive: [
      { id: 'arch-old', original_user_id: ALICE.id, document_ids: ['gen_expired_detached', 'gen_expired_reowned'], restore_until: past },
      { id: 'arch-new', original_user_id: BOB.id, document_ids: ['gen_active_detached'], restore_until: future }
    ]
  }));

  assert.equal(await profileService.purgeExpiredArchives(), 1);
  assert.deepEqual(client.tables.deleted_accounts_archive.map((row) => row.id), ['arch-new']);
  assert.deepEqual(client.tables.documents.map((row) => row.document_id).sort(), ['gen_active_detached', 'gen_expired_reowned', 'gen_other'], 'csak a gazdátlan, lejárt tervek törlődnek');

  supabase.setClient(null);
  assert.equal(await profileService.purgeExpiredArchives(), 0, 'kliens nélkül nincs teendő');
});

// ---------- DELETE /api/my-documents/:id ----------

test('DELETE /api/my-documents/:id deletes only the own cloud plan and hides everything else', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([
    docRow('gen_mine', { user_id: ALICE.id, user_email: ALICE.email }),
    docRow('gen_bought', { user_email: ALICE.email, unlocked: true }),
    docRow('gen_bob', { user_id: BOB.id }),
    docRow('gen_guest')
  ]));
  const base = await listen(t);
  const remove = (id, token = 'token-alice') => call(base, `/api/my-documents/${encodeURIComponent(id)}`, { method: 'DELETE', token });

  const noToken = await remove('gen_mine', null);
  assert.equal(noToken.status, 401);
  assert.equal(client.tables.documents.length, 4);

  for (const id of ['gen_bob', 'gen_guest', 'gen_bought', 'gen_missing', 'gen_a,user_id.eq.x']) {
    assert.equal((await remove(id)).status, 404, id);
  }
  assert.equal(client.tables.documents.length, 4, 'idegen vagy e-mail alapú terv nem törölhető');

  const own = await remove('gen_mine');
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { success: true });
  assert.deepEqual(client.tables.documents.map((row) => row.document_id).sort(), ['gen_bob', 'gen_bought', 'gen_guest']);
  assert.equal((await remove('gen_mine')).status, 404, 'a törölt terv nem törölhető újra');
});

test('the CORS preflight allows DELETE for the account API', async (t) => {
  const base = await listen(t);
  const response = await fetch(`${base}/api/my-documents/gen_x`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://ovitervezo.hu', 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization' }
  });
  assert.match(response.headers.get('access-control-allow-methods') || '', /DELETE/);
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
  const { SITE_ASSETS, CONTENT_SECURITY_POLICY, SUPABASE_PUBLIC_URL, PAGES } = require('../backend/services/siteConstants');
  assert.ok(SITE_ASSETS.includes('js/auth.js') && SITE_ASSETS.includes('js/tervezo-history.js') && SITE_ASSETS.includes('js/profil.js'));
  assert.ok(PAGES.includes('profil.html'));
  assert.match(CONTENT_SECURITY_POLICY, new RegExp(`connect-src[^;]*${SUPABASE_PUBLIC_URL.replace(/\./g, '\\.')}`));
});

// ---------- Böngészős rész (jsdom) ----------

const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');

const pageHtml = readPage('tervezo.html');
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

async function loadPage(t, { withSupabase, page = pageHtml, pageName = 'tervezo.html', search = '', config = {}, routes = {}, local = true, history = null, turnstile = false }) {
  const state = { listener: null, otp: [], logins: [], signUps: [], resets: [], updates: [], oauth: [], fetches: [], signOuts: [], order: [], turnstile: { renders: [], resets: [], removes: [] } };
  const dom = new JSDOM(page, {
    url: `http://localhost:8000/${pageName}${search}`,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
      window.confirm = () => true;
      window.APP_CONFIG = { apiBaseUrl: 'same-origin', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ...config };
      if (local) window.localStorage.setItem('oviKretaUnlocked', JSON.stringify(['gen_local1', 'nem-gen']));
      if (history) window.localStorage.setItem('oviKretaPlansHistory', JSON.stringify(history));
      if (turnstile) {
        window.turnstile = {
          render(target, options) { state.turnstile.renders.push({ target, options }); state.turnstile.last = options; return `widget-${state.turnstile.renders.length}`; },
          reset(id) { state.order.push('reset'); state.turnstile.resets.push(id); },
          remove(id) { state.turnstile.removes.push(id); }
        };
      }
      window.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const method = options.method || 'GET';
        // A site.js futásidőben lekéri a nyilvános konfigot; ez nem számít account API-hívásnak.
        if (path !== '/api/config') state.fetches.push({ path, method, headers: options.headers || {}, body: options.body });
        const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
        if (routes[path]) return json(...[].concat(routes[path](method, options.body ? JSON.parse(options.body) : null)));
        if (path === '/api/config') return json({ success: true, pricing: { standard: 390, academic: 690, weekly: 890 }, maintenance_mode: false, seasonal_hints: ['őszi falevelek gyűjtése'] });
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
                state.order.push('signIn');
                state.logins.push(args);
                await new Promise((resolve) => setTimeout(resolve, 20));
                state.order.push('signIn-done');
                if (args.password === 'secretmismatch') return { error: { message: 'captcha protection: request disallowed (invalid-input-secret)' } };
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
  // Egyedül a nyilvános konfiguráció kérése megengedett; fiókkérés nincs.
  assert.deepEqual(state.fetches.filter((call) => call.path !== '/api/config'), []);
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
    email: 'anna@example.com', password: 'hosszabbJelszo1', options: { emailRedirectTo: 'http://localhost:8000/tervezo.html', data: { full_name: 'Kovács Anna', newsletter_subscribed: false } }
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

test('logging in lists cloud plans without silently merging local ones, and logging out clears them', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;

  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(document.getElementById('authBtn').textContent, 'Fiókom');
  assert.ok(document.getElementById('authBtn').title.includes(ALICE.email));

  assert.equal(state.fetches.some((call) => call.path === '/api/sync-documents'), false, 'belépéskor nincs automatikus összefésülés');
  const list = state.fetches.find((call) => call.path === '/api/my-documents');
  assert.equal(list.headers.Authorization, 'Bearer jwt-alice');

  assert.equal(document.getElementById('cloudPlansField').hidden, false);
  const cards = document.querySelectorAll('#cloudPlansPanel [data-cloud-id]');
  assert.equal(cards.length, 2);
  assert.ok(cards[0].textContent.includes('Őszi <b>erdő</b>'));
  assert.equal(cards[0].querySelector('b'), null, 'a cím escape-elve jelenik meg');
  assert.ok(cards[0].textContent.includes('Profilba mentve'));
  assert.ok(cards[0].querySelector('[data-cloud-action="docx"]') && cards[0].querySelector('[data-cloud-action="pdf"]'));
  assert.equal(cards[1].querySelector('[data-cloud-action="docx"]'), null, 'zárolt terv nem tölthető le');
  assert.ok(cards[1].querySelector('[data-cloud-action="delete"]'), 'a profilba mentett terv törölhető');

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

const localEntry = (id, theme) => ({ id, generationId: id, theme, duration: 'Napi', savedAt: '2026-03-01T10:00:00Z', status: 'draft', paid: false, payload: { theme }, planData: null });

test('local plans are marked Helyi / Offline, only logged-in users can save them to the profile, and cloud plans can be deleted', async (t) => {
  let cloud = [
    { id: 'gen_cloud1', title: 'Őszi erdő', duration: 'Napi', unlocked: true, owned: true, createdAt: '2026-03-01T10:00:00Z' },
    { id: 'gen_cloud2', title: 'Tavaszi nyitás', duration: 'Heti', unlocked: false, owned: true, createdAt: '2026-03-02T10:00:00Z' }
  ];
  const { window, state } = await loadPage(t, {
    withSupabase: true,
    history: [localEntry('gen_local1', 'Helyi terv'), localEntry('gen_cloud1', 'Már mentett terv'), localEntry('hist_x1', 'Régi terv')],
    routes: {
      '/api/my-documents': () => [{ success: true, documents: cloud }],
      '/api/sync-documents': (_method, body) => {
        cloud = [{ id: body.documentIds[0], title: 'Helyi terv', duration: 'Napi', unlocked: false, owned: true, createdAt: '2026-03-03T10:00:00Z' }, ...cloud];
        return [{ success: true, claimed: body.documentIds }];
      },
      '/api/my-documents/gen_cloud2': (method) => {
        assert.equal(method, 'DELETE');
        cloud = cloud.filter((item) => item.id !== 'gen_cloud2');
        return [{ success: true }];
      }
    }
  });
  const document = window.document;
  const localCard = (id) => document.querySelector(`#historyPanel [data-history-id="${id}"]`);

  // Vendégként: minden helyi terv "Helyi / Offline", mentés gomb nincs.
  for (const id of ['gen_local1', 'gen_cloud1', 'hist_x1']) {
    assert.ok(localCard(id).textContent.includes('Helyi / Offline'), id);
    assert.equal(localCard(id).querySelector('[data-action="adopt"]'), null, id);
  }

  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(state.fetches.some((call) => call.path === '/api/sync-documents'), false);
  assert.ok(localCard('gen_local1').textContent.includes('Helyi / Offline'));
  assert.equal(localCard('gen_local1').querySelector('[data-action="adopt"]').textContent, 'Mentés a profilomba');
  assert.ok(localCard('gen_cloud1').textContent.includes('Profilba mentve'), 'a fiókban lévő terv jelölése');
  assert.equal(localCard('gen_cloud1').querySelector('[data-action="adopt"]'), null);
  assert.ok(localCard('hist_x1').textContent.includes('Helyi / Offline'));
  assert.equal(localCard('hist_x1').querySelector('[data-action="adopt"]'), null, 'csak a szerveren tárolt (gen_) terv menthető');
  assert.equal(document.querySelectorAll('#cloudPlansPanel [data-cloud-id]').length, 2);

  // Kifejezett mentés: egyetlen azonosító megy ki, a kártya átvált, a felhős lista bővül.
  localCard('gen_local1').querySelector('[data-action="adopt"]').click();
  await tick();
  const sync = state.fetches.filter((call) => call.path === '/api/sync-documents');
  assert.equal(sync.length, 1);
  assert.deepEqual(JSON.parse(sync[0].body), { documentIds: ['gen_local1'] });
  assert.equal(sync[0].headers.Authorization, 'Bearer jwt-alice');
  assert.ok(localCard('gen_local1').textContent.includes('Profilba mentve'));
  assert.equal(localCard('gen_local1').querySelector('[data-action="adopt"]'), null);
  assert.deepEqual([...document.querySelectorAll('#cloudPlansPanel [data-cloud-id]')].map((card) => card.dataset.cloudId), ['gen_local1', 'gen_cloud1', 'gen_cloud2']);

  // Felhős terv törlése: megerősítés után DELETE, a lista frissül.
  let confirmed = false;
  window.confirm = () => { confirmed = true; return false; };
  document.querySelector('#cloudPlansPanel [data-cloud-id="gen_cloud2"] [data-cloud-action="delete"]').click();
  await tick();
  assert.equal(confirmed, true);
  assert.equal(state.fetches.some((call) => call.method === 'DELETE'), false, 'megerősítés nélkül nincs törlés');
  window.confirm = () => true;
  document.querySelector('#cloudPlansPanel [data-cloud-id="gen_cloud2"] [data-cloud-action="delete"]').click();
  await tick();
  const removal = state.fetches.find((call) => call.method === 'DELETE');
  assert.equal(removal.path, '/api/my-documents/gen_cloud2');
  assert.equal(removal.headers.Authorization, 'Bearer jwt-alice');
  assert.deepEqual([...document.querySelectorAll('#cloudPlansPanel [data-cloud-id]')].map((card) => card.dataset.cloudId), ['gen_local1', 'gen_cloud1']);

  // Kilépés után ismét minden helyi terv "Helyi / Offline", mentés gomb nélkül.
  await window.OviAuth.signOut();
  await tick();
  assert.ok(localCard('gen_local1').textContent.includes('Helyi / Offline'));
  assert.equal(localCard('gen_local1').querySelector('[data-action="adopt"]'), null);
});

test('a failed profile save keeps the plan local and shows the server message', async (t) => {
  const { window, state } = await loadPage(t, {
    withSupabase: true,
    history: [localEntry('gen_local1', 'Helyi terv')],
    routes: { '/api/sync-documents': () => [{ success: true, claimed: [] }] }
  });
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  const card = window.document.querySelector('#historyPanel [data-history-id="gen_local1"]');
  card.querySelector('[data-action="adopt"]').click();
  await tick();
  const after = window.document.querySelector('#historyPanel [data-history-id="gen_local1"]');
  assert.ok(after.textContent.includes('Helyi / Offline'));
  assert.ok(after.querySelector('[data-action="adopt"]'), 'a gomb újra használható');
  assert.match(window.document.body.textContent, /nem menthető a profilba/);
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
  assert.ok(orders[0].includes('Teljes heti csomag') && orders[0].includes('OVI-260301-AAAAAA') && orders[0].includes('OVITE-2026-1') && orders[0].includes('Fizetve'));
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

test('profil.html has a subdued delete link at the bottom instead of the red danger zone and no billing hint text', async (t) => {
  const { window } = await loadProfil(t);
  const html = window.document.documentElement.outerHTML;
  assert.equal(/Veszélyzóna/i.test(html), false);
  assert.equal(window.document.querySelector('.profile-danger'), null);
  assert.equal(html.includes('A számlázási adatok a következő vásárláskor automatikusan kitöltődnek'), false);
  const link = window.document.querySelector('#profileApp .profile-footer #deleteOpen');
  assert.equal(link.textContent.trim(), 'Fiók törlése');
  assert.match(window.document.getElementById('deleteModal').textContent, /30 napig/);
});

// ---------- Cloudflare Turnstile a belépési ablakban ----------

test('Turnstile: with an empty site key the auth modal shows no widget, loads no script and sends no captcha token', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true, turnstile: true, config: { turnstileSiteKey: '' } });
  const document = window.document;
  document.getElementById('authBtn').click();
  await tick();
  assert.equal(document.getElementById('authCaptcha').hidden, true);
  assert.equal(state.turnstile.renders.length, 0);
  assert.equal(document.getElementById('turnstileScript'), null);
  document.getElementById('authEmail').value = 'tanar@example.com';
  document.getElementById('authPassword').value = 'joJelszo123';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.logins)), [{ email: 'tanar@example.com', password: 'joJelszo123' }]);
});

test('Turnstile: a configured site key renders the widget on login, register and forgot, requires the token and passes it to Supabase Auth', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true, turnstile: true, config: { turnstileSiteKey: 'site-key-1' } });
  const document = window.document;
  document.getElementById('authBtn').click();
  await tick();
  assert.equal(state.turnstile.renders.length, 1);
  assert.equal(state.turnstile.last.sitekey, 'site-key-1');
  assert.equal(state.turnstile.renders[0].target, document.getElementById('authCaptcha'));
  assert.equal(document.getElementById('authCaptcha').hidden, false);

  // Token nélkül nem megy ki hívás.
  document.getElementById('authEmail').value = 'tanar@example.com';
  document.getElementById('authPassword').value = 'joJelszo123';
  submitAuthForm(window);
  await tick();
  assert.match(text(window, 'authError'), /biztonsági ellenőrzést/);
  assert.equal(state.logins.length, 0);

  // Belépés a tokennel; a token egyszer használatos, ezért a widget újraindul.
  state.turnstile.last.callback('token-login');
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.logins)), [{ email: 'tanar@example.com', password: 'joJelszo123', options: { captchaToken: 'token-login' } }]);
  assert.deepEqual(state.turnstile.resets, ['widget-1']);

  // A használt token nem küldhető újra.
  document.getElementById('authBtn').click();
  submitAuthForm(window);
  await tick();
  assert.equal(state.logins.length, 1);

  // Regisztráció.
  document.querySelector('[data-auth-tab="register"]').click();
  await tick();
  assert.equal(document.getElementById('authCaptcha').hidden, false);
  state.turnstile.last.callback('token-register');
  document.getElementById('authName').value = 'Anna';
  document.getElementById('authEmail').value = 'anna@example.com';
  document.getElementById('authPassword').value = 'hosszabbJelszo1';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.signUps[0].options)), { emailRedirectTo: 'http://localhost:8000/tervezo.html', data: { full_name: 'Anna', newsletter_subscribed: false }, captchaToken: 'token-register' });

  // Elfelejtett jelszó.
  document.querySelector('[data-auth-tab="login"]').click();
  document.getElementById('authForgot').click();
  await tick();
  assert.equal(document.getElementById('authCaptcha').hidden, false);
  state.turnstile.last.callback('token-forgot');
  document.getElementById('authEmail').value = 'tanar@example.com';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.resets)), [{ email: 'tanar@example.com', options: { redirectTo: 'http://localhost:8000/tervezo.html', captchaToken: 'token-forgot' } }]);
  assert.equal(state.turnstile.renders.length, 1, 'a widget egyszer jön létre, a fülek között újrahasznosul');

  // Jelszó-visszaállítás (új jelszó): nincs widget és nincs token.
  window.closeModals();
  state.listener('PASSWORD_RECOVERY', SESSION);
  await tick();
  assert.equal(document.getElementById('authCaptcha').hidden, true);
  document.getElementById('authPassword').value = 'ujJelszo12345';
  submitAuthForm(window);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.updates)), [{ password: 'ujJelszo12345' }]);
});

test('Turnstile: the site key loads the Cloudflare script on demand and every auth page carries the widget container', async (t) => {
  const { window } = await loadPage(t, { withSupabase: true, config: { turnstileSiteKey: 'site-key-1' } });
  assert.equal(window.document.getElementById('turnstileScript'), null, 'a script csak a modál megnyitásakor töltődik');
  window.document.getElementById('authBtn').click();
  await tick();
  const script = window.document.getElementById('turnstileScript');
  assert.equal(script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');

  for (const name of ['index.html', 'tervezo.html', 'profil.html']) {
    assert.match(readPage(name), /<div id="authCaptcha" class="auth-captcha" hidden><\/div>/, name);
  }
  const { CONTENT_SECURITY_POLICY } = require('../backend/services/siteConstants');
  assert.match(CONTENT_SECURITY_POLICY, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
});

// ---------- Számlázási adatok visszaírása a profilba fizetéskor ----------

test('starting a Barion payment writes the billing data back into the logged-in profile; guests and failed starts leave it alone', async (t) => {
  relaxLimits(t);
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-billing-'));
  const saved = {};
  const env = { BARION_POS_KEY_EV: 'pos-key', BARION_POS_KEY: undefined, BARION_TEST_MODE: 'true', BARION_PAYEE_EMAIL: 'bolt@ovitervezo.hu', FRONTEND_URL: 'https://ovitervezo.hu', BACKEND_URL: 'https://api.ovitervezo.test', INVOICE_STORE_PATH: path.join(dir, 'invoiced.json') };
  for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const realFetch = global.fetch;
  let barionFails = false;
  global.fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (/^api(\.test)?\.barion\.com$/.test(target.hostname)) {
      const body = JSON.parse(options.body);
      if (barionFails) return Response.json({ Errors: [{ ErrorCode: 'ShopIsClosed', Title: 'Shop is closed' }] }, { status: 400 });
      return Response.json({ PaymentId: '4a1b2c3d4e5f60718293a4b5c6d7e8f9', PaymentRequestId: body.PaymentRequestId, Status: 'Prepared', GatewayUrl: 'https://secure.test.barion.com/Pay?id=4a1b2c3d4e5f60718293a4b5c6d7e8f9', Errors: [] });
    }
    return realFetch(url, options);
  };
  t.after(() => {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  const client = useClient(t, fakeAccounts([], { profiles: [{ id: ALICE.id, email: ALICE.email, full_name: 'Kovács Anna', billing_name: 'Régi Óvoda', billing_zip: '1111', billing_city: 'Pest', billing_address: 'Régi utca 1.', kindergarten_name: 'Napsugár' }] }));
  planStore.savePlan('gen_bill_1', { ...makePlan(3), request: { planMode: 'standard', duration: 'Napi' } });
  const base = await listen(t);
  const NEW_BILLING = { name: 'Új Óvoda Kft.', zip: '9021', city: 'Győr', address: 'Fő utca 12/B.' };
  const start = (token, billing) => call(base, '/api/checkout-barion', { method: 'POST', token, body: { plan: 'daily', planMode: 'standard', email: 'vevo@example.com', billing, generationId: 'gen_bill_1', title: 'Őszi erdő', consent: { terms: true, digitalContent: true } } });
  const profileOf = (id) => client.tables.profiles.find((row) => row.id === id);

  // Bejelentkezve a módosított számlázási adat felülírja a profilét, a többi mező és az e-mail változatlan.
  const edited = await start('token-alice', NEW_BILLING);
  assert.equal(edited.status, 200);
  const alice = profileOf(ALICE.id);
  assert.deepEqual({ name: alice.billing_name, zip: alice.billing_zip, city: alice.billing_city, address: alice.billing_address }, { name: 'Új Óvoda Kft.', zip: '9021', city: 'Győr', address: 'Fő utca 12/B.' });
  assert.equal(alice.full_name, 'Kovács Anna');
  assert.equal(alice.kindergarten_name, 'Napsugár');
  assert.equal(alice.email, ALICE.email, 'a profil e-mail címe nem a fizetőé');

  // Első alkalommal (még nincs adat/sor) a megadott adat bekerül.
  const first = await start('token-bob', { ...NEW_BILLING, name: 'Bob Óvoda' });
  assert.equal(first.status, 200);
  assert.equal(profileOf(BOB.id).billing_name, 'Bob Óvoda');
  assert.equal(profileOf(BOB.id).email, BOB.email);

  // Vendég: semmi nem íródik, a fizetés elindul.
  const before = JSON.stringify(client.tables.profiles);
  assert.equal((await start(undefined, { ...NEW_BILLING, name: 'Vendég Kft.' })).status, 200);
  assert.equal(JSON.stringify(client.tables.profiles), before);

  // Sikertelen Barion-indítás: a profil nem módosul.
  barionFails = true;
  assert.equal((await start('token-alice', { ...NEW_BILLING, name: 'Sosem fizetett Kft.' })).status >= 400, true);
  barionFails = false;
  assert.equal(profileOf(ALICE.id).billing_name, 'Új Óvoda Kft.');

  // A profil mentésének hibája nem akasztja meg a fizetést.
  client.failures.profiles = 'profiles adatbázis hiba';
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const resilient = await start('token-alice', { ...NEW_BILLING, name: 'Másik Kft.' });
  assert.equal(resilient.status, 200);
  assert.equal((await resilient.json()).success, true);
});

// ---------- Hírlevél (GDPR) és admin jogosultsági alap ----------

const TOKEN_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const newsletterProfiles = () => [
  { id: ALICE.id, email: ALICE.email, full_name: 'Kovács Anna', is_admin: false },
  { id: BOB.id, email: BOB.email, full_name: 'Bob', is_admin: false }
];
const newsletterSubscribers = () => [
  { email: ALICE.email.toLowerCase(), user_id: ALICE.id, name: 'Kovács Anna', newsletter_token: TOKEN_ALICE, subscribed: false, subscribed_at: null, unsubscribed_at: null },
  { email: BOB.email.toLowerCase(), user_id: BOB.id, name: 'Bob', newsletter_token: TOKEN_BOB, subscribed: true, subscribed_at: '2026-01-01T00:00:00Z', unsubscribed_at: null }
];
const newsletterFixtures = () => ({ profiles: newsletterProfiles(), newsletter_subscribers: newsletterSubscribers() });

test('POST /api/newsletter/subscribe needs a login, subscribes only the caller once and shows up in the profile', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([], newsletterFixtures()));
  const base = await listen(t);
  const row = (id) => client.tables.newsletter_subscribers.find((item) => item.user_id === id);

  assert.equal((await call(base, '/api/newsletter/subscribe', { method: 'POST' })).status, 401);
  assert.equal(row(ALICE.id).subscribed, false);
  const before = (await (await call(base, '/api/profile', { token: 'token-alice' })).json()).profile;
  assert.equal(before.newsletter_subscribed, false);

  const response = await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-alice' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, newsletter_subscribed: true });
  assert.equal(row(ALICE.id).subscribed, true);
  const subscribedAt = row(ALICE.id).subscribed_at;
  assert.ok(Date.now() - new Date(subscribedAt).getTime() < 60 * 1000, 'a feliratkozás ideje be van állítva');
  assert.equal(row(ALICE.id).newsletter_token, TOKEN_ALICE, 'a token nem változik');
  assert.equal(row(BOB.id).subscribed_at, '2026-01-01T00:00:00Z', 'más felhasználó sora nem változik');
  assert.equal(client.tables.newsletter_subscribers.length, 2);

  assert.equal((await (await call(base, '/api/profile', { token: 'token-alice' })).json()).profile.newsletter_subscribed, true);
  // Ismételt feliratkozás nem írja át az eredeti időpontot.
  assert.equal((await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-alice' })).status, 200);
  assert.equal(row(ALICE.id).subscribed_at, subscribedAt);
  // Bob már fel volt iratkozva: az ő időpontja sem módosul.
  assert.equal((await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-bob' })).status, 200);
  assert.equal(row(BOB.id).subscribed_at, '2026-01-01T00:00:00Z');
});

test('subscribing creates the missing profile row first and a database failure is a generic 500', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts());
  const base = await listen(t);
  assert.equal((await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-alice' })).status, 200);
  const created = client.tables.profiles.filter((item) => item.id === ALICE.id);
  assert.equal(created.length, 1);
  const subscription = client.tables.newsletter_subscribers.filter((item) => item.email === ALICE.email.toLowerCase());
  assert.equal(subscription.length, 1);
  assert.equal(subscription[0].subscribed, true);
  assert.equal(subscription[0].user_id, ALICE.id);

  client.failures.newsletter_subscribers = 'relation secret detail';
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const failed = await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-bob' });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /secret detail/);
});

test('the profile API can never change is_admin or the newsletter fields and never returns the token or the admin flag', async (t) => {
  relaxLimits(t);
  const rows = newsletterProfiles();
  rows[0].is_admin = true;
  const client = useClient(t, fakeAccounts([], { profiles: rows, newsletter_subscribers: newsletterSubscribers() }));
  const base = await listen(t);
  const save = (body, token = 'token-alice') => call(base, '/api/profile', { method: 'POST', token, body });
  const alice = () => client.tables.profiles.find((item) => item.id === ALICE.id);
  const bob = () => client.tables.profiles.find((item) => item.id === BOB.id);
  const aliceNews = () => client.tables.newsletter_subscribers.find((item) => item.user_id === ALICE.id);
  const bobNews = () => client.tables.newsletter_subscribers.find((item) => item.user_id === BOB.id);

  const read = await (await call(base, '/api/profile', { token: 'token-alice' })).json();
  assert.equal('is_admin' in read.profile, false);
  assert.equal('newsletter_token' in read.profile, false);
  assert.equal(JSON.stringify(read).includes(TOKEN_ALICE), false);

  // Egy támadó minden védett mezőt megpróbál átírni, a megengedett mező mellett.
  const hostile = { full_name: 'Új Név', is_admin: true, newsletter_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', newsletter_subscribed: true, newsletter_subscribed_at: '2030-01-01T00:00:00Z', id: BOB.id };
  const response = await save({ ...hostile });
  assert.equal(response.status, 200);
  assert.equal(alice().full_name, 'Új Név');
  assert.equal(aliceNews().newsletter_token, TOKEN_ALICE);
  assert.equal(aliceNews().subscribed, false);
  assert.equal(aliceNews().subscribed_at, null);
  assert.equal('newsletter_token' in alice() || 'newsletter_subscribed' in alice(), false, 'a profil táblába nem íródik hírlevél-adat');
  assert.equal(alice().is_admin, true, 'a meglévő is_admin érték változatlan marad, a kérésből nem íródik');
  const bobSaved = await save({ is_admin: true, newsletter_token: TOKEN_ALICE, full_name: 'Bob 2' }, 'token-bob');
  assert.equal(bobSaved.status, 200);
  assert.equal(bob().is_admin, false, 'a nem admin felhasználó nem tehet magát adminná');
  assert.equal(bobNews().newsletter_token, TOKEN_BOB);

  // Csak védett mezőt tartalmazó kérés nem menthető, és a felirat nem is kapcsolható ki ezen az úton.
  for (const body of [{ is_admin: true }, { newsletter_token: TOKEN_BOB }, { newsletter_subscribed: false }]) {
    const rejected = await save(body, 'token-bob');
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
  assert.equal(bobNews().subscribed, true, 'a profil-végpont nem tud leiratkoztatni');
  assert.equal(bob().is_admin, false);
});

test('the newsletter migration keeps is_admin and the newsletter fields out of client reach', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const sql = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((name) => name.includes('newsletter_admin'))), 'utf8');
  assert.match(sql, /add column if not exists is_admin boolean not null default false/);
  assert.match(sql, /add column if not exists newsletter_subscribed boolean not null default false/);
  assert.match(sql, /add column if not exists newsletter_subscribed_at timestamptz/);
  assert.match(sql, /add column if not exists newsletter_token uuid not null default gen_random_uuid\(\)/);
  assert.match(sql, /unique \(newsletter_token\)/);
  assert.match(sql, /create table if not exists public\.newsletter_campaigns/);
  assert.match(sql, /alter table public\.newsletter_campaigns enable row level security/);
  assert.match(sql, /revoke all on public\.newsletter_campaigns from anon, authenticated/);
  assert.doesNotMatch(sql, /create policy[^;]*newsletter_campaigns/i, 'a kampánynaplóhoz nincs kliensoldali RLS-szabály');
  // A regisztrációs trigger átveszi a hozzájárulást, de csak a pontos "true" értéket.
  assert.match(sql, /raw_user_meta_data ->> 'newsletter_subscribed'/);
  assert.match(sql, /case when subscribed then now\(\) end/);
  assert.match(sql, /revoke execute on function public\.handle_new_user\(\) from public, anon, authenticated/);

  // Egyetlen migráció sem ad UPDATE jogot a védett oszlopokra, és a token nem olvasható a böngészőből.
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const grant of text.match(/grant\s+(?:update|all)[^;]*;/gi) || []) {
      assert.match(grant, /^grant update \(/i, `${name}: csak oszlopszintű UPDATE jog engedett: ${grant}`);
      assert.doesNotMatch(grant, /is_admin|newsletter_/i, `${name}: ${grant}`);
    }
  }
  const selectGrant = sql.match(/grant select \(([^)]*)\)\s+on public\.profiles to authenticated/)[1];
  assert.doesNotMatch(selectGrant, /newsletter_token/);
  assert.match(sql, /revoke select on public\.profiles from authenticated/);
});

test('POST /api/newsletter/unsubscribe is public, token based, idempotent and friendly 404 for unknown tokens', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([], newsletterFixtures()));
  const base = await listen(t);
  const unsubscribe = (body) => call(base, '/api/newsletter/unsubscribe', { method: 'POST', body });
  const row = (id) => client.tables.newsletter_subscribers.find((item) => item.user_id === id);

  const response = await unsubscribe({ token: TOKEN_BOB });
  assert.equal(response.status, 200, 'bejelentkezés nélkül is működik');
  const body = await response.json();
  assert.deepEqual(body, { success: true });
  assert.equal(row(BOB.id).subscribed, false);
  assert.ok(row(BOB.id).unsubscribed_at, 'a leiratkozás ideje rögzül');
  assert.equal(row(ALICE.id).subscribed, false);
  assert.equal(row(BOB.id).newsletter_token, TOKEN_BOB, 'a token marad, így az újabb levélben is él');
  assert.equal(JSON.stringify(body).includes(BOB.email), false, 'a válasz nem árul el e-mail címet');

  // Ismételt vagy nagybetűs token is barátságosan lefut.
  assert.equal((await unsubscribe({ token: TOKEN_BOB })).status, 200);
  await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-bob' });
  assert.equal(row(BOB.id).subscribed, true);
  assert.equal(row(BOB.id).unsubscribed_at, null);
  assert.equal((await unsubscribe({ token: TOKEN_BOB.toUpperCase() })).status, 200);
  assert.equal(row(BOB.id).subscribed, false);

  // Érvénytelen, ismeretlen vagy hiányzó token: 404 barátságos üzenettel, semmi nem változik.
  await call(base, '/api/newsletter/subscribe', { method: 'POST', token: 'token-bob' });
  for (const payload of [{ token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, { token: 'nem-uuid' }, { token: '' }, { token: 42 }, { token: { $ne: null } }, {}, undefined]) {
    const missing = await unsubscribe(payload);
    assert.equal(missing.status, 404, JSON.stringify(payload));
    const data = await missing.json();
    assert.equal(data.success, false);
    assert.match(data.error, /érvénytelen vagy lejárt/);
  }
  assert.equal(row(BOB.id).subscribed, true);
});

test('unsubscribing without Supabase is 503 and a database failure is a generic 500', async (t) => {
  relaxLimits(t);
  const base = await listen(t);
  assert.equal((await call(base, '/api/newsletter/unsubscribe', { method: 'POST', body: { token: TOKEN_ALICE } })).status, 503);

  const client = useClient(t, fakeAccounts([], newsletterFixtures()));
  client.failures.newsletter_subscribers = 'relation secret detail';
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const failed = await call(base, '/api/newsletter/unsubscribe', { method: 'POST', body: { token: TOKEN_ALICE } });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /secret detail/);
});

test('the unsubscribe call is allowed from the production frontend origin and the page is shipped', async (t) => {
  relaxLimits(t);
  useClient(t, fakeAccounts([], newsletterFixtures()));
  const base = await listen(t);
  const preflight = await fetch(`${base}/api/newsletter/unsubscribe`, { method: 'OPTIONS', headers: { Origin: 'https://ovitervezo.hu', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://ovitervezo.hu');
  const { PAGES, SITE_ASSETS } = require('../backend/services/siteConstants');
  assert.ok(PAGES.includes('leiratkozas.html') && SITE_ASSETS.includes('js/leiratkozas.js'));
  const page = await fetch(`${base}/leiratkozas.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Leiratkozás a hírlevélről/);
  assert.equal((await fetch(`${base}/js/leiratkozas.js`)).status, 200);
});

test('the registration tab offers an unchecked newsletter checkbox and passes the choice to signUp', async (t) => {
  for (const name of ['index.html', 'tervezo.html', 'profil.html']) {
    const html = readPage(name);
    const box = html.match(/<input id="authNewsletter"[^>]*>/)[0];
    assert.doesNotMatch(box, /checked/, `${name}: alapból nincs bepipálva`);
    assert.ok(html.includes('Szeretnék értesítést kapni az OviTervező újdonságairól, pedagógiai tippekről és kedvezményekről.'), name);
  }
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;
  const box = document.getElementById('authNewsletter');
  document.getElementById('authBtn').click();
  assert.equal(visible(window, 'authNewsletterField'), false, 'belépésnél nem látszik');
  document.querySelector('[data-auth-tab="register"]').click();
  assert.equal(visible(window, 'authNewsletterField'), true);
  assert.equal(box.checked, false);
  document.getElementById('authEmail').value = 'anna@example.com';
  document.getElementById('authPassword').value = 'hosszabbJelszo1';
  submitAuthForm(window);
  await tick();
  assert.equal(state.signUps[0].options.data.newsletter_subscribed, false);

  box.click();
  assert.equal(box.checked, true);
  document.getElementById('authPassword').value = 'hosszabbJelszo1';
  submitAuthForm(window);
  await tick();
  assert.equal(state.signUps[1].options.data.newsletter_subscribed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.signUps[1].options.data)), { newsletter_subscribed: true });
  assert.equal(box.checked, false, 'a következő regisztrációnál újra bepipálatlan');

  document.querySelector('[data-auth-tab="login"]').click();
  assert.equal(visible(window, 'authNewsletterField'), false);
  document.getElementById('authPassword').value = 'joJelszo123';
  submitAuthForm(window);
  await tick();
  assert.equal(state.signUps.length, 2, 'belépés nem regisztrál');
  assert.deepEqual(JSON.parse(JSON.stringify(state.logins[0])), { email: 'anna@example.com', password: 'joJelszo123' });
});

test('profil.html offers only a subscribe button while unsubscribed and calls the protected endpoint', async (t) => {
  const { window, state } = await loadProfil(t, { routes: profilRoutes({ '/api/newsletter/subscribe': () => [{ success: true, newsletter_subscribed: true }] }) });
  const document = window.document;
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(visible(window, 'newsletterBlock'), true);
  assert.match(document.querySelector('#newsletterBlock h3').textContent, /Hírlevél értesítések/);
  assert.equal(visible(window, 'newsletterOff'), true);
  assert.equal(visible(window, 'newsletterOn'), false);
  const button = document.getElementById('newsletterSubscribe');
  assert.equal(button.textContent.trim(), 'Feliratkozom a hírlevélre');

  button.click();
  await tick();
  const request = state.fetches.find((item) => item.path === '/api/newsletter/subscribe');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer jwt-alice');
  assert.equal(visible(window, 'newsletterOff'), false);
  assert.equal(visible(window, 'newsletterOn'), true);
  assert.match(text(window, 'newsletterOn'), /✓ Feliratkozva az OviTervező hírlevelére/);
});

test('profil.html shows a calm subscribed status without any unsubscribe control', async (t) => {
  const subscribed = profilRoutes();
  const baseProfile = subscribed['/api/profile'];
  const routes = profilRoutes({ '/api/profile': (method, body) => { const [data] = baseProfile(method, body); return [{ ...data, profile: { ...data.profile, newsletter_subscribed: true } }]; } });
  const { window, state } = await loadProfil(t, { routes });
  const document = window.document;
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(visible(window, 'newsletterBlock'), true);
  assert.equal(visible(window, 'newsletterOff'), false);
  assert.equal(visible(window, 'newsletterOn'), true);
  assert.match(text(window, 'newsletterOn'), /✓ Feliratkozva az OviTervező hírlevelére/);

  // Mentés után (a szerver a teljes profilt adja vissza) az állapot megmarad, és a blokkban nincs vezérlő a leiratkozáshoz.
  document.getElementById('profileForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(visible(window, 'newsletterOn'), true);
  const block = document.getElementById('newsletterBlock');
  assert.deepEqual(Array.from(block.querySelectorAll('button, input, select, a')).filter((el) => !el.closest('[hidden]')), [], 'nincs gomb, kapcsoló vagy link a látható állapotban');
  assert.equal(state.fetches.some((item) => item.path.includes('unsubscribe')), false);
  assert.equal(window.document.documentElement.outerHTML.includes('/api/newsletter/unsubscribe'), false, 'a profil oldal nem hívhatja a leiratkozó végpontot');
});

test('profil.html keeps the subscribe button and shows the error when subscribing fails', async (t) => {
  const { window, state } = await loadProfil(t, { routes: profilRoutes({ '/api/newsletter/subscribe': () => [{ success: false, error: 'A feliratkozás sikertelen. Kérjük, próbáld újra később.' }, 500] }) });
  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  window.document.getElementById('newsletterSubscribe').click();
  await tick();
  assert.equal(visible(window, 'newsletterOff'), true);
  assert.equal(visible(window, 'newsletterOn'), false);
  assert.match(text(window, 'newsletterError'), /A feliratkozás sikertelen/);
  assert.equal(window.document.getElementById('newsletterSubscribe').disabled, false);
});

// ---------- leiratkozas.html (jsdom) ----------

const leiratkozasHtml = readPage('leiratkozas.html');
const loadLeiratkozas = (t, search, routes) => loadPage(t, { withSupabase: false, page: leiratkozasHtml, pageName: 'leiratkozas.html', search, local: false, routes });
const shown = (window) => ['unsubLoading', 'unsubSuccess', 'unsubInvalid', 'unsubError'].filter((id) => visible(window, id));

test('leiratkozas.html unsubscribes automatically with the token from the URL and confirms it', async (t) => {
  const { window, state } = await loadLeiratkozas(t, `?token=${TOKEN_BOB}`, { '/api/newsletter/unsubscribe': () => [{ success: true }] });
  await tick();
  assert.deepEqual(state.fetches.map((item) => [item.method, item.path, JSON.parse(item.body)]), [['POST', '/api/newsletter/unsubscribe', { token: TOKEN_BOB }]]);
  assert.deepEqual(shown(window), ['unsubSuccess']);
  assert.equal(text(window, 'unsubSuccess').replace(/\s+/g, ' ').includes('Sikeresen leiratkoztál az OviTervező hírleveléről. Ha a jövőben mégis szeretnél híreket kapni, a profilodban bármikor újra feliratkozhatsz.'), true);
  assert.equal(state.fetches[0].headers.Authorization, undefined, 'bejelentkezés nélkül megy');
});

test('leiratkozas.html shows a friendly message for an unknown token or a missing one without calling the API', async (t) => {
  const unknown = await loadLeiratkozas(t, '?token=cccccccc-cccc-4ccc-8ccc-cccccccccccc', { '/api/newsletter/unsubscribe': () => [{ success: false, error: 'A leiratkozási link érvénytelen vagy lejárt.' }, 404] });
  await tick();
  assert.deepEqual(shown(unknown.window), ['unsubInvalid']);
  assert.match(text(unknown.window, 'unsubInvalid'), /érvénytelen/);

  const missing = await loadLeiratkozas(t, '', {});
  await tick();
  assert.deepEqual(missing.state.fetches, []);
  assert.deepEqual(shown(missing.window), ['unsubInvalid']);
});

test('leiratkozas.html reports a server error and can retry', async (t) => {
  let calls = 0;
  const { window, state } = await loadLeiratkozas(t, `?token=${TOKEN_ALICE}`, { '/api/newsletter/unsubscribe': () => (++calls === 1 ? [{ success: false, error: 'Szerverhiba' }, 500] : [{ success: true }]) });
  await tick();
  assert.deepEqual(shown(window), ['unsubError']);
  assert.match(text(window, 'unsubErrorText'), /Szerverhiba/);
  window.document.getElementById('unsubRetry').click();
  await tick();
  assert.deepEqual(shown(window), ['unsubSuccess']);
  assert.equal(state.fetches.length, 2);
});

test('leiratkozas.html is a noindex page in the brand design without inline scripts', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'leiratkozas.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css"/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="favicon\.svg"/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'nincs inline script');
  assert.doesNotMatch(html, /#(?:e67e22|f39c12|ff9800|d35400)/i, 'nincs narancs szín');
});

const GUEST_TOKEN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

test('guest newsletter signup is an upsert that reactivates unsubscribed guests and rejects bad e-mails', async (t) => {
  const client = useClient(t, fakeAccounts([], { newsletter_subscribers: [{ email: 'vendeg@example.com', user_id: null, name: 'Régi', newsletter_token: GUEST_TOKEN, subscribed: false, unsubscribed_at: '2026-01-01T00:00:00Z' }] }));
  const profileService = require('../backend/services/profileService');
  await profileService.subscribeGuest({ email: 'Vendeg@Example.com', name: 'Új Név' });
  await profileService.subscribeGuest({ email: 'masik@example.com', name: '' });
  const [first, second] = client.tables.newsletter_subscribers;
  assert.equal(first.subscribed, true);
  assert.equal(first.unsubscribed_at, null);
  assert.equal(first.newsletter_token, GUEST_TOKEN, 'a régi leiratkozó link érvényes marad');
  assert.equal(first.name, 'Új Név');
  assert.equal(second.email, 'masik@example.com');
  assert.equal(second.subscribed, true);
  assert.equal(client.tables.newsletter_subscribers.length, 2);
  await assert.rejects(() => profileService.subscribeGuest({ email: 'nem-email', name: 'X' }));
});

test('token unsubscribe works for guest rows without a profile and leaves other subscribers untouched', async (t) => {
  relaxLimits(t);
  const client = useClient(t, fakeAccounts([], { ...newsletterFixtures(), newsletter_subscribers: [...newsletterSubscribers(), { email: 'vendeg@example.com', user_id: null, newsletter_token: GUEST_TOKEN, subscribed: true }] }));
  const base = await listen(t);
  const response = await call(base, '/api/newsletter/unsubscribe', { method: 'POST', body: { token: GUEST_TOKEN } });
  assert.equal(response.status, 200);
  const rows = client.tables.newsletter_subscribers;
  assert.equal(rows.find((row) => row.email === 'vendeg@example.com').subscribed, false);
  assert.equal(rows.find((row) => row.user_id === BOB.id).subscribed, true, 'a többi feliratkozó érintetlen');
});

test('Turnstile: the token is sent once, reset only after the Supabase request, and a secret mismatch shows a clear message', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true, turnstile: true, config: { turnstileSiteKey: '0x4AAAAAAGFSc8Zzow6VmxQ9' } });
  const document = window.document;
  const errors = [];
  window.console.error = (...args) => errors.push(args.join(' '));
  document.getElementById('authBtn').click();
  await tick();
  document.getElementById('authEmail').value = 'tanar@example.com';
  document.getElementById('authPassword').value = 'secretmismatch';
  state.turnstile.last.callback('token-once');
  submitAuthForm(window);
  submitAuthForm(window); // dupla beküldés (pl. Enter + kattintás) nem mehet ki kétszer
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.logins.length, 1, 'ugyanaz a token nem megy ki kétszer');
  assert.deepEqual(JSON.parse(JSON.stringify(state.logins[0].options)), { captchaToken: 'token-once' });
  assert.deepEqual(state.order, ['signIn', 'signIn-done', 'reset'], 'a reset a Supabase-válasz után fut, nem előtte');
  const message = text(window, 'authError');
  assert.match(message, /szerveroldali titkos kulcsa nem egyezik a kliens site kulccsal/);
  assert.match(message, /0x4AAAAAAGFS…/);
  assert.ok(errors.some((line) => line.includes('0x4AAAAAAGFS…') && !line.includes('0x4AAAAAAGFSc8')));
  // Reset után új token kell a következő próbálkozáshoz.
  submitAuthForm(window);
  await tick();
  assert.equal(state.logins.length, 1);
  assert.match(text(window, 'authError'), /biztonsági ellenőrzést/);
});
