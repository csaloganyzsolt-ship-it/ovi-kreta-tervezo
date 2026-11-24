const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { makePayload, makePlan, readPage } = require('./fixtures');

const html = readPage('tervezo.html');

async function loadApp(t) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      // jsdom provides the real DOM but does not implement scrolling or dialogs.
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
      // A nyilvános beállításokat (GET /api/config) a teszt adja; más kérés itt nincs.
      window.fetch = async (url) => {
        if (!String(url).endsWith('/api/config')) throw new Error(`váratlan kérés: ${url}`);
        return { ok: true, status: 200, json: async () => ({ success: true, pricing: { standard: 390, academic: 690, weekly: 890 }, maintenance_mode: false, seasonal_hints: ['őszi falevelek gyűjtése', 'farsangi mulatság'] }) };
      };
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
  return dom.window;
}

test('initialization leaves the document empty until a real successful response exists', async (t) => {
  const window = await loadApp(t);
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
  assert.equal(window.document.querySelector('.official-table'), null);
});

test('all rows and methods render, with escaped activity paragraphs instead of fallback content', async (t) => {
  const window = await loadApp(t);
  const plan = makePlan(8);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete[0] = '<img src=x onerror=alert(1)>\nSzóbeli instrukció.';
  window.renderResultDocument({ ...plan, request: makePayload() });
  const document = window.document;
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 8);
  const firstRow = document.querySelector('.official-table tbody tr');
  assert.equal(firstRow.cells[1].querySelectorAll('p').length, 2);
  assert.equal(firstRow.cells[1].querySelectorAll('img').length, 0);
  assert.ok(firstRow.cells[1].textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(firstRow.cells[2].textContent.trim(), plan.kidolgozas_tablazat[0].modszerek_megjegyzesek);
  assert.ok(document.querySelector('#resultDocument').textContent.includes(plan.nevelesi_feladatok));
  assert.ok(document.querySelector('#resultDocument').textContent.includes(plan.didaktikai_feladatok));
  assert.ok(document.querySelector('#resultDocument').textContent.includes(plan.kepessegfejlesztes));
  assert.ok(document.querySelector('#resultDocument').textContent.includes('Nevelési terület'));
});

test('all form settings, including group characteristics and focus areas, enter the request', async (t) => {
  const window = await loadApp(t);
  const document = window.document;
  const setField = (name, value) => {
    const field = document.querySelector(`[data-field="${name}"]`);
    assert.ok(field, `Missing bound form control: ${name}`);
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  };
  setField('child-count', 23);
  document.querySelector('.segment[data-group="energy"][data-value="Nyugodt, kiegyensúlyozott"]').click();
  setField('has-preschoolers', false);
  setField('group-note', 'Vizuális jelzés szükséges.');
  setField('required-text', 'Saját levélmondóka.');
  setField('available-tools', 'Nagyító.');
  setField('custom-request', 'Páros levélválogatás.');
  document.querySelector('.segment[data-group="detail"][data-value="concise"]').click();
  const focus = document.querySelector('[data-focus-area]');
  assert.ok(focus);
  focus.checked = true;
  const sni = document.querySelector('[data-sni-label]');
  sni.checked = true;
  const payload = window.buildGenerationPayload();
  assert.equal(payload.childCount, 23);
  assert.equal(payload.energyLevel, 'Nyugodt, kiegyensúlyozott');
  assert.equal(payload.hasPreschoolers, false);
  assert.equal(payload.focusAreas[0], focus.dataset.focusArea);
  assert.equal(payload.specialNeeds[0], sni.dataset.sniLabel);
  assert.equal(payload.customNotes.requiredText, 'Saját levélmondóka.');
  assert.equal(payload.customNotes.customRequest, 'Páros levélválogatás.');
  assert.equal(payload.detailLevel, 30);
  assert.equal('outputMode' in payload, false, 'a kivezetett outputMode nem megy a kérésben');
  assert.equal(payload.availableTools, 'Nagyító.');
  window.setDurationSelection('Heti');
  assert.equal(window.buildGenerationPayload().planKind, 'weekly');
  assert.equal(window.buildGenerationPayload().planMode, 'standard');
});

test('successful generation renders the real response and never silently replaces methods', async (t) => {
  const window = await loadApp(t);
  const plan = makePlan();
  window.fetch = async () => Response.json({ success: true, ...plan });
  await window.generatePlan();
  assert.equal(window.document.querySelector('#previewContent').style.display, 'block');
  assert.equal(window.document.querySelectorAll('.official-table tbody tr').length, 5);
  assert.equal(window.document.querySelector('.official-table tbody tr').cells[2].textContent.trim(),
    plan.kidolgozas_tablazat[0].modszerek_megjegyzesek);
});

test('a failed retry clears the previous result and shows the actual backend details', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  window.fetch = async () => Response.json({
    success: false,
    error: 'A generálás sikertelen.',
    details: 'Gemini MAX_TOKENS: a válasz nem teljes.'
  }, { status: 502 });
  window.document.querySelector('[data-field="theme"]').value = 'Másik téma';
  await window.generatePlan();
  assert.match(window.document.querySelector('#generationErrorBanner').textContent, /MAX_TOKENS/);
  assert.equal(window.document.querySelector('#previewContent').style.display, 'none');
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
  assert.equal(window.document.querySelector('#nextBtn').disabled, false);
});

test('invalid JSON or incomplete successful responses never become fake plans', async (t) => {
  for (const response of [new Response('not JSON'), Response.json({ success: true })]) {
    const window = await loadApp(t);
    window.fetch = async () => response;
    await window.generatePlan();
    assert.equal(window.document.querySelector('#generationErrorBanner').hidden, false);
    assert.equal(window.document.querySelector('#previewContent').style.display, 'none');
    assert.equal(window.document.querySelector('.official-table'), null);
  }
});

