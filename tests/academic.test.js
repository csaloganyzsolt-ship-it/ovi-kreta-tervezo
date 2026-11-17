const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const JSZip = require('jszip');
const docxLib = require('docx');
const {
  makePayload, makeAcademicPayload, makeAcademicResponse, makeThematicPayload, makeThematicResponse, readPage
} = require('./fixtures');
const server = require('../server');
const academicPlan = require('../services/academicPlan');
const planStore = require('../services/planStore');
const mailService = require('../services/mailService');
const { validateGeneratePayload } = require('../services/generateValidation');

const html = readPage('tervezo.html');

// ---------- Backend: validáció, prompt, normalizálás ----------

test('planMode accepts standard and academic, and maps the legacy daily/weekly value to planKind', () => {
  assert.equal(validateGeneratePayload({ planMode: 'academic' }).planMode, 'academic');
  assert.equal(validateGeneratePayload({ planMode: 'standard', planKind: 'weekly' }).planKind, 'weekly');
  const legacy = validateGeneratePayload({ planMode: 'weekly' });
  assert.equal(legacy.planKind, 'weekly');
  assert.equal('planMode' in legacy, false);
  assert.throws(() => validateGeneratePayload({ planMode: 'tanulo' }), /Érvénytelen beállítás: planMode/);
  assert.throws(() => validateGeneratePayload({ planKind: 'havi' }), /Érvénytelen beállítás: planKind/);
  assert.equal(validateGeneratePayload({ studentName: 'Kovács Anna' }).studentName, 'Kovács Anna');
  assert.throws(() => validateGeneratePayload({ studentName: 'x'.repeat(201) }), /studentName/);
});

test('the standard prompt does not change with an explicit standard planMode and never mentions the academic template', () => {
  const base = server.buildPrompt(makePayload());
  assert.equal(server.buildPrompt(makePayload({ planMode: 'standard', planKind: 'daily' })), base);
  assert.doesNotMatch(base, /Foglalkozási\/tevékenységi terv|Tematikus terv|Felhasznált irodalom:/);
  const weekly = makePayload({ duration: 'Heti', planKind: 'weekly', planMode: 'standard', includeDailyBreakdown: true });
  assert.match(server.buildPrompt(weekly), /heti_keretterv/);
});

test('the academic daily prompt carries the university-level structure, typography and source rules', () => {
  const prompt = server.buildPrompt(makeAcademicPayload());
  for (const required of [
    'Foglalkozási/tevékenységi terv', 'tevekenyseg_forma', 'elozmeny', 'uj_anyag', 'ismetles', 'keszsegfejlesztes', 'zenehallgatas',
    'Nevelési feladatok', 'Didaktikai feladatok', 'Képesség- és készségfejlesztés', 'modszerek', 'eszkozok',
    '"N p"', '**Szervezési feladatok:**', '**Motiváció:**', '**Elköszönés:**', 'Tanulásszervezés módja: kötetlen.', 'Az ügyesebbek',
    '*szöveg* = dőlt betű', '**szöveg** = félkövér', '(ÉNÓ 173.)', 'KEE', 'ONAP', 'Felhasznált irodalom:',
    'Szerző: Cím. Kiadó, Város, Évszám. (Rövidítés)', 'Óvodai nevelés országos alapprogramja (ONAP)', 'SZERZŐI JOG', 'ne találj ki'
  ]) assert.ok(prompt.includes(required), required);
  assert.match(prompt, /"planMode":"academic"/);
  assert.match(prompt, /"studentName":"Minta Hallgató"/);
  assert.doesNotMatch(prompt, /heti_keretterv|"napok"/);
});

test('the academic thematic prompt asks for the 7 column matrix with every mandatory group and frame', () => {
  const prompt = server.buildPrompt(makeThematicPayload());
  assert.match(prompt, /Tematikus terv/);
  assert.match(prompt, /2026\. november 2–6\./);
  for (const { key, label } of academicPlan.AREA_COLUMNS) {
    assert.ok(prompt.includes(key), key);
    assert.ok(prompt.includes(label), label);
  }
  for (const text of ['versek, ismetles, mesek, szolasok_kozmondasok, talalos_kerdesek, nyelvtorok', 'enekes_jatek, kiszamolo, zenehallgatas',
    'celok', 'feladatok', 'kiemelt_fejlesztesi_terulet', 'modszerek', 'eszkozok', 'megjegyzes_egyeb_tevekenysegek',
    'jatekbovites', 'anyanyelvi_jatekok', 'fejlesztojatek', 'kirandulas_setak', 'Szerző: Cím (forráskód)', 'Felhasznált irodalom:']) {
    assert.ok(prompt.includes(text), text);
  }
  assert.doesNotMatch(prompt, /heti_keretterv|"napok"/);
});

test('an academic weekly plan never asks for the five-day breakdown, even if the request still carries it', () => {
  const payload = makeThematicPayload({ includeDailyBreakdown: true });
  assert.equal(server.buildPrompt(payload).includes('heti_keretterv'), false);
  const result = server.normalizeResponse(JSON.stringify(makeThematicResponse()), payload);
  assert.equal(result.is_thematic, true);
  assert.equal('is_weekly' in result, false);
});

