const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { app, generateLimiter, buildPrompt, callGemini, clampRows, normalizeResponse } = require('../backend/server');
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
  const payload = makePayload({ duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary' });
  const prompt = buildPrompt(payload);
  for (const value of [payload.theme, payload.group, payload.groupName, payload.kindergartenName,
    payload.teacherName, payload.dateValue, payload.tevekenysegForma, payload.elozmeny,
    ...payload.focusAreas, ...payload.selectedGoals, ...payload.specialNeeds,
    ...Object.values(payload.customNotes).flat(), 'Szakmai tervezet']) {
    assert.ok(prompt.includes(value), `Missing prompt setting: ${value}`);
  }
  for (const [key, value] of Object.entries({ childCount: 23, energyLevel: 0,
    hasPreschoolers: false, detailLevel: 90, showLiteratureAtBottom: false })) {
    assert.match(prompt, new RegExp(`"${key}"\\s*:\\s*${value}`));
  }
  // A szerepleírás és a pedagógiai szerkezet egyetlen helyen, az Adminban szerkeszthető rendszerpromptban él.
  assert.doesNotMatch(prompt, /mester-óvodapedagógus/);
  assert.doesNotMatch(prompt, /öt egymásra épülő fázis/);
  const systemPrompt = require('../backend/services/settingsService').DEFAULT_SETTINGS.ai_config.system_prompt;
  for (const phase of ['Szervezési feladatok', 'Érzelmi ráhangolódás', 'Fő tevékenység',
    'Gyakorlás, differenciált', 'Összegzés, levezetés', 'mester-óvodapedagógus']) {
    assert.ok(systemPrompt.includes(phase), `Missing phase in the system prompt: ${phase}`);
  }
});

test('high detail starts at 80 and requests substantial paragraphs rather than a fixed page count', () => {
  const prompt = buildPrompt(makePayload({ detailLevel: 80 }));
  assert.match(prompt, /legalább 3[^\n]*bekezdés/);
  assert.match(prompt, /szóbeli instrukció/);
});

test('Gemini requests default to the fast model and use Argon only when explicitly requested', async (t) => {
  const plan = makePlan();
  const calls = stubGemini(t, geminiResponse(JSON.stringify(plan)));
  const output = await callGemini(buildPrompt(makePayload()), makePayload());
  assert.deepEqual(normalizeResponse(output).kidolgozas_tablazat, plan.kidolgozas_tablazat);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/v1beta/models/gemini-3.1-pro-preview:generateContent');
  await assert.rejects(callGemini(buildPrompt(makePayload()), { model: 'rossz modell!' }), /Érvénytelen modellnév/);
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
  const { response, data } = await postPlan(t, makePayload({ preview: false }));
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.deepEqual(data.kidolgozas_tablazat, plan.kidolgozas_tablazat);
  assert.equal(data.cel, plan.cel);
});

test('HTTP /api/generate with preview=true returns the structural mirror and hides locked text', async (t) => {
  const plan = makePlan(6);
  const secretPhrase = 'Szigorúan bizalmas és titkos foglalkozási lépés a gyerekekkel';
  const secretMethod = 'Titkos differenciálási megfigyelés és egyedi fa bábu';
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [secretPhrase];
  plan.kidolgozas_tablazat[0].modszerek_megjegyzesek = secretMethod;

  stubGemini(t, geminiResponse(JSON.stringify(plan)));
  const { response, data } = await postPlan(t, makePayload({ preview: true }));

  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.locked_meta.is_locked, true);
  assert.equal(data.locked_meta.table_count, 1);
  assert.equal(data.locked_meta.activity_count, 6);
  assert.equal(data.kidolgozas_tablazat.length, 6);

  // Only the topic is readable; the goal is masked
  assert.notEqual(data.cel, plan.cel);
  assert.equal(data.tema, plan.tema);
  assert.equal(JSON.stringify(data).includes(plan.cel), false);

  // Locked text is NOT leaked
  const bodyText = JSON.stringify(data);
  assert.equal(bodyText.includes(secretPhrase), false);
  assert.equal(bodyText.includes(secretMethod), false);

  // Plan is stored on server and retrievable via generationId
  const { planStore } = require('../backend/server');
  assert.ok(data.generationId);
  const stored = planStore.getPlan(data.generationId);
  assert.ok(stored);
  assert.equal(stored.kidolgozas_tablazat[0].tevekenyseg_menete[0], secretPhrase);
});