test('literature is only displayed when selected and never replaced with an invented citation', async (t) => {
  const window = await loadApp(t);
  window.renderResultDocument({ ...makePlan(), showLiteratureAtBottom: false, request: makePayload() });
  assert.equal(window.document.querySelector('#resultDocument').textContent.includes('Felhasznált irodalom'), false);
  window.document.querySelector('[data-field="show-literature"]').checked = true;
  window.renderResultDocument({ ...makePlan(), felhasznalt_irodalom: '', request: makePayload() });
  assert.equal(window.document.querySelector('#resultDocument').textContent.includes('Kovács Margit'), false);
});

test('explicitly empty history and literature can render without fallback prose', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => Response.json({ success: true, ...makePlan(), elozmeny: '', felhasznalt_irodalom: '' });
  await window.generatePlan();
  assert.equal(window.document.querySelector('#generationErrorBanner').hidden, true);
  assert.equal(window.document.querySelectorAll('.official-table tbody tr').length, 5);
  assert.equal(window.document.querySelector('#resultDocument').textContent.includes('ébredő természet'), false);
});

test('all administrative fields, custom notes, selected needs, dates, and weekly settings are transmitted', async (t) => {
  const window = await loadApp(t);
  const document = window.document;
  const values = {
    'kindergarten-name': 'Próba Óvoda', 'kindergarten-profile': 'Zöld Óvoda', 'teacher-name': 'Próba Pedagógus',
    'group-name': 'Próba Csoport', group: 'Vegyes csoport', theme: 'Tavaszi megfigyelés',
    'tevekenyseg-forma': 'Mikrocsoportos / egyéni fejlesztés', elozmeny: 'Korábbi udvari játék.',
    'custom-note': 'Egyéni kiegészítés.', 'group-note': 'Csoportkérés.',
    'required-text': 'Saját mondóka.', 'custom-request': 'Csendes lezárás.'
  };
  for (const [field, value] of Object.entries(values)) document.querySelector(`[data-field="${field}"]`).value = value;
  document.querySelectorAll('[data-focus-area], [data-sni-label]').forEach((checkbox) => { checkbox.checked = true; });
  document.querySelector('[data-field="date-value"]').value = '2026-11-03';
  document.querySelector('[data-field="show-literature"]').checked = true;
  document.querySelector('#iktEnabled').checked = true;
  document.querySelector('#iktToolsPicker [data-ikt-tool]').click();
  document.querySelector('#iktCustomApp').value = 'Saját fejlesztő játék';
  assert.equal(document.querySelector('.mode-pill'), null);
  const daily = window.buildGenerationPayload();
  assert.equal(daily.dateValue, '2026-11-03');
  assert.equal(daily.tevekenysegForma, values['tevekenyseg-forma']);
  assert.equal(daily.elozmeny, values.elozmeny);
  assert.equal(daily.kindergartenName, values['kindergarten-name']);
  assert.equal(daily.kindergartenProfile, values['kindergarten-profile']);
  assert.equal(daily.teacherName, values['teacher-name']);
  assert.equal(daily.groupName, values['group-name']);
  assert.equal(daily.group, values.group);
  assert.equal(daily.theme, values.theme);
  assert.equal(daily.focusAreas.length, 6);
  assert.equal(daily.specialNeeds.length, 4);
  assert.equal(daily.customNotes.primary, values['custom-note']);
  assert.equal(daily.customNotes.groupNote, values['group-note']);
  assert.equal(daily.showLiteratureAtBottom, true);
  assert.equal(daily.iktEnabled, true);
  assert.ok(daily.iktTools.length >= 1);
  assert.equal(daily.iktCustomApp, 'Saját fejlesztő játék');
  assert.equal('outputMode' in daily, false);
  window.setDurationSelection('Heti');
  document.querySelector('[data-field="week-value"]').value = '2026-W45';
  const weekly = window.buildGenerationPayload();
  assert.equal(weekly.dateValue, '2026-W45');
  assert.equal(weekly.planKind, 'weekly');
  assert.equal(weekly.planMode, 'standard');
  assert.equal(weekly.includeDailyBreakdown, true);
  assert.deepEqual([...weekly.selectedDays], ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek']);
  assert.equal(document.querySelector('#includeDailyBreakdown'), null);
  assert.equal(document.querySelector('#weeklySettingsPanel').hidden, false);
  assert.equal(weekly.weeklyProgressionType, 'progressive');
  assert.equal(weekly.fridayClosingType, 'Kiállítás a csoportszobában');
  window.setDurationSelection('Napi');
  assert.equal(window.buildGenerationPayload().includeDailyBreakdown, false);
  assert.equal(document.querySelector('#weeklySettingsPanel').hidden, true);
});

test('theme suggestions are not mistakenly sent as selected pedagogical goals', async (t) => {
  const window = await loadApp(t);
  const suggestion = window.document.querySelector('[data-theme-option]');
  suggestion.click();
  const payload = window.buildGenerationPayload();
  assert.equal(payload.theme, suggestion.dataset.themeOption);
  assert.equal(payload.selectedGoals.includes(payload.theme), false);
});

test('the preview has no margin or section controls and always shows the full fixed A4 document', async (t) => {
  const window = await loadApp(t);
  const document = window.document;
  for (const selector of ['[data-export-section]', '[data-export="margin"]', '[data-export="orientation"]', '.export-settings-panel', '#pageMarginSelect', '#activitiesLockNote']) {
    assert.equal(document.querySelector(selector), null, selector);
  }
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  const host = document.querySelector('#resultDocument');
  assert.ok(host.querySelector('.doc-summary'));
  assert.ok(host.textContent.includes(makePlan().nevelesi_feladatok));
  assert.ok(host.textContent.includes('nagyító'));
  assert.equal(document.querySelectorAll('.official-table thead th').length, 3);
  assert.equal(document.querySelectorAll('.official-table col').length, 3);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 5);
  assert.equal(host.dataset.margin, undefined);
  assert.equal(host.dataset.orientation, 'portrait');
  assert.equal(window.eval('PAGE_MARGIN_MM'), 15);
  assert.equal(window.getDocOrientation(), 'portrait');
  const pages = host.querySelectorAll('.a4-page');
  assert.ok(pages.length >= 1);
});

