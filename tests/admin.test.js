const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const server = require('../backend/server');
const supabase = require('../backend/services/supabaseService');
const mailService = require('../backend/services/mailService');
const newsletter = require('../backend/services/newsletterService');
const { readPage, makePlan, makePayload } = require('./fixtures');
const planStore = require('../backend/services/planStore');

const user = (n, email, extra = {}) => ({ id: `${n}`.repeat(8) + '-1111-4111-8111-' + `${n}`.repeat(12), email, email_confirmed_at: '2026-01-01T00:00:00Z', created_at: `2026-01-0${n}T10:00:00Z`, ...extra });
const ADMIN = user(1, 'Admin@Example.com');
const ALICE = user(2, 'alice@example.com');
const BOB = user(3, 'bob@example.com');
const NEWBIE = user(4, 'new@example.com', { email_confirmed_at: null });
const CAROL = user(5, 'carol@example.com');
const IMPOSTOR = user(6, 'admin@example.com');
const TOKENS = { 'token-admin': ADMIN, 'token-alice': ALICE, 'token-bob': BOB, 'token-new': NEWBIE, 'token-carol': CAROL, 'token-impostor': IMPOSTOR };

const TOKEN_OF = { [ADMIN.id]: 'a0000000-0000-4000-8000-000000000001', [ALICE.id]: 'a0000000-0000-4000-8000-000000000002', [BOB.id]: 'a0000000-0000-4000-8000-000000000003', [NEWBIE.id]: 'a0000000-0000-4000-8000-000000000004', [CAROL.id]: 'a0000000-0000-4000-8000-000000000005' };

const profile = (u, extra = {}) => ({ id: u.id, email: u.email.toLowerCase(), full_name: '', billing_name: '', is_admin: false, ...extra });
// Hírlevél-sor (egyetlen forrás: newsletter_subscribers, kulcs a kisbetűs e-mail); a token a felhasználóhoz tartozó rögzített UUID.
const sub = (u, subscribed, extra = {}) => ({ email: u.email.toLowerCase(), user_id: u.id, name: '', newsletter_token: TOKEN_OF[u.id], subscribed, subscribed_at: subscribed ? '2026-01-01T00:00:00Z' : null, unsubscribed_at: null, ...extra });

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// Mockolt Supabase kliens az admin végpontokhoz: auth.getUser, auth.admin.listUsers és a használt lekérdezés-láncok.
// A migráció valós sablonjai (base_layout stb.), hogy a hírlevél tesztek az éles keretet használják.
function seedTemplateRows() {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'supabase', 'migrations', '20261126090000_system_settings.sql'), 'utf8');
  return [...sql.matchAll(/\('(\w+)', '([^']*)', \$tpl\$([\s\S]*?)\$tpl\$\)/g)].map((m) => ({ id: m[1], subject: m[2], body_html: m[3] }));
}

function fakeAdmin(tables = {}, authUsers = [ADMIN, ALICE, BOB, NEWBIE, CAROL]) {
  const db = { profiles: [], orders: [], documents: [], coupons: [], coupon_redemptions: [], newsletter_campaigns: [], newsletter_subscribers: [], email_templates: seedTemplateRows(), system_settings: [], system_settings_history: [], ...tables };
  const failures = {};
  const calls = { listUsers: 0 };
  return {
    db,
    failures,
    calls,
    auth: {
      async getUser(token) {
        const found = TOKENS[token];
        return found ? { data: { user: found }, error: null } : { data: { user: null }, error: { name: 'AuthApiError', status: 401, message: 'invalid JWT' } };
      },
      admin: {
        async listUsers({ page, perPage }) {
          calls.listUsers += 1;
          if (failures.listUsers) return { data: null, error: { message: failures.listUsers } };
          return { data: { users: authUsers.slice((page - 1) * perPage, page * perPage) }, error: null };
        }
      }
    },
    from(name) {
      const filters = [];
      let patch = null;
      let order = null;
      let window = null;
      let single = false;
      let removing = false;
      let wantCount = false;
      const run = () => {
        if (removing && failures[`delete:${name}`]) return { data: null, error: failures[`delete:${name}`] };
        if (failures[name]) return { data: null, error: { message: failures[name] } };
        let rows = db[name].filter((row) => filters.every((matches) => matches(row)));
        const total = rows.length;
        if (patch) rows.forEach((row) => Object.assign(row, patch));
        if (removing) db[name] = db[name].filter((row) => !rows.includes(row));
        if (order) rows = [...rows].sort((a, b) => (order.ascending ? 1 : -1) * String(a[order.column]).localeCompare(String(b[order.column])));
        if (window) rows = rows.slice(window.from, window.to + 1);
        const data = rows.map((row) => ({ ...row, ...(name === 'documents' ? { request: row.data?.plan?.request } : {}) }));
        return single ? { data: data[0] || null, error: null } : { data, error: null, ...(wantCount ? { count: total } : {}) };
      };
      const builder = {
        select(_columns, options) { wantCount = options?.count === 'exact'; return builder; },
        gte(column, value) { filters.push((row) => String(row[column] ?? '') >= value); return builder; },
        lte(column, value) { filters.push((row) => row[column] != null && String(row[column]) <= value); return builder; },
        ilike(column, pattern) {
          const source = String(pattern).replace(/\\(.)/g, '\u0000$1').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*').replace(/\u0000(.)/g, (_m, char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const regex = new RegExp(`^${source}$`, 'i');
          filters.push((row) => regex.test(String(row[column] ?? '')));
          return builder;
        },
        update(values) { patch = values; return builder; },
        delete() { removing = true; return builder; },
        eq(column, value) { filters.push((row) => row[column] === value); return builder; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return builder; },
        order(column, options) { order = { column, ascending: options?.ascending !== false }; return builder; },
        range(from, to) { window = { from, to }; return builder; },
        limit(count) { window = { from: 0, to: count - 1 }; return builder; },
        insert(row) {
          const insertError = failures[`insert:${name}`];
          if (!insertError) {
            const stored = { ...(name === 'newsletter_campaigns' ? { id: `camp-${db[name].length + 1}`, created_at: new Date().toISOString() } : {}), ...(name === 'coupons' ? { created_at: new Date().toISOString() } : {}), ...row };
            db[name].push(stored);
            filters.push((candidate) => candidate === stored);
          } else {
            filters.push(() => false);
            builder.insertError = insertError;
          }
          return builder;
        },
        upsert(rows, options = {}) {
          const key = options.onConflict || 'id';
          for (const row of [].concat(rows)) {
            const existing = db[name].find((candidate) => candidate[key] === row[key]);
            if (existing) Object.assign(existing, row); else db[name].push({ ...row });
          }
          return Promise.resolve({ data: null, error: null });
        },
        single() { single = true; return builder; },
        maybeSingle() { single = true; return builder; },
        then(resolve, reject) {
          const result = builder.insertError ? { data: null, error: builder.insertError } : run();
          return Promise.resolve(result).then(resolve, reject);
        }
      };
      return builder;
    }
  };
}

const pagedOrders = (orders, extra = {}) => ({ success: true, truncated: false, failedCount: 0, failed: [], orders, total: orders.length, page: 1, pageSize: 20, totalPages: 1, ...extra });

function useAdminEnv(t, client, { adminEmail = 'ADMIN@example.com' } = {}) {
  const keys = ['ADMIN_EMAIL', 'ADMIN_RATE_LIMIT', 'ADMIN_SEND_RATE_LIMIT', 'ACCOUNT_RATE_LIMIT'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  if (adminEmail === null) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = adminEmail;
  process.env.ADMIN_RATE_LIMIT = '100000';
  process.env.ADMIN_SEND_RATE_LIMIT = '100000';
  supabase.setClient(client);
  t.after(() => {
    supabase.setClient(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return client;
}

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function call(base, route, { token, method = 'GET', body, headers = {} } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
}

// Admin felhasználó + profil: mindkét feltétel teljesül.
const adminProfiles = () => [profile(ADMIN, { is_admin: true }), profile(IMPOSTOR, { is_admin: false }), profile(ALICE, { is_admin: true })];

// ---------- Jogosultság ----------

test('admin routes answer 401 without a valid session, before any data is read', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  for (const route of ['/api/admin/me', '/api/admin/stats', '/api/admin/coupons', '/api/admin/orders', '/api/admin/users', '/api/admin/newsletter/campaigns']) {
    assert.equal((await call(base, route)).status, 401, `${route} token nélkül`);
    assert.equal((await call(base, route, { token: 'nem-letezo' })).status, 401, `${route} érvénytelen tokennel`);
  }
  assert.equal((await call(base, '/api/admin/me', { token: 'token-new' })).status, 401, 'a megerősítetlen e-mail nem fogadható el');
  assert.equal(client.calls.listUsers, 0);
});

test('requireAdmin needs ADMIN_EMAIL AND profiles.is_admin: every other combination is a 403', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  const routes = [['GET', '/api/admin/me'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/coupons'], ['POST', '/api/admin/coupons'], ['PATCH', '/api/admin/coupons/TEST100'], ['GET', '/api/admin/orders'], ['GET', '/api/admin/users'], ['POST', '/api/admin/newsletter/send'], ['POST', '/api/admin/newsletter/preview'], ['GET', '/api/admin/newsletter/campaigns']];
  const expect403 = async (token, label) => {
    for (const [method, route] of routes) {
      const response = await call(base, route, { token, method, body: method === 'GET' ? undefined : { is_active: true } });
      assert.equal(response.status, 403, `${label}: ${method} ${route}`);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'ADMIN_FORBIDDEN');
    }
  };

  // Rendes felhasználó: is_admin ugyan true, de az e-mail nem az ADMIN_EMAIL.
  await expect403('token-alice', 'is_admin true, de más e-mail');
  // Az e-mail egyezik, de a profilban az is_admin hamis.
  await expect403('token-impostor', 'egyező e-mail, is_admin false');
  // Profilsor nélkül sincs jog.
  client.db.profiles = client.db.profiles.filter((row) => row.id !== IMPOSTOR.id);
  await expect403('token-impostor', 'nincs profilsor');
  // A nem logikai igaz érték sem elég.
  client.db.profiles.find((row) => row.id === ADMIN.id).is_admin = 'true';
  await expect403('token-admin', 'is_admin szövegként');
  client.db.profiles.find((row) => row.id === ADMIN.id).is_admin = true;
  // Nincs beállított ADMIN_EMAIL: még a jó profil sem elég.
  delete process.env.ADMIN_EMAIL;
  await expect403('token-admin', 'üres ADMIN_EMAIL');
  process.env.ADMIN_EMAIL = '   ';
  await expect403('token-admin', 'szóközös ADMIN_EMAIL');
});

test('GET /api/admin/me returns isAdmin only when both checks pass (case-insensitive e-mail match)', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }), { adminEmail: 'ADMIN@EXAMPLE.COM' });
  const base = await listen(t);
  const response = await call(base, '/api/admin/me', { token: 'token-admin' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { success: true, isAdmin: true });
});

test('a failing profile lookup is a 503, never an open door and never a leaked database message', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  client.failures.profiles = 'connection refused: secret-db-host';
  const base = await listen(t);
  const response = await call(base, '/api/admin/me', { token: 'token-admin' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret-db-host/);
});

test('the admin limiter works before authentication and the CORS policy allows PATCH', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  const preflight = await call(base, '/api/admin/coupons/TEST100', { method: 'OPTIONS', headers: { Origin: 'https://ovitervezo.hu', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /PATCH/);
  process.env.ADMIN_RATE_LIMIT = '1';
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await call(base, '/api/admin/me')).status);
  assert.equal(statuses.at(-1), 429);
});

// ---------- Statisztika ----------

function statsTables() {
  const doc = (id, mode, duration, unlocked) => ({ document_id: id, plan_mode: mode, unlocked, data: { plan: { request: { duration } } } });
  return {
    profiles: [
      ...adminProfiles(),
      profile(BOB),
      profile(NEWBIE),
      profile(CAROL)
    ],
    newsletter_subscribers: [sub(ALICE, true), sub(BOB, false), sub(NEWBIE, true), sub(CAROL, true)],
    orders: [
      { order_number: 'O1', amount: 390, status: 'paid', created_at: ago(5) },
      { order_number: 'O2', amount: 890, status: 'paid', created_at: ago(40) },
      { order_number: 'O3', amount: 390, status: 'pending', created_at: ago(1) },
      { order_number: 'O4', amount: 390, status: 'failed', created_at: ago(2) }
    ],
    documents: [doc('d1', 'standard', 'Napi', true), doc('d2', 'standard', 'Heti', true), doc('d3', 'academic', 'Napi', false), doc('d4', 'standard', 'Napi', false), doc('d5', 'academic', 'Heti', true)]
  };
}

test('GET /api/admin/stats aggregates revenue, users, confirmed subscribers and the document conversion', async (t) => {
  useAdminEnv(t, fakeAdmin(statsTables()));
  const base = await listen(t);
  const response = await call(base, '/api/admin/stats', { token: 'token-admin' });
  assert.equal(response.status, 200);
  const { stats } = await response.json();
  assert.deepEqual(stats.revenue, { total: 1280, last30Days: 390 }, 'csak a fizetett rendelések számítanak');
  assert.equal(stats.paidOrders, 2);
  assert.equal(stats.registeredUsers, 5);
  assert.equal(stats.confirmedSubscribers, 2, 'Alice és Carol; a megerősítetlen e-mailű feliratkozó nem számít');
  assert.deepEqual(stats.documents, { total: 5, unlocked: 3, breakdown: { standard: 2, academic: 2, weekly: 1 }, conversionRate: 60 });
});

test('stats handle an empty database without dividing by zero and report database failures generically', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  const empty = await (await call(base, '/api/admin/stats', { token: 'token-admin' })).json();
  assert.equal(empty.stats.documents.conversionRate, 0);
  assert.equal(empty.stats.revenue.total, 0);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = originalError; });
  client.failures.documents = 'relation "documents" is missing';
  const failed = await call(base, '/api/admin/stats', { token: 'token-admin' });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /documents" is missing/);
  assert.ok(errors.some((line) => line.includes('documents')), 'a részlet a szerver naplójába kerül');
});

// ---------- Kuponok ----------

