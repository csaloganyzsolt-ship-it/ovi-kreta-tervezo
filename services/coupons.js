'use strict';

const crypto = require('node:crypto');

// Belső kuponok: a kódok a backend konfigurációjából jönnek (COUPON_CODES, vesszővel elválasztott 100%-os kódok).
// Beállítás nélkül egyetlen kód él: TEST100. Üres COUPON_CODES kikapcsolja a kuponokat.
const DEFAULT_COUPON_CODES = ['TEST100'];
const SESSION_PREFIX = 'coupon_';
const MAX_SESSIONS = 5000;

// generationId -> kuponos "fizetési munkamenet"; a Stripe-munkamenetekkel azonos alakban használható a kézbesítéshez.
const sessions = new Map();

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

// Ugyanarra a tervre ismételt beváltás ugyanazt a munkamenetet adja, így a levél egyszer megy ki.
function redeem({ code, generationId, email, plan, planMode }) {
  const existing = sessions.get(generationId);
  if (existing) return existing;
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
  sessions.set(generationId, session);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return session;
}

function getSession(id) {
  if (!isCouponSessionId(id)) return null;
  for (const session of sessions.values()) if (session.id === id) return session;
  return null;
}

function resetSessions() {
  sessions.clear();
}

module.exports = { DEFAULT_COUPON_CODES, couponCodes, isValidCode, isCouponSessionId, redeem, getSession, resetSessions };
