'use strict';

const stripeService = require('./stripeService');
const invoiceService = require('./invoiceService');
const barionService = require('./barionService');
const supabaseService = require('./supabaseService');
const { getBillingProfile } = require('./siteConstants');

// Csak logikai értékeket és módokat ad: titkos kulcs vagy annak töredéke sosem kerül a válaszba.
function billingStatus(env = process.env) {
  const profile = getBillingProfile(env);
  const profiles = {};
  for (const type of ['ev', 'kft']) {
    profiles[type] = {
      stripeSecret: Boolean(stripeService.stripeSecretKey(env, type)),
      stripePublishable: Boolean(stripeService.stripePublishableKey(env, type)),
      stripeWebhook: Boolean(stripeService.stripeWebhookSecret(env, type)),
      szamlazzApiKey: Boolean(invoiceService.szamlazzApiKey(env, type)),
      barionPosKey: Boolean(barionService.posKey(env, type))
    };
  }
  return {
    profile: profile.type,
    companyName: profile.name,
    vatRate: invoiceService.vatRate(env),
    hasInvoicePrefix: invoiceService.invoicePrefix(env) !== '',
    modes: {
      barion: barionService.isTestMode(env) ? 'test' : 'live',
      szamlazz: invoiceService.isSandbox(env) ? 'sandbox' : 'live',
      stripe: stripeService.isTestMode(env) ? 'test' : 'live'
    },
    profiles,
    supabase: supabaseService.connectionStatus(env),
    keys: {
      stripePublishable: profiles[profile.type].stripePublishable,
      stripeSecret: profiles[profile.type].stripeSecret,
      stripeWebhook: profiles[profile.type].stripeWebhook,
      szamlazzApiKey: profiles[profile.type].szamlazzApiKey
    }
  };
}

module.exports = { billingStatus };
