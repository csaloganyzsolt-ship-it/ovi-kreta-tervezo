// Közös konstansok, DOM-hivatkozások, tárolókulcsok, napi számláló és segédfüggvények.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

// ===== Egyetlen közös elrendezés-készlet az előnézethez (CSS), a PDF-hez (pdfmake) és a DOCX-hez =====
// Minden érték pontban (pt) vagy milliméterben van megadva; a CSS a lenti változókon (--doc-*), a PDF és a DOCX közvetlenül ezen az objektumon keresztül olvassa.
const DOC_LAYOUT = Object.freeze({
  marginMm: 15,
  pageMm: Object.freeze({ portrait: [210, 297], landscape: [297, 210] }),
  fontFamily: 'Arial',
  // Betűméretek (pt): cím, alcím (H3), törzsszöveg, táblázatszöveg, sűrű (tematikus) táblázat, meta-táblázat.
  fontPt: Object.freeze({ title: 16, heading: 11.5, body: 10, table: 9.5, thematic: 8, meta: 9.5 }),
  // Sormagasság a betűméret többszöröseként (CSS line-height); a PDF és a DOCX ebből számol a saját alapsormagasságához.
  lineHeight: Object.freeze({ body: 1.3, table: 1.2, meta: 1.25 }),
  // Térközök (pt).
  spacingPt: Object.freeze({ titleAfter: 10, headingBefore: 10, headingAfter: 5, paragraphAfter: 4, cellParagraphAfter: 2.5, blockGap: 10 }),
  // Cellamargók (pt): vízszintes (x) és függőleges (y).
  cellPadPt: Object.freeze({ table: Object.freeze({ x: 5, y: 4 }), thematic: Object.freeze({ x: 3.5, y: 3 }), meta: Object.freeze({ x: 5, y: 4 }) }),
  // A meta-táblázat címkeoszlopának aránya.
  metaLabelShare: Object.freeze({ standard: 0.28, academic: 0.3 }),
  borderPt: 0.5,
  // A Word "egyszeres" és a pdfmake 1.0-s sormagassága a betűméret ennyiszerese (Arial / Roboto), ebből számoljuk át a közös sormagasságot.
  nativeLineFactor: Object.freeze({ word: 1.15, pdf: 1.17 })
});

const PT_PER_MM = 72 / 25.4;
const TWIP_PER_PT = 20;
const TWIP_PER_MM = TWIP_PER_PT * PT_PER_MM;

function applyDocLayoutVars(root = document.documentElement) {
  const L = DOC_LAYOUT;
  const vars = {
    margin: `${L.marginMm}mm`,
    'title-pt': `${L.fontPt.title}pt`, 'heading-pt': `${L.fontPt.heading}pt`, 'body-pt': `${L.fontPt.body}pt`,
    'table-pt': `${L.fontPt.table}pt`, 'thematic-pt': `${L.fontPt.thematic}pt`, 'meta-pt': `${L.fontPt.meta}pt`,
    'lh-body': L.lineHeight.body, 'lh-table': L.lineHeight.table, 'lh-meta': L.lineHeight.meta,
    'title-after': `${L.spacingPt.titleAfter}pt`, 'heading-before': `${L.spacingPt.headingBefore}pt`, 'heading-after': `${L.spacingPt.headingAfter}pt`,
    'par-after': `${L.spacingPt.paragraphAfter}pt`, 'cell-par-after': `${L.spacingPt.cellParagraphAfter}pt`, 'block-gap': `${L.spacingPt.blockGap}pt`,
    'pad-x': `${L.cellPadPt.table.x}pt`, 'pad-y': `${L.cellPadPt.table.y}pt`,
    'thematic-pad-x': `${L.cellPadPt.thematic.x}pt`, 'thematic-pad-y': `${L.cellPadPt.thematic.y}pt`,
    'meta-pad-x': `${L.cellPadPt.meta.x}pt`, 'meta-pad-y': `${L.cellPadPt.meta.y}pt`,
    'meta-label': `${L.metaLabelShare.standard * 100}%`, 'academic-meta-label': `${L.metaLabelShare.academic * 100}%`,
    border: `${L.borderPt}pt`
  };
  Object.entries(vars).forEach(([name, value]) => root.style.setProperty(`--doc-${name}`, String(value)));
}

applyDocLayoutVars();

const steps = Array.from(document.querySelectorAll('.step-panel'));

const wizardItems = Array.from(document.querySelectorAll('.wizard-item'));

const nextBtn = document.getElementById('nextBtn');

// A szerver nyilvános beállításai (GET /api/config): árak, karbantartás, szezonális javaslatok. A betöltés a tervezo-init.js-ben történik.
const appConfig = { loaded: false, maintenance: false, seasonalHints: [] };

const MAINTENANCE_LABEL = 'Karbantartás alatt – a generálás átmenetileg szünetel';

// Karbantartás alatt a generálás gomb (az utolsó lépésen) le van tiltva; a futó generálás gombját nem bántja.
function applyMaintenanceState() {
  if (!appConfig.maintenance || nextBtn.classList.contains('is-busy') || currentStep !== steps.length - 1) return;
  nextBtn.disabled = true;
  nextBtn.textContent = MAINTENANCE_LABEL;
}

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
