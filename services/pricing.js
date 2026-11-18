'use strict';

// Egyetlen árforrás (bruttó Ft; az egyéni vállalkozó AAM számláján nettó = bruttó): a Stripe, a számlázás és a jövőbeli Barion is innen számol.
// Az óvodai (standard) tervezet 390/890 Ft, az oktatási célú (academic) tervezet napi és heti formában is 690 Ft.
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

function productFor(plan, planMode) {
  const key = resolveProductKey(plan, planMode);
  return key ? PRODUCTS[key] : null;
}

module.exports = { PRODUCTS, resolveProductKey, productFor };
