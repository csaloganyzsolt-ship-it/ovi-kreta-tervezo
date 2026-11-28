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
  if (appConfig.maintenance) return;
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

const ACADEMIC_PHASES = [
  [0, 'Szakmódszertani váz és célrendszer összeállítása...'],
  [20, 'Percre bontott foglalkozásmenet / tematikus mátrix kidolgozása...'],
  [60, 'Versek, mondókák és forráskódok pontosítása...'],
  [100, 'Felhasznált irodalom és formázás...']
];

function startGenerationLoader(payload) {
  const loader = document.getElementById('generationLoader');
  const status = document.getElementById('generationStatus');
  const elapsed = document.getElementById('generationElapsed');
  const isPackage = payload.duration === 'Heti' && payload.weeklyScope === 'package';
  const phases = payload.planMode === 'academic' ? ACADEMIC_PHASES : (isPackage ? WEEKLY_PHASES : DAILY_PHASES);
  generationProgress = null;
  const startedAt = Date.now();
  const tick = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const phase = phases.filter(([from]) => seconds >= from).pop();
    const progress = generationProgress;
    if (status) {
      status.textContent = progress && progress.label
        ? `${progress.label} (${progress.done}/${progress.total} lépés kész)`
        : phase[1];
    }
    if (elapsed) elapsed.textContent = `Eltelt idő: ${seconds} mp${isPackage ? ' – a teljes heti csomag több percig is eltarthat, ne zárd be az oldalt' : (phases === ACADEMIC_PHASES ? ' – az oktatási célú tervezet akár 2–3 percig is eltarthat' : '')}`;
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
let generationProgress = null;

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 15 * 60 * 1000;
const POLL_MAX_NETWORK_ERRORS = 5;

// Az aszinkron (heti csomag) generálás állapotát kérdezi le; a folyamatjelző feliratát a szerver lépéscímkéi adják.
async function pollGenerationJob(apiBaseUrl, started) {
  const startedAt = Date.now();
  let networkErrors = 0;
  let view = started;
  for (;;) {
    generationProgress = view.progress || generationProgress;
    if (view.status === 'done') {
      if (!view.result) throw new Error('A szerver befejezettnek jelezte a generálást, de nem adott vissza tervezetet.');
      return { ...view.result, success: true };
    }
    if (view.status === 'error') throw new Error(view.error || 'A heti csomag generálása sikertelen volt.');
    if (Date.now() - startedAt > POLL_MAX_MS) throw new Error('A generálás időtúllépés miatt megszakadt. Kérjük, próbáld újra.');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let response;
    try {
      response = await fetch(`${apiBaseUrl}/api/generate/${encodeURIComponent(started.generationId)}/status`, { headers: { ...authHeaders() } });
    } catch (networkError) {
      networkErrors += 1;
      if (networkErrors >= POLL_MAX_NETWORK_ERRORS) throw new Error('A kapcsolat megszakadt a generálás követése közben. Kérjük, próbáld újra.');
      continue;
    }
    if (response.status === 404) throw new Error('A generálás állapota nem található (a szerver újraindulhatott). Kérjük, indítsd újra a generálást.');
    let body;
    try { body = await response.json(); } catch (_error) { body = null; }
    if (!response.ok || !body) {
      networkErrors += 1;
      if (networkErrors >= POLL_MAX_NETWORK_ERRORS) throw new Error(body?.error || `A generálás állapota nem kérdezhető le (HTTP ${response.status}).`);
      continue;
    }
    networkErrors = 0;
    view = body;
  }
}

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
  updateExportLock();
  generationInFlight = true;
  nextBtn.disabled = true;
  nextBtn.classList.add('is-busy');
  nextBtn.textContent = 'Tervezet generálása folyamatban...';
  const payload = buildGenerationPayload();
  window.telemetry?.logEvent('generator_started', { plan_mode: String(payload.duration).toLowerCase() === 'heti' ? 'weekly' : 'daily', age_group: payload.group, theme_category: payload.theme });
  window.telemetry?.logFunnel?.('generator_started');
  window.OviTracking?.track('generate_plan');
  const stopLoader = startGenerationLoader(payload);
  document.getElementById('generationLoader')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {

    const apiBaseUrl = getApiBaseUrl();
    if (!apiBaseUrl) {
      throw new Error('A generáló szerver (backend) címe nincs beállítva. Add meg az apiBaseUrl értékét a config.js fájlban.');
    }
    const response = await fetch(`${apiBaseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      // Fizetőfalnál a zárolt előnézetet a kliens is kéri; a zárolást a szerver konfigurációja akkor is érvényesíti, ha ez hiányzik.
      body: JSON.stringify(paywallEnabled() ? { ...payload, preview: true } : payload),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      if (response.status === 503 || response.status === 504 || response.status === 529 || response.status === 502 || response.status === 500) {
        throw new Error('A rendszer jelenleg túlterhelt vagy a kapcsolat megszakadt. Kérjük, várj egy picit, és kattints újra a generálás gombra!');
      }
      throw new Error(`A szerver nem valid JSON-választ adott (HTTP ${response.status}).`);
    }

    if (!response.ok || !data || data.success !== true) {
      const rawDetails = [data?.error, data?.details].filter((part) => typeof part === 'string' && part.trim()).join(' ');
      if (response.status === 503 || response.status === 504 || response.status === 529 ||
          /503|529|504|timeout|abort|overload|túlterhelt|megszakadt/i.test(rawDetails)) {
        throw new Error('A rendszer jelenleg túlterhelt vagy a kapcsolat megszakadt. Kérjük, várj egy picit, és kattints újra a generálás gombra!');
      }
      throw new Error(rawDetails || `A szerver nem jelzett sikeres generálást (HTTP ${response.status}).`);
    }

    if (data.async) data = await pollGenerationJob(apiBaseUrl, data);

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
    window.telemetry?.logFunnel?.('document_generated');
    try {
      const kind = typeof planKind === 'function' ? planKind() : 'daily';
      const price = paywallPrice(kind);
      window.OviTracking?.track('view_item', { value: price, items: [{ item_id: kind, price, quantity: 1 }] });
    } catch (trackError) {
      console.warn('A view_item esemény nem küldhető:', trackError.message);
    }
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
    const message = error?.message || '';
    if (message === LIMIT_MESSAGE) {
      showGenerationError(LIMIT_MESSAGE);
    } else if (
      message === 'A rendszer jelenleg túlterhelt vagy a kapcsolat megszakadt. Kérjük, várj egy picit, és kattints újra a generálás gombra!' ||
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      /503|529|504|timeout|túlterhelt|megszakadt/i.test(message)
    ) {
      showGenerationError('A rendszer jelenleg túlterhelt vagy a kapcsolat megszakadt. Kérjük, várj egy picit, és kattints újra a generálás gombra!');
    } else {
      showGenerationError(`Generálási hiba: ${message}`);
    }
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
    applyMaintenanceState();
    updateExportLock();
  }
}

function scrollToFormTop() {
  // Csak a tervező űrlapra fókuszál (a lap tetejére nem ugrik vissza).
  const form = document.querySelector('.main-form-layout');
  try { if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' }); else window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_error) {}
}
