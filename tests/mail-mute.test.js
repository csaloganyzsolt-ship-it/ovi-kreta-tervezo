const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./fixtures');
const nodemailer = require('nodemailer');
const mail = require('../backend/services/mailService');

const smtp = { SMTP_HOST: 'smtp.invalid.example', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'OviTervező <info@example.com>' };
const purchase = { to: 'vevo@example.com', plan: 'daily', attachments: [{ filename: 'a.docx', content: Buffer.from('x') }], invoicePdf: Buffer.from('%PDF'), invoiceName: 'szamla.pdf', title: 'Téma', orderNumber: 'OVITE-1' };

// Minden küldést figyelő csapda: ha a nodemailer valódi transportja létrejönne, a teszt elbukik.
function trapNodemailer(t) {
  const original = nodemailer.createTransport;
  const created = [];
  nodemailer.createTransport = (options) => { created.push(options); return { sendMail: async () => ({ response: 'trap' }) }; };
  t.after(() => { nodemailer.createTransport = original; });
  return created;
}

test('the whole test run has NODE_ENV=test, so mail is muted by default', () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(mail.isMailMocked(), true);
});

test('under NODE_ENV=test every mail function only simulates success and never opens a real SMTP transport', async (t) => {
  const created = trapNodemailer(t);
  mail.mockOutbox.length = 0;
  const env = { ...smtp, NODE_ENV: 'test', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' };

  const info = await mail.sendPurchaseEmail(purchase, { env });
  assert.match(info.response, /mock/);
  const noInvoice = await mail.sendPurchaseEmail({ ...purchase, to: 'teszt@example.com', invoicePdf: undefined }, { env });
  assert.match(noInvoice.response, /mock/);
  assert.deepEqual(await mail.sendAdminNotification({ customer: { email: 'vevo@example.com' }, plan: 'daily', orderNumber: 'OVITE-1', invoicePdf: Buffer.from('%PDF') }, { env }), { sent: true });
  assert.deepEqual(await mail.sendFeedbackNotification(env, { rating: 5, email: 'vevo@example.com', comment: 'Szuper' }), { sent: true });

  assert.equal(created.length, 0, 'nodemailer.createTransport nem hívódott');
  assert.deepEqual(mail.mockOutbox.map((entry) => entry.to), ['vevo@example.com', 'teszt@example.com', 'admin@example.com', 'admin@example.com']);
  assert.ok(mail.mockOutbox[0].attachments.includes('a.docx') && mail.mockOutbox[0].attachments.includes('szamla.pdf'));
});

test('outside the test environment the real SMTP transport is still used', async (t) => {
  const created = trapNodemailer(t);
  await mail.sendPurchaseEmail(purchase, { env: { ...smtp, NODE_ENV: 'production' } });
  assert.equal(created.length, 1);
  assert.equal(created[0].host, 'smtp.invalid.example');
});

test('the npm test script and the fixtures force NODE_ENV=test', () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts.test, /NODE_ENV=test node scripts\/check-site\.js/);
  assert.match(pkg.scripts.test, /NODE_ENV=test node --test/);
});
