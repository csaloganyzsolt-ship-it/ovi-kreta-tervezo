'use strict';

// Dátum- és évszakfüggő téma-ajánló: a tervező „Projekt témája” chipjei a `theme_suggestions` táblából jönnek.
// A kiválasztás tiszta függvényekből áll (dátum → MM-DD → jeles napok → évszak → általános), így adatbázis nélkül tesztelhető.
const logger = require('../utils/logger');
const { normalizeThemeKey } = require('./themeStats');

const TABLE = 'theme_suggestions';
const PUBLIC_COLUMNS = 'id, title, category, season, start_mmdd, end_mmdd, priority, is_active, created_at, updated_at';
const COLUMNS = PUBLIC_COLUMNS;
const ADMIN_PAGE_SIZES = [10, 25, 50, 100];
const SORTS = ['priority', 'usage', 'title'];
const CATEGORIES = ['event', 'season', 'general'];
const SEASONS = ['tavasz', 'nyar', 'osz', 'tel'];
const MAX_SUGGESTIONS = 8;
const MAX_TITLE_LENGTH = 200;
const MIN_PRIORITY = 0;
const MAX_PRIORITY = 1000;
const DEFAULT_PRIORITY = 50;
const MMDD_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A február 29-e szökőévben létezik, ezért a hónaphossz-ellenőrzésben 29 nap engedélyezett.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

class ThemeSuggestionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ThemeSuggestionError';
    this.status = status;
  }
}

// Biztonságos beépített alap: csak akkor szolgál ki, ha az adatbázis nem elérhető vagy üres; a hibát a napló és a válasz `source` mezője jelzi.
const FALLBACK_ROWS = Object.freeze([
  ['Karácsony – ajándékkészítés és ünnepi hagyományok', 'event', null, '12-14', '12-27', 100],
  ['Mikulás – csizmák, versek és mondókák', 'event', null, '11-26', '12-08', 98],
  ['Farsang – jelmezek, álarcok és mulatság', 'event', null, '01-25', '03-02', 95],
  ['Március 15. – kokárda, huszárok, nemzeti ünnep', 'event', null, '03-08', '03-16', 100],
  ['Húsvét – tojásfestés és tavaszi népszokások', 'event', null, '03-25', '04-25', 95],
  ['Anyák napja – ajándék és köszöntő az anyukáknak', 'event', null, '04-24', '05-08', 100],
  ['Augusztus 20. – új kenyér, államalapítás ünnepe', 'event', null, '08-10', '08-21', 100],
  ['Óvodakezdés, beszoktatás – ismerkedés és jelek', 'event', null, '08-25', '09-20', 95],
  ['Márton-nap – libás népszokások és lámpáskészítés', 'event', null, '10-28', '11-14', 100],
  ['Őszi falevelek gyűjtése és préselése', 'season', 'osz', null, null, 50],
  ['Hóember építés és téli játékok', 'season', 'tel', null, null, 50],
  ['Tavaszi virágok – hóvirág, ibolya, tulipán', 'season', 'tavasz', null, null, 50],
  ['Nyári gyümölcsök – eper, cseresznye, meggy', 'season', 'nyar', null, null, 50],
  ['Egészséges életmód – mozgás és táplálkozás', 'general', null, null, null, 20],
  ['Család – rokonok és otthon', 'general', null, null, null, 20],
  ['Közlekedés – gyalogosként és járművön', 'general', null, null, null, 20],
  ['Foglalkozások – ki mit dolgozik', 'general', null, null, null, 20]
].map(([title, category, season, start_mmdd, end_mmdd, priority], index) => Object.freeze({
  id: `fallback-${index + 1}`, title, category, season, start_mmdd, end_mmdd, priority, is_active: true
})));

const pad = (number) => String(number).padStart(2, '0');

