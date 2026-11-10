'use strict';

const { PRODUCTS } = require('./stripeService');
const { orderNumber } = require('./invoiceService');

const TIMEOUT_MS = 8000;

function isConfigured(env = process.env) {
  return /^https:\/\//.test(String(env.GOOGLE_SHEETS_WEBHOOK_URL || '').trim());
}

function budapestStamp(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function buildPayload({ session, invoiceNumber, customer }, now = new Date()) {
  const plan = session.metadata?.plan;
  const product = PRODUCTS[plan];
  const created = session.created ? new Date(session.created * 1000) : now;
  const address = [customer.zip, customer.city, customer.address].filter(Boolean).join(', ');
  return {
    datum: budapestStamp(now),
    rendelesszam: orderNumber(session.id, created),
    szamlaszam: invoiceNumber || '',
    vevo_neve: customer.name || '',
    vevo_email: customer.email || '',
    szamlazasi_cim: address,
    csomag: String(plan || '').startsWith('weekly') ? 'Heti csomag' : 'Napi tervezet',
    tervezet_temaja: session.metadata?.title || '',
    fizetett_osszeg_huf: product ? product.amountHuf : null,
    stripe_session_id: session.id
  };
}

// Hibatűrő: soha nem dob kivételt, a hívó nem várja meg (fire-and-forget), így a vevő kiszolgálását nem akasztja meg.
async function recordPurchase(data, deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) return { sent: false, reason: 'not_configured' };
  const fetchImpl = deps.fetch || fetch;
  try {
    const payload = buildPayload(data, deps.now);
    const response = await fetchImpl(String(env.GOOGLE_SHEETS_WEBHOOK_URL).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`[sheets] Vásárlás rögzítve: ${payload.rendelesszam}`);
    return { sent: true };
  } catch (error) {
    console.error('[sheets] A Google Táblázat webhook hívása sikertelen:', error.message);
    return { sent: false, reason: 'error', error: error.message };
  }
}

module.exports = { isConfigured, buildPayload, recordPurchase };