test('POST /api/admin/coupons creates an active coupon, normalizes the code and rejects invalid input', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  const post = (body) => call(base, '/api/admin/coupons', { token: 'token-admin', method: 'POST', body });

  const created = await post({ code: ' nyar-20 ', discount_percent: '20', max_uses: 50, valid_until: '2099-12-31', note: ' Nyári akció ' });
  assert.equal(created.status, 201);
  const { coupon } = await created.json();
  assert.equal(coupon.code, 'NYAR-20');
  assert.equal(coupon.discountPercent, 20);
  assert.equal(coupon.isActive, true);
  assert.equal(coupon.maxUses, 50);
  assert.equal(coupon.validUntil, '2099-12-31T23:59:59.999Z');
  const stored = client.db.coupons[0];
  assert.deepEqual({ code: stored.code, discount_percent: stored.discount_percent, max_uses: stored.max_uses, is_active: stored.is_active, note: stored.note }, { code: 'NYAR-20', discount_percent: 20, max_uses: 50, is_active: true, note: 'Nyári akció' });

  const minimal = await post({ code: 'MINI', discount_percent: 100 });
  assert.equal(minimal.status, 201);
  const row = client.db.coupons.find((item) => item.code === 'MINI');
  assert.equal(row.max_uses, null);
  assert.equal(row.valid_until, null);
  assert.equal(row.note, null);

  assert.equal((await post({ code: 'nyar-20', discount_percent: 10 })).status, 409, 'ugyanaz a kód kisbetűvel is ütközik');
  for (const bad of [
    { code: '', discount_percent: 10 }, { code: 'ROSSZ KÓD', discount_percent: 10 }, { code: 'A'.repeat(41), discount_percent: 10 },
    { code: 'X1', discount_percent: 0 }, { code: 'X1', discount_percent: 101 }, { code: 'X1', discount_percent: 12.5 }, { code: 'X1' }, { code: 'X1', discount_percent: 'abc' },
    { code: 'X1', discount_percent: 10, max_uses: 0 }, { code: 'X1', discount_percent: 10, max_uses: 1.5 },
    { code: 'X1', discount_percent: 10, valid_until: 'holnap' }, { code: 'X1', discount_percent: 10, valid_until: '2020-01-01' },
    { code: 'X1', discount_percent: 10, note: 'n'.repeat(201) }
  ]) {
    const response = await post(bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.ok((await response.json()).error.length > 5);
  }
  assert.equal(client.db.coupons.length, 2, 'érvénytelen kérésből nem jön létre kupon');
});

test('a unique-violation race on insert is reported as a 409', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  client.failures['insert:coupons'] = { code: '23505', message: 'duplicate key value violates unique constraint "coupons_pkey"' };
  const base = await listen(t);
  const response = await call(base, '/api/admin/coupons', { token: 'token-admin', method: 'POST', body: { code: 'RACE', discount_percent: 5 } });
  assert.equal(response.status, 409);
});

test('PATCH /api/admin/coupons/:code switches a coupon on and off, and answers 404/400 for bad requests', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({
    profiles: adminProfiles(),
    coupons: [{ code: 'TEST100', discount_percent: 100, max_uses: null, valid_until: null, is_active: true, note: 'Belső', created_at: ago(9) }]
  }));
  const base = await listen(t);
  const patch = (code, body) => call(base, `/api/admin/coupons/${code}`, { token: 'token-admin', method: 'PATCH', body });

  const off = await patch('test100', { is_active: false });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).coupon.isActive, false);
  assert.equal(client.db.coupons[0].is_active, false);
  const on = await patch('TEST100', { is_active: true });
  assert.equal((await on.json()).coupon.isActive, true);
  assert.equal(client.db.coupons[0].is_active, true);

  assert.equal((await patch('NINCS', { is_active: false })).status, 404);
  assert.equal((await patch('rossz%20kod', { is_active: false })).status, 404);
  assert.equal((await patch('TEST100', { is_active: 'false' })).status, 400, 'csak logikai érték fogadható el');
  assert.equal((await patch('TEST100', { discount_percent: 1 })).status, 400, 'más mező nem módosítható');
  assert.equal(client.db.coupons[0].discount_percent, 100);
});

test('GET /api/admin/coupons lists coupons with uses and total discount plus the latest redemptions', async (t) => {
  const redemption = (n, code, discount, daysAgo) => ({ id: `r${n}`, coupon_code: code, user_email: `vevo${n}@example.com`, document_id: `gen_${n}`, plan_mode: 'standard', original_price: 390, discount_amount: discount, final_price: 390 - discount, used_at: ago(daysAgo) });
  useAdminEnv(t, fakeAdmin({
    profiles: adminProfiles(),
    coupons: [
      { code: 'TEST100', discount_percent: 100, max_uses: null, valid_until: null, is_active: true, note: null, created_at: ago(9) },
      { code: 'NYAR20', discount_percent: 20, max_uses: 3, valid_until: null, is_active: false, note: 'Nyár', created_at: ago(2) }
    ],
    coupon_redemptions: [redemption(1, 'TEST100', 390, 5), redemption(2, 'NYAR20', 78, 3), redemption(3, 'NYAR20', 78, 1)]
  }));
  const base = await listen(t);
  const data = await (await call(base, '/api/admin/coupons', { token: 'token-admin' })).json();
  assert.deepEqual(data.coupons.map((c) => [c.code, c.uses, c.totalDiscount, c.isActive, c.maxUses]), [['NYAR20', 2, 156, false, 3], ['TEST100', 1, 390, true, null]], 'újabb kupon elöl');
  assert.deepEqual(data.redemptions.map((r) => r.id), ['r3', 'r2', 'r1'], 'a legutóbbi beváltás elöl');
  assert.equal(data.redemptions[0].email, 'vevo3@example.com');
});

// ---------- Rendelések és felhasználók ----------

test('GET /api/admin/orders joins the buyer name, filters by status and searches several fields', async (t) => {
  const order = (n, extra) => ({ order_number: `OVI-${n}`, user_id: null, user_email: `vevo${n}@example.com`, document_id: `gen_${n}`, plan_mode: 'standard', plan_key: 'daily', amount: 390, coupon_code: null, payment_method: 'Barion', status: 'paid', invoice_number: `OVITE-2026-${n}`, created_at: ago(n), ...extra });
  useAdminEnv(t, fakeAdmin({
    profiles: [...adminProfiles().slice(0, 1), profile(ALICE, { billing_name: 'Alice Óvoda Kft.', full_name: 'Alice' }), profile(BOB, { full_name: 'Bob' })],
    orders: [order(1, { user_id: ALICE.id }), order(2, { status: 'pending', invoice_number: null }), order(3, { user_id: BOB.id, coupon_code: 'NYAR20', amount: 312 }), order(4, { status: 'failed' })]
  }));
  const base = await listen(t);
  const get = async (query = '') => (await call(base, `/api/admin/orders${query}`, { token: 'token-admin' })).json();

  const all = await get();
  assert.deepEqual(all.orders.map((o) => o.orderNumber), ['OVI-1', 'OVI-2', 'OVI-3', 'OVI-4'], 'újabb elöl');
  assert.equal(all.orders[0].name, 'Alice Óvoda Kft.', 'a számlázási név az elsődleges');
  assert.equal(all.orders[2].name, 'Bob');
  assert.equal(all.orders[1].name, '', 'vendég rendelésnél nincs név');
  assert.equal(all.orders[2].couponCode, 'NYAR20');
  assert.equal(all.orders[1].invoiceNumber, '');
  assert.deepEqual((await get('?status=pending')).orders.map((o) => o.orderNumber), ['OVI-2']);
  assert.deepEqual((await get('?q=nyar20')).orders.map((o) => o.orderNumber), ['OVI-3']);
  assert.deepEqual((await get('?q=Óvoda')).orders.map((o) => o.orderNumber), ['OVI-1']);
  assert.deepEqual((await get('?q=OVITE-2026-4')).orders.map((o) => o.orderNumber), ['OVI-4']);
  assert.deepEqual((await get('?q=vevo2@')).orders.map((o) => o.orderNumber), ['OVI-2']);
  assert.deepEqual((await get('?status=paid&q=nincs-ilyen')).orders, []);
  assert.equal((await call(base, '/api/admin/orders?status=hamis', { token: 'token-admin' })).status, 400);
});

test('guest orders show the buyer name from the stored billing data', async (t) => {
  const order = (n, extra) => ({ order_number: `OVI-${n}`, user_id: null, user_email: `vevo${n}@example.com`, document_id: `gen_${n}`, plan_mode: 'standard', plan_key: 'daily', amount: 390, coupon_code: null, payment_method: 'Barion', status: 'paid', invoice_number: `OVITE-2026-${n}`, created_at: ago(n), ...extra });
  useAdminEnv(t, fakeAdmin({
    profiles: [...adminProfiles().slice(0, 1), profile(ALICE, { billing_name: 'Alice Óvoda Kft.', full_name: 'Alice' })],
    orders: [order(1, { billing: { name: 'Vendég Vevő Bt.' } }), order(2, { user_id: ALICE.id, billing: { name: 'Mást ír a rendelés' } }), order(3)]
  }));
  const base = await listen(t);
  const { orders } = await (await call(base, '/api/admin/orders', { token: 'token-admin' })).json();
  assert.deepEqual(orders.map((o) => o.name), ['Vendég Vevő Bt.', 'Alice Óvoda Kft.', '']);
});

test('POST /api/admin/orders/:orderNumber/resend re-sends the stored package (docx + pdf) and the live invoice PDF to the stored address', async (t) => {
  const row = (extra) => ({ order_number: 'OVI-R1', session_id: 'barion_r1', user_id: null, user_email: 'vevo@example.com', document_id: 'gen_r', plan_mode: 'standard', plan_key: 'daily', amount: 390, payment_method: 'Barion', status: 'paid', invoice_number: 'OVITE-2026-9', billing_profile: 'ev', delivery_count: 1, created_at: ago(1), ...extra });
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [row(), row({ order_number: 'OVI-R2', status: 'pending' })], documents: [{ document_id: 'gen_r', unlocked: true, data: { plan: { ...makePlan(), request: makePayload(), generationId: 'gen_r' }, meta: {} } }] }));
  planStore.clearPlans();
  const saved = { SMTP_HOST: process.env.SMTP_HOST, SZAMLAZZ_API_KEY_EV: process.env.SZAMLAZZ_API_KEY_EV };
  process.env.SMTP_HOST = 'smtp.invalid.example';
  process.env.SZAMLAZZ_API_KEY_EV = 'agent-ev';
  const realFetch = global.fetch;
  const pdfRequests = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('szamlazz.hu')) { pdfRequests.push(await options.body.get('action-szamla_agent_pdf').text()); return new Response(Buffer.from('%PDF-1.4 x'), { status: 200 }); }
    return realFetch(url, options);
  };
  t.after(() => { global.fetch = realFetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const base = await listen(t);
  mailService.mockOutbox.length = 0;

  const response = await call(base, '/api/admin/orders/OVI-R1/resend', { token: 'token-admin', method: 'POST', body: { email: 'masik@example.com' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, sent: true, to: 'vevo@example.com', invoiceAttached: true, attachmentCount: 2, template: 'payment_success' });
  assert.equal(mailService.mockOutbox.length, 1);
  assert.deepEqual(mailService.mockOutbox[0].attachments, ['ovi-kreta-terv.pdf', 'ovi-kreta-terv.docx', 'OVITE-2026-9.pdf', 'ovitervezo-logo.png'], 'a tervezet a memória nélkül, a documents táblából épül újra');
  assert.doesNotMatch(mailService.mockOutbox[0].subject, /Számlája elkészült/);
  assert.equal(mailService.mockOutbox[0].to, 'vevo@example.com', 'a kliens által küldött cím nem számít');
  assert.match(pdfRequests[0], /<szamlaszam>OVITE-2026-9<\/szamlaszam>/);
  assert.equal(client.db.orders[0].delivery_count, 1, 'az admin újraküldés nem használja el a vevői kézbesítést');

  assert.equal((await call(base, '/api/admin/orders/OVI-R2/resend', { token: 'token-admin', method: 'POST' })).status, 409, 'fizetetlen rendeléshez nem megy levél');
  assert.equal((await call(base, '/api/admin/orders/OVI-NINCS/resend', { token: 'token-admin', method: 'POST' })).status, 404);
  assert.equal((await call(base, '/api/admin/orders/OVI-R1/resend', { method: 'POST' })).status, 401);
});

test('GET /api/admin/billing-status reports modes and key presence per profile without leaking secrets', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const saved = { SZAMLAZZ_API_KEY_KFT: process.env.SZAMLAZZ_API_KEY_KFT, BARION_TEST_MODE: process.env.BARION_TEST_MODE };
  process.env.SZAMLAZZ_API_KEY_KFT = 'titkos-kft-kulcs';
  process.env.BARION_TEST_MODE = 'true';
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const base = await listen(t);
  const response = await call(base, '/api/admin/billing-status', { token: 'token-admin' });
  const text = await response.text();
  const { status } = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(status.modes.barion, 'test');
  assert.equal(status.profiles.kft.szamlazzApiKey, true);
  assert.equal(text.includes('titkos-kft-kulcs'), false);
  assert.equal((await call(base, '/api/admin/billing-status')).status, 401);
});

test('GET /api/admin/users lists registrations with confirmation and subscription state and never exposes tokens', async (t) => {
  useAdminEnv(t, fakeAdmin(statsTables()));
  const base = await listen(t);
  const response = await call(base, '/api/admin/users', { token: 'token-admin' });
  const raw = await response.text();
  for (const token of Object.values(TOKEN_OF)) assert.ok(!raw.includes(token), 'a leiratkozási token nem adható ki');
  assert.doesNotMatch(raw, /is_admin|newsletter_token/);
  const data = JSON.parse(raw);
  assert.equal(data.subscriberCount, 2);
  const alice = data.users.find((u) => u.email === 'alice@example.com');
  assert.deepEqual({ confirmed: alice.confirmed, subscribed: alice.subscribed }, { confirmed: true, subscribed: true });
  const newbie = data.users.find((u) => u.email === 'new@example.com');
  assert.deepEqual({ confirmed: newbie.confirmed, subscribed: newbie.subscribed }, { confirmed: false, subscribed: true });
  assert.equal(data.users.find((u) => u.email === 'bob@example.com').subscribed, false);
});

// ---------- Hírlevél ----------

function newsletterTables() {
  return {
    profiles: [
      profile(ADMIN, { is_admin: true }),
      profile(ALICE, { full_name: 'Alice' }),
      profile(BOB),
      profile(NEWBIE),
      profile(CAROL)
    ],
    newsletter_subscribers: [sub(ADMIN, false), sub(ALICE, true), sub(BOB, false), sub(NEWBIE, true), sub(CAROL, true)]
  };
}

// A kimenő leveleket a mailService.createTransport kicserélt, rögzítő változata gyűjti.
function captureMail(t, { failFor = [], gate = null } = {}) {
  const sent = [];
  const original = mailService.createTransport;
  mailService.createTransport = () => ({
    async sendMail(message) {
      if (gate) await gate;
      if (failFor.includes(message.to)) throw new Error('554 mailbox unavailable');
      sent.push(message);
      return { accepted: [message.to] };
    }
  });
  t.after(() => { mailService.createTransport = original; });
  return sent;
}

