const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const server = require('../backend/server');
const supabase = require('../backend/services/supabaseService');
const themes = require('../backend/services/themeSuggestionsService');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261206120000_theme_suggestions.sql'), 'utf8');
const RUN_ALL = fs.readFileSync(path.join(ROOT, 'supabase', 'RUN_ALL_PENDING_MIGRATIONS.sql'), 'utf8');

const row = (title, category, priority, extra = {}) => ({ id: `id-${title}`, title, category, season: null, start_mmdd: null, end_mmdd: null, priority, is_active: true, ...extra });

// ---------- tiszta logika ----------

test('inWindow matches MM-DD ranges, including the ones that wrap around the new year', () => {
  assert.equal(themes.inWindow('11-05', '10-28', '11-15'), true);
  assert.equal(themes.inWindow('10-28', '10-28', '11-15'), true);
  assert.equal(themes.inWindow('11-15', '10-28', '11-15'), true);
  assert.equal(themes.inWindow('10-27', '10-28', '11-15'), false);
  assert.equal(themes.inWindow('11-16', '10-28', '11-15'), false);
  for (const day of ['12-20', '12-31', '01-01', '01-10']) assert.equal(themes.inWindow(day, '12-20', '01-10'), true, day);
  for (const day of ['12-19', '01-11', '06-15']) assert.equal(themes.inWindow(day, '12-20', '01-10'), false, day);
  assert.equal(themes.inWindow('05-05', null, null), false);
});

test('seasonOf maps the month to the Hungarian season key', () => {
  assert.deepEqual(['03-01', '05-31', '06-01', '08-31', '09-01', '11-30', '12-01', '02-28'].map(themes.seasonOf), ['tavasz', 'tavasz', 'nyar', 'nyar', 'osz', 'osz', 'tel', 'tel']);
});

test('ISO weeks resolve to the middle of the week and bad dates are rejected with 400', () => {
  assert.equal(themes.parseDateInput('2026-W46').toISOString().slice(0, 10), '2026-11-11');
  assert.equal(themes.parseDateInput('2026-W01').toISOString().slice(0, 10), '2025-12-31');
  assert.equal(themes.parseDateInput('2026-11-11').toISOString().slice(0, 10), '2026-11-11');
  assert.equal(themes.parseDateInput('', new Date('2026-03-04T10:00:00Z')).toISOString().slice(0, 10), '2026-03-04');
  for (const bad of ['2026-13-01', '2026-02-30', '2026-W54', 'holnap', '2026-W00']) {
    assert.throws(() => themes.parseDateInput(bad), (error) => error instanceof themes.ThemeSuggestionError && error.status === 400, bad);
  }
});

test('selectSuggestions fills events, then the season, then general, sorted by priority and title, at most 8', () => {
  const rows = [
    row('Márton-nap', 'event', 90, { start_mmdd: '11-01', end_mmdd: '11-15' }),
    row('Adventi készülődés', 'event', 90, { start_mmdd: '11-01', end_mmdd: '11-15' }),
    row('Húsvét', 'event', 95, { start_mmdd: '03-20', end_mmdd: '04-10' }),
    row('Ősz: gyümölcsök', 'season', 45, { season: 'osz' }),
    row('Tél: hó', 'season', 45, { season: 'tel' }),
    row('Család', 'general', 20),
    row('Inaktív', 'event', 100, { start_mmdd: '11-01', end_mmdd: '11-15', is_active: false })
  ];
  const picked = themes.selectSuggestions(rows.filter((r) => r.is_active), '11-05').map((r) => r.title);
  assert.deepEqual(picked, ['Adventi készülődés', 'Márton-nap', 'Ősz: gyümölcsök', 'Család']);

  const many = Array.from({ length: 12 }, (_, i) => row(`Téma ${String(i).padStart(2, '0')}`, 'event', 80 + i, { start_mmdd: '01-01', end_mmdd: '12-31' }));
  const limited = themes.selectSuggestions(many, '06-06');
  assert.equal(limited.length, themes.MAX_SUGGESTIONS);
  assert.equal(limited[0].title, 'Téma 11');
});

