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
const COLUMNS = ['email', ...Object.keys(FIELD_LIMITS)].join(', ');
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

// GDPR: a fiók és a hozzá tartozó tervezetek törlődnek (a profil a fiókkal együtt, kaszkáddal). A rendelések a számviteli megőrzési kötelezettség miatt (8 év) megmaradnak, a fiókhoz kötésük megszűnik.
async function deleteAccount(user) {
  const client = supabase.requireClient();
  await planStore.eraseUserData(user);
  const { error } = await client.auth.admin.deleteUser(user.id);
  if (error) throw new Error(`A fiók törlése sikertelen: ${error.message}`);
}

module.exports = { ProfileError, FIELD_LIMITS, parseProfileInput, getProfile, saveProfile, deleteAccount };