test('academic daily responses are normalized with minute-exact times and a mandatory bibliography', () => {
  const payload = makeAcademicPayload();
  const result = server.normalizeResponse(JSON.stringify(makeAcademicResponse()), payload);
  assert.equal(result.planMode, 'academic');
  assert.deepEqual(result.kidolgozas_tablazat.map((row) => row.ido), ['2 p', '7 p', '8 p', '3 p']);
  assert.equal(result.ossz_ido_perc, 20);
  assert.equal(result.showLiteratureAtBottom, true);
  assert.match(result.felhasznalt_irodalom, /ONAP/);
  assert.equal(result.tartalom.zenehallgatas.startsWith('Törzsök Béla'), true);

  const fail = (overrides, pattern) => assert.throws(() => server.normalizeResponse(JSON.stringify(makeAcademicResponse(overrides)), payload), pattern);
  fail({ tartalom: undefined }, /tartalom/);
  fail({ tartalom: { uj_anyag: '', ismetles: '', keszsegfejlesztes: '', zenehallgatas: '' } }, /tartalom\.uj_anyag/);
  fail({ felhasznalt_irodalom: '' }, /felhasznalt_irodalom/);
  fail({ kepessegfejlesztes: '' }, /kepessegfejlesztes/);
  fail({ kidolgozas_tablazat: makeAcademicResponse().kidolgozas_tablazat.slice(0, 2) }, /legalább 3 sort/);
  fail({ kidolgozas_tablazat: [{ ido: 'sokáig', tevekenyseg_menete: ['a'], modszerek_megjegyzesek: 'b' }, ...makeAcademicResponse().kidolgozas_tablazat] }, /Érvénytelen időkeret/);
});

test('thematic responses are normalized with computed week dates and every mandatory group', () => {
  const payload = makeThematicPayload();
  const result = server.normalizeResponse(JSON.stringify(makeThematicResponse()), payload);
  assert.equal(result.is_thematic, true);
  assert.equal(result.planMode, 'academic');
  assert.equal(result.hetek.length, 1);
  assert.equal(result.hetek[0].het_szama, 1);
  assert.equal(result.hetek[0].datum, '2026. november 2–6.');
  assert.deepEqual(Object.keys(result.hetek[0].teruletek), academicPlan.AREA_COLUMNS.map((area) => area.key));
  assert.deepEqual(Object.keys(result.hetek[0].teruletek.verseles_meseles), academicPlan.VERSELES_GROUPS.map(([key]) => key));
  assert.deepEqual(Object.keys(result.hetek[0].teruletek.enek_zene), academicPlan.ENEK_GROUPS.map(([key]) => key));
  assert.equal(result.megjegyzes_egyeb_tevekenysegek, null);

  const clone = () => JSON.parse(JSON.stringify(makeThematicResponse()));
  const fail = (mutate, pattern) => {
    const response = clone();
    mutate(response);
    assert.throws(() => server.normalizeResponse(JSON.stringify(response), payload), pattern);
  };
  fail((r) => { r.hetek.push(r.hetek[0]); }, /pontosan 1 hétnyi/);
  fail((r) => { delete r.hetek[0].teruletek.mozgas; }, /teruletek\.mozgas/);
  fail((r) => { delete r.hetek[0].teruletek.verseles_meseles.talalos_kerdesek; }, /talalos_kerdesek/);
  fail((r) => { r.hetek[0].teruletek.verseles_meseles.versek = []; }, /versek/);
  fail((r) => { r.hetek[0].teruletek.enek_zene.zenehallgatas = []; }, /zenehallgatas/);
  fail((r) => { delete r.hetek[0].keretrendszer.kiemelt_fejlesztesi_terulet.matematika; }, /kiemelt_fejlesztesi_terulet\.matematika/);
  fail((r) => { r.hetek[0].keretrendszer.celok = []; }, /celok/);
  fail((r) => { r.felhasznalt_irodalom = ''; }, /felhasznalt_irodalom/);
});

test('week ranges are computed from ISO weeks and calendar days, never invented', () => {
  assert.equal(academicPlan.weekRangeLabel('2026-W45'), '2026. november 2–6.');
  assert.equal(academicPlan.weekRangeLabel('2024-10-29'), '2024. október 28. – november 1.');
  assert.equal(academicPlan.weekRangeLabel('2026-W45', 1), '2026. november 9–13.');
  assert.equal(academicPlan.weekRangeLabel(''), '');
  assert.equal(academicPlan.weekRangeLabel('valami'), '');
});

async function listen(t) {
  const instance = server.app.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}

function stubGemini(t, text) {
  const realFetch = global.fetch;
  const saved = process.env.GEMINI_API_KEY;
  const calls = [];
  process.env.GEMINI_API_KEY = 'local-test-key';
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') return realFetch(url, options);
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
  };
  t.after(() => {
    global.fetch = realFetch;
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  });
  return calls;
}

const postGenerate = async (base, payload) => {
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { response, data: await response.json() };
};

test('POST /api/generate builds the academic prompt, stores the planMode and returns the academic document', async (t) => {
  const calls = stubGemini(t, JSON.stringify(makeAcademicResponse()));
  const base = await listen(t);
  const { response, data } = await postGenerate(base, makeAcademicPayload());
  assert.equal(response.status, 200);
  assert.equal(data.planMode, 'academic');
  assert.equal(data.ossz_ido_perc, 20);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.contents[0].parts[0].text, /Foglalkozási\/tevékenységi terv/);
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, academicPlan.MAX_ACADEMIC_OUTPUT_TOKENS);
  const stored = planStore.getPlan(data.generationId);
  assert.equal(stored.request.planMode, 'academic');
  assert.equal(stored.request.studentName, 'Minta Hallgató');
  assert.equal(stored.planMode, 'academic');
});

test('POST /api/generate returns a thematic plan for an academic weekly request, and a broken response is an error', async (t) => {
  const calls = stubGemini(t, JSON.stringify(makeThematicResponse()));
  const base = await listen(t);
  const { response, data } = await postGenerate(base, makeThematicPayload());
  assert.equal(response.status, 200);
  assert.equal(data.is_thematic, true);
  assert.equal(data.hetek[0].datum, '2026. november 2–6.');
  assert.match(calls[0].body.contents[0].parts[0].text, /Tematikus terv/);

  stubGemini(t, JSON.stringify({ ...makeThematicResponse(), hetek: [] }));
  const failed = await postGenerate(base, makeThematicPayload());
  assert.equal(failed.response.status, 502);
  assert.match(failed.data.details, /hétnyi tematikus tervet/);
});