const campaignBody = (extra = {}) => ({ subject: 'Őszi újdonságok', heading: 'Szia <Anna>!', bodyHtml: 'Első bekezdés.\n\nMásodik & harmadik sor.', ctaText: '', ctaUrl: '', recipients: 'test', ...extra });
const sendNewsletter = (base, body, token = 'token-admin') => call(base, '/api/admin/newsletter/send', { token, method: 'POST', body });

test('newsletter test mode mails only the admin with the admin personal unsubscribe link and logs the campaign', async (t) => {
  const client = useAdminEnv(t, fakeAdmin(newsletterTables()));
  const sent = captureMail(t);
  const base = await listen(t);
  const response = await sendNewsletter(base, campaignBody());
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.recipientCount, 1);
  await newsletter.whenIdle();

  assert.deepEqual(sent.map((m) => m.to), ['admin@example.com']);
  assert.equal(sent[0].subject, 'Őszi újdonságok');
  assert.ok(sent[0].html.includes(`https://ovitervezo.hu/leiratkozas.html?token=${TOKEN_OF[ADMIN.id]}`));
  assert.ok(sent[0].text.includes(`leiratkozas.html?token=${TOKEN_OF[ADMIN.id]}`));
  assert.equal(sent[0].headers['List-Unsubscribe'], `<https://ovitervezo.hu/leiratkozas.html?token=${TOKEN_OF[ADMIN.id]}>`);
  assert.ok(sent[0].html.includes('Szia &lt;Anna&gt;!'), 'a főcím escape-elt');
  assert.ok(sent[0].html.includes('Második &amp; harmadik sor.'), 'sima szöveg: escape-elt bekezdések');
  assert.ok(sent[0].html.includes('cid:ovitervezo-logo'));
  assert.equal(sent[0].attachments[0].cid, 'ovitervezo-logo');

  assert.equal(client.db.newsletter_campaigns.length, 1);
  const campaign = client.db.newsletter_campaigns[0];
  assert.deepEqual({ subject: campaign.subject, filter: campaign.recipient_filter, count: campaign.recipient_count, sent: campaign.sent_count, failed: campaign.failed_count, by: campaign.sent_by }, { subject: 'Őszi újdonságok', filter: 'test', count: 1, sent: 1, failed: 0, by: 'admin@example.com' });
});

test('newsletter to all subscribers applies the GDPR filter: subscribed AND confirmed e-mail, each mail with its own token', async (t) => {
  const client = useAdminEnv(t, fakeAdmin(newsletterTables()));
  const sent = captureMail(t);
  const base = await listen(t);
  const response = await sendNewsletter(base, campaignBody({ recipients: 'subscribers', ctaText: 'Új tervezet', ctaUrl: 'https://ovitervezo.hu/tervezo.html' }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).recipientCount, 2);
  await newsletter.whenIdle();

  assert.deepEqual(sent.map((m) => m.to).sort(), ['alice@example.com', 'carol@example.com'], 'Bob (nincs feliratkozva), Newbie (nincs megerősítve) és az admin kimarad');
  for (const message of sent) {
    const own = TOKEN_OF[message.to === 'alice@example.com' ? ALICE.id : CAROL.id];
    const others = Object.values(TOKEN_OF).filter((token) => token !== own);
    assert.ok(message.html.includes(`leiratkozas.html?token=${own}`), `${message.to}: saját link`);
    assert.ok(message.text.includes(`leiratkozas.html?token=${own}`));
    for (const token of others) assert.ok(!message.html.includes(token) && !message.text.includes(token), 'más token nem szerepelhet');
    assert.ok(message.html.includes('href="https://ovitervezo.hu/tervezo.html"') && message.html.includes('Új tervezet'), 'zöld CTA gomb');
    assert.ok(message.html.includes('#3fae84'), 'menta arculat');
  }
  const campaign = client.db.newsletter_campaigns[0];
  assert.deepEqual([campaign.recipient_filter, campaign.recipient_count, campaign.sent_count, campaign.failed_count], ['subscribers', 2, 2, 0]);
  for (const token of Object.values(TOKEN_OF)) assert.ok(!campaign.html_body.includes(token), 'a naplózott levélben nincs személyes token');
  assert.ok(campaign.html_body.includes('{{UNSUBSCRIBE_URL}}'));
});

test('failed deliveries are counted, do not stop the campaign and the progress is saved', async (t) => {
  const client = useAdminEnv(t, fakeAdmin(newsletterTables()));
  const sent = captureMail(t, { failFor: ['alice@example.com'] });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = originalError; });
  const base = await listen(t);
  assert.equal((await sendNewsletter(base, campaignBody({ recipients: 'subscribers' }))).status, 202);
  await newsletter.whenIdle();
  assert.deepEqual(sent.map((m) => m.to), ['carol@example.com']);
  const campaign = client.db.newsletter_campaigns[0];
  assert.deepEqual([campaign.recipient_count, campaign.sent_count, campaign.failed_count], [2, 1, 1]);
  assert.ok(errors.some((line) => line.includes('mailbox unavailable')));
});

test('custom recipients: unknown addresses get no personal link, unsubscribed members are skipped, invalid lists are rejected', async (t) => {
  const client = useAdminEnv(t, fakeAdmin(newsletterTables()));
  const sent = captureMail(t);
  const base = await listen(t);
  const response = await sendNewsletter(base, campaignBody({ recipients: 'custom', emails: 'Ismeretlen@Example.com, alice@example.com;bob@example.com\nalice@example.com' }));
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.recipientCount, 2);
  assert.deepEqual(result.skipped, [{ email: 'bob@example.com', reason: 'leiratkozott vagy nem iratkozott fel' }]);
  await newsletter.whenIdle();

  const byTo = Object.fromEntries(sent.map((m) => [m.to, m]));
  assert.deepEqual(Object.keys(byTo).sort(), ['alice@example.com', 'ismeretlen@example.com']);
  assert.ok(byTo['alice@example.com'].html.includes(`token=${TOKEN_OF[ALICE.id]}`));
  assert.ok(!byTo['ismeretlen@example.com'].html.includes('leiratkozas.html'), 'regisztráció nélkül nincs személyes link');
  assert.ok(byTo['ismeretlen@example.com'].html.includes('válaszolj erre a levélre'));
  assert.equal(byTo['ismeretlen@example.com'].headers, undefined);
  assert.equal(client.db.newsletter_campaigns[0].recipient_filter, 'custom');

  for (const emails of ['', '   ', 'nem-email', 'jo@example.com, rossz@']) {
    assert.equal((await sendNewsletter(base, campaignBody({ recipients: 'custom', emails }))).status, 400, JSON.stringify(emails));
  }
  const tooMany = Array.from({ length: 201 }, (_, i) => `u${i}@example.com`).join(',');
  assert.equal((await sendNewsletter(base, campaignBody({ recipients: 'custom', emails: tooMany }))).status, 400);
  await newsletter.whenIdle();
  assert.equal(client.db.newsletter_campaigns.length, 1, 'elutasított kérésből nincs kampány');
});

