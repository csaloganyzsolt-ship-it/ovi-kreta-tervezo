const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const server = require('../server');
const supabase = require('../services/supabaseService');
const settingsService = require('../services/settingsService');
const barionService = require('../services/barionService');
const mailService = require('../services/mailService');
const invoiceService = require('../services/invoiceService');
const { productFor } = require('../services/pricing');

const DB_PRICING = { standard: 555, academic: 777, weekly: 1999 };
const TEMPLATE_ROWS = [
  { id: 'base_layout', subject: 'Keret', body_html: '<html><body><div class="keret">{{content}}</div></body></html>' },
  { id: 'payment_success', subject: 'Köszönjük a fizetést!', body_html: '<h1>DB-s sablon</h1><p>{{planLabel}}{{invoiceText}}</p>{{title_block}}{{order_block}}' },
  { id: 'welcome_email', subject: 'Üdv', body_html: '<p>Üdv</p>' },
  { id: 'password_reset', subject: 'Jelszó', body_html: '<p>{{action_url}}</p>' }
];

// Mockolt Supabase kliens: system_settings és email_templates táblák, minden más írás elnyelt.
function fakeDb(t, { settings = {}, templates = TEMPLATE_ROWS, failSettings = false } = {}) {
  const store = { system_settings: { ...settings }, email_templates: Object.fromEntries(templates.map((row) => [row.id, { ...row }])) };
  const calls = { settingsReads: 0, upserts: [] };
  const client = {
    from(table) {
      return {
        select() {
          if (table === 'system_settings') {
            calls.settingsReads += 1;
            if (failSettings) return Promise.resolve({ data: null, error: { message: 'db down' } });
            return Promise.resolve({ data: Object.entries(store.system_settings).map(([key, value]) => ({ key, value })), error: null });
          }
          if (table === 'email_templates') return Promise.resolve({ data: Object.values(store.email_templates), error: null });
          return Promise.resolve({ data: [], error: null });
        },
        async upsert(rows) {
          calls.upserts.push({ table, rows });
          for (const row of [].concat(rows)) {
            if (table === 'system_settings') store.system_settings[row.key] = row.value;
            if (table === 'email_templates') store.email_templates[row.id] = row;
          }
          return { error: null };
        },
        async insert() { return { error: null }; }
      };
    }
  };
  settingsService.invalidate();
  supabase.setClient(client);
  t.after(() => { supabase.resetClient(); settingsService.invalidate(); });
  return { store, calls };
}

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function paymentEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovi-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    NODE_ENV: 'test', BARION_POS_KEY_EV: 'pos-key', BARION_TEST_MODE: 'true', BARION_PAYEE_EMAIL: 'bolt@ovitervezo.hu',
    FRONTEND_URL: 'https://ovitervezo.hu', BACKEND_URL: 'https://api.ovitervezo.test', INVOICE_STORE_PATH: path.join(dir, 'store.json')
  };
}

const BILLING = { name: 'Minta Kft.', zip: '9021', city: 'Győr', address: 'Fő utca 1.' };

// ---------- 1. Fizetés: az ár az adatbázisból jön ----------

test('payment takes the price from system_settings and ignores any client-supplied price, for Barion and for the invoice', async (t) => {
  fakeDb(t, { settings: { pricing: DB_PRICING } });
  const env = paymentEnv(t);
  const sent = [];
  const fetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname === '/v2/Payment/Start') {
      const body = JSON.parse(options.body);
      sent.push(body);
      return Response.json({ PaymentId: 'abcdef0123456789abcdef0123456789', PaymentRequestId: body.PaymentRequestId, Status: 'Prepared', GatewayUrl: 'https://secure.test.barion.com/Pay?id=abcdef0123456789abcdef0123456789', Errors: [] });
    }
    const request = sent[0];
    return Response.json({ PaymentId: 'abcdef0123456789abcdef0123456789', PaymentRequestId: request.PaymentRequestId, Status: 'Succeeded', Total: request.Transactions[0].Total, Currency: 'HUF', Errors: [] });
  };

  const started = await barionService.startPayment({
    plan: 'daily', planMode: 'standard', email: 'vevo@example.com', billing: BILLING, generationId: 'gen_settings_1', title: 'Teszt',
    amountHuf: 1, price: 1, amount: 1, total: 1, unitPrice: 1
  }, { env, fetch });
  assert.equal(started.amountHuf, 555, 'a standard ár a DB-ből jön');
  assert.equal(sent[0].Transactions[0].Total, 555);
  assert.equal(sent[0].Transactions[0].Items[0].UnitPrice, 555);

  const invoices = [];
  await barionService.handleCallback('abcdef0123456789abcdef0123456789', {
    env, fetch,
    issueInvoice: async (data) => { invoices.push(data); return { invoiceNumber: 'OVITE-1', pdf: Buffer.from('%PDF') }; }
  });
  assert.equal(invoices[0].amountHuf, 555, 'ugyanez az összeg megy a számlázóhoz');
  assert.match(invoiceService.buildInvoiceXml({ ...invoices[0], orderId: 'x', created: 1 }, env), />555</);
});

