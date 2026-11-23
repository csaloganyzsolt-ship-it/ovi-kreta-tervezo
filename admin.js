// Admin Központ (admin.html): statisztika, kuponkezelő, rendelések, felhasználók és hírlevélküldő.
// Klasszikus script (nem ES modul). Az oldal tartalma csak akkor jelenik meg, ha a szerver az /api/admin/me hívásra megerősíti az admin jogot;
// különben azonnal a főoldalra irányítunk, érzékeny adat betöltése nélkül.
(function () {
  'use strict';

  const ORDER_STATUS_LABELS = { pending: 'Függőben', paid: 'Fizetve', failed: 'Sikertelen', cancelled: 'Megszakítva' };
  const PLAN_LABELS = {
    daily: 'Napi tervezet',
    weekly: 'Heti alapcsomag',
    weekly_detailed: 'Heti részletes csomag',
    academic_daily: 'Oktatási célú napi tervezet',
    academic_weekly: 'Oktatási célú heti tematikus terv'
  };
  const RECIPIENT_LABELS = { test: 'Teszt', subscribers: 'Összes feliratkozó', custom: 'Egyedi lista' };
  const PREVIEW_DELAY_MS = 350;
  const SEARCH_DELAY_MS = 300;
  const POLL_MS = 3000;

  const auth = window.OviAuth;
  const loaded = {};
  let ordersRequest = 0;
  let previewTimer = null;
  let searchTimer = null;
  let pollTimer = null;
  let users = [];

  function byId(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(id, message) {
    const node = byId(id);
    node.textContent = message || '';
    node.hidden = !message;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function formatAmount(value) {
    return `${Number(value || 0).toLocaleString('hu-HU')} Ft`;
  }

  function errorMessage(error) {
    return error?.message || 'Ismeretlen hiba.';
  }

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    return auth.apiFetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  }

  // ---------- CSV ----------

  // Excel-barát CSV (pontosvessző, BOM). A képletként értelmezhető cellák elé aposztróf kerül (CSV-injekció ellen).
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(rows) {
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
  }

  function downloadCsv(filename, rows) {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- Táblázat-segédek ----------

  function fillTable(tableId, rows, columns, emptyText) {
    const body = byId(tableId).tBodies[0];
    body.replaceChildren();
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'admin-empty', emptyText);
      td.colSpan = columns;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((cells) => {
      const tr = el('tr');
      cells.forEach((cell) => {
        const td = el('td');
        if (cell instanceof Node) td.appendChild(cell); else td.textContent = cell;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  const yesNo = (value) => (value ? 'Igen' : 'Nem');

  // ---------- 1. Áttekintés ----------

  async function loadStats() {
    setText('overviewError', '');
    try {
      const analyticsPeriod = byId('analyticsPeriod').value;
      const params = analyticsPeriod ? `?analytics_period=${analyticsPeriod}` : '';
      const { stats, analytics } = await api(`/api/admin/stats${params}`);
      byId('kpiRevenueTotal').textContent = formatAmount(stats.revenue.total);
      byId('kpiRevenue30').textContent = formatAmount(stats.revenue.last30Days);
      byId('kpiOrders').textContent = String(stats.paidOrders);
      byId('kpiUsers').textContent = String(stats.registeredUsers);
      byId('kpiSubscribers').textContent = String(stats.confirmedSubscribers);
      byId('docTotal').textContent = String(stats.documents.total);
      byId('docStandard').textContent = String(stats.documents.breakdown.standard);
      byId('docAcademic').textContent = String(stats.documents.breakdown.academic);
      byId('docWeekly').textContent = String(stats.documents.breakdown.weekly);
      byId('docConversion').textContent = `${String(stats.documents.conversionRate).replace('.', ',')}%`;

      // Telemetria statisztikák
      if (analytics) {
        byId('analyticsTotal').textContent = String(analytics.total_events);
        byId('analyticsFunnelPageView').textContent = String(analytics.funnel.page_views);
        byId('analyticsFunnelGeneratorStarted').textContent = String(analytics.funnel.generator_started);
        byId('analyticsFunnelGenerated').textContent = String(analytics.funnel.document_generated);
        byId('analyticsFunnelPaywall').textContent = String(analytics.funnel.paywall_opened);
        byId('analyticsDownloadDocx').textContent = String(analytics.downloads.docx);
        byId('analyticsDownloadPdf').textContent = String(analytics.downloads.pdf);

        // Eszközmegoszlás
        byId('deviceMobile').textContent = `${analytics.devices.mobile}%`;
        byId('deviceTablet').textContent = `${analytics.devices.tablet}%`;
        byId('deviceDesktop').textContent = `${analytics.devices.desktop}%`;

        // Top témakörök
        const topicsRows = (analytics.top_topics || []).map((t) => [t.name, String(t.count)]);
        fillTable('topicsTable', topicsRows, 2, 'Nincsenek adatok');

        // Top korcsoportok
        const ageGroupsRows = (analytics.top_age_groups || []).map((a) => [a.name, String(a.count)]);
        fillTable('ageGroupsTable', ageGroupsRows, 2, 'Nincsenek adatok');

        // Top referrerek
        const referrersRows = (analytics.top_referrers || []).map((r) => [r.domain || '(közvetlen)', String(r.count)]);
        fillTable('referrersTable', referrersRows, 2, 'Nincsenek adatok');
      }
    } catch (error) {
      setText('overviewError', `A statisztika nem tölthető be: ${errorMessage(error)}`);
    }
  }

  // Telemetria időszak szűrő event listener
  byId('analyticsPeriod')?.addEventListener('change', loadStats);

  // ---------- 2. Kuponok ----------

  function couponSwitch(coupon) {
    const button = el('button', 'admin-switch');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', coupon.isActive ? 'true' : 'false');
    button.setAttribute('aria-label', `${coupon.code} kupon ${coupon.isActive ? 'kikapcsolása' : 'bekapcsolása'}`);
    button.textContent = coupon.isActive ? 'Aktív' : 'Inaktív';
    button.addEventListener('click', async () => {
      button.disabled = true;
      setText('couponsError', '');
      try {
        await api(`/api/admin/coupons/${encodeURIComponent(coupon.code)}`, { method: 'PATCH', body: { is_active: !coupon.isActive } });
        await loadCoupons();
      } catch (error) {
        button.disabled = false;
        setText('couponsError', `A kupon nem módosítható: ${errorMessage(error)}`);
      }
    });
    return button;
  }

  async function loadCoupons() {
    setText('couponsError', '');
    try {
      const { coupons, redemptions } = await api('/api/admin/coupons');
      fillTable('couponsTable', coupons.map((coupon) => [
        coupon.code,
        `${coupon.discountPercent}%`,
        coupon.maxUses ? `${coupon.uses} / ${coupon.maxUses}` : `${coupon.uses} / korlátlan`,
        formatAmount(coupon.totalDiscount),
        coupon.validUntil ? formatDate(coupon.validUntil) : 'Nincs lejárat',
        coupon.note || '',
        couponSwitch(coupon)
      ]), 7, 'Még nincs kupon.');
      fillTable('redemptionsTable', redemptions.map((row) => [
        formatDate(row.usedAt), row.code, row.email || '–', PLAN_LABELS[row.planMode] || row.planMode || '–',
        formatAmount(row.originalPrice), formatAmount(row.discountAmount), formatAmount(row.finalPrice)
      ]), 7, 'Még nem váltottak be kupont.');
    } catch (error) {
      setText('couponsError', `A kuponok nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  async function submitCoupon(event) {
    event.preventDefault();
    setText('couponStatus', '');
    setText('couponError', '');
    const body = {
      code: byId('couponCode').value.trim(),
      discount_percent: byId('couponPercent').value.trim(),
      max_uses: byId('couponMaxUses').value.trim() || null,
      valid_until: byId('couponValidUntil').value || null,
      note: byId('couponNote').value.trim()
    };
    const button = byId('couponSave');
    button.disabled = true;
    try {
      const { coupon } = await api('/api/admin/coupons', { method: 'POST', body });
      byId('couponForm').reset();
      setText('couponStatus', `A(z) ${coupon.code} kupon létrejött.`);
      await loadCoupons();
    } catch (error) {
      setText('couponError', errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  // ---------- 3. Rendelések ----------

  let lastOrders = [];

  async function loadOrders() {
    const request = ++ordersRequest;
    setText('ordersError', '');
    const params = new URLSearchParams();
    if (byId('ordersStatus').value) params.set('status', byId('ordersStatus').value);
    if (byId('ordersSearch').value.trim()) params.set('q', byId('ordersSearch').value.trim());
    try {
      const data = await api(`/api/admin/orders${params.toString() ? `?${params}` : ''}`);
      if (request !== ordersRequest) return;
      lastOrders = data.orders;
      fillTable('ordersTable', data.orders.map((order) => {
        const buyer = el('span');
        buyer.textContent = order.name ? `${order.name} (${order.email || '–'})` : order.email || '–';
        return [
          formatDate(order.createdAt), buyer, PLAN_LABELS[order.planKey] || order.planKey || '–', formatAmount(order.amount),
          order.couponCode || '–', ORDER_STATUS_LABELS[order.status] || order.status, order.invoiceNumber || '–'
        ];
      }), 7, 'Nincs a szűrésnek megfelelő rendelés.');
      byId('ordersCount').textContent = `${data.orders.length} rendelés${data.truncated ? ' (a lista csonkolt, szűkítsd a keresést)' : ''}`;
    } catch (error) {
      if (request !== ordersRequest) return;
      setText('ordersError', `A rendelések nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  function exportOrders() {
    const rows = [['Dátum', 'Rendelésszám', 'Név', 'E-mail', 'Csomag', 'Összeg (Ft)', 'Kupon', 'Fizetési mód', 'Státusz', 'Számlaszám']];
    lastOrders.forEach((order) => rows.push([
      order.createdAt, order.orderNumber, order.name, order.email, PLAN_LABELS[order.planKey] || order.planKey, order.amount,
      order.couponCode, order.paymentMethod, ORDER_STATUS_LABELS[order.status] || order.status, order.invoiceNumber
    ]));
    downloadCsv(`rendelesek-${today()}.csv`, rows);
  }

  // ---------- 4. Felhasználók és hírlevél ----------

  async function loadUsers() {
    setText('usersError', '');
    try {
      const data = await api('/api/admin/users');
      users = data.users;
      byId('usersCount').textContent = `${users.length} regisztrált felhasználó, ebből ${data.subscriberCount} megerősített feliratkozó`;
      fillTable('usersTable', users.map((user) => [
        user.name || '–', user.email, formatDate(user.createdAt), yesNo(user.confirmed), yesNo(user.subscribed)
      ]), 5, 'Még nincs regisztrált felhasználó.');
    } catch (error) {
      setText('usersError', `A felhasználók nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  function exportSubscribers() {
    const rows = [['Név', 'E-mail', 'Regisztráció', 'Feliratkozás']];
    users.filter((user) => user.subscribed && user.confirmed).forEach((user) => rows.push([user.name, user.email, user.createdAt, user.subscribedAt]));
    downloadCsv(`hirlevel-feliratkozok-${today()}.csv`, rows);
  }

  function newsletterPayload() {
    const recipients = document.querySelector('input[name="recipients"]:checked')?.value || 'test';
    return {
      subject: byId('nlSubject').value,
      heading: byId('nlHeading').value,
      bodyHtml: byId('nlBody').value,
      ctaText: byId('nlCtaText').value,
      ctaUrl: byId('nlCtaUrl').value,
      recipients,
      emails: recipients === 'custom' ? byId('nlCustom').value : undefined
    };
  }

  async function refreshPreview() {
    const payload = newsletterPayload();
    try {
      const { html } = await api('/api/admin/newsletter/preview', { method: 'POST', body: payload });
      byId('nlPreview').srcdoc = html;
    } catch (error) {
      setText('nlError', `Az előnézet nem frissíthető: ${errorMessage(error)}`);
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY_MS);
  }

  function syncRecipientMode() {
    byId('nlCustom').hidden = newsletterPayload().recipients !== 'custom';
  }

  async function sendNewsletter(event) {
    event.preventDefault();
    setText('nlStatus', '');
    setText('nlError', '');
    const payload = newsletterPayload();
    if (payload.recipients !== 'test' && !window.confirm(`Biztosan elküldöd a hírlevelet: ${RECIPIENT_LABELS[payload.recipients]}?`)) return;
    const button = byId('nlSend');
    button.disabled = true;
    try {
      const result = await api('/api/admin/newsletter/send', { method: 'POST', body: payload });
      const skipped = result.skipped?.length ? ` (${result.skipped.length} címzett kimaradt: leiratkozott vagy nincs megerősítve)` : '';
      setText('nlStatus', `A küldés elindult: ${result.recipientCount} címzett${skipped}. Az állapotot az alábbi kampánylistán követheted.`);
      await loadCampaigns();
    } catch (error) {
      setText('nlError', errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function loadCampaigns() {
    clearTimeout(pollTimer);
    setText('campaignsError', '');
    try {
      const { campaigns, sending } = await api('/api/admin/newsletter/campaigns');
      fillTable('campaignsTable', campaigns.map((campaign) => [
        formatDate(campaign.createdAt),
        campaign.subject,
        `${campaign.recipientCount} (${RECIPIENT_LABELS[campaign.recipientFilter] || campaign.recipientFilter})`,
        campaign.id === sending ? `${campaign.sentCount} / ${campaign.recipientCount} (folyamatban)` : String(campaign.sentCount),
        String(campaign.failedCount),
        campaign.sentBy || '–'
      ]), 6, 'Még nem volt kiküldött kampány.');
      if (sending) pollTimer = setTimeout(loadCampaigns, POLL_MS);
    } catch (error) {
      setText('campaignsError', `A kampányok nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  // ---------- Lapok ----------

  const TAB_LOADERS = {
    overview: [loadStats],
    coupons: [loadCoupons],
    orders: [loadOrders],
    users: [loadUsers, loadCampaigns, refreshPreview]
  };

  function activateTab(name) {
    document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.dataset.adminTab === name ? 'true' : 'false');
    });
    document.querySelectorAll('.profile-panel').forEach((panel) => { panel.hidden = panel.id !== `panel${name[0].toUpperCase()}${name.slice(1)}`; });
    if (!loaded[name]) {
      loaded[name] = true;
      TAB_LOADERS[name].forEach((loader) => loader());
    }
  }

  function showApp() {
    byId('adminLoading').hidden = true;
    byId('adminApp').hidden = false;
    byId('adminEmail').textContent = auth.getUser()?.email || '';
    document.querySelectorAll('[data-admin-tab]').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.adminTab)));
    byId('couponForm').addEventListener('submit', submitCoupon);
    byId('ordersStatus').addEventListener('change', loadOrders);
    byId('ordersSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadOrders, SEARCH_DELAY_MS); });
    byId('ordersExport').addEventListener('click', exportOrders);
    byId('usersExport').addEventListener('click', exportSubscribers);
    byId('newsletterForm').addEventListener('submit', sendNewsletter);
    byId('newsletterForm').addEventListener('input', schedulePreview);
    document.querySelectorAll('input[name="recipients"]').forEach((radio) => radio.addEventListener('change', syncRecipientMode));
    activateTab('overview');
  }

  function deny() {
    window.location.replace('index.html');
  }

  async function init() {
    if (!auth) return deny();
    await auth.ready;
    if (!auth.getUser()) return deny();
    try {
      await auth.apiFetch('/api/admin/me');
    } catch (_error) {
      return deny();
    }
    return showApp();
  }

  window.OviAdmin = { toCsv };
  init();
})();