test('a locked academic preview mirrors the daily table and the thematic matrix without leaking the real text', async (t) => {
  const secrets = ['aranyhörcsög', 'kukoricamorzsolás', 'cickafarkfű', 'gesztenyebábú'];
  const daily = makeAcademicResponse();
  daily.kidolgozas_tablazat[2].tevekenyseg_menete = [`A pedagógus bemutatja az ${secrets[0]} simogatását.`];
  daily.kidolgozas_tablazat[2].modszerek_megjegyzesek = `Gyógynövényes megfigyelés: ${secrets[1]}.`;
  daily.felhasznalt_irodalom = `Titkos Szerző: ${secrets[3]} tankönyv`;
  const dailyMirror = planStore.createMirrorPlan(server.normalizeResponse(JSON.stringify(daily), makeAcademicPayload()));
  assert.equal(dailyMirror.locked_meta.activity_count, 4);
  const dailyText = JSON.stringify(dailyMirror);
  for (const secret of [secrets[0], secrets[1], secrets[3]]) assert.equal(dailyText.includes(secret), false, secret);
  assert.equal(dailyMirror.tema, makeAcademicResponse().tema);

  const thematic = makeThematicResponse();
  thematic.hetek[0].teruletek.kulso_vilag = [`Kísérlet: ${secrets[2]} főzése.`];
  thematic.hetek[0].teruletek.verseles_meseles.versek = [`Titkos Szerző: ${secrets[0]} (KEE 1.)`];
  thematic.hetek[0].keretrendszer.modszerek = [`${secrets[1]} módszer`];
  const thematicMirror = planStore.createMirrorPlan(server.normalizeResponse(JSON.stringify(thematic), makeThematicPayload()));
  const thematicText = JSON.stringify(thematicMirror);
  for (const secret of secrets) assert.equal(thematicText.includes(secret), false, secret);
  assert.equal(thematicMirror.locked_meta.table_count, 1);
  assert.ok(thematicMirror.locked_meta.activity_count >= 10);
  assert.equal(thematicMirror.hetek[0].foteme, 'Őszi erdő');
  assert.equal(thematicMirror.hetek[0].teruletek.verseles_meseles.versek.length, 1);
});

test('the purchase e-mail names the academic template and only mentions a ZIP when one is attached', () => {
  const env = {};
  const standard = mailService.buildEmailContent({ planLabel: 'napi tervezet', withInvoice: true, test: false }, env);
  assert.doesNotMatch(standard.text, /Oktatási célú/);
  const academic = mailService.buildEmailContent({ planLabel: 'heti csomag', withInvoice: true, test: false, hasZip: false, planMode: 'academic' }, env);
  assert.match(academic.text, /Tervezet típusa: Oktatási célú tervezet/);
  assert.match(academic.html, /Oktatási célú tervezet/);
  assert.doesNotMatch(academic.text, /ZIP/);
  assert.match(academic.html, /Tervezet Word/);
  const legacyWeekly = mailService.buildEmailContent({ planLabel: 'heti csomag', withInvoice: true, test: false }, env);
  assert.match(legacyWeekly.text, /ZIP/);
});

// ---------- Frontend ----------

async function loadApp(t, config) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.alert = (message) => { throw new Error(message); };
      if (config) window.APP_CONFIG = config;
    }
  });
  t.after(() => dom.window.close());
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
  return dom.window;
}

const academicDaily = (overrides = {}, payload = makeAcademicPayload({ dateValue: '2026-11-03' })) => ({
  ...server.normalizeResponse(JSON.stringify(makeAcademicResponse(overrides)), payload), request: payload, generationId: 'gen_academic_daily'
});

const thematic = (response = makeThematicResponse(), payload = makeThematicPayload()) => ({
  ...server.normalizeResponse(JSON.stringify(response), payload), request: payload, generationId: 'gen_thematic'
});

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

test('the plan type switch sits at the very start of step 1, defaults to the kindergarten plan and explains both types', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  const step = document.querySelector('.step-panel[data-step="1"]');
  assert.ok(step.querySelector('#planModeBlock'));
  const order = Array.from(step.children).map((child) => child.id || child.className);
  assert.ok(order.indexOf('planModeBlock') < order.indexOf('restoreBanner'), 'a módválasztó a lépés elején van');
  const cards = Array.from(document.querySelectorAll('.plan-mode-card'));
  assert.deepEqual(cards.map((card) => text(card.querySelector('.plan-mode-title'))), ['Óvodai tervezet', 'Oktatási célú tervezet']);
  assert.equal(cards[0].classList.contains('active'), true);
  const compare = text(document.querySelector('#planModeCompare'));
  assert.match(compare, /Mindennapi óvodai gyakorlathoz optimalizált, gyors és áttekinthető tervezet a főbb célokkal és tevékenységekkel/);
  for (const phrase of ['percre bontott 3 oszlopos foglalkozásmenettel', '7 oszlopos fekvő tematikus mátrixszal',
    'nevelési–didaktikai–képességfejlesztési feladatbontással', 'dőlt betűvel szedett teljes vers-/mondókaszövegekkel', 'ÉNÓ, KEE, ONAP + Felhasznált irodalom']) {
    assert.ok(compare.includes(phrase), phrase);
  }
  assert.equal(document.querySelector('#planModeAcademicExtra').hidden, true);
  const payload = window.buildGenerationPayload();
  assert.equal(payload.planMode, 'standard');
  assert.equal(payload.studentName, '');
});

