'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'barion-pixel.js'), 'utf8');
const pricingSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pricing-ui.js'), 'utf8');
const PRICING = { daily: 390, weekly_summary: 590, weekly_extra_day: 100, academic_daily: 690, academic_weekly: 690 };

function pixelWindow({ ba, pathname = '/', pricing = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: `http://localhost${pathname}`, runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  if (ba !== 'blocked') window.bp = ba || function bp() { calls.push([...arguments]); };
  window.eval(pricingSource);
  if (pricing) window.OviPricing.setPricing(PRICING);
  window.eval(source);
  return { window, calls };
}

test('Full Barion Pixel: contentView a tervező megnyitásakor a dinamikus árakkal (nincs beégetett ár)', async () => {
  const { window, calls } = pixelWindow({ pathname: '/tervezo.html', pricing: true });
  if (window.document.readyState === 'loading') await new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve));
  const view = calls.find((c) => c[1] === 'contentView');
  assert.ok(view);
  assert.equal(view[0], 'track');
  assert.equal(view[2].currency, 'HUF');
  assert.equal(JSON.stringify(view[2].contents.map((c) => c.unitPrice)), '[390,590,1090,690]');
  assert.doesNotMatch(source, /\b(390|590|690|890|1090)\b/, 'a pixel forrásában nincs beégetett ár');
});

test('Full Barion Pixel: árak nélkül nem megy el a contentView, az árak betöltése után egyszer igen', async () => {
  const { window, calls } = pixelWindow({ pathname: '/tervezo.html' });
  const errors = [];
  window.console.error = (message) => errors.push(String(message));
  assert.equal(calls.length, 0);
  assert.equal(window.barionPixel.contentView(), false);
  assert.ok(errors.length >= 1);
  window.OviPricing.setPricing(PRICING);
  window.OviPricing.setPricing(PRICING);
  assert.equal(calls.filter((c) => c[1] === 'contentView').length, 1);
});

test('Full Barion Pixel: addToCart és initiateCheckout adatai', () => {
  const { window, calls } = pixelWindow();
  const item = { id: 'weekly_detailed', name: 'Heti részletes csomag', price: 890 };
  assert.equal(window.barionPixel.addToCart(item), true);
  assert.equal(window.barionPixel.initiateCheckout(item), true);
  const cart = calls[0][2];
  assert.equal(calls[0][1], 'addToCart');
  assert.equal(cart.currency, 'HUF');
  assert.deepEqual(JSON.parse(JSON.stringify(cart.contents[0])), { id: 'weekly_detailed', name: 'Heti részletes csomag', quantity: 1, unitPrice: 890, price: 890, currency: 'HUF' });
  const checkout = calls[1][2];
  assert.equal(calls[1][1], 'initiateCheckout');
  assert.equal(checkout.step, 1);
  assert.ok(checkout.stepDescription);
  assert.equal(checkout.totalItemPrice, 890);
});

test('Full Barion Pixel: purchase egyszer megy el, frissítésre sem duplikálódik', () => {
  const { window, calls } = pixelWindow();
  const order = { id: 'bp_session_1', itemId: 'daily', name: 'Napi tervezet', price: 390 };
  assert.equal(window.barionPixel.purchase(order), true);
  assert.equal(window.barionPixel.purchase(order), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'purchase');
  assert.equal(calls[0][2].id, 'bp_session_1');
  assert.equal(calls[0][2].revenue, 390);
  assert.equal(calls[0][2].currency, 'HUF');
  assert.equal(calls[0][2].contents[0].id, 'daily');
  assert.equal(window.barionPixel.purchase({ id: '', price: 390 }), false);
  assert.equal(window.barionPixel.purchase({ id: 'x', price: 0 }), false);
});

test('Full Barion Pixel: blokkolt Pixel (nincs bp) vagy hibát dobó bp esetén sem törik el semmi', () => {
  const blocked = pixelWindow({ ba: 'blocked', pathname: '/tervezo.html' });
  assert.equal(blocked.window.barionPixel.contentView(), false);
  assert.equal(blocked.window.barionPixel.purchase({ id: 'p1', itemId: 'daily', name: 'N', price: 390 }), false);
  const throwing = pixelWindow({ ba() { throw new Error('blocked'); } });
  assert.equal(throwing.window.barionPixel.addToCart({ id: 'daily', name: 'N', price: 390 }), false);
  assert.deepEqual(JSON.parse(throwing.window.localStorage.getItem('oviKretaBarionPurchases') || '[]'), []);
  assert.equal(throwing.window.barionPixel.purchase({ id: 'p2', itemId: 'daily', name: 'N', price: 390 }), false);
});

test('Full Barion Pixel: CSP engedi a pixel.barion.com szkript-, kapcsolat-, keret- és képkéréseket, az adatvédelmi tájékoztató említi', () => {
  const { CONTENT_SECURITY_POLICY } = require('../backend/services/siteConstants');
  for (const directive of ['script-src', 'connect-src', 'frame-src', 'img-src']) {
    assert.match(CONTENT_SECURITY_POLICY.split(';').find((d) => d.trim().startsWith(directive)), /https:\/\/pixel\.barion\.com/, directive);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'site.js'), 'utf8'), /Teljes \(Full\) Barion Pixel/);
});
