'use strict';

const { PRODUCTS } = require('./stripeService');
const { normalizeHuTaxNumber } = require('../utils/taxNumber');

const { SUPPORT_EMAIL: DEFAULT_SUPPORT_EMAIL, getBillingProfile } = require('./siteConstants');

function supportEmail(env = process.env) {
  return String(env.SUPPORT_EMAIL || '').trim() || DEFAULT_SUPPORT_EMAIL;
}

function invoiceNote(env) {
  return `Szolgáltató weboldal: https://ovitervezo.hu | Ügyfélszolgálat: ${supportEmail(env)} | Köszönjük a vásárlást!`;
}

const SZAMLAZZ_URL = 'https://www.szamlazz.hu/szamla/';

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&'"]/g, (char) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]
  ));
}

// A bruttó ár a vevő által fizetett összeg; a nettó és az ÁFA ebből számolódik. AAM/TAM esetén nincs ÁFA.
function splitGross(grossHuf, vatRate) {
  const numeric = Number(vatRate);
  if (!Number.isFinite(numeric)) return { net: grossHuf, vat: 0 };
  const net = Math.round(grossHuf / (1 + numeric / 100));
  return { net, vat: grossHuf - net };
}

// A SZAMLAZZ_SANDBOX csak jelzés (teszt üzem): a bizonylat ilyenkor is rendes számla, nem díjbekérő.
function isSandbox(env = process.env) {
  return String(env.SZAMLAZZ_SANDBOX || '').toLowerCase() === 'true';
}

function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Alapértelmezetten nincs előtag: a Számlázz.hu alapértelmezett számlatömbje használatos.
// A profileType (a rendelésen rögzített profil) megadása nélkül az aktív profil (Admin Központ, tartalék: BILLING_PROFILE) érvényes.
function invoicePrefix(env = process.env, profileType) {
  return String(env.SZAMLAZZ_INVOICE_PREFIX ?? getBillingProfile(env, profileType).invoicePrefix).trim();
}

// ÁFA-kulcs: a profilé (AAM vagy 27), SZAMLAZZ_VAT_RATE felülírhatja.
function vatRate(env = process.env, profileType) {
  return String(env.SZAMLAZZ_VAT_RATE || getBillingProfile(env, profileType).vatRate).trim();
}

// Profilfüggő Agent kulcs; a közös SZAMLAZZ_API_KEY (és a régi SZAMLAZZ_KEY) tartalék.
function szamlazzApiKey(env = process.env, profileType) {
  const specific = getBillingProfile(env, profileType).type === 'kft' ? env.SZAMLAZZ_API_KEY_KFT : env.SZAMLAZZ_API_KEY_EV;
  return String(specific || env.SZAMLAZZ_API_KEY || env.SZAMLAZZ_KEY || '').trim();
}

// Vevőbarát rendelésszám: OVI-ÉÉHHNN-<a Stripe azonosító utolsó 6 karaktere>. A teljes azonosító a Stripe-ban és a naplóban marad.
function orderNumber(orderId, created = new Date()) {
  const when = typeof created === 'number' ? new Date(created * 1000) : created;
  const ymd = when.toISOString().slice(2, 10).replace(/-/g, '');
  return `OVI-${ymd}-${String(orderId || '').slice(-6).toUpperCase()}`;
}

