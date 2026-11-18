// Oktatási célú tervezet dokumentumai: Foglalkozási/tevékenységi terv (napi) és Tematikus terv (heti, 7 oszlopos mátrix).
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

// A feliratok a szerver (services/academicPlan.js) mezőinek tükrei; a tesztek egyezésüket ellenőrzik.
const ACADEMIC_AREAS = [
  { key: 'kulso_vilag', label: 'A külső világ tevékeny megismerése' },
  { key: 'matematika', label: 'Matematikai tartalmú tapasztalatok' },
  { key: 'verseles_meseles', label: 'Verselés, mesélés' },
  { key: 'enek_zene', label: 'Ének, zene, énekes játék, gyermektánc' },
  { key: 'rajzolas', label: 'Rajzolás, festés, mintázás, kézimunka' },
  { key: 'mozgas', label: 'Mozgás / Testnevelés' }
];

const ACADEMIC_VERSELES_GROUPS = [
  ['versek', 'Versek:'], ['ismetles', 'Ismétlés:'], ['mesek', 'Mesék:'],
  ['szolasok_kozmondasok', 'Szólások, közmondások:'], ['talalos_kerdesek', 'Találós kérdések:'], ['nyelvtorok', 'Nyelvtörők:']
];

const ACADEMIC_ENEK_GROUPS = [['enekes_jatek', 'Énekes játék:'], ['kiszamolo', 'Kiszámoló:'], ['zenehallgatas', 'Zenehallgatás:']];

const ACADEMIC_NOTE_GROUPS = [
  ['jatekbovites', 'Játékbővítés'], ['anyanyelvi_jatekok', 'Anyanyelvi játékok'],
  ['fejlesztojatek', 'Fejlesztőjáték'], ['kirandulas_setak', 'Kirándulás, séta']
];

// A heti mátrix oszlopszélességei (fekvő A4): Tevékenységi területek | 6 ONAP-terület
const THEMATIC_COLUMN_WIDTHS = [12, 14, 13, 19, 17, 12.5, 12.5];

function isAcademicResult(result) {
  return result?.is_thematic === true || result?.planMode === 'academic' || result?.request?.planMode === 'academic';
}

function formatAcademicDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}. ${match[2]}. ${match[3]}.` : '';
}

function academicClass(...names) {
  const joined = names.filter(Boolean).join(' ');
  return joined ? ` class="${joined}"` : '';
}

function academicMetaRow(label, valueHtml) {
  return `
                <div class="meta-row">
                  <span class="meta-label">${escapeHtml(label)}</span>
                  <div class="meta-value">${valueHtml}</div>
                </div>`;
}

function buildAcademicMetaBlock(rows) {
  return `
          <div class="doc-section doc-meta-block">
            <div class="official-meta academic-meta">${rows.map(([label, html]) => academicMetaRow(label, html)).join('')}
            </div>
          </div>`;
}

const richParagraph = (value) => `<p>${formatRichText(value)}</p>`;

function academicLiteratureHtml(text, locked) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  return `
          <div class="doc-section academic-flow academic-literature">
            <h3>Felhasznált irodalom:</h3>
            ${lines.map((line) => `<p${academicClass('lit-item', locked && 'locked-mirror-text')}>${formatRichText(line)}</p>`).join('')}
          </div>`;
}

function academicProcessTable(rows, locked) {
  const widths = [9, 51, 40];
  const cell = (value) => `<div${academicClass(locked && 'locked-mirror-text')}>${formatRichCell(value)}</div>`;
  return `
          <table${academicClass('official-table', 'academic-table', 'academic-process-table', locked && 'locked-mirror-table')}>
            <colgroup>${widths.map((width) => `<col style="width: ${width}%;" />`).join('')}</colgroup>
            <thead>
              <tr>
                <th>Idő</th>
                <th>A fejlesztő tevékenység felépítése, a foglalkozás menete</th>
                <th>A fejlesztés módszerei, munkaformák, eszközök, megjegyzések</th>
              </tr>
            </thead>
            <tbody>
              ${(Array.isArray(rows) ? rows : []).map((row) => `
                <tr>
                  <td>${cell(row.ido)}</td>
                  <td>${cell(row.tevekenyseg_menete)}</td>
                  <td>${cell(row.modszerek_megjegyzesek)}</td>
                </tr>`).join('')}
            </tbody>
          </table>`;
}

function buildAcademicDailyHtml(result, request, { locked }) {
  const content = result.tartalom || {};
  const rows = Array.isArray(result.kidolgozas_tablazat) ? result.kidolgozas_tablazat : [];
  const minutes = Number.isFinite(result.ossz_ido_perc)
    ? result.ossz_ido_perc
    : rows.reduce((total, row) => total + (parseInt(row.ido, 10) || 0), 0);
  const dateText = formatAcademicDate(request.dateValue);
  const minutesText = minutes ? `${minutes} perc` : '';
  const timeText = dateText ? `${dateText}${minutesText ? ` (${minutesText})` : ''}` : (minutesText || '—');
  const contentParts = [
    ['Új anyag', content.uj_anyag], ['Ismétlés', content.ismetles],
    ['Készségfejlesztés', content.keszsegfejlesztes], ['Zenehallgatás', content.zenehallgatas]
  ].filter(([, value]) => String(value || '').trim());

  const metaRows = [
    ['Az óvodapedagógus neve', escapeHtml(request.studentName || request.teacherName || '—')],
    ['Csoport', escapeHtml(request.groupName || request.group || '—')],
    ['Tevékenységi forma', formatRichText(result.tevekenyseg_forma)],
    ['A tevékenység/foglalkozás időpontja', escapeHtml(timeText)],
    ['A tevékenység előzménye', formatRichText(result.elozmeny || '—')],
    ['A tevékenység tartalma/témája', `<p><strong>${escapeHtml(result.tema)}</strong></p>${contentParts.map(([label, value]) => `<p><strong>${label}:</strong> ${formatRichText(value)}</p>`).join('')}`]
  ];
  metaRows.push(
    ['A tevékenység célja', formatRichText(result.cel)],
    ['A tevékenység feladatai', [
      ['Nevelési feladatok', result.nevelesi_feladatok],
      ['Didaktikai feladatok', result.didaktikai_feladatok],
      ['Képesség- és készségfejlesztés', result.kepessegfejlesztes]
    ].map(([label, value]) => `<p><strong>${label}:</strong> ${formatRichText(value)}</p>`).join('')],
    ['Alkalmazott módszerek, eljárások', escapeHtml((result.modszerek || []).join(', '))],
    ['Eszközök', escapeHtml((result.eszkozok || []).join(', '))]
  );

  return `
          <div class="doc-header">
            <h2>Foglalkozási/tevékenységi terv</h2>
          </div>
          ${buildAcademicMetaBlock(metaRows)}
          ${locked ? buildLockedBoundaryCard(result) : ''}
          <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
            <h3>A tevékenység/foglalkozás kidolgozása</h3>
            ${academicProcessTable(rows, locked)}
          </div>
          ${academicLiteratureHtml(result.felhasznalt_irodalom, locked)}`;
}

function thematicCellHtml(key, value, locked) {
  const item = (text) => `<p${academicClass(locked && 'locked-mirror-text')}>${formatRichText(text)}</p>`;
  const groups = key === 'verseles_meseles' ? ACADEMIC_VERSELES_GROUPS : (key === 'enek_zene' ? ACADEMIC_ENEK_GROUPS : null);
  if (!groups) return (Array.isArray(value) ? value : []).map(item).join('');
  return groups.map(([groupKey, label]) => {
    const items = Array.isArray(value?.[groupKey]) ? value[groupKey] : [];
    return `<p class="cell-label"><strong>${escapeHtml(label)}</strong></p>${items.length ? items.map(item).join('') : '<p>–</p>'}`;
  }).join('');
}

function thematicMatrixTable(week, locked) {
  const areas = week.teruletek || {};
  return `
          <table${academicClass('official-table', 'academic-table', 'thematic-table', locked && 'locked-mirror-table')}>
            <colgroup>${THEMATIC_COLUMN_WIDTHS.map((width) => `<col style="width: ${width}%;" />`).join('')}</colgroup>
            <thead>
              <tr>
                <th>Tevékenységi területek</th>
                ${ACADEMIC_AREAS.map((area) => `<th>${escapeHtml(area.label)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <p><strong>Főtéma:</strong> ${escapeHtml(week.foteme)}</p>
                  <p><strong>${escapeHtml(week.het_szama)}. hét</strong></p>
                  ${week.datum ? `<p>${escapeHtml(week.datum)}</p>` : ''}
                  <p><strong>Altéma:</strong> ${escapeHtml(week.altema)}</p>
                </td>
                ${ACADEMIC_AREAS.map((area) => `<td>${thematicCellHtml(area.key, areas[area.key], locked)}</td>`).join('')}
              </tr>
            </tbody>
          </table>`;
}

function thematicFrameHtml(week, locked) {
  const frame = week.keretrendszer || {};
  const item = (text) => `<p${academicClass(locked && 'locked-mirror-text')}>• ${formatRichText(text)}</p>`;
  const list = (label, values) => `<p class="frame-label"><strong>${label}</strong></p>${(Array.isArray(values) ? values : []).map(item).join('')}`;
  const inline = (label, values) => `<p${academicClass(locked && 'locked-mirror-text')}><strong>${label}</strong> ${(Array.isArray(values) ? values : []).map((value) => formatRichText(value)).join('; ')}</p>`;
  const focus = frame.kiemelt_fejlesztesi_terulet || {};
  return `
          <div class="doc-section academic-flow academic-frame">
            <h3>Cél, - feladatrendszer:</h3>
            ${list('Célok:', frame.celok)}
            ${list('Feladatok:', frame.feladatok)}
            <h3>Kiemelt fejlesztési terület:</h3>
            ${ACADEMIC_AREAS.map((area) => `<p${academicClass(locked && 'locked-mirror-text')}><strong>${escapeHtml(area.label)}:</strong> ${formatRichText(focus[area.key] || '—')}</p>`).join('')}
            <h3>Módszerek, eszközök:</h3>
            ${inline('Módszerek:', frame.modszerek)}
            ${inline('Eszközök:', frame.eszkozok)}
          </div>`;
}

function thematicNotesHtml(notes, locked) {
  if (!notes || typeof notes !== 'object') return '';
  const groups = ACADEMIC_NOTE_GROUPS.filter(([key]) => Array.isArray(notes[key]) && notes[key].length);
  if (!groups.length) return '';
  return `
          <div class="doc-section academic-flow academic-frame">
            <h3>Megjegyzés, egyéb tevékenységek:</h3>
            ${groups.map(([key, label]) => `<p${academicClass(locked && 'locked-mirror-text')}><strong>${label}:</strong> ${notes[key].map((value) => formatRichText(value)).join('; ')}</p>`).join('')}
          </div>`;
}

function buildThematicHtml(result, request, { locked }) {
  const weeks = Array.isArray(result.hetek) ? result.hetek : [];
  const metaRows = [
    ['Az óvodapedagógus neve', escapeHtml(request.studentName || request.teacherName || '—')],
    ['Csoport', escapeHtml(request.groupName || request.group || '—')],
    ['Időszak', escapeHtml(weeks[0]?.datum || request.dateValue || '—')],
    ['Fő téma', escapeHtml(result.tema || '—')]
  ];
  return `
          <div class="doc-header">
            <h2>Tematikus terv</h2>
          </div>
          ${buildAcademicMetaBlock(metaRows)}
          ${locked ? buildLockedBoundaryCard(result) : ''}
          ${weeks.map((week) => `
            <div class="doc-section doc-table-section ${locked ? 'locked-mirror-section' : ''}">
              <h3>${escapeHtml(week.het_szama)}. hét${week.datum ? ` – ${escapeHtml(week.datum)}` : ''}</h3>
              ${thematicMatrixTable(week, locked)}
            </div>
            ${thematicFrameHtml(week, locked)}`).join('')}
          ${thematicNotesHtml(result.megjegyzes_egyeb_tevekenysegek, locked)}
          ${academicLiteratureHtml(result.felhasznalt_irodalom, locked)}`;
}

// A lapnál hosszabb, táblázat nélküli szakasz végi bekezdéseit egy folytatás-blokkba teszi (a címsor nem maradhat a rész végén).
function splitFlowBlock(block, overflows) {
  const tail = block.cloneNode(false);
  const minKeep = block.firstElementChild?.tagName === 'H3' ? 2 : 1;
  let moved = false;
  while (overflows() && block.children.length > minKeep) {
    tail.insertBefore(block.lastElementChild, tail.firstChild);
    moved = true;
  }
  while (moved && block.children.length > 1 && block.lastElementChild.tagName === 'H3') {
    tail.insertBefore(block.lastElementChild, tail.firstChild);
  }
  return moved ? tail : null;
}

function countThematicItems(value) {
  if (typeof value === 'string') return value.trim() ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countThematicItems(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((total, item) => total + countThematicItems(item), 0);
  return 0;
}

// A zárolt kártya terjedelem-jelzője; a nem tematikus tervekre a korábbi (1 táblázat, a sorok száma) érték marad.
function getLockedMeta(result) {
  if (result?.is_thematic === true && Array.isArray(result.hetek)) {
    return { table_count: result.hetek.length, activity_count: result.hetek.reduce((total, week) => total + countThematicItems(week?.teruletek), 0) };
  }
  return { table_count: 1, activity_count: (result?.kidolgozas_tablazat || []).length };
}

// Egyetlen, a lapnál magasabb táblázatsort a cellák blokkjai (bekezdései) mentén kettéoszt: az első rész a sorban marad,
// a maradék az új (visszaadott) sorba kerül. A cellák egymástól függetlenül, a legmagasabb tartalmú oszlop vége felől ürülnek.
function splitTallRow(row, overflows) {
  const cells = Array.from(row.cells);
  const containers = cells.map((cell) => cell.querySelector(':scope > div') || cell);
  const tail = row.cloneNode(false);
  const tailContainers = cells.map((cell, index) => {
    const copy = cell.cloneNode(false);
    tail.appendChild(copy);
    if (containers[index] === cell) return copy;
    const inner = containers[index].cloneNode(false);
    copy.appendChild(inner);
    return inner;
  });
  const bottomOf = (container) => {
    const last = container.lastElementChild;
    return last ? last.offsetTop + last.offsetHeight : 0;
  };
  const move = (index) => {
    tailContainers[index].insertBefore(containers[index].lastElementChild, tailContainers[index].firstChild);
  };
  let moved = false;
  while (overflows()) {
    let target = -1;
    let tallest = -1;
    containers.forEach((container, index) => {
      if (container.children.length > 1 && bottomOf(container) > tallest) { tallest = bottomOf(container); target = index; }
    });
    if (target < 0) break;
    move(target);
    // A címke nem maradhat egyedül a lap alján.
    const last = containers[target].lastElementChild;
    if (last && last.classList.contains('cell-label') && containers[target].children.length > 1) move(target);
    moved = true;
  }
  return moved ? tail : null;
}
