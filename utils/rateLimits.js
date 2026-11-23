'use strict';

const { rateLimit } = require('express-rate-limit');

const HOUR_MS = 60 * 60 * 1000;

// Általános API-limit (API-lemerítés ellen): IP-nként percenként; a webhookok és a statikus fájlok nem ide tartoznak.
function createApiLimiter({ windowMs = 60 * 1000, limit = () => Number(process.env.API_RATE_LIMIT) || 120, skip } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip,
    handler: (_req, res) => res.status(429).json({ success: false, code: 'RATE_LIMITED', error: 'Túl sok kérés. Kérjük, várj egy kicsit, és próbáld újra!' })
  });
}

const DEFAULT_GENERATE_LIMIT = 20;

module.exports = { createApiLimiter, HOUR_MS, DEFAULT_GENERATE_LIMIT };
