'use strict';

// Felhasználói profil (Supabase `profiles` tábla): számlázási adatok és óvodai alapadatok. Írás/olvasás csak a backendből, a hitelesített felhasználó azonosítójával.
const supabase = require('./supabaseService');
const planStore = require('./planStore');
const logger = require('../utils/logger');
const { normalizeEmail } = require('../utils/email');

const NEWSLETTER_TABLE = 'newsletter_subscribers';
const BILLING_FIELDS = ['billing_name', 'billing_zip', 'billing_city', 'billing_address', 'billing_tax_id'];
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
// A hírlevél-állapot egyetlen forrása a newsletter_subscribers tábla (e-mail cím a kulcs), a profil csak megjeleníti.
const COLUMNS = ['email', ...Object.keys(FIELD_LIMITS)].join(', ');
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

function toProfile(row, user, subscribed = false) {
  const profile = { email: user.email };
  for (const key of Object.keys(FIELD_LIMITS)) profile[key] = row?.[key] || '';
  profile.newsletter_subscribed = subscribed === true;
  return profile;
}

async function isSubscribed(client, user) {
  const { data, error } = await client.from(NEWSLETTER_TABLE).select('subscribed').eq('email', normalizeEmail(user.email)).maybeSingle();
  if (error) throw new Error(`A hírlevél-állapot lekérdezése sikertelen: ${error.message}`);
  return data?.subscribed === true;
}

// Regisztráció (e-mail megerősítés) után a korábbi vendégadatok a fiókhoz kötése. Az SQL trigger ugyanezt végzi az auth.users oldalon;
// ez a belépéskor futó biztosíték (idempotens). Csak megerősített e-mailű felhasználóra hívható (a requireUser ezt garantálja).
async function claimGuestRecords(user) {
  const client = supabase.requireClient();
  const email = normalizeEmail(user?.email);
  if (!user?.id || !email) return { orders: 0, documents: 0, billingFilled: false };
  const link = async (table, label) => {
    const { data, error } = await client.from(table).update({ user_id: user.id }).is('user_id', null).eq('user_email', email).select('user_id');
    if (error) throw new Error(`A vendég ${label} összekapcsolása sikertelen: ${error.message}`);
    return data?.length || 0;
  };
  const orders = await link('orders', 'rendelések');
  const documents = await link('documents', 'tervezetek');
  const subscription = await client.from(NEWSLETTER_TABLE).update({ user_id: user.id }).is('user_id', null).eq('email', email);
  if (subscription.error) throw new Error(`A hírlevél-feliratkozás összekapcsolása sikertelen: ${subscription.error.message}`);

  const profile = await client.from('profiles').select(BILLING_FIELDS.join(', ')).eq('id', user.id).maybeSingle();
  if (profile.error) throw new Error(`A profil számlázási adatainak lekérdezése sikertelen: ${profile.error.message}`);
  let billingFilled = false;
  if (profile.data && BILLING_FIELDS.every((field) => !String(profile.data[field] || '').trim())) {
    const latest = await client.from('orders').select('billing, created_at').eq('user_id', user.id).not('billing', 'is', null).order('created_at', { ascending: false }).limit(1);
    if (latest.error) throw new Error(`A legutóbbi számlázási adat lekérdezése sikertelen: ${latest.error.message}`);
    const billing = latest.data?.[0]?.billing;
    if (billing && typeof billing === 'object') {
      const fill = {};
      const source = { billing_name: billing.name, billing_zip: billing.zip, billing_city: billing.city, billing_address: billing.address, billing_tax_id: billing.taxId ?? billing.tax_id };
      for (const [field, value] of Object.entries(source)) {
        if (typeof value === 'string' && value.trim()) fill[field] = cleanText(value, FIELD_LIMITS[field]);
      }
      if (Object.keys(fill).length) {
        const saved = await client.from('profiles').update(fill).eq('id', user.id);
        if (saved.error) throw new Error(`A számlázási adatok előtöltése sikertelen: ${saved.error.message}`);
        billingFilled = true;
      }
    }
  }
  return { orders, documents, billingFilled };
}

// A hívó (profil/lista lekérés) nem bukhat el az összekapcsoláson, de a hiba a rendszernaplóba kerül.
async function claimGuestRecordsSafe(user) {
  try {
    return await claimGuestRecords(user);
  } catch (error) {
    logger.error('guest_claim', error.message, { email: user?.email });
    return null;
  }
}

