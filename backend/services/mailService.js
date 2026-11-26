'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { supportEmail } = require('./invoiceService');
const { SUPPORT_EMAIL, getBillingProfile } = require('./siteConstants');
const { stripeSecretKey } = require('./stripeService');
const settingsService = require('./settingsService');
const { normalizeEmail } = require('../utils/email');

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

// NODE_ENV=test alatt soha nem megy ki valódi levél: a küldés csak sikert szimulál, és a mockOutbox-ba jegyzi (csak címzett, tárgy, csatolmány-nevek).
const mockOutbox = [];
const mockAlerts = [];

function isMailMocked(env = process.env) {
  return env.NODE_ENV === 'test';
}

function createMockTransport() {
  return {
    mock: true,
    async sendMail(message) {
      const to = Array.isArray(message.to) ? message.to.join(', ') : String(message.to || '');
      mockOutbox.push({ to, subject: String(message.subject || ''), attachments: (message.attachments || []).map((file) => file.filename) });
      return { messageId: `<mock-${mockOutbox.length}@ovitervezo.test>`, accepted: [to], rejected: [], response: '250 mock: NODE_ENV=test, nem ment ki valódi e-mail', mock: true };
    }
  };
}

function createTransport(env, deps) {
  if (deps.transport) return deps.transport;
  if (isMailMocked(env)) return createMockTransport();
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
  return String(env.FEEDBACK_SECRET || '').trim();
}