test('a short event list is topped up with season items even when general items exist', () => {
  const rows = [
    row('Gyereknap', 'event', 90, { start_mmdd: '05-20', end_mmdd: '06-02' }),
    row('Nyár: víz', 'season', 40, { season: 'nyar' }),
    row('Tavasz: virágok', 'season', 50, { season: 'tavasz' }),
    row('Közlekedés', 'general', 20)
  ];
  assert.deepEqual(themes.selectSuggestions(rows, '05-25').map((r) => r.title), ['Gyereknap', 'Tavasz: virágok', 'Közlekedés']);
});

test('without a database the built-in fallback is served loudly and is never empty', async () => {
  const noClient = await themes.suggestionsForDate(null, '2026-11-11');
  assert.equal(noClient.source, 'fallback');
  assert.ok(noClient.suggestions.length > 0 && noClient.suggestions.length <= 8);
  const broken = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'kapcsolat megszakadt' } }) }) }) };
  const failed = await themes.suggestionsForDate(broken, '2026-W46');
  assert.equal(failed.source, 'fallback');
  const empty = { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) };
  assert.equal((await themes.suggestionsForDate(empty, '2026-07-01')).source, 'fallback');
});

test('validateSuggestion enforces the table rules', () => {
  const ok = themes.validateSuggestion({ title: '  Márton-nap  ', category: 'event', start_mmdd: '11-01', end_mmdd: '11-15', priority: 90 });
  assert.equal(ok.title, 'Márton-nap');
  assert.equal(ok.is_active, true);
  assert.equal(themes.validateSuggestion({ title: 'Szökőnap', category: 'event', start_mmdd: '02-29', end_mmdd: '03-02' }).start_mmdd, '02-29');
  const bad = [
    { category: 'event', start_mmdd: '11-01', end_mmdd: '11-15' },
    { title: 'x', category: 'ismeretlen' },
    { title: 'x', category: 'event' },
    { title: 'x', category: 'event', start_mmdd: '11-01' },
    { title: 'x', category: 'event', start_mmdd: '13-01', end_mmdd: '13-02' },
    { title: 'x', category: 'event', start_mmdd: '04-31', end_mmdd: '05-02' },
    { title: 'x', category: 'season' },
    { title: 'x', category: 'season', season: 'monsun' },
    { title: 'x', category: 'general', priority: -1 },
    { title: 'x', category: 'general', priority: 1.5 },
    { title: 'x', category: 'general', is_active: 'igen' },
    { title: 'a'.repeat(201), category: 'general' }
  ];
  for (const input of bad) {
    assert.throws(() => themes.validateSuggestion(input), themes.ThemeSuggestionError, JSON.stringify(input).slice(0, 80));
  }
});

// ---------- végpontok ----------

function fakeClient(initial = []) {
  const rows = initial.map((item) => ({ ...item }));
  let counter = 0;
  const admin = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  const alice = { id: '22222222-2222-4222-8222-222222222222', email: 'alice@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  const users = { 'token-admin': admin, 'token-alice': alice };
  const chain = (name) => {
    let filters = [];
    let op = 'select';
    let payload;
    const apply = () => (name === 'profiles' ? [{ id: filters.find(([k]) => k === 'id')?.[1], is_admin: filters.find(([k]) => k === 'id')?.[1] === admin.id }] : rows.filter((r) => filters.every(([k, v]) => r[k] === v)));
    const run = () => {
      if (name !== 'theme_suggestions' && name !== 'profiles') return []; // pl. a naplózás táblái
      const found = apply();
      if (op === 'insert') {
        const created = { id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, created_at: 'now', updated_at: 'now', ...payload };
        rows.push(created);
        return [created];
      }
      if (op === 'update') { found.forEach((r) => Object.assign(r, payload)); return found; }
      if (op === 'delete') { found.forEach((r) => rows.splice(rows.indexOf(r), 1)); return found; }
      return found;
    };
    const builder = {
      select() { return builder; },
      eq(key, value) { filters.push([key, value]); return builder; },
      order() { return builder; },
      range() { return builder; },
      insert(value) { op = 'insert'; payload = value; return builder; },
      update(value) { op = 'update'; payload = value; return builder; },
      delete() { op = 'delete'; return builder; },
      async single() { return { data: run()[0] || null, error: null }; },
      async maybeSingle() { return { data: run()[0] || null, error: null }; },
      then(resolve, reject) { return Promise.resolve({ data: run(), error: null }).then(resolve, reject); }
    };
    return builder;
  };
  return {
    rows,
    auth: { async getUser(token) { return users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: { status: 401, message: 'invalid JWT' } }; } },
    from: chain
  };
}

