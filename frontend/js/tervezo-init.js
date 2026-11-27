// Eseménykötések és az alkalmazás belépési pontja.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('#wizardProgressToggle');
  if (!toggle) return;
  const open = toggle.closest('.wizard').classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('.segment[data-group="energy"], .segment[data-group="detail"], .segment[data-group="weeklyScope"]').forEach((option) => {
  option.addEventListener('click', () => {
    setChoice(option.dataset.group, option.dataset.value);
    if (option.dataset.group === 'weeklyScope') updateWeeklyDailyBreakdownVisibility();
    updateSummary();
    persistDraftState();
  });
});

document.getElementById('documentTabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-doc-id]');
  if (tab) selectDocument(tab.dataset.docId);
});

document.getElementById('downloadZipBtn').addEventListener('click', exportAllAsZip);

nextBtn.addEventListener('click', () => {
  if (currentStep < steps.length - 1) {
    currentStep += 1;
    renderStep();
    scrollToFormTop();
  } else if (needsOverwriteConfirm() && !readCachedGeneration(buildGenerationPayload())) {
    openModal('confirmRegenModal');
  } else {
    requestGeneration();
  }
});

document.getElementById('confirmRegenYes').addEventListener('click', () => {
  closeModals();
  requestGeneration();
});

backBtn.addEventListener('click', () => {
  if (currentStep > 0) {
    currentStep -= 1;
    renderStep();
    scrollToFormTop();
  }
});

wizardItems.forEach((item) => {
  item.addEventListener('click', () => {
    currentStep = Number(item.dataset.step);
    renderStep();
    scrollToFormTop();
  });
});

document.getElementById('downloadPdfBtn').addEventListener('click', exportAsPdf);

document.getElementById('downloadDocxBtn').addEventListener('click', exportAsDocx);

document.getElementById('clearDraftBtn').addEventListener('click', clearDraftState);

const printBtn = document.createElement('button');

printBtn.id = 'printBtn';

printBtn.type = 'button';

printBtn.className = 'download-btn';

printBtn.textContent = 'Nyomtatás';

window.addEventListener('beforeprint', applyPrintPageStyle);

printBtn.addEventListener('click', () => window.print());

const downloadRow = document.querySelector('.download-row');

if (downloadRow) {
  downloadRow.appendChild(printBtn);
}

function initFooterAndModals() {
  document.addEventListener('click', (event) => {
    if (event.target.closest('.unlock-cta')) openCheckoutModal();
  });
  // Az űrlap sosem töltődik újra: egyetlen fizetési út van, a Barion gomb.
  document.getElementById('checkoutForm').addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('checkAll')?.addEventListener('click', checkAllConsents);
  for (const [id, eventName] of [['cb-terms', 'change'], ['cb-digital', 'change'], ['checkoutEmail', 'input'], ['checkoutEmail', 'change'],
    ['billingName', 'input'], ['billingZip', 'input'], ['billingCity', 'input'], ['billingAddress', 'input']]) {
    document.getElementById(id).addEventListener(eventName, syncCheckoutButtons);
  }
  document.getElementById('checkoutBarion').addEventListener('click', startBarionCheckout);
  document.getElementById('checkoutStripe').addEventListener('click', startStripeCheckout);
  document.getElementById('couponApply').addEventListener('click', applyCouponCode);
  // Enterre a kuponkód érvényesül, nem indul el a fizetés.
  document.getElementById('couponCode').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyCouponCode();
  });
  syncCheckoutButtons();
  document.getElementById('downloadInvoiceBtn').addEventListener('click', downloadInvoice);
  document.getElementById('attachedPlanRemoveBtn')?.addEventListener('click', clearAttachedPreviousPlan);
  loadPreviousBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    historyPanel?.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#loadPreviousBtn') && !e.target.closest('#historyPanel')) {
      historyPanel?.classList.remove('open');
    }
  });
}

// A nyilvános beállítások (árak, karbantartás, szezonális javaslatok) betöltése. Hiba esetén a felület hangosan jelez, nincs kamu adat.
function applyPublicConfig(config) {
  const prices = config.pricing || {};
  const byKind = { daily: prices.daily, weekly_summary: prices.daily, weekly_package: prices.weekly, academic_daily: prices.academic_daily, academic_weekly: prices.academic_weekly };
  Object.entries(byKind).forEach(([kind, price]) => {
    if (Number.isInteger(price) && price > 0) PAYWALL_PRICES[kind] = price;
  });
  appConfig.maintenance = config.maintenance_mode === true;
  appConfig.seasonalHints = Array.isArray(config.seasonal_hints) ? config.seasonal_hints.filter((hint) => typeof hint === 'string' && hint.trim()) : [];
  appConfig.loaded = true;
  renderSeasonalThemeSuggestions();
  renderStep();
  updateExportLock();
}

async function loadPublicConfig() {
  const apiBaseUrl = getApiBaseUrl();
  if (!apiBaseUrl) return;
  try {
    const response = await fetch(`${apiBaseUrl}/api/config`, { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || `HTTP ${response.status}`);
    applyPublicConfig(data);
  } catch (error) {
    console.error('A rendszerbeállítások nem tölthetők be:', error);
    const note = document.getElementById('configError');
    if (note) {
      note.textContent = 'A friss árak és beállítások most nem tölthetők be. Kérjük, frissítsd az oldalt.';
      note.hidden = false;
    }
  }
}

function initializeApp() {
  if (window.__oviKretaAppInitialized) return;
  window.__oviKretaAppInitialized = true;

  renderSeasonalThemeSuggestions();
  loadPublicConfig();
  loadProfileFromStorage();
  loadDraftFromStorage();
  loadGeneratedPlanFromStorage();
  bindAutoSaveListeners();
  updateDateInputsForDuration();
  updateWeeklyDailyBreakdownVisibility();
  renderHistoryPanel();
  renderStep();
  updateSummary();
  renderResultDocument();
  updateExportLock();
  renderPreview();
  document.getElementById('restoreLastBtn')?.addEventListener('click', restoreLastGeneration);
  refreshRestoreBanner();
  initFooterAndModals();
  handleCheckoutReturn();
}

document.addEventListener('DOMContentLoaded', initializeApp);

if (document.readyState !== 'loading') {
  initializeApp();
}
