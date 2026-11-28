const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const server = require('../backend/server');
const supabase = require('../backend/services/supabaseService');
const settingsService = require('../backend/services/settingsService');
const pc = require('../backend/services/plannerConfigDefaults');
const { makePayload } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HTML = read('frontend', 'tervezo.html');

// ---------- alapértékek és a statikus HTML paritása ----------

test('the built-in defaults match the static tervezo.html texts and option lists', () => {
  const { document } = new JSDOM(HTML).window;
  const defaults = pc.defaults();
  for (const [key, [, type, text]] of Object.entries(pc.TEXT_META)) {
    const node = document.querySelector(type === 'placeholder' ? `[data-cfg-placeholder="${key}"]` : `[data-cfg-text="${key}"]`);
    assert.ok(node, `${key}: hiányzik a data-cfg attribútum`);
    const actual = type === 'placeholder' ? node.getAttribute('placeholder') : node.textContent.replace(/\s+/g, ' ').trim();
    assert.equal(actual, text, key);
    assert.equal(defaults.texts[key], text, key);
  }
  for (const [list, items] of Object.entries(pc.DEFAULT_OPTION_LISTS)) {
    const container = document.querySelector(`[data-cfg-options="${list}"]`);
    assert.ok(container, list);
    const found = [...container.querySelectorAll('[data-option-id]')].map((node) => ({
      id: node.dataset.optionId,
      label: (node.dataset.value || node.dataset.sniLabel || node.dataset.iktTool || node.value || node.textContent).trim()
    }));
    assert.deepEqual(found, items.map((item) => ({ id: item.id, label: item.label })), list);
  }
});

// ---------- validáció ----------

test('validation rejects unknown keys, protected fields, empty or oversized text and bad lists', () => {
  const bad = [
    { texts: { planKind: 'x' } },
    { texts: { step1Title: '' } },
    { texts: { step1Title: 'a'.repeat(1000) } },
    { texts: { step1Title: 'sor\ntörés' } },
    { optionLists: { detailLevel: [{ id: 'a1', label: 'x', active: true }] } },
    { optionLists: { group: [] } },
    { optionLists: { group: [{ id: 'kiscsoport', label: 'A', active: false }] } },
    { optionLists: { group: [{ id: 'x1', label: 'A', active: true }, { id: 'x1', label: 'B', active: true }] } },
    { optionLists: { group: [{ id: 'x1', label: 'A', active: true }, { id: 'x2', label: 'A', active: true }] } },
    { optionLists: { group: [{ id: 'X!', label: 'A', active: true }] } },
    { weeklyScope: 'x' },
    'nem objektum'
  ];
  for (const input of bad) {
    assert.throws(() => pc.validatePlannerConfig(input), pc.PlannerConfigError, JSON.stringify(input).slice(0, 70));
  }
  assert.doesNotThrow(() => pc.validatePlannerConfig({ texts: { step1Title: '1. Új cím' } }));
});

test('a default option cannot be deleted, only deactivated, while a custom one can be removed', () => {
  const eff = pc.mergePlannerConfig({});
  const withoutDefault = { optionLists: { group: eff.optionLists.group.filter((item) => item.id !== 'kiscsoport') } };
  assert.throws(() => pc.applyPatch(eff, withoutDefault), pc.PlannerConfigError);
  const deactivated = { optionLists: { group: eff.optionLists.group.map((item) => (item.id === 'kiscsoport' ? { ...item, active: false } : item)) } };
  assert.doesNotThrow(() => pc.applyPatch(eff, deactivated));
});

test('the public view carries only active options and merges stored values over the defaults', () => {
  const stored = { texts: { step1Title: '1. Saját cím' }, optionLists: { group: [...pc.DEFAULT_OPTION_LISTS.group.map((item) => (item.id === 'kiscsoport' ? { ...item, active: false } : item)), { id: 'custom_ab12cd34', label: 'Tagóvoda', active: true }] } };
  const view = pc.publicView(pc.mergePlannerConfig(stored));
  assert.equal(view.texts.step1Title, '1. Saját cím');
  assert.equal(view.texts.step2Title, pc.DEFAULT_TEXTS.step2Title);
  assert.deepEqual(view.optionLists.group.map((item) => item.label), ['Középső csoport', 'Nagycsoport', 'Vegyes csoport', 'Tagóvoda']);
  assert.deepEqual(Object.keys(view.optionLists.group[0]).sort(), ['id', 'label']);
});

