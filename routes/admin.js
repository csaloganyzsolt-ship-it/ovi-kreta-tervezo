'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const supabase = require('../services/supabaseService');
const { requireAdmin } = require('../services/authService');
const admin = require('../services/adminService');
const newsletter = require('../services/newsletterService');
const analytics = require('../services/analyticsService');
const settingsService = require('../services/settingsService');
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
    analytics: analyticsStats
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

router.get('/admin/logs', handle('A rendszernapló lekérdezése', (client) => admin.listLogs(client)));
router.post('/admin/support/coupon', handle('A kárpótlási kupon létrehozása', async (client, req, res) => {
  const coupon = await admin.createSupportCoupon(client, req.body);
  logger.info('admin_support', 'Kárpótlási kupon létrehozva', { email: coupon.email, details: { code: coupon.code, admin: req.user?.email } });
  res.status(201).json({ success: true, coupon });
}));

router.get('/admin/orders', handle('A rendelések lekérdezése', (client, req) => admin.listOrders(client, { status: req.query.status, q: req.query.q })));
router.get('/admin/users', handle('A felhasználók lekérdezése', (client) => admin.listUsers(client)));

router.post('/admin/newsletter/preview', handle('Az előnézet készítése', async (_client, req) => ({ html: newsletter.buildPreview(req.body) })));
router.post('/admin/newsletter/send', sendLimiter, handle('A hírlevél indítása', async (client, req, res) => {
  const result = await newsletter.startCampaign(client, req.body, req.user);
  res.status(202).json({ success: true, ...result });
}));
router.get('/admin/newsletter/campaigns', handle('A kampányok lekérdezése', (client) => newsletter.listCampaigns(client)));

// Rendszerbeállítások (árak, AI, karbantartás, szezonális javaslatok) és e-mail sablonok.
router.get('/admin/settings', handle('A beállítások lekérdezése', async () => ({
  settings: await settingsService.getSettings({ force: true }),
  aiModels: settingsService.AI_MODELS
})));
router.patch('/admin/settings', handle('A beállítások mentése', async (client, req) => {
  const settings = await settingsService.updateSettings(client, req.body);
  logger.info('admin_settings', 'Rendszerbeállítások módosítva', { details: { keys: Object.keys(req.body || {}), admin: req.user?.email } });
  return { settings };
}));
router.get('/admin/email-templates', handle('Az e-mail sablonok lekérdezése', async (client) => ({ templates: await settingsService.listTemplates(client) })));
router.patch('/admin/email-templates/:id', handle('Az e-mail sablon mentése', async (client, req) => {
  const template = await settingsService.updateTemplate(client, req.params.id, req.body);
  logger.info('admin_settings', 'E-mail sablon módosítva', { details: { id: template.id, admin: req.user?.email } });
  return { template };
}));
// Élő előnézet: a mentés nélküli szerkesztett tartalom a mentett base_layout-ba (vagy a szerkesztett base_layoutba) illesztve, mintaadatokkal.
router.post('/admin/email-templates/preview', handle('Az előnézet készítése', async (client, req) => {
  const body = req.body || {};
  if (!settingsService.TEMPLATE_IDS.includes(body.id)) throw new settingsService.SettingsError('Ismeretlen e-mail sablon.', 404);
  const saved = Object.fromEntries((await settingsService.listTemplates(client)).map((row) => [row.id, row]));
  const edited = { id: body.id, subject: String(body.subject || '').slice(0, 200), bodyHtml: String(body.bodyHtml || '').slice(0, 100000) };
  const templates = { ...saved, [body.id]: edited };
  const sample = { content: '<p style="margin:0;color:#5b6b64;">Ide kerül a kiválasztott sablon tartalma.</p>', planLabel: 'napi tervezet', invoiceText: ' Az e-számlát is mellékeltük.', title_block: '', order_block: '', action_url: 'https://ovitervezo.hu/' };
  return { html: settingsService.composeEmail(templates, body.id, sample).html };
}));

module.exports = { router };
