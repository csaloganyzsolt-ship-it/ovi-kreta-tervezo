'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const planStore = require('../services/planStore');
const { requireUser } = require('../services/authService');

const MAX_SYNC_IDS = 50;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const accountLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Number(process.env.ACCOUNT_RATE_LIMIT) || 60,
  message: { success: false, error: 'Túl sok kérés. Kérjük, várj egy percet.' },
  standardHeaders: true,
  legacyHeaders: false
});

function sendAccountError(res, error, context) {
  const status = error.status || 500;
  if (status >= 500) console.error(`${context} failed:`, error.message);
  return res.status(status).json({
    success: false,
    ...(error.code ? { code: error.code } : {}),
    error: status === 503 ? error.message : `${context} sikertelen. Kérjük, próbáld újra később.`
  });
}

// A felhasználó tervei (hozzárendelt vagy az e-mail címére megvásárolt, feloldott), újabbak elöl.
async function listDocuments(req, res) {
  try {
    const documents = await planStore.listUserDocuments(req.user);
    return res.json({ success: true, documents });
  } catch (error) {
    return sendAccountError(res, error, 'A mentett tervek lekérdezése');
  }
}

// Egy terv megnyitása: feloldott tervnél a teljes tartalom, zároltnál a tartalom nélküli tükörterv (a feloldás a fizetéssel történik).
async function openDocument(req, res) {
  try {
    const id = String(req.params.id || '');
    if (!DOCUMENT_ID_PATTERN.test(id)) return res.status(404).json({ success: false, error: 'A tervezet nem található.' });
    const doc = await planStore.getUserDocument(req.user, id);
    if (!doc) return res.status(404).json({ success: false, error: 'A tervezet nem található.' });
    if (doc.unlocked) return res.json({ success: true, unlocked: true, plan: { ...doc.plan, generationId: doc.id } });
    const mirror = planStore.createMirrorPlan(doc.plan);
    mirror.generationId = doc.id;
    return res.json({ success: true, unlocked: false, plan: mirror });
  } catch (error) {
    return sendAccountError(res, error, 'A tervezet megnyitása');
  }
}

// A böngésző helyi tervazonosítóinak fiókhoz kötése; csak a még gazdátlan (user_id nélküli) tervek kerülnek át.
async function syncDocuments(req, res) {
  try {
    const raw = req.body?.documentIds;
    if (!Array.isArray(raw)) return res.status(400).json({ success: false, error: 'A documentIds tömb megadása kötelező.' });
    const ids = [...new Set(raw.filter((id) => typeof id === 'string' && DOCUMENT_ID_PATTERN.test(id)))].slice(0, MAX_SYNC_IDS);
    const claimed = ids.length ? await planStore.claimDocuments(req.user, ids) : [];
    return res.json({ success: true, claimed });
  } catch (error) {
    return sendAccountError(res, error, 'A tervek szinkronizálása');
  }
}

const router = express.Router();
router.get('/my-documents', accountLimiter, requireUser, listDocuments);
router.get('/my-documents/:id', accountLimiter, requireUser, openDocument);
router.post('/sync-documents', accountLimiter, requireUser, syncDocuments);

module.exports = { router, listDocuments, openDocument, syncDocuments };
