const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { makePayload, makePlan } = require('./fixtures');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

async function loadApp(t) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      // jsdom provides the real DOM but does not implement scrolling or dialogs.
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
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
  setField('energy-level', 0);
  setField('has-preschoolers', false);
  setField('group-note', 'Vizuális jelzés szükséges.');
  setField('required-text', 'Saját levélmondóka.');
  setField('idea-note', 'Nagyító.');
  setField('custom-request', 'Páros levélválogatás.');
  setField('detail-level', 80);
  const focus = document.querySelector('[data-focus-area]');
  assert.ok(focus);
  focus.checked = true;
  const sni = document.querySelector('[data-sni-label]');
  sni.checked = true;
  const payload = window.buildGenerationPayload();
  assert.equal(payload.childCount, 23);
  assert.equal(payload.energyLevel, 0);
  assert.equal(payload.hasPreschoolers, false);
  assert.equal(payload.focusAreas[0], focus.dataset.focusArea);
  assert.equal(payload.specialNeeds[0], sni.dataset.sniLabel);
  assert.equal(payload.customNotes.requiredText, 'Saját levélmondóka.');
  assert.equal(payload.customNotes.customRequest, 'Páros levélválogatás.');
  assert.equal(payload.detailLevel, 80);
  window.setDurationSelection('Heti');
  assert.equal(window.buildGenerationPayload().planMode, 'weekly');
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
    'kindergarten-name': 'Próba Óvoda', 'teacher-name': 'Próba Pedagógus',
    'group-name': 'Próba Csoport', group: 'Vegyes csoport', theme: 'Tavaszi megfigyelés',
    'tevekenyseg-forma': 'Mozgás', elozmeny: 'Korábbi udvari játék.',
    'custom-note': 'Egyéni kiegészítés.', 'group-note': 'Csoportkérés.',
    'required-text': 'Saját mondóka.', 'idea-note': 'Labdák.', 'custom-request': 'Csendes lezárás.'
  };
  for (const [field, value] of Object.entries(values)) document.querySelector(`[data-field="${field}"]`).value = value;
  document.querySelectorAll('[data-focus-area], [data-sni-label]').forEach((checkbox) => { checkbox.checked = true; });
  document.querySelector('[data-field="date-value"]').value = '2026-11-03';
  document.querySelector('[data-field="show-literature"]').checked = true;
  document.querySelector('.mode-pill[data-mode="Szülői tájékoztató"]').click();
  const daily = window.buildGenerationPayload();
  assert.equal(daily.dateValue, '2026-11-03');
  assert.equal(daily.tevekenysegForma, values['tevekenyseg-forma']);
  assert.equal(daily.elozmeny, values.elozmeny);
  assert.equal(daily.kindergartenName, values['kindergarten-name']);
  assert.equal(daily.teacherName, values['teacher-name']);
  assert.equal(daily.groupName, values['group-name']);
  assert.equal(daily.group, values.group);
  assert.equal(daily.theme, values.theme);
  assert.equal(daily.focusAreas.length, 5);
  assert.equal(daily.specialNeeds.length, 4);
  assert.equal(daily.customNotes.primary, values['custom-note']);
  assert.equal(daily.customNotes.groupNote, values['group-note']);
  assert.equal(daily.customNotes.ideaNote, values['idea-note']);
  assert.equal(daily.showLiteratureAtBottom, true);
  assert.equal(daily.outputMode, 'Szülői tájékoztató');
  window.setDurationSelection('Heti');
  document.querySelector('[data-field="week-value"]').value = '2026-W45';
  const weekly = window.buildGenerationPayload();
  assert.equal(weekly.dateValue, '2026-W45');
  assert.equal(weekly.planMode, 'weekly');
  assert.equal(weekly.includeDailyBreakdown, true);
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

test('export section toggles and margins affect the actual generated document', async (t) => {
  const window = await loadApp(t);
  const document = window.document;
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  const toggle = (name, checked) => {
    const control = document.querySelector(`[data-export-section="${name}"]`);
    control.checked = checked;
    control.dispatchEvent(new window.Event('change'));
  };
  toggle('summary', false);
  assert.equal(document.querySelector('.doc-summary'), null);
  toggle('goals', false);
  assert.equal(document.querySelector('#resultDocument').textContent.includes(makePlan().nevelesi_feladatok), false);
  toggle('materials', false);
  assert.equal(document.querySelector('#resultDocument').textContent.includes('nagyító'), false);
  toggle('differentiation', false);
  assert.equal(document.querySelectorAll('.official-table thead th').length, 2);
  assert.equal(document.querySelectorAll('.official-table col').length, 2);
  toggle('activities', false);
  assert.equal(document.querySelector('.official-table'), null);
  for (const name of ['summary', 'goals', 'materials', 'differentiation', 'activities']) toggle(name, true);
  assert.equal(document.querySelectorAll('.official-table thead th').length, 3);
  assert.equal(document.querySelectorAll('.official-table tbody tr').length, 5);
  const margin = document.querySelector('[data-export="margin"]');
  margin.value = 'spacious';
  margin.dispatchEvent(new window.Event('change'));
  assert.equal(document.querySelector('#resultDocument').dataset.margin, 'spacious');
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

test('a clean draft clears the document and restores usable export defaults', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => Response.json({ success: true, ...makePlan() });
  await window.generatePlan();
  window.clearDraftState();
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
  assert.equal(window.document.querySelector('#previewContent').style.display, 'none');
  assert.equal(window.document.querySelector('[data-field="energy-level"]').value, '65');
  assert.equal(window.document.querySelector('[data-export="margin"]').value, 'comfortable');
  assert.ok(Array.from(window.document.querySelectorAll('[data-export-section]')).every((control) => control.checked));
});

test('network errors show a real error without document content', async (t) => {
  const window = await loadApp(t);
  window.fetch = async () => { throw new TypeError('Network unavailable'); };
  await window.generatePlan();
  assert.match(window.document.querySelector('#generationErrorBanner').textContent, /Network unavailable/);
  assert.equal(window.document.querySelector('#resultDocument').textContent.trim(), '');
});
test('weekly plan renders the frame table and five day sheets', async (t) => {
  const window = await loadApp(t);
  const days = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];
  const row = { ido: '10 perc', tevekenyseg_menete: ['Egy', 'Kettő'], modszerek_megjegyzesek: 'Megfigyelés' };
  window.renderResultDocument({
    is_weekly: true,
    summary: 'Heti projekt',
    heti_keretterv: {
      tema: 'Erdő', heti_fo_cel: 'Cél', nevelesi_feladatok: 'N', didaktikai_feladatok: 'D',
      teruletek_heti_eloszlasa: days.map((nap) => ({ nap, fo_terulet: 'T', mikrocsoportos_tevekenyseg: 'M' })),
      eszkozok: ['levél'], felhasznalt_irodalom: ''
    },
    napok: days.map((nap_neve) => ({ nap_neve, tevekenyseg_forma: 'Komplex', napi_cel: 'C', kidolgozas_tablazat: [row] })),
    request: makePayload({ duration: 'Heti', planMode: 'weekly' })
  });
  const doc = window.document;
  assert.equal(doc.querySelectorAll('.document-day-sheet').length, 5);
  assert.equal(doc.querySelectorAll('.document-day-sheet .official-table tbody tr').length, 5);
  assert.equal(doc.querySelectorAll('.official-table').length, 6);
});
