// Közös konstansok, DOM-hivatkozások, tárolókulcsok, napi számláló és segédfüggvények.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

const steps = Array.from(document.querySelectorAll('.step-panel'));

const wizardItems = Array.from(document.querySelectorAll('.wizard-item'));

const nextBtn = document.getElementById('nextBtn');

const backBtn = document.getElementById('backBtn');

const loadPreviousBtn = document.getElementById('loadPreviousBtn');

const historyPanel = document.getElementById('historyPanel');

const previewPanel = document.getElementById('previewPanel');

const previewEmpty = document.getElementById('previewEmpty');

const previewContent = document.getElementById('previewContent');

const resultDocument = document.getElementById('resultDocument');

let currentStep = 0;

let previewReady = false;

let lastResult = null;

const STORAGE_KEYS = {
  profile: 'oviKretaProfile',
  history: 'oviKretaPlansHistory',
  draft: 'oviKretaDraft',
  theme: 'oviKretaTheme',
  generatedPlan: 'oviKretaGeneratedPlan',
  lastGeneration: 'oviKreta_lastGeneration',
  dailyCount: 'oviKreta_dailyCount'
};

const DAILY_FREE_LIMIT = 3;

const LIMIT_MESSAGE = 'Elérted a napi ingyenes tervezési limitet (3/3). Kérjük, fizesd ki a már elkészült tervezetet a letöltéshez, vagy térj vissza holnap új tervezet generálásához!';

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readDailyCount() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.dailyCount) || 'null');
    if (stored && stored.date === todayKey() && Number.isFinite(stored.count)) return stored;
  } catch (_error) { /* hibás érték: új számláló */ }
  return { date: todayKey(), count: 0 };
}

function writeDailyCount(count) {
  try { localStorage.setItem(STORAGE_KEYS.dailyCount, JSON.stringify({ date: todayKey(), count })); } catch (_error) { /* nincs tár */ }
}

// Bejelentkezett felhasználónál a Supabase hozzáférési token; vendég módban üres, a kérések változatlanok.
function authHeaders() {
  const token = window.OviAuth?.getAccessToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getApiBaseUrl() {
  const configured = String(window.APP_CONFIG?.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (configured === 'same-origin') return window.location.origin;
  if (configured) return configured;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || !host ? 'http://localhost:4000' : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTableCell(value) {
  const parts = Array.isArray(value)
    ? value.map((part) => String(part ?? '').trim()).filter(Boolean)
    : String(value ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

  if (!parts.length) return '';
  return parts
    .map((part) => `<p>${escapeHtml(part).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

// Oktatási célú tervezet jelölései: **félkövér** és *dőlt*; minden más karakter escape-elve marad.
function formatRichText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '<em>$1</em>')
    .replace(/\r?\n/g, '<br>');
}

function formatRichCell(value) {
  const parts = Array.isArray(value)
    ? value.map((part) => String(part ?? '').trim()).filter(Boolean)
    : String(value ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.map((part) => `<p>${formatRichText(part)}</p>`).join('');
}

const WEEKDAY_ORDER = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];

const WEEKDAY_FILE_NAMES = { 'Hétfő': 'Hetfo', 'Kedd': 'Kedd', 'Szerda': 'Szerda', 'Csütörtök': 'Csutortok', 'Péntek': 'Pentek' };

const WEEKDAY_SLUGS = {
  'Hétfő': 'hetfo',
  'Kedd': 'kedd',
  'Szerda': 'szerda',
  'Csütörtök': 'csutortok',
  'Péntek': 'pentek'
};

const AREA_SLUG_MAP = {
  'verseles, meseles': 'verseles-meseles',
  'verseles': 'verseles-meseles',
  'meseles': 'verseles-meseles',
  'enek, zene, nepi jatek, tanc': 'enek-zene',
  'enek, zene, enekes jatek': 'enek-zene',
  'enek, zene': 'enek-zene',
  'rajzolas, festes, mintazas, kezi munka': 'rajzolas-festes',
  'rajzolas, mintazas, kezimunka': 'rajzolas-festes',
  'mozgas': 'mozgas',
  'a kulso vilag tevekeny megismerese': 'kulso-vilag',
  'kulso vilag tevekeny megismerese': 'kulso-vilag',
  'a kulso vilag tevekeny megismerese – matematikai tartalommal': 'matematika',
  'a kulso vilag tevekeny megismerese - matematikai tartalommal': 'matematika',
  'matematika': 'matematika'
};

function slugifyAreaName(area) {
  if (!area) return '';
  const normalized = String(area).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (AREA_SLUG_MAP[normalized]) return AREA_SLUG_MAP[normalized];
  if (area.includes('+')) {
    return area.split('+').map((part) => slugifyAreaName(part.trim())).filter(Boolean).join('-');
  }
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

// ISO-8601 hét (a csütörtök határozza meg az évet): mindig érvényes "YYYY-Www" érték, az évhatáron is.
function isoWeekValue(date = new Date()) {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getMondayDateForWeek(dateValue) {
  const val = String(dateValue || '').trim();
  const weekMatch = val.match(/^(\d{4})-W(\d{1,2})$/i);
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10);
    const week = parseInt(weekMatch[2], 10);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Mon = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
    return new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);
  }
  const dateMatch = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    const y = parseInt(dateMatch[1], 10);
    const m = parseInt(dateMatch[2], 10);
    const d = parseInt(dateMatch[3], 10);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay() || 7;
    return new Date(dt.getTime() - (dow - 1) * 86400000);
  }
  const now = new Date();
  const dow = now.getDay() || 7;
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - (dow - 1)));
}

function getCalendarDateForDay(mondayDate, dayName) {
  const offset = WEEKDAY_ORDER.indexOf(dayName);
  const dayOffset = offset >= 0 ? offset : 0;
  const dayDate = new Date(mondayDate.getTime() + dayOffset * 86400000);
  return dayDate.toISOString().slice(0, 10);
}

function asciiSlug(value, maxLength = 32) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, maxLength).replace(/_+$/, '');
}
