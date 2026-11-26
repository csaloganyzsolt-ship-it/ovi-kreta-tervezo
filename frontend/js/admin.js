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
  const SEARCH_DELAY_MS = 350;
  const POLL_MS = 3000;

  const auth = window.OviAuth;
  const loaded = {};
  let previewTimer = null;
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

  // ---------- Szerveroldali lapozású, szűrhető listák ----------

  const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  function pageNumbers(page, totalPages) {
    const first = Math.max(1, Math.min(page - 2, totalPages - 4));
    const last = Math.min(totalPages, first + 4);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }

  // Egy lista (rendelések, felhasználók, napló, audit) állapota: oldal, oldalméret, szűrők. A [data-list="név"] elemek kötődnek hozzá:
  // data-filter (szűrőmező), data-range (gyorsgomb), data-clear (szűrők törlése), data-pagesize, data-pager.
  function createList({ name, path, render, errorId, errorText }) {
    const state = { page: 1, pageSize: 20 };
    const query = (selector) => [...document.querySelectorAll(`[data-list="${name}"]${selector}`)];
    let timer = null;
    let request = 0;

    // Az aktív szűrők száma a „Szűrők” gombon; az összecsukott panel mögött is látszik, mi szűr.
    function updateBadge() {
      const active = new Set(query('[data-filter]').filter((input) => input.value.trim()).map((input) => input.dataset.filter));
      document.querySelectorAll(`[data-filters-toggle="${name}"]`).forEach((button) => {
        button.textContent = active.size ? `Szűrők (${active.size})` : 'Szűrők';
        button.classList.toggle('has-filters', active.size > 0);
      });
    }

    function setFiltersOpen(open) {
      const panel = document.getElementById(`${name}Filters`);
      if (panel) panel.hidden = !open;
      new Set(query('[data-filter]').map((input) => input.closest('tr.admin-filter-row')).filter(Boolean)).forEach((row) => { row.hidden = !open; });
      document.querySelectorAll(`[data-filters-toggle="${name}"]`).forEach((button) => button.setAttribute('aria-expanded', String(open)));
    }

    function params() {
      const search = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
      query('[data-filter]').forEach((input) => {
        const value = input.value.trim();
        if (value) search.set(input.dataset.filter, value);
      });
      updateBadge();
      return search;
    }

    function renderPager(data) {
      query('[data-pager]').forEach((box) => {
        box.replaceChildren();
        const total = el('span', 'admin-pager-total', `${data.total} találat · ${data.page}. / ${data.totalPages} oldal`);
        const button = (label, page, { disabled = false, current = false, title = '' } = {}) => {
          const node = el('button', `profile-btn${current ? ' primary' : ''}`, label);
          node.type = 'button';
          node.disabled = disabled;
          node.dataset.page = String(page);
          if (title) node.title = title;
          if (current) node.setAttribute('aria-current', 'page');
          node.addEventListener('click', () => { state.page = page; load(); });
          return node;
        };
        const nav = el('span', 'admin-pager-nav');
        nav.append(
          button('« Első', 1, { disabled: data.page <= 1 }),
          button('‹ Előző', data.page - 1, { disabled: data.page <= 1 }),
          ...pageNumbers(data.page, data.totalPages).map((page) => button(String(page), page, { current: page === data.page })),
          button('Következő ›', data.page + 1, { disabled: data.page >= data.totalPages }),
          button('Utolsó »', data.totalPages, { disabled: data.page >= data.totalPages })
        );
        box.append(total, nav);
      });
    }

    async function load() {
      const current = ++request;
      setText(errorId, '');
      try {
        const data = await api(`${path}?${params()}`);
        if (current !== request) return null;
        state.page = data.page;
        render(data);
        renderPager(data);
        return data;
      } catch (error) {
        if (current === request) setText(errorId, `${errorText}: ${errorMessage(error)}`);
        return null;
      }
    }

    const reload = () => { state.page = 1; return load(); };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(reload, SEARCH_DELAY_MS); };

    function bind() {
      document.querySelectorAll(`[data-filters-toggle="${name}"]`).forEach((button) => button.addEventListener('click', () => {
        setFiltersOpen(button.getAttribute('aria-expanded') !== 'true');
      }));
      query('[data-filter]').forEach((input) => {
        const instant = input.tagName === 'SELECT' || input.type === 'date';
        input.addEventListener(instant ? 'change' : 'input', instant ? () => { clearTimeout(timer); reload(); } : schedule);
      });
      query('[data-range]').forEach((button) => button.addEventListener('click', () => {
        const from = query('[data-filter="dateFrom"]')[0];
        const to = query('[data-filter="dateTo"]')[0];
        const today = new Date();
        const range = button.dataset.range;
        if (range === 'all') { from.value = ''; to.value = ''; } else {
          const start = new Date(today);
          start.setDate(start.getDate() - (range === 'today' ? 0 : Number(range) - 1));
          from.value = localDay(start);
          to.value = localDay(today);
        }
        clearTimeout(timer);
        reload();
      }));
      query('[data-clear]').forEach((button) => button.addEventListener('click', () => {
        query('[data-filter]').forEach((input) => { input.value = ''; });
        clearTimeout(timer);
        reload();
      }));
      query('[data-pagesize]').forEach((select) => select.addEventListener('change', () => {
        state.pageSize = Number(select.value) || 20;
        query('[data-pagesize]').forEach((other) => { other.value = String(state.pageSize); });
        clearTimeout(timer);
        reload();
      }));
    }

    return { load, reload, bind, state, setFiltersOpen, set(filter, value) { query(`[data-filter="${filter}"]`).forEach((input) => { input.value = value; }); updateBadge(); } };
  }

  const lists = {};

  // ---------- 1. Áttekintés ----------

  async function loadStats() {
    setText('overviewError', '');
    try {
      const analyticsPeriod = byId('analyticsPeriod').value;
      const params = analyticsPeriod ? `?analytics_period=${analyticsPeriod}` : '';
      const { stats, analytics, dailyGeneration } = await api(`/api/admin/stats${params}`);
      if (dailyGeneration) {
        byId('kpiDailyCap').textContent = `${dailyGeneration.count} / ${dailyGeneration.cap}`;
        byId('kpiDailyCapNote').textContent = dailyGeneration.source === 'env' ? 'A plafont a DAILY_GENERATION_CAP környezeti változó felülírja.' : 'Ebben a szerverpéldányban, UTC-napra számolva.';
      }
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

  let editingCoupon = null;

  function couponActions(coupon) {
    const wrap = el('span', 'admin-actions');
    const edit = el('button', 'admin-switch', 'Szerkesztés');
    edit.type = 'button';
    edit.addEventListener('click', () => openCouponEdit(coupon));
    const remove = el('button', 'admin-switch admin-danger', 'Törlés');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteCoupon(coupon, remove));
    wrap.append(edit, remove);
    return wrap;
  }

  function openCouponEdit(coupon) {
    editingCoupon = coupon;
    byId('couponEditTitle').textContent = `${coupon.code} kupon szerkesztése`;
    byId('couponEditValidUntil').value = coupon.validUntil ? String(coupon.validUntil).slice(0, 10) : '';
    byId('couponEditMaxUses').value = coupon.maxUses || '';
    byId('couponEditNote').value = coupon.note || '';
    setText('couponEditError', '');
    byId('couponEditDialog').showModal();
  }

  async function saveCouponEdit(event) {
    event.preventDefault();
    if (!editingCoupon) return;
    setText('couponEditError', '');
    const button = byId('couponEditSave');
    button.disabled = true;
    try {
      await api(`/api/admin/coupons/${encodeURIComponent(editingCoupon.code)}`, {
        method: 'PATCH',
        body: { valid_until: byId('couponEditValidUntil').value || null, max_uses: byId('couponEditMaxUses').value.trim() || null, note: byId('couponEditNote').value.trim() }
      });
      byId('couponEditDialog').close();
      await loadCoupons();
    } catch (error) {
      setText('couponEditError', errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function deleteCoupon(coupon, button) {
    if (!window.confirm(`Biztosan törlöd a(z) ${coupon.code} kupont? Ha már használták, archiválódik (inaktív lesz).`)) return;
    button.disabled = true;
    setText('couponsError', '');
    try {
      await api(`/api/admin/coupons/${encodeURIComponent(coupon.code)}`, { method: 'DELETE' });
      await loadCoupons();
    } catch (error) {
      button.disabled = false;
      setText('couponsError', `A kupon nem törölhető: ${errorMessage(error)}`);
    }
  }

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
        couponSwitch(coupon),
        couponActions(coupon)
      ]), 8, 'Még nincs kupon.');
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

  // Soronkénti „Műveletek ▾” lenyíló menü; egyszerre csak egy lehet nyitva (kívülre kattintás, Esc, görgetés bezárja).
  let openMenu = null;
  function closeActionMenu() {
    if (!openMenu) return;
    openMenu.menu.hidden = true;
    openMenu.toggle.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function actionsMenu(order, items) {
    const wrap = el('span', 'admin-actions');
    const holder = el('span', 'admin-menu');
    const toggle = el('button', 'profile-btn admin-menu-toggle', 'Műveletek ▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `Műveletek: ${order.orderNumber}`);
    const menu = el('div', 'admin-menu-list');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    items.forEach((item) => {
      const button = el('button', 'admin-menu-item');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.append(el('span', '', item.label));
      button.disabled = Boolean(item.reason);
      button.title = item.reason ? `${item.label} (${item.reason})` : item.title;
      if (item.reason) button.append(el('small', 'admin-menu-reason', `(${item.reason})`));
      button.addEventListener('click', () => { closeActionMenu(); item.run(button); });
      menu.append(button);
    });
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = openMenu && openMenu.menu === menu;
      closeActionMenu();
      if (wasOpen) return;
      const rect = toggle.getBoundingClientRect();
      menu.hidden = false;
      menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      toggle.setAttribute('aria-expanded', 'true');
      openMenu = { menu, toggle };
    });
    holder.append(toggle, menu);
    wrap.append(holder);
    return wrap;
  }

  document.addEventListener('click', (event) => { if (openMenu && !openMenu.menu.contains(event.target)) closeActionMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openMenu) { const { toggle } = openMenu; closeActionMenu(); toggle.focus(); }
  });
  window.addEventListener('resize', closeActionMenu);
  window.addEventListener('scroll', closeActionMenu, true);

  function renderOrders(data) {
      lastOrders = data.orders;
      fillTable('ordersTable', data.orders.map((order) => {
        const buyer = el('span');
        buyer.textContent = order.name ? `${order.name} (${order.email || '–'})` : order.email || '–';
        const freeOrder = order.status === 'paid' && !(order.amount > 0);
        const notPaid = order.status !== 'paid';
        const items = [];
        if (!freeOrder) {
          const reason = notPaid ? 'nem fizetett' : order.invoiceNumber ? 'már kiállítva' : '';
          items.push({ label: 'Számla kiállítása', reason, title: invoiceBlockReason(order) || 'Pótlólagos számlakiállítás a Számlázz.hu-n', run: (button) => issueOrderInvoice(order, button) });
        }
        items.push({
          label: 'Számla küldése',
          reason: notPaid ? 'nem fizetett' : !order.email ? 'nincs e-mail cím' : !order.invoiceNumber ? 'még nincs számla' : '',
          title: 'Csak a számla PDF kiküldése a vevőnek',
          run: (button) => sendOrderInvoice(order, button)
        });
        items.push({
          label: 'Csomag küldése',
          reason: notPaid ? 'nem fizetett' : !order.email ? 'nincs e-mail cím' : !order.documentId ? 'nincs tervezet' : '',
          title: !order.documentId
            ? 'A rendeléshez nem tartozik tervezet (document_id hiányzik), csak a számla küldhető ki.'
            : 'A tárolt tervezet (.docx + .pdf) és a számla (ha van) kiküldése a vevőnek',
          run: (button) => resendOrder(order, button)
        });
        items.push({ label: 'Számla letöltése', reason: notPaid ? 'nem fizetett' : !order.invoiceNumber ? 'még nincs számla' : '', title: 'A számla PDF letöltése', run: (button) => downloadOrderInvoice(order, button) });
        const actions = actionsMenu(order, items);
        if (freeOrder) actions.prepend(el('span', 'admin-free-label', '0 Ft / Kupon'));
        const status = el('span');
        status.textContent = ORDER_STATUS_LABELS[order.status] || order.status;
        if (order.status === 'paid' && order.lastError) {
          const failure = el('span', 'admin-order-error');
          failure.textContent = `Hiba: ${order.lastError}`;
          status.append(el('br'), failure);
        }
        return [
          formatDate(order.createdAt), order.orderNumber, buyer, PLAN_LABELS[order.planKey] || order.planKey || '–', order.topic || '–', formatAmount(order.amount),
          order.couponCode || '–', status, order.invoiceNumber || '–', actions
        ];
      }), 10, 'Nincs a szűrésnek megfelelő rendelés.');
      byId('ordersCount').textContent = `${data.total} rendelés${data.truncated ? ' (a lista csonkolt, szűkítsd az időszakot)' : ''}`;
  }

  lists.orders = createList({ name: 'orders', path: '/api/admin/orders', render: renderOrders, errorId: 'ordersError', errorText: 'A rendelések nem tölthetők be' });
  const loadOrders = () => lists.orders.load();

  // Felső figyelmeztető sáv: kifizetett, de számlázási/kézbesítési hibás rendelések (a rendelés fizetett marad, a hiba a szerveren rögzült).
  function renderFailedOrdersBanner(data) {
    const failed = data.failed || [];
    const count = data.failedCount ?? failed.length;
    const banner = byId('failedOrdersBanner');
    banner.hidden = count === 0;
    byId('failedOrdersTitle').textContent = `${count} kifizetett rendelésnél elbukott a számlázás vagy a kézbesítés`;
    byId('failedOrdersList').replaceChildren(...failed.slice(0, 5).map((order) => {
      const item = el('li');
      item.textContent = `${order.orderNumber} – ${order.lastError}`;
      return item;
    }));
  }

  async function loadFailedOrdersBanner() {
    try {
      renderFailedOrdersBanner(await api('/api/admin/orders?status=paid&invoice=error&pageSize=20'));
    } catch (_error) {
      byId('failedOrdersBanner').hidden = true;
    }
  }

  // Pótlólagos számlakiállítás: a szerver kiállítja a számlát a Számlázz.hu-n, és elmenti a számlaszámot (duplán nem állít ki).
  async function issueOrderInvoice(order, button) {
    const reason = invoiceBlockReason(order);
    if (reason) {
      showToast(reason, true);
      return;
    }
    setText('ordersError', '');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Kiállítás…';
    showToast(`Számla kiállítása folyamatban: ${order.orderNumber}…`);
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(order.orderNumber)}/issue-invoice`, { method: 'POST', body: {} });
      await loadOrders();
      loadFailedOrdersBanner();
      showToast(`Számla kiállítva: ${result.invoiceNumber} (${order.orderNumber}).`);
    } catch (error) {
      const message = `A számla kiállítása sikertelen: ${errorMessage(error)}`;
      setText('ordersError', message);
      showToast(message, true);
      button.disabled = false;
      button.textContent = label;
    }
  }

  function invoiceBlockReason(order) {
    if (order.status !== 'paid') return 'Csak kifizetett rendeléshez állítható ki számla.';
    if (order.invoiceNumber) return `A rendeléshez már van számla: ${order.invoiceNumber}.`;
    if (!(order.amount > 0)) return 'Ingyenes (0 Ft-os) rendeléshez nem készül számla.';
    return '';
  }

  // Látható, a görgetéstől független visszajelzés (a táblázat feletti állapotsor görgetett nézetben nem látszik).
  let toastTimer = null;
  function showToast(message, isError = false) {
    let toast = byId('adminToast');
    if (!toast) {
      toast = el('div', 'admin-toast');
      toast.id = 'adminToast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle('is-error', isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 9000 : 5000);
  }

  // A számla PDF-et a szerver élőben kéri a Számlázz.hu-tól; a böngésző csak letölti, nem tárolódik sehol.
  async function downloadOrderInvoice(order, button) {
    setText('ordersError', '');
    button.disabled = true;
    try {
      const blob = await auth.apiBlob(`/api/admin/orders/${encodeURIComponent(order.orderNumber)}/invoice`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${order.invoiceNumber || order.orderNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setText('ordersError', `A számla nem tölthető le: ${errorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  // Teljes csomag a vevő rendelésen tárolt címére: a szerver a Supabase-ben tárolt tervből újra előállítja a fájlokat, a számla PDF-et élőben kéri le.
  async function resendOrder(order, button) {
    if (!window.confirm(`Kiküldöd a teljes tervezetcsomagot (${order.orderNumber}) ide: ${order.email}?`)) return;
    setText('ordersError', '');
    button.disabled = true;
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(order.orderNumber)}/resend`, { method: 'POST', body: {} });
      showToast(`A csomag elküldve: ${result.to}${result.invoiceAttached ? ' (számlával)' : ' (számla nélkül)'}.`);
    } catch (error) {
      setText('ordersError', `A csomag küldése sikertelen: ${errorMessage(error)}`);
      showToast(`A csomag küldése sikertelen: ${errorMessage(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  // Csak a számla PDF-et küldi ki a vevőnek (alapértelmezett sablon: invoice_only).
  async function sendOrderInvoice(order, button) {
    if (!window.confirm(`Kiküldöd a számlát (${order.invoiceNumber}) ide: ${order.email}?`)) return;
    setText('ordersError', '');
    button.disabled = true;
    try {
      const result = await api(`/api/admin/orders/${encodeURIComponent(order.orderNumber)}/send-invoice`, { method: 'POST', body: {} });
      showToast(`A számla elküldve: ${result.to}.`);
    } catch (error) {
      setText('ordersError', `A számla küldése sikertelen: ${errorMessage(error)}`);
      showToast(`A számla küldése sikertelen: ${errorMessage(error)}`, true);
    } finally {
      button.disabled = false;
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

  const ROLE_LABELS = { admin: 'Admin', user: 'Felhasználó' };

  const ACCOUNT_LABELS = { registered: 'Regisztrált', guest: 'Vendég (nem regisztrált)' };

  // Hírlevél-állapot + kapcsoló: a leiratkozott rekord megmarad, csak az állapota vált.
  function newsletterCell(user) {
    const cell = el('span', 'admin-newsletter-cell');
    cell.append(el('span', user.subscribed ? 'admin-badge-on' : 'admin-badge-off', user.subscribed ? 'Feliratkozott' : 'Leiratkozott'));
    const toggle = el('button', 'profile-btn', user.subscribed ? 'Leiratkoztat' : 'Feliratkoztat');
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleNewsletter(user, toggle));
    cell.append(toggle);
    return cell;
  }

  async function toggleNewsletter(user, button) {
    const subscribe = !user.subscribed;
    if (!window.confirm(`${subscribe ? 'Feliratkoztatod' : 'Leiratkoztatod'} ezt a címet: ${user.email}?`)) return;
    setText('usersError', '');
    button.disabled = true;
    try {
      await api('/api/admin/users/newsletter', { method: 'POST', body: { email: user.email, subscribed: subscribe } });
      showToast(`${user.email}: ${subscribe ? 'feliratkozott' : 'leiratkozott'}.`);
      await lists.users.load();
    } catch (error) {
      setText('usersError', `A hírlevél-állapot nem módosítható: ${errorMessage(error)}`);
      button.disabled = false;
    }
  }

  function renderUsers(data) {
    users = data.users;
    byId('usersCount').textContent = `${data.total} felhasználó / vendég, ebből ${data.subscriberCount} aktív hírlevél-feliratkozó (összesen)`;
    fillTable('usersTable', users.map((user) => [
      user.name || '–', user.email, ACCOUNT_LABELS[user.accountType] || '–', user.kindergarten || '–', user.group || '–', [user.billingName, user.taxId].filter(Boolean).join(' / ') || '–',
      user.accountType === 'guest' ? '–' : ROLE_LABELS[user.role] || '–', formatDate(user.createdAt), user.accountType === 'guest' ? '–' : yesNo(user.confirmed), newsletterCell(user), supportButton(user.email)
    ]), 11, 'Nincs a szűrésnek megfelelő felhasználó.');
  }

  lists.users = createList({ name: 'users', path: '/api/admin/users', render: renderUsers, errorId: 'usersError', errorText: 'A felhasználók nem tölthetők be' });
  const loadUsers = () => lists.users.load();

  // ---------- Ügyfélszolgálat: kárpótlási kupon ----------

  function supportButton(email) {
    const button = el('button', 'profile-btn', 'Kárpótlás (100% Kupon)');
    button.type = 'button';
    button.addEventListener('click', () => createSupportCoupon(email, button));
    return button;
  }

  async function createSupportCoupon(email, button) {
    setText('supportError', '');
    setText('supportResult', '');
    button.disabled = true;
    try {
      const data = await api('/api/admin/support/coupon', { method: 'POST', body: { email } });
      setText('supportResult', `Kárpótlási kupon (${data.coupon.email}): ${data.coupon.code} – egyszer használható, 100%-os. Küldd el az ügyfélnek!`);
      loaded.coupons = false;
    } catch (error) {
      setText('supportError', `A kupon nem hozható létre: ${errorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Értékelések ----------

  const REVIEW_STATUS_LABELS = { pending: 'Jóváhagyásra vár', approved: 'Elfogadva', rejected: 'Elutasítva' };
  let reviewReplyTarget = null;

  function setReviewsBadge(count) {
    const badge = byId('reviewsBadge');
    badge.textContent = String(count);
    badge.hidden = !(count > 0);
    badge.setAttribute('aria-label', `${count} jóváhagyásra váró értékelés`);
  }

  async function loadReviewsSummary() {
    try {
      setReviewsBadge((await api('/api/admin/reviews/summary')).pending || 0);
    } catch (_error) {
      setReviewsBadge(0);
    }
  }

  async function setReviewStatus(review, status, button) {
    button.disabled = true;
    try {
      await api(`/api/admin/reviews/${encodeURIComponent(review.id)}`, { method: 'PATCH', body: { status } });
      showToast(status === 'approved' ? 'Az értékelés megjelenik a főoldalon.' : 'Az értékelés rejtett lett.');
      await lists.reviews.load();
      loadReviewsSummary();
    } catch (error) {
      showToast(`Az értékelés nem módosítható: ${errorMessage(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteReview(review, button) {
    if (!window.confirm(`Véglegesen törlöd ${review.name || review.email} értékelését? Ez nem vonható vissza.`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/reviews/${encodeURIComponent(review.id)}`, { method: 'DELETE' });
      showToast('Az értékelés véglegesen törölve.');
      await lists.reviews.load();
      loadReviewsSummary();
    } catch (error) {
      showToast(`Az értékelés nem törölhető: ${errorMessage(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  function replyTemplate(review) {
    const name = review.name ? ` ${review.name.split(/\s+/)[0]}` : '';
    const topic = review.topic ? ` (${review.topic})` : '';
    return `Kedves${name}!\n\nKöszönjük, hogy megosztottad velünk a véleményed az OviTervező tervezetről${topic}. Sajnáljuk, ha nem minden felelt meg az elvárásaidnak – szeretnénk segíteni, hogy legközelebb jobb élményed legyen.\n\nKérlek, írd meg röviden, mi volt a legnagyobb hiányosság vagy hiba, és ${review.orderNumber ? `a ${review.orderNumber} rendelésszámú tervezetet` : 'a tervezetet'} igyekszünk mielőbb rendbe tenni vagy pótolni.\n\nÜdvözlettel:\nAz OviTervező csapata`;
  }

  function openReviewReply(review) {
    reviewReplyTarget = review;
    byId('reviewReplyTo').value = review.email;
    byId('reviewReplyOrder').value = review.orderNumber || '–';
    byId('reviewReplySubject').value = `OviTervező – válasz az értékelésedre${review.orderNumber ? ` (${review.orderNumber})` : ''}`;
    byId('reviewReplyMessage').value = replyTemplate(review);
    byId('reviewReplyError').hidden = true;
    byId('reviewReplyDialog').showModal();
  }

  async function sendReviewReply(event) {
    event.preventDefault();
    if (!reviewReplyTarget) return;
    const button = byId('reviewReplySend');
    const message = byId('reviewReplyMessage').value.trim();
    if (!message) { setText('reviewReplyError', 'Az üzenet szövege nem lehet üres.'); return; }
    button.disabled = true;
    try {
      await api(`/api/admin/reviews/${encodeURIComponent(reviewReplyTarget.id)}/reply`, { method: 'POST', body: { subject: byId('reviewReplySubject').value, message } });
      byId('reviewReplyDialog').close();
      showToast(`A válasz elment: ${reviewReplyTarget.email}`);
      reviewReplyTarget = null;
      lists.reviews.load();
    } catch (error) {
      setText('reviewReplyError', `A válasz nem küldhető el: ${errorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  function renderReviews(data) {
    byId('reviewsCount').textContent = `${data.total} értékelés`;
    fillTable('reviewsTable', data.reviews.map((review) => {
      const stars = el('span', 'admin-stars', '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating));
      stars.setAttribute('aria-label', `${review.rating} / 5 csillag`);
      const sender = el('span');
      sender.textContent = review.name ? `${review.name} (${review.email})` : review.email;
      const order = el('span');
      order.textContent = review.orderNumber ? `${review.orderNumber}${review.topic ? ` – ${review.topic}` : ''}` : '–';
      const status = el('span', `admin-badge admin-review-${review.status}`);
      status.textContent = REVIEW_STATUS_LABELS[review.status] || review.status;
      if (review.replySentAt) status.append(el('br'), el('small', '', `Válasz: ${formatDate(review.replySentAt)}`));
      const items = [
        { label: 'Elfogadás (főoldalra)', reason: review.status === 'approved' ? 'már elfogadva' : '', title: 'Megjelenik a főoldalon', run: (button) => setReviewStatus(review, 'approved', button) },
        { label: 'Elutasítás / levétel', reason: review.status === 'rejected' ? 'már elutasítva' : '', title: 'Nem jelenik meg a főoldalon', run: (button) => setReviewStatus(review, 'rejected', button) },
        { label: 'E-mail írása az ügyfélnek', reason: '', title: 'Udvarias válasz küldése a beküldőnek', run: () => openReviewReply(review) },
        { label: 'Végleges törlés', reason: '', title: 'Az értékelés végleges törlése az adatbázisból', run: (button) => deleteReview(review, button) }
      ];
      return [formatDate(review.createdAt), stars, review.comment || '–', sender, order, status, actionsMenu({ orderNumber: review.orderNumber || review.email }, items)];
    }), 7, 'Nincs a szűrésnek megfelelő értékelés.');
  }

  lists.reviews = createList({ name: 'reviews', path: '/api/admin/reviews', render: renderReviews, errorId: 'reviewsError', errorText: 'Az értékelések nem tölthetők be' });
  const loadReviews = () => lists.reviews.load();

  // ---------- Rendszernapló ----------

  function renderLogs(data) {
    byId('logsCount').textContent = `${data.total} naplóbejegyzés`;
    fillTable('logsTable', data.logs.map((entry) => [formatDate(entry.createdAt), entry.level, entry.context, entry.message, entry.email || '–']), 5, 'Nincs a szűrésnek megfelelő naplóbejegyzés.');
    [...byId('logsTable').tBodies[0].rows].forEach((row, index) => {
      if (data.logs[index]?.level === 'error') row.classList.add('log-error');
    });
  }

  lists.logs = createList({ name: 'logs', path: '/api/admin/logs', render: renderLogs, errorId: 'logsError', errorText: 'A rendszernapló nem tölthető be' });
  const loadLogs = () => lists.logs.load();

  // Audit napló: hosszú vagy összetett értékek (pl. AI prompt, e-mail sablon) összecsukható előtte/utána nézetben.
  const AUDIT_INLINE_MAX = 80;

  function auditValue(value) {
    if (value === null || value === undefined || value === '') return el('em', 'admin-audit-empty', '–');
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text.length <= AUDIT_INLINE_MAX && !text.includes('\n')) return el('code', 'admin-audit-value', text);
    const details = el('details', 'admin-audit-details');
    details.append(el('summary', '', `${text.slice(0, AUDIT_INLINE_MAX).replace(/\s+/g, ' ')}…`));
    const area = el('textarea', 'admin-audit-full');
    area.readOnly = true;
    area.value = text;
    details.append(area);
    return details;
  }

  function renderAudit(data) {
    byId('auditCount').textContent = `${data.total} módosítás`;
    fillTable('auditTable', data.entries.map((entry) => {
      const label = el('span');
      label.append(el('strong', '', entry.label));
      if (entry.label !== entry.key) label.append(el('br'), el('small', 'admin-audit-key', entry.key));
      return [formatDate(entry.changedAt), entry.changedBy || '–', label, auditValue(entry.oldValue), auditValue(entry.newValue)];
    }), 5, 'Még nincs rögzített beállításmódosítás.');
  }

  lists.audit = createList({ name: 'audit', path: '/api/admin/audit', render: renderAudit, errorId: 'auditError', errorText: 'Az audit napló nem tölthető be' });

  function activateLogsTab(name) {
    document.querySelectorAll('[data-logs-tab]').forEach((tab) => tab.setAttribute('aria-selected', tab.dataset.logsTab === name ? 'true' : 'false'));
    document.querySelectorAll('[data-logs-panel]').forEach((panel) => { panel.hidden = panel.dataset.logsPanel !== name; });
    if (name === 'audit') lists.audit.load(); else lists.logs.load();
  }

  function exportSubscribers() {
    const rows = [['Név', 'E-mail', 'Regisztráció', 'Feliratkozás']];
    users.filter((user) => user.subscribed && (user.confirmed || user.accountType === 'guest')).forEach((user) => rows.push([user.name, user.email, user.createdAt, user.subscribedAt]));
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

  function reuseButton(campaign) {
    const button = el('button', 'admin-switch', 'Újrahasználás');
    button.type = 'button';
    button.addEventListener('click', async () => {
      setText('nlError', '');
      setText('campaignsError', '');
      try {
        const { campaign: data } = await api(`/api/admin/newsletter/campaigns/${encodeURIComponent(campaign.id)}`);
        byId('nlSubject').value = data.subject || '';
        byId('nlHeading').value = data.heading || '';
        byId('nlBody').value = data.bodyHtml || '';
        byId('nlCtaText').value = data.ctaText || '';
        byId('nlCtaUrl').value = data.ctaUrl || '';
        await refreshPreview();
        byId('newsletterForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) {
        setText('campaignsError', `A kampány nem tölthető be: ${errorMessage(error)}`);
      }
    });
    return button;
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
        campaign.sentBy || '–',
        reuseButton(campaign)
      ]), 7, 'Még nem volt kiküldött kampány.');
      if (sending) pollTimer = setTimeout(loadCampaigns, POLL_MS);
    } catch (error) {
      setText('campaignsError', `A kampányok nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  // ---------- Rendszerbeállítások ----------

  let templates = {};

  function flash(statusId, errorId, message, isError) {
    setText(statusId, isError ? '' : message);
    setText(errorId, isError ? message : '');
  }

  const LINK_FIELDS = [
    ['cloudflare', 'setLinkCloudflare', 'Cloudflare Analytics'],
    ['google_analytics', 'setLinkGoogleAnalytics', 'Google Analytics'],
    ['search_console', 'setLinkSearchConsole', 'Google Search Console'],
    ['barion', 'setLinkBarion', 'Barion'],
    ['szamlazz', 'setLinkSzamlazz', 'Számlázz.hu']
  ];

  function isHttpsUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && Boolean(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  // Csak a kitöltött, érvényes https:// hivatkozások jelennek meg, új lapon nyílva.
  function renderToolLinks(links = {}) {
    const list = byId('adminToolsList');
    const anchors = LINK_FIELDS.filter(([key]) => isHttpsUrl(links[key])).map(([key, , label]) => {
      const link = el('a', 'profile-btn', label);
      link.href = links[key];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    });
    list.replaceChildren(...anchors);
    byId('adminTools').hidden = anchors.length === 0;
  }

  async function loadToolLinks() {
    try {
      const { settings } = await api('/api/admin/settings');
      renderToolLinks(settings.external_links);
    } catch (error) {
      byId('adminTools').hidden = true;
      console.error('A külső linkek nem tölthetők be:', error);
    }
  }

  async function loadSettings() {
    try {
      const { settings, dailyGeneration } = await api('/api/admin/settings');
      byId('setMaintenance').checked = settings.maintenance_mode === true;
      byId('setPriceDaily').value = settings.pricing.daily;
      byId('setPriceWeekly').value = settings.pricing.weekly;
      byId('setPriceAcademicDaily').value = settings.pricing.academic_daily;
      byId('setPriceAcademicWeekly').value = settings.pricing.academic_weekly;
      byId('setDailyCap').value = settings.daily_generation_cap;
      byId('dailyCapInfo').textContent = dailyGeneration
        ? `Ma eddig: ${dailyGeneration.count} generálás / ${dailyGeneration.cap} plafon${dailyGeneration.source === 'env' ? ' (a DAILY_GENERATION_CAP környezeti változó felülírja a beállítást)' : ''}.`
        : '';
      byId('setAnnouncementEnabled').checked = settings.announcement_bar?.enabled === true;
      byId('setAnnouncementText').value = settings.announcement_bar?.text || '';
      byId('setHints').value = settings.seasonal_hints.join('; ');
      byId('setAiModel').value = settings.ai_config.model;
      byId('setAiPrompt').value = settings.ai_config.system_prompt;
      byId('setBillingProfile').value = settings.billing_profile || 'ev';
      byId('setPaymentProvider').value = settings.payment_provider || 'barion';
      byId('setNotificationEmail').value = settings.notification_email || '';
      byId('setBillingNotificationEmail').value = settings.billing_notification_email || '';
      byId('setErrorNotificationEmail').value = settings.error_notification_email || '';
      byId('notificationEffective').textContent = settings.notification_email
        ? 'Jelenleg ez a cím él (az Admin Központban mentve).'
        : 'Nincs mentett cím: a Render környezeti változók (vagy az ügyfélszolgálati cím) az érvényesek.';
      for (const [key, id] of LINK_FIELDS) byId(id).value = settings.external_links?.[key] || '';
      renderToolLinks(settings.external_links);
    } catch (error) {
      flash('generalStatus', 'generalError', `A beállítások nem tölthetők be: ${errorMessage(error)}`, true);
    }
    loadBillingStatus();
  }

  const MODE_LABELS = { test: 'TESZT mód', sandbox: 'SANDBOX (teszt) mód', live: 'ÉLES mód' };

  function statusCard(title, value, tone, detail) {
    const card = el('article', `admin-status-card ${tone}`);
    card.append(el('span', 'admin-status-title', title), el('strong', 'admin-status-value', value));
    if (detail) card.append(el('span', 'admin-status-detail', detail));
    return card;
  }

  // Csak olvasható állapotkártyák: a szerver logikai értékeket ad (kulcsok jelenléte, éles/teszt mód), titkos adatot nem.
  async function loadBillingStatus() {
    const list = byId('billingStatusList');
    try {
      const { status } = await api('/api/admin/billing-status');
      const modeCard = (title, mode) => statusCard(title, MODE_LABELS[mode] || mode, mode === 'live' ? 'ok' : 'warn');
      const keyLine = (label, value) => `${label}: ${value ? '✓ beállítva' : '✗ HIÁNYZIK'}`;
      const cards = [modeCard('Barion', status.modes.barion), modeCard('Számlázz.hu', status.modes.szamlazz), modeCard('Stripe', status.modes.stripe)];
      const db = status.supabase || {};
      cards.push(statusCard('Supabase adatbázis', db.connected ? 'Kapcsolódva' : 'HIÁNYZIK', db.connected ? 'ok' : 'warn',
        [keyLine('SUPABASE_URL', db.urlSet), keyLine('Titkos kulcs', db.keySet), db.keySource ? `Forrás: ${db.keySource}` : ''].filter(Boolean).join(' · ')));
      for (const [type, label] of [['ev', 'EV'], ['kft', 'Kft.']]) {
        const keys = status.profiles[type];
        const complete = keys.szamlazzApiKey && keys.barionPosKey && keys.stripeSecret && keys.stripePublishable && keys.stripeWebhook;
        const detail = [keyLine('Számlázz.hu', keys.szamlazzApiKey), keyLine('Barion POS', keys.barionPosKey), keyLine('Stripe titkos', keys.stripeSecret), keyLine('Stripe nyilvános', keys.stripePublishable), keyLine('Stripe webhook', keys.stripeWebhook)].join('\n');
        cards.push(statusCard(`${label} kulcsok`, complete ? 'Teljes' : 'Hiányos', complete ? 'ok' : 'warn', detail));
      }
      list.replaceChildren(...cards);
    } catch (error) {
      list.replaceChildren(el('p', 'profile-error', `Az állapot nem tölthető be: ${errorMessage(error)}`));
    }
  }

  async function saveSettings(event, patchBuilder, ids) {
    event.preventDefault();
    flash(ids.status, ids.error, '', false);
    const button = byId(ids.button);
    button.disabled = true;
    try {
      const patch = patchBuilder();
      const { settings } = await api('/api/admin/settings', { method: 'PATCH', body: patch });
      if (patch.external_links) renderToolLinks(settings?.external_links || patch.external_links);
      flash(ids.status, ids.error, 'Mentve. A változás azonnal érvényes.', false);
    } catch (error) {
      flash(ids.status, ids.error, errorMessage(error), true);
    } finally {
      button.disabled = false;
    }
  }

  const saveGeneral = (event) => saveSettings(event, () => ({
    maintenance_mode: byId('setMaintenance').checked,
    pricing: {
      daily: Number(byId('setPriceDaily').value),
      weekly: Number(byId('setPriceWeekly').value),
      academic_daily: Number(byId('setPriceAcademicDaily').value),
      academic_weekly: Number(byId('setPriceAcademicWeekly').value)
    },
    daily_generation_cap: Number(byId('setDailyCap').value),
    announcement_bar: { enabled: byId('setAnnouncementEnabled').checked, text: byId('setAnnouncementText').value },
    seasonal_hints: byId('setHints').value
  }), { status: 'generalStatus', error: 'generalError', button: 'generalSave' });

  const saveLinks = (event) => saveSettings(event, () => ({
    external_links: Object.fromEntries(LINK_FIELDS.map(([key, id]) => [key, byId(id).value.trim()]))
  }), { status: 'linksStatus', error: 'linksError', button: 'linksSave' });

  const saveAi = (event) => saveSettings(event, () => ({
    ai_config: { model: byId('setAiModel').value, system_prompt: byId('setAiPrompt').value }
  }), { status: 'aiStatus', error: 'aiError', button: 'aiSave' });

  const saveBilling = (event) => saveSettings(event, () => ({
    billing_profile: byId('setBillingProfile').value,
    payment_provider: byId('setPaymentProvider').value
  }), { status: 'billingStatus', error: 'billingError', button: 'billingSave' });

  const saveNotification = (event) => saveSettings(event, () => ({
    notification_email: byId('setNotificationEmail').value.trim()
  }), { status: 'notificationStatus', error: 'notificationError', button: 'notificationSave' });
  const saveNotificationSplit = (event) => saveSettings(event, () => ({
    billing_notification_email: byId('setBillingNotificationEmail').value.trim(),
    error_notification_email: byId('setErrorNotificationEmail').value.trim()
  }), { status: 'notificationSplitStatus', error: 'notificationSplitError', button: 'notificationSplitSave' });

  // Módosítási napló: csak olvasható, a régi érték kijelölhető és másolható.
  async function openHistory(key) {
    const select = byId('historyKey');
    if (key) select.value = key;
    setText('historyError', '');
    byId('historyList').replaceChildren();
    byId('historyEmpty').hidden = true;
    const dialog = byId('historyDialog');
    if (!dialog.open) dialog.showModal();
    try {
      const { history } = await api(`/api/admin/settings/history/${encodeURIComponent(select.value)}`);
      byId('historyEmpty').hidden = history.length > 0;
      byId('historyList').replaceChildren(...history.map((entry) => {
        const item = el('li');
        const when = el('time', '', new Date(entry.changedAt).toLocaleString('hu-HU'));
        when.dateTime = entry.changedAt;
        item.append(when);
        for (const [label, value] of [['Korábbi érték', entry.oldValue], ['Új érték', entry.newValue]]) {
          item.append(el('div', '', label + ':'));
          const area = el('textarea');
          area.readOnly = true;
          area.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          item.append(area);
        }
        return item;
      }));
    } catch (error) {
      setText('historyError', `Az előzmények nem tölthetők be: ${errorMessage(error)}`);
    }
  }

  let creatingTemplate = false;

  const TEMPLATE_VARIABLES = ['topic', 'orderId', 'invoiceNumber', 'planLabel', 'invoiceText', 'site_url', 'logo_src', 'company_legal', 'content', 'stars', 'feedback_url', 'attachments_rows', 'unsubscribe_link'];
  const BASE_SKELETON = `<h1 style="margin:0 0 12px;font-size:22px;color:#1f5f52;">Kedves Kolléganő!</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#2d3b36;">Ide írhatja a levél szövegét.</p>
<p style="margin:20px 0;text-align:center;"><a href="{{site_url}}" style="display:inline-block;background:#3fae84;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:13px 26px;border-radius:999px;">Új tervezet készítése</a></p>
<p style="margin:0;font-size:16px;line-height:1.6;color:#2d3b36;">Üdvözlettel,<br><strong>Az OviTervező csapata</strong></p>`;

  function renderTemplateVariables() {
    const box = byId('tplVars');
    box.textContent = '';
    box.append(el('span', '', 'Használható helyőrzők (kattintásra beszúrja): '));
    TEMPLATE_VARIABLES.forEach((name) => {
      const chip = el('button', '', `{{${name}}}`);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        const area = byId('tplBody');
        const start = area.selectionStart ?? area.value.length;
        const end = area.selectionEnd ?? start;
        area.value = `${area.value.slice(0, start)}{{${name}}}${area.value.slice(end)}`;
        area.focus();
        area.setSelectionRange(start + name.length + 4, start + name.length + 4);
        refreshTemplatePreview();
      });
      box.append(chip);
    });
  }

  function renderCustomTemplateOptions(selected) {
    const group = byId('tplCustomGroup');
    group.textContent = '';
    const customs = Object.values(templates).filter((row) => row.custom);
    customs.forEach((row) => {
      const option = el('option', '', `${row.name || row.id} (${row.id})`);
      option.value = row.id;
      group.append(option);
    });
    group.hidden = customs.length === 0;
    const select = byId('tplSelect');
    if (selected && templates[selected]) select.value = selected;
  }

  function setTemplateMode(creating) {
    creatingTemplate = creating;
    byId('tplCreateFields').hidden = !creating;
    byId('tplCancelNew').hidden = !creating;
    byId('tplNew').hidden = creating;
    byId('tplSelect').disabled = creating;
    byId('tplSave').textContent = creating ? 'Sablon létrehozása' : 'Mentés';
    const template = templates[byId('tplSelect').value];
    byId('tplDelete').hidden = creating || !template?.custom;
    byId('tplReset').hidden = creating || !template?.hasDefault;
  }

  function showTemplate() {
    const template = templates[byId('tplSelect').value];
    byId('tplSubject').value = template?.subject || '';
    byId('tplBody').value = template?.bodyHtml || '';
    setTemplateMode(false);
    refreshTemplatePreview();
  }

  function startNewTemplate() {
    flash('tplStatus', 'tplError', '', false);
    byId('tplNewId').value = '';
    byId('tplNewName').value = '';
    byId('tplSubject').value = '';
    byId('tplBody').value = '';
    setTemplateMode(true);
    byId('tplNewId').focus();
    refreshTemplatePreview();
  }

  async function loadTemplates() {
    try {
      const { templates: rows } = await api('/api/admin/email-templates');
      const current = byId('tplSelect').value;
      templates = Object.fromEntries(rows.map((row) => [row.id, row]));
      renderCustomTemplateOptions(current);
      renderTemplateVariables();
      showTemplate();
    } catch (error) {
      flash('tplStatus', 'tplError', `A sablonok nem tölthetők be: ${errorMessage(error)}`, true);
    }
  }

  async function refreshTemplatePreview() {
    try {
      // Új sablonnál a mentett kézbesítő levél keretébe illesztett, még el nem mentett tartalom látszik.
      const id = creatingTemplate ? 'payment_success' : byId('tplSelect').value;
      const { html } = await api('/api/admin/email-templates/preview', { method: 'POST', body: { id, subject: byId('tplSubject').value, bodyHtml: byId('tplBody').value } });
      byId('tplPreview').srcdoc = html;
      setText('tplError', '');
    } catch (error) {
      setText('tplError', `Az előnézet nem frissíthető: ${errorMessage(error)}`);
    }
  }

  async function saveTemplate(event) {
    event.preventDefault();
    flash('tplStatus', 'tplError', '', false);
    const button = byId('tplSave');
    button.disabled = true;
    try {
      if (creatingTemplate) {
        const { template } = await api('/api/admin/email-templates', { method: 'POST', body: { id: byId('tplNewId').value.trim(), name: byId('tplNewName').value, subject: byId('tplSubject').value, bodyHtml: byId('tplBody').value } });
        templates[template.id] = template;
        renderCustomTemplateOptions(template.id);
        showTemplate();
        flash('tplStatus', 'tplError', 'Az új sablon létrejött.', false);
        return;
      }
      const id = byId('tplSelect').value;
      const { template } = await api(`/api/admin/email-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: { subject: byId('tplSubject').value, bodyHtml: byId('tplBody').value } });
      templates[id] = { ...templates[id], ...template };
      flash('tplStatus', 'tplError', 'A sablon mentve.', false);
    } catch (error) {
      flash('tplStatus', 'tplError', errorMessage(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteTemplate() {
    const id = byId('tplSelect').value;
    const template = templates[id];
    if (!template?.custom || !window.confirm(`Biztosan törlöd az egyedi sablont: ${template.name || id}?`)) return;
    try {
      await api(`/api/admin/email-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      delete templates[id];
      renderCustomTemplateOptions('welcome_email');
      byId('tplSelect').value = 'welcome_email';
      showTemplate();
      showToast('Az egyedi sablon törölve.');
    } catch (error) {
      flash('tplStatus', 'tplError', `A sablon nem törölhető: ${errorMessage(error)}`, true);
    }
  }

  async function resetTemplate() {
    const id = byId('tplSelect').value;
    if (!templates[id]?.hasDefault || !window.confirm('Visszaállítod a sablont a beépített alapértékre? A módosításaid elvesznek.')) return;
    try {
      const { template } = await api(`/api/admin/email-templates/${encodeURIComponent(id)}/reset`, { method: 'POST', body: {} });
      templates[id] = { ...templates[id], ...template };
      showTemplate();
      flash('tplStatus', 'tplError', 'A sablon az alapértékre állt vissza.', false);
    } catch (error) {
      flash('tplStatus', 'tplError', errorMessage(error), true);
    }
  }

  function loadSkeleton() {
    if (byId('tplBody').value.trim() && !window.confirm('Felülírod a jelenlegi HTML tartalmat az alap OviTervező vázzal?')) return;
    byId('tplBody').value = BASE_SKELETON;
    refreshTemplatePreview();
  }

  function activateSettingsTab(name) {
    document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.setAttribute('aria-selected', tab.dataset.settingsTab === name ? 'true' : 'false'));
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
  }

  // ---------- Lapok ----------

  const TAB_LOADERS = {
    overview: [loadStats],
    coupons: [loadCoupons],
    orders: [loadOrders],
    users: [loadUsers],
    reviews: [loadReviews],
    newsletter: [loadCampaigns, refreshPreview],
    logs: [loadLogs],
    settings: [loadSettings, loadTemplates]
  };

  function setMenuOpen(open) {
    byId('adminSidebar').classList.toggle('is-open', open);
    byId('adminBackdrop').hidden = !open;
    byId('adminMenuToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function activateTab(name) {
    document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', tab.dataset.adminTab === name ? 'true' : 'false');
      if (tab.dataset.adminTab === name) byId('adminMobileTitle').textContent = tab.childNodes[0].textContent.trim();
    });
    setMenuOpen(false);
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
    byId('couponEditForm').addEventListener('submit', saveCouponEdit);
    byId('couponEditCancel').addEventListener('click', () => byId('couponEditDialog').close());
    Object.values(lists).forEach((list) => list.bind());
    byId('adminMenuToggle').addEventListener('click', () => setMenuOpen(!byId('adminSidebar').classList.contains('is-open')));
    byId('adminBackdrop').addEventListener('click', () => setMenuOpen(false));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenuOpen(false); });
    document.querySelectorAll('[data-logs-tab]').forEach((tab) => tab.addEventListener('click', () => activateLogsTab(tab.dataset.logsTab)));
    byId('ordersExport').addEventListener('click', exportOrders);
    byId('usersExport').addEventListener('click', exportSubscribers);
    byId('logsRefresh').addEventListener('click', () => lists.logs.load());
    byId('reviewsRefresh').addEventListener('click', () => { lists.reviews.load(); loadReviewsSummary(); });
    byId('reviewReplyForm').addEventListener('submit', sendReviewReply);
    byId('reviewReplyCancel').addEventListener('click', () => byId('reviewReplyDialog').close());
    loadReviewsSummary();
    byId('newsletterForm').addEventListener('submit', sendNewsletter);
    byId('newsletterForm').addEventListener('input', schedulePreview);
    document.querySelectorAll('input[name="recipients"]').forEach((radio) => radio.addEventListener('change', syncRecipientMode));
    document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab)));
    byId('generalForm').addEventListener('submit', saveGeneral);
    byId('aiForm').addEventListener('submit', saveAi);
    byId('billingForm').addEventListener('submit', saveBilling);
    byId('notificationForm').addEventListener('submit', saveNotification);
    byId('notificationSplitForm').addEventListener('submit', saveNotificationSplit);
    byId('linksForm').addEventListener('submit', saveLinks);
    document.querySelectorAll('[data-history-key]').forEach((button) => button.addEventListener('click', () => openHistory(button.dataset.historyKey)));
    byId('historyKey').addEventListener('change', () => openHistory());
    byId('historyClose').addEventListener('click', () => byId('historyDialog').close());
    byId('templateForm').addEventListener('submit', saveTemplate);
    byId('tplSelect').addEventListener('change', showTemplate);
    byId('tplNew').addEventListener('click', startNewTemplate);
    byId('tplCancelNew').addEventListener('click', showTemplate);
    byId('tplDelete').addEventListener('click', deleteTemplate);
    byId('tplReset').addEventListener('click', resetTemplate);
    byId('tplSkeleton').addEventListener('click', loadSkeleton);
    byId('templateForm').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshTemplatePreview, PREVIEW_DELAY_MS); });
    activateTab('overview');
    byId('failedOrdersOpen').addEventListener('click', () => {
      lists.orders.set('status', 'paid');
      lists.orders.set('invoice', 'missing');
      activateTab('orders');
      lists.orders.reload();
    });
    loadFailedOrdersBanner();
    loadToolLinks();
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
