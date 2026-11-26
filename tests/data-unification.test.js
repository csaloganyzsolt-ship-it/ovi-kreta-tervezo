const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const supabase = require('../backend/services/supabaseService');
const orders = require('../backend/services/orderService');
const planStore = require('../backend/services/planStore');
const profileService = require('../backend/services/profileService');
const { normalizeEmail } = require('../backend/utils/email');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

// Minimális, táblaalapú Supabase kliens a vendég-összekapcsolás és a hírlevél vizsgálatához.
function fakeDb(tables) {
  return {
    tables,
    from(name) {
      const filters = [];
      let patch = null;
      let max = Infinity;
      let sort = null;
      const run = () => {
        let rows = tables[name].filter((row) => filters.every((matches) => matches(row)));
        if (patch) rows.forEach((row) => Object.assign(row, patch));
        if (sort) rows = [...rows].sort((a, b) => (sort.ascending ? 1 : -1) * String(a[sort.column]).localeCompare(String(b[sort.column])));
        return { data: rows.slice(0, max).map((row) => ({ ...row })), error: null };
      };
      const builder = {
        select() { return builder; },
        update(values) { patch = values; return builder; },
        eq(column, value) { filters.push((row) => row[column] === value); return builder; },
        is(column, value) { filters.push((row) => (row[column] ?? null) === value); return builder; },
        not(column, op, value) { filters.push((row) => (row[column] ?? null) !== value); return builder; },
        order(column, options) { sort = { column, ascending: options?.ascending !== false }; return builder; },
        limit(count) { max = count; return builder; },
        maybeSingle() { return Promise.resolve({ data: run().data[0] || null, error: null }); },
        upsert(row, options = {}) {
          const key = options.onConflict;
          const stored = tables[name].find((item) => item[key] === row[key]);
          if (stored) { if (!options.ignoreDuplicates) Object.assign(stored, row); } else tables[name].push({ ...row });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
      };
      return builder;
    }
  };
}

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'Anna@Example.com' };

test('normalizeEmail trims and lower-cases and tolerates empty values', () => {
  assert.equal(normalizeEmail('  Anna@Example.COM '), 'anna@example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('the Supabase status reads SUPABASE_SECRET_KEY, falls back to SUPABASE_SERVICE_ROLE_KEY and never returns the key', () => {
  const env = { NODE_ENV: 'test', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb-secret-value' };
  assert.equal(supabase.isConfigured(env), true);
  const status = supabase.connectionStatus(env);
  assert.deepEqual(status, { connected: false, urlSet: true, keySet: true, keySource: 'SUPABASE_SERVICE_ROLE_KEY' });
  assert.ok(!JSON.stringify(status).includes('sb-secret-value'));
  assert.equal(supabase.connectionStatus({ NODE_ENV: 'test', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'b' }).keySource, 'SUPABASE_SECRET_KEY');
  assert.equal(supabase.isConfigured({ SUPABASE_URL: 'https://x.supabase.co' }), false);
  assert.deepEqual(supabase.connectionStatus({}), { connected: false, urlSet: false, keySet: false, keySource: null });
});

test('without a Supabase client the order store throws a 503 outside NODE_ENV=test and only uses memory under test', async (t) => {
  supabase.setClient(null);
  orders.resetMemory();
  const order = { orderNumber: 'OVI-260101-AAAAAA', sessionId: 'cs_guest_1', email: 'Vendeg@Example.com', amount: 390, planKey: 'daily', planMode: 'standard', paymentMethod: 'Barion' };

  const saved = await orders.markPaid(order);
  await orders.markPaid(order);
  assert.equal((await orders.getByOrderNumber(order.orderNumber)).email, 'vendeg@example.com', 'a vendég e-mail normalizálva mentődik');

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = previous; orders.resetMemory(); });
  await assert.rejects(orders.markPaid({ ...order, orderNumber: 'OVI-260101-BBBBBB', sessionId: 'cs_guest_2' }), (error) => error.status === 503);
  process.env.NODE_ENV = previous;
  assert.equal(orders.memoryCount?.() ?? 1, 1);
});