async function getProfile(user) {
  const client = supabase.requireClient();
  const { data, error } = await client.from('profiles').select(COLUMNS).eq('id', user.id).maybeSingle();
  if (error) throw new Error(`A profil lekérdezése sikertelen: ${error.message}`);
  if (!data) {
    // A regisztrációs trigger előtti fiókoknál hiányozhat a sor: létrehozzuk.
    const created = await client.from('profiles').upsert({ id: user.id, email: normalizeEmail(user.email) }, { onConflict: 'id', ignoreDuplicates: true });
    if (created.error) throw new Error(`A profil létrehozása sikertelen: ${created.error.message}`);
  }
  await claimGuestRecordsSafe(user);
  const fresh = data ? (await client.from('profiles').select(COLUMNS).eq('id', user.id).maybeSingle()).data || data : null;
  return toProfile(fresh, user, await isSubscribed(client, user));
}

async function saveProfile(user, body) {
  const fields = parseProfileInput(body);
  const client = supabase.requireClient();
  const { data, error } = await client.from('profiles')
    .upsert({ id: user.id, email: normalizeEmail(user.email), ...fields }, { onConflict: 'id' })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`A profil mentése sikertelen: ${error.message}`);
  return toProfile(data, user, await isSubscribed(client, user));
}

// A fizetésnél megadott (vagy módosított) számlázási adat visszaírása a bejelentkezett felhasználó profiljába. A hibát a hívó naplózza: a fizetést nem akaszthatja meg.
async function rememberBilling(user, billing) {
  return saveProfile(user, { billing_name: billing?.name, billing_zip: billing?.zip, billing_city: billing?.city, billing_address: billing?.address, ...(billing?.taxNumber ? { billing_tax_id: billing.taxNumber } : {}) });
}

// Hírlevél: a profilból csak feliratkozni lehet; a leiratkozás kizárólag a leveleken lévő, tokenes linkkel történik.
// A newsletter_token az első beszúrásnál keletkezik (az upsert nem érinti), így a korábban kiküldött leiratkozó linkek érvényesek maradnak.
async function subscribeNewsletter(user) {
  const client = supabase.requireClient();
  const current = await getProfile(user);
  if (current.newsletter_subscribed) return current;
  const { error } = await client.from(NEWSLETTER_TABLE).upsert({
    email: normalizeEmail(user.email),
    user_id: user.id,
    subscribed: true,
    subscribed_at: new Date().toISOString(),
    unsubscribed_at: null
  }, { onConflict: 'email' });
  if (error) throw new Error(`A feliratkozás sikertelen: ${error.message}`);
  return { ...current, newsletter_subscribed: true };
}

// Vendég feliratkozás fizetéskor: az e-mail cím az elsődleges kulcs; ha már szerepel, a név frissül és a feliratkozás újra aktív lesz.
async function subscribeGuest({ email, name } = {}) {
  const address = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) || address.length > 254) throw new ProfileError('Érvénytelen e-mail cím a feliratkozáshoz.', 400);
  const client = supabase.requireClient();
  const row = { email: address, subscribed: true, subscribed_at: new Date().toISOString(), unsubscribed_at: null };
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (cleanName) row.name = cleanName;
  const { error } = await client.from(NEWSLETTER_TABLE).upsert(row, { onConflict: 'email' });
  if (error) throw new Error(`A vendég feliratkozás sikertelen: ${error.message}`);
}

// Nyilvános, tokenes leiratkozás. Az ismeretlen vagy hibás token 404 (nem derül ki, hogy melyik cím létezik).
async function unsubscribeNewsletter(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new ProfileError('A leiratkozási link érvénytelen vagy lejárt.', 404);
  const client = supabase.requireClient();
  const { data, error } = await client.from(NEWSLETTER_TABLE)
    .update({ subscribed: false, unsubscribed_at: new Date().toISOString() })
    .eq('newsletter_token', token.toLowerCase())
    .select('email');
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
  // A törölt fiók hírlevél-feliratkozása is megszűnik (a sor megmarad, de nem aktív).
  const unsubscribed = await client.from(NEWSLETTER_TABLE).update({ subscribed: false, unsubscribed_at: new Date().toISOString() }).eq('email', normalizeEmail(user.email));
  if (unsubscribed.error) logger.error('profile', `A törölt fiók hírlevél-feliratkozásának leállítása sikertelen: ${unsubscribed.error.message}`, { email: user.email });
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

module.exports = { ProfileError, FIELD_LIMITS, parseProfileInput, getProfile, saveProfile, rememberBilling, claimGuestRecords, claimGuestRecordsSafe, subscribeNewsletter, subscribeGuest, unsubscribeNewsletter, deleteAccount, purgeExpiredArchives };
