#!/usr/bin/env node
'use strict';

// Egyszer futtatható, idempotens import: a régi rendeléseket (CSV) a public.orders táblába tölti status = 'paid' állapottal.
// Használat: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/import-csv-orders.js [fájl.csv]
// A CSV oszlopai (sorrendben): Dátum, Saját azonosító, Számlaszám, Név, E-mail, Cím, Csomag, Téma, Összeg, Fizetési azonosító.
// A név, cím és téma nem kerül az orders táblába (nincs rá oszlop, és nem is szükséges).
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const CSV_FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'regi_rendelesek.csv'));

// A CSV dátumai budapesti helyi idők; a nyári/téli időszámítást az Intl számolja.
function budapestToIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(text).trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Budapest', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(utcGuess));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(utcGuess - (shown - utcGuess)).toISOString();
}

function planOf(label) {
  const weekly = /heti/i.test(label);
  return { plan_mode: 'standard', plan_key: weekly ? 'weekly_detailed' : 'daily' };
}

function toOrder(row) {
  const [date, orderNumber, invoiceNumber, , email, , plan, , amountText] = row.map((cell) => String(cell ?? '').trim());
  const amount = Number(amountText.replace(/[^\d]/g, ''));
  const createdAt = budapestToIso(date);
  if (!orderNumber || !Number.isInteger(amount) || amount <= 0 || !createdAt) return null;
  return {
    order_number: orderNumber,
    user_email: email.toLowerCase() || null,
    ...planOf(plan),
    amount,
    payment_method: 'card',
    status: 'paid',
    invoice_number: invoiceNumber || null,
    created_at: createdAt
  };
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('A SUPABASE_URL és a SUPABASE_SECRET_KEY megadása kötelező.');
  if (!fs.existsSync(CSV_FILE)) throw new Error(`A CSV nem található: ${CSV_FILE}`);

  const rows = parse(fs.readFileSync(CSV_FILE, 'utf8').replace(/^\uFEFF/, ''), { skip_empty_lines: true, relax_column_count: true }).slice(1);
  const orders = [];
  rows.forEach((row, index) => {
    const order = toOrder(row);
    if (order) orders.push(order);
    else console.error(`Érvénytelen sor kihagyva (${index + 2}. sor).`);
  });
  if (orders.length !== rows.length) throw new Error('Hibás CSV-sorok vannak, az import megszakadt.');

  const client = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const numbers = orders.map((o) => o.order_number);
  const { data: existing, error: readError } = await client.from('orders').select('order_number, invoice_number').or(`order_number.in.(${numbers.join(',')}),invoice_number.in.(${orders.map((o) => o.invoice_number).filter(Boolean).join(',')})`);
  if (readError) throw new Error(`Lekérdezési hiba: ${readError.message}`);
  const taken = new Set((existing || []).flatMap((o) => [o.order_number, o.invoice_number]));
  const fresh = orders.filter((o) => !taken.has(o.order_number) && !(o.invoice_number && taken.has(o.invoice_number)));

  if (fresh.length) {
    const { error } = await client.from('orders').insert(fresh);
    if (error) throw new Error(`Beszúrási hiba: ${error.message}`);
  }
  console.log(`CSV sorok: ${rows.length}, új rendelés: ${fresh.length}, már megvolt (kihagyva): ${orders.length - fresh.length}.`);

  const { data: check, error: checkError } = await client.from('orders').select('order_number').in('order_number', numbers);
  if (checkError) throw new Error(`Ellenőrzési hiba: ${checkError.message}`);
  if ((check || []).length !== orders.length) throw new Error(`Ellenőrzés sikertelen: ${check.length}/${orders.length} sor van az adatbázisban.`);
  console.log(`Ellenőrzés rendben: mind a ${orders.length} rendelés megvan a Supabase-ben.`);
}

if (require.main === module) main().catch((error) => { console.error(`Hiba: ${error.message}`); process.exit(1); });

module.exports = { budapestToIso, toOrder };