test('choosing the academic type reveals the student name field and feeds planMode, planKind and studentName into the request', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  document.querySelector('[data-plan-mode="academic"]').click();
  assert.equal(document.querySelector('#planModeAcademicExtra').hidden, false);
  assert.equal(document.querySelector('[data-plan-mode="academic"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-plan-mode-info="academic"]').classList.contains('active'), true);
  assert.match(text(document.querySelector('label[for="studentName"]')), /Hallgató \/ Óvodapedagógus neve/);
  document.querySelector('#studentName').value = '  Kovács Anna ';
  document.querySelector('#studentName').dispatchEvent(new window.Event('input', { bubbles: true }));
  let payload = window.buildGenerationPayload();
  assert.equal(payload.planMode, 'academic');
  assert.equal(payload.planKind, 'daily');
  assert.equal(payload.studentName, 'Kovács Anna');
  assert.equal(payload.showLiteratureAtBottom, true);
  assert.match(text(document.querySelector('#summaryChecklist')), /Tervezet típusa: Oktatási célú tervezet/);
  assert.match(text(document.querySelector('#summaryChecklist')), /Hallgató \/ Óvodapedagógus: Kovács Anna/);
  window.setDurationSelection('Heti');
  assert.match(text(document.querySelector('#summaryChecklist')), /Időtartam: Heti tematikus terv \(egy hét\)/);
  assert.match(text(document.querySelector('#summaryChecklist')), /Pénteki zárás formája: .* \(oktatási célú tervnél nem érvényes\)/);
  window.setDurationSelection('Napi');

  window.setDurationSelection('Heti');
  payload = window.buildGenerationPayload();
  assert.equal(payload.planKind, 'weekly');
  assert.equal(payload.includeDailyBreakdown, false, 'az oktatási célú heti terv egyetlen tematikus terv');
  assert.equal(document.querySelector('#weeklySettingsPanel').hidden, true);
  assert.equal(document.querySelector('#weeklyAdvancedBlock').hidden, true);

  document.querySelector('[data-plan-mode="standard"]').click();
  payload = window.buildGenerationPayload();
  assert.equal(payload.planMode, 'standard');
  assert.equal(payload.studentName, '');
  assert.equal(payload.includeDailyBreakdown, true);
  assert.equal(document.querySelector('#weeklySettingsPanel').hidden, false);
});

test('the plan type and student name survive a draft round trip and the history, and the clean slate resets them', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  document.querySelector('[data-plan-mode="academic"]').click();
  document.querySelector('#studentName').value = 'Kovács Anna';
  const draft = window.collectDraftState();
  assert.equal(draft.planMode, 'academic');

  window.clearDraftState();
  assert.equal(window.buildGenerationPayload().planMode, 'standard');
  assert.equal(document.querySelector('#studentName').value, '');
  assert.equal(document.querySelector('#planModeAcademicExtra').hidden, true);

  window.applyDraftState(draft);
  assert.equal(window.buildGenerationPayload().planMode, 'academic');
  assert.equal(document.querySelector('#studentName').value, 'Kovács Anna');
  assert.equal(document.querySelector('#planModeAcademicExtra').hidden, false);

  window.clearDraftState();
  window.restorePlanSettings(makeAcademicPayload({ studentName: 'Előzményi Hallgató' }));
  assert.equal(window.buildGenerationPayload().planMode, 'academic');
  assert.equal(window.buildGenerationPayload().studentName, 'Előzményi Hallgató');
  window.restorePlanSettings(makePayload({ planMode: 'weekly' }));
  assert.equal(window.buildGenerationPayload().planMode, 'standard', 'a régi előzmények óvodai tervezetként töltődnek vissza');
});

test('a generated academic plan keeps its template and the request, so a successful generation renders the academic document', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  document.querySelector('[data-plan-mode="academic"]').click();
  document.querySelector('[data-field="date-value"]').value = '2026-11-03';
  let sent;
  window.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ success: true, ...server.normalizeResponse(JSON.stringify(makeAcademicResponse()), makeAcademicPayload({ dateValue: '2026-11-03' })) });
  };
  await window.generatePlan();
  assert.equal(sent.planMode, 'academic');
  assert.equal(window.lastResult.request.planMode, 'academic');
  assert.equal(window.lastResult.planMode, 'academic');
  assert.equal(document.querySelector('#resultDocument .doc-header h2').textContent, 'Foglalkozási/tevékenységi terv');
});

test('rich text only produces bold and italic and keeps everything else escaped', async (t) => {
  const { formatRichText, formatRichCell } = await loadApp(t);
  assert.equal(formatRichText('**Cím:** *dőlt\nsor*'), '<strong>Cím:</strong> <em>dőlt<br>sor</em>');
  assert.equal(formatRichText('<img src=x onerror=alert(1)> *a*'), '&lt;img src=x onerror=alert(1)&gt; <em>a</em>');
  assert.equal(formatRichText('5 * 3 * 2'), '5 * 3 * 2');
  assert.equal(formatRichCell(['**Egy:** *két*', 'három']), '<p><strong>Egy:</strong> <em>két</em></p><p>három</p>');
});