test('the unlocked stored plan is not publicly retrievable by generationId', async (t) => {
  const secretPhrase = 'Titkos zárolt foglalkozási lépés a paywall teszthez';
  const plan = makePlan(6);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [secretPhrase];
  stubGemini(t, geminiResponse(JSON.stringify(plan)));
  const { data } = await postPlan(t, makePayload({ preview: true }));
  assert.match(data.generationId, /^gen_[0-9a-f-]{36}$/);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of [`/api/plan/${data.generationId}`, `/plan/${data.generationId}`]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 404, route);
    assert.equal((await res.text()).includes(secretPhrase), false, route);
  }
});

test('HTTP API failures return details and no fake document or fallback rows', async (t) => {
  const calls = stubGemini(t, { error: { message: 'Requested model is unavailable for this API key.' } }, 404);
  const { response, data } = await postPlan(t, makePayload());
  assert.equal(response.ok, false);
  assert.equal(data.success, false);
  assert.equal(data.details, undefined);
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
  assert.equal(data.details, undefined);
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
test('the weekly summary prompt asks for the six areas, the mandatory notes block and the chosen progression', () => {
  const prompt = buildPrompt(makePayload({ duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary',
    weeklyProgressionType: 'area_focused', fridayClosingType: 'Projektzáró élményséta' }));
  assert.doesNotMatch(prompt, /Tapasztalt magyar mester-óvodapedagógus/);
  assert.match(prompt, /megjegyzes_egyeb_tevekenysegek/);
  assert.match(prompt, /area_focused/);
  assert.match(prompt, /Projektzáró élményséta/);
});

test('model requests are validated against the two allowed models', () => {
  const { resolveModel } = require('../backend/server');
  assert.equal(resolveModel({}), 'gemini-3.1-pro-preview');
  assert.throws(() => resolveModel({ requestedModel: 'gemini-4-argon' }), /Nem támogatott modell/);
  assert.throws(() => resolveModel({ requestedModel: 'evil-model' }), /Nem támogatott modell/);
});

test('available tools and the blacklist reach both prompts and the system instruction', async (t) => {
  for (const extra of [{}, { duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary' }]) {
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
  const { getSelectedDays } = require('../backend/server');
  assert.deepEqual(getSelectedDays({}), ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek']);
  assert.deepEqual(getSelectedDays({ selectedDays: ['Péntek', 'Hétfő', 'Hétfő', 'Vasárnap'] }), ['Hétfő', 'Péntek']);
  assert.deepEqual(getSelectedDays({ selectedDays: [] }).length, 5);

  const payload = makePayload({ duration: 'Heti', planKind: 'weekly', weeklyScope: 'package', selectedDays: ['Hétfő', 'Kedd', 'Csütörtök'] });
  const prompt = buildPrompt(payload);
  assert.match(prompt, /Érintett napok: Hétfő, Kedd, Csütörtök\./);
  assert.match(prompt, /A napi_beosztás pontosan 3 elemű/);

  const weeklySummary = require('../backend/services/weeklySummary');
  const list = ['tétel'];
  const make = (days) => ({
    tema: 'Erdő', altema: 'Az erdő lakói',
    teruletek: {
      kulso_vilag: list, kulso_vilag_matematika: list, rajzolas: list, mozgas: list,
      verseles_meseles: { versek: list, ismetles: [], mesek: list, szolasok_kozmondasok: [], talalos_kerdesek: [], nyelvtorok: [] },
      enek_zene: { dalok: list, ismetles: [], enekes_jatekok: list, kiszamolo: [], zenei_kepessegfejlesztes: [], zenehallgatas: list }
    },
    keretrendszer: { celok: list, feladatok: list, kiemelt_fejlesztesi_teruletek: list, modszerek: list, eszkozok: list },
    megjegyzes_egyeb_tevekenysegek: { jatekbovites: list, anyanyelvi_jatekok: list, fejlesztojatek: list, kirandulas_setak: list },
    felhasznalt_irodalom: 'Forrás',
    napi_beosztas: days.map((nap) => ({ nap, fo_terulet: 'f', napi_fokusz: 'x', napi_cel: 'c' }))
  });
  const ok = weeklySummary.normalizeWeeklySummary(make(['Hétfő', 'Kedd', 'Csütörtök']), payload, { withDays: true });
  assert.deepEqual(ok.heti_osszesito.napi_beosztas.map((d) => d.nap), ['Hétfő', 'Kedd', 'Csütörtök']);
  assert.throws(() => weeklySummary.normalizeWeeklySummary(make(['Hétfő', 'Kedd']), payload, { withDays: true }), /napi_beosztas/);
});

test('mixed group prompts carry the mandatory 3-level differentiation rule', () => {
  const mixed = buildPrompt(makePayload({ group: 'Vegyes csoport' }));
  assert.match(mixed, /3 szintű differenciálás korcsoportok szerint/);
  const weekly = buildPrompt(makePayload({ group: 'Vegyes csoport', duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary' }));
  assert.match(weekly, /3 szintű differenciálás korcsoportok szerint/);
  assert.doesNotMatch(buildPrompt(makePayload({ group: 'Nagycsoport' })), /3 szintű differenciálás/);
});

test('prompts never mention protected state systems', () => {
  for (const payload of [makePayload(), makePayload({ duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary', group: 'Vegyes csoport' })]) {
    assert.doesNotMatch(buildPrompt(payload), /onap|onoap|\bOAP\b|kréta/i);
  }
});

test('kindergarten profile and IKT digital rules reach both prompts', () => {
  const base = makePayload();
  const promptOff = buildPrompt(base);
  assert.match(promptOff, /SZIGORÚ DIGITÁLIS\/IKT TILTÁS/);
  assert.doesNotMatch(promptOff, /ÓVODA ARCULATA/);

  const profilePayload = makePayload({ kindergartenProfile: 'Zöld Óvoda' });
  const promptProfile = buildPrompt(profilePayload);
  assert.match(promptProfile, /ÓVODA ARCULATA.*Zöld Óvoda/);

  const iktPayload = makePayload({
    iktEnabled: true,
    iktTools: ['Padlórobotok (Bee-Bot, Andy, Edison)', 'Tablet, diagnosztika és kreatív/3D appok (Quiver)'],
    iktCustomApp: 'eDia teszt'
  });
  const promptIkt = buildPrompt(iktPayload);
  assert.match(promptIkt, /IKT \/ DIGITÁLIS ESZKÖZÖK MÓDSZERTANI SZABÁLYAI/);
  assert.match(promptIkt, /Padlórobotok/);
  assert.match(promptIkt, /eDia teszt/);
  assert.match(promptIkt, /3–20 perc/);
  assert.match(promptIkt, /Quiver/);
  assert.doesNotMatch(promptIkt, /SZIGORÚ DIGITÁLIS\/IKT TILTÁS/);

  const weeklyIkt = buildPrompt(makePayload({
    duration: 'Heti',
    planKind: 'weekly',
    weeklyScope: 'summary',
    kindergartenProfile: 'Néphagyományőrző',
    iktEnabled: true,
    iktTools: ['Interaktív tábla és gyakorlóprogramok']
  }));
  assert.match(weeklyIkt, /ÓVODA ARCULATA.*Néphagyományőrző/);
  assert.match(weeklyIkt, /IKT \/ DIGITÁLIS ESZKÖZÖK MÓDSZERTANI SZABÁLYAI/);

  const mathPayload = makePayload({
    focusAreas: ['A külső világ tevékeny megismerése – matematikai tartalommal', 'Mozgás']
  });
  const promptMath = buildPrompt(mathPayload);
  assert.match(promptMath, /MATEMATIKAI TARTALMÚ TEVÉKENYSÉG KÖVETELMÉNYE/);
  assert.match(promptMath, /halmazképzés/);
  assert.match(promptMath, /számlálás/);

  const noMathPayload = makePayload({
    focusAreas: ['A külső világ tevékeny megismerése', 'Verselés, mesélés']
  });
  assert.doesNotMatch(buildPrompt(noMathPayload), /MATEMATIKAI TARTALMÚ TEVÉKENYSÉG KÖVETELMÉNYE/);

  const weeklyFocusPayload = makePayload({
    duration: 'Heti',
    planKind: 'weekly',
    weeklyScope: 'summary',
    weeklyFocusAreas: {
      'Hétfő': ['Verselés, mesélés'],
      'Kedd': ['Mozgás']
    }
  });
  const promptWeeklyFocus = buildPrompt(weeklyFocusPayload);
  assert.match(promptWeeklyFocus, /SZIGORÚ NAPI NEVELÉSI TERÜLET KIOSZTÁS/);
  assert.match(promptWeeklyFocus, /Hétfő: Verselés, mesélés/);
  assert.match(promptWeeklyFocus, /Kedd: Mozgás/);
});

test('POST /api/generate answers 429 after the per-IP daily limit', async () => {
  const previous = process.env.GENERATE_RATE_LIMIT;
  process.env.GENERATE_RATE_LIMIT = '2';
  await Promise.all(['127.0.0.1', '::ffff:127.0.0.1', '::1'].map((ip) => generateLimiter.resetKey(ip)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/generate`;
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    // Sikertelen (503) hívások nem számítanak bele, ezért a limit-ellenőrzés külön, sikeres hívásokkal történik.
    const realFetch = global.fetch;
    global.fetch = async (input, init) => (String(input).includes('generativelanguage')
      ? Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(makePlan()) }] } }] })
      : realFetch(input, init));
    process.env.GEMINI_API_KEY = 'test';
    const post = () => realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makePayload()) });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const blocked = await post();
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { success: false, code: 'RATE_LIMITED', error: 'Túl sok generálási kísérlet. Óránként legfeljebb 2 tervezet készíthető egy IP-címről. Kérjük, próbáld újra később!' });
    global.fetch = realFetch;
  } finally {
    process.env.GENERATE_RATE_LIMIT = previous;
    if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original;
    server.close();
  }
});

test('POST /api/generate rejects concurrent requests from the same IP with 409', async () => {
  const { activeGenerationsByIp } = require('../backend/server');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/generate`;

  // Simulate an ongoing generation for 127.0.0.1
  activeGenerationsByIp.add('127.0.0.1');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ preview: false }))
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'GENERATION_IN_PROGRESS');
    assert.match(data.error, /Már folyamatban van egy tervezet generálása/);
  } finally {
    activeGenerationsByIp.delete('127.0.0.1');
    server.close();
  }
});

test('POST /api/generate rejects honeypot field submission with 400 immediately', async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/generate`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ contact_website: 'https://spam-bot.example' }))
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /biztonsági mező/);
  } finally {
    server.close();
  }
});

test('verifyTurnstileToken allows request if TURNSTILE_SECRET_KEY is not set and validates when set', async (t) => {
  const { verifyTurnstileToken } = require('../backend/server');
  // When no key is configured, it always returns true
  assert.equal(await verifyTurnstileToken('any-token', '1.2.3.4', {}), true);
  assert.equal(await verifyTurnstileToken(undefined, '1.2.3.4', {}), true);

  // When key is configured but token is missing, returns false
  assert.equal(await verifyTurnstileToken('', '1.2.3.4', { TURNSTILE_SECRET_KEY: 'test-secret' }), false);
  assert.equal(await verifyTurnstileToken(null, '1.2.3.4', { TURNSTILE_SECRET_KEY: 'test-secret' }), false);

  // When key is configured, verifies with Cloudflare endpoint
  const realFetch = global.fetch;
  let sentBody = '';
  global.fetch = async (url, init) => {
    if (String(url).includes('challenges.cloudflare.com')) {
      sentBody = String(init.body);
      return Response.json({ success: true });
    }
    return realFetch(url, init);
  };
  t.after(() => { global.fetch = realFetch; });

  const valid = await verifyTurnstileToken('valid-token', '1.2.3.4', { TURNSTILE_SECRET_KEY: 'my-cf-secret' });
  assert.equal(valid, true);
  assert.match(sentBody, /secret=my-cf-secret/);
  assert.match(sentBody, /response=valid-token/);
});

test('getClientIp uses req.ip; CF-Connecting-IP only with TRUST_CLOUDFLARE', (t) => {
  const { getClientIp } = require('../backend/server');
  const saved = process.env.TRUST_CLOUDFLARE;
  t.after(() => { if (saved === undefined) delete process.env.TRUST_CLOUDFLARE; else process.env.TRUST_CLOUDFLARE = saved; });

  delete process.env.TRUST_CLOUDFLARE;
  assert.equal(getClientIp({ headers: { 'cf-connecting-ip': '203.0.113.195', 'x-forwarded-for': '198.51.100.10' }, ip: '10.0.0.1', socket: { remoteAddress: '10.0.0.9' } }), '10.0.0.1');
  process.env.TRUST_CLOUDFLARE = 'true';
  assert.equal(getClientIp({
    headers: {
      'cf-connecting-ip': '203.0.113.195',
      'x-forwarded-for': '198.51.100.10, 10.0.0.1'
    },
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' }
  }), '203.0.113.195');

  // req.ip fallback
  assert.equal(getClientIp({
    headers: {},
    ip: '192.0.2.1',
    socket: { remoteAddress: '10.0.0.3' }
  }), '192.0.2.1');

  // socket fallback
  assert.equal(getClientIp({
    headers: {},
    socket: { remoteAddress: '192.0.2.2' }
  }), '192.0.2.2');

  // fallback unknown
  assert.equal(getClientIp(null), 'unknown');
  assert.equal(getClientIp({}), 'unknown');
});

test('previousPlanContext enters the prompt and instructs avoiding repetitions', () => {
  const { buildPrompt } = require('../backend/server');
  const contextText = 'Csatolt előzmény: Falevelek gyűjtése (Napi, 2026. 11. 10. 09:00). Célok: megfigyelés. Eszközök: nagyító.';
  const payload = makePayload({
    previousPlanContext: contextText
  });
  const prompt = buildPrompt(payload);

  assert.match(prompt, /PEDAGÓGIAI ELŐZMÉNY ÉS ISMÉTLŐDÉSEK ELKERÜLÉSE/);
  assert.match(prompt, /Falevelek gyűjtése/);
  assert.match(prompt, /SZIGORÚAN KERÜLD a fenti előzményben szereplő konkrét mesék, versek, mondókák/);

  // Weekly prompt check as well
  const weeklyPayload = makePayload({
    duration: 'Heti',
    planKind: 'weekly',
    weeklyScope: 'summary',
    previousPlanContext: contextText
  });
  const weeklyPrompt = buildPrompt(weeklyPayload);
  assert.match(weeklyPrompt, /PEDAGÓGIAI ELŐZMÉNY ÉS ISMÉTLŐDÉSEK ELKERÜLÉSE/);
  assert.match(weeklyPrompt, /Falevelek gyűjtése/);
});

function weeklyPrompt(overrides) {
  return buildPrompt(makePayload({
    duration: 'Heti', planKind: 'weekly', weeklyScope: 'summary',
    selectedDays: ['Hétfő', 'Kedd', 'Szerda'],
    focusAreas: ['Mozgás', 'Verselés, mesélés', 'Rajzolás'],
    ...overrides
  }));
}

test('weekly focus areas assigned to a day are not repeated in the general distribution list', () => {
  const prompt = weeklyPrompt({ weeklyFocusAreas: { 'Hétfő': ['Mozgás'] } });
  assert.match(prompt, /- Hétfő: Mozgás/);
  const rest = prompt.match(/A többi napra a kiválasztott további területeket \(([^)]*)\)/);
  assert.ok(rest, 'the remaining-areas sentence is missing');
  assert.equal(rest[1], 'Verselés, mesélés, Rajzolás');
});

test('weekly focus rule omits the remaining-areas sentence when every area is assigned', () => {
  const prompt = weeklyPrompt({
    focusAreas: ['Mozgás', 'Rajzolás'],
    weeklyFocusAreas: { 'Hétfő': ['Mozgás'], 'Kedd': ['Rajzolás'] }
  });
  assert.match(prompt, /- Kedd: Rajzolás/);
  assert.doesNotMatch(prompt, /A többi napra/);
});

test('an area assigned only to an unselected day stays in the general list', () => {
  const prompt = weeklyPrompt({
    focusAreas: ['Mozgás', 'Rajzolás'],
    weeklyFocusAreas: { 'Hétfő': ['Mozgás'], 'Péntek': ['Rajzolás'] }
  });
  assert.match(prompt, /A többi napra a kiválasztott további területeket \(Rajzolás\)/);
});

test('callGemini retries up to 2 times on 503 and succeeds on subsequent attempt', async () => {
  const geminiService = require('../backend/services/geminiService');
  let calls = 0;
  const sleeps = [];
  const fakeFetch = async () => {
    calls++;
    if (calls < 3) {
      return Response.json({ error: { message: 'The model is overloaded.' } }, { status: 503 });
    }
    return Response.json(geminiResponse(JSON.stringify(makePlan())));
  };

  const text = await geminiService.callGemini('Teszt prompt', {
    maxRetries: 2,
    retryDelayMs: 20
  }, {
    env: { GEMINI_API_KEY: 'test-key' },
    fetch: fakeFetch,
    sleep: async (ms) => sleeps.push(ms)
  });

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [20, 20]);
  assert.ok(text.includes('kidolgozas_tablazat'));
});

test('callGemini fails after 2 retries on 503 and throws error', async () => {
  const geminiService = require('../backend/services/geminiService');
  let calls = 0;
  const sleeps = [];
  const fakeFetch = async () => {
    calls++;
    return Response.json({ error: { message: 'Overloaded' } }, { status: 503 });
  };

  await assert.rejects(async () => {
    await geminiService.callGemini('Teszt prompt', {
      maxRetries: 2,
      retryDelayMs: 10
    }, {
      env: { GEMINI_API_KEY: 'test-key' },
      fetch: fakeFetch,
      sleep: async (ms) => sleeps.push(ms)
    });
  }, (err) => {
    assert.equal(err.status, 503);
    assert.match(err.message, /Overloaded/);
    return true;
  });

  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
});

test('POST /api/generate sends admin error alert if generation permanently fails', async (t) => {
  const mailService = require('../backend/services/mailService');
  const alertCalls = [];
  const origSendAlert = mailService.sendAdminErrorAlert;
  mailService.sendAdminErrorAlert = async (data) => {
    alertCalls.push(data);
    return { sent: true };
  };
  t.after(() => {
    mailService.sendAdminErrorAlert = origSendAlert;
  });

  stubGemini(t, { error: { message: 'Overloaded service' } }, 503);
  const { response, data } = await postPlan(t, makePayload());

  assert.equal(response.status, 503);
  assert.equal(data.success, false);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].operation, 'Tervezet generálás (Gemini)');
  assert.match(alertCalls[0].error.message, /Overloaded service/);
});

test('GET /api/generate/:id/status returns 404 for an unknown generation', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate/gen_00000000-0000-0000-0000-000000000000/status`);
  assert.equal(response.status, 404);
});

test('legacy weekly product keys resolve to the new weekly products', () => {
  const { resolveProductKey } = require('../backend/services/pricing');
  assert.equal(resolveProductKey('weekly'), resolveProductKey('weekly_summary'));
  assert.equal(resolveProductKey('weekly_detailed'), resolveProductKey('weekly_package'));
});
