'use strict';

// A Nethely tárhelyre (/OviTervezo/) másolható, tisztán statikus csomagot állítja össze a dist-nethely/ mappába.
// Használat: node scripts/build-nethely.js [--test]
//   API_BASE_URL  a Render backend címe (alapérték: https://ovi-kreta-tervezo-api.onrender.com)
//   --test        a tesztkártya-tippet is megjeleníti (Stripe teszt mód)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-nethely');
const apiBaseUrl = String(process.env.API_BASE_URL || 'https://ovi-kreta-tervezo-api.onrender.com').trim().replace(/\/+$/, '');
const testMode = process.argv.includes('--test');

if (!/^https:\/\/[^\s/]+$/.test(apiBaseUrl)) {
  throw new Error(`Érvénytelen API_BASE_URL: ${apiBaseUrl}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

function applySiteVerification(html) {
  const code = String(process.env.GOOGLE_SITE_VERIFICATION || '').trim();
  if (code && !/^[\w-]{10,200}$/.test(code)) throw new Error('Érvénytelen GOOGLE_SITE_VERIFICATION érték.');
  return html.replace('<!--GOOGLE_SITE_VERIFICATION-->', code ? `<meta name="google-site-verification" content="${code}" />` : '');
}

// Mindkét oldal relatív hivatkozásokat használ (tervezo.html, styles.css, site.js, config.js), ezért bármilyen gyökérben működik.
for (const file of ['robots.txt', 'sitemap.xml', 'styles.css', 'site.js']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}
for (const page of ['index.html', 'tervezo.html']) {
  fs.writeFileSync(path.join(out, page), applySiteVerification(fs.readFileSync(path.join(root, page), 'utf8')));
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

fs.writeFileSync(path.join(out, '.htaccess'), `# Nethely / Apache
RewriteEngine On
# A Nethely Nginx proxy mögött fut az Apache, ezért a proxy fejlécét is figyelembe kell venni (különben átirányítási ciklus lesz).
RewriteCond %{HTTPS} off
RewriteCond %{HTTP:X-Forwarded-Proto} !https
RewriteCond %{HTTP:CF-Visitor} !{"scheme":"https"}
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

DirectoryIndex index.html
Options -Indexes

<IfModule mod_headers.c>
  Header set X-Content-Type-Options "nosniff"
  Header set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/png "access plus 7 days"
  ExpiresByType text/html "access plus 0 seconds"
  ExpiresByType application/javascript "access plus 0 seconds"
</IfModule>
`);

console.log(`Kész: ${out}\nAPI: ${apiBaseUrl}\nStripe teszt tipp: ${testMode}`);
