// Heti összesítő dokumentum (fekvő A4-es táblázatos heti terv): hat nevelési terület, cél- és feladatrendszer, megjegyzések.
// Klasszikus script (nem ES modul): a tervezo-academic.js segédfüggvényeit (academicClass, buildAcademicMetaBlock, formatRichText) használja.

const WEEKLY_AREA_COLUMNS = [
  { key: 'kulso_vilag', label: 'Külső világ tevékeny megismerése' },
  { key: 'kulso_vilag_matematika', label: 'Külső világ – matematikai tartalommal' },
  { key: 'verseles_meseles', label: 'Verselés, mesélés' },
  { key: 'enek_zene', label: 'Ének, zene, népi játék, tánc' },
  { key: 'rajzolas', label: 'Rajzolás, festés, mintázás, kézi munka' },
  { key: 'mozgas', label: 'Mozgás' }
];

const WEEKLY_VERSELES_GROUPS = [
  ['versek', 'Új versek:'], ['ismetles', 'Ismétlés:'], ['mesek', 'Mesék:'],
  ['szolasok_kozmondasok', 'Szólások, közmondások:'], ['talalos_kerdesek', 'Találós kérdések:'], ['nyelvtorok', 'Nyelvtörők:']
];

const WEEKLY_ENEK_GROUPS = [
  ['dalok', 'Dalok:'], ['ismetles', 'Ismétlés:'], ['enekes_jatekok', 'Énekes népi játékok:'],
  ['kiszamolo', 'Kiszámoló:'], ['zenei_kepessegfejlesztes', 'Zenei képességfejlesztés:'], ['zenehallgatas', 'Zenehallgatás:']
];

const WEEKLY_NOTE_GROUPS = [
  ['jatekbovites', 'Játékbővítés'], ['anyanyelvi_jatekok', 'Anyanyelvi játékok'],
  ['fejlesztojatek', 'Fejlesztőjáték'], ['kirandulas_setak', 'Kirándulás, séta']
];

const WEEKLY_COLUMN_WIDTHS = [16, 16, 19, 19, 15, 15];

function weeklyItems(list, locked) {
  const cls = academicClass(locked && 'locked-mirror-text');
  const items = Array.isArray(list) ? list.filter((item) => String(item || '').trim()) : [];
  return items.length ? items.map((item) => `<p${cls}>${formatRichText(item)}</p>`).join('') : '<p>–</p>';
}

function weeklyAreaCell(key, value, locked) {
  const groups = key === 'verseles_meseles' ? WEEKLY_VERSELES_GROUPS : (key === 'enek_zene' ? WEEKLY_ENEK_GROUPS : null);
  if (!groups) return weeklyItems(value, locked);
  return groups.map(([groupKey, label]) => `<p class="cell-label"><strong>${escapeHtml(label)}</strong></p>${weeklyItems(value?.[groupKey], locked)}`).join('');
}

function weeklyAreaMatrix(areas, locked) {
  return `
          <table${academicClass('official-table', 'academic-table', 'thematic-table', locked && 'locked-mirror-table')}>
            <colgroup>${WEEKLY_COLUMN_WIDTHS.map((width) => `<col style="width: ${width}%;" />`).join('')}</colgroup>
            <thead><tr>${WEEKLY_AREA_COLUMNS.map((area) => `<th>${escapeHtml(area.label)}</th>`).join('')}</tr></thead>
            <tbody><tr>${WEEKLY_AREA_COLUMNS.map((area) => `<td>${weeklyAreaCell(area.key, areas?.[area.key], locked)}</td>`).join('')}</tr></tbody>
          </table>`;
}

function weeklySimpleTable(columns, locked) {
  const width = Math.floor(10000 / columns.length) / 100;
  return `
          <table${academicClass('official-table', 'academic-table', 'thematic-table', locked && 'locked-mirror-table')}>
            <colgroup>${columns.map(() => `<col style="width: ${width}%;" />`).join('')}</colgroup>
            <thead><tr>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
            <tbody><tr>${columns.map(([, list]) => `<td>${weeklyItems(list, locked)}</td>`).join('')}</tr></tbody>
          </table>`;
}