test('the academic daily document renders the exact header, the 3 column table with italics and the bibliography', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  window.renderResultDocument(academicDaily());
  const host = document.querySelector('#resultDocument');
  assert.equal(host.dataset.orientation, 'portrait');
  assert.equal(text(host.querySelector('.doc-header h2')), 'Foglalkozási/tevékenységi terv');

  const labels = Array.from(host.querySelectorAll('.academic-meta .meta-label')).map(text);
  assert.deepEqual(labels, [
    'Az óvodapedagógus neve', 'Csoport', 'Tevékenységi forma', 'A tevékenység/foglalkozás időpontja', 'A tevékenység előzménye',
    'A tevékenység tartalma/témája', 'A tevékenység célja', 'A tevékenység feladatai', 'Alkalmazott módszerek, eljárások', 'Eszközök'
  ]);
  const value = (label) => text(Array.from(host.querySelectorAll('.academic-meta .meta-row')).find((row) => text(row.querySelector('.meta-label')) === label).querySelector('.meta-value'));
  assert.equal(value('Az óvodapedagógus neve'), 'Minta Hallgató');
  assert.equal(value('A tevékenység/foglalkozás időpontja'), '2026. 11. 03. (20 perc)');
  assert.match(value('A tevékenység tartalma/témája'), /Őszi falevelek – mondóka és játék\s*Új anyag: Népi mondóka: Süss fel, nap \(KEE 12\.\)\s*Ismétlés: .*\(ÉNÓ 173\.\)\s*Készségfejlesztés: .*\s*Zenehallgatás: Törzsök Béla/);
  assert.match(value('A tevékenység feladatai'), /Nevelési feladatok: .*\s*Didaktikai feladatok: .*\s*Képesség- és készségfejlesztés: /);
  assert.equal(host.querySelectorAll('.academic-meta .meta-row').length, 10);

  const table = host.querySelector('table.academic-process-table');
  assert.deepEqual(Array.from(table.querySelectorAll('thead th')).map(text), [
    'Idő', 'A fejlesztő tevékenység felépítése, a foglalkozás menete', 'A fejlesztés módszerei, munkaformák, eszközök, megjegyzések'
  ]);
  const rows = Array.from(table.tBodies[0].rows);
  assert.deepEqual(rows.map((row) => text(row.cells[0])), ['2 p', '7 p', '8 p', '3 p']);
  assert.equal(text(rows[0].cells[1].querySelector('strong')), 'Szervezési feladatok:');
  assert.equal(text(rows[1].cells[1].querySelector('strong')), 'Motiváció:');
  assert.equal(text(rows[3].cells[1].querySelector('strong')), 'Elköszönés:');
  const verse = rows[2].cells[1].querySelector('em');
  assert.ok(verse.querySelectorAll('br').length >= 2, 'a vers sortörései a dőlt részen belül maradnak');
  assert.match(verse.textContent, /Süss fel, nap, fényes nap,/);
  assert.equal(rows[2].cells[1].querySelector('strong + em, p strong').textContent.includes('Tevékenységi egység'), true);
  assert.match(text(rows[1].cells[2]), /Tanulásszervezés módja: kötetlen\./);
  assert.ok(Array.from(rows[2].cells[2].querySelectorAll('em')).some((em) => /Az ügyesebbek/.test(em.textContent)));
  assert.equal(rows[2].cells[2].querySelector('p:not(:has(em))') !== null, true, 'a módszertani magyarázat álló betűs');

  const headings = Array.from(host.querySelectorAll('h3')).map(text);
  assert.equal(headings[headings.length - 1], 'Felhasznált irodalom:');
  const items = Array.from(host.querySelectorAll('.lit-item')).map(text);
  assert.equal(items.length, 3);
  assert.equal(items[2], 'Óvodai nevelés országos alapprogramja (ONAP)');
});

test('the academic daily bibliography is shown even when the literature checkbox is off, and the teacher name is the fallback author', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  document.querySelector('[data-field="show-literature"]').checked = false;
  const payload = makeAcademicPayload({ studentName: '', teacherName: 'Nagy Eszter', dateValue: '' });
  window.renderResultDocument(academicDaily({}, payload));
  const host = document.querySelector('#resultDocument');
  assert.match(text(host), /Felhasznált irodalom:/);
  assert.match(text(host.querySelector('.academic-meta')), /Az óvodapedagógus neve Nagy Eszter/);
  assert.match(text(host.querySelector('.academic-meta')), /A tevékenység\/foglalkozás időpontja 20 perc/);
});

test('the thematic document renders one 7 column matrix per week with the mandatory groups and the pedagogical frame', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  window.renderResultDocument(thematic());
  const host = document.querySelector('#resultDocument');
  assert.equal(text(host.querySelector('.doc-header h2')), 'Tematikus terv');
  assert.equal(host.dataset.orientation, 'landscape');
  assert.match(text(host.querySelector('.academic-meta')), /Időszak 2026\. november 2–6\. Fő téma Az ősz ajándékai/);

  const table = host.querySelector('table.thematic-table');
  assert.equal(host.querySelectorAll('table.thematic-table').length, 1);
  assert.deepEqual(Array.from(table.querySelectorAll('thead th')).map(text), [
    'Tevékenységi területek', 'A külső világ tevékeny megismerése', 'Matematikai tartalmú tapasztalatok', 'Verselés, mesélés',
    'Ének, zene, énekes játék, gyermektánc', 'Rajzolás, festés, mintázás, kézimunka', 'Mozgás / Testnevelés'
  ]);
  assert.equal(table.querySelectorAll('col').length, 7);
  const cells = Array.from(table.tBodies[0].rows[0].cells);
  assert.equal(cells.length, 7);
  assert.match(text(cells[0]), /Főtéma: Őszi erdő 1\. hét 2026\. november 2–6\. Altéma: Falevelek és termések/);
  assert.deepEqual(Array.from(cells[3].querySelectorAll('.cell-label')).map(text), ['Versek:', 'Ismétlés:', 'Mesék:', 'Szólások, közmondások:', 'Találós kérdések:', 'Nyelvtörők:']);
  assert.deepEqual(Array.from(cells[4].querySelectorAll('.cell-label')).map(text), ['Énekes játék:', 'Kiszámoló:', 'Zenehallgatás:']);
  assert.match(text(cells[3]), /Weöres Sándor: Falevél \(KEE 45\.\)/);
  assert.match(text(cells[3]), /Nyelvtörők:\s*–$/);
  assert.ok(cells[3].querySelector('em'), 'az ismétlés/szólás szövege dőlt');
  assert.match(cells[4].querySelector('em').textContent, /Ég a gyertya, ég/);
  assert.equal(text(cells[1]), 'Falevelek gyűjtése és csoportosítása az udvaron.');

  const headings = Array.from(host.querySelectorAll('h3')).map(text);
  assert.deepEqual(headings, ['1. hét – 2026. november 2–6.', 'Cél, - feladatrendszer:', 'Kiemelt fejlesztési terület:', 'Módszerek, eszközök:', 'Felhasznált irodalom:']);
  const frame = text(host.querySelector('.academic-frame'));
  for (const label of ['Célok:', 'Feladatok:', 'Módszerek:', 'Eszközök:', ...academicPlan.AREA_COLUMNS.map((area) => `${area.label}:`)]) assert.ok(frame.includes(label), label);
  assert.equal(host.textContent.includes('Megjegyzés, egyéb tevékenységek'), false, 'egyhetes tervnél nincs megjegyzés-rész');
});

