'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const supabase = require('../services/supabaseService');
const logger = require('../utils/logger');
const { createApiLimiter } = require('../utils/rateLimits');
const server = require('../server');
const barionService = require('../services/barionService');

function fakeClient({ error } = {}) {
  const inserted = [];
  return { inserted, from(table) { return { async insert(row) { inserted.push({ table, row }); return { error: error || null }; } }; } };
}

function silence(t) {
  const original = { error: console.error, warn: console.warn, info: console.info };
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  t.after(() => Object.assign(console, original));
}

test('logger writes errors to system_logs with sanitised details and lowercase email', async (t) => {
  silence(t);
  const client = fakeClient();
  supabase.setClient(client);
  t.after(() => supabase.setClient(null));
  const ok = await logger.error('ai_generation', new Error('Gemini időtúllépés'), { email: 'Vevo@Example.com', details: { model: 'm', GEMINI_API_KEY: 'titok', apiToken: 'x', nested: { a: 1 } } });
  assert.equal(ok, true);
  const { table, row } = client.inserted[0];
  assert.equal(table, 'system_logs');
  assert.equal(row.level, 'error');
  assert.equal(row.context, 'ai_generation');
  assert.equal(row.message, 'Gemini időtúllépés');
  assert.equal(row.user_email, 'vevo@example.com');
  assert.deepEqual(Object.keys(row.details).sort(), ['model', 'nested']);
  await logger.warning('barion_payment', 'w');
  await logger.info('email_delivery', 'i');
  assert.deepEqual(client.inserted.slice(1).map((entry) => entry.row.level), ['warning', 'info']);
  await logger.log('bogus', 'x', 'y');
  assert.equal(client.inserted[3].row.level, 'error');
});

test('logger never throws: missing Supabase or a failing insert only reaches the console', async (t) => {
  silence(t);
  supabase.setClient(null);
  assert.equal(await logger.error('ai_generation', 'nincs adatbázis'), false);
  supabase.setClient(fakeClient({ error: { message: 'db down' } }));
  t.after(() => supabase.setClient(null));
  assert.equal(await logger.error('ai_generation', 'hibás insert'), false);
  supabase.setClient({ from() { throw new Error('boom'); } });
  assert.equal(await logger.error('ai_generation', 'kivétel'), false);
});

test('API rate limiter answers 429 after the limit and keys by client', async (t) => {
  const app = express();
  app.use(createApiLimiter({ limit: 3 }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  const instance = app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const url = `http://127.0.0.1:${instance.address().port}/ping`;
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  const blocked = await fetch(url);
  assert.equal((await blocked.json()).code, 'RATE_LIMITED');
});

test('generate limiter defaults to 20 requests per hour per IP', async () => {
  const saved = process.env.GENERATE_RATE_LIMIT;
  delete process.env.GENERATE_RATE_LIMIT;
  try {
    const { DEFAULT_GENERATE_LIMIT } = require('../utils/rateLimits');
    assert.equal(DEFAULT_GENERATE_LIMIT, 20);
    assert.equal(typeof server.generateLimiter, 'function');
  } finally {
    if (saved !== undefined) process.env.GENERATE_RATE_LIMIT = saved;
  }
});

test('Barion webhook ignores a status sent in the request body: unknown payment is never trusted', async (t) => {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const base = `http://127.0.0.1:${instance.address().port}`;
  const response = await fetch(`${base}/api/webhook/barion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentId: 'abcdef123456', Status: 'Succeeded', paid: true }) });
  assert.deepEqual(await response.json(), { received: true, ignored: 'unknown_payment' });
  assert.deepEqual(await barionService.handleCallback('abcdef123456'), { known: false });
});
