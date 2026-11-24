// Felhős tervek: a bejelentkezett felhasználó fiókba mentett tervei. A helyi (localStorage) tervek és a fiókban lévők külön maradnak:
// a helyi tervet a felhasználó a "Mentés a profilomba" gombbal kötheti a fiókjához, automatikus összefésülés nincs.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.
// Vendég módban (nincs bejelentkezett felhasználó) nem fut le semmi: a helyi előzmények változatlanok.

const CLOUD_LOCAL_ID_PATTERN = /^gen_[A-Za-z0-9_-]{1,96}$/;
let cloudRequestSeq = 0;

// A helyi előzménylista (tervezo-form.js) ebből tudja, mely tervek vannak már a fiókban és kínálható-e a mentés.
window.oviCloudPlans = {
  ids: new Set(),
  canAdopt: (id) => Boolean(cloudUser()) && CLOUD_LOCAL_ID_PATTERN.test(String(id || '')) && !window.oviCloudPlans.ids.has(id),
  adopt: (id) => adoptLocalPlan(id)
};

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

function formatCloudDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' });
}

function showCloudError(message) {
  const panel = document.getElementById('cloudPlansPanel');
  if (!panel) return showGenerationError(message);
  panel.querySelector('.cloud-error')?.remove();
  const note = document.createElement('div');
  note.className = 'history-item history-item-empty cloud-error';
  note.textContent = message;
  panel.prepend(note);
  return undefined;
}

function renderCloudPlans(documents) {
  const panel = document.getElementById('cloudPlansPanel');
  if (!panel) return;
  panel.innerHTML = '';
  if (!documents.length) {
    const empty = document.createElement('div');
    empty.className = 'history-item history-item-empty';
    empty.textContent = 'A profilodba még nincs mentett terv. A helyi terveid mellett a "Mentés a profilomba" gombbal mentheted el őket.';
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
          <span class="history-badge history-badge-cloud">Profilba mentve</span>
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
        ${item.owned ? '<button type="button" class="btn-history btn-history-delete" data-cloud-action="delete" title="Törlés a profilból">Törlés</button>' : ''}
      </div>`;
    panel.appendChild(card);
  });
}

// A fiókban lévő tervek betöltése; a helyi előzménylista jelvényei is frissülnek.
async function refreshCloudPlans() {
  const field = document.getElementById('cloudPlansField');
  const panel = document.getElementById('cloudPlansPanel');
  if (!field || !panel) return;
  const user = cloudUser();
  field.hidden = !user;
  if (!user) {
    cloudRequestSeq += 1;
    panel.innerHTML = '';
    window.oviCloudPlans.ids = new Set();
    renderHistoryPanel();
    return;
  }
  const seq = ++cloudRequestSeq;
  panel.innerHTML = '<div class="history-item history-item-empty">Mentett tervek betöltése...</div>';
  try {
    const data = await cloudFetch('/api/my-documents');
    if (seq !== cloudRequestSeq) return;
    const documents = Array.isArray(data.documents) ? data.documents : [];
    window.oviCloudPlans.ids = new Set(documents.map((item) => item.id));
    renderCloudPlans(documents);
    renderHistoryPanel();
  } catch (error) {
    if (seq !== cloudRequestSeq) return;
    panel.innerHTML = '';
    const failure = document.createElement('div');
    failure.className = 'history-item history-item-empty cloud-error';
    failure.textContent = `A mentett tervek nem tölthetők be: ${error.message}`;
    panel.appendChild(failure);
  }
}

// Egy helyi terv fiókhoz kötése (csak kifejezett kérésre): a szerver user_id + user_email mezőt rögzít a terven.
async function adoptLocalPlan(id) {
  const data = await cloudFetch('/api/sync-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentIds: [id] })
  });
  if (!Array.isArray(data.claimed) || !data.claimed.includes(id)) {
    throw new Error('a terv nem menthető a profilba (lejárt, vagy már másik fiókhoz tartozik)');
  }
  await refreshCloudPlans();
}

async function deleteCloudPlan(id) {
  await cloudFetch(`/api/my-documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshCloudPlans();
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

// A profiloldal hivatkozása: tervezo.html?open=<azonosító>[&download=docx|pdf]. A paraméterek beolvasás után eltűnnek a címsorból.
function readOpenRequest() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('open');
  if (id === null) return null;
  const format = ['docx', 'pdf'].includes(params.get('download')) ? params.get('download') : '';
  try {
    params.delete('open');
    params.delete('download');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  } catch (_error) { /* a címsor nem módosítható: a paraméter megmarad */ }
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? { id, format } : null;
}

let pendingOpenRequest = null;

async function runPendingOpenRequest() {
  if (!pendingOpenRequest || !cloudUser()) return;
  const request = pendingOpenRequest;
  pendingOpenRequest = null;
  try {
    await openCloudPlan(request.id, request.format);
  } catch (error) {
    showGenerationError(`A mentett terv megnyitása sikertelen: ${error.message}`);
  }
}

function initCloudPlans() {
  pendingOpenRequest = readOpenRequest();
  document.addEventListener('ovi-auth-change', () => {
    refreshCloudPlans();
    runPendingOpenRequest();
  });
  // Bejelentkezés nélkül a megnyitás nem lehetséges: a belépési ablak jelenik meg.
  window.OviAuth?.ready?.then(() => {
    if (pendingOpenRequest && !cloudUser()) window.OviAuth.openModal?.('login');
  });
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
    if (button.dataset.cloudAction === 'delete') {
      if (!window.confirm('Biztosan törlöd ezt a tervet a profilodból? A művelet nem vonható vissza.')) return;
      button.disabled = true;
      try {
        await deleteCloudPlan(id);
      } catch (error) {
        button.disabled = false;
        showCloudError(`A terv törlése sikertelen: ${error.message}`);
      }
      return;
    }
    button.disabled = true;
    try {
      await openCloudPlan(id, button.dataset.cloudAction);
    } catch (error) {
      showGenerationError(`A mentett terv megnyitása sikertelen: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  if (cloudUser()) refreshCloudPlans();
}

initCloudPlans();
