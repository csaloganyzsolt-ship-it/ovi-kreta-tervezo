// Dokumentum felépítése, tördelése, dokumentumfülek és a zárolt előnézet.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

function getExportSettings() {
  const settings = {};
  document.querySelectorAll('[data-export-section]').forEach((checkbox) => {
    settings[checkbox.dataset.exportSection] = checkbox.checked;
  });
  const margin = document.querySelector('[data-export="margin"]')?.value || 'comfortable';
  return { settings, margin };
}

function validateGeneratedPlan(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('A szerver nem dokumentumot tartalmazó JSON objektumot adott vissza.');
  }
  if (result.is_thematic === true) {
    if (!Array.isArray(result.hetek) || !result.hetek.length || result.hetek.some((week) => !week || typeof week.teruletek !== 'object' || typeof week.keretrendszer !== 'object')) {
      throw new Error('A tematikus tervből hiányzik a heti mátrix vagy a pedagógiai keretrendszer.');
    }
    return;
  }
  if (result.is_weekly === true && Array.isArray(result.napok)) {
    if (!result.heti_keretterv || typeof result.heti_keretterv !== 'object' || !result.napok.length) {
      throw new Error('A heti tervezetből hiányzik a keretterv vagy a napi bontás.');
    }
    return;
  }
  if (result.planMode === 'academic' && (!result.tartalom || typeof result.tartalom !== 'object')) {
    throw new Error('Az oktatási célú tervezetből hiányzik a tevékenység tartalma (tartalom).');
  }
  const textFields = ['tevekenyseg_forma', 'elozmeny', 'tema', 'cel',
    'nevelesi_feladatok', 'didaktikai_feladatok', 'kepessegfejlesztes', 'felhasznalt_irodalom'];
  for (const field of textFields) {
    const allowEmpty = field === 'elozmeny' || field === 'felhasznalt_irodalom';
    if (typeof result[field] !== 'string' || (!allowEmpty && !result[field].trim())) {
      throw new Error(`Hiányzó vagy hibás dokumentummező: ${field}.`);
    }
  }
  const isTextArray = (value) => Array.isArray(value) && value.length > 0 &&
    value.every((part) => typeof part === 'string' && part.trim());
  for (const field of ['modszerek', 'eszkozok']) {
    if (!isTextArray(result[field])) throw new Error(`Hiányzó vagy hibás dokumentumlista: ${field}.`);
  }
  if (!Array.isArray(result.kidolgozas_tablazat) || !result.kidolgozas_tablazat.length) {
    throw new Error('A válaszból hiányzik a kidolgozott táblázat.');
  }
  result.kidolgozas_tablazat.forEach((row, index) => {
    if (!row || typeof row.ido !== 'string' || !row.ido.trim() ||
        typeof row.modszerek_megjegyzesek !== 'string' || !row.modszerek_megjegyzesek.trim() ||
        !(isTextArray(row.tevekenyseg_menete) ||
          (typeof row.tevekenyseg_menete === 'string' && row.tevekenyseg_menete.trim()))) {
      throw new Error(`Hiányos vagy hibás táblázatsor: ${index + 1}.`);
    }
  });
}

let activeDocId = null;

let docSettings = {};

