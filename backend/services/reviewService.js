'use strict';

// Ügyfélértékelések: beküldés (a vásárlói levél aláírt linkjéről), publikus lista (csak jóváhagyottak) és az admin válaszlevél.
const { normalizeEmail } = require('../utils/email');
const admin = require('./adminService');
const mailService = require('./mailService');

const PUBLIC_PAGE_SIZE = 6;
const PUBLIC_MAX_PAGE_SIZE = 12;
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);

// A beküldés a rendeléshez kötődik: előbb a dokumentum-azonosító (ha az e-mail egyezik), majd a vevő legutóbbi fizetett rendelése.
async function findOrder(client, email, documentId) {
  const columns = 'id, order_number, user_email, title, document_id';
  if (documentId) {
    const { data } = await client.from('orders').select(columns).eq('document_id', documentId).limit(1);
    const match = (data || []).find((row) => normalizeEmail(row.user_email) === email);
    if (match) return match;
  }
  const { data } = await client.from('orders').select(columns).ilike('user_email', escapeLike(email)).eq('status', 'paid').order('created_at', { ascending: false }).limit(1);
  return (data || [])[0] || null;
}

async function submitReview(client, { email, rating, name, comment, documentId }) {
  const cleanEmail = normalizeEmail(email);
  const order = await findOrder(client, cleanEmail, documentId);
  const row = {
    order_id: order?.id || null,
    order_number: order?.order_number || null,
    customer_name: String(name || '').trim().slice(0, 100),
    customer_email: cleanEmail,
    plan_topic: String(order?.title || '').trim().slice(0, 200),
    rating,
    comment: String(comment || '').trim().slice(0, 3000),
    status: 'pending'
  };
  if (row.order_number) {
    const { data: existing, error: lookupError } = await client.from('reviews').select('id').eq('order_number', row.order_number).maybeSingle();
    if (lookupError) throw new admin.AdminError(`Az értékelés mentése sikertelen: ${lookupError.message}`, 500);
    if (existing) {
      const { error } = await client.from('reviews').update({ ...row, admin_reply_sent_at: null }).eq('id', existing.id);
      if (error) throw new admin.AdminError(`Az értékelés mentése sikertelen: ${error.message}`, 500);
      return { id: existing.id, orderNumber: row.order_number, updated: true };
    }
  }
  const { data, error } = await client.from('reviews').insert(row).select('id').maybeSingle();
  if (error) throw new admin.AdminError(`Az értékelés mentése sikertelen: ${error.message}`, 500);
  return { id: data?.id || null, orderNumber: row.order_number, updated: false };
}

// Publikus nézet: csak jóváhagyott sorok (legújabb elöl), lapozva; e-mail cím és rendelésszám nélkül.
async function listPublicReviews(client, { page, pageSize } = {}) {
  const size = Math.min(PUBLIC_MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || PUBLIC_PAGE_SIZE));
  const requested = Math.max(1, Number.parseInt(page, 10) || 1);
  const { data, error, count } = await client.from('reviews')
    .select('customer_name, role_label, rating, comment, created_at', { count: 'exact' })
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .range((requested - 1) * size, requested * size - 1);
  if (error) throw new admin.AdminError(`Az értékelések nem olvashatók: ${error.message}`, 500);
  const total = Number.isInteger(count) ? count : (data || []).length;
  const reviews = (data || []).map((row) => ({
    name: String(row.customer_name || '').trim() || 'Óvodapedagógus',
    role: String(row.role_label || '').trim() || 'Óvodapedagógus',
    rating: row.rating,
    comment: row.comment || '',
    createdAt: row.created_at
  }));
  return { reviews, total, page: requested, pageSize: size, totalPages: Math.max(1, Math.ceil(total / size)) };
}

async function replyToReview(client, id, { subject, message } = {}, deps = {}) {
  const review = await admin.getReview(client, id);
  const text = String(message || '').trim();
  if (!text) throw new admin.AdminError('Az üzenet szövege nem lehet üres.', 400);
  if (text.length > 5000) throw new admin.AdminError('Az üzenet legfeljebb 5000 karakter lehet.', 400);
  const result = await mailService.sendReviewReply({ to: review.customer_email, subject, message: text, orderNumber: review.order_number }, deps);
  if (!result.sent) throw new admin.AdminError('Az e-mail küldő nincs beállítva, a válasz nem ment ki.', 503);
  const sentAt = new Date().toISOString();
  const { error } = await client.from('reviews').update({ admin_reply_sent_at: sentAt }).eq('id', id);
  if (error) throw new admin.AdminError(`A válasz elment, de az időpontja nem rögzíthető: ${error.message}`, 500);
  return { replySentAt: sentAt, to: review.customer_email, orderNumber: review.order_number || '' };
}

module.exports = { submitReview, listPublicReviews, replyToReview, PUBLIC_PAGE_SIZE };
