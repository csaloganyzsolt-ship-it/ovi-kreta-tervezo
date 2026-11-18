const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { makePayload, makePlan, readPage } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const plannerHtml = readPage('tervezo.html');

async function loadPlanner(t) {
  const dom = new JSDOM(plannerHtml, {
    url: 'http://localhost:8000',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.APP_CONFIG = { paywallEnabled: true, apiBaseUrl: 'same-origin' };
    }
  });
  t.after(() => dom.window.close());
  dom.window.document.querySelector('.wizard-item[data-step="3"]').click();
  return dom.window;
}

const summaryLines = (window) => {
  window.renderSummaryChecklist();
  return Array.from(window.document.querySelectorAll('#summaryChecklist .summary-items div')).map((line) => line.textContent.replace(/^•\s*/, '').trim());
};
const setField = (window, selector, value) => {
  const field = window.document.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
};

// ---------- Összesítő képernyő ----------

test('the summary lists every selected setting of a standard plan and nothing that was retired', async (t) => {
  const window = await loadPlanner(t);
  setField(window, 'input[data-field="theme"]', 'Őszi erdő');
  setField(window, 'select[data-field="group"]', 'Középső csoport');
  setField(window, 'input[data-field="kindergarten-name"]', 'Napsugár Óvoda');
  setField(window, 'input[data-field="teacher-name"]', 'Kovács Eszter');
  const first = window.document.querySelector('[data-focus-area]');
  first.checked = true;
  const lines = summaryLines(window);
  const text = lines.join('\n');
  for (const expected of ['Tervezet típusa: Óvodai tervezet', 'Időtartam: Napi', 'Korcsoport: Középső csoport', 'Téma: Őszi erdő', `Nevelési területek: ${first.dataset.focusArea}`,
    'Óvoda: Napsugár Óvoda', 'Óvodapedagógus: Kovács Eszter', 'Gyereklétszám:', 'Speciális nevelési igények (SNI):', 'Kidolgozottság:', 'Tiltólista:', 'Előző tervezet csatolva: nem']) {
    assert.ok(text.includes(expected), `hiányzik az összesítőből: ${expected}`);
  }
  assert.doesNotMatch(text, /margó|margin|elrendezés|tájolás|orientation|oldalbeállítás|szakasz|Hallgató/i);
  assert.equal(lines.length, new Set(lines).size, 'nincs duplikált sor');
});

test('the summary shows the academic type with the student name, and the attached previous plan', async (t) => {
  const window = await loadPlanner(t);
  window.setPlanMode('academic');
  setField(window, 'input[data-field="student-name"]', 'Minta Mária');
  setField(window, 'input[data-field="theme"]', 'Az őszi gyümölcsök');
  let text = summaryLines(window).join('\n');
  assert.match(text, /Tervezet típusa: Oktatási célú tervezet/);
  assert.match(text, /Hallgató \/ Óvodapedagógus: Minta Mária/);
  assert.match(text, /Téma: Az őszi gyümölcsök/);

  window.setAttachedPreviousPlan({ id: 'h1', generationId: 'h1', theme: 'Tavaszi virágok', duration: 'Napi', savedAt: Date.UTC(2026, 3, 1), payload: makePayload() });
  text = Array.from(window.document.querySelectorAll('#summaryChecklist .summary-items div')).map((line) => line.textContent).join('\n');
  assert.match(text, /Előző tervezet csatolva: Tavaszi virágok/, 'a csatolás azonnal frissíti az összesítőt');
  window.clearAttachedPreviousPlan();
  assert.match(window.document.getElementById('summaryChecklist').textContent, /Előző tervezet csatolva: nem/);
});

// ---------- Kivezetett beállítások ----------

test('retired settings are gone from the client payload, the validator, the HTML and the CSS', async (t) => {
  const window = await loadPlanner(t);
  const payload = window.buildGenerationPayload();
  for (const key of ['outputMode', 'unlocked', 'includeLiterature', 'docSettings', 'margin', 'orientation', 'layout']) assert.equal(key in payload, false, key);
  const { validateGeneratePayload } = require('../services/generateValidation');
  const clean = validateGeneratePayload({ ...payload, outputMode: 'x', unlocked: true, includeLiterature: true, docSettings: { margin: 1 } });
  for (const key of ['outputMode', 'unlocked', 'includeLiterature', 'docSettings']) assert.equal(key in clean, false, `a validátor eldobja: ${key}`);
  assert.equal(clean.preview, undefined);
  assert.equal(validateGeneratePayload({ ...payload, preview: true }).preview, true);

  const sources = ['server.js', 'routes/payment.js', 'services/mailService.js', 'services/generateValidation.js', 'tervezo-core.js', 'tervezo-form.js', 'tervezo-paywall.js', 'tervezo-generate.js', 'tervezo-init.js', 'tervezo.html', 'styles.css', 'scripts/build-pages.js']
    .map((file) => [file, read(file)]);
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /isFreeTestOrigin|FREE_TEST_ORIGINS|testDeliver|test-deliver|TEST_DELIVERY|sendTestDelivery|docSettings|export-settings|setting-option|setting-row|exportSection|includeLiterature\b/, file);
  }
  assert.doesNotMatch(read('tervezo-form.js') + read('tervezo-generate.js') + read('tervezo-paywall.js'), /\boutputMode\b/);
});

// ---------- Egységes dokumentummodell ----------

test('the web view, the PDF and the DOCX are all built from the same buildDocumentHtml and buildExportModel', async (t) => {
  const exportSource = read('tervezo-export.js');
  const body = (name) => {
    const start = exportSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const next = exportSource.indexOf('\nfunction ', start + 10);
    const nextAsync = exportSource.indexOf('\nasync function ', start + 10);
    return exportSource.slice(start, Math.min(...[next, nextAsync].filter((i) => i > 0)));
  };
  const asyncBody = (name) => {
    const start = exportSource.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    const rest = exportSource.slice(start + 10);
    const end = rest.search(/\n(async )?function /);
    return rest.slice(0, end);
  };
  assert.match(body('buildExportModel'), /buildDocumentHtml\(/);
  assert.match(body('buildPdfDefinition'), /buildExportModel\(/);
  assert.match(asyncBody('renderPdfBlob'), /buildPdfDefinition\(/);
  assert.match(asyncBody('renderDocxBlob'), /buildExportModel\(/);
  assert.match(read('tervezo-preview.js'), /resultDocument\.innerHTML = buildDocumentHtml\(/);
  // Más helyen nem épül dokumentum a HTML-ből: a ZIP és a kézbesítés is ugyanezeket a renderelőket hívja.
  const callers = ['tervezo-export.js', 'tervezo-paywall.js'].map(read).join('\n');
  assert.equal((callers.match(/buildExportModel\(/g) || []).length, 3, 'a modellt csak a definíció, a PDF-definíció és a DOCX hívja');

  const window = await loadPlanner(t);
  const result = { ...makePlan(8), request: makePayload(), generationId: 'gen_unity', locked_meta: undefined };
  window.unlockGeneration('gen_unity');
  window.renderResultDocument(result);
  const model = window.buildExportModel(window.getDocumentList(result)[0].id);
  const dom = window.document.getElementById('resultDocument');
  assert.equal(model.title, dom.querySelector('h2').textContent.trim(), 'ugyanaz a cím a webes nézetben és az exportban');
  const modelRows = model.blocks.filter((block) => block.type === 'table').reduce((total, block) => total + block.rows.length, 0);
  assert.equal(modelRows, dom.querySelectorAll('.official-table tbody tr').length, 'ugyanannyi táblázatsor');
});
