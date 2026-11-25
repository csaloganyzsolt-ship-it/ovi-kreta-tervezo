'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const planStore = require('../services/planStore');
const profileService = require('../services/profileService');
const orderService = require('../services/orderService');
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

// A fióktörlés visszafordíthatatlan: szigorúbb limit.
const deleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => Number(process.env.ACCOUNT_DELETE_RATE_LIMIT) || 5,
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
    error: status < 500 || status === 503 ? error.message : `${context} sikertelen. Kérjük, próbáld újra később.`
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

// A felhasználó saját, fiókhoz kötött tervének végleges törlése (más tervéhez nem nyúl, és a létét sem fedi fel).
async function deleteDocument(req, res) {
  try {
    const id = String(req.params.id || '');
    if (!DOCUMENT_ID_PATTERN.test(id) || !(await planStore.deleteUserDocument(req.user, id))) {
      return res.status(404).json({ success: false, error: 'A tervezet nem található.' });
    }
    return res.json({ success: true });
  } catch (error) {
    return sendAccountError(res, error, 'A tervezet törlése');
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

// A profil (számlázási és óvodai alapadatok) olvasása.
async function getProfile(req, res) {
  try {
    return res.json({ success: true, profile: await profileService.getProfile(req.user) });
  } catch (error) {
    return sendAccountError(res, error, 'A profil lekérdezése');
  }
}

// A profil részleges mentése: csak az ismert mezők, a hiányzó kulcs változatlan marad.
async function saveProfile(req, res) {
  try {
    return res.json({ success: true, profile: await profileService.saveProfile(req.user, req.body) });
  } catch (error) {
    return sendAccountError(res, error, 'A profil mentése');
  }
}

// Feliratkozás a profilból (bejelentkezve). Leiratkozó végpont a bejelentkezett felhasználónak nincs: azt csak a levelek tokenes linkje adja.
async function subscribeNewsletter(req, res) {
  try {
    const profile = await profileService.subscribeNewsletter(req.user);
    return res.json({ success: true, newsletter_subscribed: profile.newsletter_subscribed });
  } catch (error) {
    return sendAccountError(res, error, 'A feliratkozás');
  }
}

// Nyilvános, egykattintásos leiratkozás a levelek aljáról: a newsletter_token azonosít, belépés nem kell.
async function unsubscribeNewsletter(req, res) {
  try {
    await profileService.unsubscribeNewsletter(req.body?.token);
    return res.json({ success: true });
  } catch (error) {
    return sendAccountError(res, error, 'A leiratkozás');
  }
}

async function listOrders(req, res) {
  try {
    await profileService.claimGuestRecordsSafe(req.user);
    return res.json({ success: true, orders: await orderService.listUserOrders(req.user) });
  } catch (error) {
    return sendAccountError(res, error, 'A rendelések lekérdezése');
  }
}

// Fiók végleges törlése: a kliens kifejezett megerősítést küld; a rendelések a számviteli megőrzés miatt megmaradnak.
async function deleteAccount(req, res) {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ success: false, error: 'A fiók törléséhez meg kell erősíteni a kérést.' });
    await profileService.deleteAccount(req.user);
    return res.json({ success: true });
  } catch (error) {
    return sendAccountError(res, error, 'A fiók törlése');
  }
}

const router = express.Router();
router.get('/my-documents', accountLimiter, requireUser, listDocuments);
router.get('/my-documents/:id', accountLimiter, requireUser, openDocument);
router.delete('/my-documents/:id', accountLimiter, requireUser, deleteDocument);
router.post('/sync-documents', accountLimiter, requireUser, syncDocuments);
router.get('/profile', accountLimiter, requireUser, getProfile);
router.post('/profile', accountLimiter, requireUser, saveProfile);
router.post('/newsletter/subscribe', accountLimiter, requireUser, subscribeNewsletter);
router.post('/newsletter/unsubscribe', accountLimiter, unsubscribeNewsletter);
router.get('/my-orders', accountLimiter, requireUser, listOrders);
router.post('/delete-account', deleteLimiter, requireUser, deleteAccount);

module.exports = { router, listDocuments, openDocument, deleteDocument, syncDocuments, getProfile, saveProfile, subscribeNewsletter, unsubscribeNewsletter, listOrders, deleteAccount };
