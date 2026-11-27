// Űrlapállapot, piszkozat, generálási payload, előzmények és varázsló-lépések.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

function readStoredGeneration() {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.lastGeneration) || 'null');
    return cached && cached.result && cached.result.request ? cached : null;
  } catch (_error) { return null; }
}

function refreshRestoreBanner() {
  const banner = document.getElementById('restoreBanner');
  if (!banner) return;
  const cached = readStoredGeneration();
  const waiting = Boolean(cached) && !getUnlockedIds().includes(cached.result.generationId);
  banner.hidden = !(waiting && !(previewReady && currentStep >= 3));
}

function restoreLastGeneration() {
  const cached = readStoredGeneration();
  if (!cached) return;
  if (cached.draft) applyDraftState(cached.draft);
  updateDateInputsForDuration();
  renderResultDocument(cached.result);
  lastResult = cached.result;
  previewReady = true;
  currentStep = steps.length - 1;
  updateSummary();
  renderStep();
  refreshRestoreBanner();
  document.getElementById('previewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function readCachedGeneration(payload) {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.lastGeneration) || 'null');
    if (cached && cached.payload === JSON.stringify(payload) && cached.result) return cached.result;
  } catch (_error) { /* hibás gyorsítótár */ }
  return null;
}

function resolveActiveDurationFromDom() {
  const activeSegment = document.querySelector('.segment.active[data-group="duration"]');
  const value = (activeSegment?.dataset?.value || activeSegment?.textContent || '').trim();
  return value || 'Napi';
}

function getSelectedDuration() {
  return resolveActiveDurationFromDom();
}

const ALL_WEEKDAYS = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];

// 'standard' = óvodai tervezet, 'academic' = oktatási célú (egyetemi) tervezet.
function getPlanMode() {
  return document.querySelector('.plan-mode-card.active')?.dataset.planMode === 'academic' ? 'academic' : 'standard';
}

function isAcademicMode() {
  return getPlanMode() === 'academic';
}

function setPlanMode(mode) {
  const next = mode === 'academic' ? 'academic' : 'standard';
  document.querySelectorAll('.plan-mode-card').forEach((card) => {
    const active = card.dataset.planMode === next;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-plan-mode-info]').forEach((info) => {
    info.classList.toggle('active', info.dataset.planModeInfo === next);
  });
  const extra = document.getElementById('planModeAcademicExtra');
  if (extra) extra.hidden = next !== 'academic';
  updateWeeklyDailyBreakdownVisibility();
}

// Heti módban két választás van: csak összesítő (summary) vagy teljes csomag (package: összesítő + napi tervek).
function getWeeklyScope() {
  if (getSelectedDuration() !== 'Heti' || isAcademicMode()) return undefined;
  return getChoice('weeklyScope', 'summary') === 'package' ? 'package' : 'summary';
}

function getSelectedDays() {
  const active = Array.from(document.querySelectorAll('#weeklyDayPicker .day-chip.active')).map((chip) => chip.dataset.day);
  const days = ALL_WEEKDAYS.filter((day) => active.includes(day));
  return days.length ? days : [...ALL_WEEKDAYS];
}