function getDocumentList(result = lastResult) {
  if (result?.is_weekly === true && Array.isArray(result.napok)) {
    const req = result.request || lastResult?.request || (typeof buildGenerationPayload === 'function' ? buildGenerationPayload() : {});
    const mondayDate = getMondayDateForWeek(req.dateValue);
    const mondayDateStr = mondayDate.toISOString().slice(0, 10);
    const frame = result.heti_keretterv || {};
    const grid = Array.isArray(frame.teruletek_heti_eloszlasa) ? frame.teruletek_heti_eloszlasa : [];

    return [
      { id: 'keret', label: 'Heti Keretterv', fileBase: `00_heti-keretterv_${mondayDateStr}`, kind: 'frame' },
      ...result.napok.map((day, index) => {
        const dayName = day.nap_neve || `Nap_${index + 1}`;
        const daySlug = WEEKDAY_SLUGS[dayName] || asciiSlug(dayName).toLowerCase() || `nap-${index + 1}`;
        const dayCalDate = getCalendarDateForDay(mondayDate, dayName);

        let areasForDay = [];
        if (req.weeklyFocusAreas && req.weeklyFocusAreas[dayName]) {
          areasForDay = Array.isArray(req.weeklyFocusAreas[dayName])
            ? req.weeklyFocusAreas[dayName]
            : [req.weeklyFocusAreas[dayName]];
        } else {
          const gridRow = grid.find((r) => r && r.nap === dayName);
          if (gridRow?.fo_terulet) {
            areasForDay = [gridRow.fo_terulet];
          } else if (day.tevekenyseg_forma) {
            areasForDay = [day.tevekenyseg_forma];
          }
        }

        const areaSlugParts = areasForDay.map(slugifyAreaName).filter(Boolean);
        const areaSlug = areaSlugParts.length ? areaSlugParts.join('-') : 'tervezet';
        const fileIndex = String(index + 1).padStart(2, '0');

        return {
          id: `nap-${index}`,
          label: dayName,
          fileBase: `${fileIndex}_${daySlug}-${areaSlug}_${dayCalDate}`,
          kind: 'day',
          index
        };
      })
    ];
  }
  if (result?.is_thematic === true) {
    const req = result.request || lastResult?.request || {};
    const mondayDateStr = getMondayDateForWeek(req.dateValue).toISOString().slice(0, 10);
    return [{ id: 'main', label: 'Tematikus terv', fileBase: `tematikus-terv_${mondayDateStr}`, kind: 'thematic' }];
  }
  if (result?.planMode === 'academic') {
    return [{ id: 'main', label: 'Tervezet', fileBase: 'foglalkozasi-terv', kind: 'daily' }];
  }
  return [{ id: 'main', label: 'Tervezet', fileBase: 'ovi-kreta-terv', kind: 'daily' }];
}

function currentDocKey() {
  return activeDocId || 'main';
}

function getDocSettings(docId = currentDocKey()) {
  const settings = { ...DOC_DEFAULTS, ...(docSettings[docId] || {}) };
  // A 7 oszlopos tematikus mátrix csak fekvő A4-en olvasható.
  if (lastResult?.is_thematic === true) settings.orientation = 'landscape';
  return settings;
}

function applyDocSettingsToElement(element, docId) {
  if (!element) return;
  const { orientation, margin } = getDocSettings(docId);
  element.dataset.margin = margin;
  element.dataset.orientation = orientation;
}

function syncDocControls() {
  const { orientation, margin } = getDocSettings();
  const marginSelect = document.querySelector('[data-export="margin"]');
  const orientationSelect = document.querySelector('[data-export="orientation"]');
  if (marginSelect) marginSelect.value = margin;
  if (orientationSelect) {
    orientationSelect.value = orientation;
    orientationSelect.disabled = lastResult?.is_thematic === true;
  }
  const scope = document.getElementById('docSettingsScope');
  if (scope) {
    const doc = getDocumentList().find((item) => item.id === currentDocKey());
    scope.textContent = getDocumentList().length > 1 && doc ? `A beállítások erre a dokumentumra vonatkoznak: ${doc.label}` : '';
  }
}

function applyExportSettingsToDocument() {
  applyDocSettingsToElement(resultDocument, currentDocKey());
}

function renderDocumentTabs(list) {
  const tabs = document.getElementById('documentTabs');
  const zipBtn = document.getElementById('downloadZipBtn');
  const multiple = list.length > 1;
  if (zipBtn) zipBtn.hidden = !multiple;
  if (!tabs) return;
  tabs.hidden = !multiple;
  tabs.innerHTML = multiple ? list.map((doc) => `
          <button type="button" role="tab" class="doc-tab${doc.id === activeDocId ? ' active' : ''}" data-doc-id="${escapeHtml(doc.id)}" aria-selected="${doc.id === activeDocId}">${escapeHtml(doc.label)}</button>`).join('') : '';
}

