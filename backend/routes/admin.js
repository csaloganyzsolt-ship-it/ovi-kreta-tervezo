'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const supabase = require('../services/supabaseService');
const { requireAdmin } = require('../services/authService');
const admin = require('../services/adminService');
const newsletter = require('../services/newsletterService');
const analytics = require('../services/analyticsService');
const mailService = require('../services/mailService');
const settingsService = require('../services/settingsService');
const orderService = require('../services/orderService');
const invoiceService = require('../services/invoiceService');
const planStore = require('../services/planStore');
const documentExport = require('../services/documentExport');
const { billingStatus } = require('../services/billingStatus');
const { dailyGenerationStatus } = require('../services/generationCap');
const logger = require('../utils/logger');

const limiterOptions = { windowMs: 60 * 1000, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Túl sok kérés. Kérjük, várj egy percet.' } };
// Az admin végpontok a hitelesítés ELŐTT is korlátozottak (jelszó- és tokenpróbálgatás ellen), a küldés szigorúbban.
const adminLimiter = rateLimit({ ...limiterOptions, limit: () => Number(process.env.ADMIN_RATE_LIMIT) || 120 });
const sendLimiter = rateLimit({ ...limiterOptions, limit: () => Number(process.env.ADMIN_SEND_RATE_LIMIT) || 10 });

function sendAdminError(res, error, context) {
  const status = error.status || 500;
  if (status >= 500) console.error(`[admin] ${context} sikertelen:`, error.message);
  return res.status(status).json({
    success: false,
    error: status < 500 ? error.message : status === 503 ? error.message : `${context} sikertelen. Kérjük, próbáld újra később.`
  });
}

// Egységes burkoló: Supabase-kliens beszerzése (503 nélküle), hibák kezelése, a válasz sosem gyorsítótárazható.
function handle(context, action) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const client = supabase.requireClient();
      const result = await action(client, req, res);
      if (!res.headersSent) res.json({ success: true, ...result });
    } catch (error) {
      sendAdminError(res, error, context);
    }
  };
}

const router = express.Router();
router.use('/admin', adminLimiter, requireAdmin);

// A mai generálások száma a plafon mellett (a beállítások előbb töltődnek be, hogy a plafon friss legyen).
async function currentDailyGeneration() {
  await settingsService.getSettings();
  return dailyGenerationStatus(process.env);
}

// A requireAdmin már mindkét feltételt ellenőrizte; ha ide eljutott a kérés, a felhasználó admin.
router.get('/admin/me', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, isAdmin: true });
});

router.get('/admin/stats', handle('A statisztika lekérdezése', async (client, req) => {
  const stats = await admin.getStats(client);
  
  // Telemetria adat hozzáadása időszakos szűréssel
  const timePeriod = req.query.analytics_period ? parseInt(req.query.analytics_period, 10) : null;
  const analyticsStats = await analytics.getAnalyticsStats(client, timePeriod);
  
  return { 
    stats,
    analytics: analyticsStats,
    dailyGeneration: await currentDailyGeneration()
  };
}));

router.get('/admin/coupons', handle('A kuponok lekérdezése', (client) => admin.listCoupons(client)));
router.post('/admin/coupons', handle('A kupon létrehozása', async (client, req, res) => {
  const coupon = await admin.createCoupon(client, req.body);
  res.status(201).json({ success: true, coupon });
}));
router.patch('/admin/coupons/:code', handle('A kupon módosítása', async (client, req) => ({ coupon: await admin.updateCoupon(client, req.params.code, req.body) })));
router.delete('/admin/coupons/:code', handle('A kupon törlése', (client, req) => admin.deleteCoupon(client, req.params.code)));
router.get('/admin/newsletter/campaigns/:id', handle('A kampány betöltése', (client, req) => newsletter.getCampaign(client, req.params.id)));