function setSelectedDays(days) {
  const wanted = Array.isArray(days) ? ALL_WEEKDAYS.filter((day) => days.includes(day)) : [];
  const next = wanted.length ? wanted : ALL_WEEKDAYS;
  document.querySelectorAll('#weeklyDayPicker .day-chip').forEach((chip) => {
    const on = next.includes(chip.dataset.day);
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
}

function toggleWeekday(chip) {
  const hint = document.getElementById('weeklyDaysHint');
  const isActive = chip.classList.contains('active');
  if (isActive && getSelectedDays().length <= 1) {
    if (hint) {
      hint.textContent = 'Legalább egy napot ki kell választani!';
      hint.classList.add('field-warning');
    }
    return false;
  }
  chip.classList.toggle('active', !isActive);
  chip.setAttribute('aria-pressed', String(!isActive));
  if (hint) hint.classList.remove('field-warning');
  return true;
}

function describeDuration(payload) {
  if (payload.duration !== 'Heti') return payload.duration;
  if (payload.planMode === 'academic') return 'Heti tematikus terv (egy hét)';
  return payload.weeklyScope === 'package'
    ? `Teljes heti csomag (${(payload.selectedDays || []).join(', ')})`
    : 'Csak heti összesítő';
}

function getWeeklyProgressionType() {
  return document.getElementById('weeklyProgressionType')?.value || 'progressive';
}

function getFridayClosingType() {
  return document.getElementById('fridayClosingType')?.value || 'Kiállítás a csoportszobában';
}

function updateFocusAreaDayRows() {
  const isWeekly = getSelectedDuration() === 'Heti' && !isAcademicMode();
  document.querySelectorAll('.focus-area-card').forEach((card) => {
    const checkbox = card.querySelector('input[data-focus-area]');
    const dayRow = card.querySelector('.focus-area-day-row');
    if (dayRow) {
      dayRow.hidden = !(isWeekly && checkbox?.checked);
    }
  });
}

function updateWeeklyDailyBreakdownVisibility() {
  const isWeekly = getSelectedDuration() === 'Heti' && !isAcademicMode();
  const panel = document.getElementById('weeklySettingsPanel');
  if (panel) panel.hidden = !isWeekly;
  const advancedBlock = document.getElementById('weeklyAdvancedBlock');
  if (advancedBlock) advancedBlock.hidden = !isWeekly;
  const daysBlock = document.getElementById('weeklyDaysBlock');
  if (daysBlock) daysBlock.hidden = !(isWeekly && getChoice('weeklyScope', 'summary') === 'package');
  const dailyFocusField = document.getElementById('dailyFocusAreaField');
  if (dailyFocusField) dailyFocusField.hidden = false;
  updateFocusAreaDayRows();
}

function getWeeklyFocusAreas() {
  const result = {};
  document.querySelectorAll('.focus-area-card').forEach((card) => {
    const checkbox = card.querySelector('input[data-focus-area]');
    if (!checkbox || !checkbox.checked) return;
    const area = checkbox.dataset.focusArea;
    const select = card.querySelector('.focus-area-day-select');
    const day = select?.value || 'any';
    if (area && day !== 'any') {
      if (!result[day]) result[day] = [];
      result[day].push(area);
    }
  });
  return result;
}

const ENERGY_DEFAULT = 'Átlagos';

const DETAIL_LEVELS = { concise: 30, detailed: 68, extended: 90 };

function getChoice(group, fallback) {
  return document.querySelector(`.segment.active[data-group="${group}"]`)?.dataset.value || fallback;
}

function setChoice(group, value, fallback) {
  const options = Array.from(document.querySelectorAll(`.segment[data-group="${group}"]`));
  const target = options.some((option) => option.dataset.value === value) ? value : fallback;
  options.forEach((option) => option.classList.toggle('active', option.dataset.value === target));
}

function getAvailableTools() {
  return document.querySelector('[data-field="available-tools"]')?.value.trim() || '';
}

function getIktEnabled() {
  return Boolean(document.getElementById('iktEnabled')?.checked);
}

function syncIktPanel() {
  const iktToggle = document.getElementById('iktEnabled');
  const enabled = Boolean(iktToggle?.checked);
  const statusLabel = document.getElementById('iktToggleStatusLabel');
  if (statusLabel) statusLabel.textContent = enabled ? 'Igen' : 'Nem';
  const panel = document.getElementById('iktOptionsPanel');
  if (panel) panel.hidden = !enabled;
}

function getSelectedIktTools() {
  return Array.from(document.querySelectorAll('#iktToolsPicker [data-ikt-tool].active')).map((btn) => btn.dataset.iktTool);
}

function getIktCustomApp() {
  return document.getElementById('iktCustomApp')?.value.trim() || '';
}

function getBlacklist() {
  return document.querySelector('[data-field="blacklist"]')?.value.trim() || '';
}

// Rarely used settings stay collapsed unless they already hold a non-default value.
function syncAdvancedSettingsOpenState() {
  const details = document.getElementById('advancedSettings');
  if (!details) return;
  const hasCustomValue = Boolean(getBlacklist()) ||
    Boolean(document.querySelector('[data-field="elozmeny"]')?.value.trim()) ||
    Boolean(document.querySelector('[data-field="show-literature"]')?.checked) ||
    getIktEnabled() ||
    Boolean(getIktCustomApp()) ||
    (getSelectedDuration() === 'Heti' && (
      getWeeklyProgressionType() !== 'progressive' ||
      getFridayClosingType() !== 'Kiállítás a csoportszobában'));
  if (hasCustomValue) details.open = true;
}

function getTheme() {
  return document.querySelector('input[data-field="theme"]')?.value || 'Téma';
}

function getDateValue() {
  const isWeekly = getSelectedDuration() === 'Heti';
  const weeklyInput = document.querySelector('input[data-field="week-value"]');
  const dailyInput = document.querySelector('input[data-field="date-value"]');
  if (isWeekly) return weeklyInput?.value || '';
  return dailyInput?.value || '';
}

function getGroup() {
  return document.querySelector('select[data-field="group"]')?.value || 'Nagycsoport';
}

function renderSummaryChecklist() {
  const checklist = document.getElementById('summaryChecklist');
  if (!checklist) return;

  const payload = buildGenerationPayload();
  const { selectedGoals, specialNeeds, customNotes } = payload;
  const none = 'Nincs megadva';
  const isWeekly = payload.duration === 'Heti';
  const progressionLabels = {
    progressive: 'Szervesen egymásra épülő projekt',
    area_focused: 'Klasszikus területváltó'
  };
  const defaultToolsText = 'Nincs megadva – az AI az óvodákban általánosan megtalálható alapfelszereléseket (papír, olló, ceruza, labda, stb.) veszi alapul';
  const academic = payload.planMode === 'academic';
  const weeklyOnly = (value) => {
    if (academic) return `${value} (oktatási célú tervnél nem érvényes)`;
    return isWeekly ? value : `${value} (csak heti tervnél érvényes)`;
  };

  const sections = [
    ['Téma és időkeret', [
      `Tervezet típusa: ${payload.planMode === 'academic' ? 'Oktatási célú tervezet' : 'Óvodai tervezet'}`,
      ...(payload.planMode === 'academic' ? [`Hallgató / Óvodapedagógus: ${payload.studentName || none}`] : []),
      `Időtartam: ${describeDuration(payload)}`,
      `${isWeekly ? 'Hét' : 'Dátum'}: ${payload.dateValue || none}`,
      `Korcsoport: ${payload.group}`,
      `Téma: ${payload.theme || none}`,
      `Tevékenységi forma: ${payload.tevekenysegForma || none}`,
      `Nevelési területek: ${isWeekly
        ? (payload.focusAreas.length
            ? payload.focusAreas.map((area) => {
                const days = Object.entries(payload.weeklyFocusAreas || {}).filter(([, list]) => list.includes(area)).map(([day]) => day);
                return `${area}${days.length ? ` (${days.join(', ')})` : ' (bármelyik nap)'}`;
              }).join('; ')
            : 'Nincs kiválasztva (általános heti elosztás)')
        : (payload.focusAreas.join(', ') || 'Nincs kiválasztva')}`,
      `Óvoda: ${payload.kindergartenName || none}`,
      `Óvoda arculata: ${payload.kindergartenProfile || none}`,
      `Óvodapedagógus: ${payload.teacherName || none}`,
      `Csoport neve: ${payload.groupName || none}`,
      `Saját megjegyzés: ${customNotes.primary || none}`
    ]],
    ['A csoport profilja', [
      `Gyereklétszám: ${payload.childCount ?? none}`,
      `Csoport hangulata, mozgékonysága: ${payload.energyLevel}`,
      `Iskola-előkészítő gyermekek: ${payload.hasPreschoolers ? 'igen' : 'nem'}`,
      `Speciális nevelési igények (SNI): ${specialNeeds.join(', ') || none}`,
      `Csoportmegjegyzés: ${customNotes.groupNote || none}`
    ]],
    ['Pedagógiai kívánságok', [
      `Rendelkezésre álló eszközök és saját ötletek: ${payload.availableTools || defaultToolsText}`,
      `Kötelező mese/vers/dal: ${customNotes.requiredText || none}`,
      `Kiválasztott célkifejezések: ${selectedGoals.length ? selectedGoals.join(', ') : 'Nincs kiválasztva'}`,
      `Külön kérés: ${customNotes.customRequest || none}`,
      `Kidolgozottság: ${{ concise: 'Tömör vázlat', extended: 'Kibővített, mély kidolgozás' }[payload.detail] || 'Részletesen kidolgozott tervezet'}`
    ]],
    ['Speciális beállítások', [
      `Tiltólista: ${payload.blacklist || 'Nincs megadva'}`,
      `Előzmény: ${payload.elozmeny || none}`,
      `Előző tervezet csatolva: ${attachedPreviousPlan ? `${attachedPreviousPlan.theme} (${attachedPreviousPlan.date})` : 'nem'}`,
      `Irodalomjegyzék megjelenítése: ${payload.showLiteratureAtBottom ? 'igen' : 'nem'}`,
      `IKT / Digitális eszközök: ${payload.iktEnabled ? ([...(payload.iktTools || []), payload.iktCustomApp].filter(Boolean).join('; ') || 'Igen') : 'Nem'}`,
      `Heti építkezés típusa: ${weeklyOnly(progressionLabels[payload.weeklyProgressionType] || payload.weeklyProgressionType)}`,
      `Pénteki zárás formája: ${weeklyOnly(payload.fridayClosingType)}`
    ]]
  ];

  checklist.innerHTML = sections.map(([heading, items]) => `
          <div class="summary-section">
            <strong>${escapeHtml(heading)}</strong>
            <div class="summary-items">
              ${items.map((item) => `<div>• ${escapeHtml(item)}</div>`).join('')}
            </div>
          </div>
        `).join('');
}

function setDurationSelection(nextValue) {
  const value = String(nextValue || 'Napi').trim();
  document.querySelectorAll('.segment[data-group="duration"]').forEach((segment) => {
    segment.classList.toggle('active', segment.dataset.value === value);
  });

  const dateField = document.getElementById('dailyDateField');
  const weekField = document.getElementById('weeklyDateField');
  const showDaily = value === 'Napi';

  if (dateField) {
    dateField.type = 'date';
    dateField.style.display = showDaily ? 'inline-block' : 'none';
    if (showDaily && !dateField.value) {
      dateField.value = new Date().toISOString().slice(0, 10);
    }
  }

  if (weekField) {
    weekField.type = 'week';
    weekField.style.display = showDaily ? 'none' : 'inline-block';
    if (!showDaily && !weekField.value && typeof document !== 'undefined') {
      weekField.value = isoWeekValue();
    }
  }

  saveProfileToStorage();
  persistDraftState();
  updateWeeklyDailyBreakdownVisibility();
  updateSummary();
}

function updateSummary() {
  // A generated document keeps the settings it was actually generated from.
  renderSummaryChecklist();
}

function getAutoSaveKey(element) {
  if (element?.dataset?.weeklyFocusDay) return `weeklyFocus:${element.dataset.weeklyFocusDay}`;
  if (element?.dataset?.field) return `field:${element.dataset.field}`;
  if (element?.id) return `id:${element.id}`;
  if (element?.dataset?.value && element.matches('.segment')) return `segment:${element.dataset.value}`;
  if (element?.dataset?.value && element.matches('.chip')) return `chip:${element.textContent.trim()}`;
  const labelText = element?.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() || element?.closest('.check-item')?.textContent?.replace(/\s+/g, ' ').trim() || element?.name || '';
  return labelText ? `label:${labelText}` : `index:${Array.from(document.querySelectorAll('input, textarea, select, .chip, .segment')).indexOf(element)}`;
}

function collectDraftState() {
  const selectedGoals = Array.from(document.querySelectorAll('.chip.active:not([data-theme-option])')).map((chip) => chip.textContent.trim());
  const draft = {
    version: 1,
    currentStep,
    planMode: getPlanMode(),
    duration: getSelectedDuration(),
    dateValue: getDateValue(),
    selectedDays: getSelectedDays(),
    energy: getChoice('energy', ENERGY_DEFAULT),
    detail: getChoice('detail', 'detailed'),
    selectedGoals,
    weeklyFocusAreas: getWeeklyFocusAreas(),
    fields: {}
  };

  document.querySelectorAll('input, textarea, select').forEach((field) => {
    const key = getAutoSaveKey(field);
    if (field.type === 'checkbox') {
      draft.fields[key] = field.checked;
    } else if (field.type === 'range' || field.type === 'number' || field.type === 'date' || field.type === 'week' || field.tagName === 'TEXTAREA' || field.tagName === 'SELECT' || field.tagName === 'INPUT') {
      draft.fields[key] = field.value;
    }
  });

  document.querySelectorAll('.chip, .segment').forEach((button) => {
    const key = getAutoSaveKey(button);
    draft.fields[key] = button.classList.contains('active');
  });

  return draft;
}

function applyDraftState(draft) {
  if (!draft || typeof draft !== 'object') return;

  const map = new Map();
  document.querySelectorAll('input, textarea, select, .chip, .segment').forEach((element) => {
    map.set(getAutoSaveKey(element), element);
  });

  // Korábbi fókuszterület elnevezések migrálása az új hivatalos megnevezésekre
  const legacyFocusAreaMap = {
    'label:Külső világ tevékeny megismerése': 'label:A külső világ tevékeny megismerése',
    'label:Ének, zene, énekes játék': 'label:Ének, zene, népi játék, tánc',
    'label:Rajzolás, mintázás, kézimunka': 'label:Rajzolás, festés, mintázás, kézi munka'
  };

  Object.entries(draft.fields || {}).forEach(([rawKey, value]) => {
    const key = legacyFocusAreaMap[rawKey] || rawKey;
    const element = map.get(key);
    if (!element) return;

    if (element.matches('.chip, .segment')) {
      element.classList.toggle('active', Boolean(value));
      return;
    }

    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = value ?? '';
    }
  });

  if (typeof draft.currentStep === 'number') {
    currentStep = Math.min(Math.max(draft.currentStep, 0), steps.length - 1);
  }

  const duration = draft.duration || 'Napi';
  document.querySelectorAll('.segment[data-group="duration"]').forEach((segment) => {
    segment.classList.toggle('active', segment.dataset.value === duration);
  });

  setPlanMode(draft.planMode);
  setSelectedDays(draft.selectedDays);
  setChoice('energy', draft.energy, ENERGY_DEFAULT);
  setChoice('detail', draft.detail, 'detailed');
  if (draft.weeklyFocusAreas && typeof draft.weeklyFocusAreas === 'object') {
    Object.entries(draft.weeklyFocusAreas).forEach(([day, val]) => {
      const list = Array.isArray(val) ? val : [val];
      list.forEach((area) => {
        const select = document.querySelector(`.focus-area-day-select[data-area-day="${area}"]`);
        if (select) select.value = day;
      });
    });
  }
  updateDateInputsForDuration();
  updateWeeklyDailyBreakdownVisibility();
  updateFocusAreaDayRows();
  syncAdvancedSettingsOpenState();
  const dateTarget = document.querySelector(getSelectedDuration() === 'Heti' ? 'input[data-field="week-value"]' : 'input[data-field="date-value"]');
  if (dateTarget && draft.dateValue) {
    dateTarget.value = draft.dateValue;
  }

  updateSummary();
  if (lastResult) renderResultDocument(lastResult);
}

function persistDraftState() {
  revokeIfPlanChanged();
  try {
    localStorage.setItem(STORAGE_KEYS.draft, JSON.stringify(collectDraftState()));
  } catch (error) {
    console.warn('Draft save failed:', error);
  }
}

function loadDraftFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.draft) || 'null');
    if (saved) {
      applyDraftState(saved);
      renderStep();
    }
  } catch (error) {
    console.warn('Draft load failed:', error);
  }
}

