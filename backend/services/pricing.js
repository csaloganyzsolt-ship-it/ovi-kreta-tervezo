'use strict';

// Egyetlen árforrás (bruttó Ft; az egyéni vállalkozó AAM számláján nettó = bruttó): a Stripe, a Barion és a számlázás innen számol.
// Az árak kizárólag a system_settings -> pricing értékből jönnek (alapérték: settingsService.DEFAULT_SETTINGS.pricing); itt nincs beégetett Ft.
// Árkulcsok: daily, weekly_summary (heti összesítő alapára), weekly_extra_day (felár kidolgozott napi tervenként csomagban), academic_daily, academic_weekly.
// Heti csomag: weekly_summary + kiválasztott napok száma × weekly_extra_day.
const settingsService = require('./settingsService');
const { WEEKDAYS, selectedDaysOf, classifyStoredPlan } = require('./weeklyScope');

const STANDARD_NAME = 'OviTervező – Online szoftverhasználati díj';

function product(key, planMode, label) {
  return Object.freeze({ key, planMode, name: `${STANDARD_NAME}${label}`, invoiceName: `${STANDARD_NAME}${label}` });
}

const PRODUCTS = Object.freeze({
  daily: product('daily', 'standard', ' (1 alkalom)'),
  weekly_summary: product('weekly_summary', 'standard', ' – heti összesítő'),
  weekly_package: product('weekly_package', 'standard', ' – heti tervezet csomag'),
  academic_daily: product('academic_daily', 'academic', ' – oktatási célú napi tervezet (1 alkalom)'),
  academic_weekly: product('academic_weekly', 'academic', ' – oktatási célú heti tematikus terv')
});

// A korábbi kulcsok (régi rendelések, gyorsítótárazott kliensek) az új termékekre képeződnek le.
const LEGACY_KEYS = Object.freeze({ weekly: 'weekly_summary', weekly_detailed: 'weekly_package' });

// A csomagkulcs és a planMode alapján a végső termékkulcs; ismeretlen csomagnál null. Az academic mód vagy kulcs soha nem fizethet standard árat.
function resolveProductKey(plan, planMode) {
  const trimmed = String(plan || '').trim();
  const raw = Object.prototype.hasOwnProperty.call(LEGACY_KEYS, trimmed) ? LEGACY_KEYS[trimmed] : trimmed;
  if (!Object.prototype.hasOwnProperty.call(PRODUCTS, raw)) return null;
  if (planMode !== 'academic' && !raw.startsWith('academic_')) return raw;
  return raw.includes('weekly') ? 'academic_weekly' : 'academic_daily';
}

function packageLabel(dayCount) {
  return `OviTervező – Heti tervezet csomag (heti összesítő + ${dayCount} kidolgozott nap)`;
}

// A termék ára az árbeállításból és (heti csomagnál) a kidolgozott napok számából; hiányzó árbeállításnál hangos hiba, nincs néma tartalék.
function priceOf(key, pricing, dayCount = WEEKDAYS.length) {
  const need = (tier) => {
    const value = pricing?.[tier];
    if (!Number.isInteger(value) || value < 0) throw new Error(`Hiányzó vagy érvénytelen árbeállítás: ${tier}.`);
    return value;
  };
  if (key === 'weekly_package') {
    const base = need('weekly_summary');
    const extraPerDay = need('weekly_extra_day');
    return { amountHuf: base + dayCount * extraPerDay, components: { base, extraPerDay, days: dayCount } };
  }
  const amountHuf = need(key);
  return { amountHuf, components: { base: amountHuf, extraPerDay: 0, days: 0 } };
}

// A fizetendő termék: az ár mindig a szerver beállításából jön; a kliens csak a csomagot (és az ellenőrzött napokat) adhatja.
function productFor(plan, planMode, pricing = settingsService.peek().pricing, options = {}) {
  const key = resolveProductKey(plan, planMode);
  if (!key) return null;
  const days = key === 'weekly_package' ? selectedDaysOf({ selectedDays: options.selectedDays }) : [];
  const { amountHuf, components } = priceOf(key, pricing, days.length);
  if (!(amountHuf > 0)) throw new Error(`Az ár nem lehet 0 Ft (${key}).`);
  const names = key === 'weekly_package' ? { name: packageLabel(days.length), invoiceName: packageLabel(days.length) } : {};
  return { ...PRODUCTS[key], ...names, amountHuf, components, selectedDays: days };
}

// A mentett tervezetből levezetett termék (planKey, planMode, weeklyScope, napok): a fizetési végpontok kizárólag ezt használják.
function productForStoredPlan(plan, pricing = settingsService.peek().pricing) {
  const classified = classifyStoredPlan(plan);
  if (!classified) return null;
  const found = productFor(classified.planKey, classified.planMode, pricing, { selectedDays: classified.selectedDays });
  return found ? { ...found, weeklyScope: classified.weeklyScope } : null;
}

// Az order.meta-ba kerülő árkomponensek (utólagos visszakereshetőség).
function orderMetaFor(found) {
  return {
    planKind: found.key,
    planMode: found.planMode,
    weeklyScope: found.weeklyScope || null,
    selectedDays: found.selectedDays,
    selectedDayCount: found.selectedDays.length,
    priceComponents: found.components
  };
}

module.exports = { PRODUCTS, resolveProductKey, productFor, productForStoredPlan, priceOf, orderMetaFor, packageLabel };
