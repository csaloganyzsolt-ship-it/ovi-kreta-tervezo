'use strict';

// Egyetlen forrás a nyilvános ügyfélszolgálati e-mailhez és a Turnstile site kulcshoz (szerver, levelek, build scriptek).
// A site.js böngészős tartaléka (DEFAULT_SUPPORT_EMAIL) és a statikus láblécek e-mailje tesztből ellenőrzött másolat.
// Egyetlen statikus fájllista: a server.js, a build scriptek és a check-site.js is innen dolgoznak.
const PAGES = ['index.html', 'tervezo.html', 'ertekeles.html'];
const SITE_ASSETS = [
  'styles.css', 'site.js', 'theme-init.js',
  'tervezo-core.js', 'tervezo-academic.js', 'tervezo-form.js', 'tervezo-preview.js', 'tervezo-export.js',
  'tervezo-generate.js', 'tervezo-paywall.js', 'tervezo-history.js', 'tervezo-init.js', 'barion-pixel.js', 'auth.js',
  'favicon.svg', 'favicon.ico', 'logo.svg'
];
const SEO_FILES = ['robots.txt', 'sitemap.xml'];

// A Supabase Auth publikus kapcsolati adatai (a publishable kulcs böngészőbe szánt, a titkos kulcs soha nem kerülhet ide).
const SUPABASE_PUBLIC_URL = 'https://caaouwcfoxmuurhpvqoe.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_b5CmhcG0zDzDlR8aMQyoZA_aMUDp8AP';

// Egyetlen CSP: a server.js Report-Only fejlécként küldi, a .htaccess ezzel azonos szöveget tartalmaz (tesztelt).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://challenges.cloudflare.com https://js.stripe.com https://pixel.barion.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' https://*.onrender.com ${SUPABASE_PUBLIC_URL} https://challenges.cloudflare.com https://api.stripe.com https://pixel.barion.com`,
  'frame-src https://challenges.cloudflare.com https://checkout.stripe.com https://pixel.barion.com',
  "img-src 'self' data: blob: https://pixel.barion.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'"
].join('; ');

// Két előre definiált vállalkozói profil; a BILLING_PROFILE=kft kapcsol át, minden más érték (és az üres) az egyéni vállalkozót adja.
const BILLING_PROFILES = Object.freeze({
  ev: Object.freeze({
    type: 'ev',
    name: 'Csalogány Zsolt egyéni vállalkozó',
    taxId: '68274568-1-28',
    regLabel: 'EV nyilvántartási szám',
    regNo: '51507048',
    court: '',
    address: '9153 Öttevény, Kossuth Lajos utca 26.',
    vatRate: 'AAM',
    vatNote: 'Alanyi adómentes (AAM) értékesítés, az árak 0 Ft ÁFÁ-t tartalmaznak.',
    invoicePrefix: ''
  }),
  kft: Object.freeze({
    type: 'kft',
    name: 'CSB-Villamosság Kft.',
    taxId: '27891788-2-08',
    regLabel: 'Cégjegyzékszám',
    regNo: '08 09 031727',
    court: 'Győri Törvényszék Cégbírósága',
    address: '9153 Öttevény, Arany János utca 10.',
    vatRate: '27',
    vatNote: 'Az árak magyar forintban (HUF) értendők, és tartalmazzák a 27%-os általános forgalmi adót (ÁFA).',
    invoicePrefix: ''
  })
});

function getBillingProfile(env = process.env) {
  return BILLING_PROFILES[env.BILLING_PROFILE === 'kft' ? 'kft' : 'ev'];
}

// A frontendnek átadott (nem titkos) cégadatok; a build scriptek és a /config.js is ezt használja.
function publicCompany(env = process.env) {
  const { type, name, taxId, regLabel, regNo, court, address, vatNote } = getBillingProfile(env);
  return { type, name, taxId, regLabel, regNo, court, address, vatNote };
}

// A statikus HTML az ev profil nevét tartalmazza (JSON-LD, lábléc tartalék); kft profilnál a build ezt cseréli.
function applyCompanyToHtml(html, env = process.env) {
  const active = getBillingProfile(env);
  return active.type === 'ev' ? html : html.split(BILLING_PROFILES.ev.name).join(active.name);
}

// A Barion Pixel azonosítója nyilvános (a böngészőben is látszik). A BARION_PIXEL_ID környezeti változó felülírja, üres értékkel a Pixel kikapcsolható.
const DEFAULT_BARION_PIXEL_ID = 'BP-U0p5Sp7I1Q-EF';

function barionPixelId(env = process.env) {
  const configured = env.BARION_PIXEL_ID === undefined ? DEFAULT_BARION_PIXEL_ID : String(env.BARION_PIXEL_ID).trim();
  return /^BP-[A-Za-z0-9-]{4,60}$/.test(configured) ? configured : '';
}

module.exports = {
  applyCompanyToHtml,
  barionPixelId,
  DEFAULT_BARION_PIXEL_ID,
  BILLING_PROFILES,
  getBillingProfile,
  publicCompany,
  CONTENT_SECURITY_POLICY,
  PAGES,
  SITE_ASSETS,
  SEO_FILES,
  SUPPORT_EMAIL: 'info@ovitervezo.hu',
  SUPABASE_PUBLIC_URL,
  SUPABASE_PUBLISHABLE_KEY,
  TURNSTILE_SITE_KEY: '0x4AAAAAAGFSc8Zzow6VmxQ9'
};
