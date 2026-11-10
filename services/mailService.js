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
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });
}

function companyLines(env) {
  return {
    name: env.COMPANY_NAME || 'CSB-Villamosság Kft.',
    address: env.COMPANY_ADDRESS || '9153 Öttevény, Arany János utca 10.',
    taxId: env.COMPANY_TAX_ID || '27891788-2-08',
    regNo: env.COMPANY_REG_NO || '08 09 031727'
  };
}

// Közös levélsablon: meleg hangvétel, az OviTervező arculatához igazodó kártya, jogi lábléc.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildEmailContent({ planLabel, withInvoice, test, title, orderNumber }, env) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const c = companyLines(env);
  const support = supportEmail(env);
  const site = 'https://ovitervezo.hu';
  const attachmentText = planLabel === 'heti csomag'
    ? 'a heti csomag ZIP archívuma (benne Word és PDF formátumú tervezetekkel)'
    : 'a tervezet Word (.docx) és PDF formátumban is';
  const invoiceText = withInvoice ? ' Az e-számlát is mellékeltük PDF-ben.' : '';
  const testText = test ? 'Ez egy TESZT levél: fizetés és számla nélkül érkezett.\n\n' : '';
  const legalText = `${c.name} | Székhely: ${c.address} | Adószám: ${c.taxId} | Cégjegyzékszám: ${c.regNo}`;

  const text = `Kedves Kolléganő!\n\n${testText}Köszönjük, hogy az OviTervezőt választotta, és köszönjük az elhivatott munkáját, amellyel nap mint nap a gyerekek mellett áll. Remélhetőleg ez a tervezet sok időt spórol Önnek, hogy többet jusson a legfontosabbra: a gyerekekre.\n\n${cleanTitle ? `Tervezet témája: ${cleanTitle}\n\n` : ''}${orderNumber ? `Rendelésszám: ${orderNumber}\n\n` : ''}Mellékletben küldjük ${attachmentText}.${invoiceText}\n\nTipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.\n\nSikeres, játékos hetet kívánunk!\n\nMelegséggel,\nAz OviTervező csapata\n${site}\n\nKérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk! (${support})\n\n--\nKibocsátó: ${legalText}\nAdatkezelési tájékoztató és ÁSZF: ${site}\nEz a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.`;

  const testBanner = test
    ? '<div style="background:#fff4e0;border:1px solid #f3d29b;color:#8a5a00;border-radius:12px;padding:10px 14px;margin:0 0 16px;font-size:14px;">🧪 Ez egy <strong>teszt</strong> levél: fizetés és számla nélkül érkezett.</div>'
    : '';
  const invoiceItem = withInvoice
    ? '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">🧾 <strong>E-számla</strong> (PDF)</td></tr>'
    : '';
  const fileItems = planLabel === 'heti csomag'
    ? '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">🗂️ <strong>Heti csomag</strong> (ZIP – Word és PDF fájlokkal)</td></tr>'
    : '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">📄 <strong>Tervezet Word</strong> (.docx) formátumban</td></tr><tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">📕 <strong>Tervezet PDF</strong> formátumban</td></tr>';

  const html = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="background:#d8f0e3;padding:26px 28px;text-align:center;">
<div style="font-size:26px;font-weight:700;color:#e0885a;">Ovi<span style="font-weight:400;color:#1f5f52;">Tervező</span></div>
</td></tr>
<tr><td style="padding:28px;">
${testBanner}
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – és köszönjük az elhivatott munkát, amellyel nap mint nap a gyerekek mellett áll.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Reméljük, hogy a kész tervezet sok időt spórol Önnek, így több jut a legfontosabbra: a közös játékra és felfedezésre.</p>
${cleanTitle ? `<p style="margin:0 0 18px;padding:10px 14px;background:#fff8f1;border-left:4px solid #e0885a;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Tervezet témája:</strong> ${escapeHtml(cleanTitle)}</p>` : ''}
${orderNumber ? `<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Rendelésszám: <strong>${escapeHtml(orderNumber)}</strong></p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#1f5f52;margin-bottom:4px;">📎 Mellékletek</div>
<table role="presentation" cellpadding="0" cellspacing="0">${fileItems}${invoiceItem}</table>
</td></tr></table>
<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Tipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.</p>
<p style="margin:20px 0;text-align:center;"><a href="${site}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Melegséggel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<strong>Kibocsátó:</strong> ${c.name}, székhely: ${c.address}, adószám: ${c.taxId}, cégjegyzékszám: ${c.regNo}.<br>
<a href="${site}" style="color:#7a8480;">Adatkezelési tájékoztató</a> · <a href="${site}" style="color:#7a8480;">ÁSZF</a> – ${site}<br>
Ez a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.
</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

function planLabelOf(plan) {
  return String(plan).startsWith('weekly') ? 'heti csomag' : 'napi tervezet';
}

// Egyetlen levél: a megvásárolt tervezet fájljai és az e-számla PDF együtt.
async function sendPurchaseEmail({ to, plan, attachments, invoicePdf, invoiceName, title, orderNumber }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const { text, html } = buildEmailContent({ planLabel: planLabelOf(plan), withInvoice: true, test: false, title, orderNumber }, env);
  const transport = createTransport(env, deps);
  return transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    ...(String(env.ADMIN_NOTIFICATION_EMAIL || '').trim() ? { bcc: String(env.ADMIN_NOTIFICATION_EMAIL).trim() } : {}),
    replyTo: support,
    subject: 'OviTervező – a megvásárolt tervezet és az e-számla',
    text,
    html,
    attachments: [...attachments, { filename: invoiceName || 'szamla.pdf', content: invoicePdf, contentType: 'application/pdf' }]
  });
}

// Staging tesztkézbesítés: ugyanaz a levélsablon, de Stripe-fizetés és számla nélkül.
async function sendTestDeliveryEmail({ to, plan, attachments, title }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const { text, html } = buildEmailContent({ planLabel: planLabelOf(plan), withInvoice: false, test: true, title }, env);
  const transport = createTransport(env, deps);
  console.log(`[test-deliver] SMTP kapcsolódás és küldés: ${env.SMTP_HOST}:${env.SMTP_PORT || 587}`);
  const info = await transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    replyTo: support,
    subject: 'OviTervező – TESZT: tervezet kézbesítés',
    text,
    html,
    attachments
  });
  console.log('[test-deliver] E-mail elküldve:', info?.response || 'ok');
  return info;
}

module.exports = { buildEmailContent, isConfigured, sanitizeAttachments, sendPurchaseEmail, sendTestDeliveryEmail, wasSent, markSent };
