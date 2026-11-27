const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { normalizeHuTaxNumber } = require('../backend/utils/taxNumber');
const invoiceService = require('../backend/services/invoiceService');
const { unsubscribeHeaders } = require('../backend/services/newsletterService');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const order = (customer) => ({ plan: 'daily', orderId: 'cs_test_1', customer: { email: 'ovi@example.com', ...customer } });
const ENV = { SZAMLAZZ_KEY: 'k' };

test('Hungarian tax numbers: 8 digit, 11 digit and dashed forms normalise, bad check digits are refused', () => {
  assert.equal(normalizeHuTaxNumber('68274568'), '68274568');
  assert.equal(normalizeHuTaxNumber('68274568-1-28'), '68274568-1-28');
  assert.equal(normalizeHuTaxNumber('68274568128'), '68274568-1-28');
  assert.equal(normalizeHuTaxNumber(''), '');
  assert.equal(normalizeHuTaxNumber('68274569-1-28'), null);
  assert.equal(normalizeHuTaxNumber('abc'), null);
});

test('the invoice XML carries the institution tax number and the billing address, and no adoszam without one', () => {
  const xml = invoiceService.buildInvoiceXml(order({ name: 'Minta Óvoda', zip: '9021', city: 'Győr', address: 'Fő utca 12/B.', taxNumber: '68274568-1-28' }), ENV);
  assert.match(xml, /<adoszam>68274568-1-28<\/adoszam>/);
  assert.match(xml, /<irsz>9021<\/irsz>/);
  assert.match(xml, /<telepules>Győr<\/telepules>/);
  assert.match(xml, /<cim>Fő utca 12\/B\.<\/cim>/);
  assert.match(xml, /<eszamla>false<\/eszamla>/, 'papíralapú (PDF) számla, nem e-számla');
  const plain = invoiceService.buildInvoiceXml(order({ name: 'Magánszemély', zip: '9021', city: 'Győr', address: 'Fő utca 1.' }), ENV);
  assert.doesNotMatch(plain, /<adoszam>/);
});

test('newsletter mails carry the RFC 8058 one-click List-Unsubscribe headers when a backend URL is known', () => {
  const headers = unsubscribeHeaders('tok-1', { BACKEND_URL: 'https://api.ovitervezo.test', SUPPORT_EMAIL: 'info@ovitervezo.hu' });
  assert.match(headers['List-Unsubscribe'], /<https:\/\/api\.ovitervezo\.test\/api\/newsletter\/unsubscribe\?token=tok-1>/);
  assert.match(headers['List-Unsubscribe'], /<mailto:/);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const bare = unsubscribeHeaders(null, {});
  assert.equal('List-Unsubscribe-Post' in bare, false);
  assert.match(bare['List-Unsubscribe'], /^<mailto:/);
});

test('the legal texts name every processor, the paper invoice, the AI disclaimer and no dead ODR link', () => {
  const site = read('frontend', 'js', 'site.js');
  for (const name of ['Nethely Kft.', 'Render Services, Inc.', 'Supabase, Inc.', 'Google Ireland', 'Barion Payment Zrt.', 'KBOSS.hu Kft.', 'Cloudflare, Inc.']) {
    assert.ok(site.includes(name), `${name} hiányzik a jogi szövegekből`);
  }
  assert.match(site, /29\. § \(1\) bekezdés m\) pontja/);
  assert.match(site, /mesterséges intelligencia/i);
  assert.match(site, /papíralapú/i);
  assert.doesNotMatch(site, /ec\.europa\.eu\/consumers\/odr/);
  for (const page of ['index.html', 'tervezo.html']) {
    assert.doesNotMatch(read('frontend', page), /ec\.europa\.eu\/consumers\/odr/);
    assert.match(read('frontend', page), /data-legal="imprint"/);
  }
});

test('the in-app browser pattern catches Facebook, Messenger and Instagram but not Safari or Chrome', () => {
  const source = read('frontend', 'js', 'tervezo-export.js');
  const pattern = new RegExp(source.match(/IN_APP_BROWSER_PATTERN\s*=\s*\/(.+)\/([a-z]*);/)[1], 'i');
  for (const ua of ['Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/430.0]', 'Mozilla/5.0 (Linux; Android 13) Instagram 300.0', 'Mozilla/5.0 Messenger/400']) {
    assert.ok(pattern.test(ua), ua);
  }
  for (const ua of ['Mozilla/5.0 (iPhone) Version/17.0 Mobile Safari/604.1', 'Mozilla/5.0 Chrome/120.0 Safari/537.36']) {
    assert.ok(!pattern.test(ua), ua);
  }
});

test('the checkout consent boxes are mandatory and "check all" leaves the newsletter alone', () => {
  const planner = read('frontend', 'tervezo.html');
  assert.match(planner, /id="cb-terms"/);
  assert.match(planner, /id="cb-digital"/);
  assert.match(planner, /elveszítem a 14 napos elállási jogomat/);
  const paywall = read('frontend', 'js', 'tervezo-paywall.js');
  const block = paywall.match(/function checkAllConsents[\s\S]*?\n}/)[0];
  assert.doesNotMatch(block, /newsletter/i);
});
