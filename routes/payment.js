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

module.exports = { router, stripeWebhook, deliverPurchase };