test('editing the form cannot relabel a previously generated document as a different plan', async (t) => {
  const window = await loadApp(t);
  const document = window.document;
  document.querySelector('[data-field="teacher-name"]').value = 'Eredeti Pedagógus';
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  const before = document.querySelector('#resultDocument').textContent;
  document.querySelector('[data-field="theme"]').value = 'Másik téma';
  document.querySelector('[data-field="teacher-name"]').value = 'Másik Pedagógus';
  window.updateSummary();
  window.renderResultDocument();
  assert.equal(document.querySelector('#resultDocument').textContent, before);
});

test('a clean draft clears the document and restores the form defaults', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  window.clearDraftState();
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
  assert.equal(window.document.querySelector('#previewContent').style.display, 'none');
  assert.equal(window.document.querySelector('.segment.active[data-group="energy"]').dataset.value, 'Átlagos');
  assert.equal(window.document.querySelector('.segment.active[data-group="detail"]').dataset.value, 'detailed');
});

test('network errors show a real error without document content', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => { throw new TypeError('Network unavailable'); };
  await window.generatePlan();
  assert.match(window.document.querySelector('#generationErrorBanner').textContent, /Network unavailable/);
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
});
function weeklyResult(window) {
  const days = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];
  const row = { ido: '10 perc', tevekenyseg_menete: ['Egy', 'Kettő'], modszerek_megjegyzesek: 'Megfigyelés' };
  return {
    is_weekly: true,
    summary: 'Heti projekt',
    heti_keretterv: {
      tema: 'Erdő', heti_fo_cel: 'Cél', nevelesi_feladatok: 'N', didaktikai_feladatok: 'D',
      teruletek_heti_eloszlasa: [
        { nap: 'Hétfő', fo_terulet: 'Verselés, mesélés', csoportos_tevekenyseg: 'Mese' },
        { nap: 'Kedd', fo_terulet: 'Mozgás', csoportos_tevekenyseg: 'Torna' },
        { nap: 'Szerda', fo_terulet: 'Ének, zene, népi játék, tánc', csoportos_tevekenyseg: 'Ének' },
        { nap: 'Csütörtök', fo_terulet: 'A külső világ tevékeny megismerése – matematikai tartalommal', csoportos_tevekenyseg: 'Számlálás' },
        { nap: 'Péntek', fo_terulet: 'Rajzolás, festés, mintázás, kézi munka', csoportos_tevekenyseg: 'Festés' }
      ],
      eszkozok: ['levél'], felhasznalt_irodalom: ''
    },
    napok: days.map((nap_neve) => ({ nap_neve, tevekenyseg_forma: 'Mese és vers', napi_cel: 'C', kidolgozas_tablazat: [row] })),
    request: makePayload({
      duration: 'Heti',
      planMode: 'weekly',
      dateValue: '2026-W35',
      weeklyFocusAreas: {
        'Hétfő': ['Verselés, mesélés'],
        'Kedd': ['Mozgás'],
        'Szerda': ['Ének, zene, népi játék, tánc'],
        'Csütörtök': ['A külső világ tevékeny megismerése – matematikai tartalommal'],
        'Péntek': ['Rajzolás, festés, mintázás, kézi munka']
      }
    })
  };
}

test('weekly plan renders as six tabbed documents with one fixed portrait layout', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  window.renderResultDocument(weeklyResult(window));
  const tabs = [...doc.querySelectorAll('#documentTabs .doc-tab')];
  assert.equal(tabs.map((tab) => tab.textContent).join('|'), 'Heti Keretterv|Hétfő|Kedd|Szerda|Csütörtök|Péntek');
  assert.equal(doc.querySelector('#documentTabs').hidden, false);
  assert.equal(doc.querySelector('#downloadZipBtn').hidden, false);
  assert.equal(doc.querySelectorAll('#resultDocument .official-table').length, 1);
  assert.match(doc.querySelector('#resultDocument').textContent, /Területek heti elosztása/);
  assert.match(doc.querySelector('#resultDocument').textContent, /Csoportos tevékenység \/ Tevékenység/);

  tabs[1].click();
  assert.match(doc.querySelector('#resultDocument').textContent, /Napi tervezet – Hétfő/);
  assert.match(doc.querySelector('#resultDocument').textContent, /Nevelési terület/);
  assert.equal(doc.querySelectorAll('.document-day-sheet .official-table tbody tr').length, 1);

  assert.equal(doc.querySelector('#resultDocument').dataset.orientation, 'portrait');
  doc.querySelectorAll('#documentTabs .doc-tab')[2].click();
  assert.equal(doc.querySelector('#resultDocument').dataset.orientation, 'portrait');
  assert.match(doc.querySelector('#resultDocument').textContent, /Napi tervezet – Kedd/);

  const files = window.getDocumentList(weeklyResult(window)).map((item) => item.fileBase);
  assert.equal(files.slice(0, 3).join('|'), '00_heti-keretterv_2026-08-24|01_hetfo-verseles-meseles_2026-08-24|02_kedd-mozgas_2026-08-25');
});

test('the summary checklist lists every setting, including the new ones', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  doc.querySelector('[data-field="blacklist"]').value = 'gyurma';
  doc.querySelector('[data-field="available-tools"]').value = 'xilofon';
  window.updateSummary();
  const text = doc.querySelector('#summaryChecklist').textContent;
  for (const label of ['Óvoda:', 'Óvoda arculata:', 'Óvodapedagógus:', 'Csoport neve:', 'Korcsoport:', 'Időtartam:', 'Dátum:', 'Téma:',
    'Tevékenységi forma:', 'Előzmény:', 'Gyereklétszám:', 'Csoport hangulata', 'Iskola-előkészítő', 'Speciális nevelési igények',
    'Csoportmegjegyzés:', 'Rendelkezésre álló eszközök és saját ötletek: xilofon', 'Kötelező mese/vers/dal:', 'Kiválasztott célkifejezések:',
    'Külön kérés:', 'Tiltólista: gyurma', 'Irodalomjegyzék', 'IKT / Digitális eszközök: Nem', 'Heti építkezés típusa:', 'Pénteki zárás formája:',
    'Kidolgozottság:']) {
    assert.ok(text.includes(label), `Missing summary line: ${label}`);
  }
  assert.equal(text.includes('Modell:'), false);
  assert.equal(text.includes('Kimeneti forma:'), false);
  assert.equal(text.includes('Generálási beállítások'), false);
  assert.equal(doc.querySelector('#premiumQuality'), null);
  assert.equal(window.getRequestedModel(), 'gemini-3.1-pro-preview');
});