function updateWizardProgress() {
  const text = document.getElementById('wizardProgressText');
  const bar = document.getElementById('wizardProgressBar');
  if (!text || !bar) return;
  const label = wizardItems[currentStep]?.querySelector('span:last-child')?.textContent || '';
  text.textContent = `${currentStep + 1}/${wizardItems.length}. lépés: ${label}`;
  bar.style.width = `${((currentStep + 1) / wizardItems.length) * 100}%`;
  const wizard = document.querySelector('.wizard');
  wizard?.classList.remove('open');
  document.getElementById('wizardProgressToggle')?.setAttribute('aria-expanded', 'false');
}

function renderStep() {
  steps.forEach((panel, index) => {
    panel.classList.toggle('active', index === currentStep);
  });

  wizardItems.forEach((item, index) => {
    item.classList.toggle('active', index === currentStep);
  });

  updateWizardProgress();
  backBtn.style.visibility = currentStep === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = currentStep === steps.length - 1 ? 'Tervezet elkészítése' : 'Következő lépés';
  applyMaintenanceState();
  renderPreview();
  updateExportLock();
  persistDraftState();
}

function updateDateInputsForDuration() {
  const duration = getSelectedDuration();
  const dailyInput = document.getElementById('dailyDateField');
  const weeklyInput = document.getElementById('weeklyDateField');
  const showDaily = duration === 'Napi';

  if (dailyInput) {
    dailyInput.type = 'date';
    dailyInput.style.display = showDaily ? 'inline-block' : 'none';
  }

  if (weeklyInput) {
    weeklyInput.type = 'week';
    weeklyInput.style.display = showDaily ? 'none' : 'inline-block';
  }
}

function loadProfileFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.profile) || '{}');
    const fields = [
      ['input[data-field="kindergarten-name"]', saved.kindergartenName || ''],
      ['input[data-field="kindergarten-profile"]', saved.kindergartenProfile || ''],
      ['input[data-field="teacher-name"]', saved.teacherName || ''],
      ['input[data-field="group-name"]', saved.groupName || ''],
    ];
    fields.forEach(([selector, value]) => {
      const field = document.querySelector(selector);
      if (field) field.value = value;
    });
  } catch (error) {
    console.warn('Profile load failed:', error);
  }
}

function saveProfileToStorage() {
  const profile = {
    kindergartenName: document.querySelector('input[data-field="kindergarten-name"]')?.value || '',
    kindergartenProfile: document.querySelector('input[data-field="kindergarten-profile"]')?.value || '',
    teacherName: document.querySelector('input[data-field="teacher-name"]')?.value || '',
    groupName: document.querySelector('input[data-field="group-name"]')?.value || ''
  };
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile));
}

function clearDraftState() {
  const preservedProfile = {
    kindergartenName: document.querySelector('input[data-field="kindergarten-name"]')?.value || '',
    kindergartenProfile: '',
    teacherName: document.querySelector('input[data-field="teacher-name"]')?.value || '',
    groupName: document.querySelector('input[data-field="group-name"]')?.value || '',
  };
  const profileFieldMap = {
    'kindergarten-name': 'kindergartenName',
    'kindergarten-profile': 'kindergartenProfile',
    'teacher-name': 'teacherName',
    'group-name': 'groupName'
  };

  document.querySelectorAll('input, textarea, select').forEach((field) => {
    if (field.type === 'checkbox') {
      field.checked = field.defaultChecked;
      return;
    }

    if (field.matches('#weeklyProgressionType, #fridayClosingType')) {
      field.selectedIndex = 0;
      return;
    }

    if (field.matches('[data-field="group"]')) {
      field.value = 'Nagycsoport';
      return;
    }

    if (field.matches('[data-field="theme"]')) {
      field.value = '';
      return;
    }

    if (field.matches('[data-field="tevekenyseg-forma"]')) {
      field.selectedIndex = 0;
      return;
    }

    if (field.matches('[data-field="date-value"], [data-field="week-value"]')) {
      field.value = '';
      return;
    }

    if (field.matches('[data-field="kindergarten-name"], [data-field="teacher-name"], [data-field="group-name"]')) {
      const key = profileFieldMap[field.dataset.field];
      field.value = preservedProfile[key] || '';
      return;
    }

    if (field.matches('[data-field="kindergarten-profile"]')) {
      field.value = '';
      return;
    }

    if (field.matches('.focus-area-day-select')) {
      field.value = 'any';
      return;
    }

    if (field.tagName === 'TEXTAREA' || field.tagName === 'SELECT' || field.tagName === 'INPUT') {
      field.value = '';
    }
  });

  setPlanMode('standard');
  setSelectedDays(ALL_WEEKDAYS);
  setChoice('energy', ENERGY_DEFAULT);
  setChoice('detail', 'detailed');
  document.querySelectorAll('.chip, .segment').forEach((button) => {
    if (button.matches('.segment[data-group="energy"], .segment[data-group="detail"]')) return;
    if (button.matches('.segment[data-group="duration"]')) {
      button.classList.toggle('active', button.dataset.value === 'Napi');
    } else if (button.matches('.chip')) {
      button.classList.remove('active');
    }
  });

  localStorage.removeItem(STORAGE_KEYS.draft);
  localStorage.removeItem(STORAGE_KEYS.generatedPlan);
  lastResult = null;
  previewReady = false;
  updateDateInputsForDuration();
  updateWeeklyDailyBreakdownVisibility();
  updateFocusAreaDayRows();
  const advancedSettings = document.getElementById('advancedSettings');
  if (advancedSettings) advancedSettings.open = false;
  currentStep = 0;
  resetGeneratedResult();
  hideGenerationErrorBanner();
  saveProfileToStorage();
  renderStep();
  updateSummary();
}