function buildInvoiceXml({ customer, plan, orderId, created, paymentMethod, amountHuf, couponPercent, billingProfile }, env = process.env, date = new Date()) {
  const product = PRODUCTS[plan];
  if (!product) throw new Error(`Ismeretlen csomag a számlázáshoz: ${plan}`);
  // Kuponos fizetésnél a számla a ténylegesen fizetett (kedvezményes) összegről szól.
  const gross = Number.isInteger(amountHuf) && amountHuf > 0 ? amountHuf : product.amountHuf;
  const itemName = couponPercent ? `${product.invoiceName} (kupon: -${couponPercent}%)` : product.invoiceName;
  const vatKey = vatRate(env, billingProfile);
  const { net, vat } = splitGross(gross, vatKey);
  const day = today(date);
  const taxNumber = normalizeHuTaxNumber(customer.taxNumber) || '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">
  <beallitasok>
    <szamlaagentkulcs>${escapeXml(szamlazzApiKey(env, billingProfile))}</szamlaagentkulcs>
    <eszamla>${String(env.SZAMLAZZ_E_INVOICE || '').trim().toLowerCase() === 'true'}</eszamla>
    <szamlaLetoltes>true</szamlaLetoltes>
    <valaszVerzio>1</valaszVerzio>
  </beallitasok>
  <fejlec>
    <keltDatum>${day}</keltDatum>
    <teljesitesDatum>${day}</teljesitesDatum>
    <fizetesiHataridoDatum>${day}</fizetesiHataridoDatum>
    <fizmod>${escapeXml(paymentMethod || 'Bankkártya')}</fizmod>
    <penznem>HUF</penznem>
    <szamlaNyelve>hu</szamlaNyelve>
    <megjegyzes>${escapeXml(invoiceNote(env))}</megjegyzes>
    <dijbekero>false</dijbekero>
    <fizetve>true</fizetve>
  </fejlec>
  <elado>
    <emailReplyto>${escapeXml(supportEmail(env))}</emailReplyto>
    <emailTargy>OviTervező – számla</emailTargy>
    <emailSzoveg>A szolgáltatás az ovitervezo.hu oldalon keresztül valósult meg. Köszönjük a vásárlást!</emailSzoveg>
  </elado>
  <vevo>
    <nev>${escapeXml(customer.name || customer.email)}</nev>
    <irsz>${escapeXml(customer.zip)}</irsz>
    <telepules>${escapeXml(customer.city)}</telepules>
    <cim>${escapeXml(customer.address)}</cim>
    <email>${escapeXml(customer.email)}</email>
    <sendEmail>false</sendEmail>${taxNumber ? `
    <adoalany>1</adoalany>
    <adoszam>${escapeXml(taxNumber)}</adoszam>` : ''}
  </vevo>
  <tetelek>
    <tetel>
      <megnevezes>${escapeXml(itemName)}</megnevezes>
      <mennyiseg>1</mennyiseg>
      <mennyisegiEgyseg>db</mennyisegiEgyseg>
      <nettoEgysegar>${net}</nettoEgysegar>
      <afakulcs>${escapeXml(vatKey)}</afakulcs>
      <nettoErtek>${net}</nettoErtek>
      <afaErtek>${vat}</afaErtek>
      <bruttoErtek>${gross}</bruttoErtek>
    </tetel>
  </tetelek>
</xmlszamla>`;
}

const PDF_MAGIC = '%PDF';

function szamlazzError(response) {
  const message = response.headers.get('szlahu_error');
  if (response.ok && !message) return null;
  const code = response.headers.get('szlahu_error_code');
  return new Error(`Számlázz.hu hiba${code ? ` (${code})` : ''}: ${decodeURIComponent((message || `HTTP ${response.status}`).replace(/\+/g, ' '))}`);
}

// A már kiállított számla PDF-je élőben, a Számlázz.hu Agent API-ból (action-szamla_agent_pdf); fájlba nem kerül, a hívó csak memóriában kapja meg.
// A kulcs a rendelésen rögzített számlázási profilhoz tartozik, így profilváltás után is a kiállító cég kulcsával kérdezünk.
async function fetchInvoicePdf({ invoiceNumber, billingProfile }, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const number = String(invoiceNumber || '').trim();
  if (!number) throw new Error('A rendeléshez nem tartozik számlaszám.');
  const key = szamlazzApiKey(env, billingProfile);
  if (!key) throw new Error(`A Számlázz.hu Agent kulcs nincs beállítva (SZAMLAZZ_API_KEY_${getBillingProfile(env, billingProfile).type === 'kft' ? 'KFT' : 'EV'} vagy a közös SZAMLAZZ_API_KEY), a számla nem kérhető le.`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamlapdf xmlns="http://www.szamlazz.hu/xmlszamlapdf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamlapdf https://www.szamlazz.hu/szamla/docs/xsds/agentpdf/xmlszamlapdf.xsd">
  <szamlaagentkulcs>${escapeXml(key)}</szamlaagentkulcs>
  <szamlaszam>${escapeXml(number)}</szamlaszam>
  <valaszVerzio>1</valaszVerzio>
</xmlszamlapdf>`;
  const form = new FormData();
  form.append('action-szamla_agent_pdf', new Blob([xml], { type: 'text/xml' }), 'invoice-pdf.xml');
  const response = await fetchImpl(SZAMLAZZ_URL, { method: 'POST', body: form });
  const failure = szamlazzError(response);
  if (failure) throw failure;
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.subarray(0, 4).toString() !== PDF_MAGIC) throw new Error('A Számlázz.hu válasza nem PDF, a számla nem érhető el.');
  return pdf;
}

// A számlát a hívó csak egyszer kéri (az idempotenciát az `orders` tábla invoice_number mezője adja). Az order.billingProfile a rendelésen rögzített profil.
// Visszatérés: { mock, invoiceNumber, pdf } – a PDF puffer csak memóriában utazik a levélküldőhöz / Sheets-hez, soha nem kerül lemezre.
async function issueInvoice(order, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const profileType = order.billingProfile;

  if (!szamlazzApiKey(env, profileType)) {
    if (env.NODE_ENV === 'production') {
      const type = getBillingProfile(env, profileType).type;
      throw new Error(`A Számlázz.hu Agent kulcs nincs beállítva (SZAMLAZZ_API_KEY_${type === 'kft' ? 'KFT' : 'EV'} vagy a közös SZAMLAZZ_API_KEY; aktív profil: ${type}), a számla nem állítható ki.`);
    }
    console.warn(`[Számlázz.hu mock] Számla nem készült (nincs Agent kulcs): ${order.orderId} → ${order.customer.email}`);
    return { mock: true };
  }

  console.log(`[invoice] Számla kiállítása: ${order.orderId} → ${orderNumber(order.orderId, order.created ?? new Date())}`);
  const form = new FormData();
  form.append('action-xmlagentxmlfile', new Blob([buildInvoiceXml(order, env)], { type: 'text/xml' }), 'invoice.xml');
  const response = await fetchImpl(SZAMLAZZ_URL, { method: 'POST', body: form });
  const failure = szamlazzError(response);
  if (failure) throw failure;
  const invoiceNumber = response.headers.get('szlahu_szamlaszam') || 'ismeretlen';
  const body = Buffer.from(await response.arrayBuffer());
  const hasPdf = body.subarray(0, 4).toString() === PDF_MAGIC;
  if (!hasPdf) console.warn(`A Számlázz.hu válasza nem PDF (${order.orderId}); a számla a letöltéskor élőben kérhető le.`);
  return { mock: false, sandbox: isSandbox(env), invoiceNumber, pdf: hasPdf ? body : null };
}

module.exports = { orderNumber, invoicePrefix, vatRate, szamlazzApiKey, supportEmail, isSandbox, buildInvoiceXml, issueInvoice, fetchInvoicePdf, escapeXml, splitGross };