test('a multi week thematic result also shows the closing notes with all four groups', async (t) => {
  const window = await loadApp(t);
  const result = thematic();
  result.hetek.push({ ...result.hetek[0], het_szama: 2, datum: '2026. november 9–13.' });
  result.megjegyzes_egyeb_tevekenysegek = { jatekbovites: ['Szerepjáték'], anyanyelvi_jatekok: ['Szóláncjáték'], fejlesztojatek: ['Memóriajáték'], kirandulas_setak: ['Erdei séta'] };
  window.renderResultDocument(result);
  const host = window.document.querySelector('#resultDocument');
  assert.equal(host.querySelectorAll('table.thematic-table').length, 2);
  const notes = Array.from(host.querySelectorAll('h3')).find((heading) => text(heading) === 'Megjegyzés, egyéb tevékenységek:').parentElement;
  for (const label of ['Játékbővítés', 'Anyanyelvi játékok', 'Fejlesztőjáték', 'Kirándulás, séta']) assert.ok(text(notes).includes(label), label);
});

test('the thematic plan is forced to landscape, locks the orientation control and names its files after the week', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  window.clearDraftState();
  window.docSettings = { main: { orientation: 'portrait', margin: 'comfortable' } };
  window.renderResultDocument(thematic());
  assert.equal(window.getDocSettings('main').orientation, 'landscape');
  assert.equal(document.querySelector('[data-export="orientation"]').value, 'landscape');
  assert.equal(document.querySelector('[data-export="orientation"]').disabled, true);
  assert.equal(document.querySelector('#resultDocument').dataset.orientation, 'landscape');
  assert.deepEqual(JSON.parse(JSON.stringify(window.getDocumentList().map((doc) => [doc.id, doc.label, doc.fileBase]))), [['main', 'Tematikus terv', 'tematikus-terv_2026-11-02']]);
  assert.equal(document.querySelector('#documentTabs').hidden, true);
  assert.equal(window.planKind(), 'weekly');

  window.renderResultDocument(academicDaily());
  assert.equal(document.querySelector('[data-export="orientation"]').disabled, false);
  assert.equal(window.getDocSettings('main').orientation, 'portrait');
  assert.deepEqual(JSON.parse(JSON.stringify(window.getDocumentList().map((doc) => doc.fileBase))), ['foglalkozasi-terv']);
  assert.equal(window.planKind(), 'daily');
});

test('the front end labels and groups match the server constants one to one', async (t) => {
  const window = await loadApp(t);
  const read = (name) => JSON.parse(JSON.stringify(window.eval(name)));
  assert.deepEqual(read('ACADEMIC_AREAS'), academicPlan.AREA_COLUMNS.map((area) => ({ ...area })));
  assert.deepEqual(read('ACADEMIC_VERSELES_GROUPS'), academicPlan.VERSELES_GROUPS.map(([key, label]) => [key, label]));
  assert.deepEqual(read('ACADEMIC_ENEK_GROUPS'), academicPlan.ENEK_GROUPS.map(([key, label]) => [key, label]));
  assert.deepEqual(read('ACADEMIC_NOTE_GROUPS'), academicPlan.MEGJEGYZES_GROUPS.map(([key, label]) => [key, label]));
});

test('a locked academic preview shows the structure but none of the real activity text, and counts the matrix items', async (t) => {
  const window = await loadApp(t, { paywallEnabled: true });
  const { document } = window;
  const response = makeThematicResponse();
  response.hetek[0].teruletek.kulso_vilag = ['Titkoskísérlet: gesztenyebábú készítése.'];
  const payload = makeThematicPayload();
  const mirror = { ...planStore.createMirrorPlan(server.normalizeResponse(JSON.stringify(response), payload)), request: payload, generationId: 'gen_locked_thematic' };
  window.renderResultDocument(mirror);
  const host = document.querySelector('#resultDocument');
  assert.equal(host.textContent.includes('gesztenyebábú'), false);
  assert.equal(host.textContent.includes('Weöres'), false);
  assert.ok(host.querySelectorAll('.locked-mirror-text').length > 5);
  assert.match(text(host.querySelector('.locked-boundary-text')), /^A teljes dokumentum elkészült: 1 részletes táblázat és \d+ kidolgozott tevékenységi egység vár feloldásra\.$/);
  assert.equal(host.querySelectorAll('table.thematic-table thead th').length, 7);
  assert.equal(document.querySelector('#downloadDocxBtn').disabled, true);

  const dailyPayload = makeAcademicPayload();
  const dailyMirror = { ...planStore.createMirrorPlan(server.normalizeResponse(JSON.stringify(makeAcademicResponse()), dailyPayload)), request: dailyPayload, generationId: 'gen_locked_daily' };
  window.renderResultDocument(dailyMirror);
  assert.equal(document.querySelector('#resultDocument').textContent.includes('Süss fel, nap, fényes nap'), false);
  assert.equal(document.querySelectorAll('#resultDocument table.academic-process-table tbody tr').length, 4);
  assert.match(text(document.querySelector('#resultDocument .locked-boundary-text')), /1 részletes táblázat és 4 kidolgozott/);
});

// ---------- DOCX és PDF ----------

async function docxXml(window, docId = 'main') {
  window.docx = docxLib;
  const blob = await window.renderDocxBlob(docId);
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  return zip.file('word/document.xml').async('string');
}

const pageSize = (xml) => xml.match(/<w:pgSz [^>]*\/>/)[0];