let attachedPreviousPlan = null;

function formatHistoryDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}. ${m}. ${day}. ${h}:${min}`;
}

function setAttachedPreviousPlan(item) {
  if (!item) return;
  attachedPreviousPlan = {
    id: item.id || item.generationId,
    generationId: item.generationId,
    theme: item.theme || item.payload?.theme || 'Cím nélküli tervezet',
    duration: item.duration || item.payload?.duration || 'Napi',
    date: formatHistoryDate(item.savedAt),
    payload: item.payload || item
  };
  const banner = document.getElementById('attachedPlanBanner');
  const textEl = document.getElementById('attachedPlanText');
  if (banner && textEl) {
    textEl.textContent = `Csatolt előzmény: ${attachedPreviousPlan.theme} (${attachedPreviousPlan.duration}, ${attachedPreviousPlan.date}) – az új tervezet épít rá, és elkerüli az ismétlődéseket.`;
    banner.hidden = false;
  }
  historyPanel?.classList.remove('open');
  updateSummary();
}

function clearAttachedPreviousPlan() {
  attachedPreviousPlan = null;
  const banner = document.getElementById('attachedPlanBanner');
  if (banner) banner.hidden = true;
  updateSummary();
}

function formatPreviousPlanContext(attached) {
  if (!attached) return '';
  const p = attached.payload || {};
  const parts = [
    `Téma: ${attached.theme}`,
    `Típus: ${attached.duration}`,
    attached.date ? `Dátum: ${attached.date}` : '',
    p.focusAreas?.length ? `Nevelési terület: ${p.focusAreas.join(', ')}` : '',
    p.selectedGoals?.length ? `Célok: ${p.selectedGoals.join(', ')}` : '',
    p.availableTools ? `Eszközök: ${p.availableTools}` : ''
  ].filter(Boolean);
  return parts.join(' • ');
}

function restorePlanSettings(plan) {
  if (!plan || typeof plan !== 'object') return;
  // A mentett üres érték is érvényes és törli a mezőt; csak a hiányzó kulcs hagyja érintetlenül.
  const setText = (selector, value) => {
    if (value === undefined || value === null) return;
    const field = document.querySelector(selector);
    if (field) field.value = value;
  };
  setText('[data-field="theme"]', plan.theme);
  if (plan.group) {
    const groupSelect = document.querySelector('select[data-field="group"]');
    if (groupSelect) groupSelect.value = plan.group;
  }
  if (plan.tevekenysegForma) {
    const formaSelect = document.querySelector('select[data-field="tevekenyseg-forma"]');
    if (formaSelect) formaSelect.value = plan.tevekenysegForma;
  }
  setText('input[data-field="kindergarten-name"]', plan.kindergartenName);
  setText('input[data-field="kindergarten-profile"]', plan.kindergartenProfile);
  setText('input[data-field="teacher-name"]', plan.teacherName);
  setText('input[data-field="group-name"]', plan.groupName);
  setText('input[data-field="student-name"]', plan.studentName);
  setPlanMode(plan.planMode);
  setText('textarea[data-field="custom-note"]', plan.customNote);
  setText('textarea[data-field="group-note"]', plan.customNotes?.groupNote ?? plan.groupNote);
  setText('textarea[data-field="required-text"]', plan.customNotes?.requiredText ?? plan.requiredText);
  const legacyTools = [plan.customNotes?.ideaNote, plan.ideaNote].filter(Boolean).join('; ');
  setText('textarea[data-field="available-tools"]', plan.availableTools ?? (legacyTools || undefined));
  setText('textarea[data-field="custom-request"]', plan.customNotes?.customRequest ?? plan.customRequest);
  if (plan.childCount !== undefined && plan.childCount !== null) {
    const countInput = document.querySelector('input[data-field="child-count"]');
    if (countInput) countInput.value = plan.childCount;
  }
  if (plan.energyLevel) setChoice('energy', plan.energyLevel, ENERGY_DEFAULT);
  if (plan.detail) setChoice('detail', plan.detail, 'detailed');
  if (plan.weeklyScope) {
    setChoice('weeklyScope', plan.weeklyScope, 'summary');
    updateWeeklyDailyBreakdownVisibility();
  }
  if (plan.hasPreschoolers !== undefined) {
    const pres = document.querySelector('input[data-field="has-preschoolers"]');
    if (pres) pres.checked = Boolean(plan.hasPreschoolers);
  }
  setText('[data-field="blacklist"]', plan.blacklist);
  setText('textarea[data-field="elozmeny"]', plan.elozmeny);
  if (plan.showLiteratureAtBottom !== undefined) {
    const literature = document.querySelector('input[data-field="show-literature"]');
    if (literature) literature.checked = Boolean(plan.showLiteratureAtBottom);
  }
  if (plan.weeklyProgressionType) {
    const progression = document.getElementById('weeklyProgressionType');
    if (progression) progression.value = plan.weeklyProgressionType;
  }
  if (plan.fridayClosingType) {
    const closing = document.getElementById('fridayClosingType');
    if (closing) closing.value = plan.fridayClosingType;
  }

  const areas = Array.isArray(plan.focusAreas) ? plan.focusAreas : [];
  document.querySelectorAll('input[data-focus-area]').forEach((cb) => {
    cb.checked = areas.includes(cb.dataset.focusArea);
  });

  if (plan.weeklyFocusAreas && typeof plan.weeklyFocusAreas === 'object') {
    Object.entries(plan.weeklyFocusAreas).forEach(([day, dayAreas]) => {
      (Array.isArray(dayAreas) ? dayAreas : [dayAreas]).forEach((area) => {
        const select = document.querySelector(`.focus-area-day-select[data-area-day="${area}"]`);
        if (select) select.value = day;
      });
    });
  }

  const sniList = Array.isArray(plan.specialNeeds) ? plan.specialNeeds : (Array.isArray(plan.customNotes?.specialNeeds) ? plan.customNotes.specialNeeds : []);
  document.querySelectorAll('[data-sni-label]').forEach((cb) => {
    cb.checked = sniList.includes(cb.dataset.sniLabel.trim());
  });

  const goals = Array.isArray(plan.selectedGoals) ? plan.selectedGoals : [];
  document.querySelectorAll('.chip:not([data-theme-option]):not([data-ikt-tool])').forEach((chip) => {
    chip.classList.toggle('active', goals.includes(chip.textContent.trim()));
  });

  if (plan.iktEnabled !== undefined) {
    const iktToggle = document.getElementById('iktEnabled');
    if (iktToggle) iktToggle.checked = Boolean(plan.iktEnabled);
    const iktTools = Array.isArray(plan.iktTools) ? plan.iktTools : [];
    document.querySelectorAll('#iktToolsPicker [data-ikt-tool]').forEach((button) => {
      button.classList.toggle('active', iktTools.includes(button.dataset.iktTool));
    });
    const iktCustomApp = document.getElementById('iktCustomApp');
    if (iktCustomApp) iktCustomApp.value = plan.iktCustomApp || '';
    syncIktPanel();
  }

  const duration = plan.duration || 'Napi';
  document.querySelectorAll('.segment[data-group="duration"]').forEach((segment) => {
    segment.classList.toggle('active', segment.dataset.value === duration);
  });
  if (Array.isArray(plan.selectedDays)) setSelectedDays(plan.selectedDays);

  updateDateInputsForDuration();
  const dateInput = document.querySelector(duration === 'Heti' ? 'input[data-field="week-value"]' : 'input[data-field="date-value"]');
  if (dateInput && plan.dateValue) dateInput.value = plan.dateValue;

  updateWeeklyDailyBreakdownVisibility();
  updateFocusAreaDayRows();
  syncAdvancedSettingsOpenState();
  saveProfileToStorage();
  updateSummary();
  persistDraftState();
}

function loadHistoryFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    console.warn('History load failed:', error);
    return [];
  }
}

function savePlanToHistory(payload, generationId = '', paid = false, planData = null) {
  if (!payload || typeof payload !== 'object') return;
  const plans = loadHistoryFromStorage();
  const id = generationId || `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const theme = String(payload.theme || payload.heti_keretterv?.tema || 'Cím nélküli tervezet').trim();
  const duration = payload.duration === 'Heti' ? 'Heti' : 'Napi';

  const existingIndex = plans.findIndex((p) => (generationId && (p.generationId === generationId || p.id === generationId)) || (p.id && p.id === id));
  const savedAt = existingIndex >= 0 && plans[existingIndex].savedAt ? plans[existingIndex].savedAt : new Date().toISOString();
  const status = paid ? 'paid' : (existingIndex >= 0 && plans[existingIndex].status === 'paid' ? 'paid' : 'draft');
  const finalPaid = status === 'paid';
  const finalPlanData = finalPaid ? (planData || (existingIndex >= 0 ? plans[existingIndex].planData : null)) : null;

  const newEntry = {
    id,
    generationId: generationId || id,
    theme,
    duration,
    savedAt,
    status,
    paid: finalPaid,
    payload,
    planData: finalPlanData
  };

  if (existingIndex >= 0) {
    plans[existingIndex] = newEntry;
  } else {
    plans.unshift(newEntry);
  }

  const limited = plans.slice(0, 15);
  try {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(limited));
  } catch (err) {
    console.warn('History save warning:', err);
  }
  renderHistoryPanel();
}

