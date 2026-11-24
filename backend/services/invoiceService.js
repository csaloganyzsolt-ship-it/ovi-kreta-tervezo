'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PRODUCTS } = require('./stripeService');

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

// A SZAMLAZZ_SANDBOX csak jelzés (teszt üzem): a bizonylat ilyenkor is rendes e-számla, nem díjbekérő.
function isSandbox(env = process.env) {
  return String(env.SZAMLAZZ_SANDBOX || '').toLowerCase() === 'true';
}

function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Alapértelmezetten nincs előtag: a Számlázz.hu alapértelmezett számlatömbje használatos.
function invoicePrefix(env = process.env) {
  return String(env.SZAMLAZZ_INVOICE_PREFIX ?? getBillingProfile(env).invoicePrefix).trim();
}

// ÁFA-kulcs: a profilé (AAM vagy 27), SZAMLAZZ_VAT_RATE felülírhatja.
function vatRate(env = process.env) {
  return String(env.SZAMLAZZ_VAT_RATE || getBillingProfile(env).vatRate).trim();
}

// Profilfüggő Agent kulcs; a közös SZAMLAZZ_API_KEY (és a régi SZAMLAZZ_KEY) tartalék.
function szamlazzApiKey(env = process.env) {
  const specific = getBillingProfile(env).type === 'kft' ? env.SZAMLAZZ_API_KEY_KFT : env.SZAMLAZZ_API_KEY_EV;
  return String(specific || env.SZAMLAZZ_API_KEY || env.SZAMLAZZ_KEY || '').trim();
}

// Vevőbarát rendelésszám: OVI-ÉÉHHNN-<a Stripe azonosító utolsó 6 karaktere>. A teljes azonosító a Stripe-ban és a naplóban marad.
function orderNumber(orderId, created = new Date()) {
  const when = typeof created === 'number' ? new Date(created * 1000) : created;
  const ymd = when.toISOString().slice(2, 10).replace(/-/g, '');
  return `OVI-${ymd}-${String(orderId || '').slice(-6).toUpperCase()}`;
}