test('the academic daily DOCX is portrait with real tables, shaded repeating header rows, italics and the bibliography', async (t) => {
  const window = await loadApp(t);
  window.renderResultDocument(academicDaily());
  const xml = await docxXml(window);
  assert.match(pageSize(xml), /w:w="11906"/);
  assert.match(pageSize(xml), /w:h="16838"/);
  assert.doesNotMatch(pageSize(xml), /landscape/);
  const tables = xml.split('<w:tbl>').slice(1);
  assert.equal(tables.length, 2, 'fejléctáblázat + kidolgozási táblázat');
  const process = tables[1];
  assert.equal((process.match(/<w:gridCol /g) || []).length, 3);
  assert.equal((process.match(/<w:tr>/g) || []).length, 5, 'fejlécsor + 4 sor');
  assert.match(process, /<w:tblHeader\/>/);
  assert.match(process, /w:fill="DCEFE6"/);
  assert.match(process, /w:color="444444" w:sz="4"/, 'vékony szegély');
  assert.doesNotMatch(process, /<w:cantSplit\/>/);
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /<w:b\/>/);
  for (const phrase of ['Foglalkozási/tevékenységi terv', 'Az óvodapedagógus neve', 'Nevelési feladatok:', 'Didaktikai feladatok:', 'Képesség- és készségfejlesztés:',
    'Szervezési feladatok:', 'Süss fel, nap, fényes nap,', 'Felhasznált irodalom:', 'Óvodai nevelés országos alapprogramja (ONAP)']) {
    assert.ok(xml.includes(phrase), phrase);
  }
  // A vers dőlt futása és a címke félkövér futása külön <w:r>.
  assert.match(xml, /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:i\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>Süss fel, nap, fényes nap,/);
  assert.match(xml, /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>Motiváció:/);
  // A cella bekezdései külön Word-bekezdések maradnak.
  assert.ok((process.match(/<w:p>/g) || []).length > 12);
  assert.equal(xml.includes('*'), false, 'nem maradhat nyers jelölőkarakter');
});

test('the thematic DOCX is landscape with a 7 column shaded header and tall rows allowed to break across pages', async (t) => {
  const window = await loadApp(t);
  window.docSettings = { main: { orientation: 'portrait', margin: 'comfortable' } };
  window.renderResultDocument(thematic());
  const xml = await docxXml(window);
  assert.match(pageSize(xml), /w:w="16838"/);
  assert.match(pageSize(xml), /w:h="11906"/);
  assert.match(pageSize(xml), /w:orient="landscape"/);
  const tables = xml.split('<w:tbl>').slice(1);
  const matrix = tables.find((table) => (table.match(/<w:gridCol /g) || []).length === 7);
  assert.ok(matrix, '7 oszlopos mátrix');
  assert.equal((matrix.match(/<w:tr>/g) || []).length, 2, 'fejlécsor + egy heti sor');
  assert.match(matrix, /<w:tblHeader\/>/);
  assert.equal((matrix.match(/w:fill="DCEFE6"/g) || []).length, 7);
  assert.doesNotMatch(matrix, /<w:cantSplit\/>/);
  assert.match(matrix, /<w:sz w:val="16"\/>/);
  for (const phrase of ['Tevékenységi területek', 'Verselés, mesélés', 'Mozgás / Testnevelés', 'Versek:', 'Énekes játék:', 'Zenehallgatás:', 'Weöres Sándor: Falevél (KEE 45.)',
    'Cél, - feladatrendszer:', 'Kiemelt fejlesztési terület:', 'Módszerek, eszközök:', 'Felhasznált irodalom:']) {
    assert.ok(xml.includes(phrase), phrase);
  }
  assert.match(xml, /<w:i\/>/);
});

test('the standard DOCX keeps its unshaded, non-italic tables', async (t) => {
  const window = await loadApp(t);
  const { makePlan } = require('./fixtures');
  window.renderResultDocument({ ...makePlan(4), request: makePayload() });
  const xml = await docxXml(window);
  assert.doesNotMatch(xml, /DCEFE6/);
  assert.doesNotMatch(xml, /<w:i\/>/);
  assert.match(xml, /<w:cantSplit\/>/);
  assert.match(pageSize(xml), /w:w="11906"/);
});

function stubPdfLibrary(window) {
  const calls = { options: [], pages: [], addPage: [], images: 0 };
  // A jsdom nem számol elrendezést; a PDF-export nulla méretű elemet elutasít.
  for (const property of ['offsetHeight', 'offsetWidth']) Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 100 });
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  window.html2pdf = () => {
    const chain = {
      set(options) { calls.options.push(options); return chain; },
      from(element) { calls.pages.push(element.innerHTML); return chain; },
      toPdf() { return chain; },
      toCanvas() { return chain; },
      get(name) {
        if (name === 'pdf') {
          return Promise.resolve({ internal: { getNumberOfPages: () => 1 }, deletePage() {}, addPage: (...args) => calls.addPage.push(args), addImage() { calls.images += 1; }, output: () => new window.Blob(['%PDF']) });
        }
        return Promise.resolve({ toDataURL: () => 'data:image/jpeg;base64,AA' });
      }
    };
    return chain;
  };
  return calls;
}

test('the PDF export uses portrait pages for the academic daily plan and landscape pages for the thematic plan', async (t) => {
  const window = await loadApp(t);
  const calls = stubPdfLibrary(window);

  window.renderResultDocument(academicDaily());
  const dailyBlob = await window.renderPdfBlob('main');
  assert.ok(dailyBlob.size > 0);
  assert.equal(calls.options.at(-1).jsPDF.orientation, 'portrait');
  const dailyPage = calls.pages.at(-1);
  assert.match(dailyPage, /class="official-table academic-table academic-process-table"/);
  assert.match(dailyPage, /<thead>/);
  assert.match(dailyPage, /<em>[^<]*Süss fel, nap/);
  assert.match(dailyPage, /<strong>Motiváció:<\/strong>/);
  assert.match(dailyPage, /Felhasznált irodalom:/);
  assert.match(dailyPage, /Foglalkozási\/tevékenységi terv/);

  window.renderResultDocument(thematic());
  await window.renderPdfBlob('main');
  assert.equal(calls.options.at(-1).jsPDF.orientation, 'landscape');
  assert.equal(calls.options.at(-1).jsPDF.format, 'a4');
  const matrixPage = calls.pages.at(-1);
  assert.equal((matrixPage.match(/<th>/g) || []).length, 7);
  assert.match(matrixPage, /<em>[^<]*Ég a gyertya, ég/);
  assert.match(matrixPage, /Felhasznált irodalom:/);
  assert.match(window.makePageElement('<p>x</p>', 'landscape', 12).style.cssText, /width:\s*297mm/);
});

