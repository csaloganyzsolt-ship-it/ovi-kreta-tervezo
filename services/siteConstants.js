'use strict';

// Egyetlen forrás a nyilvános ügyfélszolgálati e-mailhez és a Turnstile site kulcshoz (szerver, levelek, build scriptek).
// A site.js böngészős tartaléka (DEFAULT_SUPPORT_EMAIL) és a statikus láblécek e-mailje tesztből ellenőrzött másolat.
// Egyetlen statikus fájllista: a server.js, a build scriptek és a check-site.js is innen dolgoznak.
const PAGES = ['index.html', 'tervezo.html', 'ertekeles.html'];
const SITE_ASSETS = [
  'styles.css', 'site.js', 'theme-init.js',
  'tervezo-core.js', 'tervezo-form.js', 'tervezo-preview.js', 'tervezo-export.js',
  'tervezo-generate.js', 'tervezo-paywall.js', 'tervezo-init.js',
  'favicon.svg', 'favicon.ico', 'logo.svg'
];
const SEO_FILES = ['robots.txt', 'sitemap.xml'];

module.exports = {
  PAGES,
  SITE_ASSETS,
  SEO_FILES,
  SUPPORT_EMAIL: 'info@ovitervezo.hu',
  TURNSTILE_SITE_KEY: '0x4AAAAAAGFSc8Zzow6VmxQ9'
};
