'use strict';

const express = require('express');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const mailService = require('../services/mailService');

function sendPaymentError(res, error, context) {
  const status = error.status || 500;
  if (status >= 500) console.error(`${context} failed:`, error.message);
  return res.status(status).json({ success: false, error: error.message });
}

async function createCheckout(req, res) {
  try {
    const session = await stripeService.createCheckoutSession(req.body || {});
    return res.json({ success: true, ...session });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout');
  }
}

async function verifyCheckout(req, res) {
  try {
    const result = await stripeService.retrieveCheckoutSession(req.params.id);
    return res.json({
      success: true,
      ...result,
      invoiceReady: Boolean(invoiceService.getInvoicePdf(req.params.id)),
      emailEnabled: mailService.isConfigured() && !result.mock
    });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout verification');
  }
}

async function downloadInvoice(req, res) {
  try {
    const session = await stripeService.retrieveCheckoutSession(req.params.id);
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    const pdf = invoiceService.getInvoicePdf(req.params.id);
    if (!pdf) return res.status(404).json({ success: false, error: 'A számla még készül vagy nem érhető el.' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="OviTervezo_szamla.pdf"' });
    return res.send(pdf);
  } catch (error) {
    return sendPaymentError(res, error, 'Invoice download');
  }
}

// Egyetlen közös e-mail: a böngésző által előállított tervezetfájlok + a szerveren tárolt számla PDF. Csak egyszer, csak a vásárló e-mail címére.
async function deliverPurchase(req, res) {
  try {
    const id = req.params.id;
    const session = await stripeService.retrieveCheckoutSession(id);
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    if (session.mock || !mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
    if (mailService.wasSent(id)) return res.json({ success: true, sent: false, reason: 'already_sent' });
    const invoicePdf = invoiceService.getInvoicePdf(id);
    if (!invoicePdf) return res.status(409).json({ success: false, error: 'A számla még készül, próbáld újra.' });
    if (!session.email) return res.status(422).json({ success: false, error: 'A vásárló e-mail címe nem ismert.' });
    const attachments = mailService.sanitizeAttachments(req.body?.files);
    await mailService.sendPurchaseEmail({ to: session.email, plan: session.plan, attachments, invoicePdf });
    mailService.markSent(id);
    return res.json({ success: true, sent: true });
  } catch (error) {
    return sendPaymentError(res, error, 'Purchase delivery');
  }
}

// Staging tesztkézbesítés Stripe nélkül. Csak kifejezett bekapcsolással (TEST_DELIVERY_ENABLED=true) és csak a teszt-eredetekről működik,
// IP-nként korlátozva, hogy ne lehessen levélszemét-továbbításra használni.
const TEST_ORIGINS = ['https://csaloganyzsolt-ship-it.github.io'];
const TEST_LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const TEST_LIMIT = { windowMs: 60 * 60 * 1000, max: 10 };
const testHits = new Map();

function testDeliveryAllowed(req, env = process.env) {
  if (String(env.TEST_DELIVERY_ENABLED || '').toLowerCase() !== 'true') return false;
  const origin = String(req.headers.origin || '');
  const extra = String(env.TEST_DELIVERY_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return TEST_ORIGINS.includes(origin) || extra.includes(origin) || TEST_LOCAL_ORIGIN.test(origin);
}

function testRateLimited(ip, now = Date.now()) {
  const recent = (testHits.get(ip) || []).filter((t) => now - t < TEST_LIMIT.windowMs);
  if (recent.length >= TEST_LIMIT.max) { testHits.set(ip, recent); return true; }
  recent.push(now);
  testHits.set(ip, recent);
  return false;
}

async function testDeliver(req, res) {
  try {
    console.log(`[test-deliver] Kérés beérkezett (origin: ${req.headers?.origin || '-'}, ip: ${req.ip})`);
    if (!testDeliveryAllowed(req)) return res.status(403).json({ success: false, error: 'A tesztkézbesítés ezen a környezeten nem engedélyezett.' });
    if (testRateLimited(req.ip)) return res.status(429).json({ success: false, error: 'Túl sok tesztlevél, próbáld később.' });
    if (!mailService.isConfigured()) return res.status(503).json({ success: false, error: 'Az SMTP nincs beállítva a szerveren (SMTP_HOST, SMTP_USER, SMTP_PASS).' });
    const to = String(req.body?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return res.status(400).json({ success: false, error: 'Érvénytelen e-mail cím.' });
    const allowed = String(process.env.TEST_DELIVERY_RECIPIENTS || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(to.toLowerCase())) return res.status(403).json({ success: false, error: 'Ez a cím nem szerepel a tesztcímzettek között.' });
    console.log('[test-deliver] Mellékletek ellenőrzése (DOCX/PDF/ZIP) kezdete');
    const attachments = mailService.sanitizeAttachments(req.body?.files);
    console.log(`[test-deliver] Mellékletek kész: ${attachments.map((a) => a.filename).join(', ')}`);
    await mailService.sendTestDeliveryEmail({ to, plan: req.body?.plan, attachments });
    console.log('[test-deliver] Kész, válasz a kliensnek');
    return res.json({ success: true, sent: true });
  } catch (error) {
    console.error('[test-deliver] HIBA:', error.code || '', error.message);
    return sendPaymentError(res, error, 'Test delivery');
  }
}

// A nyers törzs (express.raw) kell az aláírás ellenőrzéséhez, ezért ezt a server.js az express.json() előtt köti be.
async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (error) {
    return sendPaymentError(res, error, 'Stripe webhook');
  }

  if (event.type !== 'checkout.session.completed') return res.json({ received: true, ignored: event.type });
  const session = event.data.object;
  if (session.payment_status !== 'paid') return res.json({ received: true, ignored: 'unpaid' });

  try {
    const details = session.customer_details || {};
    const address = details.address || {};
    const result = await invoiceService.issueInvoice({
      orderId: session.id,
      plan: session.metadata?.plan,
      customer: {
        name: details.name,
        email: details.email || session.customer_email,
        zip: address.postal_code,
        city: address.city,
        address: [address.line1, address.line2].filter(Boolean).join(' ')
      }
    });
    return res.json({ received: true, invoice: result });
  } catch (error) {
    // 500: a Stripe újrapróbálja, így a sikertelen számlázás nem vész el csendben.
    console.error('Invoice generation failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

const router = express.Router();
router.post('/create-checkout-session', createCheckout);
router.get('/checkout-session/:id', verifyCheckout);
router.get('/invoice/:id', downloadInvoice);

module.exports = { router, stripeWebhook, deliverPurchase, testDeliver, testDeliveryAllowed, testRateLimited };