test('a failing document write outside NODE_ENV=test is not swallowed and the unlock is rolled back in memory', async (t) => {
  const db = fakeDb({ documents: [] });
  const original = db.from.bind(db);
  let failing = false;
  db.from = (name) => {
    const builder = original(name);
    if (name === 'documents') builder.upsert = () => Promise.resolve(failing ? { error: { message: 'db down' } } : { error: null });
    return builder;
  };
  supabase.setClient(db);
  t.after(() => { supabase.setClient(null); planStore.clearPlans(); });
  planStore.clearPlans();
  await planStore.savePlan('gen_unlock_1', { tema: 'x', request: { duration: 'Napi' } });
  failing = true;
  await assert.rejects(planStore.updateDocument('gen_unlock_1', { unlocked: true }), /db down|Supabase/);
  assert.equal(planStore.getDocumentState('gen_unlock_1').unlocked, false);
});

test('claimGuestRecords links guest orders, documents and the subscription to the user and prefills empty billing data once', async (t) => {
  const db = fakeDb({
    orders: [
      { order_number: 'OVI-1', user_id: null, user_email: 'anna@example.com', created_at: '2026-01-01T00:00:00Z', billing: { name: 'Régi Név', zip: '1111', city: 'Régi', address: 'Régi u. 1.' } },
      { order_number: 'OVI-2', user_id: null, user_email: 'anna@example.com', created_at: '2026-02-01T00:00:00Z', billing: { name: 'Minta Óvoda', zip: '9021', city: 'Győr', address: 'Fő utca 12/B.', taxId: '12345678-1-08' } },
      { order_number: 'OVI-3', user_id: null, user_email: 'masvalaki@example.com', created_at: '2026-03-01T00:00:00Z', billing: { name: 'Más' } },
      { order_number: 'OVI-4', user_id: 'someone-else', user_email: 'anna@example.com', created_at: '2026-04-01T00:00:00Z', billing: null }
    ],
    documents: [
      { document_id: 'd1', user_id: null, user_email: 'anna@example.com' },
      { document_id: 'd2', user_id: null, user_email: 'masvalaki@example.com' }
    ],
    newsletter_subscribers: [{ email: 'anna@example.com', user_id: null, subscribed: true }],
    profiles: [{ id: USER.id, email: 'anna@example.com', billing_name: '', billing_zip: '', billing_city: '', billing_address: '', billing_tax_id: '' }]
  });
  supabase.setClient(db);
  t.after(() => supabase.setClient(null));

  const result = await profileService.claimGuestRecords(USER);
  assert.deepEqual(result, { orders: 2, documents: 1, billingFilled: true });
  assert.deepEqual(db.tables.orders.map((row) => row.user_id), [USER.id, USER.id, null, 'someone-else']);
  assert.deepEqual(db.tables.documents.map((row) => row.user_id), [USER.id, null]);
  assert.equal(db.tables.newsletter_subscribers[0].user_id, USER.id);
  assert.deepEqual({ ...db.tables.profiles[0] }, {
    id: USER.id, email: 'anna@example.com', billing_name: 'Minta Óvoda', billing_zip: '9021', billing_city: 'Győr', billing_address: 'Fő utca 12/B.', billing_tax_id: '12345678-1-08'
  }, 'a legutóbbi vendégrendelés számlázási adata töltődik elő');

  db.tables.profiles[0].billing_name = 'Saját Név';
  db.tables.profiles[0].billing_city = '';
  const again = await profileService.claimGuestRecords(USER);
  assert.equal(again.billingFilled, false, 'a már kitöltött profilt nem írja felül');
  assert.equal(db.tables.profiles[0].billing_name, 'Saját Név');
});

test('getProfile claims the guest records of the confirmed user and a claim failure is logged, not thrown', async (t) => {
  const db = fakeDb({
    orders: [{ order_number: 'OVI-9', user_id: null, user_email: 'anna@example.com', created_at: '2026-01-01T00:00:00Z', billing: null }],
    documents: [], newsletter_subscribers: [], profiles: [{ id: USER.id, email: 'anna@example.com', full_name: 'Anna' }]
  });
  supabase.setClient(db);
  t.after(() => supabase.setClient(null));
  const profile = await profileService.getProfile(USER);
  assert.equal(profile.full_name, 'Anna');
  assert.equal(db.tables.orders[0].user_id, USER.id);

  db.tables.orders = null;
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  assert.equal((await profileService.getProfile(USER)).full_name, 'Anna');
});

