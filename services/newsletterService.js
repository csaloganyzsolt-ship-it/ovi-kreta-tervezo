'use strict';

// Hírlevélküldés az Admin Központból: GDPR-szűrt címzettlista, az OviTervező arculatú levélsablon, személyes leiratkozó link
// és kíméletes (egyenként, késleltetett) küldés a háttérben. Az eredmény a newsletter_campaigns táblába kerül.
const fs = require('node:fs');
const path = require('node:path');
const mailService = require('./mailService');
const { supportEmail } = require('./invoiceService');
const { AdminError, fetchAll, listAuthUsers, isConfirmed } = require('./adminService');

const SITE = 'https://ovitervezo.hu';
const UNSUBSCRIBE_PLACEHOLDER = '{{UNSUBSCRIBE_URL}}';
const SEND_DELAY_MS = 1500;
const EMAIL_PATTERN = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
const MAX_CUSTOM_RECIPIENTS = 200;
const LIMITS = { subject: 200, heading: 200, body: 50000, ctaText: 60, ctaUrl: 500 };
const RECIPIENT_MODES = ['test', 'subscribers', 'custom'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendDelayMs = (env = process.env) => (env.NODE_ENV === 'test' ? 0 : SEND_DELAY_MS);
const escapeHtml = mailService.escapeHtml;

// ---------- Tartalom ----------

// A törzs admin által írt szöveg vagy HTML. A levelezők amúgy sem futtatnak scriptet, a veszélyes elemeket ettől még eltávolítjuk;
// az előnézet ráadásul sandboxolt iframe-ben jelenik meg.
function sanitizeHtml(html) {
  return String(html)
    .replace(/<\s*(script|iframe|object|embed|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|form|link|meta|base|input)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"');
}

const looksLikeHtml = (text) => /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(text);

const PARAGRAPH_STYLE = 'margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;';

function renderBody(text) {
  const value = String(text || '').trim();
  if (looksLikeHtml(value)) return sanitizeHtml(value);
  return value.split(/\n\s*\n/).map((part) => `<p style="${PARAGRAPH_STYLE}">${escapeHtml(part.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function htmlToText(html) {
  return String(html)
    .replace(/<\s*(style|head)[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>|<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (_error) {
    return null;
  }
}

function cleanLine(value, limit, label) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new AdminError(`A(z) ${label} szöveges legyen.`, 400);
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > limit) throw new AdminError(`A(z) ${label} legfeljebb ${limit} karakter lehet.`, 400);
  return text;
}

// A kérés ellenőrzése és tisztítása; a bodyHtml itt már a megjelenítendő (sanitizált) HTML.
function parseCampaignInput(body = {}) {
  const subject = cleanLine(body.subject, LIMITS.subject, 'tárgy');
  if (!subject) throw new AdminError('A tárgy megadása kötelező.', 400);
  const heading = cleanLine(body.heading, LIMITS.heading, 'főcím');
  if (typeof body.bodyHtml !== 'string' || !body.bodyHtml.trim()) throw new AdminError('A levél szövege kötelező.', 400);
  if (body.bodyHtml.length > LIMITS.body) throw new AdminError('A levél szövege túl hosszú.', 400);
  const ctaText = cleanLine(body.ctaText, LIMITS.ctaText, 'gomb felirata');
  const rawUrl = cleanLine(body.ctaUrl, LIMITS.ctaUrl, 'gomb hivatkozása');
  if (Boolean(ctaText) !== Boolean(rawUrl)) throw new AdminError('A gombhoz a felirat és a hivatkozás is szükséges.', 400);
  let ctaUrl = '';
  if (rawUrl) {
    ctaUrl = parseHttpsUrl(rawUrl);
    if (!ctaUrl) throw new AdminError('A gomb hivatkozása érvényes https:// cím legyen.', 400);
  }
  return { subject, heading, bodyHtml: renderBody(body.bodyHtml), ctaText, ctaUrl };
}

// ---------- Sablon ----------

function unsubscribeUrlFor(token) {
  return `${SITE}/leiratkozas.html?token=${encodeURIComponent(token)}`;
}

// Hivatalos zöld OviTervező levél: menta sáv, "OT" logó (CID), főcím, törzs, opcionális gomb, jogi lábléc és leiratkozás.
function buildNewsletterHtml({ heading, bodyHtml, ctaText, ctaUrl, unsubscribeUrl, logoSrc }, env = process.env) {
  const c = mailService.companyLines(env);
  const footerUnsub = unsubscribeUrl
    ? `Azért kaptad ezt a levelet, mert feliratkoztál az OviTervező hírlevelére. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#2f946f;">Leiratkozás egy kattintással</a>`
    : 'Ha nem szeretnél több levelet kapni tőlünk, válaszolj erre a levélre.';
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OviTervező</title></head>
<body style="margin:0;padding:0;background:#eef6f1;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef6f1;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #d9ebe0;">
<tr><td style="height:5px;line-height:5px;font-size:0;background:#3fae84;">&nbsp;</td></tr>
<tr><td style="background:#d8f0e3;padding:22px 28px;text-align:center;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
<td style="padding-right:12px;vertical-align:middle;"><img src="${logoSrc || `cid:${mailService.LOGO_CID}`}" width="52" height="52" alt="OT" style="display:block;border:0;border-radius:12px;"></td>
<td style="vertical-align:middle;font-size:26px;line-height:1;color:#1f3d34;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">Ovi<strong style="font-weight:800;color:#2f946f;">Tervező</strong></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
${heading ? `<h1 style="margin:0 0 14px;font-size:22px;color:#1f5f52;">${escapeHtml(heading)}</h1>` : ''}
${bodyHtml}
${ctaUrl ? `<p style="margin:22px 0;text-align:center;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">${escapeHtml(ctaText)}</a></p>` : ''}
<p style="margin:18px 0 0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>
</td></tr>
<tr><td style="background:#f6f7f7;padding:18px 28px;border-top:1px solid #e6eae8;font-size:12px;line-height:1.6;color:#7a8480;">
${footerUnsub}<br>
<strong>Kibocsátó:</strong> ${escapeHtml(c.name)}, székhely: ${escapeHtml(c.address)}, adószám: ${escapeHtml(c.taxId)}, ${escapeHtml(c.regLabel)}: ${escapeHtml(c.regNo)}.<br>
<a href="${SITE}" style="color:#7a8480;">${SITE}</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

function buildNewsletterText(input, unsubscribeUrl) {
  const parts = [input.heading, htmlToText(input.bodyHtml), input.ctaUrl ? `${input.ctaText}: ${input.ctaUrl}` : '', 'Üdvözlettel,\nAz OviTervező csapata\n' + SITE];
  parts.push(unsubscribeUrl ? `Leiratkozás: ${unsubscribeUrl}` : 'Ha nem szeretnél több levelet kapni, válaszolj erre a levélre.');
  return parts.filter(Boolean).join('\n\n');
}

let logoDataUri;
function logoDataUriOf() {
  if (!logoDataUri) logoDataUri = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'mail-logo.png')).toString('base64')}`;
  return logoDataUri;
}

// Élő előnézet: ugyanaz a sablon, mint a kiküldött levélé; a CID-es logó helyett beágyazott kép, a leiratkozó link mintaérték.
// Az előnézet szándékosan elnéző (gépelés közben hiányos mezők is lehetnek); a hibákat a tényleges küldés jelzi.
function buildPreview(body = {}, env = process.env) {
  const text = (value, limit) => (typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit) : '');
  const ctaText = text(body.ctaText, LIMITS.ctaText);
  const ctaUrl = ctaText ? parseHttpsUrl(text(body.ctaUrl, LIMITS.ctaUrl)) || '' : '';
  const rawBody = typeof body.bodyHtml === 'string' ? body.bodyHtml.slice(0, LIMITS.body) : '';
  return buildNewsletterHtml({
    heading: text(body.heading, LIMITS.heading),
    bodyHtml: renderBody(rawBody),
    ctaText: ctaUrl ? ctaText : '',
    ctaUrl,
    unsubscribeUrl: unsubscribeUrlFor('00000000-0000-4000-8000-000000000000'),
    logoSrc: logoDataUriOf()
  }, env);
}

// ---------- Címzettek ----------

function parseEmailList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const emails = [...new Set(list.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new AdminError('Adj meg legalább egy e-mail címet.', 400);
  if (emails.length > MAX_CUSTOM_RECIPIENTS) throw new AdminError(`Egyszerre legfeljebb ${MAX_CUSTOM_RECIPIENTS} egyedi cím adható meg.`, 400);
  const invalid = emails.filter((email) => !EMAIL_PATTERN.test(email));
  if (invalid.length) throw new AdminError(`Érvénytelen e-mail cím: ${invalid.slice(0, 3).join(', ')}`, 400);
  return emails;
}

// GDPR: hírlevelet csak az kap, aki feliratkozott (newsletter_subscribed = true) ÉS megerősítette az e-mail címét (auth.users.email_confirmed_at).
async function subscribedRecipients(client) {
  const [profiles, authUsers] = await Promise.all([
    fetchAll(() => client.from('profiles').select('id, email, newsletter_token').eq('newsletter_subscribed', true).order('id', { ascending: true }), 'A feliratkozók lekérdezése sikertelen'),
    listAuthUsers(client)
  ]);
  const confirmed = new Map(authUsers.filter(isConfirmed).map((user) => [String(user.id), user]));
  const recipients = [];
  const skipped = [];
  for (const profile of profiles) {
    const user = confirmed.get(String(profile.id));
    const email = String(user?.email || '').trim().toLowerCase();
    if (!user || !email || !profile.newsletter_token) {
      skipped.push({ email: String(profile.email || '').toLowerCase(), reason: 'nincs megerősített e-mail cím' });
      continue;
    }
    recipients.push({ email, token: String(profile.newsletter_token) });
  }
  return { recipients, skipped };
}

async function customRecipients(client, emails) {
  const { data, error } = await client.from('profiles').select('email, newsletter_subscribed, newsletter_token').in('email', emails);
  if (error) throw new AdminError(`A címzettek lekérdezése sikertelen: ${error.message}`, 500);
  const byEmail = new Map((data || []).map((profile) => [String(profile.email).toLowerCase(), profile]));
  const recipients = [];
  const skipped = [];
  for (const email of emails) {
    const profile = byEmail.get(email);
    if (!profile) recipients.push({ email, token: null });
    else if (profile.newsletter_subscribed === true && profile.newsletter_token) recipients.push({ email, token: String(profile.newsletter_token) });
    else skipped.push({ email, reason: 'leiratkozott vagy nem iratkozott fel' });
  }
  return { recipients, skipped };
}

async function resolveRecipients(client, { recipients: mode, emails }, admin) {
  if (!RECIPIENT_MODES.includes(mode)) throw new AdminError('Ismeretlen címzett-választás.', 400);
  if (mode === 'test') {
    const { data, error } = await client.from('profiles').select('newsletter_token').eq('id', admin.id).maybeSingle();
    if (error) throw new AdminError(`A profil lekérdezése sikertelen: ${error.message}`, 500);
    return { recipients: [{ email: admin.email, token: data?.newsletter_token ? String(data.newsletter_token) : null }], skipped: [] };
  }
  if (mode === 'subscribers') return subscribedRecipients(client);
  return customRecipients(client, parseEmailList(emails));
}

// ---------- Küldés ----------

let activeJob = null;

function isSending() {
  return activeJob !== null;
}

// Tesztekhez: megvárja a háttérben futó küldést.
async function whenIdle() {
  while (activeJob) await activeJob.promise;
}

async function runJob({ client, campaignId, input, recipients, env, deps, logger }) {
  const transport = mailService.createTransport(env, deps);
  const from = env.MAIL_FROM || `OviTervező <${supportEmail(env)}>`;
  const replyTo = supportEmail(env);
  const delay = sendDelayMs(env);
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index];
    const unsubscribeUrl = recipient.token ? unsubscribeUrlFor(recipient.token) : '';
    try {
      await transport.sendMail({
        from,
        to: recipient.email,
        replyTo,
        subject: input.subject,
        text: buildNewsletterText(input, unsubscribeUrl),
        html: buildNewsletterHtml({ ...input, unsubscribeUrl }, env),
        headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>` } : undefined,
        attachments: [mailService.logoAttachment()]
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error('[hírlevél] küldési hiba:', error.message);
    }
    const { error } = await client.from('newsletter_campaigns').update({ sent_count: sent, failed_count: failed }).eq('id', campaignId);
    if (error) logger.error('[hírlevél] a kampány állapota nem menthető:', error.message);
    if (delay && index < recipients.length - 1) await sleep(delay);
  }
  return { sent, failed };
}

