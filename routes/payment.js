'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const mailService = require('../services/mailService');
const sheetsService = require('../services/sheetsService');
const planStore = require('../services/planStore');
const coupons = require('../services/coupons');

// A levél sablonját a kliens jelzi; csak az ismert érték fogadható el.
function requestedPlanMode(req) {
  return req.body?.planMode === 'academic' ? 'academic' : 'standard';
}

// A kódtalálgatás ellen: IP-nként percenként legfeljebb 10 beváltási kísérlet.
const couponLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.COUPON_RATE_LIMIT) || 10,
  message: { success: false, error: 'Túl sok kuponkísérlet. Kérjük, várj egy percet.' },
  standardHeaders: true,
  legacyHeaders: false
});

function sendPaymentError(res, error, context) {
  const status = error.status || 500;
  if (status >= 500) console.error(`${context} failed:`, error.message);
  return res.status(status).json({ success: false, error: error.message });
}

// A tárolt terv a mérvadó: az academic tervezet nem fizethető standard áron akkor sem, ha a kliens ezt kéri.
function planModeFor(body = {}) {
  const stored = body.generationId ? planStore.getPlan(String(body.generationId)) : null;
  if (stored) return stored.planMode === 'academic' || stored.is_thematic === true || stored.request?.planMode === 'academic' ? 'academic' : 'standard';
  return body.planMode === 'academic' ? 'academic' : 'standard';
}

async function createCheckout(req, res) {
  try {
    const body = req.body || {};
    const session = await stripeService.createCheckoutSession({ ...body, planMode: planModeFor(body) });
    return res.json({ success: true, ...session });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout');
  }
}

// 100%-os belső kupon: a fizetési szolgáltatót és a számlázást megkerüli, a terv azonnal feloldódik, a kézbesítés (/api/deliver) ugyanúgy fut.
function applyCoupon(req, res) {
  try {
    const body = req.body || {};
    const email = stripeService.parseEmail(body.email);
    if (!coupons.isValidCode(body.code)) return res.status(400).json({ success: false, code: 'INVALID_COUPON', error: 'Érvénytelen kuponkód.' });
    const generationId = String(body.generationId || '').slice(0, 100);
    const planData = generationId ? planStore.getPlan(generationId) : null;
    if (!planData) return res.status(404).json({ success: false, error: 'A tervezet már nem érhető el a szerveren. Készíts újat.' });
    const planMode = planModeFor(body);
    const product = stripeService.parsePlan(body.plan, planMode);
    const session = coupons.redeem({ code: body.code, generationId, email, plan: product.key, planMode });
    return res.json({
      success: true,
      paid: true,
      coupon: { code: session.code, percent: session.percent },
      sessionId: session.id,
      plan: session.plan,
      generationId,
      planData,
      emailEnabled: mailService.isConfigured()
    });
  } catch (error) {
    return sendPaymentError(res, error, 'Coupon');
  }
}

// A Barion fizetés backendje a következő lépésben készül; addig kulturált 501 válasz.
function checkoutBarion(_req, res) {
  return res.status(501).json({ success: false, code: 'BARION_NOT_IMPLEMENTED', error: 'A Barion fizetés hamarosan indul!' });
}

async function verifyCheckout(req, res) {
  try {
    const result = await stripeService.retrieveCheckoutSession(req.params.id);
    let planData = null;
    if (result.paid && result.generationId) {
      planData = planStore.getPlan(result.generationId);
    }
    return res.json({
      success: true,
      ...result,
      planData,
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
    const couponSession = coupons.getSession(id);
    if (couponSession) return await deliverCouponPurchase(req, res, couponSession);
    const session = await stripeService.retrieveCheckoutSession(id);
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    if (session.mock || !mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
    if (mailService.wasSent(id)) return res.json({ success: true, sent: false, reason: 'already_sent' });
    const invoicePdf = invoiceService.getInvoicePdf(id);
    if (!invoicePdf) return res.status(409).json({ success: false, error: 'A számla még készül, próbáld újra.' });
    if (!session.email) return res.status(422).json({ success: false, error: 'A vásárló e-mail címe nem ismert.' });
    const attachments = mailService.sanitizeAttachments(req.body?.files);
    await mailService.sendPurchaseEmail({ to: session.email, plan: session.plan, orderNumber: invoiceService.orderNumber(id, session.created || new Date()), attachments, invoicePdf, title: req.body?.title, planMode: requestedPlanMode(req) });
    mailService.markSent(id);
    return res.json({ success: true, sent: true });
  } catch (error) {
    return sendPaymentError(res, error, 'Purchase delivery');
  }
}

// Kuponos kézbesítés: nincs számla, a levél a kuponnal feloldott tervezetet küldi a megadott címre (egyszer).
async function deliverCouponPurchase(req, res, session) {
  if (!mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
  if (mailService.wasSent(session.id)) return res.json({ success: true, sent: false, reason: 'already_sent' });
  const attachments = mailService.sanitizeAttachments(req.body?.files);
  await mailService.sendPurchaseEmail({ to: session.email, plan: session.plan, orderNumber: session.id.slice(-10).toUpperCase(), attachments, title: req.body?.title, planMode: session.planMode });
  mailService.markSent(session.id);
  return res.json({ success: true, sent: true, coupon: true });
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
      created: session.created,
      plan: session.metadata?.plan,
      customer: {
        name: details.name,
        email: details.email || session.customer_email,
        zip: address.postal_code,
        city: address.city,
        address: [address.line1, address.line2].filter(Boolean).join(' ')
      }
    });
    if (!result.duplicate && !result.mock) {
      // Nem várjuk meg: a Google Táblázat hibája nem érintheti a Stripe válaszát és a vevőt.
      sheetsService.recordPurchase({ session, invoiceNumber: result.invoiceNumber, invoicePdf: invoiceService.getInvoicePdf(session.id), customer: { name: details.name, email: details.email || session.customer_email, zip: address.postal_code, city: address.city, address: [address.line1, address.line2].filter(Boolean).join(' ') } }).catch(() => {});
    }
    if (!result.duplicate && !result.mock) {
      mailService.sendAdminNotification({
        customer: { name: details.name, email: details.email || session.customer_email },
        plan: session.metadata?.plan,
        title: session.metadata?.title,
        orderNumber: invoiceService.orderNumber(session.id, session.created ? new Date(session.created * 1000) : new Date()),
        invoiceNumber: result.invoiceNumber,
        invoicePdf: invoiceService.getInvoicePdf(session.id)
      }).catch((error) => console.error('[mail] Rendszergazdai értesítő sikertelen:', error.message));
    }
    return res.json({ received: true, invoice: result });
  } catch (error) {
    // 500: a Stripe újrapróbálja, így a sikertelen számlázás nem vész el csendben.
    console.error('Invoice generation failed:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

const router = express.Router();
router.post('/create-checkout-session', createCheckout);
router.post('/checkout-barion', checkoutBarion);
router.post('/apply-coupon', couponLimiter, applyCoupon);
router.get('/checkout-session/:id', verifyCheckout);
router.get('/invoice/:id', downloadInvoice);

module.exports = { router, stripeWebhook, deliverPurchase, applyCoupon };