// ---------- generálás: átírt és új opció a promptban ----------

test('a renamed or custom option is accepted by /api/generate validation and lands cleaned in the prompt', () => {
  const { validateGenerateRequest } = require('../backend/services/generateValidation');
  const payload = makePayload({ group: 'Tagóvoda – „méhecske”', fridayClosingType: 'Közös mesedélután' });
  const checked = validateGenerateRequest ? validateGenerateRequest(payload) : null;
  if (checked) assert.ok(!checked.error, JSON.stringify(checked.error));
  const prompt = server.buildPrompt(payload);
  assert.match(prompt, /Tagóvoda – „méhecske”/);
  assert.match(prompt, /Közös mesedélután/);
  const dirty = server.buildPrompt(makePayload({ group: 'Új\ncsoport\u0000 ```' }));
  assert.doesNotMatch(dirty, /Új\ncsoport/);
});

test('renaming the mixed group keeps the mixed-group rule through its stable id', () => {
  const stored = { optionLists: { group: pc.DEFAULT_OPTION_LISTS.group.map((item) => (item.id === 'vegyes' ? { ...item, label: 'Összevont csoport' } : item)) } };
  const labels = pc.mixedGroupLabels(stored);
  assert.ok(labels.has('Összevont csoport'));
  assert.ok(labels.has('Vegyes csoport'));
  assert.ok(!labels.has('Nagycsoport'));
});

// ---------- végpontok, napló, visszaállítás ----------

function fakeClient() {
  const db = { system_settings: [], system_settings_history: [], theme_suggestions: [], profiles: [] };
  let counter = 0;
  const admin = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  const alice = { id: '22222222-2222-4222-8222-222222222222', email: 'alice@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  const users = { 'token-admin': admin, 'token-alice': alice };
  const chain = (name) => {
    const table = name === 'profiles' ? null : db[name];
    const filters = [];
    let op = 'select';
    let payload;
    let limit = Infinity;
    let desc = false;
    const run = () => {
      if (!table) return [{ id: filters.find(([k]) => k === 'id')?.[1], is_admin: filters.find(([k]) => k === 'id')?.[1] === admin.id }];
      let found = table.filter((r) => filters.every(([k, v]) => r[k] === v));
      if (op === 'insert') {
        counter += 1;
        const created = { id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, seq: counter, changed_at: `2026-01-01T00:00:${String(counter % 60).padStart(2, '0')}Z`, ...payload };
        table.push(created);
        return [created];
      }
      if (op === 'update') { found.forEach((r) => Object.assign(r, payload)); return found; }
      if (op === 'delete') { found.forEach((r) => table.splice(table.indexOf(r), 1)); return found; }
      if (desc) found = [...found].sort((a, b) => (b.seq || 0) - (a.seq || 0));
      return found.slice(0, limit);
    };
    const builder = {
      select() { return builder; },
      eq(key, value) { filters.push([key, value]); return builder; },
      in() { return builder; },
      ilike() { return builder; },
      gte() { return builder; },
      lte() { return builder; },
      order(_c, options) { desc = options?.ascending === false; return builder; },
      range() { return builder; },
      limit(n) { limit = n; return builder; },
      insert(value) { op = 'insert'; payload = value; return builder; },
      update(value) { op = 'update'; payload = value; return builder; },
      delete() { op = 'delete'; return builder; },
      upsert(rows, options = {}) {
        const key = options.onConflict || 'id';
        for (const row of [].concat(rows)) {
          const existing = table.find((r) => r[key] === row[key]);
          if (existing) Object.assign(existing, row); else table.push({ ...row });
        }
        return Promise.resolve({ data: null, error: null });
      },
      async single() { const [first] = run(); return { data: first ? { ...first } : null, error: null }; },
      async maybeSingle() { const [first] = run(); return { data: first ? { ...first } : null, error: null }; },
      then(resolve, reject) {
        const data = run().map((r) => ({ ...r }));
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
      }
    };
    return builder;
  };
  return { db, auth: { async getUser(token) { return users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: { status: 401, message: 'invalid JWT' } }; } }, from: chain };
}

