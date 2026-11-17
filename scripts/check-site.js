const fs = require('fs');
const path = require('path');

const { PAGES, SITE_ASSETS } = require('../services/siteConstants');

const requiredFiles = [
  ...PAGES,
  ...SITE_ASSETS,
  '.github/workflows/test.yml',
  '.github/workflows/deploy.yml',
];

const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(process.cwd(), file))) {
    failures.push(`Missing required file: ${file}`);
  }
}

// A tervező markup és a kiszervezett tervezo-*.js scriptek együtt adják az oldalt.
const html = ['tervezo.html', ...SITE_ASSETS.filter((file) => file.startsWith('tervezo-'))]
  .map((file) => (fs.existsSync(path.join(process.cwd(), file)) ? fs.readFileSync(path.join(process.cwd(), file), 'utf8') : ''))
  .join('\n');

const requiredMarkers = [
  'OviTervező',
  'Tervezet elkészítése',
  'Generálásra vár',
];

// Minden helyi script/stíluslap hivatkozás és minden tervezo-*.js fájl szerepeljen a közös listán.
const shipped = new Set(SITE_ASSETS);
for (const page of PAGES) {
  const source = fs.readFileSync(path.join(process.cwd(), page), 'utf8');
  for (const match of source.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"#?]+)/g)) {
    if (!/^(https?:|mailto:|data:)/.test(match[1]) && !match[1].endsWith('.html') && match[1] !== 'config.js' && !shipped.has(match[1])) {
      failures.push(`${page}: ${match[1]} hiányzik a közös statikus fájllistából`);
    }
  }
}
for (const file of fs.readdirSync(process.cwd())) {
  if (/^tervezo-.*\.js$/.test(file) && !shipped.has(file)) failures.push(`${file} hiányzik a közös statikus fájllistából`);
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
