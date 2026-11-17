// Terv generálása, betöltő és Turnstile.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

let turnstileWidgetId = null;

let currentTurnstileToken = '';

function getTurnstileSiteKey() {
  return String(window.APP_CONFIG?.turnstileSiteKey || '').trim();
}

let turnstileWidgetTheme = '';

function setTurnstileError(message) {
  const box = document.getElementById('turnstileError');
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

function onTurnstileVerified(token) {
  currentTurnstileToken = token;
  setTurnstileError('');
  // Rövid várakozás, hogy a zöld pipa látszódjon.
  setTimeout(() => {
    const modal = document.getElementById('turnstileModal');
    if (!modal || !modal.classList.contains('open')) return;
    closeModals();
    generatePlan();
  }, 350);
}

function renderTurnstileWidget(siteKey) {
  const container = document.getElementById('turnstileContainer');
  if (!container || !window.turnstile) return;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  if (turnstileWidgetId !== null && turnstileWidgetTheme === theme) {
    try { window.turnstile.reset(turnstileWidgetId); } catch (_e) {}
    return;
  }
  if (turnstileWidgetId !== null) {
    try { window.turnstile.remove(turnstileWidgetId); } catch (_e) {}
    turnstileWidgetId = null;
  }
  try {
    turnstileWidgetId = window.turnstile.render('#turnstileContainer', {
      sitekey: siteKey,
      theme,
      callback: onTurnstileVerified,
      'expired-callback': () => {
        currentTurnstileToken = '';
      },
      'error-callback': () => {
        currentTurnstileToken = '';
        setTurnstileError('A biztonsági ellenőrzés nem sikerült. Kérjük, próbáld újra, vagy frissítsd az oldalt.');
      }
    });
    turnstileWidgetTheme = theme;
  } catch (err) {
    console.warn('Turnstile render warning:', err);
    setTurnstileError('A biztonsági ellenőrzés nem tölthető be. Kérjük, frissítsd az oldalt, és próbáld újra.');
  }
}

function openTurnstileModal(siteKey) {
  currentTurnstileToken = '';
  setTurnstileError('');
  openModal('turnstileModal');
  if (window.turnstile) {
    renderTurnstileWidget(siteKey);
    return;
  }
  const existing = document.getElementById('turnstileScript');
  if (existing) existing.remove();
  const script = document.createElement('script');
  script.id = 'turnstileScript';
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = () => renderTurnstileWidget(siteKey);
  script.onerror = () => {
    script.remove();
    setTurnstileError('A biztonsági ellenőrzés nem tölthető be (a Cloudflare szolgáltatás nem érhető el). Ellenőrizd az internetkapcsolatot, és próbáld újra.');
  };
  document.head.appendChild(script);
}

// Kattintásra indított generálás: élő Turnstile-token nélkül előbb a felugró ellenőrzés fut.
function requestGeneration() {
  const siteKey = getTurnstileSiteKey();
  if (!siteKey || currentTurnstileToken || readCachedGeneration(buildGenerationPayload()) || readDailyCount().count >= DAILY_FREE_LIMIT) {
    generatePlan();
    return;
  }
  openTurnstileModal(siteKey);
}

const WEEKLY_PHASES = [
  [0, 'Heti tematikus keret és célok tervezése...'],
  [30, 'Hétfői és keddi tevékenységek kidolgozása...'],
  [65, 'Szerdai és csütörtöki játékok és differenciálás összeállítása...'],
  [100, 'Pénteki záróélmény kidolgozása és formázás...']
];

const DAILY_PHASES = [
  [0, 'Ráhangolódás a témára...'],
  [12, 'A fő tevékenység kidolgozása...'],
  [28, 'Differenciálás és gyakorlás összeállítása...'],
  [42, 'Összegzés és formázás...']
];

function startGenerationLoader(payload) {
  const loader = document.getElementById('generationLoader');
  const status = document.getElementById('generationStatus');
  const elapsed = document.getElementById('generationElapsed');
  const phases = payload.duration === 'Heti' && payload.includeDailyBreakdown ? WEEKLY_PHASES : DAILY_PHASES;
  const startedAt = Date.now();
  const tick = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const phase = phases.filter(([from]) => seconds >= from).pop();
    if (status) status.textContent = phase[1];
    if (elapsed) elapsed.textContent = `Eltelt idő: ${seconds} mp${phases === WEEKLY_PHASES ? ' – a heti terv akár 2–3 percig is eltarthat' : ''}`;
  };
  tick();
  if (loader) loader.hidden = false;
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    if (loader) loader.hidden = true;
  };
}