// Ellenőrzi a kérést, összeállítja a címzetteket, naplózza a kampányt, majd a háttérben elküldi a leveleket (az admin a kampánylistán követi).
async function startCampaign(client, body, admin, { env = process.env, deps = {}, logger = console } = {}) {
  if (activeJob) throw new AdminError('Már fut egy hírlevélküldés. Várd meg, amíg befejeződik.', 409);
  const input = parseCampaignInput(body);
  const mode = body?.recipients;
  if (!mailService.isConfigured(env) && !mailService.isMailMocked(env) && !deps.transport) {
    throw new AdminError('Az e-mail küldés nincs beállítva a szerveren (SMTP_HOST).', 503);
  }
  const { recipients, skipped } = await resolveRecipients(client, { recipients: mode, emails: body?.emails }, admin);
  if (!recipients.length) throw new AdminError('Nincs olyan címzett, akinek a levél jogszerűen elküldhető.', 400);

  const { data, error } = await client.from('newsletter_campaigns').insert({
    subject: input.subject,
    html_body: buildNewsletterHtml({ ...input, unsubscribeUrl: UNSUBSCRIBE_PLACEHOLDER, logoSrc: `cid:${mailService.LOGO_CID}` }, env),
    recipient_filter: mode,
    recipient_count: recipients.length,
    sent_count: 0,
    failed_count: 0,
    sent_by: admin.email
  }).select('id').single();
  if (error || !data?.id) throw new AdminError(`A kampány naplózása sikertelen: ${error?.message || 'ismeretlen hiba'}`, 500);

  const job = { campaignId: data.id };
  job.promise = runJob({ client, campaignId: data.id, input, recipients, env, deps, logger })
    .catch((jobError) => logger.error('[hírlevél] a küldés megszakadt:', jobError.message))
    .finally(() => { if (activeJob === job) activeJob = null; });
  activeJob = job;
  return { campaignId: data.id, recipientCount: recipients.length, skipped };
}

async function listCampaigns(client) {
  const { data, error } = await client.from('newsletter_campaigns')
    .select('id, subject, recipient_filter, recipient_count, sent_count, failed_count, sent_by, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new AdminError(`A kampányok lekérdezése sikertelen: ${error.message}`, 500);
  return {
    sending: activeJob?.campaignId || null,
    campaigns: (data || []).map((row) => ({
      id: row.id,
      subject: row.subject,
      recipientFilter: row.recipient_filter,
      recipientCount: row.recipient_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      sentBy: row.sent_by || '',
      createdAt: row.created_at
    }))
  };
}

module.exports = {
  SITE,
  UNSUBSCRIBE_PLACEHOLDER,
  sanitizeHtml,
  renderBody,
  parseCampaignInput,
  parseEmailList,
  buildNewsletterHtml,
  buildNewsletterText,
  buildPreview,
  unsubscribeUrlFor,
  resolveRecipients,
  startCampaign,
  listCampaigns,
  isSending,
  sendDelayMs,
  whenIdle
};
