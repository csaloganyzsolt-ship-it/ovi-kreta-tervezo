const assert = require('node:assert/strict');
const { test } = require('node:test');
const settingsService = require('../backend/services/settingsService');
const mailService = require('../backend/services/mailService');

// Minimális email_templates tábla: select, insert, upsert, delete/eq.
function fakeClient(initial = []) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const client = {
    rows,
    from(table) {
      assert.equal(table, 'email_templates');
      return {
        select: async () => ({ data: [...rows.values()], error: null }),
        insert: async (payload) => {
          if (rows.has(payload.id)) return { error: { code: '23505', message: 'duplicate key value' } };
          rows.set(payload.id, { ...payload });
          return { error: null };
        },
        upsert: async (payload) => { rows.set(payload.id, { ...rows.get(payload.id), ...payload }); return { error: null }; },
        delete: () => ({ eq: async (_column, id) => { rows.delete(id); return { error: null }; } })
      };
    }
  };
  return client;
}

const VALID = { id: 'husvet_level', name: 'Húsvéti levél', subject: 'Boldog húsvétot, {{topic}}!', bodyHtml: '<p>Szia {{topic}}</p>' };

test('a custom template can be created, listed and deleted', async () => {
  const client = fakeClient();
  const created = await settingsService.createTemplate(client, VALID);
  assert.equal(created.custom, true);
  assert.equal(client.rows.get('husvet_level').is_system, false);
  const listed = await settingsService.listTemplates(client);
  assert.ok(listed.some((row) => row.id === 'husvet_level' && row.name === 'Húsvéti levél'));
  assert.ok(listed.some((row) => row.id === 'invoice_only'), 'a beépített invoice_only akkor is listázódik, ha még nincs a táblában');
  assert.deepEqual(await settingsService.deleteTemplate(client, 'husvet_level'), { id: 'husvet_level' });
  assert.equal(client.rows.has('husvet_level'), false);
});

test('template creation validates the slug and rejects system or duplicate ids', async () => {
  const client = fakeClient();
  await assert.rejects(settingsService.createTemplate(client, { ...VALID, id: 'Rossz Id!' }), (error) => error.status === 400);
  await assert.rejects(settingsService.createTemplate(client, { ...VALID, id: 'invoice_only' }), (error) => error.status === 409);
  await settingsService.createTemplate(client, VALID);
  await assert.rejects(settingsService.createTemplate(client, VALID), (error) => error.status === 409);
});

test('system templates cannot be deleted, unknown ones give 404, and defaults can be reset', async () => {
  const client = fakeClient([{ id: 'invoice_only', subject: 'Módosított', body_html: '<p>x</p>' }]);
  await assert.rejects(settingsService.deleteTemplate(client, 'invoice_only'), (error) => error.status === 409);
  await assert.rejects(settingsService.deleteTemplate(client, 'nincs_ilyen'), (error) => error.status === 404);
  const reset = await settingsService.resetTemplate(client, 'invoice_only');
  assert.equal(reset.subject, 'Számlája elkészült – OviTervező ({{invoiceNumber}})');
  assert.equal(client.rows.get('invoice_only').subject, reset.subject);
  await assert.rejects(settingsService.resetTemplate(client, 'base_layout'), (error) => error.status === 409);
});

test('the invoice_only default has no draft attachment table and no .docx tip', () => {
  const body = settingsService.DEFAULT_TEMPLATES.invoice_only.bodyHtml;
  assert.match(body, /Csatolmány: Számla \(PDF\)/);
  assert.doesNotMatch(body, /\.docx|attachments_rows/);
});

const TEMPLATES = {
  base_layout: { id: 'base_layout', subject: 'Keret', bodyHtml: '<html><body>{{content}}</body></html>' },
  payment_success: { id: 'payment_success', subject: 'Köszönjük a fizetést!', bodyHtml: '<p>{{planLabel}}</p>{{attachments_rows}}<p>Tipp: .docx</p>' },
  invoice_only: { id: 'invoice_only', ...settingsService.DEFAULT_TEMPLATES.invoice_only }
};

async function sendWith(options) {
  const sent = [];
  const transport = { async sendMail(message) { sent.push(message); return { messageId: 'x' }; } };
  await mailService.sendPurchaseEmail({ to: 'vevo@example.com', plan: 'daily', invoicePdf: Buffer.from('%PDF'), title: 'Erdő', orderNumber: 'OVI-5', invoiceNumber: 'OVITE-1', ...options }, { env: { FEEDBACK_SECRET: 'unit-secret', NODE_ENV: 'test' }, transport, templates: TEMPLATES });
  return sent[0];
}

test('a delivery with only an invoice automatically uses the invoice_only template', async () => {
  const message = await sendWith({ attachments: [] });
  assert.match(message.subject, /Számlája elkészült – OviTervező \(OVITE-1\)/);
  assert.match(message.html, /Számlaszám: <strong>OVITE-1/);
  assert.doesNotMatch(message.html, /\.docx|Mellékletek|e-számla/i);
  assert.deepEqual(message.attachments.filter((a) => /\.pdf$/i.test(a.filename || '')).length, 1);
  assert.equal(message.attachments.some((a) => /\.docx$/i.test(a.filename || '')), false);
});

test('a delivery with draft attachments keeps the full package template', async () => {
  const message = await sendWith({ attachments: [{ filename: 'tervezet.docx', content: Buffer.from('x') }] });
  assert.doesNotMatch(message.subject, /Számlája elkészült/);
  assert.match(message.html, /Tipp:/);
  assert.ok(message.attachments.length >= 2);
});

test('an unknown explicit templateId fails instead of silently sending a wrong mail', async () => {
  await assert.rejects(sendWith({ attachments: [], templateId: 'nincs_ilyen' }), (error) => error.status === 404);
});
