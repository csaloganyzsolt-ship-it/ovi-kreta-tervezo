#!/usr/bin/env node

/**
 * Import régi rendeléseket a regi_rendelesek.csv-ből a Supabase orders táblába.
 * Idempotens: duplikációk ellenőrzésével (számlaszám vagy saját azonosító alapján).
 * Futtatás: node scripts/import-csv-orders.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

const CSV_FILE = path.join(__dirname, '..', 'regi_rendelesek.csv');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('❌ Hiba: SUPABASE_URL és SUPABASE_SECRET_KEY szükséges a .env fájlban.');
  process.exit(1);
}

if (!fs.existsSync(CSV_FILE)) {
  console.error(`❌ Hiba: ${CSV_FILE} fájl nem található.`);
  process.exit(1);
}

async function importOrders() {
  try {
    // CSV olvasása
    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const records = csv.parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });

    console.log(`📄 CSV olvasva: ${records.length} sor.`);

    if (records.length === 0) {
      console.log('✅ Nincs importálandó adat.');
      return;
    }

    // Supabase kliens
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false }
    });

    // Meglévő rendelések lekérdezése (számlaszám és saját azonosító alapján)
    const { data: existingOrders, error: fetchError } = await supabase
      .from('orders')
      .select('invoice_number, order_number');

    if (fetchError) throw new Error(`Supabase lekérdezés hiba: ${fetchError.message}`);

    const existingInvoices = new Set(existingOrders.map((o) => o.invoice_number).filter(Boolean));
    const existingOrderNumbers = new Set(existingOrders.map((o) => o.order_number).filter(Boolean));

    console.log(`📊 Meglévő rendelések: ${existingOrders.length} (számlaszám: ${existingInvoices.size}, rendelésszám: ${existingOrderNumbers.size}).`);

    // CSV sorok feldolgozása
    const toInsert = [];
    const skipped = [];

    records.forEach((row, index) => {
      const lineNum = index + 2; // Header után kezd
      
      // Oszlopneveket normalizáljuk és trimmelünk
      const datum = (row['Dátum'] || '').trim();
      const sajaAzonositó = (row['Saját azonosító'] || '').trim();
      const szamlaszam = (row['Számlaszám'] || '').trim();
      const nev = (row['Név'] || '').trim();
      const email = (row['E-mail'] || '').trim();
      const cim = (row['Cím'] || '').trim();
      const csomag = (row['Csomag (Napi / Heti)'] || '').trim();
      const osszegText = (row['Összeg'] || '').trim();
      const szamlaszamSzamlazz = (row['Számlaszám (Számlázz.hu)'] || '').trim();

      // Validáció
      if (!sajaAzonositó || !email || !osszegText) {
        skipped.push({ line: lineNum, reason: 'Hiányzó kötelező mező (Saját azonosító, E-mail vagy Összeg)' });
        return;
      }

      // Duplikáció ellenőrzés
      if (existingInvoices.has(szamlaszamSzamlazz) || existingOrderNumbers.has(sajaAzonositó)) {
        skipped.push({ line: lineNum, reason: `Duplikáció: ${sajaAzonositó}` });
        return;
      }

      // Összeg feldolgozása
      const amount = parseInt(osszegText, 10);
      if (isNaN(amount) || amount <= 0) {
        skipped.push({ line: lineNum, reason: `Érvénytelen összeg: ${osszegText}` });
        return;
      }

      // Dátum feldolgozása (YYYY-MM-DD formátumra)
      let createdAt = new Date().toISOString();
      if (datum) {
        const parsed = new Date(datum);
        if (!isNaN(parsed.getTime())) {
          createdAt = parsed.toISOString();
        }
      }

      // Plan mode feldolgozása
      const planMode = csomag.toLowerCase().includes('heti') ? 'weekly' : 'daily';

      toInsert.push({
        order_number: sajaAzonositó,
        user_email: email,
        plan_mode: planMode,
        amount: amount,
        payment_method: 'imported',
        status: 'paid',
        invoice_number: szamlaszamSzamlazz || null,
        created_at: createdAt
      });
    });

    console.log(`\n✅ Feldolgozva: ${toInsert.length} új rendelés.`);
    if (skipped.length > 0) {
      console.log(`⚠️  Kihagyva: ${skipped.length} sor.`);
      skipped.slice(0, 10).forEach((s) => {
        console.log(`   • Sor ${s.line}: ${s.reason}`);
      });
      if (skipped.length > 10) {
        console.log(`   ... és még ${skipped.length - 10} sor.`);
      }
    }

    // Beszúrás
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('orders')
        .insert(toInsert);

      if (insertError) {
        throw new Error(`Supabase beszúrás hiba: ${insertError.message}`);
      }

      console.log(`\n🎉 Sikeresen importálva ${toInsert.length} rendelés!`);
    } else {
      console.log('\n📭 Nincs importálandó rendelés (mind duplikáció vagy hibás).');
    }

  } catch (error) {
    console.error('❌ Hiba az importálás során:', error.message);
    process.exit(1);
  }
}

// Futtatás
importOrders();