router.get('/admin/logs', handle('A rendszernapló lekérdezése', (client, req) => admin.listLogs(client, req.query)));
router.get('/admin/audit', handle('A beállítások naplójának lekérdezése', (client, req) => admin.listAudit(client, req.query)));
router.post('/admin/support/coupon', handle('A kárpótlási kupon létrehozása', async (client, req, res) => {
  const coupon = await admin.createSupportCoupon(client, req.body);
  logger.info('admin_support', 'Kárpótlási kupon létrehozva', { email: coupon.email, details: { code: coupon.code, admin: req.user?.email } });
  res.status(201).json({ success: true, coupon });
}));

router.get('/admin/orders', handle('A rendelések lekérdezése', (client, req) => admin.listOrders(client, req.query)));
// A visszaigazoló / számlaértesítő levél újraküldése: kizárólag a szerveren tárolt, fizetett rendelés vevői címére, az élőben lekért számla PDF-fel; a vevői kézbesítési számlálót nem növeli.
// A vevőnek szóló levél kiküldése a szerveren tárolt, fizetett rendelés címére; a számla PDF-et élőben kéri le a Számlázz.hu-tól. A vevői kézbesítési számlálót nem növeli.
const MISSING_PLAN_MESSAGE = 'A rendeléshez tartozó tervezet nem található az adatbázisban, csak a számla küldhető ki.';

async function loadPlanAttachments(order) {
  if (!order.documentId) throw new admin.AdminError(MISSING_PLAN_MESSAGE, 404);
  let plan;
  try {
    plan = await planStore.loadPlan(order.documentId);
  } catch (error) {
    throw new admin.AdminError(`A tervezet nem olvasható az adatbázisból: ${error.message}`, 503);
  }
  if (!plan) throw new admin.AdminError(MISSING_PLAN_MESSAGE, 404);
  try {
    return await documentExport.buildDeliveryFiles(plan);
  } catch (error) {
    throw new admin.AdminError(`A tervezetfájlok előállítása sikertelen: ${error.message}`, 500);
  }
}

async function sendOrderMail(req, { requireInvoice, templateId, withPlan = false }) {
  const order = await orderService.getByOrderNumber(String(req.params.orderNumber || '').slice(0, 40));
  if (!order) throw new admin.AdminError('A rendelés nem található.', 404);
  if (order.status !== 'paid') throw new admin.AdminError('Csak kifizetett rendelés értesítője küldhető újra.', 409);
  if (!order.email) throw new admin.AdminError('A rendeléshez nem tartozik e-mail cím.', 422);
  if (requireInvoice && !order.invoiceNumber) throw new admin.AdminError('A rendeléshez még nincs számla, előbb állítsd ki.', 409);
  if (!mailService.isConfigured()) throw new admin.AdminError('Az e-mail küldés nincs beállítva (SMTP).', 503);
  const attachments = withPlan ? await loadPlanAttachments(order) : [];
  const invoicePdf = order.invoiceNumber
    ? await invoiceService.fetchInvoicePdf({ invoiceNumber: order.invoiceNumber, billingProfile: order.billingProfile })
    : undefined;
  try {
    await mailService.sendPurchaseEmail({
      to: order.email,
      plan: order.planKey,
      orderNumber: order.orderNumber,
      attachments,
      invoicePdf,
      invoiceName: order.invoiceNumber ? `${order.invoiceNumber}.pdf` : undefined,
      invoiceNumber: order.invoiceNumber,
      title: order.title,
      planMode: order.planMode,
      documentId: order.documentId || order.orderNumber,
      templateId
    });
  } catch (error) {
    if (error.status && error.status < 500) throw new admin.AdminError(error.message, error.status);
    await orderService.recordError(order.orderNumber, 'Kézbesítés', error.message);
    throw error;
  }
  await orderService.clearError(order.orderNumber, 'Kézbesítés');
  return { sent: true, to: order.email, invoiceAttached: Boolean(invoicePdf), attachmentCount: attachments.length, template: attachments.length || !invoicePdf ? 'payment_success' : (templateId || 'invoice_only') };
}

