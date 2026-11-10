const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { app, buildPrompt, callGemini, clampRows, normalizeResponse } = require('../server');
const { makePayload, makePlan } = require('./fixtures');

function stubGemini(t, body, status = 200) {
  const realFetch = global.fetch;
  const savedKey = process.env.GEMINI_API_KEY;
  const savedModel = process.env.GEMINI_MODEL;
  const calls = [];
  process.env.GEMINI_API_KEY = 'local-test-key';
  process.env.GEMINI_MODEL = 'must-not-override-the-requested-model';
  global.fetch = async (url, options) => {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') {
      return realFetch(url, options);
    }
    calls.push({ url: String(url), options });
    return Response.json(body, { status });
  };
  t.after(() => {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
  });
  return calls;
}

function geminiResponse(text, finishReason = 'STOP') {
  return {
    candidates: [{ finishReason, content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 2400, totalTokenCount: 3000 }
  };
}

async function postPlan(t, payload) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { response, data: await response.json() };
}

test('clampRows preserves every valid row, its paragraphs, and repeated method prefixes', () => {
  const rows = makePlan(8).kidolgozas_tablazat;
  assert.deepEqual(clampRows(rows), rows);
});

test('normalizeResponse accepts parsed JSON objects without reparsing them as strings', () => {
  const plan = makePlan();
  const result = normalizeResponse(plan, makePayload());
  assert.deepEqual(result.kidolgozas_tablazat, plan.kidolgozas_tablazat);
  assert.deepEqual(result.modszerek, plan.modszerek);
});

test('normalization never truncates valid rows, even at low detail', () => {
  const plan = makePlan(8);
  const result = normalizeResponse(JSON.stringify(plan), makePayload({ detailLevel: 0 }));
  assert.deepEqual(result.kidolgozas_tablazat, plan.kidolgozas_tablazat);
});

test('legacy string activities become paragraphs without losing line breaks', () => {
  const plan = makePlan();
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = 'Első bekezdés.\n\nMásodik bekezdés.\nInstrukció.';
  const result = normalizeResponse(plan, makePayload());
  assert.deepEqual(result.kidolgozas_tablazat[0].tevekenyseg_menete,
    ['Első bekezdés.', 'Második bekezdés.\nInstrukció.']);
});

test('invalid or incomplete model output fails instead of supplying invented content', () => {
  for (const invalid of ['not JSON', '{}', '[]', 'null', '```json\n{}\n```']) {
    assert.throws(() => normalizeResponse(invalid, makePayload()));
  }
  const missingGoal = makePlan();
  delete missingGoal.cel;
  assert.throws(() => normalizeResponse(missingGoal), /cel/);
  const missingNotes = makePlan();
  delete missingNotes.kidolgozas_tablazat[1].modszerek_megjegyzesek;
  assert.throws(() => normalizeResponse(missingNotes), /modszerek_megjegyzesek/);
  const missingTime = makePlan();
  delete missingTime.kidolgozas_tablazat[0].ido;
  assert.throws(() => normalizeResponse(missingTime), /ido/);
  const invalidParagraph = makePlan();
  invalidParagraph.kidolgozas_tablazat[0].tevekenyseg_menete = [{}];
  assert.throws(() => normalizeResponse(invalidParagraph), /tevekenyseg_menete/);
});

test('the explicit literature setting stays false even when the model supplies sources', () => {
  const result = normalizeResponse(JSON.stringify(makePlan()), makePayload());
  assert.equal(result.showLiteratureAtBottom, false);
});

test('empty or missing history and literature are normalized as empty strings instead of blocking generation', () => {
  const plan = { ...makePlan(), elozmeny: '', felhasznalt_irodalom: '' };
  const result = normalizeResponse(plan, makePayload({ elozmeny: '' }));
  assert.equal(result.elozmeny, '');
  assert.equal(result.felhasznalt_irodalom, '');

  delete plan.elozmeny;
  const missingHistory = normalizeResponse(plan, makePayload({ elozmeny: undefined }));
  assert.equal(missingHistory.elozmeny, '');

  delete plan.felhasznalt_irodalom;
  const missingLiterature = normalizeResponse(plan, makePayload({ elozmeny: '' }));
  assert.equal(missingLiterature.felhasznalt_irodalom, '');
});