function deletePlanFromHistory(id) {
  const plans = loadHistoryFromStorage().filter((p) => p.id !== id && p.generationId !== id);
  try {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(plans));
  } catch (err) {
    console.warn('History delete warning:', err);
  }
  if (attachedPreviousPlan && (attachedPreviousPlan.id === id || attachedPreviousPlan.generationId === id)) {
    clearAttachedPreviousPlan();
  }
  renderHistoryPanel();
}

function markPlanAsPaidInHistory(generationId, planData) {
  if (!generationId) return;
  const plans = loadHistoryFromStorage();
  let updated = false;
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].generationId === generationId || plans[i].id === generationId) {
      plans[i].status = 'paid';
      plans[i].paid = true;
      plans[i].planData = planData;
      updated = true;
      break;
    }
  }
  if (!updated && planData) {
    savePlanToHistory(planData.request || buildGenerationPayload(), generationId, true, planData);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(plans));
  } catch (err) {
    console.warn('History update warning:', err);
  }
  renderHistoryPanel();
}

function renderHistoryPanel() {
  const history = loadHistoryFromStorage();
  if (!historyPanel) return;
  historyPanel.innerHTML = '';

  if (history.length === 0) {
    historyPanel.innerHTML = '<div class="history-item history-item-empty">Még nincs mentett terv.</div>';
    return;
  }

  history.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'history-item-card';
    card.dataset.historyId = item.id || item.generationId;

    const isPaid = item.status === 'paid' || item.paid === true;
    const durationLabel = item.duration === 'Heti' ? 'Heti' : 'Napi';
    const themeTitle = item.theme || item.payload?.theme || 'Cím nélküli tervezet';
    const dateFormatted = formatHistoryDate(item.savedAt);
    const localId = item.generationId || item.id;
    const cloudPlans = window.oviCloudPlans;
    const inCloud = Boolean(cloudPlans?.ids.has(localId));
    const canAdopt = Boolean(cloudPlans?.canAdopt(localId));

    card.innerHTML = `
            <div class="history-item-header">
              <div class="history-item-title-row">
                <strong class="history-item-title">${escapeHtml(themeTitle)}</strong>
                <span class="history-item-type">${escapeHtml(durationLabel)}</span>
              </div>
              <div class="history-item-meta">
                <span class="history-item-date">${escapeHtml(dateFormatted)}</span>
                ${inCloud
            ? '<span class="history-badge history-badge-cloud">Profilba mentve</span>'
            : '<span class="history-badge history-badge-local">Helyi / Offline</span>'}
                ${isPaid
            ? '<span class="history-badge history-badge-paid">Fizetve</span>'
            : '<span class="history-badge history-badge-draft">Csak előnézet (piszkozat)</span>'}
              </div>
            </div>
            <div class="history-item-actions">
              <button type="button" class="btn-history btn-history-load" data-action="load">Beállítások betöltése</button>
              <button type="button" class="btn-history btn-history-attach" data-action="attach">Előzményként csatol</button>
              ${isPaid && item.planData
          ? '<button type="button" class="btn-history btn-history-download" data-action="download">Letöltés</button>'
          : ''}
              ${canAdopt ? '<button type="button" class="btn-history btn-history-adopt" data-action="adopt">Mentés a profilomba</button>' : ''}
              <button type="button" class="btn-history btn-history-delete" data-action="delete" title="Törlés">Törlés</button>
            </div>
          `;

    card.querySelector('.btn-history-load')?.addEventListener('click', (e) => {
      e.stopPropagation();
      restorePlanSettings(item.payload || item);
      historyPanel.classList.remove('open');
    });

    card.querySelector('.btn-history-attach')?.addEventListener('click', (e) => {
      e.stopPropagation();
      setAttachedPreviousPlan(item);
    });

    card.querySelector('.btn-history-download')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.planData) {
        const genId = item.generationId || item.id;
        unlockGeneration(genId);
        lastResult = { ...item.planData, request: item.payload || item.planData.request, generationId: genId };
        window.lastResult = lastResult;
        try {
          localStorage.setItem(STORAGE_KEYS.generatedPlan, JSON.stringify(lastResult));
        } catch (_err) {}
        previewReady = true;
        currentStep = steps.length - 1;
        renderStep();
        renderResultDocument(lastResult);
        renderPreview();
        updateExportLock();
        historyPanel.classList.remove('open');
        document.getElementById('previewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    card.querySelector('.btn-history-adopt')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const adoptButton = e.currentTarget;
      adoptButton.disabled = true;
      try {
        await cloudPlans.adopt(localId);
      } catch (error) {
        adoptButton.disabled = false;
        showGenerationError(`A terv mentése a profilba sikertelen: ${error.message}`);
      }
    });

    card.querySelector('.btn-history-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlanFromHistory(item.id || item.generationId);
    });

    historyPanel.appendChild(card);
  });
}