let generationInFlight = false;

async function generatePlan() {
  if (generationInFlight) return;
  hideGenerationErrorBanner();
  const earlyPayload = buildGenerationPayload();
  const cachedResult = readCachedGeneration(earlyPayload);
  if (cachedResult) {
    console.info('Azonos bemenet: a mentett tervezet jelenik meg, a szerver hívása kimarad.');
    renderResultDocument(cachedResult);
    lastResult = cachedResult;
    previewReady = true;
    renderPreview();
    updateExportLock();
    refreshRestoreBanner();
    document.getElementById('previewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (readDailyCount().count >= DAILY_FREE_LIMIT) {
    showGenerationError(LIMIT_MESSAGE);
    return;
  }
  revokeUnlock(lastResult?.generationId);
  resetGeneratedResult();
  generationInFlight = true;
  nextBtn.disabled = true;
  nextBtn.classList.add('is-busy');
  nextBtn.textContent = 'Tervezet generálása folyamatban...';
  const payload = buildGenerationPayload();
  const stopLoader = startGenerationLoader(payload);
  document.getElementById('generationLoader')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {

    const apiBaseUrl = getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('A generáló szerver (backend) címe nincs beállítva. Add meg az apiBaseUrl értékét a config.js fájlban.');
    }
    const response = await fetch(`${apiBaseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      throw new Error(`A szerver nem valid JSON-választ adott (HTTP ${response.status}).`);
    }

    if (!response.ok || !data || data.success !== true) {
      const message = [data?.error, data?.details].filter((part) => typeof part === 'string' && part.trim()).join(' ');
      throw new Error(message || `A szerver nem jelzett sikeres generálást (HTTP ${response.status}).`);
    }

    const generatedResult = { ...data, request: payload, generationId: data.generationId || newGenerationId() };
    renderResultDocument(generatedResult);
    lastResult = generatedResult;
    previewReady = true;
    try {
      localStorage.setItem(STORAGE_KEYS.generatedPlan, JSON.stringify(lastResult));
    } catch (storageError) {
      console.warn('A generált terv nem menthető a böngészőbe:', storageError);
    }
    writeDailyCount(readDailyCount().count + 1);
    try {
      localStorage.setItem(STORAGE_KEYS.lastGeneration, JSON.stringify({ payload: JSON.stringify(payload), draft: collectDraftState(), result: generatedResult }));
    } catch (storageError) {
      console.warn('A gyorsítótár nem menthető:', storageError);
    }
    renderPreview();
    setTimeout(() => {
      const previewEl = document.getElementById('previewPanel') || document.getElementById('previewBox');
      if (previewEl) previewEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
    try {
      savePlanToHistory(payload, generatedResult.generationId, false, null);
      renderHistoryPanel();
    } catch (storageError) {
      console.warn('A sikeres terv előzményként nem menthető:', storageError);
    }
  } catch (error) {
    resetGeneratedResult();
    const message = error?.message || 'A generálás hiba miatt nem tudott lefutni.';
    showGenerationError(message === LIMIT_MESSAGE ? message : `Generálási hiba: ${message}`);
  } finally {
    if (window.turnstile && turnstileWidgetId !== null) {
      try { window.turnstile.reset(turnstileWidgetId); } catch (_e) {}
      currentTurnstileToken = '';
    }
    stopLoader();
    generationInFlight = false;
    refreshRestoreBanner();
    nextBtn.disabled = false;
    nextBtn.classList.remove('is-busy');
    nextBtn.textContent = 'Tervezet elkészítése';
    updateExportLock();
  }
}

function scrollToFormTop() {
  // Csak a tervező űrlapra fókuszál (a lap tetejére nem ugrik vissza).
  const form = document.querySelector('.main-form-layout');
  try { if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' }); else window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_error) {}
}
