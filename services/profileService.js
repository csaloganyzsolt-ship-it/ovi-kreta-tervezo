'use strict';

// Felhasználói profil (Supabase `profiles` tábla): számlázási adatok és óvodai alapadatok. Írás/olvasás csak a backendből, a hitelesített felhasználó azonosítójával.
const supabase = require('./supabaseService');
const planStore = require('./planStore');

const FIELD_LIMITS = Object.freeze({
  full_name: 120,
  billing_name: 120,
  billing_zip: 10,
  billing_city: 80,
  billing_address: 120,
  billing_tax_id: 30,
  kindergarten_name: 120,
  group_name: 80
});
// Az is_admin és a newsletter_token szándékosan nincs a listán: a kliens sosem olvashatja és nem módosíthatja őket.
const COLUMNS = ['email', ...Object.keys(FIELD_LIMITS), 'newsletter_subscribed'].join(', ');
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZIP_PATTERN = /^[0-9A-Za-z][0-9A-Za-z -]{2,9}$/;
const TAX_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z -]{0,29}$/;

class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProfileError';
    this.status = status;
  }
}

function cleanText(value, max) {
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A kérés csak az ismert mezőket fogadja el; a hiányzó kulcs változatlanul hagyja az értéket, az üres szöveg törli.
function parseProfileInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProfileError('A profiladatok megadása kötelező.');
  const fields = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') throw new ProfileError(`A(z) ${key} mező szöveges érték kell legyen.`);
    fields[key] = cleanText(body[key], max);
  }
  if (!Object.keys(fields).length) throw new ProfileError('Nincs menthető profiladat.');
  if (fields.billing_zip && !ZIP_PATTERN.test(fields.billing_zip)) throw new ProfileError('Az irányítószám érvénytelen.');
  if (fields.billing_tax_id && !TAX_ID_PATTERN.test(fields.billing_tax_id)) throw new ProfileError('Az adószám érvénytelen.');
  return fields;
}

function toProfile(row, user) {
  const profile = { email: user.email };
  for (const key of Object.keys(FIELD_LIMITS)) profile[key] = row?.[key] || '';
  profile.newsletter_subscribed = row?.newsletter_subscribed === true;
  return profile;
}

async function getProfile(user) {
  const client = supabase.requireClient();
  const { data, error } = await client.from('profiles').select(COLUMNS).eq('id', user.id).maybeSingle();
  if (error) throw new Error(`A profil lekérdezése sikertelen: ${error.message}`);
  if (data) return toProfile(data, user);
  // A regisztrációs trigger előtti fiókoknál hiányozhat a sor: létrehozzuk.
  const created = await client.from('profiles').upsert({ id: user.id, email: user.email }, { onConflict: 'id', ignoreDuplicates: true });
  if (created.error) throw new Error(`A profil létrehozása sikertelen: ${created.error.message}`);
  return toProfile(null, user);
}

async function saveProfile(user, body) {
  const fields = parseProfileInput(body);
  const client = supabase.requireClient();
  const { data, error } = await client.from('profiles')
    .upsert({ id: user.id, email: user.email, ...fields }, { onConflict: 'id' })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`A profil mentése sikertelen: ${error.message}`);
  return toProfile(data, user);
}

// A fizetésnél megadott (vagy módosított) számlázási adat visszaírása a bejelentkezett felhasználó profiljába. A hibát a hívó naplózza: a fizetést nem akaszthatja meg.
async function rememberBilling(user, billing) {
  return saveProfile(user, { billing_name: billing?.name, billing_zip: billing?.zip, billing_city: billing?.city, billing_address: billing?.address });
}

// Hírlevél: a profilból csak feliratkozni lehet; a leiratkozás kizárólag a leveleken lévő, tokenes linkkel történik.
async function subscribeNewsletter(user) {
  const client = supabase.requireClient();
  const current = await getProfile(user);
  if (current.newsletter_subscribed) return current;
  const { data, error } = await client.from('profiles')
    .update({ newsletter_subscribed: true, newsletter_subscribed_at: new Date().toISOString() })
    .eq('id', user.id)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`A feliratkozás sikertelen: ${error.message}`);
  return toProfile(data, user);
}