function bindAutoSaveListeners() {
  const trackedFields = Array.from(document.querySelectorAll('input, textarea, select'));
  trackedFields.forEach((field) => {
    if (field.matches('input[type="hidden"]')) return;
    field.addEventListener('input', () => {
      updateSummary();
      saveProfileToStorage();
      persistDraftState();
    });
    field.addEventListener('change', () => {
      updateSummary();
      saveProfileToStorage();
      persistDraftState();
    });
  });

  document.querySelectorAll('.plan-mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      setPlanMode(card.dataset.planMode);
      updateSummary();
      persistDraftState();
    });
  });

  document.querySelectorAll('input[data-focus-area]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      updateFocusAreaDayRows();
      updateSummary();
      persistDraftState();
    });
  });

  document.querySelectorAll('.focus-area-day-select').forEach((select) => {
    select.addEventListener('change', () => {
      updateSummary();
      persistDraftState();
    });
  });

  document.querySelectorAll('#weeklyDayPicker .day-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!toggleWeekday(chip)) return;
      updateSummary();
      saveProfileToStorage();
      persistDraftState();
    });
  });

  ['weeklyProgressionType', 'fridayClosingType'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      updateSummary();
      saveProfileToStorage();
      persistDraftState();
    });
  });

  document.querySelectorAll('.chip').forEach((button) => {
    if (button.dataset.themeOption || button.dataset.iktTool) return;
    button.addEventListener('click', () => {
      button.classList.toggle('active');
      saveProfileToStorage();
      persistDraftState();
      updateSummary();
    });
  });

  const iktToggle = document.getElementById('iktEnabled');
  if (iktToggle) {
    iktToggle.addEventListener('change', () => {
      syncIktPanel();
      updateSummary();
      persistDraftState();
    });
  }

  document.querySelectorAll('#iktToolsPicker [data-ikt-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      button.classList.toggle('active');
      updateSummary();
      persistDraftState();
    });
  });

  document.getElementById('iktCustomApp')?.addEventListener('input', () => {
    updateSummary();
    persistDraftState();
  });

  document.querySelectorAll('.segment[data-group="duration"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const selectedValue = (button.dataset.value || button.textContent || 'Napi').trim();
      setDurationSelection(selectedValue);

      const targetInput = selectedValue === 'Heti'
        ? document.querySelector('input[data-field="week-value"]')
        : document.querySelector('input[data-field="date-value"]');
      if (targetInput) {
        targetInput.type = selectedValue === 'Heti' ? 'week' : 'date';
      }

      updateWeeklyDailyBreakdownVisibility();
      updateSummary();
      localStorage.setItem(STORAGE_KEYS.draft, JSON.stringify(collectDraftState()));

      if (lastResult) {
        renderResultDocument(lastResult);
      }
    });
  });
}

