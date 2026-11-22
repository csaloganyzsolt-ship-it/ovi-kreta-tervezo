// Felhős tervek: belépés után a helyi tervek fiókhoz kötése és a mentett tervek listája.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.
// Vendég módban (nincs bejelentkezett felhasználó) nem fut le semmi: a helyi előzmények változatlanok.

const CLOUD_LOCAL_ID_PATTERN = /^gen_[A-Za-z0-9_-]{1,96}$/;
const CLOUD_SYNC_MAX_IDS = 50;
let cloudRequestSeq = 0;

function cloudUser() {
  return window.OviAuth?.getUser?.() || null;
}

async function cloudFetch(path, options = {}) {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// A böngészőben ismert tervazonosítók: helyi előzmények, feloldott tervek és az utoljára generált terv.
function collectLocalPlanIds() {
  const ids = new Set();
  const add = (id) => { if (typeof id === 'string' && CLOUD_LOCAL_ID_PATTERN.test(id)) ids.add(id); };
  loadHistoryFromStorage().forEach((item) => { add(item.generationId); add(item.id); });
  getUnlockedIds().forEach(add);
  try { add(JSON.parse(localStorage.getItem(STORAGE_KEYS.generatedPlan) || 'null')?.generationId); } catch (_error) { /* hibás mentés: kihagyjuk */ }
  return [...ids].slice(0, CLOUD_SYNC_MAX_IDS);
}

function formatCloudDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderCloudPlans(documents, syncError = '') {
  const panel = document.getElementById('cloudPlansPanel');
  if (!panel) return;
  panel.innerHTML = '';
  if (syncError) {
    const note = document.createElement('div');
    note.className = 'history-item history-item-empty cloud-error';
    note.textContent = `A helyi tervek fiókhoz kötése sikertelen: ${syncError}`;
    panel.appendChild(note);
  }
  if (!documents.length) {
    const empty = document.createElement('div');
    empty.className = 'history-item history-item-empty';
    empty.textContent = 'A fiókodhoz még nem tartozik mentett terv.';
    panel.appendChild(empty);
    return;
  }
  documents.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'history-item-card';
    card.dataset.cloudId = item.id;
    card.innerHTML = `
      <div class="history-item-header">
        <div class="history-item-title-row">
          <strong class="history-item-title">${escapeHtml(item.title)}</strong>
          <span class="history-item-type">${escapeHtml(item.duration === 'Heti' ? 'Heti' : 'Napi')}</span>
        </div>
        <div class="history-item-meta">
          <span class="history-item-date">${escapeHtml(formatCloudDate(item.createdAt))}</span>
          <span class="history-badge history-badge-cloud">Felhőben mentve</span>
          ${item.unlocked
    ? '<span class="history-badge history-badge-paid">Fizetve</span>'
    : '<span class="history-badge history-badge-draft">Csak előnézet (piszkozat)</span>'}
        </div>
      </div>
      <div class="history-item-actions">
        <button type="button" class="btn-history btn-history-load" data-cloud-action="open">Megnyitás</button>
        ${item.unlocked
    ? '<button type="button" class="btn-history btn-history-download" data-cloud-action="docx">Letöltés (Word)</button><button type="button" class="btn-history btn-history-download" data-cloud-action="pdf">Letöltés (PDF)</button>'
    : ''}
      </div>`;
    panel.appendChild(card);
  });
}

// Belépés után (sync = true) előbb a helyi tervek a fiókhoz kötődnek, majd betöltődik a felhős lista.
async function refreshCloudPlans({ sync = false } = {}) {
  const field = document.getElementById('cloudPlansField');
  const panel = document.getElementById('cloudPlansPanel');
  if (!field || !panel) return;
  const user = cloudUser();
  field.hidden = !user;
  if (!user) {
    cloudRequestSeq += 1;
    panel.innerHTML = '';
    return;
  }
  const seq = ++cloudRequestSeq;
  panel.innerHTML = '<div class="history-item history-item-empty">Mentett tervek betöltése...</div>';
  let syncError = '';
  try {
    if (sync) {
      const ids = collectLocalPlanIds();
      if (ids.length) {
        try {
          await cloudFetch('/api/sync-documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentIds: ids })
          });
        } catch (error) {
          syncError = error.message;
        }
      }
    }
    const data = await cloudFetch('/api/my-documents');
    if (seq !== cloudRequestSeq) return;
    renderCloudPlans(Array.isArray(data.documents) ? data.documents : [], syncError);
  } catch (error) {
    if (seq !== cloudRequestSeq) return;
    panel.innerHTML = '';
    const failure = document.createElement('div');
    failure.className = 'history-item history-item-empty cloud-error';
    failure.textContent = `A mentett tervek nem tölthetők be: ${error.message}`;
    panel.appendChild(failure);
  }
}

// A felhős tervhez a feloldás helyben is rögzül (a napi ingyenes keretet nem érinti, ellentétben az unlockGeneration-nel).
function grantLocalUnlock(id) {
  const ids = getUnlockedIds();
  if (ids.includes(id)) return;
  ids.push(id);
  localStorage.setItem('oviKretaUnlocked', JSON.stringify(ids));
}

async function openCloudPlan(id, format) {
  const data = await cloudFetch(`/api/my-documents/${encodeURIComponent(id)}`);
  const plan = data.plan;
  if (data.unlocked) grantLocalUnlock(id);
  lastResult = { ...plan, request: plan.request, generationId: id };
  window.lastResult = lastResult;
  try {
    localStorage.setItem(STORAGE_KEYS.generatedPlan, JSON.stringify(lastResult));
  } catch (_error) { /* nincs tár: a terv a memóriában marad */ }
  previewReady = true;
  currentStep = steps.length - 1;
  renderStep();
  renderResultDocument(lastResult);
  renderPreview();
  updateExportLock();
  document.getElementById('previewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!data.unlocked) return;
  if (format === 'docx') await exportAsDocx();
  else if (format === 'pdf') await exportAsPdf();
}

function initCloudPlans() {
  document.addEventListener('ovi-auth-change', () => { refreshCloudPlans({ sync: true }); });
  document.getElementById('cloudPlansRefresh')?.addEventListener('click', () => refreshCloudPlans());
  loadPreviousBtn?.addEventListener('click', () => { if (cloudUser()) refreshCloudPlans(); });
  // A "Mentett terveim" hivatkozás az első lépésre visz, ahol a lista található.
  document.getElementById('authPlansLink')?.addEventListener('click', () => {
    currentStep = 0;
    renderStep();
  });
  document.getElementById('cloudPlansPanel')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-cloud-action]');
    const id = button?.closest('[data-cloud-id]')?.dataset.cloudId;
    if (!button || !id) return;
    button.disabled = true;
    try {
      await openCloudPlan(id, button.dataset.cloudAction);
    } catch (error) {
      showGenerationError(`A mentett terv megnyitása sikertelen: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  if (cloudUser()) refreshCloudPlans({ sync: true });
}

initCloudPlans();
