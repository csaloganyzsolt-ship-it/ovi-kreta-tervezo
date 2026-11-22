'use strict';

const supabase = require('./supabaseService');

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

function trimPlans() {
  // A Map beszúrási sorrendet őriz, ezért az első kulcs a legrégebbi.
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
}

function planModeOf(plan) {
  return plan?.planMode === 'academic' || plan?.is_thematic === true || plan?.request?.planMode === 'academic' ? 'academic' : 'standard';
}

// A Supabase `documents` tábla: document_id (PK), plan_mode, unlocked, data (jsonb: { plan, meta }), user_id (uuid), user_email (text), created_at, updated_at.
async function persist(id, entry) {
  const client = supabase.getClient();
  if (!client) return;
  const { error } = await client.from('documents').upsert({
    document_id: id,
    plan_mode: planModeOf(entry.plan),
    unlocked: entry.unlocked === true,
    data: { plan: entry.plan, meta: entry.meta },
    // Csak az ismert tulajdonos-mezők kerülnek az upsertbe, így a tulajdonos nélküli mentés nem töröl semmit.
    ...(entry.userId ? { user_id: entry.userId } : {}),
    ...(entry.userEmail ? { user_email: entry.userEmail } : {}),
    updated_at: new Date().toISOString()
  }, { onConflict: 'document_id' });
  if (error) throw new Error(`A tervezet Supabase-be mentése sikertelen (${id}): ${error.message}`);
}

function normalizeOwnerEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email && email.length <= 254 ? email : '';
}

// owner: { userId?, email? } – bejelentkezett felhasználó vagy a vásárló e-mail címe; egy másik user_id-hoz rendelt tervezet tulajdonosát nem írja felül.
function applyOwner(entry, owner) {
  const userId = owner?.userId ? String(owner.userId) : '';
  const email = normalizeOwnerEmail(owner?.email);
  if (userId) {
    if (!entry.userId) entry.userId = userId;
    if (entry.userId === userId && email) entry.userEmail = email;
  } else if (email && !entry.userId) {
    entry.userEmail = email;
  }
}

// A generálás nem akad meg a mentésen: a memória a mérvadó addig, a hiba pedig a naplóban jelenik meg.
function savePlan(id, plan, owner) {
  if (!id || !plan) return Promise.resolve();
  const key = String(id);
  const stored = plan.request === undefined ? plan : { ...plan, request: sanitizeRequest(plan.request) };
  const previous = plans.get(key);
  const entry = { plan: stored, createdAt: Date.now(), unlocked: previous?.unlocked === true, meta: previous?.meta || {}, userId: previous?.userId || null, userEmail: previous?.userEmail || '' };
  applyOwner(entry, owner);
  plans.delete(key);
  plans.set(key, entry);
  trimPlans();
  return persist(key, entry).catch((error) => console.error('[supabase]', error.message));
}

// Szerver-újraindítás után a memóriából hiányzó tervet a Supabase-ből tölti vissza; hiba esetén dob, nem tér vissza csendben null-lal.
// A feloldott vagy felhasználóhoz rendelt tervezet nem jár le; a gazdátlan piszkozat 48 óra után igen.
async function loadPlan(id) {
  const local = getPlan(id);
  if (local) return local;
  const client = supabase.getClient();
  if (!client || !id) return null;
  const key = String(id).slice(0, 100);
  const { data, error } = await client.from('documents').select('document_id, unlocked, user_id, user_email, data, created_at').eq('document_id', key).maybeSingle();
  if (error) throw new Error(`A tervezet Supabase-ből olvasása sikertelen: ${error.message}`);
  if (!data?.data?.plan) return null;
  if (data.unlocked !== true && !data.user_id && data.created_at && Date.now() - Date.parse(data.created_at) > MAX_AGE_MS) return null;
  hydrate(key, data);
  return data.data.plan;
}

function hydrate(key, row) {
  plans.set(key, { plan: row.data.plan, createdAt: Date.now(), unlocked: row.unlocked === true, meta: row.data.meta || {}, userId: row.user_id || null, userEmail: row.user_email || '' });
  trimPlans();
}

// A dokumentum feloldott állapota és a hozzá tartozó metaadatok (kupon, kuponos munkamenet); ismeretlen tervnél null.
function getDocumentState(id) {
  const entry = readEntry(id);
  return entry ? { unlocked: entry.unlocked === true, ...entry.meta } : null;
}

// Memória + Supabase frissítés; a Supabase hibája továbbdobódik, hogy a hívó ne higgye feloldottnak a mentetlen állapotot.
async function updateDocument(id, { unlocked, meta } = {}) {
  if (!(await loadPlan(id))) return false;
  const entry = readEntry(id);
  if (unlocked !== undefined) entry.unlocked = unlocked === true;
  if (meta) entry.meta = { ...entry.meta, ...meta };
  await persist(String(id), entry);
  return true;
}