// Nyilvános, tokenes leiratkozás: az ismeretlen vagy hibás token 404 (nem derül ki, hogy melyik fiók létezik).
async function unsubscribeNewsletter(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new ProfileError('A leiratkozási link érvénytelen vagy lejárt.', 404);
  const client = supabase.requireClient();
  const { data, error } = await client.from('profiles').update({ newsletter_subscribed: false }).eq('newsletter_token', token.toLowerCase()).select('id');
  if (error) throw new Error(`A leiratkozás sikertelen: ${error.message}`);
  if (!data?.length) throw new ProfileError('A leiratkozási link érvénytelen vagy lejárt.', 404);
}

const ARCHIVE_TABLE = 'deleted_accounts_archive';
const RESTORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Fióktörlés: előbb archívum (profil + tervezet-azonosítók, 30 napig), aztán az auth-felhasználó törlése. Az `orders` a számviteli megőrzés (8 év) miatt marad.
// A tervezetek a user_id külső kulcs (ON DELETE SET NULL) miatt elszakadnak a fióktól; tartalmuk az archívum lejártáig megmarad, utána purgeExpiredArchives törli.
async function deleteAccount(user) {
  const client = supabase.requireClient();
  const profile = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (profile.error) throw new Error(`A profil archiválása sikertelen: ${profile.error.message}`);
  const documentIds = await planStore.listOwnedDocumentIds(user);
  const archived = await client.from(ARCHIVE_TABLE).insert({
    original_user_id: user.id,
    email: user.email,
    profile_data: profile.data || {},
    document_ids: documentIds,
    restore_until: new Date(Date.now() + RESTORE_DAYS * DAY_MS).toISOString()
  }).select('id').single();
  if (archived.error) throw new Error(`A fiók archiválása sikertelen: ${archived.error.message}`);

  const { error } = await client.auth.admin.deleteUser(user.id);
  if (error) {
    const rollback = await client.from(ARCHIVE_TABLE).delete().eq('id', archived.data.id);
    if (rollback.error) console.error('[profil] A sikertelen törlés archív sora nem távolítható el:', rollback.error.message);
    throw new Error(`A fiók törlése sikertelen: ${error.message}`);
  }
  // A fiók már nincs meg: a visszamaradó adatok takarítása nem állíthatja meg a törlés sikerét.
  await planStore.detachUserData(user, documentIds).catch((cleanupError) => console.error('[profil]', cleanupError.message));
}

// A lejárt archívumok és a hozzájuk tartozó, gazdátlan tervezetek végleges törlése.
async function purgeExpiredArchives() {
  const client = supabase.getClient();
  if (!client) return 0;
  const { data, error } = await client.from(ARCHIVE_TABLE).select('id, document_ids').lt('restore_until', new Date().toISOString()).limit(50);
  if (error) throw new Error(`A lejárt archívumok lekérdezése sikertelen: ${error.message}`);
  for (const row of data || []) {
    await planStore.deleteDetachedDocuments(row.document_ids || []);
    const removed = await client.from(ARCHIVE_TABLE).delete().eq('id', row.id);
    if (removed.error) throw new Error(`A lejárt archívum törlése sikertelen: ${removed.error.message}`);
  }
  return (data || []).length;
}

// Induláskor (a gyakori újraindítások miatt) és naponta egyszer fut.
const runPurge = () => purgeExpiredArchives().catch((error) => console.error('[profil]', error.message));
setTimeout(runPurge, 60 * 1000).unref();
setInterval(runPurge, DAY_MS).unref();

module.exports = { ProfileError, FIELD_LIMITS, parseProfileInput, getProfile, saveProfile, rememberBilling, subscribeNewsletter, unsubscribeNewsletter, deleteAccount, purgeExpiredArchives };