test('newsletter requests are validated and the custom HTML is stripped of active content', async (t) => {
  const client = useAdminEnv(t, fakeAdmin(newsletterTables()));
  const sent = captureMail(t);
  const base = await listen(t);
  for (const bad of [
    { subject: '' }, { subject: 'x'.repeat(201) }, { bodyHtml: '' }, { bodyHtml: 'y'.repeat(50001) }, { recipients: 'mindenki' }, { recipients: undefined },
    { ctaText: 'Gomb' }, { ctaUrl: 'https://ovitervezo.hu' }, { ctaText: 'Gomb', ctaUrl: 'javascript:alert(1)' }, { ctaText: 'Gomb', ctaUrl: 'http://ovitervezo.hu' }, { ctaText: 'Gomb', ctaUrl: 'nem url' }
  ]) {
    const response = await sendNewsletter(base, campaignBody(bad));
    assert.equal(response.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(client.db.newsletter_campaigns.length, 0);

  const html = '<h2 onclick="steal()">Cím</h2><script>alert(1)</script><p>Szia <a href="javascript:alert(2)">link</a> <a href="https://ovitervezo.hu" onmouseover=evil()>jó</a></p><iframe src="https://evil.example"></iframe>';
  assert.equal((await sendNewsletter(base, campaignBody({ bodyHtml: html, subject: 'Tárgy\r\nBcc: rossz@example.com' }))).status, 202);
  await newsletter.whenIdle();
  const mail = sent[0].html;
  assert.ok(mail.includes('<h2>Cím</h2>') && mail.includes('href="https://ovitervezo.hu"'));
  assert.doesNotMatch(mail, /<script|<iframe|onclick|onmouseover|javascript:/i);
  assert.ok(!/[\r\n]/.test(sent[0].subject), 'a tárgyban nincs sortörés (fejlécinjekció ellen)');
});

test('only one newsletter job runs at a time and the campaign list reports the running one', async (t) => {
  useAdminEnv(t, fakeAdmin(newsletterTables()));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  captureMail(t, { gate });
  const base = await listen(t);
  const first = await sendNewsletter(base, campaignBody({ recipients: 'subscribers' }));
  assert.equal(first.status, 202);
  const { campaignId } = await first.json();
  assert.equal((await sendNewsletter(base, campaignBody())).status, 409);
  const running = await (await call(base, '/api/admin/newsletter/campaigns', { token: 'token-admin' })).json();
  assert.equal(running.sending, campaignId);
  release();
  await newsletter.whenIdle();
  const done = await (await call(base, '/api/admin/newsletter/campaigns', { token: 'token-admin' })).json();
  assert.equal(done.sending, null);
  assert.deepEqual([done.campaigns[0].sentCount, done.campaigns[0].failedCount, done.campaigns[0].recipientFilter], [2, 0, 'subscribers']);
  assert.ok(!('html_body' in done.campaigns[0]) && !('htmlBody' in done.campaigns[0]), 'a lista nem hozza a levéltörzset');
});

test('sending is refused without an SMTP configuration outside the test mode, and the pacing is 1.5 s (0 in tests)', async (t) => {
  const client = fakeAdmin(newsletterTables());
  await assert.rejects(newsletter.startCampaign(client, campaignBody(), { id: ADMIN.id, email: 'admin@example.com' }, { env: { NODE_ENV: 'production' } }), (error) => error.status === 503 && /SMTP/.test(error.message));
  assert.equal(client.db.newsletter_campaigns.length, 0);
  assert.equal(newsletter.sendDelayMs({ NODE_ENV: 'test' }), 0);
  assert.equal(newsletter.sendDelayMs({ NODE_ENV: 'production' }), 1500);
  assert.equal(newsletter.sendDelayMs({}), 1500);
});

test('POST /api/admin/newsletter/preview renders the official mail with an embedded logo and tolerates unfinished input', async (t) => {
  useAdminEnv(t, fakeAdmin(newsletterTables()));
  const base = await listen(t);
  const empty = await call(base, '/api/admin/newsletter/preview', { token: 'token-admin', method: 'POST', body: {} });
  assert.equal(empty.status, 200);
  const { html } = await empty.json();
  assert.ok(html.includes('data:image/png;base64,') && !html.includes('cid:'));
  assert.ok(html.includes('leiratkozas.html?token='), 'minta leiratkozó link látszik');
  const full = await (await call(base, '/api/admin/newsletter/preview', { token: 'token-admin', method: 'POST', body: { heading: '<b>Cím</b>', bodyHtml: 'Szöveg', ctaText: 'Gomb', ctaUrl: 'https://ovitervezo.hu/x' } })).json();
  assert.ok(full.html.includes('&lt;b&gt;Cím&lt;/b&gt;') && full.html.includes('href="https://ovitervezo.hu/x"'));
  const badLink = await (await call(base, '/api/admin/newsletter/preview', { token: 'token-admin', method: 'POST', body: { bodyHtml: 'x', ctaText: 'Gomb', ctaUrl: 'javascript:alert(1)' } })).json();
  assert.ok(!badLink.html.includes('javascript:') && !badLink.html.includes('Gomb'));
});

// ---------- Fájllisták és oldal ----------

test('admin.html and admin.js are shipped with every build, served by the backend and kept out of search engines', async (t) => {
  const { PAGES, SITE_ASSETS } = require('../backend/services/siteConstants');
  assert.ok(PAGES.includes('admin.html') && SITE_ASSETS.includes('js/admin.js'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'admin.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'nincs inline script');
  assert.doesNotMatch(html, /#(?:e67e22|f39c12|ff9800|d35400)/i, 'nincs narancs szín');
  assert.match(html, /<iframe[^>]*id="nlPreview"[^>]*sandbox=""/, 'az előnézet sandboxolt');
  for (const label of ['Cloudflare Analytics', 'Google Analytics', 'Google Search Console', 'Barion', 'Számlázz.hu', 'Külső eszközök']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'sitemap.xml'), 'utf8'), /admin/);
  const base = await listen(t);
  assert.equal((await fetch(`${base}/admin.html`)).status, 200);
  assert.equal((await fetch(`${base}/js/admin.js`)).status, 200);
});

// ---------- Böngészős rész (jsdom) ----------

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const SESSION = { access_token: 'jwt-admin', user: { id: ADMIN.id, email: 'admin@example.com' } };

async function loadPage(t, { page = 'admin.html', session = SESSION, routes = {} }) {
  const state = { listener: null, fetches: [], errors: [], blobs: [], confirms: [] };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => state.errors.push(error.message));
  const dom = new JSDOM(readPage(page), {
    url: `http://localhost:8000/${page}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.APP_CONFIG = { apiBaseUrl: 'same-origin', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
      window.alert = () => {};
      window.confirm = (message) => { state.confirms.push(message); return true; };
      window.URL.createObjectURL = (blob) => { state.blobs.push(blob); return 'blob:test'; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = () => {};
      window.fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        // A site.js futásidőben lekéri a nyilvános konfigot; ez nem admin adatkérés.
        if (parsed.pathname !== '/api/config') state.fetches.push({ path: parsed.pathname, query: parsed.search, method, body, headers: options.headers || {} });
        const handler = routes[parsed.pathname];
        const [data, status = 200] = handler ? [].concat(handler(method, body, parsed.searchParams)) : [{ success: false, error: 'nincs ilyen' }, 404];
        return { ok: status < 400, status, json: async () => data };
      };
      window.supabase = { createClient: () => ({ auth: { onAuthStateChange(callback) { state.listener = callback; return { data: { subscription: {} } }; } } }) };
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  state.listener('INITIAL_SESSION', session);
  await tick();
  return { window: dom.window, document: dom.window.document, state };
}

const STATS = { success: true, stats: { revenue: { total: 12340, last30Days: 4560 }, paidOrders: 25, registeredUsers: 42, confirmedSubscribers: 17, documents: { total: 80, unlocked: 30, breakdown: { standard: 40, academic: 25, weekly: 15 }, conversionRate: 37.5 } }, dailyGeneration: { day: '2026-01-02', count: 7, cap: 250, source: 'settings' } };
const ME = () => [{ success: true, isAdmin: true }];
const hidden = (document, id) => document.getElementById(id).hidden;
const redirected = (state) => state.errors.some((message) => /navigation/i.test(message));

test('admin.js: a guest or a non-admin is redirected at once and no admin data is requested or shown', async (t) => {
  const guest = await loadPage(t, { session: null, routes: {} });
  assert.deepEqual(guest.state.fetches, [], 'vendég: semmilyen kérés');
  assert.ok(redirected(guest.state), 'vendég: átirányítás a főoldalra');
  assert.equal(hidden(guest.document, 'adminApp'), true);

  const regular = await loadPage(t, { routes: { '/api/admin/me': () => [{ success: false, code: 'ADMIN_FORBIDDEN', error: 'Nincs jogosultság' }, 403] } });
  assert.deepEqual(regular.state.fetches.map((f) => f.path), ['/api/admin/me'], 'csak a jogosultság-ellenőrzés fut');
  assert.ok(redirected(regular.state));
  assert.equal(hidden(regular.document, 'adminApp'), true);
  assert.equal(regular.document.getElementById('kpiRevenueTotal').textContent, '–');

  const offline = await loadPage(t, { routes: { '/api/admin/me': () => { throw new Error('hálózati hiba'); } } });
  assert.ok(redirected(offline.state), 'hibánál is zárva marad');
  assert.equal(hidden(offline.document, 'adminApp'), true);
});

test('admin.js: the admin sees the overview with KPI cards and the document analytics', async (t) => {
  const links = { cloudflare: 'https://dash.cloudflare.com/', google_analytics: 'https://analytics.google.com/', search_console: 'https://search.google.com/search-console', barion: 'https://secure.barion.com/', szamlazz: 'http://nem-https.example' };
  const { document, state } = await loadPage(t, { routes: { '/api/admin/me': ME, '/api/admin/stats': () => [STATS], '/api/admin/settings': () => [{ success: true, settings: { external_links: links } }] } });
  assert.ok(!redirected(state));
  assert.equal(hidden(document, 'adminApp'), false);
  assert.equal(hidden(document, 'adminLoading'), true);
  assert.equal(state.fetches[0].headers.Authorization, 'Bearer jwt-admin');
  const text = (id) => document.getElementById(id).textContent.replace(/\s/g, ' ');
  assert.match(text('kpiRevenueTotal'), /12\s?340 Ft/);
  assert.match(text('kpiRevenue30'), /4\s?560 Ft/);
  assert.equal(text('kpiOrders'), '25');
  assert.equal(text('kpiUsers'), '42');
  assert.equal(text('kpiSubscribers'), '17');
  assert.equal(text('docTotal'), '80');
  assert.deepEqual(['docStandard', 'docAcademic', 'docWeekly'].map(text), ['40', '25', '15']);
  assert.equal(text('docConversion'), '37,5%');
  assert.equal(document.querySelectorAll('.admin-tools-list a[target="_blank"][rel~="noopener"]').length, 4, 'csak az érvényes https:// linkek jelennek meg');
  assert.equal(document.getElementById('adminTools').hidden, false);
  assert.equal(text('kpiDailyCap'), '7 / 250');
  assert.equal(document.querySelectorAll('.admin-card-grid .admin-card table').length, 3, 'a Top táblák kártyákban vannak');
});

test('admin.js: coupon form posts the new coupon and the switch patches the active flag', async (t) => {
  let coupons = [{ code: 'TEST100', discountPercent: 100, maxUses: null, validUntil: null, isActive: true, note: 'Belső', createdAt: ago(3), uses: 2, totalDiscount: 780 }];
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/coupons': (method, body) => {
        if (method === 'POST') { coupons = [{ code: body.code.toUpperCase(), discountPercent: Number(body.discount_percent), maxUses: body.max_uses, validUntil: null, isActive: true, note: body.note, createdAt: ago(0), uses: 0, totalDiscount: 0 }, ...coupons]; return [{ success: true, coupon: coupons[0] }, 201]; }
        return [{ success: true, coupons, redemptions: [{ id: 'r1', code: 'TEST100', email: 'vevo@example.com', planMode: 'standard', originalPrice: 390, discountAmount: 390, finalPrice: 0, usedAt: ago(1) }] }];
      },
      '/api/admin/coupons/TEST100': (method, body) => { const coupon = coupons.find((c) => c.code === 'TEST100'); coupon.isActive = body.is_active; return [{ success: true, coupon }]; }
    }
  });
  document.getElementById('tabCoupons').click();
  await tick();
  const rows = () => [...document.querySelectorAll('#couponsTable tbody tr')];
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /TEST100.*100%.*2 \/ korlátlan/);
  assert.match(document.querySelector('#redemptionsTable tbody').textContent, /vevo@example\.com/);
  assert.equal(document.getElementById('panelOverview').hidden, true);

  document.getElementById('couponCode').value = 'nyar20';
  document.getElementById('couponPercent').value = '20';
  document.getElementById('couponMaxUses').value = '10';
  document.getElementById('couponNote').value = 'Nyári akció';
  document.getElementById('couponForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  const post = state.fetches.find((f) => f.method === 'POST' && f.path === '/api/admin/coupons');
  assert.deepEqual(post.body, { code: 'nyar20', discount_percent: '20', max_uses: '10', valid_until: null, note: 'Nyári akció' });
  assert.match(document.getElementById('couponStatus').textContent, /NYAR20/);
  assert.equal(rows().length, 2);

  const toggle = rows()[1].querySelector('button[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  toggle.click();
  await tick();
  const patch = state.fetches.find((f) => f.method === 'PATCH');
  assert.equal(patch.path, '/api/admin/coupons/TEST100');
  assert.deepEqual(patch.body, { is_active: false });
  assert.equal(rows()[1].querySelector('button[role="switch"]').getAttribute('aria-checked'), 'false');
});

test('admin.js: an invalid coupon shows the server message without adding a row', async (t) => {
  const { document, window } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/coupons': (method) => (method === 'POST' ? [{ success: false, error: 'Ilyen kuponkód már létezik.' }, 409] : [{ success: true, coupons: [], redemptions: [] }])
    }
  });
  document.getElementById('tabCoupons').click();
  await tick();
  document.getElementById('couponCode').value = 'DUPLA';
  document.getElementById('couponPercent').value = '10';
  document.getElementById('couponForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(document.getElementById('couponError').textContent, 'Ilyen kuponkód már létezik.');
  assert.equal(document.getElementById('couponError').hidden, false);
});

const readBlob = (window, blob) => new Promise((resolve) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });

test('admin.js: the orders table is filtered through the API and exports a formula-safe CSV', async (t) => {
  const orders = [
    { orderNumber: 'OVI-1', createdAt: '2026-03-01T10:00:00Z', email: 'vevo@example.com', name: '=HYPERLINK("x")', planKey: 'daily', amount: 390, couponCode: '', paymentMethod: 'Barion', status: 'paid', invoiceNumber: 'OVITE-2026-1' },
    { orderNumber: 'OVI-2', createdAt: '2026-03-02T10:00:00Z', email: 'masik@example.com', name: '', planKey: 'weekly_detailed', amount: 890, couponCode: 'NYAR20', paymentMethod: 'Barion', status: 'pending', invoiceNumber: '' }
  ];
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/orders': (_method, _body, params) => [pagedOrders(orders.filter((o) => (!params.get('status') || o.status === params.get('status')) && (!params.get('q') || o.email.includes(params.get('q')))))]
    }
  });
  document.getElementById('tabOrders').click();
  await tick();
  assert.equal(document.querySelectorAll('#ordersTable tbody tr').length, 2);
  assert.match(document.getElementById('ordersTable').textContent, /Fizetve.*OVITE-2026-1/);
  assert.match(document.getElementById('ordersTable').textContent, /Heti részletes csomag/);

  const status = document.getElementById('ordersStatus');
  status.value = 'pending';
  status.dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal(document.querySelectorAll('#ordersTable tbody tr').length, 1);
  assert.match(state.fetches.at(-1).query, /status=pending/);

  status.value = '';
  status.dispatchEvent(new window.Event('change'));
  const search = document.getElementById('ordersSearch');
  search.value = 'vevo@';
  search.dispatchEvent(new window.Event('input'));
  await tick(450);
  assert.match(state.fetches.at(-1).query, /q=vevo%40/);
  assert.equal(document.querySelectorAll('#ordersTable tbody tr').length, 1);

  document.getElementById('ordersExport').click();
  assert.equal(state.blobs.length, 1);
  const csv = await readBlob(window, state.blobs[0]);
  assert.ok(csv.length > 0);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2, 'fejléc + a szűrt sor');
  assert.match(lines[0], /Rendelésszám;Név;E-mail/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`) || lines[1].includes("'=HYPERLINK"), 'a képletnek látszó cella aposztróffal védett');
  assert.ok(!/;=HYPERLINK/.test(lines[1]));
});

test('admin.js: toCsv quotes separators, newlines and neutralizes formula prefixes', async (t) => {
  const { window } = await loadPage(t, { routes: { '/api/admin/me': ME, '/api/admin/stats': () => [STATS] } });
  const csv = window.OviAdmin.toCsv([['a;b', 'sor\ntörés', '+36 30', '@parancs', '-1+1', 'idézet "x"', null, 390]]);
  assert.equal(csv, '\uFEFF"a;b";"sor\ntörés";\'+36 30;\'@parancs;\'-1+1;"idézet ""x""";;390\r\n');
});

test('admin.js: the users tab lists registrations and exports only confirmed subscribers', async (t) => {
  const usersData = [
    { id: '1', email: 'alice@example.com', name: 'Alice', createdAt: '2026-01-02T10:00:00Z', confirmed: true, subscribed: true, subscribedAt: '2026-01-02T10:00:00Z' },
    { id: '2', email: 'bob@example.com', name: '', createdAt: '2026-01-03T10:00:00Z', confirmed: true, subscribed: false, subscribedAt: null },
    { id: '3', email: 'new@example.com', name: 'Új', createdAt: '2026-01-04T10:00:00Z', confirmed: false, subscribed: true, subscribedAt: '2026-01-04T10:00:00Z' }
  ];
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/users': () => [{ success: true, users: usersData, subscriberCount: 1, total: usersData.length, page: 1, pageSize: 20, totalPages: 1 }],
      '/api/admin/newsletter/campaigns': () => [{ success: true, sending: null, campaigns: [{ id: 'c1', subject: 'Őszi hírlevél', recipientFilter: 'subscribers', recipientCount: 12, sentCount: 11, failedCount: 1, sentBy: 'admin@example.com', createdAt: ago(2) }] }],
      '/api/admin/newsletter/preview': () => [{ success: true, html: '<html><body>ELŐNÉZET</body></html>' }]
    }
  });
  document.getElementById('tabUsers').click();
  await tick();
  assert.equal(document.querySelectorAll('#usersTable tbody tr').length, 3);
  assert.match(document.getElementById('usersCount').textContent, /3 regisztrált.*1 megerősített/);
  assert.equal(document.getElementById('nlSubject'), document.querySelector('#panelNewsletter #nlSubject'), 'a hírlevél űrlap a saját fülén van');
  assert.equal(document.querySelector('#panelUsers #nlSubject'), null);
  document.getElementById('tabNewsletter').click();
  await tick();
  assert.equal(document.getElementById('panelNewsletter').hidden, false);
  assert.equal(document.getElementById('panelUsers').hidden, true);
  assert.match(document.querySelector('#campaignsTable tbody').textContent, /Őszi hírlevél.*12 \(Összes feliratkozó\).*11.*1.*admin@example\.com/);
  assert.equal(document.getElementById('nlPreview').srcdoc, '<html><body>ELŐNÉZET</body></html>');

  document.getElementById('usersExport').click();
  const csv = await readBlob(window, state.blobs[0]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2, 'csak a feliratkozott ÉS megerősített felhasználó');
  assert.ok(lines[1].startsWith('Alice;alice@example.com;'));
});

test('admin.js: a free coupon order shows a 0 Ft / Kupon label instead of a disabled invoice button', async (t) => {
  const orders = [
    { orderNumber: 'OVI-K1', createdAt: ago(1), email: 'k@example.com', name: 'K', planKey: 'daily', amount: 0, couponCode: 'TEST100', paymentMethod: 'Kupon', status: 'paid', invoiceNumber: '', lastError: '' },
    { orderNumber: 'OVI-P1', createdAt: ago(2), email: 'p@example.com', name: 'P', planKey: 'daily', amount: 390, couponCode: '', paymentMethod: 'Barion', status: 'paid', invoiceNumber: '', lastError: '' }
  ];
  const { document } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/orders': () => [pagedOrders(orders)]
    }
  });
  await tick();
  document.getElementById('tabOrders').click();
  await tick();
  const rows = document.querySelectorAll('#ordersTable tbody tr');
  assert.equal(rows[0].querySelector('.admin-free-label').textContent, '0 Ft / Kupon');
  assert.ok(![...rows[0].querySelectorAll('button')].some((b) => b.textContent === 'Számla kiállítása'));
  const paid = [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Számla kiállítása');
  assert.equal(paid.disabled, false);
});

