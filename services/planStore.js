'use strict';

const VOCAB = [
  'a', 'et', 'in', 'ut', 'ad', 'ex', 'de',
  'sed', 'non', 'iam', 'vel', 'sit', 'nam', 'tam',
  'amet', 'nunc', 'duis', 'nisi', 'ante', 'enim', 'quis',
  'lorem', 'ipsum', 'dolor', 'velit', 'magna', 'etiam', 'porta', 'vitae',
  'tempor', 'dolore', 'labore', 'aliqua', 'veniam', 'animus', 'facile',
  'nostrud', 'ullamco', 'laboris', 'aliquip', 'commodo', 'posuere', 'viverra',
  'aliquam', 'euismod', 'egestas', 'laoreet', 'luctus', 'iaculis', 'rhoncus',
  'consequat', 'hendrerit', 'facilisis', 'fermentum', 'bibendum', 'sollicitudin',
  'consectetur', 'adipiscing', 'incididunt', 'vestibulum', 'tincidunt',
  'exercitation', 'pellentesque', 'suspendisse'
];

const BY_LENGTH = {};
for (const word of VOCAB) {
  const len = word.length;
  if (!BY_LENGTH[len]) BY_LENGTH[len] = [];
  BY_LENGTH[len].push(word);
}

let seed = 0;

function getFillerWord(len, capitalize = false) {
  if (len <= 0) return '';
  const list = BY_LENGTH[len];
  let word;
  if (list && list.length) {
    word = list[(seed++) % list.length];
  } else {
    const syllables = ['con', 'sec', 'te', 'tur', 'ad', 'ip', 'is', 'cing', 'e', 'lit', 'tem', 'por', 'in', 'ci', 'di', 'dunt'];
    let str = '';
    while (str.length < len) {
      str += syllables[(seed++) % syllables.length];
    }
    word = str.slice(0, len);
  }
  if (capitalize) {
    word = word.charAt(0).toUpperCase() + word.slice(1);
  }
  return word;
}

function generateFillerText(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  return text.split('\n\n').map((paragraph) => {
    return paragraph.replace(/[\p{L}\p{N}]+/gu, (match) => {
      if (/^\d+$/.test(match)) return match;
      const isCap = match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase();
      return getFillerWord(match.length, isCap);
    });
  }).join('\n\n');
}

// Minden szöveglevél (tömbök és objektumok mélyén is) hasonló hosszúságú töltelékszöveg lesz; a szerkezet és a kulcsok megmaradnak.
function mirrorValue(value) {
  if (typeof value === 'string') return generateFillerText(value);
  if (Array.isArray(value)) return value.map(mirrorValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mirrorValue(item)]));
  return value;
}