test('the ZIP and the e-mail delivery keep a single PDF and DOCX for the thematic plan', async (t) => {
  const window = await loadApp(t);
  stubPdfLibrary(window);
  window.docx = docxLib;
  window.JSZip = JSZip;
  window.blobToBase64 = async () => 'AA'; // a jsdom FileReader nem olvassa a Node Blobját
  window.renderResultDocument(thematic());
  const files = await window.buildDeliveryFiles();
  assert.deepEqual(JSON.parse(JSON.stringify(files.map((file) => file.name))), ['tematikus-terv_2026-11-02.pdf', 'tematikus-terv_2026-11-02.docx']);
});

// ---------- Tördelés ----------

test('splitTallRow moves trailing blocks of the tallest column into a continuation row and keeps labels with their content', async (t) => {
  const window = await loadApp(t);
  const { document } = window;
  document.body.insertAdjacentHTML('beforeend', `<table id="fixture"><tbody><tr>
    <td><p>a1</p><p>a2</p><p class="cell-label">L</p><p>a3</p><p>a4</p></td>
    <td><div><p>b1</p><p>b2</p></div></td>
  </tr></tbody></table>`);
  const row = document.querySelector('#fixture tr');
  const first = row.cells[0];
  const tail = window.splitTallRow(row, () => first.children.length > 3);
  assert.deepEqual(Array.from(first.children).map(text), ['a1', 'a2']);
  assert.deepEqual(Array.from(tail.cells[0].children).map(text), ['L', 'a3', 'a4']);
  assert.deepEqual(Array.from(row.cells[1].querySelector('div').children).map(text), ['b1', 'b2']);
  assert.equal(tail.cells[1].querySelector('div').children.length, 0);
  assert.equal(window.splitTallRow(row, () => false), null);
});

// A jsdom nem számol elrendezést, ezért egy egyszerű blokkmagasság-modellel (1 bekezdés = 10 egység) fut a valódi tördelő.
function installFakeLayout(window) {
  const height = (element) => {
    if (['P', 'H2', 'H3', 'TH'].includes(element.tagName)) return 10;
    if (element.tagName === 'TR') return Math.max(0, ...Array.from(element.cells).map(height));
    return Array.from(element.children).reduce((sum, child) => sum + height(child), 0);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return height(this); } });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
      let top = 0;
      for (let node = this.previousElementSibling; node; node = node.previousElementSibling) top += height(node);
      return top;
    }
  });
}

test('an oversized thematic matrix row is split over several landscape pages with the header repeated and no content lost', async (t) => {
  const window = await loadApp(t);
  installFakeLayout(window);
  const response = makeThematicResponse();
  response.hetek[0].teruletek.verseles_meseles.versek = Array.from({ length: 45 }, (_, index) => `Szerző ${index + 1}: Vers ${index + 1} (KEE ${index + 1}.)`);
  response.hetek[0].teruletek.mozgas = Array.from({ length: 30 }, (_, index) => `Mozgásos játék ${index + 1}`);
  window.renderResultDocument(thematic(response));
  const host = window.document.querySelector('#resultDocument');
  const pages = Array.from(host.querySelectorAll('.a4-page'));
  assert.ok(pages.length >= 3, `várt legalább 3 lap, kapott: ${pages.length}`);
  const tables = Array.from(host.querySelectorAll('table.thematic-table'));
  assert.ok(tables.length >= 3, 'a mátrix folytatásai külön táblázatok');
  for (const table of tables) assert.equal(table.querySelectorAll('thead th').length, 7, 'a fejléc minden lapon ismétlődik');
  const joined = text(host);
  for (let index = 1; index <= 45; index += 1) assert.ok(joined.includes(`Vers ${index} (KEE ${index}.)`), `Vers ${index}`);
  for (let index = 1; index <= 30; index += 1) assert.ok(new RegExp(`Mozgásos játék ${index}(?!\\d)`).test(joined), `Mozgásos játék ${index}`);
  assert.equal(joined.split('Versek:').length - 1 >= 1, true);
  assert.equal(host.querySelectorAll('h3').length >= 5, true);
  const lastPage = pages[pages.length - 1];
  assert.match(text(lastPage), /Felhasznált irodalom:/);
});

test('an oversized daily table row is split the same way, while the standard single row table stays untouched', async (t) => {
  const window = await loadApp(t);
  installFakeLayout(window);
  const response = makeAcademicResponse();
  response.kidolgozas_tablazat[2].tevekenyseg_menete = Array.from({ length: 40 }, (_, index) => `Bekezdés ${index + 1}.`);
  window.renderResultDocument(academicDaily(response));
  const host = window.document.querySelector('#resultDocument');
  assert.ok(host.querySelectorAll('.a4-page').length >= 2);
  const joined = text(host);
  for (let index = 1; index <= 40; index += 1) assert.ok(new RegExp(`Bekezdés ${index}\\.`).test(joined), `Bekezdés ${index}`);

  const { makePlan } = require('./fixtures');
  const plan = makePlan(1);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = Array.from({ length: 40 }, (_, index) => `Szabvány bekezdés ${index + 1}.`);
  window.renderResultDocument({ ...plan, request: makePayload(), generationId: 'gen_standard' });
  const standardHost = window.document.querySelector('#resultDocument');
  assert.equal(standardHost.querySelectorAll('table').length, 1, 'a szabvány táblázat sora változatlanul egyben marad');
});
