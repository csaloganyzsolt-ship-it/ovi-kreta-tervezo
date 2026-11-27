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
const logger = require('../utils/logger');
const orders = require('../services/orderService');
const profileService = require('../services/profileService');
const settingsService = require('../services/settingsService');
const { getBillingProfile } = require('../services/siteConstants');

// Rendelésenként ennyiszer küldhető ki a tervezet e-mailben (kézbesítés, újraküldés ellen védve).
const MAX_DELIVERIES = 1;

// A terv tulajdonosa: bejelentkezett felhasználó (Bearer token) vagy a vásárló e-mail címe. A fizetést nem akaszthatja meg, ha ez nem menthető. A bejelentkezett felhasználót (vagy null-t) adja vissza.
async function recordOwner(req, generationId, rawEmail) {
  let user = null;
  try {
    user = await authService.optionalUser(req);
    let email = user?.email || '';
    if (!email) {
      try { email = stripeService.parseEmail(rawEmail); } catch (_error) { email = ''; }
    }
    if (user || email) await planStore.setOwner(generationId, { userId: user?.id, email });
  } catch (error) {
    console.error('[account] A tulajdonos rögzítése sikertelen:', error.message);
  }
  return user;
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
    const logContext = /delivery/i.test(context) ? 'email_delivery' : 'barion_payment';
    logger.error(logContext, `${context}: ${error.message}`, { email: req?.logEmail || req?.body?.email || req?.body?.customerEmail, details: { context, path: req?.originalUrl || req?.url } });
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
  return res.status(status).json({ success: false, ...(error.code === 'INVALID_COUPON' || error.code === 'CONSENT_REQUIRED' ? { code: error.code } : {}), error: error.message });
}

// Kézbesítési hiba a fizetett rendelésen: a hiba rögzül, a riasztás ugyanarra a hibára csak egyszer megy ki a hibariasztási címre.
async function recordDeliveryFailure(order, error, req) {
  const firstTime = await orders.recordError(order.orderNumber, 'Kézbesítés', error.message);
  if (!firstTime) return;
  mailService.sendAdminErrorAlert({
    operation: 'Kézbesítés (vevői e-mail)',
    error,
    email: order.email || req?.logEmail,
    documentId: order.documentId,
    details: { orderNumber: order.orderNumber }
  }).catch((e) => console.warn('Admin error alert failed:', e.message));
}

// A tárolt terv a mérvadó: az academic tervezet nem fizethető standard áron akkor sem, ha a kliens ezt kéri.
// 45/2014. (II. 26.) Korm. rendelet 29. § (1) m): digitális adattartalomnál a vevő kifejezett nyilatkozata nélkül nem indul fizetés; a nyilatkozat bizonyítékként a rendszernaplóba kerül.
const CONSENT_VERSION = '2026-11-27';
function requireConsent(req, body, email) {
  const consent = body.consent || {};
  if (consent.terms !== true || consent.digitalContent !== true) {
    const error = new Error('A fizetéshez el kell fogadnod az ÁSZF-et és az Adatkezelési tájékoztatót, valamint kifejezetten nyilatkoznod kell a digitális tartalom azonnali teljesítéséről és az elállási jog elvesztéséről.');
    error.status = 400;
    error.code = 'CONSENT_REQUIRED';
    throw error;
  }
  logger.info('consent', 'Fogyasztói nyilatkozat rögzítve (ÁSZF/adatkezelés elfogadása, azonnali teljesítés kérése, elállási jog elvesztése)', {
    email: String(email || '').slice(0, 200),
    details: { termsAccepted: true, immediatePerformanceRequested: true, withdrawalRightAcknowledged: true, version: CONSENT_VERSION, generationId: String(body.generationId || '').slice(0, 100), ip: req?.ip, userAgent: String(req?.get?.('user-agent') || '').slice(0, 160) }
  });
}

function planModeFor(body = {}) {
  const stored = body.generationId ? planStore.getPlan(String(body.generationId)) : null;
  if (stored) return stored.planMode === 'academic' || stored.is_thematic === true || stored.request?.planMode === 'academic' ? 'academic' : 'standard';
  return body.planMode === 'academic' ? 'academic' : 'standard';
}

