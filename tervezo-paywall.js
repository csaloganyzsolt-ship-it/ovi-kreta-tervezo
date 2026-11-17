// Fizetési kapu, checkout, számla és kézbesítés.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

// ===== Fizetési kapu (teaser) =====
// FIGYELEM: ez felületi kapu. A teljes terv a böngészőben létezik; a szerveroldali visszatartás a következő lépés.
const PAYWALL_PRICES = { daily: 390, weekly: 390, weekly_detailed: 890 };

const PLAN_LABELS = { daily: 'Napi tervezet', weekly: 'Heti alapcsomag', weekly_detailed: 'Heti részletes csomag (keretterv + 5 napi tervezet)' };

function getPaidSessions() {
  try { return JSON.parse(localStorage.getItem('oviKretaPaidSessions') || '{}') || {}; } catch (_e) { return {}; }
}

function currentPaidSessionId() {
  return getPaidSessions()[lastResult?.generationId] || null;
}

// Egyszeri fizetés: a feloldás csak az adott generált tervhez (generationId) tartozik, és bármely módosításnál megszűnik.
function revokeUnlock(generationId) {
  if (!generationId) return;
  localStorage.setItem('oviKretaUnlocked', JSON.stringify(getUnlockedIds().filter((id) => id !== generationId)));
  const sessions = getPaidSessions();
  delete sessions[generationId];
  localStorage.setItem('oviKretaPaidSessions', JSON.stringify(sessions));
}

function needsOverwriteConfirm() {
  return paywallEnabled() && Boolean(lastResult) && !isPlanLocked();
}

function revokeIfPlanChanged() {
  // A kifizetett terv űrlapmódosításkor sem záródik vissza; csak az új generálás gomb jelenik meg újra.
  if (!paywallEnabled() || !lastResult) return;
  updateExportLock();
}

function isFormDirty() {
  return Boolean(lastResult?.request) && JSON.stringify(buildGenerationPayload()) !== JSON.stringify(lastResult.request);
}

function syncActivitiesControl() {
  const box = document.querySelector('[data-export-section="activities"]');
  const note = document.getElementById('activitiesLockNote');
  if (!box) return;
  const locked = paywallEnabled() && !(lastResult && !isPlanLocked());
  if (locked) {
    box.checked = false;
    box.disabled = true;
    box.dataset.paywallLocked = '1';
  } else {
    if (box.dataset.paywallLocked === '1') { box.checked = true; delete box.dataset.paywallLocked; }
    box.disabled = false;
  }
  if (note) note.hidden = !locked;
}

