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

const stats = require('../backend/services/themeStats');

test('themeStats counts custom and suggested themes together, case- and whitespace-insensitively', () => {
  const counts = stats.countThemes(['Márton-nap', ' márton-nap ', 'Márton-nap', 'Saját kirándulás', '', null, 'saját   kirándulás']);
  assert.equal(counts.get(stats.normalizeThemeKey('Márton-nap')).count, 3);
  assert.equal(counts.get(stats.normalizeThemeKey('Márton-nap')).title, 'Márton-nap');
  assert.equal(counts.get('saját kirándulás').count, 2);
  assert.equal(counts.size, 2);
  assert.deepEqual(stats.topThemes(counts, 1), [{ name: 'Márton-nap', count: 3 }]);
});

test('loadThemeCounts pages through documents and fails loudly on database errors', async () => {
  const pages = [Array.from({ length: 1000 }, () => ({ request: { theme: 'Ősz' } })), [{ request: { theme: 'ősz' } }, { request: null }]];
  let call = 0;
  const client = { from: (table) => { assert.equal(table, 'documents'); return { select: () => ({ order: () => ({ range: async () => ({ data: pages[call++], error: null }) }) }) }; } };
  assert.equal((await stats.loadThemeCounts(client)).get('ősz').count, 1001);
  const broken = { from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  await assert.rejects(() => stats.loadThemeCounts(broken), /boom/);
});

test('the usage column and the admin home Top themes use the same counts', async () => {
  const counts = stats.countThemes(['Márton-nap', 'márton-nap', 'Saját téma']);
  const client = { from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: [{ id: 'a', title: 'Márton-nap', category: 'event', priority: 90, is_active: true }], error: null }) }) }) }) };
  const list = await themes.listSuggestions(client, {}, counts);
  assert.equal(list.suggestions[0].usage_count, stats.topThemes(counts)[0].count);
  assert.equal(list.suggestions[0].usage_count, 2);
  const adminSource = read('backend', 'services', 'adminService.js');
  assert.match(adminSource, /topThemes: topThemes\(countThemes\(/);
  assert.match(read('backend', 'routes', 'admin.js'), /loadThemeCounts\(client\)/);
  assert.equal(/recordUsage|recordThemeUsage/.test(read('backend', 'server.js') + read('backend', 'services', 'themeSuggestionsService.js')), false);
});

test('the admin home tables fit their cards without horizontal scrolling', () => {
  assert.match(CSS, /\.admin-card-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(260px, 100%\), 1fr\)\)/);
  assert.match(CSS, /\.admin-card \.admin-table\s*\{[^}]*min-width:\s*0/);
  assert.match(CSS, /\.admin-card \.admin-table td:last-child[^{]*\{[^}]*white-space:\s*nowrap/);
  assert.match(CSS, /\.admin-card \.admin-table td:first-child[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
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

test('theme chip container in the planner is a flex-wrap box with a visible gap; the admin date preview is gone', () => {
  assert.match(CSS, /#themeSuggestions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*10px 12px/);
  assert.match(CSS, /\.theme-suggestions \.chip\s*\{[^}]*margin:\s*0/);
  assert.match(read('frontend', 'tervezo.html'), /class="theme-suggestions[^"]*" id="themeSuggestions"/);
  assert.equal(/Előnézet dátumra|themesPreview|admin-theme-preview|previewThemes/.test(ADMIN_HTML + ADMIN_JS + CSS), false);
});

const fakeListClient = (rows) => ({
  from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }) })
});

test('admin list pages the filtered rows, sorts by usage and validates the page size', async () => {
  const rows = Array.from({ length: 74 }, (_, i) => ({
    id: `id-${i}`, title: `Téma ${String(i).padStart(2, '0')}`, category: 'general', season: null, start_mmdd: null, end_mmdd: null, priority: 20, is_active: true, usage_count: i
  }));
  const client = fakeListClient(rows);
  const counts = new Map(rows.map((r) => [stats.normalizeThemeKey(r.title), { title: r.title, count: r.usage_count }]));

  const first = await themes.listSuggestions(client, { pageSize: '25' }, counts);
  assert.equal(first.suggestions.length, 25);
  assert.equal(first.total, 74);
  assert.equal(first.totalPages, 3);
  assert.equal(first.from, 1);
  assert.equal(first.to, 25);

  const last = await themes.listSuggestions(client, { pageSize: '25', page: '3' }, counts);
  assert.equal(last.suggestions.length, 24);
  assert.equal(last.to, 74);

  const byUsage = await themes.listSuggestions(client, { pageSize: '10', sort: 'usage' }, counts);
  assert.equal(byUsage.suggestions[0].usage_count, 73);
  assert.equal(byUsage.suggestions.length, 10);

  const filtered = await themes.listSuggestions(client, { pageSize: '10', q: 'téma 7' }, counts);
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
