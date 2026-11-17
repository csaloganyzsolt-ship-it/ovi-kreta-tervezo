'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { supportEmail, storageDir } = require('./invoiceService');
const { SUPPORT_EMAIL, getBillingProfile } = require('./siteConstants');
const { stripeSecretKey } = require('./stripeService');

const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const LOGO_CID = 'ovitervezo-logo';
let logoBuffer;
// A logó CID-vel csatolt PNG: Gmailben, Outlookban és Apple Mailben is megbízhatóan megjelenik (az inline SVG nem).
function logoAttachment() {
  if (!logoBuffer) logoBuffer = fs.readFileSync(path.join(__dirname, 'assets', 'mail-logo.png'));
  return { filename: 'ovitervezo-logo.png', content: logoBuffer, contentType: 'image/png', cid: LOGO_CID, contentDisposition: 'inline' };
}

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
  const { name, address, taxId, regLabel, regNo } = getBillingProfile(env);
  return { name, address, taxId, regLabel, regNo };
}

function feedbackSecret(env = process.env) {
  return String(env.FEEDBACK_SECRET || stripeSecretKey(env) || 'ovitervezo-feedback-key').trim();
}

function createFeedbackSignature(email, env = process.env) {
  const normalized = String(email || '').trim().toLowerCase();
  const secret = feedbackSecret(env);
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

function verifyFeedbackSignature(email, sig, env = process.env) {
  if (!email || !sig) return false;
  const expected = createFeedbackSignature(email, env);
  if (typeof sig !== 'string' || sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_e) {
    return false;
  }
}

// Közös levélsablon: meleg hangvétel, az OviTervező arculatához igazodó kártya, jogi lábléc.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildEmailContent({ planLabel, withInvoice, test, title, orderNumber, to, hasZip, planMode }, env) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const c = companyLines(env);
  const support = supportEmail(env);
  const site = 'https://ovitervezo.hu';
  // A ZIP-szöveg a tényleges mellékleteket követi (az oktatási célú tematikus terv egyetlen PDF/DOCX), ennek hiányában a csomag nevét.
  const zip = hasZip ?? planLabel === 'heti csomag';
  const attachmentText = zip
    ? 'a heti csomag ZIP archívuma (benne Word és PDF formátumú tervezetekkel)'
    : 'a tervezet Word (.docx) és PDF formátumban is';
  const invoiceText = withInvoice ? ' Az e-számlát is mellékeltük PDF-ben.' : '';
  const testText = test ? 'Ez egy TESZT levél: fizetés és számla nélkül érkezett.\n\n' : '';
  const legalText = `${c.name} | Székhely: ${c.address} | Adószám: ${c.taxId} | ${c.regLabel}: ${c.regNo}`;

  let feedbackBlock = '';
  let textFeedbackBlock = '';
  if (to && !test) {
    const sig = createFeedbackSignature(to, env);
    const feedbackUrl = (r) => `${site}/ertekeles.html?rating=${r}&email=${encodeURIComponent(to)}&sig=${sig}`;
    const starSvg = '<svg width="26" height="26" viewBox="0 0 24 24" style="display:inline-block;vertical-align:middle;"><path fill="#f59e0b" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    const starsHtml = [5, 4, 3, 2, 1].map((r) =>
      `<a href="${feedbackUrl(r)}" title="${r} csillag" style="display:inline-block;padding:2px 4px;text-decoration:none;">${starSvg}</a>`
    ).join('');

    feedbackBlock = `
<div style="margin:22px 0 0;padding:16px 18px;background:#f9fbf9;border:1px solid #d9ebe0;border-radius:14px;text-align:center;">
<p style="margin:0 0 10px;font-size:13.5px;line-height:1.5;color:#4a5953;font-weight:600;">Hogy sikerült a tervezet? Kattints a csillagokra, és írd meg 1 percben a véleményed:</p>
<div class="star-rating" style="direction:rtl;unicode-bidi:bidi-override;display:inline-block;text-align:center;">
${starsHtml}
</div>
</div>`;

    textFeedbackBlock = `\n\nHogy sikerült a tervezet? Kattints a csillagokra, és írd meg 1 percben a véleményed:\n${feedbackUrl(5)}`;
  }

  const text = `Kedves Kolléganő!\n\n${testText}Köszönjük, hogy az OviTervezőt választotta, és köszönjük az elhivatott munkáját, amellyel nap mint nap a gyerekek mellett áll. Remélhetőleg ez a tervezet sok időt spórol Önnek, hogy többet jusson a legfontosabbra: a gyerekekre.\n\n${cleanTitle ? `Tervezet témája: ${cleanTitle}\n\n` : ''}${orderNumber ? `Rendelésszám: ${orderNumber}\n\n` : ''}${planMode === 'academic' ? 'Tervezet típusa: Oktatási célú tervezet\n\n' : ''}Mellékletben küldjük ${attachmentText}.${invoiceText}\n\nTipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.\n\nSikeres, játékos hetet kívánunk!\n\nMelegséggel,\nAz OviTervező csapata\n${site}\n\nKérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk! (${support})${textFeedbackBlock}\n\n--\nKibocsátó: ${legalText}\nAdatkezelési tájékoztató és ÁSZF: ${site}\nEz a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.`;

  const testBanner = test
    ? '<div style="background:#fff4e0;border:1px solid #f3d29b;color:#8a5a00;border-radius:12px;padding:10px 14px;margin:0 0 16px;font-size:14px;">🧪 Ez egy <strong>teszt</strong> levél: fizetés és számla nélkül érkezett.</div>'
    : '';
  const invoiceItem = withInvoice
    ? '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">🧾 <strong>E-számla</strong> (PDF)</td></tr>'
    : '';
  const fileItems = zip
    ? '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">🗂️ <strong>Heti csomag</strong> (ZIP – Word és PDF fájlokkal)</td></tr>'
    : '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">📄 <strong>Tervezet Word</strong> (.docx) formátumban</td></tr><tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">📕 <strong>Tervezet PDF</strong> formátumban</td></tr>';

  const html = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title>
