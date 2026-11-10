function makePayload(overrides = {}) {
  return {
    duration: 'Napi',
    planMode: 'daily',
    includeDailyBreakdown: false,
    theme: 'Falevelek vizsgálata',
    group: 'Vegyes csoport',
    kindergartenName: 'Teszt Óvoda',
    teacherName: 'Teszt Pedagógus',
    groupName: 'Teszt Csoport',
    dateValue: '2026-11-03',
    tevekenysegForma: 'Külső világ tevékeny megismerése',
    elozmeny: 'Az udvaron leveleket gyűjtöttünk.',
    childCount: 23,
    energyLevel: 0,
    hasPreschoolers: false,
    focusAreas: ['Mozgás', 'Verselés, mesélés'],
    selectedGoals: ['összehasonlítás fejlesztése'],
    specialNeeds: ['Beszédfejlődési elmaradás'],
    customNote: 'Elsődleges egyéni kérés.',
    customNotes: {
      primary: 'Elsődleges egyéni kérés.',
      groupNote: 'Vizuális napirendet használunk.',
      requiredText: 'Saját, szabadon felhasználható levélmondóka.',
      ideaNote: 'Nagyító és tapintózsák áll rendelkezésre.',
      customRequest: 'Legyen páros válogatás is.',
      specialNeeds: ['Mozgásfejlődési elmaradás']
    },
    detailLevel: 90,
    outputMode: 'Kréta',
    showLiteratureAtBottom: false,
    ...overrides
  };
}

function makePlan(rowCount = 5) {
  const phases = ['Előkészítés', 'Ráhangolódás', 'Fő tevékenység', 'Gyakorlás', 'Levezetés'];
  return {
    tevekenyseg_forma: 'Külső világ tevékeny megismerése',
    elozmeny: 'Az udvaron leveleket gyűjtöttünk.',
    tema: 'Falevelek vizsgálata',
    cel: 'A levelek tulajdonságainak összehasonlítása közös felfedezéssel.',
    nevelesi_feladatok: 'A társak türelmes meghallgatása és az eszközök közös használata.',
    didaktikai_feladatok: 'A levélformák megfigyelése, csoportosítása és összevetése.',
    kepessegfejlesztes: 'Tapintásos észlelés, megfigyelés és szókincs fejlesztése.',
    modszerek: ['megfigyelés', 'cselekedtetés', 'páros összehasonlítás', 'visszajelzés'],
    eszkozok: ['nagyító', 'levelek', 'tálcák', 'tapintózsák'],
    kidolgozas_tablazat: Array.from({ length: rowCount }, (_, index) => ({
      ido: `${index + 2} perc`,
      tevekenyseg_menete: [
        `${phases[index % phases.length]}: ${index + 1}. lépésként a pedagógus bemutatja a levélvizsgálatot. A gyermekek elmondják a saját megfigyeléseiket.`,
        `A ${index + 1}. feladatban párokban összehasonlítják a levélformákat. A pedagógus képes jelzéssel és választási lehetőséggel segít.`
      ],
      // Repeated prefixes and identical notes are valid and must never delete rows.
      modszerek_megjegyzesek: index % 2 === 0
        ? 'Szemléltetés bábbal; páros munka; képes választás.'
        : 'Szemléltetés bábbal; mikrocsoport; egyéni mozgástámogatás.'
    })),
    felhasznalt_irodalom: 'A pedagógus saját, szabadon felhasználható feladatgyűjteménye.'
  };
}

module.exports = { makePayload, makePlan };
// A jsdom-tesztek nem töltenek külső fájlokat, ezért a közös site.js tartalmát a lapba ágyazzuk.
function readPage(name) {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  return fs.readFileSync(path.join(root, name), 'utf8')
    .replace('<script src="site.js"></script>', () => `<script>${fs.readFileSync(path.join(root, 'site.js'), 'utf8')}</script>`);
}
module.exports.readPage = readPage;