function selectDocument(docId) {
  if (!lastResult || !getDocumentList().some((doc) => doc.id === docId)) return;
  activeDocId = docId;
  renderResultDocument(lastResult);
  persistDraftState();
}

function renderTableColumns(showMethods, orientation) {
  const landscape = orientation === 'landscape';
  const time = landscape ? 8 : 10;
  const methods = landscape ? 28 : 32;
  const middle = showMethods ? 100 - time - methods : 100 - time;
  return `<colgroup><col style="width: ${time}%;" /><col style="width: ${middle}%;" />${showMethods ? `<col style="width: ${methods}%;" />` : ''}</colgroup>`;
}

function buildLockedBoundaryCard(result) {
  const meta = (typeof window !== 'undefined' && window.getLockedMeta)
    ? window.getLockedMeta(result)
    : (typeof getLockedMeta === 'function' ? getLockedMeta(result) : { table_count: 1, activity_count: (result?.kidolgozas_tablazat || []).length });
  const price = PAYWALL_PRICES[planKind(result)] || 390;
  return `
          <div class="locked-boundary-card">
            <div class="locked-boundary-badge">Zárolt szakasz</div>
            <p class="locked-boundary-text">A teljes dokumentum elkészült: ${escapeHtml(meta.table_count)} részletes táblázat és ${escapeHtml(meta.activity_count)} kidolgozott tevékenységi egység vár feloldásra.</p>
            <button type="button" class="unlock-cta" data-action="unlock">Teljes tervezet feloldása – ${escapeHtml(price)} Ft</button>
          </div>`;
}

function buildActivityTable(rows, showMethods, orientation, locked = false) {
  return `
          <table class="official-table ${locked ? 'locked-mirror-table' : ''}">
            ${renderTableColumns(showMethods, orientation)}
            <thead>
              <tr>
                <th>Idő</th>
                <th>A fejlesztő tevékenység felépítése</th>
                ${showMethods ? '<th>A fejlesztés módszerei és megjegyzések</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${(Array.isArray(rows) ? rows : []).map((row) => `
                <tr>
                  <td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.ido)}</div></td>
                  <td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.tevekenyseg_menete)}</div></td>
                  ${showMethods ? `<td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.modszerek_megjegyzesek)}</div></td>` : ''}
                </tr>`).join('')}
            </tbody>
          </table>`;
}

function buildMetaBlock(metaRows) {
  return `
          <div class="doc-section doc-meta-block">
            <div class="official-meta">
              ${metaRows.map(([label, value]) => `
                <div class="meta-row">
                  <span class="meta-label">${escapeHtml(label)}</span>
                  <span class="meta-value">${escapeHtml(value)}</span>
                </div>`).join('')}
            </div>
          </div>`;
}

