'use strict';

const express = require('express');
const stripeService = require('../services/stripeService');
const invoiceService = require('../services/invoiceService');

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
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendPaymentError(res, error, 'Checkout verification');
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

module.exports = { router, stripeWebhook };