<style>
.star-rating { direction: rtl; unicode-bidi: bidi-override; display: inline-block; }
.star-rating > a { display: inline-block; padding: 2px 4px; text-decoration: none; }
.star-rating > a svg { display: inline-block; vertical-align: middle; fill: #f59e0b; }
.star-rating:hover > a svg { fill: #d1d5db; }
.star-rating > a:hover svg,
.star-rating > a:hover ~ a svg { fill: #f59e0b !important; }
</style>
</head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><img src="cid:${LOGO_CID}" width="52" height="52" alt="OT" style="display:block;border:0;border-radius:12px;"></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
${testBanner}
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – és köszönjük az elhivatott munkát, amellyel nap mint nap a gyerekek mellett áll.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Reméljük, hogy a kész tervezet sok időt spórol Önnek, így több jut a legfontosabbra: a közös játékra és felfedezésre.</p>
${cleanTitle ? `<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Tervezet témája:</strong> ${escapeHtml(cleanTitle)}</p>` : ''}
${planMode === 'academic' ? '<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Tervezet típusa: <strong>Oktatási célú tervezet</strong></p>' : ''}
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
${feedbackBlock}
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<strong>Kibocsátó:</strong> ${c.name}, székhely: ${c.address}, adószám: ${c.taxId}, ${c.regLabel}: ${c.regNo}.<br>
<a href="${site}" style="color:#7a8480;">Adatkezelési tájékoztató</a> · <a href="${site}" style="color:#7a8480;">ÁSZF</a> – ${site}<br>
Ez a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.
</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

function hasZipAttachment(attachments) {
  return Array.isArray(attachments) && attachments.some((file) => /\.zip$/i.test(String(file?.filename || '')));
}

function planLabelOf(plan) {
  return String(plan).startsWith('weekly') ? 'heti csomag' : 'napi tervezet';
}

// A rendszergazdai másolat kötelező: alapértelmezetten a közös ügyfélszolgálati cím, az ADMIN_NOTIFICATION_EMAIL felülírhatja.
function adminEmail(env = process.env) {
  return String(env.ADMIN_NOTIFICATION_EMAIL || '').trim() || SUPPORT_EMAIL;
}

// Külön értesítő a webhookból: a számla a rendszergazdához akkor is eljut, ha a vevő böngészője nem indítja a kézbesítést.
async function sendAdminNotification({ customer, plan, orderNumber, invoiceNumber, invoicePdf, title }, deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) return { sent: false, reason: 'smtp_not_configured' };
  const support = supportEmail(env);
  const lines = [`Új sikeres fizetés.`, `Rendelésszám: ${orderNumber || '-'}`, `Számlaszám: ${invoiceNumber || '-'}`, `Csomag: ${planLabelOf(plan)}`, `Vevő: ${customer?.name || '-'} <${customer?.email || '-'}>`, `Téma: ${title || '-'}`];
  const transport = createTransport(env, deps);
  await transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to: adminEmail(env),
    subject: `OviTervező – új fizetés: ${orderNumber || ''}`.trim(),
    text: lines.join('\n'),
    attachments: Buffer.isBuffer(invoicePdf) && invoicePdf.length ? [{ filename: `${orderNumber || 'szamla'}.pdf`, content: invoicePdf, contentType: 'application/pdf' }] : []
  });
  return { sent: true };
}

// Egyetlen levél: a megvásárolt tervezet fájljai és az e-számla PDF együtt.
async function sendPurchaseEmail({ to, plan, attachments, invoicePdf, invoiceName, title, orderNumber, planMode }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const { text, html } = buildEmailContent({ planLabel: planLabelOf(plan), withInvoice: true, test: false, title, orderNumber, to, hasZip: hasZipAttachment(attachments), planMode }, env);
  const transport = createTransport(env, deps);
  return transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    replyTo: support,
    subject: 'OviTervező – a megvásárolt tervezet és az e-számla',
    text,
    html,
    attachments: [...attachments, { filename: invoiceName || 'szamla.pdf', content: invoicePdf, contentType: 'application/pdf' }, logoAttachment()]
  });
}