// ISO hét (2026-W46) → a hét közepe (szerda), UTC-ben. A hét 1-es számú csütörtökét tartalmazó hét az 1. hét.
function isoWeekToDate(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOfWeek1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  return new Date(mondayOfWeek1.getTime() + ((week - 1) * 7 + 2) * 86400000);
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

// A bemenet: YYYY-MM-DD vagy ISO hét (YYYY-Www / YYYY-ww); üres érték esetén a `now`. Hibás érték 400-as hiba, nem csendes tartalék.
function parseDateInput(value, now = new Date()) {
  const text = String(value ?? '').trim();
  if (!text) return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const date = validCalendarDate(Number(day[1]), Number(day[2]), Number(day[3]));
    if (date) return date;
  }
  const week = /^(\d{4})-W(\d{2})$/i.exec(text);
  if (week) {
    const year = Number(week[1]);
    const number = Number(week[2]);
    const weeksInYear = isoWeekToDate(year, 53).getUTCFullYear() === year ? 53 : 52;
    if (number >= 1 && number <= weeksInYear) return isoWeekToDate(year, number);
  }
  throw new ThemeSuggestionError('Érvénytelen dátum. Használd az ÉÉÉÉ-HH-NN vagy az ÉÉÉÉ-Www (pl. 2026-W46) formátumot.');
}

