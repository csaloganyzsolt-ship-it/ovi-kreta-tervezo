'use strict';

// Cache-busting: a HTML-ben hivatkozott helyi CSS/JS/kép/ikon fájlok URL-jéhez ?v=<build-időbélyeg> paramétert fűz.
// A külső (http/https/protokoll-relatív) hivatkozásokat és a HTML-oldalakra mutató linkeket nem módosítja.
function buildVersion(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

const ASSET = /\.(?:css|js|svg|ico|png|jpe?g|webp|gif|woff2?)$/i;

function addVersion(html, version = buildVersion()) {
  return html.replace(/(<(?:link|script|img)\b[^>]*?\s(?:href|src)=")([^"]+)(")/gi, (match, before, url, after) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) || url.includes('?') || !ASSET.test(url)) return match;
    return `${before}${url}?v=${version}${after}`;
  });
}

module.exports = { addVersion, buildVersion };
