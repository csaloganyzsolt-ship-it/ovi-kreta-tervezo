'use strict';

// A Nethely tárhelyre (/OviTervezo/) másolható, tisztán statikus csomagot állítja össze a dist-nethely/ mappába.
// Használat: node scripts/build-nethely.js [--test]
//   API_BASE_URL  a Render backend címe (alapérték: https://ovi-kreta-tervezo-api.onrender.com)
//   --test        a tesztkártya-tippet is megjeleníti (Stripe teszt mód)
const fs = require('node:fs');
const path = require('node:path');
const { addVersion, buildVersion } = require('./cache-bust');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-nethely');
const apiBaseUrl = String(process.env.API_BASE_URL || 'https://ovi-kreta-tervezo-api.onrender.com').trim().replace(/\/+$/, '');
const version = buildVersion();
const testMode = process.argv.includes('--test');

if (!/^https:\/\/[^\s/]+$/.test(apiBaseUrl)) {
  throw new Error(`Érvénytelen API_BASE_URL: ${apiBaseUrl}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

// Megbocsátó beolvasás: a teljes meta címkét, a "google-site-verification=" előtagot, idézőjeleket és szóközöket is lecsupaszítja a tiszta tokenre.
function cleanVerificationToken(raw) {
  let code = String(raw || '').trim();
  const fromMeta = code.match(/content\s*=\s*["']?([\w-]+)/i);
  if (fromMeta) code = fromMeta[1];
  code = code.replace(/^["'\s]*google-site-verification\s*[=:]\s*/i, '').replace(/[\s"'<>/]+/g, '');
  return code;
}

function applySiteVerification(html) {
  let code = cleanVerificationToken(process.env.GOOGLE_SITE_VERIFICATION);
  if (code && !/^[\w-]{10,200}$/.test(code)) {
    console.warn('FIGYELEM: a GOOGLE_SITE_VERIFICATION secret nem tartalmaz érvényes tokent, a meta címke kimarad.');
    code = '';
  }
  return html.replace('<!--GOOGLE_SITE_VERIFICATION-->', code ? `<meta name="google-site-verification" content="${code}" />` : '');
}

// Mindkét oldal relatív hivatkozásokat használ (tervezo.html, styles.css, site.js, config.js), ezért bármilyen gyökérben működik.
for (const file of ['robots.txt', 'sitemap.xml', 'styles.css', 'site.js', 'favicon.svg', 'favicon.ico', 'logo.svg']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}
for (const page of ['index.html', 'tervezo.html']) {
  fs.writeFileSync(path.join(out, page), addVersion(applySiteVerification(fs.readFileSync(path.join(root, page), 'utf8')), version));
}
for (const file of fs.readdirSync(path.join(root, 'assets'))) {
  fs.copyFileSync(path.join(root, 'assets', file), path.join(out, 'assets', file));
}

const config = {
  apiBaseUrl,
  paywallEnabled: true,
  company: { stripeTestMode: testMode },
};
fs.writeFileSync(path.join(out, 'config.js'), `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

fs.copyFileSync(path.join(root, '.htaccess'), path.join(out, '.htaccess'));

console.log(`Kész: ${out}\nVerzió: ?v=${version}\nAPI: ${apiBaseUrl}\nStripe teszt tipp: ${testMode}`);