test('new fields reach the payload, survive a draft round trip and are cleared by the clean slate button', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  const set = (selector, value) => { const el = doc.querySelector(selector); el.value = value; };
  set('[data-field="available-tools"]', 'xilofon');
  set('[data-field="blacklist"]', 'gyurma');
  set('[data-field="kindergarten-profile"]', 'Zöld Óvoda');
  doc.querySelector('#iktEnabled').checked = true;
  doc.querySelector('#iktCustomApp').value = 'Bee-Bot szőnyeg';
  let payload = window.buildGenerationPayload();
  assert.equal(payload.availableTools, 'xilofon');
  assert.equal(payload.blacklist, 'gyurma');
  assert.equal(payload.kindergartenProfile, 'Zöld Óvoda');
  assert.equal(payload.iktEnabled, true);
  assert.equal(payload.iktCustomApp, 'Bee-Bot szőnyeg');
  assert.equal(payload.requestedModel, 'gemini-3.1-pro-preview');
  const draft = window.collectDraftState();
  window.clearDraftState();
  payload = window.buildGenerationPayload();
  assert.equal(payload.availableTools, '');
  assert.equal(payload.blacklist, '');
  assert.equal(payload.kindergartenProfile, '');
  assert.equal(payload.iktEnabled, false);
  assert.equal(payload.iktCustomApp, '');
  assert.equal(payload.requestedModel, 'gemini-3.1-pro-preview');
  window.applyDraftState(draft);
  payload = window.buildGenerationPayload();
  assert.equal(payload.availableTools, 'xilofon');
  assert.equal(payload.blacklist, 'gyurma');
  assert.equal(payload.kindergartenProfile, 'Zöld Óvoda');
  assert.equal(payload.iktEnabled, true);
  assert.equal(payload.iktCustomApp, 'Bee-Bot szőnyeg');
  assert.equal(payload.requestedModel, 'gemini-3.1-pro-preview');
  assert.equal(doc.querySelector('#advancedSettings').open, true);
});

test('theme toggle switches and persists the dark mode', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  assert.equal(doc.documentElement.dataset.theme, 'light');
  doc.querySelector('#themeToggle').click();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(window.localStorage.getItem('oviKretaTheme'), 'dark');
  doc.querySelector('#themeToggle').click();
  assert.equal(window.localStorage.getItem('oviKretaTheme'), 'light');
});

test('weekly extras and daily focus area allocation follow the duration selection', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  assert.equal(doc.querySelector('#weeklyAdvancedBlock').hidden, true);
  assert.equal(doc.querySelector('#dailyFocusAreaField').hidden, false);
  assert.equal(doc.querySelector('#weeklyFocusAreaPanel'), null);

  const verseBox = doc.querySelector('input[data-focus-area="Verselés, mesélés"]');
  const verseCard = verseBox.closest('.focus-area-card');
  const verseDayRow = verseCard.querySelector('.focus-area-day-row');
  assert.equal(verseDayRow.hidden, true);

  verseBox.click();
  assert.equal(verseDayRow.hidden, true);

  window.setDurationSelection('Heti');
  assert.equal(doc.querySelector('#weeklyAdvancedBlock').hidden, false);
  assert.equal(doc.querySelector('#dailyFocusAreaField').hidden, false);
  assert.ok(doc.querySelector('#advancedSettings #fridayClosingType'));

  assert.equal(verseDayRow.hidden, false);
  const verseSelect = verseCard.querySelector('.focus-area-day-select');
  assert.equal(verseSelect.value, 'any');

  verseSelect.value = 'Hétfő';
  verseSelect.dispatchEvent(new window.Event('change'));

  const rajzBox = doc.querySelector('input[data-focus-area="Rajzolás, festés, mintázás, kézi munka"]');
  rajzBox.click();
  const rajzCard = rajzBox.closest('.focus-area-card');
  const rajzSelect = rajzCard.querySelector('.focus-area-day-select');
  rajzSelect.value = 'Hétfő';
  rajzSelect.dispatchEvent(new window.Event('change'));

  const weeklyPayload = window.buildGenerationPayload();
  assert.deepEqual([...weeklyPayload.weeklyFocusAreas['Hétfő']], ['Verselés, mesélés', 'Rajzolás, festés, mintázás, kézi munka']);

  const customWeeklyMock = weeklyResult(window);
  customWeeklyMock.request.weeklyFocusAreas['Hétfő'] = ['Verselés, mesélés', 'Mozgás'];
  const files = window.getDocumentList(customWeeklyMock).map((item) => item.fileBase);
  assert.equal(files[1], '01_hetfo-verseles-meseles-mozgas_2026-08-24');

  window.setDurationSelection('Napi');
  assert.equal(doc.querySelector('#dailyFocusAreaField').hidden, false);
  assert.equal(verseDayRow.hidden, true);
});