async function setup(t, initial) {
  const client = fakeClient(initial);
  const savedEmail = process.env.ADMIN_EMAIL;
  const savedRate = process.env.ADMIN_RATE_LIMIT;
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_RATE_LIMIT = '100000';
  supabase.setClient(client);
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    supabase.setClient(null);
    if (savedEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = savedEmail;
    if (savedRate === undefined) delete process.env.ADMIN_RATE_LIMIT; else process.env.ADMIN_RATE_LIMIT = savedRate;
    await new Promise((resolve) => instance.close(resolve));
  });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const send = (route, { token, method = 'GET', body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(body && method !== 'GET' && method !== 'DELETE' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' || method === 'DELETE' ? undefined : (body ? JSON.stringify(body) : undefined)
  });
  return { client, base, send };
}

test('GET /api/theme-suggestions serves the date-specific list from the database, also for ISO weeks', async (t) => {
  const { send } = await setup(t, [
    row('Márton-nap', 'event', 90, { start_mmdd: '11-01', end_mmdd: '11-15' }),
    row('Karácsony', 'event', 100, { start_mmdd: '12-20', end_mmdd: '01-10' }),
    row('Ősz: falevelek', 'season', 45, { season: 'osz' })
  ]);
  const day = await (await send('/api/theme-suggestions?date=2026-11-11')).json();
  assert.equal(day.success, true);
  assert.equal(day.source, 'database');
  assert.equal(day.season, 'osz');
  assert.deepEqual(day.suggestions.map((s) => s.title), ['Márton-nap', 'Ősz: falevelek']);
  const week = await (await send('/api/theme-suggestions?date=2026-W46')).json();
  assert.equal(week.date, '2026-11-11');
  const winter = await (await send('/api/theme-suggestions?date=2027-01-05')).json();
  assert.deepEqual(winter.suggestions.map((s) => s.title), ['Karácsony']);
  const response = await send('/api/theme-suggestions?date=2026-11-11');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bad = await send('/api/theme-suggestions?date=nem-datum');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).success, false);
});

test('the admin theme endpoints need an admin token', async (t) => {
  const { send } = await setup(t, [row('Márton-nap', 'event', 90, { start_mmdd: '11-01', end_mmdd: '11-15' })]);
  const body = { title: 'Új', category: 'general' };
  for (const [route, method] of [['/api/admin/theme-suggestions', 'GET'], ['/api/admin/theme-suggestions', 'POST'], ['/api/admin/theme-suggestions/00000000-0000-4000-8000-000000000001', 'PUT'], ['/api/admin/theme-suggestions/00000000-0000-4000-8000-000000000001', 'DELETE']]) {
    assert.equal((await send(route, { method, body })).status, 401, `${method} token nélkül`);
    assert.equal((await send(route, { method, body, token: 'token-alice' })).status, 403, `${method} sima felhasználóval`);
  }
});

