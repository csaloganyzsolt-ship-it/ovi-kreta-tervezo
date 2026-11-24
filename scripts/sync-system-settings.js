'use strict';

// Már létrehozott system_settings / email_templates táblák esetén újra felülírja a sorokat a migráció valós seedjével (ON CONFLICT ... DO UPDATE).
// Használat: DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/sync-system-settings.js
// Előfeltétel: a psql parancs elérhető. Szimulációhoz: --print (csak kiírja az SQL-t).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20261126090000_system_settings.sql');
const MARKER = '-- SEED-KEZDET';
const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function seedSql(file = MIGRATION) {
  const sql = fs.readFileSync(file, 'utf8');
  const start = sql.indexOf(MARKER);
  if (start < 0) throw new Error('A migrációban nem található a seed kezdete (-- SEED-KEZDET).');
  return sql.slice(start);
}

function main(argv = process.argv.slice(2), env = process.env) {
  const sql = seedSql();
  if (argv.includes('--print')) {
    process.stdout.write(sql);
    return 0;
  }
  const result = spawnSync('psql', [env.DATABASE_URL || DEFAULT_URL, '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) {
    console.error(`A psql nem futtatható: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (require.main === module) process.exit(main());

module.exports = { seedSql, MARKER };
