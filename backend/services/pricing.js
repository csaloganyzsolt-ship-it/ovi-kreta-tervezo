'use strict';

// Egyetlen árforrás (bruttó Ft; az egyéni vállalkozó AAM számláján nettó = bruttó): a Stripe, a számlázás és a jövőbeli Barion is innen számol.
// 4 árkategória (system_settings -> pricing): daily, weekly (a teljes heti csomag ára), academic_daily, academic_weekly; a heti összesítő (weekly_summary) a daily árat használja.
const settingsService = require('./settingsService');

const STANDARD_NAME = 'OviTervező – Online szoftverhasználati díj';

const PRODUCTS = Object.freeze({
  daily: Object.freeze({ key: 'daily', planMode: 'standard', name: `${STANDARD_NAME} (1 alkalom)`, invoiceName: `${STANDARD_NAME} (1 alkalom)`, amountHuf: 390 }),
  weekly_summary: Object.freeze({ key: 'weekly_summary', planMode: 'standard', name: `${STANDARD_NAME} – heti összesítő`, invoiceName: `${STANDARD_NAME} – heti összesítő`, amountHuf: 390 }),
  weekly_package: Object.freeze({ key: 'weekly_package', planMode: 'standard', name: `${STANDARD_NAME} – teljes heti csomag`, invoiceName: `${STANDARD_NAME} – teljes heti csomag`, amountHuf: 890 }),
  academic_daily: Object.freeze({ key: 'academic_daily', planMode: 'academic', name: `${STANDARD_NAME} – oktatási célú napi tervezet (1 alkalom)`, invoiceName: `${STANDARD_NAME} – oktatási célú napi tervezet (1 alkalom)`, amountHuf: 690 }),
  academic_weekly: Object.freeze({ key: 'academic_weekly', planMode: 'academic', name: `${STANDARD_NAME} – oktatási célú heti tematikus terv`, invoiceName: `${STANDARD_NAME} – oktatási célú heti tematikus terv`, amountHuf: 690 })
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

// Az ár mindig a szerver beállításából (system_settings -> pricing) jön, a kliens csak a csomag azonosítóját adja.
// A statikus PRODUCTS ár csak az adatbázis nélküli alapérték.
function productFor(plan, planMode, pricing = settingsService.peek().pricing) {
  const key = resolveProductKey(plan, planMode);
  if (!key) return null;
  const amountHuf = pricing?.[settingsService.pricingTierFor(key)];
  return Number.isInteger(amountHuf) && amountHuf > 0 ? { ...PRODUCTS[key], amountHuf } : PRODUCTS[key];
}

module.exports = { PRODUCTS, resolveProductKey, productFor };
