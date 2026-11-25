'use strict';

const supabase = require('../services/supabaseService');
const { normalizeEmail } = require('./email');

const LEVELS = ['info', 'warning', 'error'];
const MAX_MESSAGE = 1000;
const MAX_DETAIL_VALUE = 500;
const SECRET_KEY_PATTERN = /key|secret|token|password|authorization|iban|card/i;

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

// A naplóba csak rövid, titokmentes részletek kerülhetnek (kulcsok, tokenek, jelszavak soha).
function sanitizeDetails(details) {
  const clean = {};
  for (const [key, value] of Object.entries(details && typeof details === 'object' ? details : {})) {
    if (SECRET_KEY_PATTERN.test(key) || value === undefined) continue;
    clean[key] = typeof value === 'object' && value !== null ? clip(JSON.stringify(value), MAX_DETAIL_VALUE) : typeof value === 'string' ? clip(value, MAX_DETAIL_VALUE) : value;
  }
  return clean;
}

// Konzolra mindig ír; a Supabase `system_logs` tábla elérhetetlensége vagy hibája csak konzolhiba, a hívó folyamatot sosem töri meg.
async function log(level, context, message, { details, email } = {}) {
  const safeLevel = LEVELS.includes(level) ? level : 'error';
  const text = clip(message instanceof Error ? message.message : message, MAX_MESSAGE);
  const consoleMethod = safeLevel === 'info' ? 'info' : safeLevel === 'warning' ? 'warn' : 'error';
  console[consoleMethod](`[${context}] ${text}`);
  try {
    const client = supabase.getClient();
    if (!client) return false;
    const { error } = await client.from('system_logs').insert({
      level: safeLevel,
      context: clip(context, 100),
      message: text,
      details: sanitizeDetails(details),
      user_email: email ? normalizeEmail(clip(email, 254)) : null
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    console.error(`[logger] A rendszernapló mentése sikertelen: ${error.message}`);
    return false;
  }
}

module.exports = {
  log,
  info: (context, message, options) => log('info', context, message, options),
  warning: (context, message, options) => log('warning', context, message, options),
  error: (context, message, options) => log('error', context, message, options),
  sanitizeDetails,
  LEVELS
};