function createFeedbackSignature(email, env = process.env) {
  const normalized = normalizeEmail(email);
  const secret = feedbackSecret(env);
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

function verifyFeedbackSignature(email, sig, env = process.env) {
  if (!email || !sig) return false;
  const expected = createFeedbackSignature(email, env);
  if (!expected) return false;
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

function buildEmailContent({ planLabel, withInvoice, title, orderNumber, to, hasZip, planMode, documentId, invoiceOnly = false }, env) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const c = companyLines(env);
  const support = supportEmail(env);
  const site = 'https://ovitervezo.hu';
  // A ZIP-szöveg a tényleges mellékleteket követi (az oktatási célú tematikus terv egyetlen PDF/DOCX), ennek hiányában a csomag nevét.
  const zip = hasZip ?? planLabel === 'heti csomag';
  const attachmentText = zip
    ? 'a heti csomag ZIP archívuma (benne Word és PDF formátumú tervezetekkel)'
    : 'a tervezet Word (.docx) és PDF formátumban is';
  const invoiceText = withInvoice ? ' A számlát is mellékeltük PDF-ben.' : '';
  const legalText = `${c.name} | Székhely: ${c.address} | Adószám: ${c.taxId} | ${c.regLabel}: ${c.regNo}`;

  let feedbackBlock = '';
  let textFeedbackBlock = '';
  let feedbackStars = '';
  let feedbackLink = '';
  const sig = to ? createFeedbackSignature(to, env) : '';
  if (to && sig && !invoiceOnly) {
    const docParam = documentId ? `&documentId=${encodeURIComponent(documentId)}` : '';
    const feedbackUrl = (r) => `${site}/ertekeles.html?rating=${r}&email=${encodeURIComponent(to)}&sig=${sig}${docParam}`;
    const starsHtml = [1, 2, 3, 4, 5].map((r) =>
      `<a href="${feedbackUrl(r)}" title="${r} csillag" style="display:inline-block;padding:2px 6px;text-decoration:none;font-size:26px;line-height:1;color:#f59e0b;">⭐</a>`
    ).join('');
    feedbackStars = starsHtml;
    feedbackLink = feedbackUrl(5);
    feedbackBlock = `
<div style="margin:22px 0 0;padding:16px 18px;background:#f9fbf9;border:1px solid #d9ebe0;border-radius:14px;text-align:center;">
<p style="margin:0 0 10px;font-size:13.5px;line-height:1.5;color:#4a5953;font-weight:600;">Hogy sikerült a tervezet? Kattints a csillagokra, és írd meg 1 percben a véleményed:</p>
<div style="display:inline-block;text-align:center;">
${starsHtml}
</div>
</div>`;

    textFeedbackBlock = `\n\nHogy sikerült a tervezet? Kattints a csillagokra, és írd meg 1 percben a véleményed:\n${feedbackUrl(5)}`;
  }

  const text = invoiceOnly
    ? `Kedves Kolléganő!\n\nKöszönjük, hogy az OviTervezőt választotta – mellékelten küldjük a vásárlásáról kiállított számlát PDF formátumban.\n\n${cleanTitle ? `Megrendelés témája: ${cleanTitle}\n` : ''}${orderNumber ? `Rendelésszám: ${orderNumber}\n` : ''}Csatolmány: Számla (PDF)\n\nA számla elektronikus úton továbbított, nyomtatás nélkül is könyvelhető bizonylat. Kérjük, őrizze meg saját nyilvántartása számára.\n\nSikeres, játékos hetet kívánunk!\n\nÜdvözlettel,\nAz OviTervező csapata\n${site}\n\nKérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk! (${support})\n\n--\nKibocsátó: ${legalText}\nAdatkezelési tájékoztató és ÁSZF: ${site}\nEz a vásárláshoz kapcsolódó automatikus rendszerüzenet.`
    : `Kedves Kolléganő!\n\nKöszönjük, hogy az OviTervezőt választotta, és köszönjük az elhivatott munkáját, amellyel nap mint nap a gyerekek mellett áll. Remélhetőleg ez a tervezet sok időt spórol Önnek, hogy többet jusson a legfontosabbra: a gyerekekre.\n\n${cleanTitle ? `Tervezet témája: ${cleanTitle}\n\n` : ''}${orderNumber ? `Rendelésszám: ${orderNumber}\n\n` : ''}${planMode === 'academic' ? 'Tervezet típusa: Oktatási célú tervezet\n\n' : ''}Mellékletben küldjük ${attachmentText}.${invoiceText}\n\nTipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.\n\nSikeres, játékos hetet kívánunk!\n\nÜdvözlettel,\nAz OviTervező csapata\n${site}\n\nKérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk! (${support})${textFeedbackBlock}\n\n--\nKibocsátó: ${legalText}\nAdatkezelési tájékoztató és ÁSZF: ${site}\nEz a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.`;

  const invoiceItem = withInvoice
    ? `<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">🧾 <strong>Számla</strong> (PDF)</td></tr>`
    : '';
  const fileItems = invoiceOnly ? '' : zip
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
<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
${invoiceOnly
    ? '<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – mellékelten küldjük a vásárlásáról kiállított számlát PDF formátumban.</p>'
    : `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Köszönjük, hogy az OviTervezőt választotta – és köszönjük az elhivatott munkát, amellyel nap mint nap a gyerekek mellett áll.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#2d3b36;">Reméljük, hogy a kész tervezet sok időt spórol Önnek, így több jut a legfontosabbra: a közös játékra és felfedezésre.</p>`}
${cleanTitle ? `<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>${invoiceOnly ? 'Megrendelés' : 'Tervezet'} témája:</strong> ${escapeHtml(cleanTitle)}</p>` : ''}
${planMode === 'academic' ? '<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Tervezet típusa: <strong>Oktatási célú tervezet</strong></p>' : ''}
${orderNumber ? `<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Rendelésszám: <strong>${escapeHtml(orderNumber)}</strong></p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4fbf7;border:1px solid #cfe8da;border-radius:14px;"><tr><td style="padding:14px 18px;">
<div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#1f5f52;margin-bottom:4px;">📎 Mellékletek</div>
<table role="presentation" cellpadding="0" cellspacing="0">${fileItems}${invoiceItem}</table>
</td></tr></table>
${invoiceOnly ? '' : '<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#5b6b64;background:#f6f7f7;border-radius:10px;padding:10px 14px;">Tipp: A csatolt Word (.docx) formátum szabadon szerkeszthető, így bármikor hozzáigazíthatja saját csoportja igényeihez.</p>'}
<p style="margin:20px 0;text-align:center;"><a href="${site}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0 0 4px;font-size:16px;line-height:1.6;color:#2d3b36;">Sikeres, játékos hetet kívánunk!</p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
<p style="margin:14px 0 0;font-size:14px;color:#5b6b64;">Kérdése van? Nyugodtan válaszoljon közvetlenül erre a levélre, szívesen segítünk!</p>
${feedbackBlock}
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
<strong>Kibocsátó:</strong> ${c.name}, székhely: ${c.address}, adószám: ${c.taxId}, ${c.regLabel}: ${c.regNo}.<br>
<a href="${site}" style="color:#7a8480;">Adatkezelési tájékoztató</a> · <a href="${site}" style="color:#7a8480;">ÁSZF</a> – ${site}<br>
Ez a vásárláshoz/tervezéshez kapcsolódó automatikus rendszerüzenet.
</td></tr>
</table></td></tr></table></body></html>`;
  const parts = {
    attachments_rows: `${fileItems}${invoiceItem}`,
    invoiceText,
    feedback_block: feedbackBlock,
    feedback_stars: feedbackStars,
    feedback_url: feedbackLink,
    site_url: site
  };
  return { text, html, parts };
}

// A base_layout közös helyőrzői: a logó forrása, a kibocsátó adatai és a leiratkozó blokk (üres, ha nincs leiratkozási lehetőség).
function layoutValues(env, { logoSrc, unsubscribeUrl, newsletter = false } = {}) {
  const c = companyLines(env);
  const unsubscribe = unsubscribeUrl
    ? `Azért kaptad ezt a levelet, mert feliratkoztál az OviTervező hírlevelére. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#2f946f;">Leiratkozás egy kattintással</a><br>`
    : (newsletter ? 'Ha nem szeretnél több levelet kapni tőlünk, válaszolj erre a levélre.<br>' : '');
  return {
    logo_src: logoSrc || `cid:${LOGO_CID}`,
    site_url: 'https://ovitervezo.hu',
    company_legal: `${escapeHtml(c.name)}, székhely: ${escapeHtml(c.address)}, adószám: ${escapeHtml(c.taxId)}, ${escapeHtml(c.regLabel)}: ${escapeHtml(c.regNo)}`,
    unsubscribe_link: unsubscribe
  };
}

function hasZipAttachment(attachments) {
  return Array.isArray(attachments) && attachments.some((file) => /\.zip$/i.test(String(file?.filename || '')));
}

function planLabelOf(plan) {
  if (String(plan) === 'academic_weekly') return 'oktatási célú heti tematikus terv';
  if (String(plan) === 'academic_daily') return 'oktatási célú napi tervezet';
  return String(plan).startsWith('weekly') ? 'heti csomag' : 'napi tervezet';
}

// A rendszergazdai másolat kötelező. Sorrend: Admin Központban mentett értesítési cím > NOTIFICATION_EMAIL / ADMIN_NOTIFICATION_EMAIL / ADMIN_EMAIL / SUPPORT_EMAIL > közös ügyfélszolgálati cím.
// kind: 'billing' (fizetés/számla) vagy 'error' (hiba, tesztelés, visszajelzés).
function adminEmail(env = process.env, kind = '') {
  return settingsService.resolveNotificationEmail(settingsService.peek(), env, kind) || SUPPORT_EMAIL;
}

// A küldés előtt frissíti a beállítás-gyorsítótárat, hogy az admin friss címe azonnal érvényes legyen; adatbázis-hiba esetén az utolsó ismert érték/tartalék él.
async function refreshNotificationSettings() {
  try {
    await settingsService.getSettings();
  } catch (error) {
    console.error('Az értesítési e-mail beállítás nem frissíthető, az utolsó ismert érték/tartalék él:', error.message);
  }
}

// Külön értesítő a webhookból: a számla a rendszergazdához akkor is eljut, ha a vevő böngészője nem indítja a kézbesítést.
async function sendAdminNotification({ customer, plan, orderNumber, invoiceNumber, invoicePdf, title, paymentMethod }, deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) return { sent: false, reason: 'smtp_not_configured' };
  await refreshNotificationSettings();
  const support = supportEmail(env);
  const lines = [`Új sikeres fizetés${paymentMethod ? ` (${paymentMethod})` : ''}.`, `Rendelésszám: ${orderNumber || '-'}`, `Számlaszám: ${invoiceNumber || '-'}`, `Csomag: ${planLabelOf(plan)}`, `Vevő: ${customer?.name || '-'} <${customer?.email || '-'}>`, `Téma: ${title || '-'}`];
  const transport = createTransport(env, deps);
  await transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to: adminEmail(env, 'billing'),
    subject: `OviTervező – új fizetés${paymentMethod === 'Barion' ? ' Barionnal' : ''}: ${orderNumber || ''}`.trim(),
    text: lines.join('\n'),
    attachments: Buffer.isBuffer(invoicePdf) && invoicePdf.length ? [{ filename: `${orderNumber || 'szamla'}.pdf`, content: invoicePdf, contentType: 'application/pdf' }] : []
  });
  return { sent: true };
}