// A napokhoz rendelt területek (weeklyFocusAreas) szöveges összefoglalója: „Hétfő: A, B; Kedd: C”.
function weeklyFocusAssignmentText(request) {
  const map = request?.weeklyFocusAreas;
  if (!map || typeof map !== 'object') return '';
  return Object.entries(map)
    .map(([day, areas]) => [day, (Array.isArray(areas) ? areas : [areas]).filter(Boolean)])
    .filter(([, areas]) => areas.length)
    .map(([day, areas]) => `${day}: ${areas.join(', ')}`)
    .join('; ');
}

function buildWeeklySummaryHtml(result, request, { locked }) {
  const summary = result.heti_osszesito || {};
  const frame = summary.keretrendszer || {};
  const notes = summary.megjegyzes_egyeb_tevekenysegek || {};
  const specialNeeds = Array.isArray(request.specialNeeds) ? request.specialNeeds.filter(Boolean) : [];
  const ageGroup = [request.group, specialNeeds.length ? `SNI/differenciálás: ${specialNeeds.join(', ')}` : ''].filter(Boolean).join(' • ');
  const assignment = weeklyFocusAssignmentText(request);
  const metaRows = [
    ['Óvodapedagógus', escapeHtml(request.teacherName || '—')],
    ['Óvoda', escapeHtml(request.kindergartenName || '—')],
    ['Csoport', escapeHtml(request.groupName || '—')],
    ['Korcsoport / SNI fókusz', escapeHtml(ageGroup || '—')],
    ['Időszak', escapeHtml(summary.datum || request.dateValue || '—')],
    ['Főtéma', `<strong>${escapeHtml(summary.tema || '')}</strong>`],
    ['Heti altéma', escapeHtml(summary.altema || '—')]
  ];
  if (assignment) metaRows.push(['Napokhoz rendelt területek', escapeHtml(assignment)]);

  const noteColumns = WEEKLY_NOTE_GROUPS.map(([key, label]) => [label, notes[key]]);
  const lit = result.showLiteratureAtBottom ? academicLiteratureHtml(summary.felhasznalt_irodalom, locked) : '';
  const plan = Array.isArray(summary.napi_beosztas) ? summary.napi_beosztas : [];
  const planTable = plan.length ? `
          <div class="doc-section doc-table-section">
            <h3>Napi beosztás</h3>
            <table${academicClass('official-table', 'academic-table', 'thematic-table', locked && 'locked-mirror-table')}>
              <colgroup><col style="width: 12%;" /><col style="width: 24%;" /><col style="width: 34%;" /><col style="width: 30%;" /></colgroup>
              <thead><tr><th>Nap</th><th>Fő terület</th><th>Napi fókusz</th><th>Napi cél</th></tr></thead>
              <tbody>${plan.map((row) => `<tr><td>${escapeHtml(row.nap)}</td><td><p${academicClass(locked && 'locked-mirror-text')}>${formatRichText(row.fo_terulet)}</p></td><td><p${academicClass(locked && 'locked-mirror-text')}>${formatRichText(row.napi_fokusz)}</p></td><td><p${academicClass(locked && 'locked-mirror-text')}>${formatRichText(row.napi_cel)}</p></td></tr>`).join('')}</tbody>
            </table>
          </div>` : '';

  return `
          <div class="doc-header">
            <h2>Heti összesítő</h2>
          </div>
          ${buildAcademicMetaBlock(metaRows)}
          ${locked ? buildLockedBoundaryCard(result) : ''}
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>Nevelési területek heti bontásban</h3>
            ${weeklyAreaMatrix(summary.teruletek, locked)}
          </div>
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>Cél- és feladatrendszer</h3>
            ${weeklySimpleTable([['Célok', frame.celok], ['Feladatok', frame.feladatok]], locked)}
          </div>
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>Kiemelt fejlesztési területek, módszerek és eszközök</h3>
            ${weeklySimpleTable([['Kiemelt fejlesztési területek', frame.kiemelt_fejlesztesi_teruletek], ['Módszerek', frame.modszerek], ['Eszközök', frame.eszkozok]], locked)}
          </div>
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>Megjegyzés, egyéb tevékenységek</h3>
            ${weeklySimpleTable(noteColumns, locked)}
          </div>
          ${planTable}
          ${lit}`;
}
