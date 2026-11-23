// Fizetési kapu, checkout, számla és kézbesítés.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

// ===== Fizetési kapu (teaser) =====
// FIGYELEM: ez felületi kapu. A teljes terv a böngészőben létezik; a szerveroldali visszatartás a következő lépés.
// Az oktatási célú (academic) tervezet napi és heti formában is 690 Ft; a szerver (services/pricing.js) a mérvadó, a teszt egyezésüket ellenőrzi.
const PAYWALL_PRICES = { daily: 390, weekly: 390, weekly_detailed: 890, academic_daily: 690, academic_weekly: 690 };

const PLAN_LABELS = {
  daily: 'Napi tervezet',
  weekly: 'Heti alapcsomag',
  weekly_detailed: 'Heti részletes csomag (keretterv + 5 napi tervezet)',
  academic_daily: 'Oktatási célú napi tervezet',
  academic_weekly: 'Oktatási célú heti tematikus terv'
};

function getPaidSessions() {
  try { return JSON.parse(localStorage.getItem('oviKretaPaidSessions') || '{}') || {}; } catch (_e) { return {}; }
}

function currentPaidSessionId() {
  return getPaidSessions()[lastResult?.generationId] || null;
}

// A kuponos feloldásnak nincs számlája.
function isCouponSession(sessionId) {
  return String(sessionId || '').startsWith('coupon_');
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
  const weekly = result?.is_thematic === true || result?.request?.duration === 'Heti';
  if (isAcademicResult(result)) return weekly ? 'academic_weekly' : 'academic_daily';
  return weekly ? 'weekly' : 'daily';
}

