'use strict';

// Egyetlen árforrás (bruttó Ft; az egyéni vállalkozó AAM számláján nettó = bruttó): a Stripe, a számlázás és a jövőbeli Barion is innen számol.
// 4 árkategória (system_settings -> pricing): daily (a heti alapcsomag is), weekly (a heti részletes csomag), academic_daily, academic_weekly.
const settingsService = require('./settingsService');

const STANDARD_NAME = 'OviTervező – Online szoftverhasználati díj';

const PRODUCTS = Object.freeze({
  daily: Object.freeze({ key: 'daily', planMode: 'standard', name: `${STANDARD_NAME} (1 alkalom)`, invoiceName: `${STANDARD_NAME} (1 alkalom)`, amountHuf: 390 }),
  weekly: Object.freeze({ key: 'weekly', planMode: 'standard', name: `${STANDARD_NAME} – heti alapcsomag`, invoiceName: `${STANDARD_NAME} – heti alapcsomag`, amountHuf: 390 }),
  weekly_detailed: Object.freeze({ key: 'weekly_detailed', planMode: 'standard', name: `${STANDARD_NAME} – heti részletes csomag`, invoiceName: `${STANDARD_NAME} – heti részletes csomag`, amountHuf: 890 }),
  academic_daily: Object.freeze({ key: 'academic_daily', planMode: 'academic', name: `${STANDARD_NAME} – oktatási célú napi tervezet (1 alkalom)`, invoiceName: `${STANDARD_NAME} – oktatási célú napi tervezet (1 alkalom)`, amountHuf: 690 }),
  academic_weekly: Object.freeze({ key: 'academic_weekly', planMode: 'academic', name: `${STANDARD_NAME} – oktatási célú heti tematikus terv`, invoiceName: `${STANDARD_NAME} – oktatási célú heti tematikus terv`, amountHuf: 690 })
});

// A csomagkulcs és a planMode alapján a végső termékkulcs; ismeretlen csomagnál null. Az academic mód vagy kulcs soha nem fizethet standard árat.
function resolveProductKey(plan, planMode) {
  const raw = String(plan || '').trim();
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