// Teljes csomag: a Supabase-ben tárolt tervből újra előállított .docx + .pdf (heti: ZIP) és, ha van, a számla PDF.
router.post('/admin/orders/:orderNumber/resend', sendLimiter, handle('A csomag küldése', (_client, req) => sendOrderMail(req, { requireInvoice: false, withPlan: true })));
// Csak a számla PDF kiküldése (opcionális templateId: rendszer- vagy egyedi sablon, alapértelmezetten invoice_only).
router.post('/admin/orders/:orderNumber/send-invoice', sendLimiter, handle('A számla küldése', (_client, req) => {
  const templateId = req.body?.templateId === undefined || req.body?.templateId === '' ? undefined : String(req.body.templateId).slice(0, 40);
  return sendOrderMail(req, { requireInvoice: true, templateId });
}));

// Pótlólagos számlakiállítás: csak kifizetett, még számla nélküli rendeléshez (duplán nem állít ki). A kapott számlaszám az orders.invoice_number mezőbe kerül, a hibamező törlődik.
router.post('/admin/orders/:orderNumber/issue-invoice', sendLimiter, handle('A számla kiállítása', async (_client, req) => {
  const order = await orderService.getByOrderNumber(String(req.params.orderNumber || '').slice(0, 40));
  if (!order) throw new admin.AdminError('A rendelés nem található.', 404);
  try {
    const { invoiceNumber } = await orderService.issueInvoiceForOrder(order);
    return { invoiceNumber };
  } catch (error) {
    if (error.status && error.status < 500) throw new admin.AdminError(error.message, error.status);
    throw new admin.AdminError(`A számla kiállítása sikertelen: ${error.message}`, 424);
  }
}));
router.get('/admin/billing-status', handle('Az állapotjelző lekérdezése', async () => ({ status: billingStatus(process.env) })));
// A számla PDF-et élőben, memóriában kéri le a Számlázz.hu-tól és streameli; nincs fájlmentés.
router.get('/admin/orders/:orderNumber/invoice', handle('A számla letöltése', async (_client, req, res) => {
  const order = await orderService.getByOrderNumber(String(req.params.orderNumber || '').slice(0, 40));
  if (!order) throw new admin.AdminError('A rendelés nem található.', 404);
  if (order.status !== 'paid' || !order.invoiceNumber) throw new admin.AdminError('A rendeléshez nem tartozik letölthető számla.', 409);
  const pdf = await invoiceService.fetchInvoicePdf({ invoiceNumber: order.invoiceNumber, billingProfile: order.billingProfile });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(order.invoiceNumber).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
  res.send(pdf);
}));
router.get('/admin/users', handle('A felhasználók lekérdezése', (client, req) => admin.listUsers(client, req.query)));

router.post('/admin/newsletter/preview', handle('Az előnézet készítése', async (_client, req) => ({ html: await newsletter.buildPreview(req.body) })));
router.post('/admin/newsletter/send', sendLimiter, handle('A hírlevél indítása', async (client, req, res) => {
  const result = await newsletter.startCampaign(client, req.body, req.user);
  res.status(202).json({ success: true, ...result });
}));
router.get('/admin/newsletter/campaigns', handle('A kampányok lekérdezése', (client) => newsletter.listCampaigns(client)));

