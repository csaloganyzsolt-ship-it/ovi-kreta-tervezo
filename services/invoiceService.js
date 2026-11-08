'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PRODUCTS } = require('./stripeService');

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

// Teszt üzemmódban nem éles bizonylat, hanem díjbekérő készül.
function isSandbox(env = process.env) {
  return String(env.SZAMLAZZ_SANDBOX || '').toLowerCase() === 'true';
}

function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function buildInvoiceXml({ customer, plan, orderId }, env = process.env, date = new Date()) {
  const product = PRODUCTS[plan];
  if (!product) throw new Error(`Ismeretlen csomag a számlázáshoz: ${plan}`);
  const vatKey = String(env.SZAMLAZZ_AFA || '27').trim();
  const { net, vat } = splitGross(product.amountHuf, vatKey);
  const day = today(date);
  const sandbox = isSandbox(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">
  <beallitasok>
    <szamlaagentkulcs>${escapeXml(env.SZAMLAZZ_KEY)}</szamlaagentkulcs>
    <eszamla>true</eszamla>
    <szamlaLetoltes>false</szamlaLetoltes>
    <valaszVerzio>1</valaszVerzio>
  </beallitasok>
  <fejlec>
    <keltDatum>${day}</keltDatum>
    <teljesitesDatum>${day}</teljesitesDatum>
    <fizetesiHataridoDatum>${day}</fizetesiHataridoDatum>
    <fizmod>Bankkártya</fizmod>
    <penznem>HUF</penznem>
    <szamlaNyelve>hu</szamlaNyelve>
    <megjegyzes>Stripe online bankkártyás fizetés</megjegyzes>
    <rendelesSzam>${escapeXml(orderId)}</rendelesSzam>
    <dijbekero>${sandbox}</dijbekero>
    <fizetve>${!sandbox}</fizetve>
  </fejlec>
  <elado></elado>
  <vevo>
    <nev>${escapeXml(customer.name || customer.email)}</nev>
    <irsz>${escapeXml(customer.zip)}</irsz>
    <telepules>${escapeXml(customer.city)}</telepules>
    <cim>${escapeXml(customer.address)}</cim>
    <email>${escapeXml(customer.email)}</email>
    <sendEmail>true</sendEmail>
  </vevo>
  <tetelek>
    <tetel>
      <megnevezes>${escapeXml(product.name)}</megnevezes>
      <mennyiseg>1</mennyiseg>
      <mennyisegiEgyseg>db</mennyisegiEgyseg>
      <nettoEgysegar>${net}</nettoEgysegar>
      <afakulcs>${escapeXml(vatKey)}</afakulcs>
      <nettoErtek>${net}</nettoErtek>
      <afaErtek>${vat}</afaErtek>
      <bruttoErtek>${product.amountHuf}</bruttoErtek>
    </tetel>
  </tetelek>
</xmlszamla>`;
}

function storePath(env = process.env) {
  return env.INVOICE_STORE_PATH || path.join(__dirname, '..', 'data', 'invoiced-sessions.json');
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

  if (!String(env.SZAMLAZZ_KEY || '').trim()) {
    if (env.NODE_ENV === 'production') {
      throw new Error('A SZAMLAZZ_KEY nincs beállítva, a számla nem állítható ki.');
    }
    console.warn(`[Számlázz.hu mock] Számla nem készült (nincs SZAMLAZZ_KEY): ${order.orderId} → ${order.customer.email}`);
    return { mock: true };
  }

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
  return { mock: false, sandbox: isSandbox(env), invoiceNumber };
}

module.exports = { isSandbox, buildInvoiceXml, issueInvoice, escapeXml, splitGross };
