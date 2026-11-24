const fs = require('fs');
const path = require('path');

const { PAGES, SITE_ASSETS } = require('../backend/services/siteConstants');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');

const requiredFiles = [
  ...PAGES,
  ...SITE_ASSETS,
].map((file) => path.join(FRONTEND, file)).concat([
  path.join(ROOT, '.github/workflows/test.yml'),
  path.join(ROOT, '.github/workflows/deploy-nethely.yml'),
]);

const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing required file: ${path.relative(ROOT, file)}`);
  }
}

// A tervező markup és a kiszervezett tervezo-*.js scriptek együtt adják az oldalt.
const html = ['tervezo.html', ...SITE_ASSETS.filter((file) => file.startsWith('js/tervezo-'))]
  .map((file) => (fs.existsSync(path.join(FRONTEND, file)) ? fs.readFileSync(path.join(FRONTEND, file), 'utf8') : ''))
  .join('\n');

const requiredMarkers = [
  'OviTervező',
  'Tervezet elkészítése',
  'Generálásra vár',
];

// Minden helyi script/stíluslap hivatkozás és minden tervezo-*.js fájl szerepeljen a közös listán.
const shipped = new Set(SITE_ASSETS);
for (const page of PAGES) {
  const source = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
  for (const match of source.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"#?]+)/g)) {
    if (!/^(https?:|mailto:|data:)/.test(match[1]) && !match[1].endsWith('.html') && match[1] !== 'js/config.js' && !shipped.has(match[1])) {
      failures.push(`${page}: ${match[1]} hiányzik a közös statikus fájllistából`);
    }
  }
}
for (const file of fs.readdirSync(path.join(FRONTEND, 'js'))) {
  if (/^tervezo-.*\.js$/.test(file) && !shipped.has(`js/${file}`)) failures.push(`js/${file} hiányzik a közös statikus fájllistából`);
}

for (const marker of requiredMarkers) {
  if (!html.includes(marker)) {
    failures.push(`Missing required marker in tervezo.html: ${marker}`);
  }
}

if (failures.length > 0) {
  console.error('Site validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Site validation passed. Static files and required markers are present.');