test('package prices follow the three tiers of system_settings', async (t) => {
  fakeDb(t, { settings: { pricing: DB_PRICING } });
  await settingsService.getSettings({ force: true });
  assert.equal(productFor('daily', 'standard').amountHuf, 555);
  assert.equal(productFor('weekly', 'standard').amountHuf, 555);
  assert.equal(productFor('weekly_detailed', 'standard').amountHuf, 1999);
  assert.equal(productFor('daily', 'academic').amountHuf, 777);
  assert.equal(productFor('academic_weekly', 'standard').amountHuf, 777);
});

test('the settings cache refreshes after 5 minutes or immediately after an admin update', async (t) => {
  const { calls, store } = fakeDb(t, { settings: { pricing: DB_PRICING } });
  await settingsService.getSettings();
  await settingsService.getSettings();
  assert.equal(calls.settingsReads, 1, 'a második lekérés gyorsítótárból jön');

  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + settingsService.CACHE_TTL_MS + 1000;
  await settingsService.getSettings();
  assert.equal(calls.settingsReads, 2, '5 perc után újratölt');
  Date.now = realNow;

  const updated = await settingsService.updateSettings(supabase.getClient(), { pricing: { standard: 450 } });
  assert.equal(updated.pricing.standard, 450);
  assert.equal(settingsService.peek().pricing.standard, 450, 'a módosítás azonnal érvényes');
  assert.equal(store.system_settings.pricing.standard, 450);
});

test('settings updates are validated', async (t) => {
  fakeDb(t);
  const client = supabase.getClient();
  await assert.rejects(settingsService.updateSettings(client, { pricing: { standard: -5 } }), /ár egész szám/);
  await assert.rejects(settingsService.updateSettings(client, { pricing: { vip: 100 } }), /Ismeretlen csomag/);
  await assert.rejects(settingsService.updateSettings(client, { ai_config: { model: 'rossz modell!' } }), /Érvénytelen modellnév/);
  await assert.rejects(settingsService.updateSettings(client, { maintenance_mode: 'igen' }), /igaz\/hamis/);
  await assert.rejects(settingsService.updateSettings(client, { rendszer: 1 }), /Ismeretlen beállítás/);
});

test('a failing settings database surfaces as an error instead of a silent default', async (t) => {
  fakeDb(t, { failSettings: true });
  await assert.rejects(settingsService.getSettings({ force: true }), (error) => error.status === 503 && /db down/.test(error.message));
});

// ---------- 2. Karbantartás és AI konfiguráció ----------

test('maintenance mode blocks generation with a polite 503 before any model call', async (t) => {
  fakeDb(t, { settings: { maintenance_mode: true } });
  const base = await listen(t);
  const realFetch = global.fetch;
  let modelCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('generativelanguage.googleapis.com')) { modelCalls += 1; }
    return realFetch(url, options);
  };
  t.after(() => { global.fetch = realFetch; });

  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Őszi erdő', group: 'Nagycsoport', duration: 'Napi' }) });
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.success, false);
  assert.equal(data.code, 'MAINTENANCE_MODE');
  assert.match(data.error, /karbantartás/i);
  assert.equal(modelCalls, 0);
});

