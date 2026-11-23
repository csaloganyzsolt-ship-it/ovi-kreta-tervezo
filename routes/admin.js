'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const supabase = require('../services/supabaseService');
const { requireAdmin } = require('../services/authService');
const admin = require('../services/adminService');
const newsletter = require('../services/newsletterService');
const analytics = require('../services/analyticsService');
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

module.exports = { router };
