'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');

const siteScript = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'site.js'), 'utf8');

async function loadHome(t, reviews) {
  const requested = [];
  const dom = new JSDOM(readPage('index.html'), {
    url: 'http://localhost:8000',
    runScripts: 'outside-only',
    beforeParse(window) {
      window.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).endsWith('/api/reviews/public')) return { ok: true, status: 200, json: async () => ({ success: true, reviews }) };
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
    }
  });
  t.after(() => dom.window.close());
  dom.window.eval(siteScript);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { document: dom.window.document, requested };
}

test('homepage keeps the "Pedagógusok mondták rólunk" section hidden until an approved review exists', async (t) => {
  const { document, requested } = await loadHome(t, []);
  assert.ok(requested.some((url) => url.endsWith('/api/reviews/public')));
  assert.equal(document.getElementById('testimonials').hidden, true);
  assert.equal(document.getElementById('testimonialGrid').children.length, 0);
});

test('homepage renders approved reviews as plain text with stars, quote and name', async (t) => {
  const { document } = await loadHome(t, [
    { name: 'K. Anna – óvodapedagógus', topic: 'Tavaszi erdő', rating: 4, comment: 'Nagyon hasznos <img src=x onerror=alert(1)>' },
    { name: '', topic: '', rating: 5, comment: 'Időt spórol' }
  ]);
  const section = document.getElementById('testimonials');
  assert.equal(section.hidden, false);
  assert.match(section.querySelector('h2').textContent, /Pedagógusok mondták rólunk/);
  const cards = section.querySelectorAll('.testimonial-card');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.testimonial-stars').textContent, '★★★★☆');
  assert.match(cards[0].querySelector('figcaption').textContent, /K\. Anna – óvodapedagógus – Tavaszi erdő/);
  assert.equal(cards[0].querySelector('img'), null, 'a vélemény szövege nem értelmeződik HTML-ként');
  assert.match(cards[0].querySelector('blockquote').textContent, /<img src=x/);
  assert.equal(cards[1].querySelector('figcaption').textContent, 'Óvodapedagógus');
});

test('reviews migration is idempotent, public RLS read is limited to approved rows and it is part of RUN_ALL_PENDING_MIGRATIONS.sql', () => {
  const root = path.join(__dirname, '..', 'supabase');
  const sql = fs.readFileSync(path.join(root, 'migrations', '20261204090000_reviews.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.reviews/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for select to anon, authenticated\s+using \(status = 'approved'\)/);
  assert.match(sql, /status in \('pending', 'approved', 'rejected'\)/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all)/i, 'írás csak a service_role-lal');
  assert.doesNotMatch(sql, /grant select \([^)]*(customer_email|admin_note)/, 'az e-mail és a jegyzet nem publikus');
  assert.ok(fs.readFileSync(path.join(root, 'RUN_ALL_PENDING_MIGRATIONS.sql'), 'utf8').includes(sql.trim()));
});