test('callGemini sends the configured system prompt and the supported model', async () => {
  const { callGemini } = require('../services/geminiService');
  let request;
  const fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] });
  };
  await callGemini('kérés', { model: 'gemini-2.5-flash', systemPrompt: 'Egyedi admin prompt.' }, { env: { GEMINI_API_KEY: 'k' }, fetch });
  assert.match(request.url, /models\/gemini-2\.5-flash:/);
  assert.match(request.body.systemInstruction.parts[0].text, /^Egyedi admin prompt\./);
  await assert.rejects(callGemini('kérés', { model: 'rossz modell!' }, { env: { GEMINI_API_KEY: 'k' }, fetch }), /Érvénytelen modellnév/);
});

test('the AI model comes from the settings and a malformed name falls back loudly', () => {
  assert.equal(settingsService.resolveAiModel({ ai_config: { model: 'gemini-2.5-pro' } }, 'x'), 'gemini-2.5-pro');
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(settingsService.resolveAiModel({ ai_config: { model: 'rossz modell!' } }, 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
  } finally { console.warn = warn; }
  assert.match(warnings[0], /érvénytelen/);
});

// ---------- 3. Publikus konfiguráció ----------

test('GET /api/config exposes only public data and never the system prompt', async (t) => {
  fakeDb(t, { settings: { pricing: DB_PRICING, maintenance_mode: true, seasonal_hints: ['hó', 'szél'], ai_config: { model: 'gemini-2.5-pro', system_prompt: 'TITKOS PROMPT' } } });
  const base = await listen(t);
  const response = await fetch(`${base}/api/config`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(data, { success: true, pricing: DB_PRICING, maintenance_mode: true, seasonal_hints: ['hó', 'szél'] });
  assert.equal(JSON.stringify(data).includes('TITKOS'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

// ---------- 4. E-mail sablonok ----------

test('the purchase e-mail is composed from the payment_success template inside the base_layout', async (t) => {
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: 'x' }; } };
  const templates = Object.fromEntries(TEMPLATE_ROWS.map((row) => [row.id, { id: row.id, subject: row.subject, bodyHtml: row.body_html }]));
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', attachments: [], invoicePdf: Buffer.from('%PDF'), title: 'Őszi <erdő>', orderNumber: 'OVI-1' }, { env: { NODE_ENV: 'test' }, transport, templates });
  assert.equal(sent[0].subject, 'Köszönjük a fizetést!');
  assert.match(sent[0].html, /<div class="keret"><h1>DB-s sablon<\/h1>/);
  assert.match(sent[0].html, /napi tervezet Az e-számlát is mellékeltük/);
  assert.match(sent[0].html, /Őszi &lt;erdő&gt;/, 'a változók escape-eltek');
  assert.match(sent[0].html, /Rendelésszám: <strong>OVI-1/);
  assert.equal(sent[0].html.includes('{{'), false);
});

test('the e-mail sender reads the templates from the database', async (t) => {
  fakeDb(t);
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: 'x' }; } };
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', attachments: [], invoicePdf: Buffer.from('%PDF') }, { env: { NODE_ENV: 'test' }, transport });
  assert.match(sent[0].html, /class="keret"/);
  assert.equal(sent[0].subject, 'Köszönjük a fizetést!');
});

test('composeEmail needs the base_layout and a {{content}} placeholder is enforced on save', async (t) => {
  assert.throws(() => settingsService.composeEmail({ payment_success: { bodyHtml: 'x', subject: '' } }, 'payment_success'), /base_layout/);
  fakeDb(t);
  const client = supabase.getClient();
  await assert.rejects(settingsService.updateTemplate(client, 'base_layout', { subject: 'x', bodyHtml: '<p>nincs helyőrző</p>' }), /\{\{content\}\}/);
  const saved = await settingsService.updateTemplate(client, 'welcome_email', { subject: 'Új tárgy', bodyHtml: '<p>Új</p>' });
  assert.equal(saved.subject, 'Új tárgy');
  await assert.rejects(settingsService.updateTemplate(client, 'ismeretlen', { subject: 'x', bodyHtml: 'y' }), /Ismeretlen/);
});