// Rendszerbeállítások (árak, AI, karbantartás, szezonális javaslatok) és e-mail sablonok.
router.get('/admin/settings', handle('A beállítások lekérdezése', async () => ({
  settings: await settingsService.getSettings({ force: true }),
  dailyGeneration: await currentDailyGeneration()
})));
router.get('/admin/settings/history/:key', handle('Az előzmények lekérdezése', async (client, req) => ({
  key: req.params.key,
  history: await settingsService.listHistory(client, req.params.key)
})));
router.patch('/admin/settings', handle('A beállítások mentése', async (client, req) => {
  const settings = await settingsService.updateSettings(client, req.body, req.user?.email);
  logger.info('admin_settings', 'Rendszerbeállítások módosítva', { details: { keys: Object.keys(req.body || {}), admin: req.user?.email } });
  return { settings };
}));
router.get('/admin/email-templates', handle('Az e-mail sablonok lekérdezése', async (client) => ({ templates: await settingsService.listTemplates(client) })));
router.patch('/admin/email-templates/:id', handle('Az e-mail sablon mentése', async (client, req) => {
  const template = await settingsService.updateTemplate(client, req.params.id, req.body, req.user?.email);
  logger.info('admin_settings', 'E-mail sablon módosítva', { details: { id: template.id, admin: req.user?.email } });
  return { template };
}));
router.post('/admin/email-templates', handle('Az e-mail sablon létrehozása', async (client, req, res) => {
  const template = await settingsService.createTemplate(client, req.body, req.user?.email);
  logger.info('admin_settings', 'Egyedi e-mail sablon létrehozva', { details: { id: template.id, admin: req.user?.email } });
  res.status(201).json({ success: true, template });
}));
router.post('/admin/email-templates/:id/reset', handle('A sablon alapértékre állítása', async (client, req) => {
  const template = await settingsService.resetTemplate(client, req.params.id, req.user?.email);
  logger.info('admin_settings', 'E-mail sablon alapértékre állítva', { details: { id: template.id, admin: req.user?.email } });
  return { template };
}));
router.delete('/admin/email-templates/:id', handle('Az e-mail sablon törlése', async (client, req) => {
  const result = await settingsService.deleteTemplate(client, req.params.id, req.user?.email);
  logger.info('admin_settings', 'Egyedi e-mail sablon törölve', { details: { id: result.id, admin: req.user?.email } });
  return { deleted: result.id };
}));
// Élő előnézet: a mentés nélküli szerkesztett tartalom a mentett base_layout-ba (vagy a szerkesztett base_layoutba) illesztve, mintaadatokkal.
router.post('/admin/email-templates/preview', handle('Az előnézet készítése', async (client, req) => {
  const body = req.body || {};
  const saved = Object.fromEntries((await settingsService.listTemplates(client)).map((row) => [row.id, row]));
  if (!saved[body.id]) throw new settingsService.SettingsError('Ismeretlen e-mail sablon.', 404);
  const edited = { id: body.id, subject: String(body.subject || '').slice(0, 200), bodyHtml: String(body.bodyHtml || '').slice(0, 100000) };
  const templates = { ...saved, [body.id]: edited };
  const sample = { ...mailService.layoutValues(process.env, { logoSrc: newsletter.logoDataUriOf(), unsubscribeUrl: ['payment_success', 'feedback_request', 'invoice_only'].includes(body.id) ? '' : 'https://ovitervezo.hu/leiratkozas.html?token=minta' }), content: '<p style="margin:0;color:#5b6b64;">Ide kerül a kiválasztott sablon tartalma.</p>', planLabel: 'napi tervezet', invoiceText: ' A számlát is mellékeltük.', title_block: '', order_block: '', plan_type_block: '', topic: 'Őszi erdő', orderId: 'OVI-261124-ABC123', invoiceNumber: 'OVI-2026-123', feedback_block: '', feedback_stars: '<span style="font-size:26px;color:#f59e0b;">⭐⭐⭐⭐⭐</span>', feedback_url: 'https://ovitervezo.hu/ertekeles.html', attachments_rows: '<tr><td style="padding:6px 0;font-size:15px;color:#2d3b36;">📄 <strong>Tervezet Word</strong> (.docx) formátumban</td></tr>', action_url: 'https://ovitervezo.hu/' };
  return { html: settingsService.composeEmail(templates, body.id, sample).html };
}));

module.exports = { router };