// Vásárlói visszajelzés és értékelés értesítő a rendszergazdának
async function sendFeedbackNotification(firstArg, secondArg, deps = {}) {
  let env, data, actualDeps;
  if (firstArg && (firstArg.SMTP_HOST || firstArg.ADMIN_NOTIFICATION_EMAIL || firstArg.NODE_ENV !== undefined)) {
    env = firstArg;
    data = secondArg || {};
    actualDeps = deps;
  } else {
    data = firstArg || {};
    actualDeps = secondArg || {};
    env = actualDeps.env || process.env;
  }
  if (!isConfigured(env)) return { sent: false, reason: 'smtp_not_configured' };
  const support = supportEmail(env);
  const transport = createTransport(env, actualDeps);

  const subject = `OviTervező értékelés: ${data.rating}/5 csillag – ${data.email}`;
  const text = [
    `Új vásárlói értékelés érkezett az OviTervező felületén.`,
    ``,
    `Értékelés: ${data.rating} / 5 csillag`,
    `Vásárló: ${data.email}`,
    `Név / beosztás: ${data.name || 'Nem adott meg nevet'}`,
    ``,
    `Vélemény, tapasztalat:`,
    data.comment || 'Nem fűzött hozzá szöveges megjegyzést.'
  ].join('\n');

  const html = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><title>OviTervező értékelés</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px;">
<h2 style="margin:0 0 16px;color:#1f5f52;font-size:20px;">Új vásárlói értékelés érkezett</h2>
<table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:18px;">
  <tr><td style="padding:6px 0;color:#5b6b64;font-size:14px;width:140px;">Értékelés:</td><td style="padding:6px 0;font-size:16px;font-weight:700;color:#1f3d34;">${data.rating} / 5 csillag</td></tr>
  <tr><td style="padding:6px 0;color:#5b6b64;font-size:14px;">Vásárló:</td><td style="padding:6px 0;font-size:15px;color:#1f3d34;"><a href="mailto:${escapeHtml(data.email)}" style="color:#2f946f;text-decoration:none;">${escapeHtml(data.email)}</a></td></tr>
  <tr><td style="padding:6px 0;color:#5b6b64;font-size:14px;">Név / beosztás:</td><td style="padding:6px 0;font-size:15px;color:#1f3d34;">${escapeHtml(data.name || 'Nem adott meg nevet')}</td></tr>
</table>
<div style="background:#f4fbf7;border:1px solid #cfe8da;border-left:4px solid #3fae84;border-radius:8px;padding:14px 16px;">
  <div style="font-size:13px;font-weight:700;text-transform:uppercase;color:#1f5f52;margin-bottom:6px;">Vélemény, tapasztalat:</div>
  <div style="font-size:15px;line-height:1.6;color:#2d3b36;white-space:pre-wrap;">${escapeHtml(data.comment || 'Nem fűzött hozzá szöveges megjegyzést.')}</div>
</div>
<p style="margin:18px 0 0;font-size:13px;color:#7a8480;">Erre a levélre közvetlenül válaszolva a vásárlónak (${escapeHtml(data.email)}) küldhetsz választ.</p>
</td></tr>
</table></td></tr></table></body></html>`;

  await transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to: adminEmail(env),
    replyTo: data.email,
    subject,
    text,
    html
  });
  return { sent: true };
}

// Staging tesztkézbesítés: ugyanaz a levélsablon, de Stripe-fizetés és számla nélkül.
async function sendTestDeliveryEmail({ to, plan, attachments, title, planMode }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const { text, html } = buildEmailContent({ planLabel: planLabelOf(plan), withInvoice: false, test: true, title, hasZip: hasZipAttachment(attachments), planMode }, env);
  const transport = createTransport(env, deps);
  console.log(`[test-deliver] SMTP kapcsolódás és küldés: ${env.SMTP_HOST}:${env.SMTP_PORT || 587}`);
  const info = await transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    replyTo: support,
    subject: 'OviTervező – TESZT: tervezet kézbesítés',
    text,
    html,
    attachments: [...attachments, logoAttachment()]
  });
  console.log('[test-deliver] E-mail elküldve:', info?.response || 'ok');
  return info;
}

module.exports = {
  adminEmail,
  sendAdminNotification,
  buildEmailContent,
  isConfigured,
  sanitizeAttachments,
  sendPurchaseEmail,
  sendTestDeliveryEmail,
  wasSent,
  markSent,
  feedbackSecret,
  createFeedbackSignature,
  verifyFeedbackSignature,
  sendFeedbackNotification
};