// Egyetlen levél: a megvásárolt tervezet fájljai és a számla PDF együtt. Ha nincs tervezet-melléklet (csak számla), az invoice_only sablon (vagy a megadott egyedi sablon) megy ki.
async function sendPurchaseEmail({ to, plan, attachments, invoicePdf, invoiceName, invoiceNumber, title, orderNumber, planMode, documentId, templateId }, deps = {}) {
  const env = deps.env || process.env;
  const support = supportEmail(env);
  const invoiceOnly = Boolean(invoicePdf) && !(Array.isArray(attachments) && attachments.length);
  const activeTemplateId = invoiceOnly ? (templateId || 'invoice_only') : 'payment_success';
  const built = buildEmailContent({ planLabel: planLabelOf(plan), withInvoice: Boolean(invoicePdf), title, orderNumber, to, hasZip: hasZipAttachment(attachments), planMode, documentId, invoiceOnly }, env);
  const { text } = built;
  let { html } = built;
  let subject = invoiceOnly
    ? `Számlája elkészült – OviTervező (${invoiceNumber || orderNumber || 'számla'})`
    : invoicePdf ? 'OviTervező – a megvásárolt tervezet és a számla' : 'OviTervező – a kuponnal feloldott tervezet';
  // Az adatbázisban szerkeszthető sablon (payment_success / invoice_only a base_layout-ban) elsőbbséget élvez; a hiba hangosan naplózódik, a kézbesítés ettől nem akad el.
  let templates = null;
  try {
    templates = deps.templates !== undefined ? deps.templates : await settingsService.getTemplates();
  } catch (error) {
    console.error(`[mail] Az e-mail sablonok betöltése sikertelen, a hivatalos alapsablon megy ki: ${error.message}`);
  }
  // Adatbázis nélkül (vagy olvasási hibánál) is az Adminban szerkeszthető sablon hivatalos alapértéke küldi a levelet, nem egy külön beégetett HTML.
  if (!templates) templates = { ...settingsService.DEFAULT_TEMPLATES };
  if (invoiceOnly && templateId && templates && !templates[templateId] && !settingsService.DEFAULT_TEMPLATES[templateId]) {
    const missing = new Error('A kiválasztott e-mail sablon nem található.');
    missing.status = 404;
    throw missing;
  }
  try {
    if (templates) {
      for (const id of [activeTemplateId, 'base_layout']) {
        if (!templates[id] && settingsService.DEFAULT_TEMPLATES[id]) templates = { ...templates, [id]: settingsService.DEFAULT_TEMPLATES[id] };
      }
      const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      // A szerkeszthető értékeléskérő sablon csak aláírt (érvényes FEEDBACK_SECRET-es) linkekkel jelenik meg.
      const feedbackBlock = templates.feedback_request && built.parts.feedback_stars
        ? settingsService.fillPlaceholders(templates.feedback_request.bodyHtml, { stars: built.parts.feedback_stars, feedback_url: escapeHtml(built.parts.feedback_url) })
        : built.parts.feedback_block;
      const composed = settingsService.composeEmail(templates, activeTemplateId, {
        ...layoutValues(env),
        ...built.parts,
        feedback_block: feedbackBlock,
        planLabel: escapeHtml(planLabelOf(plan)),
        invoiceText: invoicePdf ? ' A számlát is mellékeltük PDF-ben.' : '',
        invoiceNumber: escapeHtml(invoiceNumber || '–'),
        topic: escapeHtml(cleanTitle || '–'),
        orderId: escapeHtml(orderNumber || '–'),
        title_block: cleanTitle ? `<p style="margin:0 0 18px;padding:10px 14px;background:#f4fbf7;border-left:4px solid #3fae84;border-radius:8px;font-size:15px;color:#2d3b36;"><strong>Tervezet témája:</strong> ${escapeHtml(cleanTitle)}</p>` : '',
        plan_type_block: planMode === 'academic' ? '<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Tervezet típusa: <strong>Oktatási célú tervezet</strong></p>' : '',
        order_block: orderNumber ? `<p style="margin:0 0 18px;font-size:14px;color:#5b6b64;">Rendelésszám: <strong>${escapeHtml(orderNumber)}</strong></p>` : ''
      });
      html = composed.html;
      if (invoicePdf && composed.subject) subject = composed.subject.replace(/[\r\n]+/g, ' ');
    }
  } catch (error) {
    console.error(`[mail] Az e-mail sablon betöltése sikertelen, a beépített levél megy ki: ${error.message}`);
  }
  const transport = createTransport(env, deps);
  return transport.sendMail({
    from: env.MAIL_FROM || `OviTervező <${support}>`,
    to,
    replyTo: support,
    subject,
    text,
    html,
    attachments: [...attachments, ...(invoicePdf ? [{ filename: invoiceName || 'szamla.pdf', content: invoicePdf, contentType: 'application/pdf' }] : []), logoAttachment()]
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
  await refreshNotificationSettings();
  const support = supportEmail(env);
  const transport = createTransport(env, actualDeps);

  const subject = `OviTervező értékelés: ${data.rating}/5 csillag – ${data.email}`;
  const text = [
    `Új vásárlói értékelés érkezett az OviTervező felületén.`,
    ``,
    `Értékelés: ${data.rating} / 5 csillag`,
    `Vásárló: ${data.email}`,
    `Név / beosztás: ${data.name || 'Nem adott meg nevet'}`,
    data.documentId ? `Dokumentum azonosító: ${data.documentId}` : '',
    ``,
    `Vélemény, tapasztalat:`,
    data.comment || 'Nem fűzött hozzá szöveges megjegyzést.'
  ].filter(Boolean).join('\n');

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
  ${data.documentId ? `<tr><td style="padding:6px 0;color:#5b6b64;font-size:14px;">Dokumentum ID:</td><td style="padding:6px 0;font-size:14px;font-family:monospace;color:#1f3d34;">${escapeHtml(data.documentId)}</td></tr>` : ''}
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
    to: adminEmail(env, 'error'),
    replyTo: data.email,
    subject,
    text,
    html
  });
  return { sent: true };
}

