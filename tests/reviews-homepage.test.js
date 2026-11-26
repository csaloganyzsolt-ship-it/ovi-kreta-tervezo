'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { readPage } = require('./fixtures');

const siteScript = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'site.js'), 'utf8');

async function loadHome(t, reviews, total = reviews.length) {
  const requested = [];
  const dom = new JSDOM(readPage('index.html'), {
    url: 'http://localhost:8000',
    runScripts: 'outside-only',
    beforeParse(window) {
      window.fetch = async (url) => {
        requested.push(String(url));
        const match = String(url).match(/\/api\/reviews\/public\?page=(\d+)/);
        if (match) {
          const page = Number(match[1]);
          const slice = reviews.slice((page - 1) * 6, page * 6);
          return { ok: true, status: 200, json: async () => ({ success: true, reviews: slice, total, page, pageSize: 6, totalPages: Math.max(1, Math.ceil(total / 6)) }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
    }
  });
  t.after(() => dom.window.close());
  dom.window.eval(siteScript);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { document: dom.window.document, requested, window: dom.window };
}

const sample = (n, extra = {}) => ({ name: `Teszt Elek${n}`, role: 'Óvodapedagógus', rating: 5, comment: `Vélemény ${n}`, createdAt: new Date().toISOString(), ...extra });

test('monogram and relative time helpers', () => {
  const { window } = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  window.eval(siteScript);
  const { reviewMonogram, reviewRelativeTime } = window.eval('({ reviewMonogram, reviewRelativeTime })');
  assert.equal(reviewMonogram('Csalogány Eszter'), 'CE');
  assert.equal(reviewMonogram('Kovácsné T. Judit'), 'KJ');
  assert.equal(reviewMonogram('Varga-Németh Krisztina'), 'VK');
  assert.equal(reviewMonogram('Anna'), 'AN');
  assert.equal(reviewMonogram(''), 'Ó');
  const now = new Date('2026-06-30T12:00:00Z');
  const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  assert.deepEqual([0, 1, 3, 14, 21, 32, 62, 400].map((d) => reviewRelativeTime(ago(d), now)), ['Ma', 'Tegnap', '3 napja', '2 hete', '3 hete', '1 hónapja', '2 hónapja', '1 éve']);
});

test('homepage keeps the "Pedagógusok mondták rólunk" section hidden until an approved review exists', async (t) => {
  const { document, requested } = await loadHome(t, []);
  assert.ok(requested.some((url) => url.includes('/api/reviews/public?page=1&pageSize=6')));
  assert.equal(document.getElementById('testimonials').hidden, true);
  assert.equal(document.getElementById('reviewsGrid').children.length, 0);
  assert.equal(document.querySelector('.review-card'), null, 'nincs beégetett vélemény');
});

test('homepage renders database reviews as monogram cards using plain text', async (t) => {
  const { document } = await loadHome(t, [
    sample(1, { name: 'Kovácsné T. Judit', role: 'Óvodapedagógus (vegyes csoport)', rating: 4, comment: 'Hasznos <img src=x onerror=alert(1)>', createdAt: new Date(Date.now() - 14 * 86400000).toISOString() }),
    sample(2, { name: '', role: '' })
  ]);
  const section = document.getElementById('testimonials');
  assert.equal(section.hidden, false);
  assert.match(section.querySelector('h2').textContent, /Pedagógusok mondták rólunk/);
  const cards = section.querySelectorAll('#reviewsGrid .review-card');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.review-avatar').textContent, 'KJ');
  assert.equal(cards[0].querySelector('.review-name').textContent, 'Kovácsné T. Judit');
  assert.equal(cards[0].querySelector('.review-role-date').textContent, 'Óvodapedagógus (vegyes csoport) • 2 hete');
  assert.equal(cards[0].querySelector('.review-stars').textContent, '★★★★☆');
  assert.equal(cards[0].querySelector('img'), null);
  assert.match(cards[0].querySelector('.review-text').textContent, /^„Hasznos <img src=x/);
  assert.equal(cards[1].querySelector('.review-name').textContent, 'Óvodapedagógus');
  assert.equal(document.getElementById('reviewsPager').hidden, true, '6 vagy kevesebb értékelésnél nincs lapozó');
});

test('homepage pages through more than 6 reviews, 6 per page', async (t) => {
  const all = Array.from({ length: 8 }, (_, i) => sample(i + 1));
  const { document, requested } = await loadHome(t, all);
  const pager = document.getElementById('reviewsPager');
  assert.equal(pager.hidden, false);
  assert.equal(document.querySelectorAll('#reviewsGrid .review-card').length, 6);
  assert.equal(document.getElementById('reviewsPageInfo').textContent, '1 / 2');
  assert.equal(document.getElementById('reviewsPrev').disabled, true);
  document.getElementById('reviewsNext').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(requested.some((url) => url.includes('page=2')));
  assert.equal(document.querySelectorAll('#reviewsGrid .review-card').length, 2);
  assert.equal(document.getElementById('reviewsPageInfo').textContent, '2 / 2');
  assert.equal(document.getElementById('reviewsNext').disabled, true);
  document.getElementById('reviewsPrev').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.getElementById('reviewsPageInfo').textContent, '1 / 2');
});

test('seed migration inserts the six former static reviews idempotently and is part of RUN_ALL_PENDING_MIGRATIONS.sql', () => {
  const root = path.join(__dirname, '..', 'supabase');
  const sql = fs.readFileSync(path.join(root, 'migrations', '20261205090000_seed_initial_reviews_and_delete.sql'), 'utf8');
  assert.match(sql, /add column if not exists role_label/);
  for (const name of ['Kovácsné T. Judit', 'Szabó Eszter', 'Varga-Németh Krisztina', 'Tóth Anikó', 'Horváthné Gabi', 'Molnár Dóra']) assert.ok(sql.includes(name), name);
  assert.equal((sql.match(/korabbi-velemeny-\d@ovitervezo\.invalid/g) || []).length, 6);
  assert.match(sql, /where not exists \(select 1 from public\.reviews r where r\.customer_email = v\.email\)/);
  assert.match(sql, /'approved'/);
  assert.ok(fs.readFileSync(path.join(root, 'RUN_ALL_PENDING_MIGRATIONS.sql'), 'utf8').includes(sql.trim()));
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