test('admin.js: failed paid orders show a red banner and error text, with separate issue-invoice, e-mail and download buttons', async (t) => {
  const orders = [
    { orderNumber: 'OVI-F1', createdAt: ago(1), email: 'a@example.com', name: 'A', planKey: 'daily', amount: 390, couponCode: '', paymentMethod: 'Barion', status: 'paid', invoiceNumber: '', lastError: 'Számlázás: Számlázz.hu hiba (8): emelt díjcsomag' },
    { orderNumber: 'OVI-F2', documentId: 'gen_f2', createdAt: ago(2), email: 'b@example.com', name: 'B', planKey: 'daily', amount: 390, couponCode: '', paymentMethod: 'Barion', status: 'paid', invoiceNumber: 'E-1', lastError: '' }
  ];
  const { document, state } = await loadPage(t, {
    confirm: true,
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/orders': () => [pagedOrders(orders, { failedCount: 1, failed: [{ orderNumber: 'OVI-F1', lastError: orders[0].lastError }] })],
      '/api/admin/orders/OVI-F1/issue-invoice': () => [{ success: true, invoiceNumber: 'E-2' }]
    }
  });
  await tick();
  const banner = document.getElementById('failedOrdersBanner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /1 kifizetett rendelésnél[\s\S]*OVI-F1[\s\S]*emelt díjcsomag/);

  document.getElementById('tabOrders').click();
  await tick();
  const rows = document.querySelectorAll('#ordersTable tbody tr');
  assert.match(rows[0].textContent, /Hiba: Számlázás: Számlázz\.hu hiba \(8\)/);
  assert.ok(rows[0].querySelector('.admin-order-error'));
  assert.equal(rows[1].querySelector('.admin-order-error'), null);
  const labels = (row) => [...row.querySelectorAll('button')].map((b) => [b.textContent, b.disabled]);
  assert.deepEqual(labels(rows[0]), [['Számla kiállítása', false], ['Számla küldése', true], ['Csomag küldése', true], ['Számla letöltése', true]]);
  assert.match([...rows[0].querySelectorAll('button')][2].title, /document_id hiányzik/, 'tervezet nélküli rendelésnél a gomb magyarázó tooltippel letiltott');
  assert.deepEqual(labels(rows[1]), [['Számla kiállítása', true], ['Számla küldése', false], ['Csomag küldése', false], ['Számla letöltése', false]]);

  rows[0].querySelector('button').click();
  await tick();
  assert.ok(state.fetches.some((f) => f.path === '/api/admin/orders/OVI-F1/issue-invoice' && f.method === 'POST'));
  assert.deepEqual(state.confirms, [], 'a számlakiállítás nem függ a böngésző confirm ablakától');
  assert.match(document.getElementById('adminToast').textContent, /Számla kiállítva: E-2/);
  assert.equal(document.getElementById('adminToast').hidden, false);
});

test('admin.js: the newsletter editor refreshes the live preview, asks for confirmation and sends the payload', async (t) => {
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/users': () => [{ success: true, users: [], subscriberCount: 0 }],
      '/api/admin/newsletter/campaigns': () => [{ success: true, sending: null, campaigns: [] }],
      '/api/admin/newsletter/preview': (_method, body) => [{ success: true, html: `<p>${body.heading}|${body.bodyHtml}</p>` }],
      '/api/admin/newsletter/send': (_method, body) => (body.recipients === 'custom' ? [{ success: true, recipientCount: 2, skipped: [{ email: 'x@example.com', reason: 'leiratkozott' }] }, 202] : [{ success: true, recipientCount: 1, skipped: [] }, 202])
    }
  });
  document.getElementById('tabUsers').click();
  await tick();
  const set = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  set('nlSubject', 'Tárgy');
  set('nlHeading', 'Főcím');
  set('nlBody', 'Törzs');
  await tick(450);
  assert.equal(document.getElementById('nlPreview').srcdoc, '<p>Főcím|Törzs</p>', 'az előnézet a beírt tartalmat mutatja');
  assert.equal(document.getElementById('nlPreview').getAttribute('sandbox'), '');

  // Teszt címzett: nincs megerősítő kérdés.
  document.getElementById('newsletterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.deepEqual(state.confirms, []);
  const testSend = state.fetches.find((f) => f.path === '/api/admin/newsletter/send');
  assert.deepEqual(testSend.body, { subject: 'Tárgy', heading: 'Főcím', bodyHtml: 'Törzs', ctaText: '', ctaUrl: '', recipients: 'test' });
  assert.match(document.getElementById('nlStatus').textContent, /elindult: 1 címzett/);

  // Egyedi lista: a címmező megjelenik, és van megerősítés.
  const custom = document.querySelector('input[name="recipients"][value="custom"]');
  assert.equal(document.getElementById('nlCustom').hidden, true);
  custom.checked = true;
  custom.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('nlCustom').hidden, false);
  set('nlCustom', 'a@example.com, x@example.com');
  document.getElementById('newsletterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(state.confirms.length, 1);
  const customSend = state.fetches.filter((f) => f.path === '/api/admin/newsletter/send').at(-1);
  assert.equal(customSend.body.recipients, 'custom');
  assert.equal(customSend.body.emails, 'a@example.com, x@example.com');
  assert.match(document.getElementById('nlStatus').textContent, /1 címzett kimaradt/);
});

test('admin.js: a refused send shows the server error', async (t) => {
  const { document, window } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/users': () => [{ success: true, users: [], subscriberCount: 0 }],
      '/api/admin/newsletter/campaigns': () => [{ success: true, sending: null, campaigns: [] }],
      '/api/admin/newsletter/preview': () => [{ success: true, html: '' }],
      '/api/admin/newsletter/send': () => [{ success: false, error: 'A tárgy megadása kötelező.' }, 400]
    }
  });
  document.getElementById('tabUsers').click();
  await tick();
  document.getElementById('newsletterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(document.getElementById('nlError').textContent, 'A tárgy megadása kötelező.');
  assert.equal(document.getElementById('nlSend').disabled, false);
});

// ---------- A Vezérlőpult link az auth.js-ben ----------

test('auth.js shows the discreet Vezérlőpult link next to the account button only for a confirmed admin', async (t) => {
  const admin = await loadPage(t, { page: 'index.html', routes: { '/api/admin/me': ME } });
  const link = admin.document.getElementById('adminLink');
  assert.ok(link, 'adminként megjelenik');
  assert.equal(link.getAttribute('href'), 'admin.html');
  assert.equal(link.textContent, 'Vezérlőpult');
  assert.equal(link.previousElementSibling, admin.document.getElementById('authBtn'), 'a Fiókom gomb mellett');
  assert.equal(admin.document.getElementById('authBtn').textContent, 'Fiókom');

  const forbidden = await loadPage(t, { page: 'index.html', routes: { '/api/admin/me': () => [{ success: false, error: 'Nincs jogosultság' }, 403] } });
  assert.equal(forbidden.document.getElementById('adminLink'), null, '403: nincs link');
  assert.equal(forbidden.state.fetches.filter((f) => f.path === '/api/admin/me').length, 1);

  const notTrue = await loadPage(t, { page: 'index.html', routes: { '/api/admin/me': () => [{ success: true, isAdmin: false }] } });
  assert.equal(notTrue.document.getElementById('adminLink'), null, 'csak az isAdmin: true számít');

  const broken = await loadPage(t, { page: 'index.html', routes: { '/api/admin/me': () => { throw new Error('offline'); } } });
  assert.equal(broken.document.getElementById('adminLink'), null, 'hálózati hibánál nincs link');

  const guest = await loadPage(t, { page: 'index.html', session: null, routes: { '/api/admin/me': ME } });
  assert.equal(guest.document.getElementById('adminLink'), null);
  assert.deepEqual(guest.state.fetches.filter((f) => f.path.startsWith('/api/admin')), [], 'vendégként nincs admin kérés');

  // Kijelentkezéskor a link eltűnik.
  admin.state.listener('SIGNED_OUT', null);
  await tick();
  assert.equal(admin.document.getElementById('adminLink'), null);
});

// ---------- Rendszernapló és ügyfélszolgálati kupon ----------

test('GET /api/admin/logs returns paginated logs, newest first, only for admins', async (t) => {
  const rows = Array.from({ length: 105 }, (_, i) => ({ id: `l${i}`, level: i === 104 ? 'error' : 'info', context: 'ai_generation', message: `m${i}`, details: { secret: 'x' }, user_email: i === 104 ? 'vevo@example.com' : null, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_logs: rows }));
  const base = await listen(t);
  const denied = await call(base, '/api/admin/logs', { token: 'token-bob' });
  assert.equal(denied.status, 403);
  const response = await call(base, '/api/admin/logs', { token: 'token-admin' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.logs.length, 20, 'az alapértelmezett oldalméret 20');
  assert.equal(data.total, 105);
  const full = await (await call(base, '/api/admin/logs?pageSize=100', { token: 'token-admin' })).json();
  assert.equal(full.logs.length, 100);
  assert.deepEqual({ level: full.logs[0].level, email: full.logs[0].email, message: full.logs[0].message }, { level: 'error', email: 'vevo@example.com', message: 'm104' });
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.ok(client.db.system_logs.length >= 105);
});

test('POST /api/admin/support/coupon creates a single-use SORRY-XXXXXX 100% coupon for the user', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_logs: [] }));
  const base = await listen(t);
  assert.equal((await call(base, '/api/admin/support/coupon', { method: 'POST', token: 'token-bob', body: { email: 'a@example.com' } })).status, 403);
  assert.equal((await call(base, '/api/admin/support/coupon', { method: 'POST', token: 'token-admin', body: { email: 'nem-email' } })).status, 400);
  const response = await call(base, '/api/admin/support/coupon', { method: 'POST', token: 'token-admin', body: { email: 'Panasz@Example.com' } });
  assert.equal(response.status, 201);
  const { coupon } = await response.json();
  assert.match(coupon.code, /^SORRY-[A-Z2-9]{6}$/);
  assert.equal(coupon.email, 'panasz@example.com');
  const stored = client.db.coupons.find((row) => row.code === coupon.code);
  assert.equal(stored.discount_percent, 100);
  assert.equal(stored.max_uses, 1);
  assert.equal(stored.is_active, true);
  assert.match(stored.note, /panasz@example\.com/);
  assert.ok(client.db.system_logs.some((row) => row.context === 'admin_support' && row.user_email === 'panasz@example.com'));
});

test('newsletter to all subscribers includes active guests (rows without user_id) with their own token, once per e-mail', async (t) => {
  const tables = newsletterTables();
  tables.newsletter_subscribers.push(
    { email: 'vendeg@example.com', user_id: null, name: 'Vendég', newsletter_token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', subscribed: true },
    { email: 'kilepett@example.com', user_id: null, name: '', newsletter_token: 'ffffffff-ffff-4fff-8fff-ffffffffffff', subscribed: false }
  );
  useAdminEnv(t, fakeAdmin(tables));
  const sent = captureMail(t);
  const base = await listen(t);
  const response = await sendNewsletter(base, campaignBody({ recipients: 'subscribers' }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).recipientCount, 3);
  await newsletter.whenIdle();
  assert.deepEqual(sent.map((m) => m.to).sort(), ['alice@example.com', 'carol@example.com', 'vendeg@example.com']);
  const guest = sent.find((m) => m.to === 'vendeg@example.com');
  assert.ok(guest.html.includes('token=dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  const alice = sent.find((m) => m.to === 'alice@example.com');
  assert.ok(alice.html.includes(`token=${TOKEN_OF[ALICE.id]}`), 'a regisztrált felhasználó a saját tokenjét kapja');
  assert.ok(!sent.some((m) => m.to === 'kilepett@example.com'), 'a leiratkozott vendég kimarad');
});

test('PATCH /api/admin/coupons/:code edits valid_until (clearable), max_uses and note', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), coupons: [{ code: 'TEST100', discount_percent: 100, max_uses: 5, valid_until: '2099-01-01T00:00:00.000Z', is_active: true, note: 'Régi', created_at: '2026-01-01T00:00:00Z' }] }));
  const base = await listen(t);
  const patch = (body) => call(base, '/api/admin/coupons/TEST100', { token: 'token-admin', method: 'PATCH', body });
  const row = () => client.db.coupons[0];

  assert.equal((await patch({ valid_until: '2099-12-31', max_uses: '10', note: 'Új' })).status, 200);
  assert.deepEqual([row().valid_until, row().max_uses, row().note, row().is_active], ['2099-12-31T23:59:59.999Z', 10, 'Új', true]);
  assert.equal((await patch({ valid_until: '', max_uses: null, note: '' })).status, 200);
  assert.deepEqual([row().valid_until, row().max_uses, row().note], [null, null, null], 'üres érték = NULL');
  assert.equal((await patch({ is_active: false })).status, 200);
  assert.equal(row().is_active, false);
  assert.equal(row().note, null, 'a nem küldött mezők érintetlenek');
  for (const bad of [{ max_uses: 0 }, { valid_until: '2001-01-01' }, { valid_until: 'nem-datum' }, { note: 'x'.repeat(201) }, {}]) assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(base, '/api/admin/coupons/NINCS', { token: 'token-admin', method: 'PATCH', body: { note: 'x' } })).status, 404);
});

test('DELETE /api/admin/coupons/:code deletes, and soft-deletes on a foreign key violation (23503)', async (t) => {
  const coupons = () => [
    { code: 'FREE', discount_percent: 10, max_uses: null, valid_until: null, is_active: true, note: 'x', created_at: '2026-01-01T00:00:00Z' },
    { code: 'USED', discount_percent: 10, max_uses: null, valid_until: null, is_active: true, note: 'x', created_at: '2026-01-01T00:00:00Z' }
  ];
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), coupons: coupons() }));
  const base = await listen(t);
  const remove = (code) => call(base, `/api/admin/coupons/${code}`, { token: 'token-admin', method: 'DELETE' });

  assert.equal((await call(base, '/api/admin/coupons/FREE', { method: 'DELETE' })).status, 401);
  const plain = await remove('FREE');
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { success: true, deleted: true, archived: false, code: 'FREE' });
  assert.deepEqual(client.db.coupons.map((c) => c.code), ['USED']);

  client.failures['delete:coupons'] = { code: '23503', message: 'violates foreign key constraint' };
  const before = Date.now();
  const soft = await remove('USED');
  assert.equal(soft.status, 200);
  const body = await soft.json();
  assert.equal(body.archived, true);
  const used = client.db.coupons[0];
  assert.equal(used.is_active, false);
  assert.equal(used.note, '[Archiválva/Törölve]');
  assert.ok(Date.parse(used.valid_until) < before, 'a lejárat múltbeli (tegnap)');
  assert.ok(before - Date.parse(used.valid_until) < 25 * 3600 * 1000);

  client.failures['delete:coupons'] = { code: '42501', message: 'permission denied' };
  assert.equal((await remove('USED')).status, 500);
  assert.equal((await remove('nem jó kód!')).status, 404);
});

test('GET /api/admin/newsletter/campaigns/:id extracts subject, heading, body and CTA for reuse', async (t) => {
  const newsletterService = require('../backend/services/newsletterService');
  const html = newsletterService.buildNewsletterHtml({ heading: 'Új & jó', bodyHtml: '<p>Szia <b>ovis</b>!</p>', ctaText: 'Megnézem', ctaUrl: 'https://ovitervezo.hu/tervezo.html', unsubscribeUrl: '{{UNSUBSCRIBE_URL}}' });
  const id = '11111111-1111-4111-8111-111111111111';
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), newsletter_campaigns: [{ id, subject: 'Tárgy', html_body: html, created_at: '2026-01-01T00:00:00Z' }] }));
  const base = await listen(t);
  const response = await call(base, `/api/admin/newsletter/campaigns/${id}`, { token: 'token-admin' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).campaign, { id, subject: 'Tárgy', heading: 'Új & jó', bodyHtml: '<p>Szia <b>ovis</b>!</p>', ctaText: 'Megnézem', ctaUrl: 'https://ovitervezo.hu/tervezo.html' });
  assert.equal((await call(base, '/api/admin/newsletter/campaigns/22222222-2222-4222-8222-222222222222', { token: 'token-admin' })).status, 404);
  assert.equal((await call(base, '/api/admin/newsletter/campaigns/nem-id', { token: 'token-admin' })).status, 404);
});