function countStrings(value) {
  if (typeof value === 'string') return value.trim() ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countStrings(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((total, item) => total + countStrings(item), 0);
  return 0;
}

function countLockedContent(plan) {
  if (!plan || typeof plan !== 'object') {
    return { table_count: 0, activity_count: 0 };
  }
  if (plan.is_thematic === true && Array.isArray(plan.hetek)) {
    return {
      table_count: plan.hetek.length,
      activity_count: plan.hetek.reduce((total, week) => total + countStrings(week?.teruletek), 0)
    };
  }
  if (plan.is_weekly === true && Array.isArray(plan.napok)) {
    let table_count = 0;
    let activity_count = 0;
    for (const day of plan.napok) {
      if (Array.isArray(day?.kidolgozas_tablazat) && day.kidolgozas_tablazat.length) {
        table_count += 1;
        activity_count += day.kidolgozas_tablazat.length;
      }
    }
    return { table_count, activity_count };
  }
  const rows = Array.isArray(plan.kidolgozas_tablazat) ? plan.kidolgozas_tablazat.length : 0;
  return {
    table_count: rows > 0 ? 1 : 0,
    activity_count: rows
  };
}

function formatExtentSummary(tableCount, activityCount) {
  return `A teljes dokumentum elkészült: ${tableCount} részletes táblázat és ${activityCount} kidolgozott tevékenységi egység vár feloldásra.`;
}

function createMirrorPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const counts = countLockedContent(plan);
  const locked_meta = {
    is_locked: true,
    table_count: counts.table_count,
    activity_count: counts.activity_count,
    summary_text: formatExtentSummary(counts.table_count, counts.activity_count)
  };

  if (plan.is_thematic === true && Array.isArray(plan.hetek)) {
    return {
      ...plan,
      locked_meta,
      felhasznalt_irodalom: mirrorValue(plan.felhasznalt_irodalom || ''),
      hetek: plan.hetek.map((week) => ({
        ...week,
        teruletek: mirrorValue(week.teruletek),
        keretrendszer: mirrorValue(week.keretrendszer)
      })),
      megjegyzes_egyeb_tevekenysegek: mirrorValue(plan.megjegyzes_egyeb_tevekenysegek ?? null)
    };
  }

  if (plan.is_weekly === true && Array.isArray(plan.napok)) {
    const mirror = {
      ...plan,
      locked_meta,
      heti_keretterv: plan.heti_keretterv ? {
        ...plan.heti_keretterv,
        felhasznalt_irodalom: plan.heti_keretterv.felhasznalt_irodalom
          ? generateFillerText(plan.heti_keretterv.felhasznalt_irodalom)
          : ''
      } : plan.heti_keretterv,
      napok: plan.napok.map((day) => ({
        ...day,
        kidolgozas_tablazat: Array.isArray(day.kidolgozas_tablazat)
          ? day.kidolgozas_tablazat.map((row) => ({
              ido: row.ido || '',
              tevekenyseg_menete: (Array.isArray(row.tevekenyseg_menete)
                ? row.tevekenyseg_menete
                : [String(row.tevekenyseg_menete || '')]
              ).map((p) => generateFillerText(p)),
              modszerek_megjegyzesek: generateFillerText(row.modszerek_megjegyzesek || '')
            }))
          : []
      }))
    };
    return mirror;
  }

  return {
    ...plan,
    locked_meta,
    felhasznalt_irodalom: plan.felhasznalt_irodalom
      ? generateFillerText(plan.felhasznalt_irodalom)
      : '',
    kidolgozas_tablazat: Array.isArray(plan.kidolgozas_tablazat)
      ? plan.kidolgozas_tablazat.map((row) => ({
          ido: row.ido || '',
          tevekenyseg_menete: (Array.isArray(row.tevekenyseg_menete)
            ? row.tevekenyseg_menete
            : [String(row.tevekenyseg_menete || '')]
          ).map((p) => generateFillerText(p)),
          modszerek_megjegyzesek: generateFillerText(row.modszerek_megjegyzesek || '')
        }))
      : []
  };
}

const plans = new Map();
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_PLANS = 500;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_REQUEST_CHARS = 16000;
const MAX_REQUEST_STRING = 4000;
// Titkos vagy a mentéshez felesleges mezők: a tárolt kérésbe soha nem kerülhetnek be.
const REQUEST_BLOCKED_KEYS = ['turnstileToken', 'contact_website', 'website', 'honeypot'];

function sanitizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(request)) {
    if (REQUEST_BLOCKED_KEYS.includes(key)) continue;
    clean[key] = typeof value === 'string' ? value.slice(0, MAX_REQUEST_STRING) : value;
  }
  if (JSON.stringify(clean).length <= MAX_REQUEST_CHARS) return clean;
  // Túl nagy kérés: a nagy szabad szövegek és objektumok kimaradnak, a skalár beállítások megmaradnak.
  const compact = {};
  for (const [key, value] of Object.entries(clean)) {
    if (value === null || ['number', 'boolean'].includes(typeof value)) compact[key] = value;
    else if (typeof value === 'string') compact[key] = value.slice(0, 200);
  }
  return compact;
}

function isExpired(entry, now = Date.now()) {
  return now - entry.createdAt > MAX_AGE_MS;
}

function cleanup(now = Date.now()) {
  for (const [id, entry] of plans.entries()) {
    if (isExpired(entry, now)) plans.delete(id);
  }
}

// A lejárt bejegyzések időzítve törlődnek; olvasáskor csak az adott bejegyzést ellenőrizzük.
setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

function savePlan(id, plan) {
  if (!id || !plan) return;
  const key = String(id);
  const stored = plan.request === undefined ? plan : { ...plan, request: sanitizeRequest(plan.request) };
  plans.delete(key);
  plans.set(key, { plan: stored, createdAt: Date.now() });
  // A Map beszúrási sorrendet őriz, ezért az első kulcs a legrégebbi.
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
}

function readEntry(id) {
  if (!id) return null;
  const key = String(id);
  const entry = plans.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    plans.delete(key);
    return null;
  }
  return entry;
}

function getPlan(id) {
  const entry = readEntry(id);
  return entry ? entry.plan : null;
}

function hasPlan(id) {
  return readEntry(id) !== null;
}

function planCount() {
  return plans.size;
}

function clearPlans() {
  plans.clear();
}

module.exports = {
  generateFillerText,
  countLockedContent,
  formatExtentSummary,
  createMirrorPlan,
  savePlan,
  getPlan,
  hasPlan,
  clearPlans,
  cleanup,
  planCount,
  sanitizeRequest,
  MAX_PLANS
};
