'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');
const mailService = require('../services/mailService');
const sheetsService = require('../services/sheetsService');
const planStore = require('../services/planStore');
const coupons = require('../services/coupons');
const barionService = require('../services/barionService');
const authService = require('../services/authService');

// A terv tulajdonosa: bejelentkezett felhasználó (Bearer token) vagy a vásárló e-mail címe. A fizetést nem akaszthatja meg, ha ez nem menthető.
async function recordOwner(req, generationId, rawEmail) {
  try {
    const user = await authService.optionalUser(req);
    let email = user?.email || '';
    if (!email) {
      try { email = stripeService.parseEmail(rawEmail); } catch (_error) { email = ''; }
    }
    if (user || email) await planStore.setOwner(generationId, { userId: user?.id, email });
  } catch (error) {
    console.error('[account] A tulajdonos rögzítése sikertelen:', error.message);
  }
}

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

// A Barion-indítás minden hívása külső API-t terhel.
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PAYMENT_RATE_LIMIT) || 20,
  message: { success: false, error: 'Túl sok fizetési kísérlet. Kérjük, várj egy percet.' },
  standardHeaders: true,
  legacyHeaders: false
});

function sendPaymentError(res, error, context, req) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(`${context} failed:`, error.message);
    if (context === 'Checkout' || context === 'Barion checkout') {
      mailService.sendAdminErrorAlert({
        operation: `Fizetés indítás (${context})`,
        error,
        email: req?.body?.email || req?.body?.customerEmail,
        documentId: req?.body?.generationId,
        details: { context, path: req?.originalUrl || req?.url }
      }).catch((e) => console.warn('Admin error alert failed:', e.message));
    }
  }
  return res.status(status).json({ success: false, ...(error.code === 'INVALID_COUPON' ? { code: error.code } : {}), error: error.message });
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
    if (body.generationId) await planStore.loadPlan(String(body.generationId).slice(0, 100));
    const session = await stripeService.createCheckoutSession({ ...body, planMode: planModeFor(body) });
    return res.json({ success: true, ...session });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout', req);
  }
}

// Kupon: a 100%-os kód a fizetési szolgáltatót és a számlázást megkerüli, a terv azonnal feloldódik, a kézbesítés (/api/deliver) ugyanúgy fut.
// Részleges (1–99%) kuponnál a kedvezmény a dokumentumhoz mentődik, a fizetés a csökkentett összegre indul (/api/checkout-barion).
async function applyCoupon(req, res) {
  try {
    const body = req.body || {};
    const email = stripeService.parseEmail(body.email);
    const generationId = String(body.generationId || '').slice(0, 100);
    const planData = generationId ? await planStore.loadPlan(generationId) : null;
    if (!planData) return res.status(404).json({ success: false, error: 'A tervezet már nem érhető el a szerveren. Készíts újat.' });
    await recordOwner(req, generationId, email);
    // Az már beváltott kód ugyanarra a tervre ismételten is ugyanazt a munkamenetet adja, akkor is, ha a kerete közben elfogyott.
    coupons.restoreSession(planStore.getDocumentState(generationId)?.coupon_session);
    const known = coupons.sessionFor(generationId);
    const coupon = known && known.code === coupons.normalizeCode(body.code) ? { code: known.code, percent: 100 } : await coupons.lookup(body.code);
    const planMode = planModeFor(body);
    const product = stripeService.parsePlan(body.plan, planMode);
    const discount = coupons.computeDiscount(product.amountHuf, coupon.percent);

    if (coupon.percent < 100) {
      await planStore.updateDocument(generationId, { meta: { coupon: { code: coupon.code, plan: product.key, planMode, ...discount } } });
      return res.json({ success: true, paid: false, coupon: { code: coupon.code, percent: coupon.percent }, plan: product.key, ...discount, generationId });
    }

    const session = await coupons.redeem({ code: coupon.code, generationId, email, plan: product.key, planMode, originalPrice: product.amountHuf });
    await planStore.updateDocument(generationId, { unlocked: true, meta: { coupon: { code: coupon.code, plan: product.key, planMode, ...discount }, coupon_session: session } });
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
    return sendPaymentError(res, error, 'Coupon', req);
  }
}

// Barion fizetés indítása: az összeg a mentett terv módjából (és a dokumentumhoz mentett, újraellenőrzött kuponból) jön, a documentId (generationId) az OrderNumber mezőben utazik.
async function checkoutBarion(req, res) {
  try {
    const body = req.body || {};
    const generationId = String(body.generationId || '').slice(0, 100);
    if (!generationId || !(await planStore.loadPlan(generationId))) {
      return res.status(404).json({ success: false, error: 'A tervezet már nem érhető el a szerveren, ezért nem fizethető. Készíts újat.' });
    }
    await recordOwner(req, generationId, body.email);
    const saved = planStore.getDocumentState(generationId)?.coupon;
    let coupon = null;
    if (saved && saved.percent < 100) {
      try {
        coupon = await coupons.lookup(saved.code);
      } catch (error) {
        // A már nem érvényes kupon leválik a dokumentumról, hogy a fizetés teljes áron újrapróbálható legyen.
        if (error.code === 'INVALID_COUPON') await planStore.updateDocument(generationId, { meta: { coupon: null } });
        throw error;
      }
    }
    const result = await barionService.startPayment({ ...body, generationId, planMode: planModeFor(body), coupon, req });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendPaymentError(res, error, 'Barion checkout', req);
  }
}

