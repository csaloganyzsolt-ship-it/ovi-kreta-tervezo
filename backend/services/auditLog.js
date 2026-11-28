'use strict';

// Admin módosítások naplózása a system_settings_history táblába (a Rendszernapló „Módosítási napló” fülén jelenik meg).
// A system_settings UPDATE-jét a trigger is naplózza; a mentés utáni explicit bejegyzés a duplázást kihagyja, az első (INSERT) mentést viszont pótolja.
// A naplózási hiba soha nem akasztja meg a mentést (csak figyelmeztetés).

const isEqual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function isMissingColumn(error) {
  return error?.code === '42703' || error?.code === 'PGRST204' || /column .*(does not exist|schema cache)|could not find the/i.test(String(error?.message || ''));
}

async function recordChange(client, key, before, after, actor = '') {
  try {
    if (!client || isEqual(before, after)) return false;
    const latest = await client.from('system_settings_history').select('id, new_value').eq('setting_key', key).order('changed_at', { ascending: false }).limit(1);
    const last = Array.isArray(latest?.data) ? latest.data[0] : null;
    if (last && isEqual(last.new_value, after)) return false;
    const row = { setting_key: key, old_value: before ?? null, new_value: after ?? null };
    const by = String(actor || '').trim().slice(0, 254);
    let { error } = await client.from('system_settings_history').insert(by ? { ...row, changed_by: by } : row);
    if (error && by && isMissingColumn(error)) ({ error } = await client.from('system_settings_history').insert(row));
    if (error) throw new Error(error.message || 'insert hiba');
    return true;
  } catch (error) {
    console.warn(`[audit] A(z) ${key} módosítása nem naplózható: ${error.message}`);
    return false;
  }
}

const THEME_FIELDS = ['title', 'category', 'season', 'start_mmdd', 'end_mmdd', 'priority', 'is_active'];
const THEME_FIELD_LABELS = { title: 'szöveg', category: 'típus', season: 'évszak', start_mmdd: 'kezdet', end_mmdd: 'vég', priority: 'prioritás', is_active: 'állapot' };
const THEME_KEY_PREFIX = 'theme_suggestion:';

const themeKey = (id) => `${THEME_KEY_PREFIX}${id}`;
const isThemeKey = (key) => typeof key === 'string' && key.startsWith(THEME_KEY_PREFIX);

function themeSnapshot(row) {
  if (!row) return null;
  return { id: row.id, ...Object.fromEntries(THEME_FIELDS.map((field) => [field, row[field] ?? null])) };
}

function describePlanner(before, after) {
  const count = (value) => Object.keys(value?.texts || {}).length + Object.keys(value?.optionLists || {}).length;
  const texts = new Set([...Object.keys(before?.texts || {}), ...Object.keys(after?.texts || {})]);
  const changedTexts = [...texts].filter((key) => !isEqual(before?.texts?.[key], after?.texts?.[key])).length;
  const lists = new Set([...Object.keys(before?.optionLists || {}), ...Object.keys(after?.optionLists || {})]);
  const changedLists = [...lists].filter((key) => !isEqual(before?.optionLists?.[key], after?.optionLists?.[key]));
  if (!count(after) && count(before)) return 'Tervező űrlap: minden szöveg és lista visszaállítva az alapértelmezésre.';
  const parts = [];
  if (changedTexts) parts.push(`${changedTexts} szöveg`);
  if (changedLists.length) parts.push(`${changedLists.length} opciólista (${changedLists.join(', ')})`);
  return `Tervező űrlap módosítva: ${parts.join(', ') || 'nincs látható eltérés'}.`;
}

function describeTheme(before, after) {
  if (!before && after) return `Téma létrehozva: „${after.title}”.`;
  if (before && !after) return `Téma törölve: „${before.title}”.`;
  const changed = THEME_FIELDS.filter((field) => !isEqual(before?.[field], after?.[field])).map((field) => THEME_FIELD_LABELS[field]);
  return `Téma módosítva: „${after?.title || before?.title}” (${changed.join(', ') || 'nincs eltérés'}).`;
}

const PRICE_LABELS = { daily: 'Napi tervezet', weekly_summary: 'Heti összesítő alapára', weekly_extra_day: 'Kidolgozott nap felára', academic_daily: 'Oktatási napi', academic_weekly: 'Oktatási heti' };

function describePricing(before, after) {
  const changed = Object.keys(PRICE_LABELS).filter((tier) => !isEqual(before?.[tier], after?.[tier]));
  if (!changed.length) return 'Árak módosítva (nincs látható eltérés).';
  return `Árak módosítva: ${changed.map((tier) => `${PRICE_LABELS[tier]} ${before?.[tier] ?? '–'} → ${after?.[tier] ?? '–'} Ft`).join('; ')}.`;
}