test('GET /api/admin/settings/history/:key returns the change log newest first, only for admins', async (t) => {
  const rows = [
    { id: 'a', setting_key: 'pricing', old_value: { standard: 390 }, new_value: { standard: 400 }, changed_at: '2026-11-01T10:00:00Z' },
    { id: 'b', setting_key: 'pricing', old_value: { standard: 400 }, new_value: { standard: 450 }, changed_at: '2026-11-03T10:00:00Z' },
    { id: 'c', setting_key: 'ai_config', old_value: { model: 'x' }, new_value: { model: 'y' }, changed_at: '2026-11-02T10:00:00Z' }
  ];
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_settings_history: rows }));
  const base = await listen(t);
  assert.equal((await call(base, '/api/admin/settings/history/pricing')).status, 401);
  assert.equal((await call(base, '/api/admin/settings/history/pricing', { token: 'token-alice' })).status, 403);
  const ok = await call(base, '/api/admin/settings/history/pricing', { token: 'token-admin' });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.key, 'pricing');
  assert.deepEqual(data.history.map((entry) => entry.id), ['b', 'a']);
  assert.deepEqual(data.history[0].oldValue, { standard: 400 });
  assert.deepEqual(data.history[0].newValue, { standard: 450 });
  assert.equal((await call(base, '/api/admin/settings/history/nincs-ilyen', { token: 'token-admin' })).status, 404);
});

test('the history migration logs value changes with an AFTER UPDATE trigger and keeps the table service-only', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'supabase', 'migrations', '20261126100000_system_settings_history.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.system_settings_history/);
  for (const column of ['id uuid', 'setting_key text', 'old_value jsonb', 'new_value jsonb', 'changed_at timestamptz']) assert.ok(sql.includes(column), column);
  assert.match(sql, /after update on public\.system_settings/);
  assert.match(sql, /new\.value is distinct from old\.value/);
  assert.match(sql, /alter table public\.system_settings_history enable row level security/);
  assert.match(sql, /revoke all on public\.system_settings_history from anon, authenticated/);
});

test('the real-settings SQL overwrites the model, the prompt and the templates with upserts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const sql = fs.readFileSync(path.join(dir, '20261126110000_update_real_settings.sql'), 'utf8');
  assert.match(sql, /on conflict \(key\) do update/);
  assert.match(sql, /on conflict \(id\) do update/);
  assert.match(sql, /'model', 'gemini-3\.1-pro-preview'/);
  assert.equal(sql.includes('gpt-4o'), false);
  for (const id of ['base_layout', 'payment_success', 'welcome_email', 'password_reset']) assert.ok(sql.includes(`('${id}'`), id);
  assert.ok(fs.readdirSync(dir).indexOf('20261126100000_system_settings_history.sql') < fs.readdirSync(dir).indexOf('20261126110000_update_real_settings.sql'));
});

test('POST /api/admin/orders/:orderNumber/issue-invoice issues a missing invoice once, stores the account-numbered invoice number, clears the error and records failures', async (t) => {
  const row = (extra) => ({ order_number: 'OVI-N1', session_id: 'barion_n1', user_id: null, user_email: 'vevo@example.com', plan_mode: 'standard', plan_key: 'daily', amount: 390, payment_method: 'Barion', status: 'paid', invoice_number: null, billing: { name: 'Vevő Vera' }, billing_profile: 'ev', last_error: 'Számlázás: régi hiba', last_error_at: ago(1), created_at: ago(1), ...extra });
  const orders = [row(), row({ order_number: 'OVI-N2', status: 'pending' }), row({ order_number: 'OVI-N3', invoice_number: 'ABC-1', last_error: null })];
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders }));
  const saved = process.env.SZAMLAZZ_API_KEY_EV;
  process.env.SZAMLAZZ_API_KEY_EV = 'agent-ev';
  const realFetch = global.fetch;
  const xmls = [];
  let fail = false;
  global.fetch = async (url, options) => {
    if (!String(url).includes('szamlazz.hu')) return realFetch(url, options);
    xmls.push(await options.body.get('action-xmlagentxmlfile').text());
    return fail ? new Response('', { status: 200, headers: { szlahu_error: 'Hiba+tortent', szlahu_error_code: '8' } }) : new Response(Buffer.from('%PDF-1.4 n'), { status: 200, headers: { szlahu_szamlaszam: 'E-2026-77' } });
  };
  t.after(() => { global.fetch = realFetch; if (saved === undefined) delete process.env.SZAMLAZZ_API_KEY_EV; else process.env.SZAMLAZZ_API_KEY_EV = saved; });
  const base = await listen(t);
  const issue = (number, token = 'token-admin') => call(base, `/api/admin/orders/${number}/issue-invoice`, { token, method: 'POST' });

  assert.equal((await issue('OVI-N1', null)).status, 401);
  assert.equal((await issue('OVI-N2')).status, 409, 'fizetetlen rendeléshez nincs számla');
  assert.equal((await issue('OVI-N3')).status, 409, 'meglévő számlaszám mellett nincs dupla számla');
  assert.equal((await issue('OVI-NINCS')).status, 404);
  assert.equal(xmls.length, 0);

  const ok = await issue('OVI-N1');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, invoiceNumber: 'E-2026-77' });
  assert.doesNotMatch(xmls[0], /rendelesSzam|szamlaszamElotag/i);
  assert.equal(orders[0].invoice_number, 'E-2026-77');
  assert.equal(orders[0].order_number, 'OVI-N1', 'a belső rendelésazonosító megmarad');
  assert.equal(orders[0].last_error, null, 'siker után a hibamező törlődik');
  assert.equal((await issue('OVI-N1')).status, 409, 'második kattintásra nem készül újabb számla');
  assert.equal(xmls.length, 1);

  orders.push(row({ order_number: 'OVI-N4', last_error: null }));
  fail = true;
  const failed = await issue('OVI-N4');
  assert.equal(failed.status, 424);
  assert.match((await failed.json()).error, /Hiba tortent/);
  assert.match(orders[3].last_error, /^Számlázás: .*Hiba tortent/);
  assert.equal(orders[3].status, 'paid', 'a rendelés fizetett marad');
  assert.ok(orders[3].last_error_at);
  const listed = await (await call(base, '/api/admin/orders', { token: 'token-admin' })).json();
  assert.equal(listed.failedCount, 1);
  assert.match(listed.orders.find((o) => o.orderNumber === 'OVI-N4').lastError, /Hiba tortent/);
});

test('GET /api/admin/orders still lists orders when the last_error columns are not migrated yet', async (t) => {
  const row = { order_number: 'OVI-M1', user_id: null, user_email: 'v@example.com', plan_key: 'daily', amount: 390, status: 'paid', invoice_number: null, created_at: ago(1) };
  const fake = fakeAdmin({ profiles: adminProfiles(), orders: [row] });
  const guarded = { ...fake, from(table) {
    const builder = fake.from(table);
    if (table !== 'orders') return builder;
    return { ...builder, select(columns) { return String(columns).includes('last_error') ? { range: async () => ({ data: null, error: { message: 'column orders.last_error does not exist' } }), eq() { return this; }, order() { return this; } } : builder.select(columns); } };
  } };
  useAdminEnv(t, guarded);
  const base = await listen(t);
  const response = await call(base, '/api/admin/orders', { token: 'token-admin' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].lastError, '');
});

test('GET /api/admin/orders/:orderNumber/invoice streams the live Számlázz.hu PDF for paid orders only and stores nothing', async (t) => {
  const row = (extra) => ({ order_number: 'OVI-I1', session_id: 'barion_i1', user_id: null, user_email: 'vevo@example.com', plan_mode: 'standard', plan_key: 'daily', amount: 390, payment_method: 'Barion', status: 'paid', invoice_number: 'OVITE-2026-9', billing_profile: 'ev', created_at: ago(1), ...extra });
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [row(), row({ order_number: 'OVI-I2', status: 'pending', invoice_number: null }), row({ order_number: 'OVI-I3', invoice_number: null })] }));
  const saved = process.env.SZAMLAZZ_API_KEY_EV;
  process.env.SZAMLAZZ_API_KEY_EV = 'agent-ev';
  const realFetch = global.fetch;
  let pdfCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('szamlazz.hu')) { pdfCalls += 1; return new Response(Buffer.from('%PDF-1.4 admin'), { status: 200 }); }
    return realFetch(url, options);
  };
  t.after(() => { global.fetch = realFetch; if (saved === undefined) delete process.env.SZAMLAZZ_API_KEY_EV; else process.env.SZAMLAZZ_API_KEY_EV = saved; });
  const base = await listen(t);

  const ok = await call(base, '/api/admin/orders/OVI-I1/invoice', { token: 'token-admin' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.match(ok.headers.get('content-disposition'), /OVITE-2026-9\.pdf/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), '%PDF-1.4 admin');
  assert.equal(pdfCalls, 1);
  assert.equal((await call(base, '/api/admin/orders/OVI-I2/invoice', { token: 'token-admin' })).status, 409);
  assert.equal((await call(base, '/api/admin/orders/OVI-I3/invoice', { token: 'token-admin' })).status, 409, 'számlaszám nélkül nincs letöltés');
  assert.equal((await call(base, '/api/admin/orders/OVI-NINCS/invoice', { token: 'token-admin' })).status, 404);
  assert.equal((await call(base, '/api/admin/orders/OVI-I1/invoice')).status, 401);
  assert.equal(pdfCalls, 1);
});

test('admin.html: the settings tab has four prices, cap, announcement bar, external links, and the template list has the feedback request', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'admin.html'), 'utf8');
  for (const id of ['setPriceDaily', 'setPriceWeekly', 'setPriceAcademicDaily', 'setPriceAcademicWeekly', 'setDailyCap', 'setAnnouncementEnabled', 'setAnnouncementText', 'setLinkCloudflare', 'setLinkGoogleAnalytics', 'setLinkSearchConsole', 'setLinkBarion', 'setLinkSzamlazz', 'tabNewsletter', 'panelNewsletter']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const key of ['daily_generation_cap', 'announcement_bar', 'external_links']) assert.ok(html.includes(`value="${key}"`), `${key} előzmény`);
  assert.ok(html.includes('value="feedback_request"') && html.includes('value="payment_success"'));
});

test('admin.js: the settings form saves four prices, the cap and the announcement; the links form saves only https URLs and refreshes the toolbar', async (t) => {
  const settings = { maintenance_mode: false, pricing: { daily: 390, weekly: 890, academic_daily: 690, academic_weekly: 690 }, daily_generation_cap: 250, announcement_bar: { enabled: false, text: '' }, seasonal_hints: [], ai_config: { model: 'gemini-3.1-pro-preview', system_prompt: 'x' }, billing_profile: 'ev', payment_provider: 'barion', external_links: { cloudflare: '', google_analytics: '', search_console: '', barion: '', szamlazz: '' } };
  const patches = [];
  const { document } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/billing-status': () => [{ success: true, status: { modes: { barion: 'test', szamlazz: 'sandbox', stripe: 'live' }, profiles: { ev: { szamlazzApiKey: true, barionPosKey: true, stripeSecret: true, stripePublishable: true, stripeWebhook: true }, kft: { szamlazzApiKey: false, barionPosKey: false, stripeSecret: false, stripePublishable: false, stripeWebhook: false } } } }],
      '/api/admin/settings': (method, body) => {
        if (method === 'PATCH') { patches.push(body); return [{ success: true, settings: { ...settings, ...body } }]; }
        return [{ success: true, settings, dailyGeneration: { day: 'x', count: 3, cap: 250, source: 'settings' } }];
      }
    }
  });
  assert.equal(document.getElementById('adminTools').hidden, true, 'link nélkül a sáv rejtett');
  document.getElementById('tabSettings').click();
  await tick();
  assert.equal(document.getElementById('setPriceAcademicDaily').value, '690');
  assert.equal(document.getElementById('setDailyCap').value, '250');
  assert.match(document.getElementById('dailyCapInfo').textContent, /3 generálás \/ 250/);
  assert.equal(document.querySelectorAll('#billingStatusList .admin-status-card').length, 6);
  assert.match(document.getElementById('billingStatusList').textContent, /Supabase adatbázis\s*HIÁNYZIK/);

  document.getElementById('setPriceDaily').value = '400';
  document.getElementById('setDailyCap').value = '300';
  document.getElementById('setAnnouncementEnabled').checked = true;
  document.getElementById('setAnnouncementText').value = 'Akció!';
  document.getElementById('generalForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.deepEqual(patches[0].pricing, { daily: 400, weekly: 890, academic_daily: 690, academic_weekly: 690 });
  assert.equal(patches[0].daily_generation_cap, 300);
  assert.deepEqual(patches[0].announcement_bar, { enabled: true, text: 'Akció!' });

  document.getElementById('setLinkBarion').value = 'https://secure.barion.com/';
  document.getElementById('linksForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.equal(patches[1].external_links.barion, 'https://secure.barion.com/');
  const anchors = document.querySelectorAll('.admin-tools-list a[target="_blank"][rel~="noopener"]');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'https://secure.barion.com/');
  assert.equal(document.getElementById('adminTools').hidden, false);

  assert.match(document.getElementById('notificationEffective').textContent, /környezeti változók/);
  document.getElementById('setNotificationEmail').value = ' ops@example.com ';
  document.getElementById('notificationForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.deepEqual(patches[2], { notification_email: 'ops@example.com' });
  document.getElementById('setBillingNotificationEmail').value = ' bill@example.com ';
  document.getElementById('setErrorNotificationEmail').value = 'err@example.com';
  document.getElementById('notificationSplitForm').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await tick();
  assert.deepEqual(patches[3], { billing_notification_email: 'bill@example.com', error_notification_email: 'err@example.com' });
});