// Rendszergazdai e-mail riasztás kritikus hibákról (Gemini generálás, számlázás, fizetési rendszerhibák).
async function sendAdminErrorAlert({ operation, error, email, documentId, details }, deps = {}) {
  const env = deps.env || process.env;
  if (!isConfigured(env)) return { sent: false, reason: 'smtp_not_configured' };
  await refreshNotificationSettings();
  const support = supportEmail(env);
  const recipient = adminEmail(env, 'error');
  const timestamp = new Date().toISOString();
  const errorMessage = error?.stack || error?.message || String(error || 'Ismeretlen hiba');
  const op = String(operation || 'Rendszerhiba');
  const subject = `KRITIKUS HIBA: ${op}`;

  const lines = [
    `KRITIKUS RENDSZERHIBA RIASZTÁS - OviTervező`,
    `Időpont: ${timestamp}`,
    `Művelet: ${op}`,
    `Felhasználó e-mail: ${email || '-'}`,
    `Dokumentum / Munkamenet azonosító: ${documentId || '-'}`,
    details ? `Részletek: ${typeof details === 'object' ? JSON.stringify(details, null, 2) : details}` : '',
    ``,
    `Hibaüzenet / Stack trace:`,
    errorMessage
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><title>Kritikus Rendszerhiba</title></head>
<body style="margin:0;padding:0;background:#fef2f2;font-family:monospace;">
<div style="padding:24px;max-width:700px;background:#ffffff;border:1px solid #f87171;border-radius:8px;margin:20px auto;">
  <h2 style="color:#b91c1c;margin:0 0 16px;">KRITIKUS RENDSZERHIBA: ${escapeHtml(op)}</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr><td><strong>Időpont:</strong></td><td>${escapeHtml(timestamp)}</td></tr>
    <tr><td><strong>Művelet:</strong></td><td>${escapeHtml(op)}</td></tr>
    <tr><td><strong>Felhasználó:</strong></td><td>${escapeHtml(email || '-')}</td></tr>
    <tr><td><strong>Dokumentum / Session ID:</strong></td><td>${escapeHtml(documentId || '-')}</td></tr>
    ${details ? `<tr><td><strong>Részletek:</strong></td><td><pre style="margin:0;white-space:pre-wrap;">${escapeHtml(typeof details === 'object' ? JSON.stringify(details, null, 2) : String(details))}</pre></td></tr>` : ''}
  </table>
  <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px;margin-top:12px;">
    <strong>Hiba és Stack trace:</strong>
    <pre style="margin:8px 0 0;white-space:pre-wrap;color:#991b1b;">${escapeHtml(errorMessage)}</pre>
  </div>
</div>
</body></html>`;

  if (!deps.transport && isMailMocked(env)) {
    mockAlerts.push({ to: recipient, subject, text: lines, html });
    return { sent: true, mock: true };
  }

  try {
    const transport = createTransport(env, deps);
    await transport.sendMail({
      from: env.MAIL_FROM || `OviTervező Rendszerhiba <${support}>`,
      to: recipient,
      subject,
      text: lines,
      html
    });
    return { sent: true };
  } catch (mailError) {
    console.error('Failed to send admin error alert email:', mailError.message);
    return { sent: false, error: mailError.message };
  }
}

module.exports = {
  LOGO_CID,
  logoAttachment,
  createTransport,
  companyLines,
  escapeHtml,
  isMailMocked,
  mockOutbox,
  mockAlerts,
  adminEmail,
  sendAdminNotification,
  sendAdminErrorAlert,
  buildEmailContent,
  layoutValues,
  isConfigured,
  sanitizeAttachments,
  sendPurchaseEmail,
  feedbackSecret,
  createFeedbackSignature,
  verifyFeedbackSignature,
  sendFeedbackNotification
};