test('generated plan survives a reload and is removed only by the clean-slate action', async (t) => {
  const saved = JSON.stringify({ ...makePlan(3), request: makePayload() });
  const dom = new JSDOM(html, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.localStorage.setItem('oviKretaGeneratedPlan', saved);
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  const { window } = dom;
  const doc = window.document;
  assert.equal(doc.querySelectorAll('.official-table tbody tr').length, 3);
  assert.notEqual(doc.querySelector('#previewContent').style.display, 'none');
  assert.equal(doc.querySelector('#previewEmpty').style.display, 'none');
  assert.ok(window.localStorage.getItem('oviKretaGeneratedPlan'));

  window.clearDraftState();
  assert.equal(window.localStorage.getItem('oviKretaGeneratedPlan'), null);
  assert.equal(doc.querySelector('#resultDocument').textContent.trim(), '');
  assert.equal(doc.querySelector('#previewContent').style.display, 'none');
  assert.notEqual(doc.querySelector('#previewEmpty').style.display, 'none');
});

test('preview is built from A4 page containers and nothing is rasterised for the export', async (t) => {
  const window = await loadApp(t);
  window.renderResultDocument({ ...makePlan(4), request: makePayload() });
  const doc = window.document;
  assert.ok(doc.querySelectorAll('#resultDocument .a4-page').length >= 1);
  assert.equal(doc.querySelectorAll('#resultDocument .a4-page tbody tr').length, 4);
  assert.equal(window.makePageElement, undefined, 'nincs raszteres oldalelem-készítés');
  assert.equal(window.html2pdf, undefined);
});

test('DOCX is a native Word document with real tables, not an embedded HTML chunk', async (t) => {
  const window = await loadApp(t);
  window.renderResultDocument({ ...makePlan(4), request: makePayload() });
  const doc = window.document;
  assert.equal(doc.querySelector('#resultDocument .doc-meta'), null);
  assert.equal(doc.querySelector('#resultDocument .doc-header').textContent.includes('Szakmai tervezet'), false);
  const docxLib = require('docx');
  window.docx = docxLib;
  const blob = await window.renderDocxBlob('main');
  const buffer = Buffer.from(await blob.arrayBuffer());
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(zip.file('word/afchunk.mht'), null);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok((xml.match(/<w:tr>/g) || []).length >= 5);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /Napi tervezet/);
  assert.equal(xml.includes('SZAKMAI TERVEZET'), false);
  assert.equal(xml.includes('F2E9DF'), false);
  assert.equal(xml.includes('FAF6F1'), false);
  assert.equal(xml.includes('C9BDB0'), false);
  assert.equal(xml.includes('8E8174'), false);
  assert.match(xml, /w:color="000000"/);
});

test('planner page keeps the legal footer and checkout withdrawal note', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  assert.match(doc.title, /Tervező/);
  const footer = doc.getElementById('siteFooter').textContent;
  assert.match(footer, /Nethely Kft\./);
  assert.match(footer, /Békéltető Testület/);
  assert.match(doc.getElementById('checkoutWithdrawalNote').textContent, /14 napos elállási jog/);
  assert.ok(doc.getElementById('cb-digital'));
  assert.ok(doc.getElementById('cb-terms'));
});

test('history panel displays detailed items, distinguishes paid vs draft, supports attach, load, download and delete', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  const loadBtn = doc.getElementById('loadPreviousBtn');
  const panel = doc.getElementById('historyPanel');
  assert.ok(loadBtn);
  assert.ok(panel);

  // Toggle open
  loadBtn.click();
  assert.equal(panel.classList.contains('open'), true);

  // Create a draft item (generated, not paid)
  const draftPayload = makePayload({
    theme: 'Őszi falevelek',
    duration: 'Napi',
    kindergartenName: 'Minta Óvoda',
    focusAreas: ['Mozgás']
  });
  window.savePlanToHistory(draftPayload, 'gen_draft1', false, null);

  // Create a paid item (with full planData)
  const paidPayload = makePayload({
    theme: 'Erdei állatok',
    duration: 'Heti',
    kindergartenName: 'Erdőszéli Óvoda',
    focusAreas: ['Verselés, mesélés']
  });
  const mockPlan = { ...makePlan(5), request: paidPayload, generationId: 'gen_paid1' };
  window.savePlanToHistory(paidPayload, 'gen_paid1', true, mockPlan);

  // Check rendering
  const cards = doc.querySelectorAll('.history-item-card');
  assert.equal(cards.length, 2);

  // The paid card (top item)
  const paidCard = cards[0];
  assert.match(paidCard.querySelector('.history-item-title').textContent, /Erdei állatok/);
  assert.equal(paidCard.querySelector('.history-item-type').textContent, 'Heti');
  assert.ok(paidCard.querySelector('.history-badge-paid'));
  assert.equal(paidCard.querySelector('.history-badge-paid').textContent, 'Fizetve');
  assert.ok(paidCard.querySelector('.btn-history-download'), 'Paid card must have download button');

  // The draft card
  const draftCard = cards[1];
  assert.match(draftCard.querySelector('.history-item-title').textContent, /Őszi falevelek/);
  assert.equal(draftCard.querySelector('.history-item-type').textContent, 'Napi');
  assert.ok(draftCard.querySelector('.history-badge-draft'));
  assert.equal(draftCard.querySelector('.history-badge-draft').textContent, 'Csak előnézet (piszkozat)');
  assert.equal(draftCard.querySelector('.btn-history-download'), null, 'Draft card must NOT have download button');

  // Test "Beállítások betöltése" on draft card
  draftCard.querySelector('.btn-history-load').click();
  assert.equal(doc.querySelector('input[data-field="theme"]').value, 'Őszi falevelek');
  assert.equal(doc.querySelector('input[data-field="kindergarten-name"]').value, 'Minta Óvoda');
  assert.equal(panel.classList.contains('open'), false);

  // Test "Előzményként csatol" on paid card
  loadBtn.click();
  assert.equal(panel.classList.contains('open'), true);
  const banner = doc.getElementById('attachedPlanBanner');
  assert.equal(banner.hidden, true);

  cards[0].querySelector('.btn-history-attach').click();
  assert.equal(banner.hidden, false);
  assert.match(doc.getElementById('attachedPlanText').textContent, /Csatolt előzmény: Erdei állatok \(Heti/);
  assert.match(doc.getElementById('attachedPlanText').textContent, /az új tervezet épít rá, és elkerüli az ismétlődéseket/);

  // Verify that payload gets previousPlanContext
  const payloadWithContext = window.buildGenerationPayload();
  assert.match(payloadWithContext.previousPlanContext, /Erdei állatok/);

  // Remove attached predecessor
  doc.getElementById('attachedPlanRemoveBtn').click();
  assert.equal(banner.hidden, true);
  assert.equal(window.buildGenerationPayload().previousPlanContext, '');

  // Test "Letöltés" on paid card
  loadBtn.click();
  cards[0].querySelector('.btn-history-download').click();
  assert.equal(window.lastResult.theme, mockPlan.theme);
  assert.equal(window.isPlanLocked(), false);

  // Test "Törlés" on history item
  loadBtn.click();
  assert.equal(doc.querySelectorAll('.history-item-card').length, 2);
  cards[1].querySelector('.btn-history-delete').click();
  assert.equal(doc.querySelectorAll('.history-item-card').length, 1);
});

