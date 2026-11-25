'use strict';

// Szerveroldali Supabase kliens (service/secret kulcs): csak a backend használhatja, a frontendbe soha nem kerülhet.
// Hiányzó SUPABASE_URL / titkos kulcs vagy NODE_ENV=test esetén nincs kliens; a memóriatáblák csak NODE_ENV=test alatt engedélyezettek, egyébként a tárolást igénylő műveletek 503-mal állnak le.
let cached = null;
let injected = null;

// A titkos kulcs: SUPABASE_SECRET_KEY, ennek hiányában a régebbi SUPABASE_SERVICE_ROLE_KEY elnevezés (a böngészős anon kulcsot a backend nem használja).
function secretKey(env = process.env) {
  return String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function isConfigured(env = process.env) {
  return Boolean(String(env.SUPABASE_URL || '').trim() && secretKey(env));
}

function getClient(env = process.env) {
  if (injected) return injected;
  if (env.NODE_ENV === 'test' || !isConfigured(env)) return null;
  if (!cached) {
    const { createClient } = require('@supabase/supabase-js');
    cached = createClient(String(env.SUPABASE_URL).trim(), secretKey(env), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return cached;
}

// Csak logikai állapot (kulcsot nem ad vissza): a kapcsolat aktív-e, és melyik kulcs hiányzik.
function connectionStatus(env = process.env) {
  const urlSet = Boolean(String(env.SUPABASE_URL || '').trim());
  const keySet = Boolean(secretKey(env));
  return {
    connected: getClient(env) !== null,
    urlSet,
    keySet,
    keySource: env.SUPABASE_SECRET_KEY ? 'SUPABASE_SECRET_KEY' : env.SUPABASE_SERVICE_ROLE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY' : null
  };
}

function isEnabled(env = process.env) {
  return getClient(env) !== null;
}

// Fiókfunkciókhoz: kliens nélkül 503-as hiba (nincs csendes tartalék).
function requireClient(env = process.env) {
  const client = getClient(env);
  if (client) return client;
  const error = new Error('A fiókkezelés ezen a szerveren nincs bekapcsolva.');
  error.status = 503;
  error.code = 'ACCOUNTS_UNAVAILABLE';
  throw error;
}

// Tesztekhez: mockolt kliens beállítása (NODE_ENV=test mellett is él), null-ra állítva visszaáll az alapműködés.
function setClient(client) {
  injected = client || null;
}

function resetClient() {
  injected = null;
  cached = null;
}

module.exports = { isConfigured, isEnabled, getClient, requireClient, setClient, resetClient, connectionStatus, secretKey };