function showPurchaseNotice(message) {
  const el = document.getElementById('purchaseNotice');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function getUnlockedIds() {
  try { return JSON.parse(localStorage.getItem('oviKretaUnlocked') || '[]'); } catch (_e) { return []; }
}

function paywallEnabled() { return window.APP_CONFIG?.paywallEnabled === true; }

function isPlanLocked(result = lastResult) {
  if (!paywallEnabled() || !result) return false;
  return !getUnlockedIds().includes(result.generationId);
}

function planKind(result = lastResult) {
  if (result?.is_weekly === true) return 'weekly_detailed';
  return result?.request?.duration === 'Heti' ? 'weekly' : 'daily';
}

function newGenerationId() {
  return `gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const LOCK_MESSAGE = 'A részletes tevékenységmenet kidolgozása és a letöltés a terv feloldása után érhető el.';

function applyPaywall(host) {
  if (!isPlanLocked()) return;
  const bodies = host.querySelectorAll('.a4-page-body');
  const body = bodies[bodies.length - 1];
  if (!body) return;
  const gate = document.createElement('div');
  gate.className = 'paywall-gate';
  gate.id = 'paywallGate';
  const meta = (typeof window !== 'undefined' && window.getLockedMeta)
    ? window.getLockedMeta(lastResult)
    : (typeof getLockedMeta === 'function' ? getLockedMeta(lastResult) : { table_count: 1, activity_count: (lastResult?.kidolgozas_tablazat || []).length });
  const summary = (typeof window !== 'undefined' && window.formatExtentSummary)
    ? window.formatExtentSummary(meta.table_count, meta.activity_count)
    : `A teljes dokumentum elkészült: ${meta.table_count} részletes táblázat és ${meta.activity_count} kidolgozott tevékenységi egység vár feloldásra.`;
  const price = PAYWALL_PRICES[planKind(lastResult)] || 390;
  gate.innerHTML = `
          <div class="locked-boundary-badge">Teljes kidolgozás feloldása</div>
          <p>${escapeHtml(summary)}</p>
          <button type="button" class="unlock-cta" id="unlockBtn">Teljes tervezet feloldása – ${price} Ft</button>`;
  body.appendChild(gate);
}

function updateExportLock() {
  const locked = isPlanLocked();
  ['downloadPdfBtn', 'downloadDocxBtn', 'downloadZipBtn', 'printBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = locked;
  });
  const invoiceBtn = document.getElementById('downloadInvoiceBtn');
  if (invoiceBtn) invoiceBtn.hidden = !(paywallEnabled() && lastResult && !locked && currentPaidSessionId());
  syncActivitiesControl();
  const testRow = document.getElementById('testDeliverRow');
  if (testRow) testRow.hidden = !(testDeliveryEnabled() && Boolean(lastResult));
  const onResultStep = currentStep >= 3 && Boolean(lastResult);
  const showCta = paywallEnabled() && Boolean(lastResult) && locked && onResultStep;
  // Fizetés után a generálás gomb elbújik; csak az űrlap módosítása (zárolás) hozza vissza.
  const justPaid = paywallEnabled() && Boolean(lastResult) && !locked && onResultStep;
  nextBtn.hidden = justPaid && !isFormDirty() && !nextBtn.classList.contains('is-busy');
  const price = PAYWALL_PRICES[planKind()];
  const label = `Teljes tervezet feloldása – ${price} Ft`;
  ['unlockNavBtn', 'unlockTopBtn', 'unlockBottomBtn', 'unlockFloatingBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.hidden = !showCta;
    button.textContent = label;
  });
  const bottomNote = document.getElementById('unlockBottomNote');
  if (bottomNote) bottomNote.hidden = !showCta;
  const badge = document.getElementById('unlockedBadge');
  if (badge) badge.hidden = !justPaid;

  const floatingBar = document.getElementById('lockedFloatingBar');
  const floatingText = document.getElementById('lockedFloatingText');
  if (floatingBar) {
    floatingBar.hidden = !showCta;
    if (showCta && floatingText) {
      const meta = (typeof window !== 'undefined' && window.getLockedMeta)
        ? window.getLockedMeta(lastResult)
        : (typeof getLockedMeta === 'function' ? getLockedMeta(lastResult) : { table_count: 1, activity_count: (lastResult?.kidolgozas_tablazat || []).length });
      const summary = (typeof window !== 'undefined' && window.formatExtentSummary)
        ? window.formatExtentSummary(meta.table_count, meta.activity_count)
        : `A teljes dokumentum elkészült: ${meta.table_count} részletes táblázat és ${meta.activity_count} kidolgozott tevékenységi egység vár feloldásra.`;
      floatingText.textContent = summary;
    }
  }
}

function guardLocked() {
  if (!isPlanLocked()) return false;
  openCheckoutModal();
  return true;
}

function openCheckoutModal() {
  const kind = planKind();
  document.getElementById('checkoutSummary').textContent =
    `${PLAN_LABELS[kind]} – ${PAYWALL_PRICES[kind]} Ft`;
  document.getElementById('checkoutError').textContent = '';
  document.getElementById('checkoutTestNote').hidden = window.APP_CONFIG?.company?.stripeTestMode !== true;
  openModal('checkoutModal');
  document.getElementById('checkoutEmail').focus();
}

async function submitCheckout(event) {
  event.preventDefault();
  const errorEl = document.getElementById('checkoutError');
  const email = document.getElementById('checkoutEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errorEl.textContent = 'Adj meg egy érvényes e-mail címet.'; return; }
  if (!document.getElementById('consentTerms').checked || !document.getElementById('consentDigital').checked) {
    errorEl.textContent = 'A fizetéshez mindkét nyilatkozatot el kell fogadni.';
    return;
  }
  const submit = document.getElementById('checkoutSubmit');
  submit.disabled = true;
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planKind(), email, generationId: lastResult.generationId, title: planTitle() }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    localStorage.setItem('oviKretaPendingCheckout', lastResult.generationId);
    if (data.mock) errorEl.textContent = data.message;
    window.location.assign(data.url);
  } catch (error) {
    errorEl.textContent = `A fizetés nem indítható: ${error.message}`;
  } finally {
    submit.disabled = false;
  }
}

function unlockGeneration(generationId, sessionId) {
  const ids = getUnlockedIds();
  if (!ids.includes(generationId)) ids.push(generationId);
  localStorage.setItem('oviKretaUnlocked', JSON.stringify(ids));
  writeDailyCount(0);
  if (sessionId) {
    const sessions = getPaidSessions();
    sessions[generationId] = sessionId;
    localStorage.setItem('oviKretaPaidSessions', JSON.stringify(sessions));
  }
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id') || params.get('checkout_session');
  const cancelled = params.get('payment') === 'cancel' || params.get('checkout') === 'cancelled';
  if (!sessionId && !cancelled) return;
  // A paraméterek törlése után a sima frissítés nem indítja újra a kézbesítést.
  window.history.replaceState({}, '', window.location.pathname);
  if (sessionId && !lastResult) restoreLastGeneration();
  if (cancelled) { showGenerationError('A fizetés megszakadt, a tervezet zárolva maradt.'); return; }
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/checkout-session/${encodeURIComponent(sessionId)}`);
    const data = await response.json();
    if (!response.ok || !data.paid) throw new Error(data.error || 'A fizetés még nem érkezett meg.');
    const pending = localStorage.getItem('oviKretaPendingCheckout') || lastResult?.generationId || data.generationId;
    if (pending) unlockGeneration(pending, sessionId);
    localStorage.removeItem('oviKretaPendingCheckout');
    if (data.planData) {
      lastResult = { ...data.planData, request: lastResult?.request || data.planData.request, generationId: pending };
      try {
        localStorage.setItem(STORAGE_KEYS.generatedPlan, JSON.stringify(lastResult));
      } catch (_e) {}
      markPlanAsPaidInHistory(pending, data.planData);
    } else if (lastResult) {
      markPlanAsPaidInHistory(pending, lastResult);
    }
    if (lastResult) {
      currentStep = steps.length - 1;
      renderStep();
      renderResultDocument(lastResult);
      renderPreview();
      updateExportLock();
    }
    if (data.emailEnabled && lastResult) await deliverPurchaseEmail(sessionId);
  } catch (error) {
    showGenerationError(`A fizetés ellenőrzése sikertelen: ${error.message}`);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadInvoice() {
  const sessionId = currentPaidSessionId();
  if (!sessionId) return;
  const button = document.getElementById('downloadInvoiceBtn');
  button.disabled = true;
  try {
    // A számla a Stripe webhook után készül, ezért néhányszor újrapróbáljuk.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${getApiBaseUrl()}/api/invoice/${encodeURIComponent(sessionId)}`);
      if (response.ok) { downloadBlob(await response.blob(), 'OviTervezo_szamla.pdf'); return; }
      if (response.status !== 404) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      showPurchaseNotice('A számla még készül, kérlek várj egy pillanatot...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error('A számla még nem érhető el. Próbáld újra egy perc múlva.');
  } catch (error) {
    showGenerationError(`A számla letöltése sikertelen: ${error.message}`);
  } finally {
    button.disabled = false;
    showPurchaseNotice('');
  }
}

// Egyetlen közös levél a vevőnek: a tervezetfájlok (napi: PDF+DOCX, heti: ZIP) a szerveren tárolt számlával együtt.
function planTitle() {
  return String(lastResult?.heti_keretterv?.tema || lastResult?.request?.theme || '').trim().slice(0, 200);
}

async function buildDeliveryFiles() {
  const files = [];
  if (lastResult.is_weekly === true) {
    files.push({ name: 'OviTervezo_heti_csomag.zip', base64: await blobToBase64(await buildZipBlob()) });
  } else {
    const doc = getDocumentList()[0];
    files.push({ name: `${doc.fileBase}.pdf`, base64: await blobToBase64(await renderPdfBlob(doc.id)) });
    files.push({ name: `${doc.fileBase}.docx`, base64: await blobToBase64(await renderDocxBlob(doc.id)) });
  }
  return files;
}

// Staging: ugyanaz a melléklet-előállítás, de fizetés és számla nélkül (csak ha a config testDelivery=true és nincs fizetési kapu).
function testDeliveryEnabled() { return window.APP_CONFIG?.testDelivery === true && !paywallEnabled(); }

async function sendTestDelivery() {
  const email = document.getElementById('testDeliverEmail').value.trim();
  const button = document.getElementById('testDeliverBtn');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showPurchaseNotice('Adj meg egy érvényes e-mail címet.'); return; }
  button.disabled = true;
  const controller = new AbortController();
  let timer;
  try {
    showPurchaseNotice('Fájlok előállítása és küldés...');
    const files = await buildDeliveryFiles();
    timer = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(`${getApiBaseUrl()}/api/test-deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, files, plan: planKind(), title: planTitle() }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    showPurchaseNotice(`A tesztlevelet elküldtük ide: ${email}`);
  } catch (error) {
    showPurchaseNotice('');
    const reason = error.name === 'AbortError' ? 'a szerver 20 másodpercen belül nem válaszolt' : error.message;
    showGenerationError(`A tesztlevél kiküldése sikertelen: ${reason}`);
  } finally {
    clearTimeout(timer);
    button.disabled = false;
  }
}

async function deliverPurchaseEmail(sessionId) {
  try {
    showPurchaseNotice('A megvásárolt anyagokat e-mailben is elküldjük...');
    const files = await buildDeliveryFiles();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${getApiBaseUrl()}/api/deliver/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, title: planTitle() }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 3000)); continue; }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      showPurchaseNotice(data.sent ? 'A tervezetet és az e-számlát elküldtük a megadott e-mail címre.' : '');
      return;
    }
    throw new Error('A számla még nem készült el.');
  } catch (error) {
    showPurchaseNotice('');
    showGenerationError(`Az e-mail kiküldése sikertelen (a letöltés ettől még működik): ${error.message}`);
  }
}