test('weekly day picker toggles days, keeps at least one and feeds payload and summary', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  const chip = (day) => document.querySelector(`#weeklyDayPicker [data-day="${day}"]`);
  window.setDurationSelection('Heti');
  assert.equal(document.querySelectorAll('#weeklyDayPicker .day-chip.active').length, 5);
  chip('Szerda').click();
  chip('Péntek').click();
  assert.equal(chip('Szerda').classList.contains('active'), false);
  assert.deepEqual([...window.buildGenerationPayload().selectedDays], ['Hétfő', 'Kedd', 'Csütörtök']);
  assert.match(document.body.textContent, /Heti tervezet \(Hétfő, Kedd, Csütörtök\)/);
  chip('Hétfő').click();
  chip('Kedd').click();
  chip('Csütörtök').click();
  assert.equal(chip('Csütörtök').classList.contains('active'), true);
  assert.deepEqual([...window.buildGenerationPayload().selectedDays], ['Csütörtök']);
  assert.match(document.querySelector('#weeklyDaysHint').textContent, /Legalább egy napot ki kell választani!/);
  window.setDurationSelection('Napi');
  assert.equal(document.querySelector('#weeklySettingsPanel').hidden, true);
});

test('identical input is served from the local cache without calling the backend', async (t) => {
  const window = await loadApp(t);
  let calls = 0;
  window.fetch = async () => { calls += 1; return Response.json({ success: true, ...makePlan() }); };
  await window.generatePlan();
  await window.generatePlan();
  assert.equal(calls, 1);
  assert.equal(window.document.querySelector('#previewContent').style.display, 'block');
  assert.equal(JSON.parse(window.localStorage.getItem('oviKreta_dailyCount')).count, 1);
});

test('the daily free limit blocks a different request after 3 generations and unlock resets it', async (t) => {
  const window = await loadApp(t);
  let calls = 0;
  window.fetch = async () => { calls += 1; return Response.json({ success: true, ...makePlan() }); };
  const theme = window.document.querySelector('[data-field="theme"]');
  for (const value of ['A', 'B', 'C']) { theme.value = value; await window.generatePlan(); }
  assert.equal(calls, 3);
  theme.value = 'D';
  await window.generatePlan();
  assert.equal(calls, 3);
  assert.match(window.document.querySelector('#generationErrorBanner').textContent, /Elérted a napi ingyenes tervezési limitet \(3\/3\)/);
  window.unlockGeneration('g1');
  assert.equal(JSON.parse(window.localStorage.getItem('oviKreta_dailyCount')).count, 0);
});

test('cache hit is served even when the daily limit is already used up', async (t) => {
  const window = await loadApp(t);
  let calls = 0;
  window.fetch = async () => { calls += 1; return Response.json({ success: true, ...makePlan() }); };
  await window.generatePlan();
  window.localStorage.setItem('oviKreta_dailyCount', JSON.stringify({ date: (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; })(), count: 3 }));
  await window.generatePlan();
  assert.equal(calls, 1);
  assert.equal(window.document.querySelector('#generationErrorBanner').hidden, true);
  assert.equal(window.document.querySelector('#previewContent').style.display, 'block');
});

