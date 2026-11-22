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
function fakeAccounts(documents = []) {
  const tables = { documents };
  const failures = {};
  const calls = { getUser: [] };
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
      }
    },
    from(name) {
      const filters = [];
      let patch = null;
      let order = null;
      let max = Infinity;
      const run = () => {
        if (failures[name]) return { data: null, error: { message: failures[name] } };
        let rows = tables[name].filter((row) => filters.every((matches) => matches(row)));
        if (patch) rows.forEach((row) => Object.assign(row, patch));
        if (order) rows = [...rows].sort((a, b) => (order.ascending ? 1 : -1) * String(read(a, order.column)).localeCompare(String(read(b, order.column))));
        return { data: rows.slice(0, max).map((row) => ({ ...row, request: row.data?.plan?.request })), error: null };
      };
      const builder = {
        select() { return builder; },
        update(values) { patch = values; return builder; },
        eq(column, value) { filters.push((row) => read(row, column) === value); return builder; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return builder; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
        order(column, options) { order = { column, ascending: options?.ascending !== false }; return builder; },
        limit(count) { max = count; return builder; },
        maybeSingle() {
          const { data, error } = run();
          return Promise.resolve({ data: data?.[0] || null, error });
        },
        upsert(row) {
          const existing = tables[name].find((item) => item.document_id === row.document_id);
          if (existing) Object.assign(existing, row);
          else tables[name].push({ created_at: new Date().toISOString(), ...row });
          return Promise.resolve({ error: null });
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

  for (const [route, options] of [['/api/my-documents', {}], ['/api/my-documents/gen_a', {}], ['/api/sync-documents', { method: 'POST', body: { documentIds: [] } }]]) {
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

test('the account client files are shipped and the CSP allows the Supabase host', () => {
  const { SITE_ASSETS, CONTENT_SECURITY_POLICY, SUPABASE_PUBLIC_URL } = require('../services/siteConstants');
  assert.ok(SITE_ASSETS.includes('auth.js') && SITE_ASSETS.includes('tervezo-history.js'));
  assert.match(CONTENT_SECURITY_POLICY, new RegExp(`connect-src[^;]*${SUPABASE_PUBLIC_URL.replace(/\./g, '\\.')}`));
});

// ---------- Böngészős rész (jsdom) ----------

const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');

const pageHtml = readPage('tervezo.html');
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

async function loadPage(t, { withSupabase }) {
  const state = { listener: null, otp: [], fetches: [], signOuts: 0 };
  const dom = new JSDOM(pageHtml, {
    url: 'http://localhost:8000/tervezo.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
      window.APP_CONFIG = { apiBaseUrl: 'same-origin', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
      window.localStorage.setItem('oviKretaUnlocked', JSON.stringify(['gen_local1', 'nem-gen']));
      window.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        state.fetches.push({ path, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
        const json = (data) => ({ ok: true, status: 200, json: async () => data });
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
              async signInWithOtp(args) { state.otp.push(args); return { error: null }; },
              async signOut() { state.signOuts += 1; state.listener('SIGNED_OUT', null); return { error: null }; }
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

test('the magic-link modal sends the e-mail with the tervezo.html redirect and confirms it', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;
  assert.equal(document.getElementById('authBtn').hidden, false);
  assert.equal(document.getElementById('authBtn').textContent, 'Belépés / Mentett terveim');
  document.getElementById('authBtn').click();
  assert.ok(document.getElementById('authModal').classList.contains('open'));

  document.getElementById('authEmail').value = 'nem-email';
  document.getElementById('authForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(state.otp.length, 0);
  assert.ok(document.getElementById('authError').textContent.length > 0);

  document.getElementById('authEmail').value = 'tanar@example.com';
  document.getElementById('authForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(state.otp)), [{ email: 'tanar@example.com', options: { emailRedirectTo: 'http://localhost:8000/tervezo.html' } }]);
  assert.equal(document.getElementById('authStatus').textContent, 'Elküldtük a belépési linket az e-mail címedre!');
  assert.equal(document.getElementById('authError').hidden, true);
});

test('logging in syncs local plan ids, lists cloud plans, opens them and logging out clears them', async (t) => {
  const { window, state } = await loadPage(t, { withSupabase: true });
  const document = window.document;

  state.listener('INITIAL_SESSION', SESSION);
  await tick();
  assert.equal(document.getElementById('authBtn').textContent, ALICE.email);
  assert.equal(document.getElementById('authLoggedIn').hidden, false);

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

  document.getElementById('authLogout').click();
  await tick();
  assert.equal(state.signOuts, 1);
  assert.equal(document.getElementById('authBtn').textContent, 'Belépés / Mentett terveim');
  assert.equal(document.getElementById('cloudPlansField').hidden, true);
  assert.equal(document.getElementById('cloudPlansPanel').children.length, 0);
});
