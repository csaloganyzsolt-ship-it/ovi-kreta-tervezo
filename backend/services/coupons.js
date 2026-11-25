'use strict';

const crypto = require('node:crypto');
const supabase = require('./supabaseService');
const planStore = require('./planStore');
const { PaymentError } = require('./stripeService');
const { normalizeEmail } = require('../utils/email');

// Belső kuponok (Supabase nélkül, pl. tesztben): a kódok a backend konfigurációjából jönnek (COUPON_CODES, vesszővel elválasztott 100%-os kódok).
// Beállítás nélkül egyetlen kód él: TEST100. Üres COUPON_CODES kikapcsolja a kuponokat.
// Supabase mellett a `coupons` tábla az egyetlen forrás; a COUPON_CODES nem érvényes.
const DEFAULT_COUPON_CODES = ['TEST100'];
const SESSION_PREFIX = 'coupon_';
const MAX_SESSIONS = 5000;
const CODE_PATTERN = /^[A-Z0-9_-]{1,40}$/;

// generationId -> kuponos "fizetési munkamenet"; a Stripe-munkamenetekkel azonos alakban használható a kézbesítéshez.
const sessions = new Map();
const pendingRedemptions = new Map();

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function couponCodes(env = process.env) {
  if (env.COUPON_CODES === undefined) return DEFAULT_COUPON_CODES;
  return String(env.COUPON_CODES).split(',').map(normalizeCode).filter(Boolean);
}

function isValidCode(code, env = process.env) {
  if (typeof code !== 'string') return false;
  const normalized = normalizeCode(code);
  if (!normalized || normalized.length > 40) return false;
  return couponCodes(env).includes(normalized);
}

function isCouponSessionId(id) {
  return String(id || '').startsWith(SESSION_PREFIX);
}

function couponError(message, status = 400) {
  const error = new PaymentError(message, status);
  error.code = 'INVALID_COUPON';
  return error;
}

// Kedvezményes ár egész forintra kerekítve.
function computeDiscount(originalPrice, percent) {
  const finalPrice = Math.round(originalPrice * (100 - percent) / 100);
  return { originalPrice, percent, discountAmount: originalPrice - finalPrice, finalPrice };
}

// Megkeresi és ellenőrzi a kódot: létezik, aktív, nem járt le, és a felhasználások száma a max_uses alatt van. Hibánál INVALID_COUPON kódú PaymentError.
async function lookup(code, { env = process.env, now = new Date() } = {}) {
  const normalized = typeof code === 'string' ? normalizeCode(code) : '';
  if (!normalized || normalized.length > 40) throw couponError('Érvénytelen kuponkód.');
  const client = supabase.getClient(env);
  if (!client) {
    if (!couponCodes(env).includes(normalized)) throw couponError('Érvénytelen kuponkód.');
    return { code: normalized, percent: 100 };
  }
  if (!CODE_PATTERN.test(normalized)) throw couponError('Érvénytelen kuponkód.');
  const { data, error } = await client.from('coupons').select('code, discount_percent, max_uses, valid_until, is_active').eq('code', normalized).maybeSingle();
  if (error) throw new PaymentError(`A kuponok jelenleg nem érhetők el: ${error.message}`, 503);
  if (!data) throw couponError('Érvénytelen kuponkód.');
  if (data.is_active !== true) throw couponError('Ez a kupon már nem aktív.');
  if (data.valid_until && Date.parse(data.valid_until) < now.getTime()) throw couponError('Ez a kupon lejárt.');
  const percent = Number(data.discount_percent);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    console.error(`[coupon] Hibás kedvezmény a(z) ${normalized} kuponnál: ${data.discount_percent}`);
    throw couponError('Ez a kupon jelenleg nem használható.');
  }
  if (data.max_uses !== null && data.max_uses !== undefined) {
    const { count, error: countError } = await client.from('coupon_redemptions').select('id', { count: 'exact', head: true }).eq('coupon_code', normalized);
    if (countError) throw new PaymentError(`A kupon felhasználásai nem kérdezhetők le: ${countError.message}`, 503);
    if ((count || 0) >= Number(data.max_uses)) throw couponError('A kupon felhasználási kerete elfogyott.');
  }
  return { code: normalized, percent };
}

// Statisztikai sor a `coupon_redemptions` táblába; Supabase nélkül nincs naplózás. Hibánál dob, hogy a beváltás ne maradjon számolatlanul.
async function logRedemption({ code, email, generationId, planMode, originalPrice, discountAmount, finalPrice }, env = process.env) {
  const client = supabase.getClient(env);
  if (!client) return false;
  const { error } = await client.from('coupon_redemptions').insert({
    coupon_code: normalizeCode(code),
    user_email: normalizeEmail(email) || null,
    document_id: generationId,
    plan_mode: planMode,
    original_price: originalPrice,
    discount_amount: discountAmount,
    final_price: finalPrice
  });
  if (error) throw new Error(`A kuponbeváltás naplózása sikertelen (${code}): ${error.message}`);
  return true;
}

function rememberSession(session) {
  sessions.set(session.generationId, session);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return session;
}

// Újraindítás után a Supabase-ben tárolt munkamenetet tölti vissza a memóriába.
function restoreSession(stored) {
  if (!stored?.id || !stored.generationId) return null;
  return sessions.get(stored.generationId) || rememberSession({ ...stored, created: new Date(stored.created) });
}

// 100%-os beváltás: ugyanarra a tervre ismételt beváltás ugyanazt a munkamenetet adja (a levél egyszer megy ki, a statisztika egyszer számol).
async function redeem({ code, generationId, email, plan, planMode, originalPrice }) {
  const existing = sessions.get(generationId);
  if (existing) return existing;
  if (pendingRedemptions.has(generationId)) return pendingRedemptions.get(generationId);
  const task = (async () => {
    const session = {
      id: `${SESSION_PREFIX}${crypto.randomBytes(16).toString('hex')}`,
      code: normalizeCode(code),
      percent: 100,
      generationId,
      email,
      plan,
      planMode,
      paid: true,
      created: new Date()
    };
    await logRedemption({ code, email, generationId, planMode, originalPrice, discountAmount: originalPrice, finalPrice: 0 });
    return rememberSession(session);
  })().finally(() => pendingRedemptions.delete(generationId));
  pendingRedemptions.set(generationId, task);
  return task;
}

function sessionFor(generationId) {
  return sessions.get(generationId) || null;
}

function getSession(id) {
  if (!isCouponSessionId(id)) return null;
  for (const session of sessions.values()) if (session.id === id) return session;
  return null;
}

// Memória, majd (újraindítás után) a Supabase `documents` tábla.
async function loadSession(id) {
  const local = getSession(id);
  if (local || !isCouponSessionId(id)) return local;
  const found = await planStore.findDocumentByCouponSession(id);
  return found ? restoreSession(found.session) : null;
}

function resetSessions() {
  sessions.clear();
}

module.exports = {
  DEFAULT_COUPON_CODES, CODE_PATTERN, normalizeCode, couponCodes, isValidCode, isCouponSessionId, sessionFor, computeDiscount, lookup, logRedemption, redeem, restoreSession, getSession, loadSession, resetSessions
};