async function setup(t) {
  const client = fakeClient();
  const saved = { email: process.env.ADMIN_EMAIL, rate: process.env.ADMIN_RATE_LIMIT };
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_RATE_LIMIT = '100000';
  supabase.setClient(client);
  settingsService.invalidate();
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    supabase.setClient(null);
    settingsService.invalidate();
    if (saved.email === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = saved.email;
    if (saved.rate === undefined) delete process.env.ADMIN_RATE_LIMIT; else process.env.ADMIN_RATE_LIMIT = saved.rate;
    await new Promise((resolve) => instance.close(resolve));
  });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const send = (route, { token = 'token-admin', method = 'GET', body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { client, send };
}

test('the planner-config endpoints need an admin and reject protected or invalid fields with 400', async (t) => {
  const { send } = await setup(t);
  assert.equal((await send('/api/admin/planner-config', { token: null })).status, 401);
  assert.equal((await send('/api/admin/planner-config', { token: 'token-alice' })).status, 403);
  assert.equal((await send('/api/admin/planner-config', { method: 'PUT', token: 'token-alice', body: { texts: { step1Title: 'x' } } })).status, 403);
  const initial = await (await send('/api/admin/planner-config')).json();
  assert.equal(initial.effective.texts.step1Title, pc.DEFAULT_TEXTS.step1Title);
  for (const body of [{ texts: { planKind: 'x' } }, { optionLists: { detailLevel: [] } }, { texts: { step1Title: '' } }, { optionLists: { group: [] } }]) {
    const response = await send('/api/admin/planner-config', { method: 'PUT', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).success, false);
  }
});

test('saving the planner config serves it on /api/config, logs it and a log entry restores it (also logged)', async (t) => {
  const { send, client } = await setup(t);
  const put = await send('/api/admin/planner-config', { method: 'PUT', body: { texts: { step1Title: '1. Saját cím' }, optionLists: { group: [...pc.DEFAULT_OPTION_LISTS.group, { id: 'custom_ab12cd34', label: 'Tagóvoda', active: true }] } } });
  assert.equal(put.status, 200);
  const config = await (await send('/api/config', { token: null })).json();
  assert.equal(config.planner_config.texts.step1Title, '1. Saját cím');
  assert.ok(config.planner_config.optionLists.group.some((item) => item.label === 'Tagóvoda'));

  const history = client.db.system_settings_history.filter((row) => row.setting_key === 'planner_config');
  assert.ok(history.length >= 1, 'a mentés naplózódott');
  const audit = await (await send('/api/admin/audit?type=setting')).json();
  const entry = audit.entries.find((e) => e.key === 'planner_config');
  assert.ok(entry && entry.restorable && entry.summary);

  const forbidden = await send(`/api/admin/audit/${entry.id}/restore`, { method: 'POST', token: 'token-alice' });
  assert.equal(forbidden.status, 403);
  const restore = await send(`/api/admin/audit/${entry.id}/restore`, { method: 'POST' });
  assert.equal(restore.status, 200);
  const after = await (await send('/api/config', { token: null })).json();
  assert.equal(after.planner_config.texts.step1Title, pc.DEFAULT_TEXTS.step1Title);
  assert.ok(!after.planner_config.optionLists.group.some((item) => item.label === 'Tagóvoda'));
  assert.ok(client.db.system_settings_history.filter((row) => row.setting_key === 'planner_config').length > history.length, 'a visszaállítás is naplózódik');
  assert.equal((await send('/api/admin/audit/00000000-0000-4000-8000-999999999999/restore', { method: 'POST' })).status, 404);
});

test('reset-all returns every text and list to the defaults', async (t) => {
  const { send } = await setup(t);
  await send('/api/admin/planner-config', { method: 'PUT', body: { texts: { step2Title: '2. Másik' } } });
  assert.equal((await (await send('/api/config', { token: null })).json()).planner_config.texts.step2Title, '2. Másik');
  assert.equal((await send('/api/admin/planner-config/reset', { method: 'POST' })).status, 200);
  assert.equal((await (await send('/api/config', { token: null })).json()).planner_config.texts.step2Title, pc.DEFAULT_TEXTS.step2Title);
});

test('theme suggestion create, update and delete are logged and each can be restored', async (t) => {
  const { send, client } = await setup(t);
  const created = await (await send('/api/admin/theme-suggestions', { method: 'POST', body: { title: 'Teszt téma', category: 'general', priority: 20, is_active: true } })).json();
  const id = created.suggestion?.id || created.id;
  assert.ok(id, JSON.stringify(created));
  await send(`/api/admin/theme-suggestions/${id}`, { method: 'PUT', body: { title: 'Átírt téma', category: 'general', priority: 20, is_active: true } });
  assert.equal(client.db.theme_suggestions[0].title, 'Átírt téma');
  await send(`/api/admin/theme-suggestions/${id}`, { method: 'DELETE' });
  assert.equal(client.db.theme_suggestions.length, 0);

  const logged = client.db.system_settings_history.filter((row) => row.setting_key === `theme_suggestion:${id}`);
  assert.equal(logged.length, 3);
  const [createRow, updateRow, deleteRow] = logged;
  const restoreRow = async (row) => send(`/api/admin/audit/${row.id}/restore`, { method: 'POST' });

  assert.equal((await restoreRow(deleteRow)).status, 200);
  assert.equal(client.db.theme_suggestions.find((r) => r.id === id)?.title, 'Átírt téma', 'törlés visszaállítása újraszúrja a sort');
  assert.equal((await restoreRow(updateRow)).status, 200);
  assert.equal(client.db.theme_suggestions.find((r) => r.id === id)?.title, 'Teszt téma');
  assert.equal((await restoreRow(createRow)).status, 200);
  assert.equal(client.db.theme_suggestions.find((r) => r.id === id), undefined, 'a létrehozás visszaállítása törli a sort');
  assert.ok(client.db.system_settings_history.filter((row) => row.setting_key === `theme_suggestion:${id}`).length > 3, 'a visszaállítás is naplózódik');
});

// ---------- admin fül és XSS-biztos renderelés ----------

test('the Admin has the Tervező űrlap tab, the restore column and renders values without innerHTML', () => {
  const admin = read('frontend', 'admin.html');
  const js = read('frontend', 'js', 'admin.js');
  assert.match(admin, /data-admin-tab="planner"/);
  assert.match(admin, /id="panelPlanner"/);
  assert.match(admin, /id="plannerSave"/);
  assert.match(admin, /id="plannerResetAll"/);
  assert.match(admin, /<option value="theme">/);
  assert.match(js, /planner: \[loadPlanner\]/);
  assert.match(js, /↺ Alapértelmezés/);
  assert.match(js, /↺ Lista visszaállítása/);
  assert.match(js, /\+ Új opció/);
  assert.match(js, /↺ Visszaállítás/);
  assert.match(js, /\/api\/admin\/audit\/\$\{encodeURIComponent\(entry\.id\)\}\/restore/);
  const plannerBlock = js.slice(js.indexOf('Tervező űrlap (szövegek és opciólisták)'), js.indexOf('const TAB_LOADERS'));
  assert.ok(plannerBlock.length > 500);
  assert.doesNotMatch(plannerBlock, /innerHTML|insertAdjacentHTML/);
  const configJs = read('frontend', 'js', 'tervezo-config.js');
  assert.doesNotMatch(configJs, /innerHTML|insertAdjacentHTML/);
});

test('applyPlannerConfig renders renamed options and texts safely and keeps the selection by id', async () => {
  const dom = new JSDOM(HTML.replace(/<script[^>]*><\/script>/g, ''), { runScripts: 'outside-only' });
  const { window } = dom;
  window.updateSummary = () => {};
  window.saveProfileToStorage = () => {};
  window.persistDraftState = () => {};
  window.setChoice = () => {};
  window.eval(`${read('frontend', 'js', 'tervezo-config.js')}\nlet ENERGY_DEFAULT = 'Átlagos';\nwindow.applyPlannerConfig = applyPlannerConfig;`);
  const evil = '<img src=x onerror=alert(1)>';
  window.applyPlannerConfig({
    texts: { step1Title: evil, studentNamePlaceholder: 'Új helykitöltő' },
    optionLists: { group: [{ id: 'kiscsoport', label: 'Kis', active: true }, { id: 'nagycsoport', label: evil, active: true }], specialNeeds: [{ id: 'sni', label: 'SNI-új', active: true }] }
  });
  const { document } = window;
  assert.equal(document.querySelector('[data-cfg-text="step1Title"]').textContent, evil);
  assert.equal(document.querySelector('[data-cfg-text="step1Title"] img'), null);
  assert.equal(document.querySelector('[data-cfg-placeholder="studentNamePlaceholder"]').placeholder, 'Új helykitöltő');
  const select = document.querySelector('[data-cfg-options="group"]');
  assert.deepEqual([...select.options].map((o) => o.value), ['Kis', evil]);
  assert.equal(select.value, evil, 'az eredetileg kijelölt nagycsoport id alapján megmarad');
  assert.equal(document.querySelectorAll('[data-cfg-options="specialNeeds"] [data-sni-label]').length, 1);
  assert.equal(document.querySelector('img[src="x"]'), null);
});