test('admin CRUD: validation, create, partial update, toggle, delete and 404s', async (t) => {
  const { send, client } = await setup(t, [row('Márton-nap', 'event', 90, { id: '33333333-3333-4333-8333-333333333333', start_mmdd: '11-01', end_mmdd: '11-15' })]);
  const token = 'token-admin';

  const list = await (await send('/api/admin/theme-suggestions', { token })).json();
  assert.equal(list.suggestions.length, 1);

  const invalid = await send('/api/admin/theme-suggestions', { token, method: 'POST', body: { title: 'x', category: 'event' } });
  assert.equal(invalid.status, 400);
  assert.equal(client.rows.length, 1);

  const created = await send('/api/admin/theme-suggestions', { token, method: 'POST', body: { title: 'Medvenap', category: 'event', start_mmdd: '01-30', end_mmdd: '02-04', priority: 85 } });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.suggestion.title, 'Medvenap');
  assert.equal(client.rows.length, 2);

  const id = createdBody.suggestion.id;
  const toggled = await send(`/api/admin/theme-suggestions/${id}`, { token, method: 'PUT', body: { is_active: false } });
  assert.equal(toggled.status, 200);
  const toggledBody = await toggled.json();
  assert.equal(toggledBody.suggestion.is_active, false);
  assert.equal(toggledBody.suggestion.title, 'Medvenap');

  const badUpdate = await send(`/api/admin/theme-suggestions/${id}`, { token, method: 'PUT', body: { priority: 'sok' } });
  assert.equal(badUpdate.status, 400);

  assert.equal((await send('/api/admin/theme-suggestions/00000000-0000-4000-8000-0000000000ff', { token, method: 'PUT', body: { priority: 5 } })).status, 404);
  assert.equal((await send('/api/admin/theme-suggestions/nem-uuid', { token, method: 'DELETE' })).status, 400);

  assert.equal((await send(`/api/admin/theme-suggestions/${id}`, { token, method: 'DELETE' })).status, 200);
  assert.equal(client.rows.length, 1);
  assert.equal((await send(`/api/admin/theme-suggestions/${id}`, { token, method: 'DELETE' })).status, 404);
});

test('CORS allows the PUT method the admin edit needs', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/admin/theme-suggestions/x`, { method: 'OPTIONS', headers: { Origin: 'https://ovitervezo.hu', 'Access-Control-Request-Method': 'PUT' } });
  assert.match(response.headers.get('access-control-allow-methods') || '', /PUT/);
});

// ---------- migráció ----------

test('the migration is idempotent, seeded with real Hungarian topics and part of RUN_ALL_PENDING_MIGRATIONS', () => {
  assert.match(MIGRATION, /create table if not exists public\.theme_suggestions/i);
  assert.match(MIGRATION, /enable row level security/i);
  assert.match(MIGRATION, /is_active = true/);
  assert.match(MIGRATION, /on conflict \(title\) do nothing/i);
  assert.equal(/lorem/i.test(MIGRATION), false);
  assert.ok(RUN_ALL.includes(MIGRATION.trim()), 'a RUN_ALL fájl az új migráció teljes szövegét tartalmazza');

  const seeds = [...MIGRATION.matchAll(/^\s*\('((?:[^']|'')+)',\s*'(event|season|general)',\s*(null|'[a-z]+'),\s*(null|'[\d-]+'),\s*(null|'[\d-]+'),\s*(\d+)\)/gm)];
  assert.ok(seeds.length >= 60 && seeds.length <= 80, `seed sorok: ${seeds.length}`);
  const titles = seeds.map((m) => m[1]);
  assert.equal(new Set(titles).size, titles.length, 'egyedi címek');
  const count = (category) => seeds.filter((m) => m[2] === category).length;
  assert.ok(count('event') >= 25 && count('general') >= 5);
  for (const season of ['tavasz', 'nyar', 'osz', 'tel']) assert.ok(seeds.filter((m) => m[2] === 'season' && m[3] === `'${season}'`).length >= 10, season);
  for (const m of seeds) {
    for (const mmdd of [m[4], m[5]].filter((v) => v !== 'null')) assert.match(mmdd.replace(/'/g, ''), /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, m[1]);
    if (m[2] === 'event') assert.ok(m[4] !== 'null' && m[5] !== 'null' && Number(m[6]) >= 80 && Number(m[6]) <= 100, m[1]);
  }
  assert.ok(titles.some((title) => /Márton/.test(title)) && titles.some((title) => /Augusztus 20/.test(title)));
});

// ---------- admin oldal ----------

test('the admin page has a dedicated theme tab and the old seasonal hints field is gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'admin.js'), 'utf8');
  assert.match(html, /data-admin-tab="themes"/);
  for (const id of ['panelThemes', 'themesSearch', 'themesCategory', 'themesPeriod', 'themesPreviewDate', 'themesPreviewChips', 'themesTable', 'themeDialog', 'themeForm']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.equal(html.includes('id="setHints"'), false);
  assert.equal(/seasonal_hints|setHints/.test(js), false);
  assert.ok(js.includes('/api/admin/theme-suggestions'));
});