function mailEnv(t) {
  const saved = { SMTP_HOST: process.env.SMTP_HOST, SZAMLAZZ_API_KEY_EV: process.env.SZAMLAZZ_API_KEY_EV };
  process.env.SMTP_HOST = 'smtp.invalid.example';
  process.env.SZAMLAZZ_API_KEY_EV = 'agent-ev';
  const realFetch = global.fetch;
  global.fetch = async (url, options) => (String(url).includes('szamlazz.hu') ? new Response(Buffer.from('%PDF-1.4 x'), { status: 200 }) : realFetch(url, options));
  t.after(() => { global.fetch = realFetch; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

const packageOrder = (extra) => ({ order_number: 'OVI-P1', session_id: 'barion_p1', user_id: null, user_email: 'vevo@example.com', document_id: 'gen_p', plan_mode: 'standard', plan_key: 'daily', amount: 390, payment_method: 'Barion', status: 'paid', invoice_number: 'OVITE-2026-5', billing_profile: 'ev', delivery_count: 1, created_at: ago(1), ...extra });
const storedPlan = (id) => ({ document_id: id, unlocked: true, data: { plan: { ...makePlan(), request: makePayload(), generationId: id }, meta: {} } });

test('the package resend works from an empty planStore memory, and a 0 Ft coupon order gets the package without an invoice', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [packageOrder(), packageOrder({ order_number: 'OVI-P0', document_id: 'gen_free', amount: 0, invoice_number: null })], documents: [storedPlan('gen_p'), storedPlan('gen_free')] }));
  mailEnv(t);
  planStore.clearPlans();
  const base = await listen(t);
  mailService.mockOutbox.length = 0;

  const paid = await (await call(base, '/api/admin/orders/OVI-P1/resend', { token: 'token-admin', method: 'POST' })).json();
  assert.deepEqual([paid.sent, paid.invoiceAttached, paid.attachmentCount, paid.template], [true, true, 2, 'payment_success']);
  assert.ok(planStore.hasPlan('gen_p'), 'a terv a documents táblából visszatöltődött');

  planStore.clearPlans();
  const free = await (await call(base, '/api/admin/orders/OVI-P0/resend', { token: 'token-admin', method: 'POST' })).json();
  assert.deepEqual([free.sent, free.invoiceAttached, free.attachmentCount], [true, false, 2]);
  assert.deepEqual(mailService.mockOutbox.map((mail) => mail.attachments), [['ovi-kreta-terv.pdf', 'ovi-kreta-terv.docx', 'OVITE-2026-5.pdf', 'ovitervezo-logo.png'], ['ovi-kreta-terv.pdf', 'ovi-kreta-terv.docx', 'ovitervezo-logo.png']]);
});

test('the package resend never silently falls back to an invoice-only mail when the stored plan is missing', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [packageOrder({ document_id: 'gen_nincs' }), packageOrder({ order_number: 'OVI-P2', document_id: null })], documents: [] }));
  mailEnv(t);
  planStore.clearPlans();
  const base = await listen(t);
  mailService.mockOutbox.length = 0;
  for (const number of ['OVI-P1', 'OVI-P2']) {
    const response = await call(base, `/api/admin/orders/${number}/resend`, { token: 'token-admin', method: 'POST' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'A rendeléshez tartozó tervezet nem található az adatbázisban, csak a számla küldhető ki.');
  }
  assert.equal(mailService.mockOutbox.length, 0);
});

test('the weekly package is re-built as a single ZIP', async (t) => {
  const weekly = { ...makePlan(), is_weekly: true, heti_keretterv: { tema: 'Erdő', teruletek_heti_eloszlasa: [] }, napok: ['Hétfő', 'Kedd'].map((nap_neve) => ({ nap_neve, kidolgozas_tablazat: makePlan().kidolgozas_tablazat })), request: makePayload({ duration: 'Heti' }), generationId: 'gen_w' };
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [packageOrder({ document_id: 'gen_w', plan_key: 'weekly_detailed' })], documents: [{ document_id: 'gen_w', unlocked: true, data: { plan: weekly, meta: {} } }] }));
  mailEnv(t);
  planStore.clearPlans();
  const base = await listen(t);
  mailService.mockOutbox.length = 0;
  const response = await call(base, '/api/admin/orders/OVI-P1/resend', { token: 'token-admin', method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(mailService.mockOutbox[0].attachments, ['OviTervezo_heti_csomag.zip', 'OVITE-2026-5.pdf', 'ovitervezo-logo.png']);
});

test('POST /api/admin/orders/:orderNumber/send-invoice sends only the invoice PDF with invoice_only, an explicit template, or errors clearly', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: [packageOrder(), packageOrder({ order_number: 'OVI-P3', invoice_number: null })], documents: [storedPlan('gen_p')] }));
  mailEnv(t);
  const base = await listen(t);
  mailService.mockOutbox.length = 0;
  const post = (number, body) => call(base, `/api/admin/orders/${number}/send-invoice`, { token: 'token-admin', method: 'POST', body });

  const plain = await (await post('OVI-P1', {})).json();
  assert.deepEqual([plain.sent, plain.attachmentCount, plain.template], [true, 0, 'invoice_only']);
  assert.deepEqual(mailService.mockOutbox[0].attachments, ['OVITE-2026-5.pdf', 'ovitervezo-logo.png']);
  assert.match(mailService.mockOutbox[0].subject, /Számlája elkészült – OviTervező \(OVITE-2026-5\)/);

  assert.equal((await post('OVI-P1', { templateId: 'nincs_ilyen' })).status, 404);
  assert.equal((await post('OVI-P3', {})).status, 409, 'számla nélküli rendeléshez nincs számlaküldés');
  assert.equal((await call(base, '/api/admin/orders/OVI-P1/send-invoice', { method: 'POST' })).status, 401);
});

test('the admin e-mail template routes create, preview, delete and reset templates', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const base = await listen(t);
  const send = (route, method, body) => call(base, `/api/admin/email-templates${route}`, { token: 'token-admin', method, body });
  const fresh = { id: 'husvet_level', name: 'Húsvéti levél', subject: 'Boldog húsvétot!', bodyHtml: '<p>Szia {{topic}}</p>' };

  const created = await send('', 'POST', fresh);
  assert.equal(created.status, 201);
  assert.equal((await send('', 'POST', { ...fresh, id: 'Rossz Id' })).status, 400);
  assert.equal((await send('', 'POST', { ...fresh, id: 'invoice_only' })).status, 409);
  assert.ok(client.db.email_templates.some((row) => row.id === 'husvet_level'));

  const preview = await send('/preview', 'POST', { id: 'husvet_level', subject: fresh.subject, bodyHtml: fresh.bodyHtml });
  assert.equal(preview.status, 200);
  assert.match(JSON.stringify(await preview.json()), /Szia/);

  assert.equal((await send('/invoice_only', 'DELETE')).status, 409, 'rendszersablon nem törölhető');
  assert.equal((await send('/nincs_ilyen', 'DELETE')).status, 404);
  assert.equal((await send('/husvet_level', 'DELETE')).status, 200);
  assert.equal(client.db.email_templates.some((row) => row.id === 'husvet_level'), false);

  const reset = await send('/invoice_only/reset', 'POST');
  assert.equal(reset.status, 200);
  assert.equal((await send('/base_layout/reset', 'POST')).status, 409);
  assert.equal((await call(base, '/api/admin/email-templates/invoice_only', { method: 'DELETE' })).status, 401);
});

// ---------- Szerveroldali lapozás, szűrők és audit napló ----------

const bulkOrder = (n, extra = {}) => ({
  order_number: `OVI-${String(n).padStart(3, '0')}`, user_id: null, user_email: `vevo${n}@example.com`, document_id: `gen_${n}`, plan_mode: 'standard', plan_key: 'daily', amount: 390,
  coupon_code: null, payment_method: 'Barion', status: 'paid', invoice_number: `OVITE-${n}`, title: `Téma ${n}`, billing: { name: `Vevő ${n}` }, created_at: ago(n), ...extra
});

test('GET /api/admin/orders paginates on the server with total, page count and validated page size', async (t) => {
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: Array.from({ length: 45 }, (_, i) => bulkOrder(i + 1)) }));
  const base = await listen(t);
  const get = async (query = '') => (await call(base, `/api/admin/orders${query}`, { token: 'token-admin' })).json();
  const first = await get();
  assert.deepEqual({ total: first.total, page: first.page, pageSize: first.pageSize, totalPages: first.totalPages, rows: first.orders.length }, { total: 45, page: 1, pageSize: 20, totalPages: 3, rows: 20 });
  assert.equal(first.orders[0].orderNumber, 'OVI-001', 'legújabb elöl');
  const last = await get('?page=3');
  assert.deepEqual({ page: last.page, rows: last.orders.length, first: last.orders[0].orderNumber }, { page: 3, rows: 5, first: 'OVI-041' });
  assert.equal((await get('?pageSize=50')).orders.length, 45);
  assert.equal((await get('?page=99')).page, 3, 'a túlzott oldalszám az utolsó oldalra igazodik');
  assert.equal((await call(base, '/api/admin/orders?pageSize=7', { token: 'token-admin' })).status, 400);
  assert.equal((await call(base, '/api/admin/orders?dateFrom=nem-datum', { token: 'token-admin' })).status, 400);
});

test('GET /api/admin/orders filters by period, type and per-column search combined', async (t) => {
  const rows = [
    bulkOrder(1, { payment_method: 'Barion', coupon_code: null, title: 'Őszi erdő', user_email: 'anna@example.com', billing: { name: 'Kiss Anna' }, amount: 390 }),
    bulkOrder(2, { payment_method: 'Stripe', status: 'paid', invoice_number: null, amount: 890, title: 'Tavaszi rét' }),
    bulkOrder(3, { payment_method: 'Kupon', amount: 0, coupon_code: 'NYAR100', invoice_number: null, title: 'Nyári játék' }),
    bulkOrder(4, { status: 'pending', invoice_number: null, title: 'Téli ünnep' }),
    bulkOrder(5, { last_error: 'Számlázás: hiba', invoice_number: null, created_at: ago(40) })
  ];
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), orders: rows }));
  const base = await listen(t);
  const numbers = async (query) => (await (await call(base, `/api/admin/orders?${query}`, { token: 'token-admin' })).json()).orders.map((o) => o.orderNumber);
  assert.deepEqual(await numbers('paymentMethod=Stripe'), ['OVI-002']);
  assert.deepEqual(await numbers('paymentMethod=Kupon'), ['OVI-003']);
  assert.deepEqual(await numbers('invoice=has'), ['OVI-001']);
  assert.deepEqual((await numbers('invoice=missing')).sort(), ['OVI-002', 'OVI-005'], 'fizetett >0 Ft számla nélkül + hibás; a 0 Ft-os kupon nem hiányos');
  assert.deepEqual(await numbers('invoice=error'), ['OVI-005']);
  assert.deepEqual(await numbers(`dateFrom=${ago(10).slice(0, 10)}`), ['OVI-001', 'OVI-002', 'OVI-003', 'OVI-004']);
  assert.deepEqual(await numbers(`dateTo=${ago(20).slice(0, 10)}`), ['OVI-005']);
  assert.deepEqual(await numbers('orderNumber=004'), ['OVI-004']);
  assert.deepEqual(await numbers('customer=kiss'), ['OVI-001']);
  assert.deepEqual(await numbers('customer=ANNA@'), ['OVI-001']);
  assert.deepEqual(await numbers('topic=tavaszi'), ['OVI-002']);
  assert.deepEqual(await numbers('amount=890'), ['OVI-002']);
  assert.deepEqual(await numbers('coupon=nyar'), ['OVI-003']);
  assert.deepEqual(await numbers('invoiceNumber=OVITE-1'), ['OVI-001']);
  assert.deepEqual(await numbers('status=paid&paymentMethod=Barion&topic=erdő'), ['OVI-001'], 'a szűrők együtt érvényesülnek');
  assert.deepEqual(await numbers('topic=nincs-ilyen'), []);
  const data = await (await call(base, '/api/admin/orders?status=pending', { token: 'token-admin' })).json();
  assert.equal(data.failed.length, 0);
  const all = await (await call(base, '/api/admin/orders', { token: 'token-admin' })).json();
  assert.deepEqual(all.failed, [{ orderNumber: 'OVI-005', lastError: 'Számlázás: hiba' }]);
});

test('GET /api/admin/users paginates and filters by role, newsletter, purchases, period and columns', async (t) => {
  const tables = statsTables();
  tables.profiles = tables.profiles.map((p) => (p.id === ALICE.id ? { ...p, full_name: 'Alice Kiss', kindergarten_name: 'Napsugár Óvoda', group_name: 'Méhecske', billing_tax_id: '12345678-1-42' } : p));
  tables.orders = [{ order_number: 'U1', user_id: ALICE.id, user_email: 'alice@example.com', amount: 390, status: 'paid', created_at: ago(2) }, { order_number: 'U2', user_id: null, user_email: 'carol@example.com', amount: 390, status: 'pending', created_at: ago(2) }];
  useAdminEnv(t, fakeAdmin(tables));
  const base = await listen(t);
  const get = async (query = '') => (await call(base, `/api/admin/users?${query}`, { token: 'token-admin' })).json();
  const emails = async (query) => (await get(query)).users.map((u) => u.email).sort();
  const everyone = await get();
  assert.deepEqual({ total: everyone.total, page: everyone.page, totalPages: everyone.totalPages, subscriberCount: everyone.subscriberCount }, { total: 5, page: 1, totalPages: 1, subscriberCount: 2 });
  assert.equal((await get('page=2')).page, 1, 'a túlzott oldalszám az utolsó oldalra igazodik');
  assert.deepEqual(await emails('role=admin'), ['admin@example.com', 'alice@example.com']);
  assert.equal((await emails('role=user')).length, 3);
  assert.deepEqual(await emails('newsletter=not'), ['admin@example.com', 'bob@example.com']);
  assert.deepEqual(await emails('hasOrders=yes'), ['alice@example.com'], 'csak a fizetett rendelés számít vásárlásnak');
  assert.equal((await emails('hasOrders=no')).length, 4);
  assert.deepEqual(await emails('kindergarten=napsugár'), ['alice@example.com']);
  assert.deepEqual(await emails('group=méhecske'), ['alice@example.com']);
  assert.deepEqual(await emails('billing=12345678'), ['alice@example.com']);
  assert.deepEqual(await emails('name=alice&email=alice@'), ['alice@example.com']);
  assert.deepEqual(await emails(`dateFrom=${ago(1).slice(0, 10)}`), []);
  assert.equal((await call(base, '/api/admin/users?role=root', { token: 'token-admin' })).status, 400);
  assert.equal(everyone.users.find((u) => u.email === 'alice@example.com').role, 'admin');
});