function currentPlanMode(result = lastResult) {
  return isAcademicResult(result) ? 'academic' : 'standard';
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
          <button type="button" class="unlock-cta" id="unlockBtn">Teljes tervezet feloldása – ${escapeHtml(price)} Ft</button>`;
  body.appendChild(gate);
}

function updateExportLock() {
  const locked = isPlanLocked();
  ['downloadPdfBtn', 'downloadDocxBtn', 'downloadZipBtn', 'printBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = locked;
  });
  const invoiceBtn = document.getElementById('downloadInvoiceBtn');
  const paidSession = currentPaidSessionId();
  if (invoiceBtn) invoiceBtn.hidden = !(paywallEnabled() && lastResult && !locked && paidSession && !isCouponSession(paidSession));
  const onResultStep = currentStep >= 3 && Boolean(lastResult);
  // A fizetési felület csak kész, zárolt előnézetnél él: generálás közben vagy az előnézet nélkül nem jelenhet meg.
  const showCta = paywallEnabled() && Boolean(lastResult) && locked && onResultStep && previewReady && !generationInFlight
    && Boolean(document.getElementById('paywallGate'));
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
  if (generationInFlight || !lastResult) return;
  renderCheckoutPrice();
  document.getElementById('checkoutError').textContent = '';
  syncCheckoutButtons();
  document.getElementById('checkoutTestNote').hidden = window.APP_CONFIG?.company?.stripeTestMode !== true;
  openModal('checkoutModal');
  document.getElementById('checkoutEmail').focus();
  prefillCheckoutFromProfile();
}

// Bejelentkezett felhasználónál a profil mentett számlázási adatai kitöltik az üres mezőket (a már beírt értéket nem írják felül).
// A fizetés indításakor a szerver a megadott (vagy módosított) adatokat visszaírja a profilba, ezért itt nincs külön mentés.
const PROFILE_BILLING_FIELDS = { billingName: 'billing_name', billingZip: 'billing_zip', billingCity: 'billing_city', billingAddress: 'billing_address' };

async function prefillCheckoutFromProfile() {
  const auth = window.OviAuth;
  const user = auth?.getUser?.();
  if (!user) return;
  const emailInput = document.getElementById('checkoutEmail');
  if (emailInput && !emailInput.value.trim()) emailInput.value = user.email;
  try {
    const { profile } = await auth.apiFetch('/api/profile');
    Object.entries(PROFILE_BILLING_FIELDS).forEach(([id, key]) => {
      const input = document.getElementById(id);
      if (input && !input.value.trim() && profile[key]) input.value = profile[key];
    });
  } catch (error) {
    console.error('[profil] A számlázási adatok betöltése sikertelen:', error.message);
    document.getElementById('checkoutError').textContent = `A mentett számlázási adataid nem tölthetők be (${error.message}). Add meg őket kézzel.`;
  }
  syncCheckoutButtons();
}

const CHECKOUT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const BILLING_ZIP_PATTERN = /^[0-9A-Za-z][0-9A-Za-z -]{2,9}$/;

// A Barion-fizetés csak akkor kattintható, ha mindkét nyilatkozat be van pipálva, az e-mail cím érvényes és a számlázási mezők ki vannak töltve.
function checkoutFormReady() {
  return Boolean(document.getElementById('consentTerms')?.checked)
    && Boolean(document.getElementById('consentDigital')?.checked)
    && CHECKOUT_EMAIL_PATTERN.test(String(document.getElementById('checkoutEmail')?.value || '').trim())
    && Boolean(readBilling());
}

function syncCheckoutButtons() {
  const button = document.getElementById('checkoutBarion');
  if (button) button.disabled = !checkoutFormReady();
}

// A Számlázz.hu számlához kötelező vevői adatok; hiányos vagy túl rövid érték esetén null.
function readBilling() {
  const value = (id) => String(document.getElementById(id)?.value || '').replace(/\s+/g, ' ').trim();
  const billing = { name: value('billingName'), zip: value('billingZip'), city: value('billingCity'), address: value('billingAddress') };
  if (billing.name.length < 2 || !BILLING_ZIP_PATTERN.test(billing.zip) || billing.city.length < 2 || billing.address.length < 3) return null;
  return billing;
}

// Közös ellenőrzés a fizetéshez és a kuponhoz; hibánál kiírja az okot és null-t ad. A számlázási adat csak a fizetésnél kötelező.
function readCheckoutForm({ billing = false } = {}) {
  const errorEl = document.getElementById('checkoutError');
  const email = document.getElementById('checkoutEmail').value.trim();
  if (!CHECKOUT_EMAIL_PATTERN.test(email)) { errorEl.textContent = 'Adj meg egy érvényes e-mail címet.'; return null; }
  const billingData = billing ? readBilling() : null;
  if (billing && !billingData) {
    errorEl.textContent = 'Add meg a számlázási nevet, az irányítószámot, a települést és az utcát, házszámot.';
    return null;
  }
  if (!document.getElementById('consentTerms').checked) {
    errorEl.textContent = 'A fizetéshez el kell fogadnod az ÁSZF-et és az Adatvédelmi tájékoztatót.';
    return null;
  }
  if (!document.getElementById('consentDigital').checked) {
    errorEl.textContent = 'A fizetéshez mindkét nyilatkozatot el kell fogadni.';
    return null;
  }
  errorEl.textContent = '';
  return { email, billing: billingData };
}

function redirectTo(url) {
  window.location.assign(url);
}

const BARION_GATEWAY_PATTERN = /^https:\/\/secure(\.test)?\.barion\.com\//;
const PENDING_BARION_KEY = 'oviKretaPendingBarion';

// Barion fizetés: a szerver elindítja a Payment/Start hívást, a felhasználó a kapott GatewayUrl-re megy; a visszatérést a handleCheckoutReturn kezeli.
async function startBarionCheckout() {
  const form = readCheckoutForm({ billing: true });
  if (!form) return;
  const errorEl = document.getElementById('checkoutError');
  document.getElementById('checkoutBarion').disabled = true;
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/checkout-barion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ plan: planKind(), planMode: currentPlanMode(), email: form.email, billing: form.billing, generationId: lastResult.generationId, title: planTitle() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const failure = new Error(data.error || `HTTP ${response.status}`);
      failure.code = data.code;
      throw failure;
    }
    if (!BARION_GATEWAY_PATTERN.test(String(data.gatewayUrl || ''))) throw new Error('A Barion érvénytelen fizetési címet adott vissza.');
    localStorage.setItem('oviKretaPendingCheckout', lastResult.generationId);
    localStorage.setItem(PENDING_BARION_KEY, data.sessionId);
    redirectTo(data.gatewayUrl);
  } catch (error) {
    if (error.code === 'INVALID_COUPON') {
      localStorage.removeItem(APPLIED_COUPON_KEY);
      renderCheckoutPrice();
      errorEl.textContent = `A kupon már nem érvényes (${error.message}) Kattints újra a fizetésre a teljes áron.`;
    } else if (error.message === 'A Barion érvénytelen fizetési címet adott vissza.') {
      errorEl.textContent = error.message;
    } else {
      errorEl.textContent = 'Hiba történt a fizetés indításakor. Kérjük, frissítsd az oldalt (F5), és próbáld újra!';
    }
  } finally {
    syncCheckoutButtons();
  }
}

// Részleges kupon: a szerver a dokumentumhoz menti a kedvezményt, a böngésző csak a kijelzéshez őrzi meg (a fizetendő összeget a szerver számolja).
const APPLIED_COUPON_KEY = 'oviKretaAppliedCoupon';

function getAppliedDiscount() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPLIED_COUPON_KEY) || 'null');
    return saved && saved.generationId === lastResult?.generationId && saved.plan === planKind() ? saved : null;
  } catch (_e) { return null; }
}

function discountMessage(discount) {
  return `Kupon elfogadva (-${discount.percent}%): fizetendő ${discount.finalPrice} Ft`;
}

function renderCheckoutPrice() {
  const kind = planKind();
  const discount = getAppliedDiscount();
  document.getElementById('checkoutSummary').textContent = discount
    ? `${PLAN_LABELS[kind]} – ${discount.finalPrice} Ft (eredeti ár: ${PAYWALL_PRICES[kind]} Ft)`
    : `${PLAN_LABELS[kind]} – ${PAYWALL_PRICES[kind]} Ft`;
  document.getElementById('couponStatus').textContent = discount ? discountMessage(discount) : '';
}

// Kupon: 100%-os kódnál a szerver fizetés és számla nélkül feloldja a tervet; részleges kódnál a Barion-fizetés a kedvezményes összegre indul.
async function applyCouponCode() {
  const statusEl = document.getElementById('couponStatus');
  const errorEl = document.getElementById('checkoutError');
  const code = document.getElementById('couponCode').value.trim();
  if (!code) { statusEl.textContent = 'Add meg a kuponkódot.'; return; }
  const form = readCheckoutForm();
  if (!form) return;
  const button = document.getElementById('couponApply');
  button.disabled = true;
  statusEl.textContent = '';
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/apply-coupon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ code, plan: planKind(), planMode: currentPlanMode(), email: form.email, generationId: lastResult.generationId, title: planTitle() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
    if (!data.paid) {
      localStorage.setItem(APPLIED_COUPON_KEY, JSON.stringify({ generationId: lastResult.generationId, plan: planKind(), code: data.coupon.code, percent: data.coupon.percent, finalPrice: data.finalPrice }));
      document.getElementById('couponCode').value = '';
      renderCheckoutPrice();
      return;
    }
    localStorage.removeItem(APPLIED_COUPON_KEY);
    closeModals();
    document.getElementById('couponCode').value = '';
    showUnlockedPlan(lastResult.generationId, data.sessionId, data.planData);
    showPurchaseNotice('A kupon érvényes: a tervezet feloldva, letölthető.');
    if (data.emailEnabled && lastResult) await deliverPurchaseEmail(data.sessionId);
  } catch (error) {
    errorEl.textContent = '';
    statusEl.textContent = `A kupon nem érvényesíthető: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function unlockGeneration(generationId, sessionId) {
  const ids = getUnlockedIds();
  if (!ids.includes(generationId)) ids.push(generationId);
  localStorage.setItem('oviKretaUnlocked', JSON.stringify(ids));
  localStorage.removeItem(APPLIED_COUPON_KEY);
  writeDailyCount(0);
  if (sessionId) {
    const sessions = getPaidSessions();
    sessions[generationId] = sessionId;
    localStorage.setItem('oviKretaPaidSessions', JSON.stringify(sessions));
  }
}

// Sikeres fizetés vagy kupon után: a terv feloldása, a teljes tartalom megjelenítése a webes nézetben.
function showUnlockedPlan(generationId, sessionId, planData) {
  if (generationId) unlockGeneration(generationId, sessionId);
  if (planData) {
    lastResult = { ...planData, request: lastResult?.request || planData.request, generationId };
    try {
      localStorage.setItem(STORAGE_KEYS.generatedPlan, JSON.stringify(lastResult));
    } catch (_e) {}
    markPlanAsPaidInHistory(generationId, planData);
  } else if (lastResult) {
    markPlanAsPaidInHistory(generationId, lastResult);
  }
  if (lastResult) {
    currentStep = steps.length - 1;
    renderStep();
    renderResultDocument(lastResult);
    renderPreview();
    updateExportLock();
  }
}

const RETURN_POLL = { attempts: 20, delayMs: 3000 };

// A Barion visszatéréskor még függőben lehet (a visszahívás késik): addig kérdezzük a státuszt, amíg el nem dől.
async function fetchSessionState(sessionId, poll) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${getApiBaseUrl()}/api/checkout-session/${encodeURIComponent(sessionId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.paid || !data.pending || !poll || attempt >= RETURN_POLL.attempts) return data;
    showPurchaseNotice('A Barion fizetés megerősítésére várunk...');
    await new Promise((resolve) => setTimeout(resolve, RETURN_POLL.delayMs));
  }
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const urlSession = params.get('session_id') || params.get('checkout_session');
  // Ha a Barion-oldalról nem tért vissza a felhasználó, a következő betöltéskor egyszer rákérdezünk a függő fizetésre.
  const resumed = !urlSession && localStorage.getItem(PENDING_BARION_KEY);
  const sessionId = urlSession || resumed;
  const cancelled = params.get('payment') === 'cancel' || params.get('checkout') === 'cancelled';
  if (!sessionId && !cancelled) return;
  // A paraméterek törlése után a sima frissítés nem indítja újra a kézbesítést.
  window.history.replaceState({}, '', window.location.pathname);
  if (sessionId && !lastResult) restoreLastGeneration();
  if (cancelled) { showGenerationError('A fizetés megszakadt, a tervezet zárolva maradt.'); return; }
  try {
    const data = await fetchSessionState(sessionId, !resumed);
    if (!data.paid && data.provider === 'barion') {
      showPurchaseNotice('');
      if (data.pending) {
        if (!resumed) showGenerationError('A Barion fizetés megerősítése még tart. Az oldal újratöltésekor a tervezet automatikusan feloldódik, ha a fizetés sikeres volt.');
      } else {
        localStorage.removeItem(PENDING_BARION_KEY);
        if (!resumed) showGenerationError('A Barion fizetés megszakadt vagy sikertelen volt, a tervezet zárolva maradt.');
      }
      return;
    }
    if (!data.paid) throw new Error(data.error || 'A fizetés még nem érkezett meg.');
    const pending = localStorage.getItem('oviKretaPendingCheckout') || lastResult?.generationId || data.generationId;
    localStorage.removeItem('oviKretaPendingCheckout');
    localStorage.removeItem(PENDING_BARION_KEY);
    showPurchaseNotice('');
    showUnlockedPlan(pending, sessionId, data.planData);
    if (data.emailEnabled && lastResult) await deliverPurchaseEmail(sessionId);
  } catch (error) {
    showPurchaseNotice('');
    // Az automatikus újrakérdezés egyszeri: hibánál nem zaklatja a felhasználót minden betöltéskor.
    if (resumed) { localStorage.removeItem(PENDING_BARION_KEY); return; }
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

async function deliverPurchaseEmail(sessionId) {
  try {
    showPurchaseNotice('A megvásárolt anyagokat e-mailben is elküldjük...');
    const files = await buildDeliveryFiles();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${getApiBaseUrl()}/api/deliver/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, planMode: currentPlanMode(), title: planTitle() }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 3000)); continue; }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      showPurchaseNotice(data.sent ? (isCouponSession(sessionId) ? 'A tervezetet elküldtük a megadott e-mail címre.' : 'A tervezetet és az e-számlát elküldtük a megadott e-mail címre.') : '');
      return;
    }
    throw new Error('A számla még nem készült el.');
  } catch (error) {
    showPurchaseNotice('');
    showGenerationError(`Az e-mail kiküldése sikertelen (a letöltés ettől még működik): ${error.message}`);
  }
}
