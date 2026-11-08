'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { supportEmail, storageDir } = require('./invoiceService');

const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.zip']);

function isConfigured(env = process.env) {
  return Boolean(String(env.SMTP_HOST || '').trim());
}

function safeSessionId(sessionId) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_]{6,200}$/.test(id)) throw new Error('Érvénytelen fizetési azonosító.');
  return id;
}

function sentMarker(sessionId, env) {
  return path.join(storageDir(env), 'invoices', `${safeSessionId(sessionId)}.sent`);
}

function wasSent(sessionId, env = process.env) {
  return fs.existsSync(sentMarker(sessionId, env));
}

function markSent(sessionId, env = process.env) {
  const file = sentMarker(sessionId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, new Date().toISOString());
}

// A kliensből érkező mellékleteket szigorúan szűrjük: csak pdf/docx/zip, tiszta fájlnévvel és méretkorláttal.
function sanitizeAttachments(files) {
  if (!Array.isArray(files) || !files.length || files.length > 20) {
    throw Object.assign(new Error('A mellékletek listája hiányzik vagy túl hosszú.'), { status: 400 });
  }
  let total = 0;
  return files.map((file) => {
    const filename = path.basename(String(file?.name || '')).replace(/[^\w.\-]+/g, '_');
    if (!ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
      throw Object.assign(new Error(`Nem engedélyezett melléklettípus: ${filename}`), { status: 400 });
    }
    const content = Buffer.from(String(file?.base64 || ''), 'base64');
    total += content.length;
    if (!content.length || total > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('A mellékletek üresek vagy túl nagyok.'), { status: 400 });
    }
    return { filename, content };
  });
}

function createTransport(env, deps) {
  if (deps.transport) return deps.transport;
  const nodemailer = require('nodemailer');
  const port = Number(env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: String(env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });
}

// Egyetlen levél: a megvásárolt tervezet fájljai és az e-számla PDF együtt.
async function sendPurchaseEmail({ to, plan, attachments, invoicePdf, invoiceName }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const planLabel = String(plan).startsWith('weekly') ? 'heti csomag' : 'napi tervezet';
  const transport = createTransport(env, deps);
  return transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    replyTo: support,
    subject: 'OviTervező – a megvásárolt tervezet és az e-számla',
    text: `Kedves Vásárlónk!\n\nKöszönjük a vásárlást! Mellékletben küldjük a megvásárolt ${planLabel} fájljait és az e-számlát.\n\nSzolgáltató weboldal: https://ovitervezo.hu\nÜgyfélszolgálat: ${support}\n\nÜdvözlettel,\nOviTervező`,
    attachments: [...attachments, { filename: invoiceName || 'szamla.pdf', content: invoicePdf, contentType: 'application/pdf' }]
  });
}

module.exports = { isConfigured, sanitizeAttachments, sendPurchaseEmail, wasSent, markSent };
