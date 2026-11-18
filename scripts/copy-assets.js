'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Az assets/ mappa kép- és ikonfájljait másolja (almappákkal együtt); a PDF-ek, a rejtett fájlok és a .DS_Store nem kerülnek a csomagba.
const SHIPPED_EXTENSIONS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.ico']);

function copyAssets(root, out) {
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, 'assets', relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (SHIPPED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        fs.mkdirSync(path.dirname(path.join(out, 'assets', next)), { recursive: true });
        fs.copyFileSync(path.join(root, 'assets', next), path.join(out, 'assets', next));
      }
    }
  };
  walk('');
}

module.exports = { copyAssets, SHIPPED_EXTENSIONS };
