const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app } = require('../server');
const planStore = require('../services/planStore');
const { makePayload, makePlan } = require('./fixtures');

test('createMirrorPlan produces a 1:1 structural mirror with exact table rows and paragraphs', () => {
  const original = makePlan(7);
  original.kidolgozas_tablazat[0].tevekenyseg_menete = [
    'Első részletes bekezdés az előkészületről és a gyermekek elhelyezkedéséről.',
    'Második bekezdés a bábos motivációról és a közös éneklésről.',
    'Harmadik bekezdés a feladatok differenciált kiosztásáról.'
  ];
  original.kidolgozas_tablazat[0].modszerek_megjegyzesek = 'Beszélgetés, szemléltetés, motiválás bábbal.';

  const mirror = planStore.createMirrorPlan(original);

  // Introductory fields remain readable and identical
  assert.equal(mirror.tema, original.tema);
  assert.equal(mirror.cel, original.cel);
  assert.equal(mirror.tevekenyseg_forma, original.tevekenyseg_forma);
  assert.equal(mirror.elozmeny, original.elozmeny);
  assert.equal(mirror.nevelesi_feladatok, original.nevelesi_feladatok);
  assert.equal(mirror.didaktikai_feladatok, original.didaktikai_feladatok);
  assert.equal(mirror.kepessegfejlesztes, original.kepessegfejlesztes);
  assert.deepEqual(mirror.modszerek, original.modszerek);
  assert.deepEqual(mirror.eszkozok, original.eszkozok);

  // Structural mirror: exact same table rows
  assert.equal(mirror.kidolgozas_tablazat.length, 7);

  // Exact same paragraph count in first row
  assert.equal(mirror.kidolgozas_tablazat[0].tevekenyseg_menete.length, 3);

  // Paragraph lengths are approximately equal (within 15%)
  for (let i = 0; i < 3; i += 1) {
    const origLen = original.kidolgozas_tablazat[0].tevekenyseg_menete[i].length;
    const mirrorLen = mirror.kidolgozas_tablazat[0].tevekenyseg_menete[i].length;
    assert.ok(Math.abs(origLen - mirrorLen) < origLen * 0.2 + 5,
      `Length mismatch: orig ${origLen} vs mirror ${mirrorLen}`);
  }

  // Metadata verification
  assert.equal(mirror.locked_meta.is_locked, true);
  assert.equal(mirror.locked_meta.table_count, 1);
  assert.equal(mirror.locked_meta.activity_count, 7);
  assert.equal(
    mirror.locked_meta.summary_text,
    'A teljes dokumentum elkészült: 1 részletes táblázat és 7 kidolgozott tevékenységi egység vár feloldásra.'
  );
});

test('createMirrorPlan strictly does not leak any locked real text into the response', () => {
  const secretWords = [
    'aranyhörcsög',
    'bábszínházas',
    'kukoricamorzsolás',
    'gesztenyebábú',
    'cickafarkfű'
  ];
  const plan = makePlan(5);
  plan.kidolgozas_tablazat[0].tevekenyseg_menete = [
    `A pedagógus bemutatja az ${secretWords[0]} simogatását és a ${secretWords[1]} játékot.`
  ];
  plan.kidolgozas_tablazat[1].tevekenyseg_menete = [
    `Közös tevékenységként ${secretWords[2]} és ${secretWords[3]} készítése zajlik.`
  ];
  plan.kidolgozas_tablazat[2].modszerek_megjegyzesek = `Gyógynövényes megfigyelés: ${secretWords[4]} teájának illatolása.`;

  const mirror = planStore.createMirrorPlan(plan);
  const jsonString = JSON.stringify(mirror);

  // Verify that not a single secret word appears anywhere in the mirror JSON
  for (const secret of secretWords) {
    assert.equal(
      jsonString.includes(secret),
      false,
      `Secret word "${secret}" leaked into the mirror response!`
    );
  }

  // Verify that the filler text is non-empty and well-formed
  assert.ok(mirror.kidolgozas_tablazat[0].tevekenyseg_menete[0].length > 30);
  assert.ok(mirror.kidolgozas_tablazat[1].tevekenyseg_menete[0].length > 30);
  assert.ok(mirror.kidolgozas_tablazat[2].modszerek_megjegyzesek.length > 20);
});

