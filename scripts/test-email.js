'use strict';

// SMTP-diagnosztika: node scripts/test-email.js cimzett@email.hu
// A .env SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM értékeit használja.
require('dotenv').config();
const nodemailer = require('nodemailer');

function log(step, message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step.padEnd(10)} ${message}`);
}

async function main() {
  const to = process.argv[2];
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    console.error('Használat: node scripts/test-email.js cimzett@email.hu');
    process.exit(2);
  }
  const env = process.env;
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    console.error(`Hiányzó .env értékek: ${missing.join(', ')}`);
    process.exit(2);
  }

  const port = Number(env.SMTP_PORT || 587);
  const secure = String(env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true';
  const from = env.MAIL_FROM || env.SMTP_USER;
  log('CONFIG', `host=${env.SMTP_HOST} port=${port} secure=${secure} user=${env.SMTP_USER} from=${from}`);

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
    debug: true,
    logger: {
      // A nodemailer a hitelesítési adatokat a naplóban maga elrejti.
      level: () => {}, trace: () => {}, fatal: (_t, m, ...a) => log('FATAL', [m, ...a].join(' ')),
      debug: (_t, m, ...a) => log('SMTP', require('node:util').format(m, ...a)),
      info: (_t, m, ...a) => log('INFO', require('node:util').format(m, ...a)),
      warn: (_t, m, ...a) => log('WARN', require('node:util').format(m, ...a)),
      error: (_t, m, ...a) => log('ERROR', require('node:util').format(m, ...a)),
    },
  });

  try {
    log('VERIFY', 'Kapcsolódás és hitelesítés...');
    await transport.verify();
    log('VERIFY', 'OK – a szerver elfogadta a kapcsolatot és a hitelesítést.');
    log('SEND', `Tesztlevél küldése ide: ${to}`);
    const info = await transport.sendMail({
      from,
      to,
      subject: 'OviTervező – SMTP tesztlevél',
      text: 'Ez egy SMTP tesztlevél az OviTervezőből. Ha ezt olvasod, a levélküldés működik.',
      html: '<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="color:#0f4c5c">OviTervező</h2><p>Ez egy <strong>SMTP tesztlevél</strong>. Ha ezt olvasod, a levélküldés működik.</p><p style="color:#888;font-size:12px">ovitervezo.hu</p></div>',
    });
    log('SEND', `Siker. Szerver válasza: ${info.response}`);
    log('SEND', `Elfogadva: ${JSON.stringify(info.accepted)} Elutasítva: ${JSON.stringify(info.rejected)} MessageID: ${info.messageId}`);
  } catch (error) {
    log('HIBA', `${error.code || 'ERROR'}: ${error.message}`);
    if (error.response) log('HIBA', `Szerver válasza: ${error.response}`);
    if (error.code === 'EAUTH') log('TIPP', 'Hibás felhasználónév/jelszó, vagy a postafiók nem engedi az SMTP-t.');
    if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET'].includes(error.code)) log('TIPP', 'Port/titkosítás eltérés (587 → SMTP_SECURE=false, 465 → true), vagy a hálózat blokkolja a kimenő SMTP-t.');
    process.exitCode = 1;
  } finally {
    transport.close();
  }
}

main();