function getDetailLevel() {
  return DETAIL_LEVELS[getChoice('detail', 'detailed')] ?? DETAIL_LEVELS.detailed;
}

function getCustomNotes() {
  return {
    primary: document.querySelector('textarea[data-field="custom-note"]')?.value || '',
    groupNote: document.querySelector('textarea[data-field="group-note"]')?.value || '',
    requiredText: document.querySelector('textarea[data-field="required-text"]')?.value || '',
    customRequest: document.querySelector('textarea[data-field="custom-request"]')?.value || '',
    specialNeeds: Array.from(document.querySelectorAll('[data-sni-label]'))
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.sniLabel.trim())
  };
}

function buildGenerationPayload() {
  const activeDurationButton = document.querySelector('.segment.active[data-group="duration"]');
  const selectedDuration = (activeDurationButton?.dataset?.value || activeDurationButton?.textContent || '').trim() || getSelectedDuration() || 'Napi';
  const planMode = getPlanMode();
  const isWeekly = selectedDuration === 'Heti' && planMode !== 'academic';
  const weeklyFocusAreas = isWeekly ? getWeeklyFocusAreas() : {};
  const focusAreas = Array.from(document.querySelectorAll('[data-focus-area]:checked')).map((checkbox) => checkbox.dataset.focusArea);
  const iktEnabled = getIktEnabled();
  const iktTools = getSelectedIktTools();
  const iktCustomApp = getIktCustomApp();

  return {
    duration: selectedDuration,
    weeklyScope: isWeekly ? getWeeklyScope() : undefined,
    selectedDays: getSelectedDays(),
    weeklyProgressionType: getWeeklyProgressionType(),
    fridayClosingType: getFridayClosingType(),
    availableTools: getAvailableTools(),
    blacklist: getBlacklist(),
    planMode,
    planKind: selectedDuration === 'Heti' ? 'weekly' : 'daily',
    studentName: planMode === 'academic' ? (document.querySelector('input[data-field="student-name"]')?.value.trim() || '') : '',
    theme: getTheme(),
    group: getGroup(),
    kindergartenName: document.querySelector('input[data-field="kindergarten-name"]')?.value || '',
    kindergartenProfile: document.querySelector('input[data-field="kindergarten-profile"]')?.value.trim() || '',
    teacherName: document.querySelector('input[data-field="teacher-name"]')?.value || '',
    groupName: document.querySelector('input[data-field="group-name"]')?.value || '',
    dateValue: getDateValue(),
    tevekenysegForma: document.querySelector('[data-field="tevekenyseg-forma"]')?.value || '',
    elozmeny: document.querySelector('textarea[data-field="elozmeny"]')?.value || '',
    childCount: document.querySelector('[data-field="child-count"]')?.value
      ? Number(document.querySelector('[data-field="child-count"]').value) : null,
    energyLevel: getChoice('energy', ENERGY_DEFAULT),
    hasPreschoolers: document.querySelector('[data-field="has-preschoolers"]')?.checked ?? false,
    focusAreas,
    weeklyFocusAreas,
    previousPlanContext: attachedPreviousPlan ? formatPreviousPlanContext(attachedPreviousPlan) : '',
    contact_website: document.getElementById('contact_website')?.value || '',
    turnstileToken: currentTurnstileToken || '',
    customNote: document.querySelector('textarea[data-field="custom-note"]')?.value || '',
    customNotes: getCustomNotes(),
    detailLevel: getDetailLevel(),
    selectedGoals: Array.from(document.querySelectorAll('.chip.active:not([data-theme-option])')).map((chip) => chip.textContent.trim()),
    specialNeeds: Array.from(document.querySelectorAll('[data-sni-label]')).filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.dataset.sniLabel.trim()),
    showLiteratureAtBottom: planMode === 'academic' || (document.querySelector('input[data-field="show-literature"]')?.checked || false),
    iktEnabled,
    iktTools,
    iktCustomApp
  };
}

function renderSeasonalThemeSuggestions() {
  const container = document.getElementById('themeSuggestions');
  if (!container) return;

  // A javaslatok az adatbázisból (GET /api/config -> seasonal_hints) jönnek; betöltés előtt vagy hiba esetén nincs beégetett lista.
  const themes = appConfig.seasonalHints;
  const themeField = document.querySelector('input[data-field="theme"]');
  if (themeField && themes.length) themeField.placeholder = `Pl.: ${themes[0]}`;
  const activeTheme = document.querySelector('input[data-field="theme"]')?.value?.trim();
  container.innerHTML = themes.map((theme) => `<button class="chip${activeTheme === theme ? ' active' : ''}" type="button" data-theme-option="${escapeHtml(theme)}">${escapeHtml(theme)}</button>`).join('');

  container.querySelectorAll('[data-theme-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const themeInput = document.querySelector('input[data-field="theme"]');
      if (!themeInput) return;

      const currentlyActive = button.classList.contains('active');
      container.querySelectorAll('[data-theme-option]').forEach((item) => item.classList.remove('active'));

      if (currentlyActive) {
        themeInput.value = '';
      } else {
        button.classList.add('active');
        themeInput.value = button.dataset.themeOption;
      }

      themeInput.dispatchEvent(new Event('input', { bubbles: true }));
      saveProfileToStorage();
      persistDraftState();
    });
  });
}