const mmddOf = (date) => `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

function seasonOf(mmdd) {
  const month = Number(String(mmdd).slice(0, 2));
  if (month >= 3 && month <= 5) return 'tavasz';
  if (month >= 6 && month <= 8) return 'nyar';
  if (month >= 9 && month <= 11) return 'osz';
  return 'tel';
}

// Az MM-DD karakterlánc rendezése megegyezik a naptári sorrenddel; a start > end tartomány az évfordulón átnyúlik (pl. 12-20 – 01-10).
function inWindow(mmdd, start, end) {
  if (!MMDD_PATTERN.test(String(start)) || !MMDD_PATTERN.test(String(end))) return false;
  return start <= end ? mmdd >= start && mmdd <= end : mmdd >= start || mmdd <= end;
}

function compareSuggestions(a, b) {
  return (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.title).localeCompare(String(b.title), 'hu');
}

// 1) a dátumra eső jeles napok, 2) kevés találatnál az évszak témái, 3) majd az általános tartalék; a végeredmény priority DESC, title ASC.
function selectSuggestions(rows, mmdd, limit = MAX_SUGGESTIONS) {
  const active = (rows || []).filter((row) => row && row.is_active !== false);
  const season = seasonOf(mmdd);
  const events = active.filter((row) => row.category === 'event' && inWindow(mmdd, row.start_mmdd, row.end_mmdd)).sort(compareSuggestions);
  const picked = events.slice(0, limit);
  if (picked.length < limit) {
    const seasonal = active.filter((row) => row.category === 'season' && row.season === season).sort(compareSuggestions);
    picked.push(...seasonal.slice(0, limit - picked.length));
  }
  if (picked.length < limit) {
    const general = active.filter((row) => row.category === 'general').sort(compareSuggestions);
    picked.push(...general.slice(0, limit - picked.length));
  }
  return picked.sort(compareSuggestions);
}

const publicItem = (row) => ({ id: row.id, title: row.title, category: row.category, priority: row.priority });

async function fetchActiveRows(client) {
  const { data, error } = await client.from(TABLE).select(PUBLIC_COLUMNS).eq('is_active', true);
  if (error) throw new Error(error.message || 'Ismeretlen adatbázishiba');
  return data || [];
}

// Nyilvános ajánlás egy dátumra. Adatbázishiba vagy üres tábla esetén a beépített alap szolgál ki, a `source` mező és a napló jelzi.
async function suggestionsForDate(client, dateInput, now = new Date()) {
  const date = parseDateInput(dateInput, now);
  const mmdd = mmddOf(date);
  const result = { date: date.toISOString().slice(0, 10), season: seasonOf(mmdd) };
  let rows = [];
  let reason = '';
  if (!client) {
    reason = 'nincs Supabase kapcsolat';
  } else {
    try {
      rows = await fetchActiveRows(client);
      if (!rows.length) reason = 'a theme_suggestions tábla üres';
    } catch (error) {
      reason = error.message;
    }
  }
  if (reason) {
    logger.error('theme_suggestions', `A téma-ajánlások az adatbázisból nem olvashatók (${reason}), a beépített alap szolgál ki.`);
    return { ...result, source: 'fallback', suggestions: selectSuggestions(FALLBACK_ROWS, mmdd).map(publicItem) };
  }
  return { ...result, source: 'database', suggestions: selectSuggestions(rows, mmdd).map(publicItem) };
}

// ---------- Admin ----------

function cleanMmdd(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const match = MMDD_PATTERN.exec(text);
  const month = match ? Number(text.slice(0, 2)) : 0;
  if (!match || Number(text.slice(3)) > DAYS_IN_MONTH[month - 1]) {
    throw new ThemeSuggestionError(`A(z) ${label} formátuma HH-NN legyen (pl. 11-11), létező naptári napra.`);
  }
  return text;
}

// A teljes (összevont) rekord validálása; a PUT részleges módosítása is ezen megy át.
function validateSuggestion(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!body) throw new ThemeSuggestionError('A kérés törzse JSON objektum legyen.');
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new ThemeSuggestionError('A téma szövege kötelező.');
  if (title.length > MAX_TITLE_LENGTH) throw new ThemeSuggestionError(`A téma szövege legfeljebb ${MAX_TITLE_LENGTH} karakter lehet.`);
  if (!CATEGORIES.includes(body.category)) throw new ThemeSuggestionError('A típus „event”, „season” vagy „general” lehet.');
  const season = body.season === undefined || body.season === null || body.season === '' ? null : body.season;
  if (season !== null && !SEASONS.includes(season)) throw new ThemeSuggestionError('Az évszak tavasz, nyar, osz vagy tel lehet.');
  const start = cleanMmdd(body.start_mmdd, 'kezdő nap');
  const end = cleanMmdd(body.end_mmdd, 'záró nap');
  if ((start === null) !== (end === null)) throw new ThemeSuggestionError('A kezdő és a záró napot együtt kell megadni.');
  if (body.category === 'event' && start === null) throw new ThemeSuggestionError('Jeles napnál az időszak (kezdő és záró nap) kötelező.');
  if (body.category === 'season' && season === null) throw new ThemeSuggestionError('Évszakos témánál az évszak kötelező.');
  const priorityRaw = body.priority === undefined || body.priority === null || body.priority === '' ? DEFAULT_PRIORITY : body.priority;
  const priority = typeof priorityRaw === 'string' ? Number(priorityRaw.trim()) : priorityRaw;
  if (!Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
    throw new ThemeSuggestionError(`A prioritás ${MIN_PRIORITY} és ${MAX_PRIORITY} közötti egész szám legyen.`);
  }
  const isActive = body.is_active === undefined || body.is_active === null ? true : body.is_active;
  if (typeof isActive !== 'boolean') throw new ThemeSuggestionError('Az aktív mező igaz/hamis érték legyen.');
  return { title, category: body.category, season, start_mmdd: start, end_mmdd: end, priority, is_active: isActive };
}

function requireId(id) {
  if (!UUID_PATTERN.test(String(id || ''))) throw new ThemeSuggestionError('Érvénytelen téma-azonosító.', 400);
  return String(id);
}

function dbError(message, error) {
  // 23505: egyedi (title) megsértése.
  if (error?.code === '23505') return new ThemeSuggestionError('Ilyen szövegű téma már létezik.', 409);
  return new ThemeSuggestionError(`${message}: ${error?.message || 'ismeretlen hiba'}`, 500);
}

function monthContains(row, month) {
  if (row.category !== 'event' || !row.start_mmdd || !row.end_mmdd) return false;
  for (let day = 1; day <= DAYS_IN_MONTH[month - 1]; day += 1) {
    if (inWindow(`${pad(month)}-${pad(day)}`, row.start_mmdd, row.end_mmdd)) return true;
  }
  return false;
}

// A használatot nem ez a tábla számolja: a `counts` a közös téma-statisztika (themeStats.loadThemeCounts) eredménye,
// ugyanaz, amit az Admin főoldal „Top témák” táblája is mutat.
const usageOf = (row) => Number(row.usage_count) || 0;

const SORTERS = {
  priority: compareSuggestions,
  usage: (a, b) => usageOf(b) - usageOf(a) || compareSuggestions(a, b),
  title: (a, b) => String(a.title).localeCompare(String(b.title), 'hu')
};

function parseAdminPaging(query) {
  const page = Number.parseInt(query.page, 10);
  const rawSize = query.pageSize;
  const pageSize = Number.parseInt(rawSize, 10);
  if (rawSize !== undefined && rawSize !== '' && !ADMIN_PAGE_SIZES.includes(pageSize)) {
    throw new ThemeSuggestionError(`Az oldalméret ${ADMIN_PAGE_SIZES.join(', ')} lehet.`);
  }
  return { page: Number.isInteger(page) && page > 0 ? page : 1, pageSize: ADMIN_PAGE_SIZES.includes(pageSize) ? pageSize : ADMIN_PAGE_SIZES[1] };
}

// A „period” szűrő: „season:osz” vagy „month:11”; a külön season / month paraméter is él.
function periodFilter(query) {
  const [kind, value] = String(query.period || '').split(':');
  return {
    season: kind === 'season' ? value : query.season,
    month: kind === 'month' ? value : query.month
  };
}

// Admin lista: kereső (cím), típus, évszak (a megadott évszak hónapjaihoz eső jeles napok is), hónap és állapot szerinti szűrés,
// rendezés (priority | usage | title) és lapozás (10 / 25 / 50 / 100 sor).
async function listSuggestions(client, query = {}, counts = new Map()) {
  const paging = parseAdminPaging(query);
  const sort = SORTS.includes(query.sort) ? query.sort : 'priority';
  const { data: stored, error } = await client.from(TABLE).select(COLUMNS).order('priority', { ascending: false }).range(0, 4999);
  if (error) throw dbError('A téma-ajánlások lekérdezése sikertelen', error);
  const data = (stored || []).map((row) => ({ ...row, usage_count: counts.get(normalizeThemeKey(row.title))?.count || 0 }));
  const q = String(query.q || '').trim().toLocaleLowerCase('hu');
  const category = CATEGORIES.includes(query.category) ? query.category : '';
  const period = periodFilter(query);
  const season = SEASONS.includes(period.season) ? period.season : '';
  const month = Number(period.month);
  const hasMonth = Number.isInteger(month) && month >= 1 && month <= 12;
  const active = query.active === 'true' ? true : query.active === 'false' ? false : null;
  const seasonMonths = { tavasz: [3, 4, 5], nyar: [6, 7, 8], osz: [9, 10, 11], tel: [12, 1, 2] };
  const filtered = (data || [])
    .filter((row) => !q || String(row.title).toLocaleLowerCase('hu').includes(q))
    .filter((row) => !category || row.category === category)
    .filter((row) => !season || row.season === season || seasonMonths[season].some((m) => monthContains(row, m)))
    .filter((row) => !hasMonth || monthContains(row, month))
    .filter((row) => active === null || row.is_active === active)
    .sort(SORTERS[sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / paging.pageSize));
  const page = Math.min(paging.page, totalPages);
  const offset = (page - 1) * paging.pageSize;
  const suggestions = filtered.slice(offset, offset + paging.pageSize).map((row) => ({ ...row, usage_count: usageOf(row) }));
  return {
    suggestions,
    total: filtered.length,
    overall: (data || []).length,
    page,
    pageSize: paging.pageSize,
    totalPages,
    from: suggestions.length ? offset + 1 : 0,
    to: offset + suggestions.length,
    sort
  };
}

async function createSuggestion(client, body) {
  const row = validateSuggestion(body);
  const { data, error } = await client.from(TABLE).insert(row).select(COLUMNS).single();
  if (error) throw dbError('A téma mentése sikertelen', error);
  return data;
}

async function updateSuggestion(client, id, body) {
  const key = requireId(id);
  const { data: current, error: readError } = await client.from(TABLE).select(COLUMNS).eq('id', key).maybeSingle();
  if (readError) throw dbError('A téma lekérdezése sikertelen', readError);
  if (!current) throw new ThemeSuggestionError('A téma nem található.', 404);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ThemeSuggestionError('A kérés törzse JSON objektum legyen.');
  const merged = validateSuggestion({ ...current, ...body });
  const { data, error } = await client.from(TABLE).update({ ...merged, updated_at: new Date().toISOString() }).eq('id', key).select(COLUMNS).maybeSingle();
  if (error) throw dbError('A téma módosítása sikertelen', error);
  if (!data) throw new ThemeSuggestionError('A téma nem található.', 404);
  return data;
}

async function deleteSuggestion(client, id) {
  const key = requireId(id);
  const { data, error } = await client.from(TABLE).delete().eq('id', key).select('id');
  if (error) throw dbError('A téma törlése sikertelen', error);
  if (!data || !data.length) throw new ThemeSuggestionError('A téma nem található.', 404);
  return { deleted: key };
}

module.exports = {
  ThemeSuggestionError,
  CATEGORIES,
  SEASONS,
  MAX_SUGGESTIONS,
  FALLBACK_ROWS,
  isoWeekToDate,
  parseDateInput,
  mmddOf,
  seasonOf,
  inWindow,
  selectSuggestions,
  suggestionsForDate,
  validateSuggestion,
  listSuggestions,
  ADMIN_PAGE_SIZES,
  createSuggestion,
  updateSuggestion,
  deleteSuggestion
};
