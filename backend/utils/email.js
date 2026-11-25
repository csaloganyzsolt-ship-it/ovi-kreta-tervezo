'use strict';

// Minden e-mail cím mentésénél és keresésénél ez az egyetlen normalizálás él (orders, documents, profiles, coupons, newsletter, system_logs).
function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

module.exports = { normalizeEmail };