test('the migration enables RLS on both tables and seeds the defaults', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261126090000_system_settings.sql'), 'utf8');
  assert.match(sql, /alter table public\.system_settings enable row level security/);
  assert.match(sql, /alter table public\.email_templates enable row level security/);
  for (const id of ['base_layout', 'welcome_email', 'payment_success', 'password_reset']) assert.ok(sql.includes(`'${id}'`), id);
  assert.match(sql, /\{\{content\}\}/);
  assert.match(sql, /on conflict \(key\) do update/);
});

test('admin settings routes are protected', async (t) => {
  const base = await listen(t);
  for (const [method, route] of [['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings'], ['GET', '/api/admin/email-templates'], ['PATCH', '/api/admin/email-templates/welcome_email']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PATCH' ? '{}' : undefined });
    assert.ok([401, 403, 503].includes(response.status), `${method} ${route} -> ${response.status}`);
  }
});

const MIGRATION_SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261126090000_system_settings.sql'), 'utf8');
const migrationTemplates = () => Object.fromEntries([...MIGRATION_SQL.matchAll(/\('(\w+)', '([^']*)', \$tpl\$([\s\S]*?)\$tpl\$\)/g)].map((m) => [m[1], { id: m[1], subject: m[2], bodyHtml: m[3] }]));

test('the migration seeds the real model, the full original prompt and the real templates with upsert', () => {
  const prompt = MIGRATION_SQL.match(/\$prompt\$([\s\S]*?)\$prompt\$/)[1];
  assert.equal(prompt, settingsService.DEFAULT_SETTINGS.ai_config.system_prompt);
  assert.match(MIGRATION_SQL, /'model', 'gemini-3\.1-pro-preview'/);
  assert.ok(prompt.length > 3000 && prompt.includes('kidolgozas_tablazat') && prompt.includes('mester-óvodapedagógus'));
  assert.equal(MIGRATION_SQL.includes('gpt-4o'), false);
  assert.match(MIGRATION_SQL, /on conflict \(id\) do update set subject = excluded\.subject, body_html = excluded\.body_html/);
  const templates = migrationTemplates();
  assert.deepEqual(Object.keys(templates).sort(), ['base_layout', 'password_reset', 'payment_success', 'welcome_email']);
  assert.ok(templates.base_layout.bodyHtml.includes('{{content}}') && templates.base_layout.bodyHtml.includes('{{unsubscribe_link}}'));
  assert.ok(templates.welcome_email.bodyHtml.includes('Fiók aktiválása'));
  assert.ok(templates.password_reset.bodyHtml.includes('Új jelszó megadása'));
  assert.ok(templates.payment_success.bodyHtml.includes('{{attachments_rows}}') && templates.payment_success.bodyHtml.includes('Mellékletek'));
  assert.equal(/lorem/i.test(MIGRATION_SQL), false);
});

test('the sync script prints the idempotent seed section of the migration', () => {
  const { seedSql } = require('../scripts/sync-system-settings');
  const sql = seedSql();
  assert.match(sql, /^-- SEED-KEZDET/);
  assert.match(sql, /on conflict \(key\) do update/);
  assert.equal(sql.includes('create table'), false);
});

test('seasonal hints are separated by semicolons so a hint may contain commas', async (t) => {
  const { store } = fakeDb(t);
  const saved = await settingsService.updateSettings(supabase.getClient(), { seasonal_hints: 'Őszi termések gyűjtése, falevelek préselése; Márton-napi lámpás;' });
  assert.deepEqual(saved.seasonal_hints, ['Őszi termések gyűjtése, falevelek préselése', 'Márton-napi lámpás']);
  assert.deepEqual(store.system_settings.seasonal_hints, ['Őszi termések gyűjtése, falevelek préselése', 'Márton-napi lámpás']);
});

test('the newsletter is rendered into the base_layout with the recipient unsubscribe link, also when the layout forgets the placeholder', () => {
  const newsletter = require('../services/newsletterService');
  const templates = migrationTemplates();
  const input = { heading: 'Szia', bodyHtml: '<p>Hír</p>', ctaText: 'Gomb', ctaUrl: 'https://ovitervezo.hu/x' };
  const url = newsletter.unsubscribeUrlFor('tok-1');
  const html = newsletter.renderNewsletter(templates, input, { unsubscribeUrl: url, env: { NODE_ENV: 'test' } });
  assert.ok(html.includes('cid:ovitervezo-logo') && html.includes('<h1 style="margin:0 0 14px;font-size:22px;color:#1f5f52;">Szia</h1>'));
  assert.ok(html.includes(`href="${url}"`) && html.includes('Leiratkozás egy kattintással'));
  assert.equal(html.includes('{{'), false);
  const bare = { ...templates, base_layout: { ...templates.base_layout, bodyHtml: '<html><body>{{content}}</body></html>' } };
  const forced = newsletter.renderNewsletter(bare, input, { unsubscribeUrl: url, env: { NODE_ENV: 'test' } });
  assert.ok(forced.includes(`href="${url}"`), 'a leiratkozó link sablontól függetlenül bekerül');
  assert.equal(newsletter.extractCampaign(html).heading, 'Szia');
  assert.equal(newsletter.extractCampaign(html).ctaUrl, 'https://ovitervezo.hu/x');
});

test('the newsletter preview and the payment e-mail use the same base_layout from the database', async (t) => {
  const rows = Object.values(migrationTemplates()).map((row) => ({ id: row.id, subject: row.subject, body_html: row.bodyHtml }));
  fakeDb(t, { templates: rows });
  const newsletter = require('../services/newsletterService');
  const preview = await newsletter.buildPreview({ heading: 'Cím', bodyHtml: 'Szöveg' }, { NODE_ENV: 'test' });
  assert.ok(preview.includes('data:image/png;base64,') && preview.includes('leiratkozas.html?token='));
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: 'x' }; } };
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', attachments: [], invoicePdf: Buffer.from('%PDF'), title: 'Erdő', orderNumber: 'OVI-9' }, { env: { NODE_ENV: 'test' }, transport });
  assert.ok(sent[0].html.includes('Kibocsátó:') && sent[0].html.includes('Mellékletek') && sent[0].html.includes('OVI-9'));
  assert.equal(sent[0].html.includes('Leiratkozás'), false, 'a fizetési levélben nincs leiratkozó mondat');
  assert.equal(sent[0].html.includes('{{'), false);
});