function buildDocumentHtml(result, request, docId) {
  const { settings } = getExportSettings();
  const { orientation } = getDocSettings(docId);
  const showMethods = settings.differentiation !== false;
  const showLiterature = document.querySelector('[data-field="show-literature"]')?.checked ?? result.showLiteratureAtBottom ?? false;
  const locked = isPlanLocked(result);

  if (result.is_thematic === true) return buildThematicHtml(result, request, { settings, locked });
  if (result.planMode === 'academic') return buildAcademicDailyHtml(result, request, { settings, showMethods, locked });

  if (result.is_weekly === true && Array.isArray(result.napok)) {
    const frame = result.heti_keretterv || {};
    const summary = result.summary || [frame.tema, request.group, request.duration, request.dateValue].filter(Boolean).join(' • ');
    const baseMeta = [
      ['Óvoda', request.kindergartenName || '—'],
      ['Óvodapedagógus', request.teacherName || '—'],
      ['Csoport', request.groupName || request.group || '—']
    ];
    if (docId !== 'keret') {
      const day = result.napok[Number(docId.replace('nap-', ''))] || {};
      const dayName = day.nap_neve || '';
      let dayAreaText = '';
      if (request.weeklyFocusAreas && request.weeklyFocusAreas[dayName]) {
        const raw = request.weeklyFocusAreas[dayName];
        dayAreaText = Array.isArray(raw) ? raw.join(', ') : String(raw);
      }
      if (!dayAreaText && frame.teruletek_heti_eloszlasa) {
        const gridRow = frame.teruletek_heti_eloszlasa.find((r) => r && r.nap === dayName);
        if (gridRow?.fo_terulet) dayAreaText = gridRow.fo_terulet;
      }
      return `
              <div class="doc-header">
                <h2>Napi tervezet – ${escapeHtml(day.nap_neve || '')}</h2>
              </div>
              ${buildMetaBlock([
          ...baseMeta,
          ['Nevelési terület', dayAreaText || '—'],
          ['Téma', frame.tema || '—'],
          ['Forma', day.tevekenyseg_forma || '—'],
          ['Napi cél', day.napi_cel || '—']
        ])}
              ${(settings.activities !== false || locked) ? `
                ${locked ? buildLockedBoundaryCard(result) : ''}
                <div class="doc-section document-day-sheet ${locked ? 'locked-mirror-section' : ''}">
                  <h3>A tevékenység/foglalkozás kidolgozása</h3>
                  ${buildActivityTable(day.kidolgozas_tablazat, showMethods, orientation, locked)}
                </div>` : ''}`;
    }

    const metaRows = [...baseMeta, ['Téma', frame.tema || '—'], ['Heti fő cél', frame.heti_fo_cel || '—']];
    if (settings.materials !== false) {
      metaRows.push(['Eszközök', (Array.isArray(frame.eszkozok) ? frame.eszkozok : []).join(', ')]);
    }
    const grid = Array.isArray(frame.teruletek_heti_eloszlasa) ? frame.teruletek_heti_eloszlasa : [];
    const gridWidths = orientation === 'landscape' ? [12, 28, 60] : [16, 34, 50];
    return `
            <div class="doc-header">
              <h2>Heti tervezet</h2>
            </div>
            ${settings.summary !== false ? `
              <div class="doc-section">
                <p class="doc-summary"><strong>Projekt:</strong> ${escapeHtml(summary)}</p>
              </div>` : ''}
            ${buildMetaBlock(metaRows)}
            ${settings.goals !== false ? `
              <div class="doc-section">
                <h3>Cél- és feladatrendszer</h3>
                <p><strong>Nevelési feladatok:</strong> ${escapeHtml(frame.nevelesi_feladatok || '')}</p>
                <p><strong>Didaktikai feladatok:</strong> ${escapeHtml(frame.didaktikai_feladatok || '')}</p>
              </div>` : ''}
            <div class="doc-section doc-table-section">
              <h3>Területek heti elosztása</h3>
              <table class="official-table">
                <colgroup>${gridWidths.map((width) => `<col style="width: ${width}%;" />`).join('')}</colgroup>
                <thead><tr><th>Nap</th><th>Fő terület</th><th>Csoportos tevékenység / Tevékenység</th></tr></thead>
                <tbody>
                  ${grid.map((row) => `
                    <tr>
                      <td>${formatTableCell(row.nap)}</td>
                      <td>${formatTableCell(row.fo_terulet)}</td>
                      <td>${formatTableCell(row.csoportos_tevekenyseg || row.mikrocsoportos_tevekenyseg)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
            ${showLiterature && String(frame.felhasznalt_irodalom || '').trim() ? `
              <div class="doc-section">
                <h3>Felhasznált irodalom</h3>
                ${formatTableCell(frame.felhasznalt_irodalom)}
              </div>` : ''}`;
  }

  const summary = result.summary || [result.tema, request.group, request.duration, request.dateValue].filter(Boolean).join(' • ');
  const title = request.planMode === 'weekly' ? 'Heti tervezet' : 'Napi tervezet';
  const focusAreasText = Array.isArray(request.focusAreas) && request.focusAreas.length > 0
    ? request.focusAreas.join(', ')
    : '—';
  const metaRows = [
    ['Óvoda', request.kindergartenName || '—'],
    ['Óvodapedagógus', request.teacherName || '—'],
    ['Csoport', request.groupName || request.group || '—'],
    ['Nevelési terület', focusAreasText],
    ['Forma', result.tevekenyseg_forma],
    ['Előzmény', result.elozmeny],
    ['Téma', result.tema],
    ['Cél', result.cel]
  ];
  if (settings.materials !== false) metaRows.push(['Eszközök', result.eszkozok.join(', ')]);
  const professionalFields = [
    ['Nevelési feladatok', result.nevelesi_feladatok],
    ['Didaktikai feladatok', result.didaktikai_feladatok],
    ['Képességfejlesztés', result.kepessegfejlesztes],
    ['Módszerek', result.modszerek.join(', ')]
  ];

  return `
          <div class="doc-header">
            <h2>${escapeHtml(title)}</h2>
          </div>
          ${settings.summary !== false ? `
            <div class="doc-section">
              <p class="doc-summary"><strong>Projekt:</strong> ${escapeHtml(summary)}</p>
            </div>` : ''}
          ${buildMetaBlock(metaRows)}
          ${settings.goals !== false ? `
            <div class="doc-section">
              <h3>Cél- és feladatrendszer</h3>
              ${professionalFields.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')}
            </div>` : ''}
          ${(settings.activities !== false || locked) ? `
            ${locked ? buildLockedBoundaryCard(result) : ''}
            <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
              <h3>A tevékenység/foglalkozás kidolgozása</h3>
              ${buildActivityTable(result.kidolgozas_tablazat, showMethods, orientation, locked)}
            </div>` : ''}
          ${showLiterature && result.felhasznalt_irodalom.trim() ? `
            <div class="doc-section">
              <h3>Felhasznált irodalom</h3>
              ${formatTableCell(result.felhasznalt_irodalom)}
            </div>` : ''}`;
}

function renderResultDocument(data = lastResult) {
  if (!data) {
    resultDocument.replaceChildren();
    updateExportLock();
    return;
  }
  validateGeneratedPlan(data);
  lastResult = data;
  window.lastResult = lastResult;
  syncActivitiesControl();
  const request = data.request || buildGenerationPayload();
  const list = getDocumentList(data);
  if (!list.some((doc) => doc.id === activeDocId)) activeDocId = list[0].id;
  resultDocument.innerHTML = buildDocumentHtml(data, request, activeDocId);
  renderDocumentTabs(list);
  syncDocControls();
  applyExportSettingsToDocument();
  paginateDocument(resultDocument);
  applyPaywall(resultDocument);
  updateExportLock();
}

// A dokumentumot valódi A4 lapokra (.a4-page) tördeli; a hosszú táblázatokat sorok mentén osztja, fejléc-ismétléssel.
function paginateDocument(host) {
  const orientation = host.dataset.orientation === 'landscape' ? 'landscape' : 'portrait';
  const marginMm = MARGIN_MM[host.dataset.margin] || MARGIN_MM.comfortable;
  const blocks = Array.from(host.children);

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100mm;height:0;';
  host.appendChild(probe);
  const pxPerMm = probe.offsetWidth / 100;
  probe.remove();

  const makePage = () => {
    const page = document.createElement('div');
    page.className = 'a4-page';
    const body = document.createElement('div');
    body.className = 'a4-page-body';
    page.appendChild(body);
    host.appendChild(page);
    return body;
  };

  host.replaceChildren();
  host.dataset.paginated = pxPerMm ? '1' : '';
  let body = makePage();
  if (!pxPerMm) {
    blocks.forEach((block) => body.appendChild(block));
    return;
  }

  const capacity = (PAGE_MM[orientation][1] - marginMm * 2) * pxPerMm;
  const overflows = () => body.offsetHeight > capacity + 1;
  const newPage = () => { body = makePage(); };

  blocks.forEach((block) => {
    body.appendChild(block);
    if (!overflows()) return;

    const table = block.querySelector('.official-table');
    const rows = table ? Array.from(table.tBodies[0]?.rows || []) : [];
    // Az oktatási célú táblázatok egyetlen lapnál magasabb sora a cellák bekezdései mentén tovább osztható.
    const splittable = Boolean(table?.classList.contains('academic-table'));
    if (!rows.length || (rows.length < 2 && !splittable)) {
      if (body.children.length > 1) {
        newPage();
        body.appendChild(block);
      }
      return;
    }

    // Táblázatos blokk: sorok mentén szétosztás, a folytatás fejléces táblázatként új lapon indul.
    const tbody = table.tBodies[0];
    rows.forEach((row) => row.remove());
    let current = block;
    let currentBody = tbody;
    const openContinuation = () => {
      const continuation = current.cloneNode(true);
      continuation.querySelectorAll('h3').forEach((node) => node.remove());
      const continuationBody = continuation.querySelector('.official-table').tBodies[0];
      continuationBody.replaceChildren();
      newPage();
      body.appendChild(continuation);
      current = continuation;
      currentBody = continuationBody;
    };
    const splitOversizedRow = (row) => {
      let pending = row;
      while (overflows()) {
        const tail = splitTallRow(pending, overflows);
        if (!tail) return;
        openContinuation();
        currentBody.appendChild(tail);
        pending = tail;
      }
    };
    rows.forEach((row) => {
      currentBody.appendChild(row);
      if (!overflows()) return;
      if (currentBody.rows.length === 1) {
        if (body.children.length > 1) {
          newPage();
          body.appendChild(current);
        }
        if (splittable) splitOversizedRow(row);
        return;
      }
      currentBody.removeChild(row);
      openContinuation();
      currentBody.appendChild(row);
      if (splittable) splitOversizedRow(row);
    });
  });

  host.querySelectorAll('.a4-page').forEach((page) => {
    if (!page.textContent.trim() && host.querySelectorAll('.a4-page').length > 1) page.remove();
  });
}

function renderPreview() {
  const showPreview = currentStep >= 3 && previewReady;
  previewPanel.classList.toggle('preview-hidden', !showPreview);
  // Kész dokumentum nélkül (vagy az 1–3. lépésben) a teljes előnézeti konténer rejtve marad.
  previewPanel.hidden = !showPreview;
  previewEmpty.style.display = showPreview ? 'none' : 'grid';
  previewContent.style.display = showPreview ? 'block' : 'none';
  // Rejtett állapotban nem mérhető a lap magassága, ezért láthatóvá váláskor újratördelünk.
  if (showPreview && lastResult && resultDocument.dataset.paginated !== '1') renderResultDocument(lastResult);
}

function loadGeneratedPlanFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.generatedPlan) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (!saved.generationId) saved.generationId = newGenerationId();
    renderResultDocument(saved);
    previewReady = true;
    currentStep = Math.max(currentStep, 3);
  } catch (error) {
    console.warn('A mentett terv nem tölthető vissza:', error);
    lastResult = null;
    previewReady = false;
  }
}

function resetGeneratedResult() {
  lastResult = null;
  activeDocId = null;
  renderDocumentTabs([]);
  previewReady = false;
  resultDocument.replaceChildren();
  renderPreview();
}

function showGenerationError(message) {
  const banner = document.getElementById('generationErrorBanner');
  if (!banner) {
    alert(message);
    return;
  }

  banner.textContent = message;
  banner.hidden = false;
  banner.style.display = 'block';
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideGenerationErrorBanner() {
  const banner = document.getElementById('generationErrorBanner');
  if (!banner) return;
  banner.hidden = true;
  banner.style.display = 'none';
  banner.textContent = '';
}
