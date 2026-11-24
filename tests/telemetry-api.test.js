const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const server = require('../backend/server');
const supabase = require('../backend/services/supabaseService');
const telemetry = require('../backend/services/telemetryService');

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function mockClient(t, error = null) {
  const inserted = [];
  supabase.setClient({ from: (table) => ({ insert: async (row) => { inserted.push({ table, row }); return { error }; } }) });
  t.after(() => supabase.setClient(null));
  return inserted;
}

const post = (base, body) => fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/telemetry stores a whitelisted event with only anonymous fields', async (t) => {
  const inserted = mockClient(t);
  const base = await listen(t);
  const res = await post(base, { eventName: 'download_docx', deviceType: 'mobile', referrerDomain: 'Google.com', metadata: { plan_mode: 'weekly', age_group: 'Nagycsoport', utm_source: 'fb' } });
  assert.equal(res.status, 200);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, 'analytics_events');
  assert.deepEqual(inserted[0].row, { event_name: 'download_docx', category: null, device_type: 'mobile', referrer_domain: 'google.com', metadata: { plan_mode: 'weekly', age_group: 'Nagycsoport', utm_source: 'fb' } });
});

test('POST /api/telemetry rejects events outside the whitelist and never inserts them', async (t) => {
  const inserted = mockClient(t);
  const base = await listen(t);
  for (const eventName of ['drop_table', 'user_login', '', undefined, 42]) {
    const res = await post(base, { eventName });
    assert.equal(res.status, 400, String(eventName));
  }
  for (const eventName of telemetry.ALLOWED_EVENTS) assert.equal((await post(base, { eventName })).status, 200, eventName);
  assert.equal(inserted.length, telemetry.ALLOWED_EVENTS.size);
});

test('POST /api/telemetry drops identifiers, IPs, e-mails and unknown metadata keys (PII-free)', async (t) => {
  const inserted = mockClient(t);
  const base = await listen(t);
  const res = await post(base, {
    eventName: 'page_view',
    deviceType: 'toaster',
    referrerDomain: 'https://evil.example/path?email=a@b.hu',
    ip: '1.2.3.4',
    user_id: 'u-1',
    metadata: { user_id: 'u-1', email: 'a@b.hu', ip: '1.2.3.4', timestamp: 'x', plan_mode: 'daily', theme_category: 'a@b.hu' }
  });
  assert.equal(res.status, 400, 'az e-mail címet tartalmazó érték elutasított');
  const ok = await post(base, { eventName: 'page_view', deviceType: 'toaster', referrerDomain: 'https://evil.example/path', ip: '1.2.3.4', user_id: 'u-1', metadata: { user_id: 'u-1', email: 'a@b.hu', ip: '1.2.3.4', plan_mode: 'daily' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(inserted[0].row, { event_name: 'page_view', category: null, device_type: null, referrer_domain: null, metadata: { plan_mode: 'daily' } });
  assert.deepEqual(Object.keys(inserted[0].row).sort(), ['category', 'device_type', 'event_name', 'metadata', 'referrer_domain']);
});

test('POST /api/telemetry reports a database failure instead of hiding it, and 503 without Supabase', async (t) => {
  mockClient(t, { message: 'db down' });
  const base = await listen(t);
  assert.equal((await post(base, { eventName: 'page_view' })).status, 500);
  supabase.setClient(null);
  assert.equal((await post(base, { eventName: 'page_view' })).status, 503);
});

test('the analytics_events migration has no identifier columns and enables RLS', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261124110000_analytics_events.sql'), 'utf8');
  assert.match(sql, /enable row level security/i);
  const columns = sql.split('create table')[1].split(');')[0];
  assert.doesNotMatch(columns, /\b(ip|ip_address|user_id|session_id|client_id|user_agent)\b/i);
});
