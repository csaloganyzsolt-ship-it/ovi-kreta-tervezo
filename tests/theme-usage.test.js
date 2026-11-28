const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const themes = require('../backend/services/themeSuggestionsService');
const { validateGeneratePayload, ValidationError } = require('../backend/services/generateValidation');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const MIGRATION = read('supabase', 'migrations', '20261206150000_theme_suggestions_usage.sql');
const RUN_ALL = read('supabase', 'RUN_ALL_PENDING_MIGRATIONS.sql');
const ADMIN_HTML = read('frontend', 'admin.html');
const ADMIN_JS = read('frontend', 'js', 'admin.js');
const CSS = read('frontend', 'styles.css');
const FORM_JS = read('frontend', 'js', 'tervezo-form.js');

const UUID = '3f2b8c1e-5d4a-4b7e-9c10-1a2b3c4d5e6f';

const fakeRpcClient = (result = { data: 1, error: null }) => {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return result; } };
};

test('recordUsage increments by id, or by trimmed title when there is no id', async () => {
  const byId = fakeRpcClient();
  assert.equal(await themes.recordUsage({ id: UUID, title: 'Márton-nap' }, byId), true);
  assert.deepEqual(byId.calls, [{ name: 'increment_theme_suggestion_usage', args: { p_id: UUID, p_title: null } }]);

  const byTitle = fakeRpcClient();
  assert.equal(await themes.recordUsage({ title: '  Márton-nap  ' }, byTitle), true);
  assert.deepEqual(byTitle.calls[0].args, { p_id: null, p_title: 'Márton-nap' });
});

test('recordUsage never throws and ignores empty or invalid input', async () => {
  const client = fakeRpcClient();
  assert.equal(await themes.recordUsage({}, client), false);
  assert.equal(await themes.recordUsage({ id: 'nem-uuid', title: '' }, client), false);
  assert.equal(client.calls.length, 0);

  assert.equal(await themes.recordUsage({ title: 'Téma' }, fakeRpcClient({ data: null, error: { message: 'boom' } })), false);
  const throwing = { rpc: async () => { throw new Error('hálózati hiba'); } };
  assert.equal(await themes.recordUsage({ title: 'Téma' }, throwing), false);
});

test('generate validation accepts an optional themeSuggestionId and rejects non-UUID values', () => {
  assert.deepEqual(themes.ADMIN_PAGE_SIZES, [10, 25, 50, 100]);
  assert.equal(validateGeneratePayload({ themeSuggestionId: UUID }).themeSuggestionId, UUID);
  assert.equal('themeSuggestionId' in validateGeneratePayload({ themeSuggestionId: '' }), false);
  assert.equal('themeSuggestionId' in validateGeneratePayload({}), false);
  assert.throws(() => validateGeneratePayload({ themeSuggestionId: 'nem-uuid' }), ValidationError);
});

test('the usage migration is idempotent, service-role only and part of RUN_ALL_PENDING_MIGRATIONS', () => {
  assert.match(MIGRATION, /add column if not exists usage_count integer not null default 0/i);
  assert.match(MIGRATION, /create or replace function public\.increment_theme_suggestion_usage\(p_id uuid default null, p_title text default null\)/i);
  assert.match(MIGRATION, /usage_count = usage_count \+ 1/i);
  assert.match(MIGRATION, /lower\(btrim\(/i);
  assert.match(MIGRATION, /grant execute on function public\.increment_theme_suggestion_usage\(uuid, text\) to service_role/i);
  assert.ok(RUN_ALL.includes(MIGRATION.trim()), 'a RUN_ALL fájl az új migráció teljes szövegét tartalmazza');
});

test('the admin theme table has pager, page size selector, usage column and an action menu', () => {
  assert.match(ADMIN_HTML, /id="themesPageSize"/);
  for (const size of [10, 25, 50, 100]) assert.match(ADMIN_HTML, new RegExp(`<option value="${size}"`));
  assert.match(ADMIN_HTML, /data-list="themes" data-pager/);
  assert.match(ADMIN_HTML, /id="themesSortUsage"/);
  assert.match(ADMIN_HTML, /Használat/);
  assert.match(ADMIN_JS, /admin-menu-btn/);
  assert.match(ADMIN_JS, /role', 'menu'|role="menu"|'menu'/);
  assert.match(ADMIN_JS, /Escape/);
  assert.match(ADMIN_JS, /Aktiválás|Inaktiválás/);
  assert.match(CSS, /\.admin-action-menu[^{]*\{[^}]*/);
  assert.match(CSS, /\.admin-menu-list\s*\{[^}]*position:\s*fixed|\.admin-action-menu\s*\{[^}]*position:\s*fixed/);
});

test('theme chip containers get a roomy gap in the planner and in the admin preview', () => {
  assert.match(CSS, /^\.theme-suggestions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*8px 10px/m);
  assert.match(CSS, /\.admin-theme-preview \.theme-suggestions\s*\{[^}]*gap:\s*8px 10px/);
});

const fakeListClient = (rows) => ({
  from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }) })
});

test('admin list pages the filtered rows, sorts by usage and validates the page size', async () => {
  const rows = Array.from({ length: 74 }, (_, i) => ({
    id: `id-${i}`, title: `Téma ${String(i).padStart(2, '0')}`, category: 'general', season: null, start_mmdd: null, end_mmdd: null, priority: 20, is_active: true, usage_count: i
  }));
  const client = fakeListClient(rows);

  const first = await themes.listSuggestions(client, { pageSize: '25' });
  assert.equal(first.suggestions.length, 25);
  assert.equal(first.total, 74);
  assert.equal(first.totalPages, 3);
  assert.equal(first.from, 1);
  assert.equal(first.to, 25);

  const last = await themes.listSuggestions(client, { pageSize: '25', page: '3' });
  assert.equal(last.suggestions.length, 24);
  assert.equal(last.to, 74);

  const byUsage = await themes.listSuggestions(client, { pageSize: '10', sort: 'usage' });
  assert.equal(byUsage.suggestions[0].usage_count, 73);
  assert.equal(byUsage.suggestions.length, 10);

  const filtered = await themes.listSuggestions(client, { pageSize: '10', q: 'téma 7' });
  assert.equal(filtered.total, 4);
  assert.equal(filtered.page, 1);

  await assert.rejects(() => themes.listSuggestions(client, { pageSize: '7' }), (error) => error.status === 400);
});

test('the planner remembers the chosen suggestion id and drops it when the theme is edited by hand', () => {
  assert.match(FORM_JS, /data-theme-id=/);
  assert.match(FORM_JS, /selectedThemeSuggestion/);
  assert.match(FORM_JS, /themeSuggestionId: getThemeSuggestionId\(\)/);
  assert.match(FORM_JS, /function bindThemeSuggestionReset/);
});
