// Eseménykötések és az alkalmazás belépési pontja.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('#wizardProgressToggle');
  if (!toggle) return;
  const open = toggle.closest('.wizard').classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('.segment[data-group="energy"], .segment[data-group="detail"]').forEach((option) => {
  option.addEventListener('click', () => {
    setChoice(option.dataset.group, option.dataset.value);
    updateSummary();
    persistDraftState();
  });
});

document.querySelectorAll('[data-export-section], [data-export="margin"], [data-export="orientation"]').forEach((control) => {
  control.addEventListener('change', () => {
    if (control.matches('[data-export="margin"], [data-export="orientation"]')) {
      const key = currentDocKey();
      docSettings[key] = {
        ...getDocSettings(key),
        [control.dataset.export]: control.value
      };
      persistDraftState();
    }
    if (lastResult) {
      renderResultDocument(lastResult);
    } else {
      applyExportSettingsToDocument();
    }
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
    generatePlan();
  }
});

document.getElementById('testDeliverBtn').addEventListener('click', sendTestDelivery);

document.getElementById('confirmRegenYes').addEventListener('click', () => {
  closeModals();
  generatePlan();
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
  document.getElementById('checkoutForm').addEventListener('submit', submitCheckout);
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

function initializeApp() {
  if (window.__oviKretaAppInitialized) return;
  window.__oviKretaAppInitialized = true;

  renderSeasonalThemeSuggestions();
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