test('newsletter state lives in one table: guests and users share it, the token survives resubscribing and unsubscribing is token based', async (t) => {
  const db = fakeDb({ newsletter_subscribers: [], profiles: [{ id: USER.id, email: 'anna@example.com' }], orders: [], documents: [] });
  supabase.setClient(db);
  t.after(() => supabase.setClient(null));

  await profileService.subscribeGuest({ email: ' Vendeg@Example.com ', name: 'Vendég Elek' });
  assert.deepEqual(db.tables.newsletter_subscribers.map((row) => [row.email, row.subscribed, row.name]), [['vendeg@example.com', true, 'Vendég Elek']]);
  await assert.rejects(profileService.subscribeGuest({ email: 'nem-email' }), { status: 400 });

  const subscribed = await profileService.subscribeNewsletter(USER);
  assert.equal(subscribed.newsletter_subscribed, true);
  const row = db.tables.newsletter_subscribers.find((item) => item.email === 'anna@example.com');
  assert.equal(row.user_id, USER.id);

  row.newsletter_token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await profileService.unsubscribeNewsletter(row.newsletter_token);
  assert.equal(row.subscribed, false);
  assert.ok(row.unsubscribed_at);
  assert.equal((await profileService.getProfile(USER)).newsletter_subscribed, false);
  await profileService.subscribeNewsletter(USER);
  assert.equal(row.newsletter_token, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a token nem változik újrafeliratkozáskor');
  await assert.rejects(profileService.unsubscribeNewsletter('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), { status: 404 });
});

test('the data unification migration defines the newsletter table, the guest-claim trigger, the unlock sync and the cleanup function idempotently', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '20261130090000_data_unification.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.newsletter_subscribers/);
  assert.match(sql, /email text primary key/);
  assert.match(sql, /user_id uuid references auth\.users \(id\) on delete set null/);
  assert.match(sql, /alter table public\.newsletter_subscribers enable row level security/);
  assert.match(sql, /after insert or update of email_confirmed_at on auth\.users/);
  assert.match(sql, /when \(new\.email_confirmed_at is not null\)/);
  assert.match(sql, /drop trigger if exists on_auth_user_created_claim_guest_records/);
  assert.match(sql, /update public\.orders set user_id = p_user_id where user_id is null and lower\(user_email\) = v_email/);
  assert.match(sql, /update public\.documents set user_id = p_user_id where user_id is null and lower\(user_email\) = v_email/);
  assert.match(sql, /drop column if exists subscription_tier/);
  assert.match(sql, /create or replace function public\.purge_expired_deleted_accounts/);
  assert.match(sql, /restore_until < now\(\)/);
  for (const statement of sql.match(/create (unique )?index [^;]+/gi) || []) assert.match(statement, /if not exists/i);
  for (const statement of sql.match(/create table [^;(]+/gi) || []) assert.match(statement, /if not exists/i);
});

// A gyűjtőfájlt a 20261202090000 migrációig kézzel frissítik; az újabb migrációkat külön futtatják.
test('RUN_ALL_PENDING_MIGRATIONS.sql contains every migration from 20261127 to 20261202090000 verbatim', () => {
  const all = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'RUN_ALL_PENDING_MIGRATIONS.sql'), 'utf8');
  const pending = fs.readdirSync(MIGRATIONS).filter((name) => name >= '20261127' && name <= '20261202090000.sql').sort();
  assert.ok(pending.length >= 5);
  let cursor = -1;
  for (const name of pending) {
    const body = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8').trim();
    const at = all.indexOf(body);
    assert.ok(at > cursor, `${name} hiányzik vagy rossz sorrendben van a gyűjtőfájlban`);
    cursor = at;
  }
});
