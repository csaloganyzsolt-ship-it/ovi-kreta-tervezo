'use strict';

const supabase = require('./supabaseService');

class AuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function bearerToken(req) {
  const match = String(req?.headers?.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : '';
}

// A tokent a Supabase Auth ellenőrzi (aláírás, lejárat, visszavonás); csak megerősített e-mail címmel rendelkező felhasználó fogadható el.
async function verifyToken(token) {
  const client = supabase.getClient();
  if (!client) throw new AuthError('A fiókkezelés ezen a szerveren nincs bekapcsolva.', 503, 'AUTH_UNAVAILABLE');
  let result;
  try {
    result = await client.auth.getUser(token);
  } catch (error) {
    throw new AuthError(`A belépés ellenőrzése sikertelen: ${error.message}`, 503, 'AUTH_UNAVAILABLE');
  }
  const { data, error } = result || {};
  if (error) {
    const status = Number(error.status);
    if (error.name === 'AuthRetryableFetchError' || status === 0 || status >= 500) {
      throw new AuthError(`A belépés ellenőrzése sikertelen: ${error.message}`, 503, 'AUTH_UNAVAILABLE');
    }
    throw new AuthError('A munkamenet érvénytelen vagy lejárt. Jelentkezz be újra.', 401, 'AUTH_INVALID');
  }
  const user = data?.user;
  const email = normalizeEmail(user?.email);
  if (!user?.id || !email || !(user.email_confirmed_at || user.confirmed_at)) {
    throw new AuthError('A munkamenet érvénytelen vagy lejárt. Jelentkezz be újra.', 401, 'AUTH_INVALID');
  }
  return { id: String(user.id), email };
}

// Vendég módú végpontokhoz: token nélkül (vagy elfogadhatatlan tokennel) null, a kérés vendégként folytatódik.
async function optionalUser(req) {
  const token = bearerToken(req);
  if (!token || !supabase.isEnabled()) return null;
  try {
    return await verifyToken(token);
  } catch (error) {
    if (error.code !== 'AUTH_INVALID') console.error('[auth]', error.message);
    return null;
  }
}

// Védett végpontokhoz: bejelentkezés nélkül 401, érvénytelen tokennel 401, elérhetetlen Supabase-nél 503.
async function requireUser(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Ehhez a művelethez be kell jelentkezni.' });
  try {
    req.user = await verifyToken(token);
    return next();
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    if (error.status >= 500) console.error('[auth]', error.message);
    return res.status(error.status).json({ success: false, code: error.code, error: error.message });
  }
}

// Admin végpontokhoz: két független feltétel egyszerre. (1) az ADMIN_EMAIL környezeti változó be van állítva és megegyezik a felhasználó e-mail címével,
// (2) a profiles.is_admin értéke true. Bármelyik hiányában 403 (a két ok nem különböztethető meg kívülről); az is_admin értéket semmilyen API nem állítja.
const FORBIDDEN = { success: false, code: 'ADMIN_FORBIDDEN', error: 'Nincs jogosultságod ehhez a művelethez.' };

function adminEmail(env = process.env) {
  return normalizeEmail(env.ADMIN_EMAIL);
}

async function requireAdmin(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Ehhez a művelethez be kell jelentkezni.' });
  try {
    const user = await verifyToken(token);
    const expected = adminEmail();
    if (!expected || user.email !== expected) return res.status(403).json(FORBIDDEN);
    const client = supabase.requireClient();
    const { data, error } = await client.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
    if (error) throw new AuthError('Az admin jogosultság ellenőrzése sikertelen.', 503, 'AUTH_UNAVAILABLE');
    if (data?.is_admin !== true) return res.status(403).json(FORBIDDEN);
    req.user = user;
    return next();
  } catch (error) {
    if (error.status === 401) return res.status(401).json({ success: false, code: error.code, error: error.message });
    console.error('[admin-auth]', error.message);
    return res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', error: 'Az admin jogosultság ellenőrzése most nem érhető el.' });
  }
}

module.exports = { AuthError, bearerToken, normalizeEmail, verifyToken, optionalUser, requireUser, requireAdmin, adminEmail };