function buildInvoiceXml({ customer, plan, orderId, created, paymentMethod, amountHuf, couponPercent }, env = process.env, date = new Date()) {
  const product = PRODUCTS[plan];
  if (!product) throw new Error(`Ismeretlen csomag a számlázáshoz: ${plan}`);
  // Kuponos fizetésnél a számla a ténylegesen fizetett (kedvezményes) összegről szól.
  const gross = Number.isInteger(amountHuf) && amountHuf > 0 ? amountHuf : product.amountHuf;
  const itemName = couponPercent ? `${product.invoiceName} (kupon: -${couponPercent}%)` : product.invoiceName;
  const vatKey = vatRate(env);
  const { net, vat } = splitGross(gross, vatKey);
  const day = today(date);
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">
  <beallitasok>
    <szamlaagentkulcs>${escapeXml(szamlazzApiKey(env))}</szamlaagentkulcs>
    <eszamla>true</eszamla>
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
    <rendelesSzam>${escapeXml(orderNumber(orderId, created ?? date))}</rendelesSzam>
${invoicePrefix(env) ? `    <szamlaszamElotag>${escapeXml(invoicePrefix(env))}</szamlaszamElotag>\n` : ''}    <dijbekero>false</dijbekero>
    <fizetve>true</fizetve>
  </fejlec>
  <elado>
    <emailReplyto>${escapeXml(supportEmail(env))}</emailReplyto>
    <emailTargy>OviTervező – e-számla</emailTargy>
    <emailSzoveg>A szolgáltatás az ovitervezo.hu oldalon keresztül valósult meg. Köszönjük a vásárlást!</emailSzoveg>
  </elado>
  <vevo>
    <nev>${escapeXml(customer.name || customer.email)}</nev>
    <irsz>${escapeXml(customer.zip)}</irsz>
    <telepules>${escapeXml(customer.city)}</telepules>
    <cim>${escapeXml(customer.address)}</cim>
    <email>${escapeXml(customer.email)}</email>
    <sendEmail>false</sendEmail>
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

function storePath(env = process.env) {
  return env.INVOICE_STORE_PATH || path.join(__dirname, '..', '..', 'data', 'invoiced-sessions.json');
}

function storageDir(env = process.env) {
  return path.dirname(storePath(env));
}

function invoicePdfPath(orderId, env = process.env) {
  const id = String(orderId || '');
  if (!/^[A-Za-z0-9_]{6,200}$/.test(id)) throw new Error('Érvénytelen fizetési azonosító.');
  return path.join(storageDir(env), 'invoices', `${id}.pdf`);
}

// A Számlázz.hu a kért PDF-et a válasz törzsében adja vissza; fizetési sessionhöz társítva fájlban tartjuk.
function getInvoicePdf(orderId, env = process.env) {
  try {
    return fs.readFileSync(invoicePdfPath(orderId, env));
  } catch (_error) {
    return null;
  }
}

function saveInvoicePdf(orderId, pdf, env) {
  const file = invoicePdfPath(orderId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pdf);
}

function readStore(env) {
  try {
    return JSON.parse(fs.readFileSync(storePath(env), 'utf8'));
  } catch (_error) {
    return {};
  }
}

function writeStore(env, data) {
  const file = storePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Ugyanarra a Stripe fizetésre (a webhook újrapróbálkozásai miatt) csak egyszer állítunk ki számlát.
async function issueInvoice(order, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const issued = readStore(env);
  if (issued[order.orderId]) return { duplicate: true, invoiceNumber: issued[order.orderId] };

  if (!szamlazzApiKey(env)) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`A Számlázz.hu Agent kulcs nincs beállítva (SZAMLAZZ_API_KEY_${getBillingProfile(env).type === 'kft' ? 'KFT' : 'EV'} vagy a közös SZAMLAZZ_API_KEY; aktív profil: ${getBillingProfile(env).type}), a számla nem állítható ki.`);
    }
    console.warn(`[Számlázz.hu mock] Számla nem készült (nincs Agent kulcs): ${order.orderId} → ${order.customer.email}`);
    return { mock: true };
  }

  console.log(`[invoice] Számla kiállítása: ${order.orderId} → ${orderNumber(order.orderId, order.created ?? new Date())}`);
  const form = new FormData();
  form.append('action-xmlagentxmlfile', new Blob([buildInvoiceXml(order, env)], { type: 'text/xml' }), 'invoice.xml');
  const response = await fetchImpl(SZAMLAZZ_URL, { method: 'POST', body: form });
  const errorMessage = response.headers.get('szlahu_error');
  if (!response.ok || errorMessage) {
    const code = response.headers.get('szlahu_error_code');
    throw new Error(`Számlázz.hu hiba${code ? ` (${code})` : ''}: ${decodeURIComponent((errorMessage || `HTTP ${response.status}`).replace(/\+/g, ' '))}`);
  }
  const invoiceNumber = response.headers.get('szlahu_szamlaszam') || 'ismeretlen';
  issued[order.orderId] = invoiceNumber;
  writeStore(env, issued);
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.subarray(0, 4).toString() === '%PDF') {
    // A számla már kiállt, ezért a PDF mentési hibája nem dobhat hibát (a webhook újrapróbálása duplikátumot adna).
    try {
      saveInvoicePdf(order.orderId, pdf, env);
    } catch (error) {
      console.error(`A számla PDF mentése sikertelen (${order.orderId}):`, error.message);
    }
  } else {
    console.warn(`A Számlázz.hu válasza nem PDF (${order.orderId}), a számla letöltése nem érhető el.`);
  }
  return { mock: false, sandbox: isSandbox(env), invoiceNumber };
}

module.exports = { orderNumber, invoicePrefix, vatRate, szamlazzApiKey, storageDir, getInvoicePdf, supportEmail, isSandbox, buildInvoiceXml, issueInvoice, escapeXml, splitGross };