test('the AI model is a free text field: any valid model name is accepted, malformed ones are rejected', async (t) => {
  fakeDb(t);
  const client = supabase.getClient();
  const saved = await settingsService.updateSettings(client, { ai_config: { model: 'gemini-1.5-flash' } });
  assert.equal(saved.ai_config.model, 'gemini-1.5-flash');
  assert.equal(settingsService.resolveAiModel(saved, 'x'), 'gemini-1.5-flash');
  await assert.rejects(settingsService.updateSettings(client, { ai_config: { model: 'a/b?key=1' } }), /Érvénytelen modellnév/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(html, /<input id="setAiModel" type="text"/);
});

test('the real payment_success and base_layout carry the original structure and placeholders', async () => {
  const templates = migrationTemplates();
  const layout = templates.base_layout.bodyHtml;
  for (const needle of ['#d8f0e3', 'OT', 'Kibocsátó:', '{{company_legal}}', 'Adatkezelési tájékoztató', 'ÁSZF', '{{site_url}}', '#f6f7f7']) assert.ok(layout.includes(needle), needle);
  const pay = templates.payment_success.bodyHtml;
  for (const needle of ['Kedves Kolléganő!', '{{topic}}', 'Rendelésszám: <strong>{{orderId}}', 'Mellékletek', '{{attachments_rows}}', 'Tipp:', 'Új tervezet készítése', '{{feedback_block}}']) assert.ok(pay.includes(needle), needle);
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: 'x' }; } };
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', attachments: [], invoicePdf: Buffer.from('%PDF'), title: 'Őszi <erdő>', orderNumber: 'OVI-77' }, { env: { NODE_ENV: 'test' }, transport, templates });
  const html = sent[0].html;
  assert.match(html, /Tervezet témája:<\/strong> Őszi &lt;erdő&gt;/);
  assert.match(html, /Rendelésszám: <strong>OVI-77/);
  assert.ok(html.includes('Tervezet Word</strong> (.docx) formátumban') && html.includes('Tervezet PDF</strong> formátumban') && html.includes('ertekeles.html?rating=5'));
  assert.equal(html.includes('{{'), false);
});