test('after a reload the unpaid cached plan can be restored with its form and the 4th step', async (t) => {
  const first = await loadApp(t);
  first.fetch = async () => Response.json({ success: true, ...makePlan() });
  first.document.querySelector('[data-field="theme"]').value = 'Visszatöltés próba';
  first.document.querySelector('[data-field="group"]').value = 'Kiscsoport';
  await first.generatePlan();
  const saved = first.localStorage.getItem('oviKreta_lastGeneration');
  assert.ok(saved);
  const second = await loadApp(t);
  second.localStorage.setItem('oviKreta_lastGeneration', saved);
  second.refreshRestoreBanner();
  const banner = second.document.querySelector('#restoreBanner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /befejezetlen, letöltésre váró tervezeted/);
  second.document.querySelector('[data-field="theme"]').value = '';
  second.document.querySelector('#restoreLastBtn').click();
  assert.equal(second.document.querySelector('[data-field="theme"]').value, 'Visszatöltés próba');
  assert.equal(second.document.querySelector('[data-field="group"]').value, 'Kiscsoport');
  assert.equal(second.document.querySelector('.step-panel.active').dataset.step, '4');
  assert.equal(second.document.querySelector('#previewContent').style.display, 'block');
});

test('the age group field lives in step 1', async (t) => {
  const window = await loadApp(t);
  assert.equal(window.document.querySelector('[data-field="group"]').closest('.step-panel').dataset.step, '1');
});

test('the payment=success return unlocks the restored plan, jumps to step 4 and cleans the URL', async (t) => {
  const first = await loadApp(t);
  first.fetch = async () => Response.json({ success: true, ...makePlan() });
  await first.generatePlan();
  const saved = first.localStorage.getItem('oviKreta_lastGeneration');
  const window = await loadApp(t);
  window.localStorage.setItem('oviKreta_lastGeneration', saved);
  const urls = [];
  window.fetch = async (url) => { urls.push(String(url)); return Response.json({ success: true, paid: true, emailEnabled: false }); };
  window.history.pushState({}, '', '/tervezo.html?payment=success&session_id=cs_test_abc123');
  await window.handleCheckoutReturn();
  assert.equal(window.location.search, '');
  assert.ok(urls[0].includes('/api/checkout-session/cs_test_abc123'));
  assert.equal(window.document.querySelector('.step-panel.active').dataset.step, '4');
  assert.equal(window.document.querySelector('#previewContent').style.display, 'block');
  assert.ok(JSON.parse(window.localStorage.getItem('oviKretaUnlocked')).length >= 1);
});

test('429 and 409 responses show the server message and never set the daily counter', async (t) => {
  for (const [status, code, error] of [[429, 'RATE_LIMITED', 'Óránkénti limit.'], [409, 'GENERATION_IN_PROGRESS', 'Már folyamatban van.']]) {
    const window = await loadApp(t);
    window.fetch = async () => Response.json({ success: false, code, error }, { status });
    await window.generatePlan();
    assert.match(window.document.querySelector('#generationErrorBanner').textContent, new RegExp(error));
    assert.equal(window.localStorage.getItem('oviKreta_dailyCount'), null);
    assert.equal(window.document.querySelector('#nextBtn').disabled, false);
  }
});

test('a double click sends only one generation request', async (t) => {
  const window = await loadApp(t);
  let calls = 0;
  let release;
  window.fetch = () => {
    calls += 1;
    return new Promise((resolve) => { release = () => resolve(Response.json({ success: true, ...makePlan() })); });
  };
  const first = window.generatePlan();
  const second = window.generatePlan();
  await second;
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(window.document.querySelectorAll('.official-table tbody tr').length, 5);
});

function fillHistoryFields(window) {
  const { document } = window;
  const values = {
    'kindergarten-name': 'Próba Óvoda', 'kindergarten-profile': 'Zöld Óvoda', 'teacher-name': 'Próba Pedagógus',
    'group-name': 'Próba Csoport', group: 'Vegyes csoport', theme: 'Tavaszi megfigyelés',
    'tevekenyseg-forma': 'Mikrocsoportos / egyéni fejlesztés', elozmeny: 'Korábbi udvari játék.',
    'custom-note': 'Egyéni kiegészítés.', 'group-note': 'Csoportkérés.', 'required-text': 'Saját mondóka.',
    'available-tools': 'Nagyító.', 'custom-request': 'Csendes lezárás.', 'child-count': 21,
    blacklist: 'Ne legyen gyurma, ne legyen Süss fel nap.'
  };
  for (const [field, value] of Object.entries(values)) document.querySelector(`[data-field="${field}"]`).value = value;
  document.querySelector('[data-field="show-literature"]').checked = true;
  const iktToggle = document.querySelector('#iktEnabled');
  iktToggle.checked = true;
  iktToggle.dispatchEvent(new window.Event('change'));
  document.querySelectorAll('#iktToolsPicker [data-ikt-tool]')[1].click();
  document.querySelector('#iktCustomApp').value = 'Fényasztal';
  document.querySelectorAll('[data-focus-area]').forEach((box, index) => { box.checked = index < 3; });
  window.setDurationSelection('Heti');
  document.querySelector('[data-field="week-value"]').value = '2026-W45';
  const selects = Array.from(document.querySelectorAll('.focus-area-card .focus-area-day-select'));
  selects[0].value = 'Kedd';
  document.querySelector('#weeklyProgressionType').selectedIndex = 1;
  document.querySelector('#fridayClosingType').selectedIndex = 2;
}

test('restorePlanSettings round-trips every setting, including blacklist, IKT, literature and weekly options', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  fillHistoryFields(window);
  const saved = JSON.parse(JSON.stringify(window.buildGenerationPayload()));
  assert.equal(saved.iktEnabled, true);
  assert.equal(saved.iktTools.length, 1);

  window.clearDraftState();
  assert.equal(window.buildGenerationPayload().blacklist, '');
  window.restorePlanSettings(saved);

  const restored = JSON.parse(JSON.stringify(window.buildGenerationPayload()));
  assert.deepEqual(restored, saved);
  assert.equal(document.querySelector('#iktOptionsPanel').hidden, false);
  assert.equal(document.querySelector('#iktToggleStatusLabel').textContent, 'Igen');
});

test('restorePlanSettings clears fields that were empty in the saved plan', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  const saved = JSON.parse(JSON.stringify(window.buildGenerationPayload()));
  fillHistoryFields(window);
  window.restorePlanSettings(saved);
  const restored = window.buildGenerationPayload();
  assert.equal(restored.blacklist, '');
  assert.equal(restored.elozmeny, '');
  assert.equal(restored.iktEnabled, false);
  assert.equal(restored.showLiteratureAtBottom, false);
  assert.equal(document.querySelector('#iktOptionsPanel').hidden, true);
  assert.equal(document.querySelector('#iktToggleStatusLabel').textContent, 'Nem');
});

function stubTurnstile(window) {
  const widget = { options: null, resets: 0, removed: 0 };
  window.turnstile = {
    render: (_selector, options) => { widget.options = options; return 'w1'; },
    reset: () => { widget.resets += 1; },
    remove: () => { widget.removed += 1; }
  };
  return widget;
}

async function clickToGenerate(window) {
  const step = window.document.querySelector('.wizard-item[data-step="3"]');
  step.click();
  window.document.getElementById('nextBtn').click();
}

test('the planner page has no static Turnstile box, only the check modal', async (t) => {
  const window = await loadApp(t);
  const doc = window.document;
  const modal = doc.getElementById('turnstileModal');
  assert.ok(modal);
  assert.equal(modal.classList.contains('open'), false);
  assert.equal(doc.querySelectorAll('#turnstileContainer').length, 1);
  assert.ok(modal.contains(doc.getElementById('turnstileContainer')));
  assert.equal(modal.querySelector('h2').textContent, 'Biztonsági ellenőrzés');
  assert.match(modal.textContent, /Kérjük, igazold, hogy nem robot vagy a tervezet elkészítéséhez\./);
  assert.equal(modal.querySelector('#turnstileCancel').textContent, 'Mégse');
  for (const step of [0, 1, 2, 3]) {
    doc.querySelector(`.wizard-item[data-step="${step}"]`).click();
    assert.equal(modal.classList.contains('open'), false);
    assert.equal(doc.querySelector('.step.active #turnstileContainer, .form-step.active #turnstileContainer'), null);
  }
});

test('without a site key generation starts directly and no modal opens', async (t) => {
  const window = await loadApp(t);
  let calls = 0;
  window.APP_CONFIG = { ...(window.APP_CONFIG || {}), turnstileSiteKey: '' };
  window.fetch = async () => { calls += 1; return Response.json({ success: true, ...makePlan() }); };
  await clickToGenerate(window);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);
  assert.equal(window.document.getElementById('turnstileModal').classList.contains('open'), false);
});

