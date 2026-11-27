// Dokumentum felépítése, tördelése, dokumentumfülek és a zárolt előnézet.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

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
  if (result.is_weekly_summary === true) {
    const body = result.heti_osszesito;
    if (!body || typeof body.teruletek !== 'object' || typeof body.keretrendszer !== 'object' || typeof body.megjegyzes_egyeb_tevekenysegek !== 'object') {
      throw new Error('A heti összesítőből hiányzik a területi bontás, a keretrendszer vagy a megjegyzés blokk.');
    }
    return;
  }
  if (result.is_weekly === true && Array.isArray(result.napok)) {
    const hasFrame = (result.heti_osszesito && typeof result.heti_osszesito === 'object') || (result.heti_keretterv && typeof result.heti_keretterv === 'object');
    if (!hasFrame || !result.napok.length) {
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

function getDocumentList(result = lastResult) {
  if (result?.is_weekly_summary === true) {
    const req = result.request || lastResult?.request || {};
    const mondayDateStr = getMondayDateForWeek(req.dateValue).toISOString().slice(0, 10);
    return [{ id: 'main', label: 'Heti összesítő', fileBase: `heti-osszesito_${mondayDateStr}`, kind: 'weekly_summary' }];
  }
  if (result?.is_weekly === true && Array.isArray(result.napok)) {
    const req = result.request || lastResult?.request || (typeof buildGenerationPayload === 'function' ? buildGenerationPayload() : {});
    const mondayDate = getMondayDateForWeek(req.dateValue);
    const mondayDateStr = mondayDate.toISOString().slice(0, 10);
    const frame = result.heti_keretterv || {};
    const grid = Array.isArray(frame.teruletek_heti_eloszlasa) ? frame.teruletek_heti_eloszlasa
      : (Array.isArray(result.heti_osszesito?.napi_beosztas) ? result.heti_osszesito.napi_beosztas : []);

    return [
      result.heti_osszesito
        ? { id: 'keret', label: 'Heti összesítő', fileBase: `00_heti-osszesito_${mondayDateStr}`, kind: 'frame' }
        : { id: 'keret', label: 'Heti Keretterv', fileBase: `00_heti-keretterv_${mondayDateStr}`, kind: 'frame' },
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

// A 7 oszlopos tematikus mátrix és a heti összesítő fekvő A4-en olvasható; minden más dokumentum (a heti csomag napi tervei is) álló A4. Egységes 15 mm-es margó (PAGE_MARGIN_MM).
function getDocOrientation(result = lastResult, docId = activeDocId) {
  if (result?.is_thematic === true || result?.is_weekly_summary === true) return 'landscape';
  if (result?.is_weekly === true && result.heti_osszesito && docId === 'keret') return 'landscape';
  return 'portrait';
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

function renderTableColumns(orientation) {
  const landscape = orientation === 'landscape';
  const time = landscape ? 8 : 10;
  const methods = landscape ? 28 : 32;
  const middle = 100 - time - methods;
  return `<colgroup><col style="width: ${time}%;" /><col style="width: ${middle}%;" /><col style="width: ${methods}%;" /></colgroup>`;
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

function buildActivityTable(rows, orientation, locked = false) {
  return `
          <table class="official-table ${locked ? 'locked-mirror-table' : ''}">
            ${renderTableColumns(orientation)}
            <thead>
              <tr>
                <th>Idő</th>
                <th>A fejlesztő tevékenység felépítése</th>
                <th>A fejlesztés módszerei és megjegyzések</th>
              </tr>
            </thead>
            <tbody>
              ${(Array.isArray(rows) ? rows : []).map((row) => `
                <tr>
                  <td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.ido)}</div></td>
                  <td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.tevekenyseg_menete)}</div></td>
                  <td><div class="${locked ? 'locked-mirror-text' : ''}">${formatTableCell(row.modszerek_megjegyzesek)}</div></td>
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
  const orientation = getDocOrientation(result, docId);
  const locked = isPlanLocked(result);

  if (result.is_thematic === true) return buildThematicHtml(result, request, { locked });
  if (result.planMode === 'academic') return buildAcademicDailyHtml(result, request, { locked });
  if (result.is_weekly_summary === true) return buildWeeklySummaryHtml(result, request, { locked });

  if (result.is_weekly === true && Array.isArray(result.napok) && result.heti_osszesito) {
    if (docId === 'keret') return buildWeeklySummaryHtml(result, request, { locked });
    const day = result.napok[Number(String(docId).replace('nap-', ''))] || {};
    const assigned = Array.isArray(request.weeklyFocusAreas?.[day.nap_neve]) ? request.weeklyFocusAreas[day.nap_neve] : [];
    const row = (result.heti_osszesito.napi_beosztas || []).find((item) => item.nap === day.nap_neve);
    const dayRequest = {
      ...request,
      dateValue: day.datum || request.dateValue,
      focusAreas: assigned.length ? assigned : (row?.fo_terulet ? [row.fo_terulet] : request.focusAreas)
    };
    return buildDailyHtml({ ...day, showLiteratureAtBottom: result.showLiteratureAtBottom }, dayRequest, { orientation, locked, title: `Napi tervezet – ${day.nap_neve || ''}`, lockResult: result });
  }

  const showLiterature = result.showLiteratureAtBottom ?? false;

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
              ${locked ? buildLockedBoundaryCard(result) : ''}
              <div class="doc-section document-day-sheet ${locked ? 'locked-mirror-section' : ''}">
                <h3>A tevékenység/foglalkozás kidolgozása</h3>
                ${buildActivityTable(day.kidolgozas_tablazat, orientation, locked)}
              </div>`;
    }

    const metaRows = [...baseMeta, ['Téma', frame.tema || '—'], ['Heti fő cél', frame.heti_fo_cel || '—'],
      ['Eszközök', (Array.isArray(frame.eszkozok) ? frame.eszkozok : []).join(', ')]];
    const grid = Array.isArray(frame.teruletek_heti_eloszlasa) ? frame.teruletek_heti_eloszlasa : [];
    const gridWidths = orientation === 'landscape' ? [12, 28, 60] : [16, 34, 50];
    return `
            <div class="doc-header">
              <h2>Heti tervezet</h2>
            </div>
            <div class="doc-section">
              <p class="doc-summary"><strong>Projekt:</strong> ${escapeHtml(summary)}</p>
            </div>
            ${buildMetaBlock(metaRows)}
            <div class="doc-section">
              <h3>Cél- és feladatrendszer</h3>
              <p><strong>Nevelési feladatok:</strong> ${escapeHtml(frame.nevelesi_feladatok || '')}</p>
              <p><strong>Didaktikai feladatok:</strong> ${escapeHtml(frame.didaktikai_feladatok || '')}</p>
            </div>
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

  return buildDailyHtml(result, request, { orientation, locked, title: 'Napi tervezet' });
}

// Napi tervezet (önálló, illetve a heti csomag napja): teljes fejléc, cél- és feladatrendszer, kidolgozási táblázat, irodalom.
function buildDailyHtml(result, request, { orientation, locked, title, lockResult = result }) {
  const showLiterature = result.showLiteratureAtBottom ?? false;
  const summary = result.summary || [result.tema, request.group, request.duration, request.dateValue].filter(Boolean).join(' • ');
  const focusAreasText = Array.isArray(request.focusAreas) && request.focusAreas.length > 0
    ? request.focusAreas.join(', ')
    : '—';
  const specialNeeds = Array.isArray(request.specialNeeds) ? request.specialNeeds.filter(Boolean) : [];
  const metaRows = [
    ['Óvoda', request.kindergartenName || '—'],
    ['Óvodapedagógus', request.teacherName || '—'],
    ['Csoport', request.groupName || request.group || '—'],
    ['Dátum', formatAcademicDate(request.dateValue) || '—'],
    ['Létszám', request.childCount ? `${request.childCount} fő` : '—'],
    ...(specialNeeds.length ? [['SNI / differenciálás', specialNeeds.join(', ')]] : []),
    ['Nevelési terület', focusAreasText],
    ['Forma', result.tevekenyseg_forma],
    ['Előzmény', result.elozmeny],
    ['Téma', result.tema],
    ['Cél', result.cel],
    ['Eszközök', result.eszkozok.join(', ')]
  ];
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
          <div class="doc-section">
            <p class="doc-summary"><strong>Projekt:</strong> ${escapeHtml(summary)}</p>
          </div>
          ${buildMetaBlock(metaRows)}
          <div class="doc-section">
            <h3>Cél- és feladatrendszer</h3>
            ${professionalFields.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')}
          </div>
          ${locked ? buildLockedBoundaryCard(lockResult) : ''}
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>A tevékenység/foglalkozás kidolgozása</h3>
            ${buildActivityTable(result.kidolgozas_tablazat, orientation, locked)}
          </div>
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
  const request = data.request || buildGenerationPayload();
  const list = getDocumentList(data);
  if (!list.some((doc) => doc.id === activeDocId)) activeDocId = list[0].id;
  resultDocument.innerHTML = buildDocumentHtml(data, request, activeDocId);
  renderDocumentTabs(list);
  resultDocument.dataset.orientation = getDocOrientation(data, activeDocId);
  paginateDocument(resultDocument);
  applyPaywall(resultDocument);
  updateExportLock();
}

// A dokumentumot valódi A4 lapokra (.a4-page) tördeli; a hosszú táblázatokat sorok mentén osztja, fejléc-ismétléssel.
// Ennél kisebb szabad hely alatt (a lap magasságának hányada) a táblázat nem kezdődik megosztott lapon.
const MIN_SLICE_SHARE = 0.2;

function paginateDocument(host) {
  const orientation = host.dataset.orientation === 'landscape' ? 'landscape' : 'portrait';
  const marginMm = PAGE_MARGIN_MM;
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

  // Hosszú, táblázat nélküli szakasz (pl. pedagógiai keretrendszer): bekezdések mentén több lapra oszlik, címsor nem marad egyedül.
  const placeFlowBlock = (original) => {
    let block = original;
    const shared = body.children.length > 1;
    const backup = shared ? block.cloneNode(true) : null;
    let tail = splitFlowBlock(block, overflows);
    if (shared && overflows()) {
      block.remove();
      newPage();
      body.appendChild(backup);
      block = backup;
      tail = splitFlowBlock(block, overflows);
    }
    while (tail) {
      newPage();
      body.appendChild(tail);
      tail = overflows() ? splitFlowBlock(tail, overflows) : null;
    }
  };

  blocks.forEach((block) => {
    body.appendChild(block);
    if (!overflows()) return;

    const table = block.querySelector('.official-table');
    const rows = table ? Array.from(table.tBodies[0]?.rows || []) : [];
    // Az oktatási célú táblázatok egyetlen lapnál magasabb sora a cellák bekezdései mentén tovább osztható.
    const splittable = Boolean(table?.classList.contains('academic-table'));
    if (!rows.length || (rows.length < 2 && !splittable)) {
      if (block.classList.contains('academic-flow')) placeFlowBlock(block);
      else if (body.children.length > 1) {
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
    // Megosztott lapon az első adatsor-szelet a fejléc alatt indul; ha ez a legkisebb szelettel sem fér el, a fejléc is új lapra kerül.
    const startOnSharedPage = (row) => {
      const backup = current.cloneNode(true);
      const tail = splitTallRow(row, overflows);
      if (!overflows()) {
        if (tail) {
          openContinuation();
          currentBody.appendChild(tail);
          splitOversizedRow(tail);
        }
        return;
      }
      body.removeChild(current);
      newPage();
      body.appendChild(backup);
      current = backup;
      currentBody = backup.querySelector('.official-table').tBodies[0];
      splitOversizedRow(currentBody.rows[0]);
    };
    rows.forEach((row) => {
      currentBody.appendChild(row);
      if (!overflows()) return;
      if (currentBody.rows.length === 1) {
        const roomAbove = capacity - (body.offsetHeight - current.offsetHeight);
        if (splittable && body.children.length > 1 && roomAbove >= capacity * MIN_SLICE_SHARE) {
          startOnSharedPage(row);
          return;
        }
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
  updateExportLock();
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
