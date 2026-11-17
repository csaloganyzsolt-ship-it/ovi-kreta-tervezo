// Védőháló a refaktoráláshoz: a kimenetek változatlanságát rögzített (golden) fájlokkal őrzi. Frissítés: UPDATE_GOLDEN=1 npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildPrompt } = require('../server');
const { makePayload, makePlan, readPage } = require('./fixtures');

const GOLDEN_DIR = path.join(__dirname, 'golden');

function expectGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  assert.ok(fs.existsSync(file), `Hiányzó golden fájl: ${name} (UPDATE_GOLDEN=1 npm test)`);
  assert.equal(actual, fs.readFileSync(file, 'utf8'), `A kimenet eltér a golden fájltól: ${name}`);
}

async function loadApp(t, config = {}) {
  const dom = new JSDOM(readPage('tervezo.html'), {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.APP_CONFIG = config;
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  return dom.window;
}

function fillCommonFields(document) {
  const values = {
    'kindergarten-name': 'Golden Óvoda', 'kindergarten-profile': 'Zöld Óvoda', 'teacher-name': 'Golden Pedagógus',
    'group-name': 'Katica csoport', group: 'Vegyes csoport', theme: 'Őszi erdő',
    'tevekenyseg-forma': 'Mikrocsoportos / egyéni fejlesztés', elozmeny: 'Korábbi udvari játék.',
    'custom-note': 'Egyéni kiegészítés.', 'group-note': 'Csoportkérés.', 'required-text': 'Saját mondóka.',
    'available-tools': 'Nagyító.', 'custom-request': 'Csendes lezárás.', 'child-count': 22, blacklist: 'Ne legyen gyurma.'
  };
  for (const [field, value] of Object.entries(values)) document.querySelector(`[data-field="${field}"]`).value = value;
  document.querySelector('[data-field="show-literature"]').checked = true;
  document.querySelector('#iktEnabled').checked = true;
  document.querySelector('#iktToolsPicker [data-ikt-tool]').classList.add('active');
  document.querySelector('#iktCustomApp').value = 'Saját fejlesztő játék';
  const areas = Array.from(document.querySelectorAll('[data-focus-area]'));
  areas[0].checked = true;
  areas[1].checked = true;
  document.querySelector('[data-sni-label]').checked = true;
}

test('golden: daily request payload', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  fillCommonFields(document);
  document.querySelector('[data-field="date-value"]').value = '2026-11-03';
  expectGolden('payload-daily.json', `${JSON.stringify(window.buildGenerationPayload(), null, 2)}\n`);
});

test('golden: weekly request payload', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  fillCommonFields(document);
  window.setDurationSelection('Heti');
  document.querySelector('[data-field="week-value"]').value = '2026-W45';
  const [first, second] = Array.from(document.querySelectorAll('.focus-area-card .focus-area-day-select'));
  first.value = 'Hétfő';
  second.value = 'Szerda';
  document.querySelector('#weeklyProgressionType').selectedIndex = 1;
  document.querySelector('#fridayClosingType').selectedIndex = 1;
  expectGolden('payload-weekly.json', `${JSON.stringify(window.buildGenerationPayload(), null, 2)}\n`);
});

function weeklyPlan() {
  const days = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];
  const row = { ido: '10 perc', tevekenyseg_menete: ['Első bekezdés.', 'Második bekezdés.'], modszerek_megjegyzesek: 'Megfigyelés' };
  return {
    is_weekly: true,
    summary: 'Heti projekt',
    heti_keretterv: {
      tema: 'Erdő', heti_fo_cel: 'Cél', nevelesi_feladatok: 'N', didaktikai_feladatok: 'D',
      teruletek_heti_eloszlasa: days.map((nap, index) => ({ nap, fo_terulet: `Terület ${index + 1}`, csoportos_tevekenyseg: `Tevékenység ${index + 1}` })),
      eszkozok: ['levél'], felhasznalt_irodalom: ''
    },
    napok: days.map((nap_neve) => ({ nap_neve, tevekenyseg_forma: 'Mese és vers', napi_cel: 'C', kidolgozas_tablazat: [row] })),
    request: makePayload({ duration: 'Heti', planMode: 'weekly', dateValue: '2026-W45' })
  };
}

test('golden: rendered daily, weekly and locked documents', async (t) => {
  const window = await loadApp(t);
  const out = [];

  window.renderResultDocument({ ...makePlan(3), generationId: 'gen_golden_daily', request: makePayload() });
  out.push('## daily', window.document.querySelector('#resultDocument').innerHTML);

  window.renderResultDocument({ ...weeklyPlan(), generationId: 'gen_golden_weekly' });
  out.push('## weekly keret', window.document.querySelector('#resultDocument').innerHTML);
  window.selectDocument('nap-1');
  out.push('## weekly nap-1', window.document.querySelector('#resultDocument').innerHTML);

  expectGolden('document-render.html', `${out.join('\n')}\n`);
});

test('golden: rendered locked document', async (t) => {
  const window = await loadApp(t, { paywallEnabled: true });
  const plan = makePlan(3);
  plan.locked_meta = { is_locked: true, table_count: 1, activity_count: 3, summary_text: 'Zárolt összefoglaló.' };
  window.renderResultDocument({ ...plan, generationId: 'gen_golden_locked', request: makePayload() });
  expectGolden('document-render-locked.html', `${window.document.querySelector('#resultDocument').innerHTML}\n`);
});

test('golden: generation prompts', () => {
  const weekly = makePayload({
    duration: 'Heti',
    planMode: 'weekly',
    includeDailyBreakdown: true,
    selectedDays: ['Hétfő', 'Szerda', 'Péntek'],
    weeklyProgressionType: 'progressive',
    fridayClosingType: 'Szülői kiállítás',
    focusAreas: ['Mozgás', 'Verselés, mesélés', 'Ének, zene, népi játék, tánc'],
    weeklyFocusAreas: { 'Hétfő': ['Mozgás'], 'Szerda': ['Verselés, mesélés'] },
    previousPlanContext: 'Előző heti terv: Süss fel nap mondóka.',
    blacklist: 'gyurma',
    iktEnabled: true,
    iktTools: ['Padlórobotok'],
    iktCustomApp: 'fényasztal'
  });
  const out = [
    '## daily', buildPrompt(makePayload()),
    '## daily homogeneous group', buildPrompt(makePayload({ group: 'Középső csoport', blacklist: 'gyurma' })),
    '## weekly', buildPrompt(weekly)
  ];
  expectGolden('prompts.txt', `${out.join('\n')}\n`);
});
