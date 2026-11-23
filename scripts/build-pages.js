'use strict';

// A GitHub Pages (teszt / staging) csomagot állítja össze a dist-pages/ mappába: fizetési kapu nélkül, e-mailes tesztkézbesítéssel.
const fs = require('node:fs');
const path = require('node:path');
const { addVersion, buildVersion } = require('./cache-bust');
const { copyAssets } = require('./copy-assets');
const { SUPPORT_EMAIL, SUPABASE_PUBLIC_URL, SUPABASE_PUBLISHABLE_KEY, barionPixelId, PAGES, SITE_ASSETS, publicCompany, applyCompanyToHtml } = require('../services/siteConstants');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-pages');
const apiBaseUrl = String(process.env.API_BASE_URL || 'https://ovi-kreta-tervezo-api.onrender.com').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(apiBaseUrl)) throw new Error(`Érvénytelen API_BASE_URL: ${apiBaseUrl}`);

const version = buildVersion();
fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
// A staging oldal nem indexelhető, ezért nem kap Search Console igazolást.
for (const page of PAGES) {
  fs.writeFileSync(path.join(out, page), addVersion(applyCompanyToHtml(fs.readFileSync(path.join(root, page), 'utf8').replace('<!--GOOGLE_SITE_VERIFICATION-->', '')), version));
}
for (const file of SITE_ASSETS) fs.copyFileSync(path.join(root, file), path.join(out, file));
copyAssets(root, out);
const config = { apiBaseUrl, paywallEnabled: true, turnstileSiteKey: '', barionPixelId: barionPixelId(), SUPABASE_URL: SUPABASE_PUBLIC_URL, SUPABASE_PUBLISHABLE_KEY, company: { ...publicCompany(), email: SUPPORT_EMAIL, stripeTestMode: false } };
fs.writeFileSync(path.join(out, 'config.js'), `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
// A teszt oldal ne kerüljön indexelésre, hogy ne versenyezzen az éles oldallal.
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Kész: ${out}\nAPI: ${apiBaseUrl}\npaywallEnabled: true`);