test('with a site key the click opens the modal first and the verified token auto-starts generation', async (t) => {
  const window = await loadApp(t);
  const widget = stubTurnstile(window);
  const bodies = [];
  window.APP_CONFIG = { ...(window.APP_CONFIG || {}), turnstileSiteKey: 'site-key' };
  window.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({ success: true, ...makePlan() }); };
  const modal = window.document.getElementById('turnstileModal');

  await clickToGenerate(window);
  assert.equal(modal.classList.contains('open'), true);
  assert.equal(bodies.length, 0);
  assert.equal(widget.options.sitekey, 'site-key');

  widget.options.callback('tok-123');
  assert.equal(modal.classList.contains('open'), true, 'a pipa látszik a várakozás alatt');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(modal.classList.contains('open'), false);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].turnstileToken, 'tok-123');
  assert.equal(window.eval('currentTurnstileToken'), '', 'a token a generálás után törlődik');
  assert.ok(widget.resets >= 1);
});

test('cancelling the modal blocks the backend call and a late token does not start generation', async (t) => {
  const window = await loadApp(t);
  const widget = stubTurnstile(window);
  let calls = 0;
  window.APP_CONFIG = { ...(window.APP_CONFIG || {}), turnstileSiteKey: 'site-key' };
  window.fetch = async () => { calls += 1; return Response.json({ success: true, ...makePlan() }); };
  await clickToGenerate(window);
  window.document.getElementById('turnstileCancel').click();
  assert.equal(window.document.getElementById('turnstileModal').classList.contains('open'), false);
  widget.options.callback('late-token');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls, 0);
});

test('a Turnstile load or verification error shows a clear Hungarian message', async (t) => {
  const window = await loadApp(t);
  window.APP_CONFIG = { ...(window.APP_CONFIG || {}), turnstileSiteKey: 'site-key' };
  window.fetch = async () => { throw new Error('nem hívható'); };
  await clickToGenerate(window);
  const script = window.document.getElementById('turnstileScript');
  assert.ok(script);
  script.onerror();
  const box = window.document.getElementById('turnstileError');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /nem tölthető be/);
  assert.equal(window.document.getElementById('turnstileScript'), null);

  const widget = stubTurnstile(window);
  window.document.getElementById('turnstileCancel').click();
  window.document.getElementById('nextBtn').click();
  widget.options['error-callback']();
  assert.match(box.textContent, /nem sikerült/);
});

test('isoWeekValue always returns a valid ISO week, also across year boundaries', async (t) => {
  const window = await loadApp(t);
  const week = (year, month, day) => window.isoWeekValue(new window.Date(year, month - 1, day));
  assert.equal(week(2026, 11, 3), '2026-W45');
  assert.equal(week(2026, 11, 2), '2026-W45');
  assert.equal(week(2026, 11, 8), '2026-W45');
  assert.equal(week(2026, 1, 1), '2026-W01');
  assert.equal(week(2024, 12, 30), '2025-W01');
  assert.equal(week(2021, 1, 3), '2020-W53');
  assert.equal(week(2027, 1, 1), '2026-W53');
  assert.equal(week(2026, 12, 31), '2026-W53');
  assert.equal(week(2027, 1, 4), '2027-W01');

  // Minden nap 2019–2031 között érvényes, és a hét hétfője pontosan a nap hétfője.
  const mondayOf = (date) => {
    const monday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() || 7) - 1)));
    return monday.toISOString().slice(0, 10);
  };
  for (let date = new Date(2019, 0, 1); date.getFullYear() <= 2031; date.setDate(date.getDate() + 1)) {
    const value = window.isoWeekValue(new window.Date(date.getFullYear(), date.getMonth(), date.getDate()));
    assert.match(value, /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, value);
    assert.equal(window.getMondayDateForWeek(value).toISOString().slice(0, 10), mondayOf(date), `${date.toDateString()} -> ${value}`);
  }
});

test('switching to the weekly duration pre-fills a valid current week in the week field', async (t) => {
  const window = await loadApp(t);
  const field = window.document.querySelector('[data-field="week-value"]');
  field.value = '';
  window.setDurationSelection('Heti');
  assert.match(field.value, /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/);
  assert.equal(field.value, window.isoWeekValue());
  assert.equal(window.buildGenerationPayload().dateValue, field.value);
  field.value = '2026-W45';
  window.setDurationSelection('Napi');
  window.setDurationSelection('Heti');
  assert.equal(field.value, '2026-W45', 'a már megadott hét nem íródik felül');
});

test('the standard DOCX keeps every paragraph of a table cell as its own Word paragraph', async (t) => {
  const window = await loadApp(t);
  window.docx = require('docx');
  const plan = makePlan(3);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = ['Első bekezdés.', 'Második bekezdés.', 'Harmadik bekezdés.'];
  window.renderResultDocument({ ...plan, request: makePayload() });
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(await (await window.renderDocxBlob('main')).arrayBuffer()));
  const xml = await zip.file('word/document.xml').async('string');
  const table = xml.split('<w:tbl>')[2];
  const rows = table.split('<w:tr>').slice(2);
  const paragraphsPerCell = rows.map((row) => row.split('<w:tc>').slice(1).map((cell) => (cell.split('</w:tc>')[0].match(/<w:p>/g) || []).length));
  assert.deepEqual(paragraphsPerCell, [[1, 3, 1], [1, 2, 1], [1, 2, 1]]);
  const firstActivityCell = rows[0].split('<w:tc>')[2];
  for (const sentence of ['Első bekezdés.', 'Második bekezdés.', 'Harmadik bekezdés.']) {
    const holders = firstActivityCell.split('</w:p>').filter((paragraph) => paragraph.includes(sentence));
    assert.equal(holders.length, 1);
    assert.equal(holders[0].includes('Első bekezdés.') && holders[0].includes('Második bekezdés.'), false, 'a bekezdések nem olvadhatnak össze');
  }
});
