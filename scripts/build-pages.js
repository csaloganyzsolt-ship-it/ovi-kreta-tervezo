'use strict';

// A GitHub Pages (teszt / staging) csomagot állítja össze a dist-pages/ mappába: fizetési kapu nélkül, e-mailes tesztkézbesítéssel.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-pages');
const apiBaseUrl = String(process.env.API_BASE_URL || 'https://ovi-kreta-tervezo-api.onrender.com').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(apiBaseUrl)) throw new Error(`Érvénytelen API_BASE_URL: ${apiBaseUrl}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
// A staging oldal nem indexelhető, ezért nem kap Search Console igazolást.
for (const page of ['index.html', 'tervezo.html']) {
  fs.writeFileSync(path.join(out, page), fs.readFileSync(path.join(root, page), 'utf8').replace('<!--GOOGLE_SITE_VERIFICATION-->', ''));
}
for (const file of ['styles.css', 'site.js', 'favicon.svg', 'favicon.ico', 'logo.svg']) fs.copyFileSync(path.join(root, file), path.join(out, file));
for (const file of fs.readdirSync(path.join(root, 'assets'))) {
  fs.copyFileSync(path.join(root, 'assets', file), path.join(out, 'assets', file));
}
const config = { apiBaseUrl, paywallEnabled: false, testDelivery: true, company: { stripeTestMode: false } };
fs.writeFileSync(path.join(out, 'config.js'), `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
// A teszt oldal ne kerüljön indexelésre, hogy ne versenyezzen az éles oldallal.
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Kész: ${out}\nAPI: ${apiBaseUrl}\npaywallEnabled: false, testDelivery: true`);
