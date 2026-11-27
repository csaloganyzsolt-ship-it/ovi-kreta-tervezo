'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { makePayload, makeAcademicPayload, makeThematicPayload } = require('./fixtures');
const { buildPrompt } = require('../backend/server');
const academicPlan = require('../backend/services/academicPlan');
const geminiService = require('../backend/services/geminiService');
const defaultSystemPrompt = require('../backend/services/defaultSystemPrompt');
const { LITERATURE_PRIORITY_RULE } = require('../backend/services/literatureRules');

const ROLE_ESSAY = /mester-óvodapedagógus vagy|szakmódszertani oktató|öt egymásra épülő fázis|Szigorú pedagógiai szabály|Ne használj elcsépelt/;

const weekly = () => makePayload({ duration: 'Heti', planMode: 'standard', planKind: 'weekly', weeklyScope: 'summary' });
const prompts = () => ({
  daily: buildPrompt(makePayload()),
  weekly: buildPrompt(weekly()),
  academicDaily: buildPrompt(makeAcademicPayload()),
  thematic: buildPrompt(makeThematicPayload())
});

test('the code-side user prompts do not duplicate the role or the pedagogical essays of the admin system prompt', () => {
  for (const [name, prompt] of Object.entries(prompts())) {
    assert.doesNotMatch(prompt, ROLE_ESSAY, name);
    assert.match(prompt, /A szerepet.*a rendszerutasítás tartalmazza/, `${name}: a prompt a rendszerutasításra utal`);
  }
});

test('the code-side prompts keep the request data, the plan type and the JSON schema', () => {
  const all = prompts();
  const payload = makePayload();
  for (const value of [payload.theme, payload.group, 'kidolgozas_tablazat']) assert.ok(all.daily.includes(value), `daily: ${value}`);
  assert.match(all.weekly, /megjegyzes_egyeb_tevekenysegek/);
  assert.match(all.weekly, /hat nevelési terület/);
  assert.match(all.academicDaily, /"kidolgozas_tablazat"/);
  assert.match(all.thematic, /"hetek"/);
});

test('the literature switch state is passed to the daily and weekly prompts', () => {
  for (const make of [() => makePayload(), weekly]) {
    const on = buildPrompt({ ...make(), showLiteratureAtBottom: true });
    const off = buildPrompt({ ...make(), showLiteratureAtBottom: false });
    assert.match(on, /Szakirodalom-kapcsoló \(showLiteratureAtBottom\): BEKAPCSOLVA/);
    assert.match(off, /Szakirodalom-kapcsoló \(showLiteratureAtBottom\): KIKAPCSOLVA[^\n]*üres szöveg/);
  }
});

test('the default system prompt carries the strict Hungarian-only, no-invention literature rules', () => {
  for (const needle of [
    'KIZÁRÓLAG magyar nyelvű, valóban létező',
    'Weöres Sándor', 'Lázár Ervin',
    'SZIGORÚAN TILOS bármilyen idegen nyelvű (francia, latin, angol, német',
    'kifejezetten idegen nyelvű foglalkozást',
    'hivatalos magyar fordításban',
    'SOHA ne találj ki fiktív verset, mesét, költőt, szerzőt, kötetet, kiadót, évszámot vagy oldalszámot',
    'saját ötletnek',
    'felhasznalt_irodalom listába kizárólag'
  ]) assert.ok(defaultSystemPrompt.includes(needle), needle);
  assert.ok(defaultSystemPrompt.length < 8000, 'belefér az admin 8000 karakteres promptkorlátjába');
});

test('SOURCE_RULES and the Gemini system instruction repeat the Hungarian-source priority rule', async () => {
  assert.match(LITERATURE_PRIORITY_RULE, /minden más utasítást megelőz/);
  for (const prompt of [prompts().academicDaily, prompts().thematic]) assert.ok(prompt.includes(LITERATURE_PRIORITY_RULE));
  assert.ok(academicPlan.buildAcademicPrompt);

  let sent;
  const body = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] });
  await geminiService.callGemini('kérés', { systemPrompt: 'ADMIN PROMPT' }, {
    env: { GEMINI_API_KEY: 'k' },
    fetch: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, status: 200, text: async () => body }; }
  });
  const instruction = sent.systemInstruction.parts[0].text;
  assert.ok(instruction.startsWith('ADMIN PROMPT'), 'az admin prompt kerül a rendszerutasítás elejére');
  assert.ok(instruction.includes(LITERATURE_PRIORITY_RULE), 'a magyar forrás szabály a rendszerutasítás végén is szerepel');
  assert.ok(instruction.indexOf('ADMIN PROMPT') < instruction.indexOf(LITERATURE_PRIORITY_RULE));
});

test('the literature migration only upgrades the untouched old default prompt and matches the code default', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261202090000_literature_rules_prompt.sql'), 'utf8');
  const crypto = require('node:crypto');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261126110000_update_real_settings.sql'), 'utf8').match(/\$prompt\$([\s\S]*?)\$prompt\$/)[1];
  assert.match(sql, new RegExp(`md5\\(value ->> 'system_prompt'\\) = '${crypto.createHash('md5').update(seed).digest('hex')}'`));
  const rules = sql.match(/\$rules\$([\s\S]*?)\$rules\$/)[1];
  assert.equal(`${seed}\n\n${rules}`, defaultSystemPrompt);
});
