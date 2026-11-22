'use strict';

// Szerveroldali Supabase kliens (service/secret kulcs): csak a backend használhatja, a frontendbe soha nem kerülhet.
// Hiányzó SUPABASE_URL / SUPABASE_SECRET_KEY vagy NODE_ENV=test esetén nincs kliens, és a rendszer a memória/fájl alapú tárolással működik.
let cached = null;
let injected = null;

function isConfigured(env = process.env) {
  return Boolean(String(env.SUPABASE_URL || '').trim() && String(env.SUPABASE_SECRET_KEY || '').trim());
}

function getClient(env = process.env) {
  if (injected) return injected;
  if (env.NODE_ENV === 'test' || !isConfigured(env)) return null;
  if (!cached) {
    const { createClient } = require('@supabase/supabase-js');
    cached = createClient(String(env.SUPABASE_URL).trim(), String(env.SUPABASE_SECRET_KEY).trim(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return cached;
}

function isEnabled(env = process.env) {
  return getClient(env) !== null;
}

// Tesztekhez: mockolt kliens beállítása (NODE_ENV=test mellett is él), null-ra állítva visszaáll az alapműködés.
function setClient(client) {
  injected = client || null;
}

function resetClient() {
  injected = null;
  cached = null;
}

module.exports = { isConfigured, isEnabled, getClient, setClient, resetClient };
