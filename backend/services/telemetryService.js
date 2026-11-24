'use strict';

const supabase = require('./supabaseService');

// Engedélyezett eseménynevek (whitelist)
const ALLOWED_EVENTS = new Set([
  'page_view',
  'generator_started',
  'document_generated',
  'paywall_opened',
  'coupon_box_opened',
  'download_docx',
  'download_pdf',
  'auth_modal_opened'
]);

// Eszköztípus meghatározása a viewport szélességéből
function detectDeviceType(viewportWidth) {
  if (!viewportWidth || viewportWidth < 0) return null;
  if (viewportWidth < 768) return 'mobile';
  if (viewportWidth < 1024) return 'tablet';
  return 'desktop';
}

// Referrer domain kinyerése (parse URL)
function extractReferrerDomain(referrer) {
  if (!referrer || typeof referrer !== 'string') return null;
  try {
    const url = new URL(referrer);
    return url.hostname || null;
  } catch {
    return null;
  }
}

const DEVICE_TYPES = new Set(['mobile', 'tablet', 'desktop']);
const METADATA_KEYS = ['plan_mode', 'age_group', 'theme_category', 'utm_source'];

// Csak a névtelen szakmai kulcsok maradnak meg, rövid szövegként; minden más (pl. azonosító, időbélyeg) eldobódik.
function sanitizeMetadata(metadata) {
  const clean = {};
  if (!metadata || typeof metadata !== 'object') return clean;
  for (const key of METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) clean[key] = value.trim().slice(0, 80);
  }
  return clean;
}

function sanitizeDeviceType(value) {
  return DEVICE_TYPES.has(value) ? value : null;
}

function sanitizeReferrerDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  return /^[a-z0-9.-]{1,100}$/.test(domain) && domain.includes('.') ? domain : null;
}

// Telemetria esemény logolása
async function logEvent(eventName, options = {}) {
  const client = supabase.getClient();
  if (!client) {
    // Ha nincs Supabase, hallgatólag döntünk (dev módban naplózunk, prod-ban figyelmen kívül hagyjuk)
    if (process.env.NODE_ENV === 'development') {
      console.log(`[telemetry] ${eventName}`, options);
    }
    return { success: false, reason: 'supabase_unavailable' };
  }

  // Validáció: eseménynév whitelistben van-e
  if (!ALLOWED_EVENTS.has(eventName)) {
    console.warn(`[telemetry] Érvénytelen eseménynév: ${eventName}`);
    return { success: false, reason: 'invalid_event' };
  }

  try {
    const {
      category = null,
      deviceType = null,
      referrerDomain = null,
      metadata = {}
    } = options;

    // PII-mentesség ellenőrzése a metaadatokban
    const cleanMetadata = sanitizeMetadata(metadata);
    if (isPIIDetected(JSON.stringify(cleanMetadata))) {
      console.error(`[telemetry] PII észlelt az eseményben: ${eventName}`);
      return { success: false, reason: 'pii_detected' };
    }

    const record = {
      event_name: eventName,
      category: category || null,
      device_type: sanitizeDeviceType(deviceType),
      referrer_domain: sanitizeReferrerDomain(referrerDomain),
      metadata: cleanMetadata
    };

    const { error } = await client
      .from('analytics_events')
      .insert(record);

    if (error) {
      console.error(`[telemetry] Supabase beszúrás hiba (${eventName}):`, error.message);
      return { success: false, reason: 'database_error' };
    }

    return { success: true };
  } catch (error) {
    console.error(`[telemetry] Hiba az eseménytől (${eventName}):`, error.message);
    return { success: false, reason: 'exception' };
  }
}

// Egyszerű PII detektálás (Email, IP-cím, Telefonszám, User ID minták)
function isPIIDetected(str) {
  if (!str || typeof str !== 'string') return false;

  // Email cím
  if (/@/.test(str) && /\w+@[\w.-]+\.\w+/.test(str)) return true;

  // IP-cím (IPv4/IPv6 imitáció)
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(str)) return true;

  // 10+ számjegyű telefon (nemzetközi formátumok)
  if (/\+?\d{10,}/.test(str)) return true;

  // UUID/user_id/token minták (hozzávetőleges)
  if (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|user_[0-9a-f]{20,}|token_[a-zA-Z0-9]{32,})/i.test(str)) return true;

  return false;
}

module.exports = {
  logEvent,
  detectDeviceType,
  extractReferrerDomain,
  sanitizeMetadata,
  isPIIDetected,
  ALLOWED_EVENTS
};