const onOff = (value) => (value === true ? 'bekapcsolva' : 'kikapcsolva');

const COUPON_KEY_PREFIX = 'coupon:';
const COUPON_FIELDS = ['code', 'discount_percent', 'max_uses', 'valid_until', 'is_active', 'note'];
const COUPON_FIELD_LABELS = { discount_percent: 'kedvezmény', max_uses: 'felhasználási keret', valid_until: 'érvényesség vége', is_active: 'állapot', note: 'megjegyzés' };
const couponKey = (code) => `${COUPON_KEY_PREFIX}${code}`;
const isCouponKey = (key) => typeof key === 'string' && key.startsWith(COUPON_KEY_PREFIX);

function couponSnapshot(row) {
  if (!row) return null;
  return Object.fromEntries(COUPON_FIELDS.map((field) => [field, row[field] ?? null]));
}

function describeCoupon(before, after) {
  if (!before && after) return `Kupon létrehozva: ${after.code} (${after.discount_percent}%).`;
  if (before && !after) return `Kupon törölve: ${before.code}.`;
  const changed = Object.keys(COUPON_FIELD_LABELS).filter((field) => !isEqual(before?.[field], after?.[field])).map((field) => COUPON_FIELD_LABELS[field]);
  if (before?.is_active !== false && after?.is_active === false && /Archiválva/.test(String(after.note || ''))) return `Kupon archiválva: ${after.code}.`;
  return `Kupon módosítva: ${after?.code || before?.code} (${changed.join(', ') || 'nincs eltérés'}).`;
}

// Magyar összefoglaló egy history-sorhoz (olvasáskor számolva, nincs külön oszlop).
function describeChange(key, before, after) {
  if (key === 'planner_config') return describePlanner(before, after);
  if (isThemeKey(key)) return describeTheme(before, after);
  if (isCouponKey(key)) return describeCoupon(before, after);
  if (key === 'pricing') return describePricing(before, after);
  if (key === 'maintenance_mode') return `Karbantartási mód ${onOff(after === true)}.`;
  if (key === 'payment_provider') return `Fizetési szolgáltató: ${before ?? '–'} → ${after ?? '–'}.`;
  if (key === 'billing_profile') return `Számlázási profil: ${before ?? '–'} → ${after ?? '–'}.`;
  if (key === 'daily_generation_cap') return `Napi generálási keret: ${before ?? '–'} → ${after ?? '–'}.`;
  if (key === 'announcement_bar') return `Hirdetősáv ${onOff(after?.enabled)}${after?.text ? `: „${String(after.text).slice(0, 80)}”` : ''}.`;
  if (key === 'tracking_config') {
    const labels = { barion_pixel_id: 'Barion Pixel', ga4_measurement_id: 'GA4', meta_pixel_id: 'Meta Pixel' };
    const changed = Object.keys(labels).filter((field) => !isEqual(before?.[field], after?.[field])).map((field) => `${labels[field]}: ${before?.[field] || '–'} → ${after?.[field] || '–'}`);
    return `Analitika és pixelek módosítva${changed.length ? ` (${changed.join('; ')})` : ' (nincs látható eltérés)'}.`;
  }
  if (key === 'ai_config') {
    const parts = [];
    if (before?.model !== after?.model) parts.push(`modell: ${before?.model ?? '–'} → ${after?.model ?? '–'}`);
    if (before?.system_prompt !== after?.system_prompt) parts.push('system prompt módosítva');
    return `AI beállítás módosítva${parts.length ? ` (${parts.join('; ')})` : ''}.`;
  }
  return '';
}

// Az egykattintásos visszaállítást támogató beállítások (mind a validatePatch-en át íródik vissza).
const RESTORABLE_SETTING_KEYS = Object.freeze(['planner_config', 'pricing', 'ai_config', 'maintenance_mode', 'daily_generation_cap', 'announcement_bar', 'external_links', 'tracking_config', 'billing_profile', 'payment_provider', 'notification_email', 'billing_notification_email', 'error_notification_email']);
const isRestorableKey = (key) => RESTORABLE_SETTING_KEYS.includes(key) || isThemeKey(key);

module.exports = { recordChange, describeChange, themeKey, isThemeKey, themeSnapshot, couponKey, isCouponKey, couponSnapshot, isRestorableKey, isEqual, THEME_FIELDS, THEME_KEY_PREFIX, COUPON_KEY_PREFIX, RESTORABLE_SETTING_KEYS, isMissingColumn };