test('the concise pedagogical prompt includes all real settings and every custom note', () => {
  const payload = makePayload({ duration: 'Heti', planMode: 'weekly', includeDailyBreakdown: true });
  const prompt = buildPrompt(payload);
  for (const value of [payload.theme, payload.group, payload.groupName, payload.kindergartenName,
    payload.teacherName, payload.dateValue, payload.tevekenysegForma, payload.elozmeny,
    ...payload.focusAreas, ...payload.selectedGoals, ...payload.specialNeeds,
    ...Object.values(payload.customNotes).flat(), payload.outputMode]) {
    assert.ok(prompt.includes(value), `Missing prompt setting: ${value}`);
  }
  for (const [key, value] of Object.entries({ childCount: 23, energyLevel: 0,
    hasPreschoolers: false, detailLevel: 90, includeDailyBreakdown: true, showLiteratureAtBottom: false })) {
    assert.match(prompt, new RegExp(`"${key}"\\s*:\\s*${value}`));
  }
  assert.match(prompt, /mester-óvodapedagógus/);
  assert.match(prompt, /óvodapedagógiai irányelv/);
  for (const phase of ['Szervezési feladatok', 'Érzelmi ráhangolódás', 'Fő tevékenység',
    'Gyakorlás, differenciált', 'Összegzés, levezetés']) {
    assert.ok(prompt.includes(phase), `Missing phase: ${phase}`);
  }
});

test('high detail starts at 80 and requests substantial paragraphs rather than a fixed page count', () => {
  const prompt = buildPrompt(makePayload({ detailLevel: 80 }));
  assert.match(prompt, /legalább 3[^\n]*bekezdés/);
  assert.match(prompt, /szóbeli instrukció/);
  assert.match(prompt, /közkincs|népköltészeti/);
});

test('Gemini requests default to the fast model and use Argon only when explicitly requested', async (t) => {
  const plan = makePlan();
  const calls = stubGemini(t, geminiResponse(JSON.stringify(plan)));
  const output = await callGemini(buildPrompt(makePayload()), makePayload());
  assert.deepEqual(normalizeResponse(output).kidolgozas_tablazat, plan.kidolgozas_tablazat);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v1beta/models/gemini-3.1-pro-preview:generateContent');
  await assert.rejects(callGemini(buildPrompt(makePayload()), { model: 'gemini-4-argon' }), /Nem támogatott modell/);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.maxOutputTokens >= 12288);
  assert.equal(body.generationConfig.responseSchema, undefined);
});

test('Gemini thought parts are not mixed into JSON and split text is joined without corruption', async (t) => {
  const json = JSON.stringify(makePlan());
  const envelope = geminiResponse(json);
  envelope.candidates[0].content.parts = [
    { thought: true, text: 'Internal analysis is not the document.' },
    { text: json.slice(0, 40) }, { text: json.slice(40) }
  ];
  stubGemini(t, envelope);
  const output = await callGemini(buildPrompt(makePayload()));
  assert.equal(normalizeResponse(output).tema, makePlan().tema);
});

test('a MAX_TOKENS finish is reported even if the remaining JSON happens to parse', async (t) => {
  stubGemini(t, geminiResponse(JSON.stringify(makePlan()), 'MAX_TOKENS'));
  await assert.rejects(() => callGemini(buildPrompt(makePayload())), /MAX_TOKENS|token/i);
});

test('the real HTTP generation route returns the actual model rows', async (t) => {
  const plan = makePlan();
  stubGemini(t, geminiResponse(JSON.stringify(plan)));
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.deepEqual(data.kidolgozas_tablazat, plan.kidolgozas_tablazat);
  assert.equal(data.cel, plan.cel);
});

test('HTTP API failures return details and no fake document or fallback rows', async (t) => {
  const calls = stubGemini(t, { error: { message: 'Requested model is unavailable for this API key.' } }, 404);
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.ok, false);
  assert.equal(data.success, false);
  assert.match(data.details, /Requested model is unavailable/);
  assert.equal(data.kidolgozas_tablazat, undefined);
  assert.equal(calls.length, 1);
});

test('HTTP rejects malformed model JSON and incomplete tables', async (t) => {
  stubGemini(t, geminiResponse('{"kidolgozas_tablazat": []}'));
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.ok, false);
  assert.equal(data.success, false);
  assert.equal(data.kidolgozas_tablazat, undefined);
});

test('HTTP rejects syntactically invalid generated JSON, not just missing fields', async (t) => {
  stubGemini(t, geminiResponse('{"tema": "unfinished'));
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.status, 502);
  assert.equal(data.success, false);
  assert.match(data.details, /JSON/);
  assert.equal(data.kidolgozas_tablazat, undefined);
});

test('blocked generation reports its reason instead of treating an empty answer as a document', async (t) => {
  stubGemini(t, { promptFeedback: { blockReason: 'SAFETY' } });
  await assert.rejects(() => callGemini(buildPrompt(makePayload())), /SAFETY/);
});

test('quota errors preserve their HTTP status and are not retried on a different model', async (t) => {
  const calls = stubGemini(t, { error: { message: 'Quota exceeded' } }, 429);
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.status, 429);
  assert.match(data.details, /Quota exceeded/);
  assert.equal(calls.length, 1);
});
test('weekly breakdown uses the weekly master prompt and 16384 output tokens', () => {
  const prompt = buildPrompt(makePayload({ duration: 'Heti', planMode: 'weekly', includeDailyBreakdown: true,
    weeklyProgressionType: 'area_focused', fridayClosingType: 'Projektzáró élményséta' }));
  assert.match(prompt, /óvodapedagógiai irányelv/);
  assert.match(prompt, /heti_keretterv/);
  assert.match(prompt, /area_focused/);
  assert.match(prompt, /Projektzáró élményséta/);
});