// Barion visszahívás (IPN): csak a paymentId-t használjuk, az állapotot a Barion API adja. Siker esetén feloldás és számla; fájlt és levelet nem a webhook küld.
async function barionWebhook(req, res) {
  const paymentId = String(req.query?.paymentId || req.query?.PaymentId || req.body?.paymentId || req.body?.PaymentId || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(paymentId)) return res.status(400).json({ success: false, error: 'Hiányzó vagy érvénytelen paymentId.' });
  try {
    const result = await barionService.handleCallback(paymentId);
    if (!result.known) return res.json({ received: true, ignored: 'unknown_payment' });
    return res.json({ received: true, status: result.status, paid: result.paid });
  } catch (error) {
    // Nem 2xx válasznál a Barion újrapróbálja a visszahívást.
    console.error('Barion webhook failed:', error.message);
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
}

// A munkamenet azonosítója alapján a megfelelő szolgáltatótól kérdez (Barion vagy Stripe); közös alakot ad vissza.
function retrieveSession(id) {
  return barionService.isSessionId(id) ? barionService.retrieveSession(id) : stripeService.retrieveCheckoutSession(id);
}

async function verifyCheckout(req, res) {
  try {
    const result = await retrieveSession(req.params.id);
    let planData = null;
    if (result.paid && result.generationId) {
      planData = await planStore.loadPlan(result.generationId);
    }
    return res.json({
      success: true,
      ...result,
      planData,
      invoiceReady: Boolean(invoiceService.getInvoicePdf(req.params.id)),
      emailEnabled: mailService.isConfigured() && !result.mock
    });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout verification', req);
  }
}

async function downloadInvoice(req, res) {
  try {
    const session = await retrieveSession(req.params.id);
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    const pdf = invoiceService.getInvoicePdf(req.params.id);
    if (!pdf) return res.status(404).json({ success: false, error: 'A számla még készül vagy nem érhető el.' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="OviTervezo_szamla.pdf"' });
    return res.send(pdf);
  } catch (error) {
    return sendPaymentError(res, error, 'Invoice download', req);
  }
}

// Egyetlen közös e-mail: a böngésző által előállított tervezetfájlok + a szerveren tárolt számla PDF. Csak egyszer, csak a vásárló e-mail címére.
async function deliverPurchase(req, res) {
  try {
    const id = req.params.id;
    const couponSession = await coupons.loadSession(id);
    if (couponSession) return await deliverCouponPurchase(req, res, couponSession);
    const session = await retrieveSession(id);
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    if (session.mock || !mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
    if (mailService.wasSent(id)) return res.json({ success: true, sent: false, reason: 'already_sent' });
    const invoicePdf = invoiceService.getInvoicePdf(id);
    if (!invoicePdf) return res.status(409).json({ success: false, error: 'A számla még készül, próbáld újra.' });
    if (!session.email) return res.status(422).json({ success: false, error: 'A vásárló e-mail címe nem ismert.' });
    const attachments = mailService.sanitizeAttachments(req.body?.files);
    await mailService.sendPurchaseEmail({
      to: session.email,
      plan: session.plan,
      orderNumber: invoiceService.orderNumber(id, session.created || new Date()),
      attachments,
      invoicePdf,
      title: req.body?.title,
      planMode: requestedPlanMode(req),
      documentId: session.generationId || id
    });
    mailService.markSent(id);
    return res.json({ success: true, sent: true });
  } catch (error) {
    return sendPaymentError(res, error, 'Purchase delivery', req);
  }
}

// Kuponos kézbesítés: nincs számla, a levél a kuponnal feloldott tervezetet küldi a megadott címre (egyszer).
async function deliverCouponPurchase(req, res, session) {
  if (!mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
  if (mailService.wasSent(session.id)) return res.json({ success: true, sent: false, reason: 'already_sent' });
  const attachments = mailService.sanitizeAttachments(req.body?.files);
  await mailService.sendPurchaseEmail({
    to: session.email,
    plan: session.plan,
    orderNumber: session.id.slice(-10).toUpperCase(),
    attachments,
    title: req.body?.title,
    planMode: session.planMode,
    documentId: session.generationId || session.id
  });
  mailService.markSent(session.id);
  return res.json({ success: true, sent: true, coupon: true });
}

// A nyers törzs (express.raw) kell az aláírás ellenőrzéséhez, ezért ezt a server.js az express.json() előtt köti be.
async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (error) {
    return sendPaymentError(res, error, 'Stripe webhook', req);
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
    mailService.sendAdminErrorAlert({
      operation: 'Számlázás (Stripe webhook)',
      error,
      email: session.customer_details?.email || session.customer_email,
      documentId: session.metadata?.generationId || session.id,
      details: { orderId: session.id, plan: session.metadata?.plan }
    }).catch((e) => console.warn('Admin error alert failed:', e.message));
    return res.status(500).json({ success: false, error: error.message });
  }
}

const router = express.Router();
router.post('/create-checkout-session', createCheckout);
router.post('/checkout-barion', paymentLimiter, checkoutBarion);
router.post('/apply-coupon', couponLimiter, applyCoupon);
router.get('/checkout-session/:id', verifyCheckout);
router.get('/invoice/:id', downloadInvoice);

module.exports = { router, stripeWebhook, barionWebhook, deliverPurchase, applyCoupon };
