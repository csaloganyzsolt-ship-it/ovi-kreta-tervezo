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

// Magyar összefoglaló egy history-sorhoz (olvasáskor számolva, nincs külön oszlop).
function describeChange(key, before, after) {
  if (key === 'planner_config') return describePlanner(before, after);
  if (isThemeKey(key)) return describeTheme(before, after);
  return '';
}

const isRestorableKey = (key) => key === 'planner_config' || isThemeKey(key);

module.exports = { recordChange, describeChange, themeKey, isThemeKey, themeSnapshot, isRestorableKey, isEqual, THEME_FIELDS, THEME_KEY_PREFIX, isMissingColumn };