async function createCheckout(req, res) {
  try {
    const body = req.body || {};
    requireConsent(req, body, body.email);
    if (body.generationId) await planStore.loadPlan(String(body.generationId).slice(0, 100));
    const planMode = planModeFor(body);
    const session = await stripeService.createCheckoutSession({ ...body, planMode });
    // A valódi Stripe-fizetés rendelése már a indításkor megvan (állapotforrás); a mock munkamenet nem kerül az adatbázisba.
    if (!session.mock) {
      const user = await recordOwner(req, String(body.generationId || '').slice(0, 100), body.email);
      await orders.createPending({
        orderNumber: orders.orderNumberFor(session.id, new Date()),
        sessionId: session.id,
        provider: 'stripe',
        providerPaymentId: session.id,
        billingProfile: getBillingProfile().type,
        userId: user?.id,
        email: stripeService.parseEmail(body.email),
        documentId: String(body.generationId || '').slice(0, 100) || undefined,
        planMode,
        planKey: session.plan,
        amount: session.amountHuf,
        title: String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined,
        paymentMethod: 'Stripe'
      });
    }
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
    const user = await recordOwner(req, generationId, email);
    // Az már beváltott kód ugyanarra a tervre ismételten is ugyanazt a munkamenetet adja, akkor is, ha a kerete közben elfogyott.
    coupons.restoreSession(planStore.getDocumentState(generationId)?.coupon_session);
    const known = coupons.sessionFor(generationId);
    const coupon = known && known.code === coupons.normalizeCode(body.code) ? { code: known.code, percent: 100 } : await coupons.lookup(body.code);
    const planMode = planModeFor(body);
    await settingsService.getSettings();
    const product = stripeService.parsePlan(body.plan, planMode);
    const discount = coupons.computeDiscount(product.amountHuf, coupon.percent);

    if (coupon.percent < 100) {
      await planStore.updateDocument(generationId, { meta: { coupon: { code: coupon.code, plan: product.key, planMode, ...discount } } });
      return res.json({ success: true, paid: false, coupon: { code: coupon.code, percent: coupon.percent }, plan: product.key, ...discount, generationId });
    }

    requireConsent(req, body, email);
    const session = await coupons.redeem({ code: coupon.code, generationId, email, plan: product.key, planMode, originalPrice: product.amountHuf });
    // Először a documents sor mentődik (feloldva), majd az orders; bármelyik hibája 5xx-ként kerül vissza, és a terv nem marad feloldva.
    const unlockMeta = { coupon: { code: coupon.code, plan: product.key, planMode, ...discount }, coupon_session: session };
    await planStore.updateDocument(generationId, { unlocked: true, meta: unlockMeta });
    try {
      await orders.markPaid({
        orderNumber: orders.orderNumberFor(session.id, session.created),
        userId: user?.id,
        sessionId: session.id,
        email: user?.email || email,
        documentId: generationId,
        planMode,
        planKey: session.plan,
        amount: 0,
        couponCode: session.code,
        paymentMethod: 'Kupon'
      });
    } catch (error) {
      await planStore.updateDocument(generationId, { unlocked: false }).catch((rollbackError) => logger.error('coupon', `A feloldás visszavonása sikertelen: ${rollbackError.message}`));
      logger.error('coupon', `A kuponos rendelés mentése sikertelen: ${error.message}`, { email, details: { generationId } });
      throw Object.assign(new Error(`A rendelés mentése sikertelen: ${error.message}`), { status: error.status || 500 });
    }
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
// Hírlevél-feliratkozás a fizetés indításakor: bejelentkezettnek a profilja, vendégnek a newsletter_guests tábla; a hibája nem állítja meg a fizetést.
async function saveCheckoutSubscription(user, body) {
  try {
    if (user) await profileService.subscribeNewsletter(user);
    else await profileService.subscribeGuest({ email: body.email, name: body.billing?.name });
  } catch (error) {
    logger.error('newsletter', `A hírlevél-feliratkozás mentése sikertelen: ${error.message}`, { email: user?.email || body.email });
  }
}

async function checkoutBarion(req, res) {
  try {
    const body = req.body || {};
    const generationId = String(body.generationId || '').slice(0, 100);
    if (!generationId || !(await planStore.loadPlan(generationId))) {
      return res.status(404).json({ success: false, error: 'A tervezet már nem érhető el a szerveren, ezért nem fizethető. Készíts újat.' });
    }
    requireConsent(req, body, body.email);
    const user = await recordOwner(req, generationId, body.email);
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
    const result = await barionService.startPayment({ ...body, generationId, planMode: planModeFor(body), coupon, user, req });
    // A már ellenőrzött számlázási adat így kitölti a következő vásárlást; a hibája nem állítja meg a fizetést.
    if (user) await profileService.rememberBilling(user, barionService.parseBilling(body.billing)).catch((error) => console.error('[profil] A számlázási adatok visszaírása sikertelen:', error.message));
    if (body.subscribeNewsletter === true) await saveCheckoutSubscription(user, body);
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
    logger.error('barion_payment', `Barion webhook sikertelen: ${error.message}`, { details: { paymentId } });
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
      invoiceReady: Boolean((await orders.getBySessionId(req.params.id))?.invoiceNumber),
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
    const order = await orders.getBySessionId(req.params.id);
    if (!order?.invoiceNumber) return res.status(404).json({ success: false, error: 'A számla még készül vagy nem érhető el.' });
    // Élő lekérés a Számlázz.hu-tól; a PDF csak memóriában utazik, fájlba nem kerül.
    const pdf = await invoiceService.fetchInvoicePdf({ invoiceNumber: order.invoiceNumber, billingProfile: order.billingProfile });
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
    if (couponSession) { req.logEmail = couponSession.email; return await deliverCouponPurchase(req, res, couponSession); }
    const session = await retrieveSession(id);
    req.logEmail = session.email;
    if (!session.paid) return res.status(402).json({ success: false, error: 'A fizetés még nem érkezett meg.' });
    if (session.mock || !mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
    const order = await orders.getBySessionId(id);
    if (!order) return res.status(404).json({ success: false, error: 'A rendelés nem található.' });
    if (order.deliveryCount >= MAX_DELIVERIES) return res.json({ success: true, sent: false, reason: 'already_sent' });
    if (!order.invoiceNumber) return res.status(409).json({ success: false, error: 'A számla még készül, próbáld újra.' });
    if (!session.email) return res.status(422).json({ success: false, error: 'A vásárló e-mail címe nem ismert.' });
    const attachments = mailService.sanitizeAttachments(req.body?.files);
    const invoicePdf = await invoiceService.fetchInvoicePdf({ invoiceNumber: order.invoiceNumber, billingProfile: order.billingProfile });
    if (!(await orders.claimDelivery(order.orderNumber, MAX_DELIVERIES))) return res.json({ success: true, sent: false, reason: 'already_sent' });
    try {
      await mailService.sendPurchaseEmail({
        to: session.email,
        plan: session.plan,
        orderNumber: order.orderNumber,
        attachments,
        invoicePdf,
        invoiceNumber: order.invoiceNumber,
        title: req.body?.title,
        planMode: requestedPlanMode(req),
        documentId: session.generationId || id
      });
    } catch (error) {
      await orders.releaseDelivery(order.orderNumber).catch((e) => console.error('[orders]', e.message));
      await recordDeliveryFailure(order, error, req);
      throw error;
    }
    await orders.clearError(order.orderNumber, 'Kézbesítés');
    return res.json({ success: true, sent: true });
  } catch (error) {
    return sendPaymentError(res, error, 'Purchase delivery', req);
  }
}

// Kuponos kézbesítés: nincs számla, a levél a kuponnal feloldott tervezetet küldi a megadott címre (egyszer).
async function deliverCouponPurchase(req, res, session) {
  if (!mailService.isConfigured()) return res.json({ success: true, sent: false, reason: 'smtp_not_configured' });
  const orderNumber = orders.orderNumberFor(session.id, session.created);
  const attachments = mailService.sanitizeAttachments(req.body?.files);
  if (!(await orders.claimDelivery(orderNumber, MAX_DELIVERIES))) return res.json({ success: true, sent: false, reason: 'already_sent' });
  try {
    await mailService.sendPurchaseEmail({
      to: session.email,
      plan: session.plan,
      orderNumber: session.id.slice(-10).toUpperCase(),
      attachments,
      title: req.body?.title,
      planMode: session.planMode,
      documentId: session.generationId || session.id
    });
  } catch (error) {
    await orders.releaseDelivery(orderNumber).catch((e) => console.error('[orders]', e.message));
    throw error;
  }
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
    await settingsService.getSettings();
    const details = session.customer_details || {};
    const address = details.address || {};
    const profileType = event.billingProfile || session.metadata?.billingProfile || getBillingProfile().type;
    const email = details.email || session.customer_email;
    const customer = {
      name: details.name,
      email,
      zip: address.postal_code,
      city: address.city,
      address: [address.line1, address.line2].filter(Boolean).join(' ')
    };
    const createdAt = session.created ? new Date(session.created * 1000) : new Date();
    const amountHuf = Number.isFinite(session.amount_total) ? Math.round(session.amount_total / 100) : undefined;
    let order = await orders.getBySessionId(session.id);
    if (!order || order.status !== 'paid') {
      order = await orders.markPaid({
        orderNumber: orders.orderNumberFor(session.id, createdAt),
        sessionId: session.id,
        provider: 'stripe',
        providerPaymentId: String(session.payment_intent || session.id),
        billingProfile: profileType,
        billing: customer,
        email,
        documentId: session.metadata?.generationId || undefined,
        planMode: session.metadata?.planMode === 'academic' ? 'academic' : 'standard',
        planKey: session.metadata?.plan,
        amount: amountHuf,
        title: session.metadata?.title || undefined,
        paymentMethod: 'Stripe',
        createdAt: createdAt.toISOString()
      });
      order = await orders.getBySessionId(session.id);
    }
    // Idempotencia: a webhook újrapróbálásakor a rendelésen már rögzített számlaszám miatt nem készül második számla.
    if (order.invoiceNumber) return res.json({ received: true, invoice: { duplicate: true, invoiceNumber: order.invoiceNumber } });

    const result = await invoiceService.issueInvoice({
      orderId: session.id,
      created: session.created,
      plan: session.metadata?.plan,
      billingProfile: order.billingProfile || profileType,
      customer
    });
    await orders.patchOrder(order.orderNumber, result.mock
      ? { invoiceStatus: 'mock' }
      : { invoiceNumber: result.invoiceNumber, invoiceStatus: 'issued', invoiceIssuedAt: new Date().toISOString() });
    if (!result.mock) await orders.clearError(order.orderNumber, 'Számlázás');
    if (!result.mock) {
      // Nem várjuk meg: a Google Táblázat hibája nem érintheti a Stripe válaszát és a vevőt.
      sheetsService.recordPurchase({ session, invoiceNumber: result.invoiceNumber, invoicePdf: result.pdf, customer }).catch(() => {});
      mailService.sendAdminNotification({
        customer: { name: details.name, email },
        plan: session.metadata?.plan,
        title: session.metadata?.title,
        orderNumber: order.orderNumber,
        invoiceNumber: result.invoiceNumber,
        invoicePdf: result.pdf
      }).catch((error) => logger.error('email_delivery', `Rendszergazdai értesítő sikertelen: ${error.message}`, { email: session.customer_details?.email, details: { orderId: session.id } }));
    }
    return res.json({ received: true, invoice: { mock: result.mock, sandbox: result.sandbox, invoiceNumber: result.invoiceNumber } });
  } catch (error) {
    // 500: a Stripe újrapróbálja, így a sikertelen számlázás nem vész el csendben. A rendelés fizetett marad, a hiba rögzül, a riasztás ugyanarra a hibára csak egyszer megy.
    console.error('Invoice generation failed:', error.message);
    logger.error('barion_payment', `Számlázás sikertelen (Stripe webhook): ${error.message}`, { email: session.customer_details?.email || session.customer_email, details: { orderId: session.id } });
    const failedOrderNumber = orders.orderNumberFor(session.id, session.created ? new Date(session.created * 1000) : new Date());
    const firstTime = await orders.recordError(failedOrderNumber, 'Számlázás', error.message);
    if (firstTime) {
      mailService.sendAdminErrorAlert({
        operation: 'Számlázás (Stripe webhook)',
        error,
        email: session.customer_details?.email || session.customer_email,
        documentId: session.metadata?.generationId || session.id,
        details: { orderId: session.id, orderNumber: failedOrderNumber, plan: session.metadata?.plan }
      }).catch((e) => console.warn('Admin error alert failed:', e.message));
    }
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
