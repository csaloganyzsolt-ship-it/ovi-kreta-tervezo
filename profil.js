// Felhasználói portál (profil.html): profil és számlázási adatok, dokumentumok, rendeléstörténet, fióktörlés.
// Klasszikus script (nem ES modul). A kéréseket az auth.js által adott OviAuth.apiFetch küldi a bejelentkezett felhasználó tokenjével.
(function () {
  'use strict';

  const PROFILE_FIELDS = {
    full_name: 'profileFullName',
    kindergarten_name: 'profileKindergarten',
    group_name: 'profileGroup',
    billing_name: 'profileBillingName',
    billing_zip: 'profileBillingZip',
    billing_city: 'profileBillingCity',
    billing_address: 'profileBillingAddress',
    billing_tax_id: 'profileBillingTaxId'
  };
  const PLAN_LABELS = {
    daily: 'Napi tervezet',
    weekly: 'Heti alapcsomag',
    weekly_detailed: 'Heti részletes csomag',
    academic_daily: 'Oktatási célú napi tervezet',
    academic_weekly: 'Oktatási célú heti tematikus terv'
  };
  const ORDER_STATUS_LABELS = { pending: 'Függőben', paid: 'Fizetve', failed: 'Sikertelen', cancelled: 'Megszakítva' };
  const ZIP_PATTERN = /^[0-9A-Za-z][0-9A-Za-z -]{2,9}$/;

  const auth = window.OviAuth;
  const loaded = { documents: false, orders: false };

  function byId(id) { return document.getElementById(id); }

  function show(id) {
    ['profileLoading', 'profileGate', 'profileApp', 'profileDeleted'].forEach((section) => { byId(section).hidden = section !== id; });
  }

  function setText(id, message) {
    const el = byId(id);
    el.textContent = message || '';
    el.hidden = !message;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatAmount(value) {
    return `${Number(value || 0).toLocaleString('hu-HU')} Ft`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function badge(text, paid) {
    return el('span', `profile-badge${paid ? ' is-paid' : ''}`, text);
  }

  function emptyItem(message) {
    const li = el('li');
    li.appendChild(el('div', 'profile-empty', message));
    return li;
  }

  // ---------- Profil ----------

  function fillProfile(profile) {
    byId('profileEmail').textContent = profile.email || '';
    byId('profileEmailField').value = profile.email || '';
    Object.entries(PROFILE_FIELDS).forEach(([key, id]) => { byId(id).value = profile[key] || ''; });
    renderNewsletter(profile.newsletter_subscribed === true);
  }

  // Hírlevél: csak feliratkozás van; feliratkozva csak státusz látszik (a leiratkozás a levelek alján lévő link).
  function renderNewsletter(subscribed) {
    byId('newsletterBlock').hidden = false;
    byId('newsletterOff').hidden = subscribed;
    byId('newsletterOn').hidden = !subscribed;
  }

  async function subscribeNewsletter() {
    setText('newsletterError', '');
    const button = byId('newsletterSubscribe');
    button.disabled = true;
    try {
      const data = await auth.apiFetch('/api/newsletter/subscribe', { method: 'POST' });
      renderNewsletter(data.newsletter_subscribed === true);
    } catch (error) {
      setText('newsletterError', `A feliratkozás sikertelen: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function readProfileForm() {
    const clean = (id) => byId(id).value.replace(/\s+/g, ' ').trim();
    const values = {};
    Object.entries(PROFILE_FIELDS).forEach(([key, id]) => { values[key] = clean(id); });
    return values;
  }

  function validateProfile(values) {
    if (values.billing_zip && !ZIP_PATTERN.test(values.billing_zip)) return 'Az irányítószám érvénytelen.';
    const anyBilling = values.billing_name || values.billing_zip || values.billing_city || values.billing_address;
    if (anyBilling && (values.billing_name.length < 2 || !values.billing_zip || values.billing_city.length < 2 || values.billing_address.length < 3)) {
      return 'A számlázási adatokat teljesen töltsd ki (név, irányítószám, település, utca, házszám), vagy hagyd üresen mindet.';
    }
    return '';
  }

  async function saveProfile(event) {
    event.preventDefault();
    setText('profileStatus', '');
    setText('profileError', '');
    const values = readProfileForm();
    const problem = validateProfile(values);
    if (problem) {
      setText('profileError', problem);
      return;
    }
    const button = byId('profileSave');
    button.disabled = true;
    try {
      const data = await auth.apiFetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      fillProfile(data.profile);
      setText('profileStatus', 'Az adatok mentve.');
    } catch (error) {
      setText('profileError', `A mentés sikertelen: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Dokumentumok ----------

  function renderDocuments(documents) {
    const list = byId('documentsList');
    list.replaceChildren();
    if (!documents.length) {
      list.appendChild(emptyItem('A fiókodhoz még nem tartozik mentett tervezet.'));
      return;
    }
    documents.forEach((doc) => {
      const li = el('li', 'profile-item');
      const main = el('div', 'profile-item-main');
      main.appendChild(el('strong', 'profile-item-title', doc.title));
      const meta = el('div', 'profile-item-meta');
      meta.appendChild(el('span', '', formatDate(doc.createdAt)));
      meta.appendChild(badge(doc.duration === 'Heti' ? 'Heti' : 'Napi', false));
      meta.appendChild(doc.unlocked ? badge('Fizetve', true) : badge('Piszkozat (csak előnézet)', false));
      main.appendChild(meta);
      li.appendChild(main);
      const actions = el('div', 'profile-item-meta');
      const base = `tervezo.html?open=${encodeURIComponent(doc.id)}`;
      const link = (label, href, primary) => {
        const a = el('a', `profile-btn${primary ? ' primary' : ''}`, label);
        a.href = href;
        return a;
      };
      actions.appendChild(link('Megnyitás', base, true));
      if (doc.unlocked) {
        actions.appendChild(link('Word', `${base}&download=docx`, false));
        actions.appendChild(link('PDF', `${base}&download=pdf`, false));
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  async function loadDocuments() {
    const list = byId('documentsList');
    list.replaceChildren(emptyItem('Dokumentumok betöltése...'));
    try {
      const data = await auth.apiFetch('/api/my-documents');
      renderDocuments(Array.isArray(data.documents) ? data.documents : []);
      loaded.documents = true;
    } catch (error) {
      list.replaceChildren(emptyItem(`A dokumentumok nem tölthetők be: ${error.message}`));
    }
  }

  // ---------- Rendelések ----------

  function renderOrders(orders) {
    const list = byId('ordersList');
    list.replaceChildren();
    if (!orders.length) {
      list.appendChild(emptyItem('Még nincs rendelésed.'));
      return;
    }
    orders.forEach((order) => {
      const li = el('li', 'profile-item');
      const main = el('div', 'profile-item-main');
      main.appendChild(el('strong', 'profile-item-title', PLAN_LABELS[order.planKey] || (order.planMode === 'academic' ? 'Oktatási célú tervezet' : 'Óvodai tervezet')));
      const meta = el('div', 'profile-item-meta');
      meta.appendChild(el('span', '', formatDate(order.createdAt)));
      meta.appendChild(el('span', '', `Rendelésszám: ${order.orderNumber}`));
      if (order.invoiceNumber) meta.appendChild(el('span', '', `Számla: ${order.invoiceNumber}`));
      if (order.couponCode) meta.appendChild(el('span', '', `Kupon: ${order.couponCode}`));
      main.appendChild(meta);
      li.appendChild(main);
      const side = el('div', 'profile-item-meta');
      side.appendChild(el('strong', '', formatAmount(order.amount)));
      side.appendChild(badge(ORDER_STATUS_LABELS[order.status] || order.status, order.status === 'paid'));
      li.appendChild(side);
      list.appendChild(li);
    });
  }

  async function loadOrders() {
    const list = byId('ordersList');
    list.replaceChildren(emptyItem('Rendelések betöltése...'));
    try {
      const data = await auth.apiFetch('/api/my-orders');
      renderOrders(Array.isArray(data.orders) ? data.orders : []);
      loaded.orders = true;
    } catch (error) {
      list.replaceChildren(emptyItem(`A rendelések nem tölthetők be: ${error.message}`));
    }
  }

  // ---------- Fülek ----------

  function selectTab(name) {
    document.querySelectorAll('[data-profile-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.dataset.profileTab === name ? 'true' : 'false');
    });
    byId('panelProfile').hidden = name !== 'profile';
    byId('panelDocuments').hidden = name !== 'documents';
    byId('panelOrders').hidden = name !== 'orders';
    if (name === 'documents' && !loaded.documents) loadDocuments();
    if (name === 'orders' && !loaded.orders) loadOrders();
  }

  // ---------- Fióktörlés ----------

  async function deleteAccount() {
    setText('deleteError', '');
    const button = byId('deleteConfirm');
    button.disabled = true;
    try {
      await auth.apiFetch('/api/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
      });
    } catch (error) {
      setText('deleteError', `A fiók törlése sikertelen: ${error.message}`);
      button.disabled = false;
      return;
    }
    // A felhasználó már törölve van: előbb a végső állapotot mutatjuk, hogy a kijelentkezés ne a belépési kaput jelenítse meg.
    button.disabled = false;
    if (typeof closeModals === 'function') closeModals();
    show('profileDeleted');
    // A törölt felhasználó tokenje a lejártáig érvényes marad, ezért a böngészőből is kilépünk (csak helyi munkamenet-törlés).
    try {
      await auth.signOut('local');
    } catch (error) {
      console.error('[profil] A kijelentkezés a törlés után sikertelen:', error.message);
    }
  }

  // ---------- Indítás ----------

  async function showForUser() {
    const user = auth.getUser();
    if (!user) {
      byId('profileGateText').textContent = auth.isAvailable()
        ? 'A profil, a rendeléstörténet és a mentett tervezeteid eléréséhez jelentkezz be.'
        : 'A fiókkezelés ezen a kiszolgálón jelenleg nem érhető el.';
      byId('profileLogin').hidden = !auth.isAvailable();
      show('profileGate');
      return;
    }
    show('profileApp');
    byId('profileEmail').textContent = user.email;
    byId('profileEmailField').value = user.email;
    loaded.documents = false;
    loaded.orders = false;
    try {
      fillProfile((await auth.apiFetch('/api/profile')).profile);
    } catch (error) {
      setText('profileError', `A profil nem tölthető be: ${error.message}`);
    }
    selectTab('profile');
  }

  function init() {
    byId('profileForm').addEventListener('submit', saveProfile);
    byId('newsletterSubscribe').addEventListener('click', subscribeNewsletter);
    document.querySelectorAll('[data-profile-tab]').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.profileTab)));
    byId('profileLogin').addEventListener('click', () => auth.openModal('login'));
    byId('profileLogout').addEventListener('click', async () => {
      try {
        await auth.signOut();
      } catch (error) {
        setText('profileError', `A kijelentkezés sikertelen: ${error.message}`);
      }
    });
    byId('deleteOpen').addEventListener('click', () => {
      setText('deleteError', '');
      openModal('deleteModal');
    });
    byId('deleteConfirm').addEventListener('click', deleteAccount);
    // A belépés/kilépés azonnal frissíti az oldalt; a törlés utáni állapotot nem írjuk felül.
    document.addEventListener('ovi-auth-change', () => {
      if (!byId('profileDeleted').hidden) return;
      showForUser();
    });
    auth.ready.then(() => {
      if (byId('profileDeleted').hidden && byId('profileApp').hidden) showForUser();
    });
  }

  if (!auth) {
    document.getElementById('profileLoading').textContent = 'A fiókkezelés nem tölthető be.';
    return;
  }
  init();
})();