test('GET /api/admin/logs filters by level, category, period and columns on the database side with a total count', async (t) => {
  const log = (i, extra) => ({ id: `l${i}`, level: 'info', context: 'ai_generation', message: `üzenet ${i}`, user_email: null, created_at: new Date(Date.UTC(2026, 2, 1 + i, 10, 0)).toISOString(), ...extra });
  const rows = [log(0), log(1, { level: 'error', context: 'barion_payment', user_email: 'vevo@example.com', message: 'Eltérő összeg' }), log(2, { level: 'warning', context: 'invoice' }), log(3, { context: 'admin_settings' }), log(4, { context: 'guest_claim' })];
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_logs: rows }));
  const base = await listen(t);
  const get = async (query) => (await call(base, `/api/admin/logs?${query}`, { token: 'token-admin' })).json();
  const ids = async (query) => (await get(query)).logs.map((l) => l.id).sort();
  assert.deepEqual(await ids('level=error'), ['l1']);
  assert.deepEqual(await ids('level=warn'), ['l2']);
  assert.deepEqual(await ids('category=payment'), ['l1']);
  assert.deepEqual(await ids('category=invoice'), ['l2']);
  assert.deepEqual(await ids('category=ai'), ['l0']);
  assert.deepEqual(await ids('category=settings'), ['l3']);
  assert.deepEqual(await ids('category=auth'), ['l4']);
  assert.deepEqual(await ids('time=2026-03-03'), ['l2']);
  assert.deepEqual(await ids('time=2026-03'), ['l0', 'l1', 'l2', 'l3', 'l4']);
  assert.deepEqual(await ids('dateFrom=2026-03-04&dateTo=2026-03-05'), ['l3', 'l4']);
  assert.deepEqual(await ids('email=VEVO@'), ['l1']);
  assert.deepEqual(await ids('message=összeg'), ['l1']);
  assert.deepEqual(await ids('context=barion'), ['l1']);
  assert.deepEqual(await ids('level=info&category=ai'), ['l0']);
  const small = await get('pageSize=20');
  assert.equal(small.total, 5);
  for (const bad of ['level=fatal', 'category=x', 'time=tegnap', 'pageSize=500']) assert.equal((await call(base, `/api/admin/logs?${bad}`, { token: 'token-admin' })).status, 400, bad);
  const paged = [];
  useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_logs: Array.from({ length: 130 }, (_, i) => log(i % 28, { id: `p${i}` })) }));
  const page2 = await (await call(base, '/api/admin/logs?pageSize=50&page=2', { token: 'token-admin' })).json();
  paged.push(page2.logs.length, page2.total, page2.totalPages);
  assert.deepEqual(paged, [50, 130, 3]);
});

test('settings and e-mail template changes are audited with who, when, old and new value, and secrets are masked', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles(), system_settings_history: [] }));
  const base = await listen(t);
  const send = (path, method, body) => call(base, `/api/admin/${path}`, { token: 'token-admin', method, body });
  assert.equal((await send('settings', 'PATCH', { announcement_bar: { enabled: true, text: 'Nyári szünet' } })).status, 200);
  const stored = client.db.system_settings.find((row) => row.key === 'announcement_bar');
  assert.equal(String(stored.updated_by).toLowerCase(), 'admin@example.com', 'a módosító admin e-mailje az updated_by-ba kerül (a trigger ebből tölti a changed_by-t)');

  const created = await send('email-templates', 'POST', { id: 'audit_demo', name: 'Audit teszt', subject: 'Régi tárgy', bodyHtml: '<p>Régi törzs {{topic}}</p>' });
  assert.equal(created.status, 201);
  assert.equal((await send('email-templates/audit_demo', 'PATCH', { name: 'Audit teszt', subject: 'Új tárgy', bodyHtml: '<p>Új törzs {{topic}}</p>' })).status, 200);
  assert.equal((await send('email-templates/audit_demo', 'DELETE')).status, 200);

  const rows = client.db.system_settings_history.filter((row) => row.setting_key === 'email_template:audit_demo');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].old_value, null);
  assert.equal(rows[0].new_value.subject, 'Régi tárgy');
  assert.deepEqual({ old: rows[1].old_value.subject, next: rows[1].new_value.subject }, { old: 'Régi tárgy', next: 'Új tárgy' });
  assert.equal(rows[2].new_value, null);
  assert.ok(rows.every((row) => String(row.changed_by).toLowerCase() === 'admin@example.com'));

  client.db.system_settings_history.push({ id: 'h-secret', setting_key: 'external_links', old_value: { api_key: 'titok-1', url: 'https://a.example' }, new_value: { api_key: 'titok-2', url: 'https://b.example' }, changed_at: new Date().toISOString(), changed_by: 'admin@example.com' });
  const audit = await (await call(base, '/api/admin/audit?pageSize=100', { token: 'token-admin' })).json();
  assert.equal(audit.total, 4);
  const secret = audit.entries.find((entry) => entry.id === 'h-secret');
  assert.equal(secret.label, 'Külső eszközök linkjei');
  assert.equal(secret.newValue.url, 'https://b.example');
  assert.equal(JSON.stringify(audit).includes('titok'), false, 'a titkos nevű mezők maszkolva');
  const tpl = audit.entries.find((entry) => entry.key === 'email_template:audit_demo');
  assert.equal(tpl.label, 'E-mail sablon: audit_demo');
  assert.equal(tpl.kind, 'template');

  const ids = async (query) => (await (await call(base, `/api/admin/audit?${query}`, { token: 'token-admin' })).json()).entries.map((e) => e.key);
  assert.deepEqual(await ids('type=setting'), ['external_links']);
  assert.equal((await ids('type=template')).length, 3);
  assert.deepEqual(await ids('setting=külső'), ['external_links']);
  assert.equal((await ids('changedBy=ADMIN@')).length, 4);
  assert.deepEqual(await ids('changedBy=senki'), []);
  assert.equal((await call(base, '/api/admin/audit', { token: 'token-bob' })).status, 403);
  assert.equal((await call(base, '/api/admin/audit?type=x', { token: 'token-admin' })).status, 400);
});

test('settings are saved even before the audit migration adds updated_by', async (t) => {
  const client = useAdminEnv(t, fakeAdmin({ profiles: adminProfiles() }));
  const original = client.from;
  client.from = (name) => {
    const builder = original(name);
    const upsert = builder.upsert;
    builder.upsert = (row, options) => (name === 'system_settings' && [].concat(row).some((item) => 'updated_by' in item)
      ? Promise.resolve({ data: null, error: { code: '42703', message: 'column "updated_by" of relation "system_settings" does not exist' } })
      : upsert(row, options));
    return builder;
  };
  const base = await listen(t);
  const response = await call(base, '/api/admin/settings', { token: 'token-admin', method: 'PATCH', body: { maintenance_mode: true } });
  assert.equal(response.status, 200);
  assert.equal(client.db.system_settings.find((row) => row.key === 'maintenance_mode').value, true);
});

test('the audit migration adds the actor columns and keeps the history trigger idempotent', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261203090000_settings_audit_log.sql'), 'utf8');
  assert.match(sql, /add column if not exists updated_by text/);
  assert.match(sql, /add column if not exists changed_by text/);
  assert.match(sql, /drop trigger if exists system_settings_history_trigger/);
  assert.match(sql, /create or replace function public\.log_system_settings_change/);
});

// ---------- Admin felület: oldalsáv, lapozó, szűrők ----------

test('admin.html has a left sidebar with every tab, a collapsible external tools block and per-column filters', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'admin.html'), 'utf8');
  const sidebar = html.slice(html.indexOf('id="adminSidebar"'), html.indexOf('</aside>'));
  for (const tab of ['overview', 'coupons', 'orders', 'users', 'newsletter', 'logs', 'settings']) assert.ok(sidebar.includes(`data-admin-tab="${tab}"`), tab);
  assert.match(sidebar, /<details class="admin-tools" id="adminTools"/);
  assert.match(html, /id="adminMenuToggle"/);
  assert.match(html, /Beállítások változásai \(Audit napló\)/);
  for (const list of ['orders', 'users', 'logs', 'audit']) {
    assert.ok(html.includes(`data-list="${list}" data-pager`), `${list} lapozó`);
    assert.ok(html.includes(`data-list="${list}" data-clear`), `${list} szűrők törlése`);
    assert.ok(html.includes(`id="${list}PageSize"`), `${list} oldalméret`);
  }
  assert.equal((html.match(/class="admin-filter-row"/g) || []).length, 4, 'minden táblázat fejléce alatt szűrősor');
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.admin-sidebar \{ position: fixed/);
});

test('admin.js: the mobile drawer opens from the hamburger button and closes on selection, backdrop and Escape', async (t) => {
  const { document, window } = await loadPage(t, { routes: { '/api/admin/me': ME, '/api/admin/stats': () => [STATS] } });
  const sidebar = document.getElementById('adminSidebar');
  const toggle = document.getElementById('adminMenuToggle');
  toggle.click();
  assert.ok(sidebar.classList.contains('is-open'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(document.getElementById('adminBackdrop').hidden, false);
  document.getElementById('adminBackdrop').click();
  assert.equal(sidebar.classList.contains('is-open'), false);
  toggle.click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(sidebar.classList.contains('is-open'), false);
  toggle.click();
  document.getElementById('tabCoupons').click();
  assert.equal(sidebar.classList.contains('is-open'), false);
  assert.equal(document.getElementById('adminMobileTitle').textContent, 'Kuponkezelő');
  await tick();
});

test('admin.js: orders table shows pager, page size, debounced column search, quick period buttons and clear filters', async (t) => {
  const all = Array.from({ length: 45 }, (_, i) => ({ orderNumber: `OVI-${i + 1}`, createdAt: ago(i), email: `v${i}@example.com`, name: '', topic: `Téma ${i + 1}`, planKey: 'daily', amount: 390, couponCode: '', paymentMethod: 'Barion', status: 'paid', invoiceNumber: `E-${i + 1}`, lastError: '', documentId: `g${i}` }));
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/orders': (_method, _body, params) => {
        const size = Number(params.get('pageSize'));
        const topic = params.get('topic');
        const rows = all.filter((o) => !topic || o.topic.toLowerCase().includes(topic.toLowerCase()));
        const totalPages = Math.max(1, Math.ceil(rows.length / size));
        const page = Math.min(Number(params.get('page')) || 1, totalPages);
        return [{ success: true, truncated: false, failedCount: 0, failed: [], orders: rows.slice((page - 1) * size, page * size), total: rows.length, page, pageSize: size, totalPages }];
      }
    }
  });
  document.getElementById('tabOrders').click();
  await tick();
  const rowCount = () => document.querySelectorAll('#ordersTable tbody tr').length;
  assert.equal(rowCount(), 20);
  assert.match(document.getElementById('ordersCount').textContent, /45 rendelés/);
  const pager = document.querySelector('[data-list="orders"][data-pager]');
  assert.match(pager.textContent, /45 találat · 1\. \/ 3 oldal/);
  const labels = [...pager.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual([labels[0], labels[1], labels.at(-2), labels.at(-1)], ['« Első', '‹ Előző', 'Következő ›', 'Utolsó »']);
  assert.equal(pager.querySelector('button[data-page="1"]').disabled, true);

  pager.querySelector('button[data-page="3"]:not([aria-current])').click();
  await tick();
  assert.match(state.fetches.at(-1).query, /page=3/);
  assert.equal(rowCount(), 5);
  assert.equal([...document.querySelectorAll('[data-list="orders"][data-pager] button')].find((b) => b.textContent === 'Következő ›').disabled, true);

  const size = document.getElementById('ordersPageSize');
  size.value = '50';
  size.dispatchEvent(new window.Event('change'));
  await tick();
  assert.match(state.fetches.at(-1).query, /pageSize=50/);
  assert.match(state.fetches.at(-1).query, /page=1/);
  assert.equal(rowCount(), 45);

  const before = state.fetches.length;
  const topic = document.querySelector('[data-list="orders"][data-filter="topic"]');
  topic.value = 'Téma 4';
  topic.dispatchEvent(new window.Event('input'));
  topic.value = 'Téma 45';
  topic.dispatchEvent(new window.Event('input'));
  await tick(150);
  assert.equal(state.fetches.length, before, '350 ms előtt nincs lekérdezés');
  await tick(400);
  assert.equal(state.fetches.length, before + 1, 'a gépelés egyetlen lekérdezéssé összevonva');
  assert.match(state.fetches.at(-1).query, /topic=T%C3%A9ma\+45|topic=T%C3%A9ma%2045/);
  assert.equal(rowCount(), 1);

  document.querySelector('[data-list="orders"][data-range="7"]').click();
  await tick();
  assert.match(state.fetches.at(-1).query, /dateFrom=\d{4}-\d{2}-\d{2}/);
  assert.match(state.fetches.at(-1).query, /dateTo=\d{4}-\d{2}-\d{2}/);
  document.querySelector('[data-list="orders"][data-range="all"]').click();
  await tick();
  assert.doesNotMatch(state.fetches.at(-1).query, /dateFrom/);

  document.querySelector('[data-list="orders"][data-clear]').click();
  await tick();
  assert.equal(topic.value, '');
  assert.doesNotMatch(state.fetches.at(-1).query, /topic=/);
  assert.equal(rowCount(), 45);
});

test('admin.js: the audit sub-tab lists who changed what, with collapsible long values and masked secrets', async (t) => {
  const prompt = 'Hosszú AI prompt '.repeat(20);
  const { document, window, state } = await loadPage(t, {
    routes: {
      '/api/admin/me': ME,
      '/api/admin/stats': () => [STATS],
      '/api/admin/logs': () => [{ success: true, logs: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }],
      '/api/admin/audit': () => [{ success: true, total: 2, page: 1, pageSize: 20, totalPages: 1, entries: [
        { id: 'a1', key: 'ai_config', label: 'AI beállítások (modell és prompt)', kind: 'setting', changedAt: ago(1), changedBy: 'admin@example.com', oldValue: { system_prompt: 'régi' }, newValue: { system_prompt: prompt } },
        { id: 'a2', key: 'maintenance_mode', label: 'Karbantartási mód', kind: 'setting', changedAt: ago(2), changedBy: '', oldValue: false, newValue: true }
      ] }]
    }
  });
  document.getElementById('tabLogs').click();
  await tick();
  document.getElementById('logsTabAudit').click();
  await tick();
  assert.equal(document.querySelector('[data-logs-panel="audit"]').hidden, false);
  assert.equal(document.querySelector('[data-logs-panel="system"]').hidden, true);
  const rows = document.querySelectorAll('#auditTable tbody tr');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /admin@example\.com/);
  assert.match(rows[0].textContent, /AI beállítások/);
  assert.ok(rows[0].querySelectorAll('details').length >= 1, 'a hosszú érték összecsukható');
  const [oldArea, newArea] = rows[0].querySelectorAll('textarea');
  assert.ok(oldArea.value.includes('régi'));
  assert.ok(newArea.value.includes('Hosszú AI prompt'));
  assert.match(rows[1].textContent, /false/);
  assert.match(rows[1].textContent, /true/);
  const who = document.querySelector('[data-list="audit"][data-filter="changedBy"]');
  who.value = 'admin';
  who.dispatchEvent(new window.Event('input'));
  await tick(450);
  assert.match(state.fetches.at(-1).query, /changedBy=admin/);
});