// Kuponos (100%) munkamenet visszakeresése újraindítás után: a munkamenet a dokumentum metaadataiban él.
async function findDocumentByCouponSession(sessionId) {
  for (const [id, entry] of plans.entries()) {
    if (entry.meta?.coupon_session?.id === sessionId && !isExpired(entry)) return { id, session: entry.meta.coupon_session };
  }
  const client = supabase.getClient();
  if (!client || !/^coupon_[0-9a-f]{32}$/.test(String(sessionId || ''))) return null;
  const { data, error } = await client.from('documents').select('document_id').eq('data->meta->coupon_session->>id', sessionId).maybeSingle();
  if (error) throw new Error(`A kuponos munkamenet Supabase-ből olvasása sikertelen: ${error.message}`);
  if (!data?.document_id || !(await loadPlan(data.document_id))) return null;
  const session = readEntry(data.document_id)?.meta?.coupon_session;
  return session ? { id: data.document_id, session } : null;
}

function requireClient() {
  const client = supabase.getClient();
  if (client) return client;
  const error = new Error('A fiókkezelés és a felhős mentés ezen a szerveren nincs bekapcsolva.');
  error.status = 503;
  error.code = 'ACCOUNTS_UNAVAILABLE';
  throw error;
}

// A fizetéskor vagy kuponbeváltáskor megadott (vagy bejelentkezett) tulajdonos rögzítése; ismeretlen tervnél false.
async function setOwner(id, owner) {
  if (!(await loadPlan(id))) return false;
  const entry = readEntry(id);
  const before = `${entry.userId}|${entry.userEmail}`;
  applyOwner(entry, owner);
  if (`${entry.userId}|${entry.userEmail}` !== before) await persist(String(id), entry);
  return true;
}

const LIST_COLUMNS = 'document_id, plan_mode, unlocked, user_id, created_at, updated_at, request:data->plan->request';
const MAX_LISTED_DOCUMENTS = 100;

function summarize(row, user) {
  const request = row.request && typeof row.request === 'object' ? row.request : {};
  return {
    id: row.document_id,
    title: String(request.theme || '').trim().slice(0, 200) || 'Cím nélküli tervezet',
    duration: request.duration === 'Heti' ? 'Heti' : 'Napi',
    planMode: row.plan_mode === 'academic' ? 'academic' : 'standard',
    unlocked: row.unlocked === true,
    owned: row.user_id === user.id,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

// A felhasználó tervei: a hozzá rendelt (user_id) és az ugyanezzel a (megerősített) e-mail címmel megvásárolt, feloldott tervek, újabbak elöl.
// Két külön lekérdezés fut (nincs szövegbe épített OR-feltétel, így az e-mail cím nem injektálhat szűrőt).
async function listUserDocuments(user) {
  const client = requireClient();
  const query = () => client.from('documents').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(MAX_LISTED_DOCUMENTS);
  const [owned, purchased] = await Promise.all([query().eq('user_id', user.id), query().eq('user_email', user.email).eq('unlocked', true)]);
  for (const result of [owned, purchased]) {
    if (result.error) throw new Error(`A mentett tervek lekérdezése sikertelen: ${result.error.message}`);
  }
  const byId = new Map();
  for (const row of [...(owned.data || []), ...(purchased.data || [])]) byId.set(row.document_id, row);
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .slice(0, MAX_LISTED_DOCUMENTS)
    .map((row) => summarize(row, user));
}

// Egy terv teljes tartalma, ha a felhasználóé (user_id) vagy az e-mail címére megvásárolt (feloldott); egyébként null, a lététét sem fedi fel.
async function getUserDocument(user, id) {
  const client = requireClient();
  const key = String(id || '').slice(0, 100);
  const { data, error } = await client.from('documents').select('document_id, plan_mode, unlocked, user_id, user_email, data, created_at').eq('document_id', key).maybeSingle();
  if (error) throw new Error(`A tervezet Supabase-ből olvasása sikertelen: ${error.message}`);
  if (!data?.data?.plan) return null;
  const allowed = data.user_id === user.id || (data.unlocked === true && data.user_email === user.email);
  if (!allowed) return null;
  hydrate(key, data);
  return { id: key, unlocked: data.unlocked === true, plan: data.data.plan };
}

// A böngésző helyi tervazonosítóit a bejelentkezett felhasználóhoz köti, ha még nincs más user_id-hoz rendelve; a került azonosítók listáját adja.
async function claimDocuments(user, ids) {
  const client = requireClient();
  const { data, error } = await client.from('documents')
    .update({ user_id: user.id, user_email: user.email, updated_at: new Date().toISOString() })
    .in('document_id', ids)
    .is('user_id', null)
    .select('document_id');
  if (error) throw new Error(`A tervek fiókhoz kötése sikertelen: ${error.message}`);
  const claimed = (data || []).map((row) => row.document_id);
  for (const id of claimed) {
    const entry = plans.get(id);
    if (entry) { entry.userId = user.id; entry.userEmail = user.email; }
  }
  return claimed;
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
  loadPlan,
  getPlan,
  hasPlan,
  getDocumentState,
  updateDocument,
  setOwner,
  listUserDocuments,
  getUserDocument,
  claimDocuments,
  findDocumentByCouponSession,
  clearPlans,
  cleanup,
  planCount,
  sanitizeRequest,
  MAX_PLANS
};
