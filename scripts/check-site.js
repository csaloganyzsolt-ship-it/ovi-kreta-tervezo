const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'index.html',
  'tervezo.html',
  'styles.css',
  'site.js', 'favicon.svg', 'favicon.ico', 'logo.svg',
  '.github/workflows/test.yml',
  '.github/workflows/deploy.yml',
];

const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(process.cwd(), file))) {
    failures.push(`Missing required file: ${file}`);
  }
}

const html = fs.existsSync(path.join(process.cwd(), 'tervezo.html'))
  ? fs.readFileSync(path.join(process.cwd(), 'tervezo.html'), 'utf8')
  : '';

const requiredMarkers = [
  'OviTervező',
  'Tervezet elkészítése',
  'Generálásra vár',
];

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