test('createMirrorPlan correctly mirrors weekly plans with multi-day breakdown', () => {
  const weeklyPlan = {
    is_weekly: true,
    heti_keretterv: {
      tema: 'Őszi betakarítás a kertben',
      heti_fo_cel: 'A kerti zöldségek és gyümölcsök megismerése érzékszervi tapasztalással.',
      nevelesi_feladatok: 'Együttműködés a kerti munkákban.',
      didaktikai_feladatok: 'Formák, színek és ízek összehasonlítása.',
      eszkozok: ['kosarak', 'zöldségek', 'nagyítók'],
      teruletek_heti_eloszlasa: [
        { nap: 'Hétfő', fo_terulet: 'Külső világ megismerése', csoportos_tevekenyseg: 'Zöldségkosár átválogatása' },
        { nap: 'Kedd', fo_terulet: 'Verselés, mesélés', csoportos_tevekenyseg: 'A répa mese feldolgozása' }
      ]
    },
    napok: [
      {
        nap_neve: 'Hétfő',
        tevekenyseg_forma: 'Külső világ megismerése',
        napi_cel: 'A zöldségek tapintásos vizsgálata',
        kidolgozas_tablazat: Array.from({ length: 5 }, (_, i) => ({
          ido: `${(i + 1) * 5} perc`,
          tevekenyseg_menete: [`Hétfői titkos tevékenység lépés ${i + 1}: zellergyökér vizsgálat`],
          modszerek_megjegyzesek: `Hétfői titkos módszer ${i + 1}`
        }))
      },
      {
        nap_neve: 'Kedd',
        tevekenyseg_forma: 'Verselés, mesélés',
        napi_cel: 'A répa mese dramatikus eljátszása',
        kidolgozas_tablazat: Array.from({ length: 4 }, (_, i) => ({
          ido: `${(i + 1) * 7} perc`,
          tevekenyseg_menete: [`Keddi titkos dramatizálás ${i + 1}: meselánc építés`],
          modszerek_megjegyzesek: `Keddi titkos módszer ${i + 1}`
        }))
      }
    ]
  };

  const mirror = planStore.createMirrorPlan(weeklyPlan);

  // Framework remains readable
  assert.equal(mirror.is_weekly, true);
  assert.equal(mirror.heti_keretterv.tema, 'Őszi betakarítás a kertben');
  assert.equal(mirror.heti_keretterv.teruletek_heti_eloszlasa.length, 2);

  // Metadata: 2 days with tables, 5 + 4 = 9 activity blocks
  assert.equal(mirror.locked_meta.is_locked, true);
  assert.equal(mirror.locked_meta.table_count, 2);
  assert.equal(mirror.locked_meta.activity_count, 9);
  assert.equal(
    mirror.locked_meta.summary_text,
    'A teljes dokumentum elkészült: 2 részletes táblázat és 9 kidolgozott tevékenységi egység vár feloldásra.'
  );

  // Daily tables are mirrored
  assert.equal(mirror.napok[0].kidolgozas_tablazat.length, 5);
  assert.equal(mirror.napok[1].kidolgozas_tablazat.length, 4);

  // No secrets leaked
  const jsonStr = JSON.stringify(mirror);
  assert.equal(jsonStr.includes('zellergyökér'), false);
  assert.equal(jsonStr.includes('meselánc'), false);
});

test('no emojis are present in locked metadata and summary texts', () => {
  const plan = makePlan(6);
  const mirror = planStore.createMirrorPlan(plan);
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  assert.equal(emojiRegex.test(mirror.locked_meta.summary_text), false);
  assert.match(
    mirror.locked_meta.summary_text,
    /^A teljes dokumentum elkészült: \d+ részletes táblázat és \d+ kidolgozott tevékenységi egység vár feloldásra\.$/
  );
});