test('model requests are validated against the two allowed models', () => {
  const { resolveModel } = require('../server');
  assert.equal(resolveModel({}), 'gemini-3.1-pro-preview');
  assert.throws(() => resolveModel({ requestedModel: 'gemini-4-argon' }), /Nem támogatott modell/);
  assert.throws(() => resolveModel({ requestedModel: 'evil-model' }), /Nem támogatott modell/);
});

test('available tools and the blacklist reach both prompts and the system instruction', async (t) => {
  for (const extra of [{}, { duration: 'Heti', planMode: 'weekly', includeDailyBreakdown: true }]) {
    const prompt = buildPrompt(makePayload({ ...extra, availableTools: 'xilofon, nagy labda', blacklist: 'gyurma, Süss fel nap' }));
    assert.match(prompt, /xilofon, nagy labda/);
    assert.match(prompt, /SZIGORÚ TILTÁS/);
    assert.match(prompt, /gyurma, Süss fel nap/);
  }
  assert.match(buildPrompt(makePayload()), /óvodákban általánosan megtalálható/);
  assert.doesNotMatch(buildPrompt(makePayload()), /SZIGORÚ TILTÁS/);
  const calls = stubGemini(t, geminiResponse(JSON.stringify(makePlan())));
  await callGemini('x', { blacklist: 'gyurma' });
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.systemInstruction.parts[0].text, /SZIGORÚ TILTÁS.*gyurma/s);
});

test('weekly generation covers only the selected days in prompt and response validation', () => {
  const { getSelectedDays } = require('../server');
  assert.deepEqual(getSelectedDays({}), ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek']);
  assert.deepEqual(getSelectedDays({ selectedDays: ['Péntek', 'Hétfő', 'Hétfő', 'Vasárnap'] }), ['Hétfő', 'Péntek']);
  assert.deepEqual(getSelectedDays({ selectedDays: [] }).length, 5);

  const payload = makePayload({ duration: 'Heti', planMode: 'weekly', includeDailyBreakdown: true, selectedDays: ['Hétfő', 'Kedd', 'Csütörtök'] });
  const prompt = buildPrompt(payload);
  assert.match(prompt, /pontosan 3 elem, ebben a sorrendben: Hétfő, Kedd, Csütörtök/);
  assert.match(prompt, /nem kiválasztott napokra NEM készítesz/);
  assert.doesNotMatch(prompt, /pontosan 5 elem/);

  const row = { ido: '10 perc', tevekenyseg_menete: ['Bekezdés'], modszerek_megjegyzesek: 'Megjegyzés' };
  const make = (days) => JSON.stringify({
    is_weekly: true,
    summary: 's',
    heti_keretterv: {
      tema: 'Erdő', heti_fo_cel: 'c', nevelesi_feladatok: 'n', didaktikai_feladatok: 'd',
      teruletek_heti_eloszlasa: days.map((nap) => ({ nap, fo_terulet: 'f', mikrocsoportos_tevekenyseg: 'm' })),
      eszkozok: ['papír'], felhasznalt_irodalom: ''
    },
    napok: days.map((nap_neve) => ({ nap_neve, tevekenyseg_forma: 'játék', napi_cel: 'cél', kidolgozas_tablazat: [row] }))
  });
  const ok = normalizeResponse(make(['Hétfő', 'Kedd', 'Csütörtök']), payload);
  assert.equal(ok.napok.length, 3);
  assert.deepEqual(ok.napok.map((d) => d.nap_neve), ['Hétfő', 'Kedd', 'Csütörtök']);
  assert.throws(() => normalizeResponse(make(['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek']), payload), /kiválasztott 3 napot/);
  assert.throws(() => normalizeResponse(make(['Hétfő']), payload), /kiválasztott 3 napot/);
});

test('mixed group prompts carry the mandatory 3-level differentiation rule', () => {
  const mixed = buildPrompt(makePayload({ group: 'Vegyes csoport' }));
  assert.match(mixed, /3 szintű differenciálás korcsoportok szerint/);
  const weekly = buildPrompt(makePayload({ group: 'Vegyes csoport', duration: 'Heti', includeDailyBreakdown: true }));
  assert.match(weekly, /3 szintű differenciálás korcsoportok szerint/);
  assert.doesNotMatch(buildPrompt(makePayload({ group: 'Nagycsoport' })), /3 szintű differenciálás/);
});

test('prompts never mention protected state systems', () => {
  for (const payload of [makePayload(), makePayload({ duration: 'Heti', includeDailyBreakdown: true, group: 'Vegyes csoport' })]) {
    assert.doesNotMatch(buildPrompt(payload), /onap|onoap|\bOAP\b|kréta/i);
  }
});
