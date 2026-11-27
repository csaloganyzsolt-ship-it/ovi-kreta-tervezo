// Tesztek alatt a levélküldés mindig mockolt (services/mailService.js), akkor is, ha az .env-ben van SMTP-beállítás.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// A fizetőfalat az egyes tesztek kapcsolják be; a helyi .env értéke nem szivároghat a tesztekbe.
process.env.PAYWALL_ENABLED = 'false';
process.env.FEEDBACK_SECRET = process.env.FEEDBACK_SECRET || 'test-feedback-secret';
process.env.COUPON_RATE_LIMIT = process.env.COUPON_RATE_LIMIT || '1000';
process.env.PAYMENT_RATE_LIMIT = process.env.PAYMENT_RATE_LIMIT || '1000';
process.env.GENERATE_RATE_LIMIT = process.env.GENERATE_RATE_LIMIT || '1000';
process.env.DAILY_GENERATION_CAP = process.env.DAILY_GENERATION_CAP || '100000';

function makePayload(overrides = {}) {
  return {
    duration: 'Napi',
    planMode: 'daily',
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

// Oktatási célú (academic) fixture-ök: a szerver fogadó oldali válaszformáját adják, hogy a tesztek a valódi normalizálón át dolgozzanak.
function makeAcademicPayload(overrides = {}) {
  return makePayload({ planMode: 'academic', planKind: 'daily', studentName: 'Minta Hallgató', ...overrides });
}

function makeAcademicResponse(overrides = {}) {
  return {
    tevekenyseg_forma: 'Irányított foglalkozás – Verselés, mesélés',
    elozmeny: 'A gyermekek az előző héten falevelet gyűjtöttek az udvaron.',
    tema: 'Őszi falevelek – mondóka és játék',
    tartalom: {
      uj_anyag: 'Népi mondóka: *Süss fel, nap* (KEE 12.)',
      ismetles: 'Gyermekdal: *Ég a gyertya, ég* (ÉNÓ 173.)',
      keszsegfejlesztes: 'Beszédfejlesztés, finommotorika.',
      zenehallgatas: 'Törzsök Béla: Zenehallgatás az óvodában – őszi hangulatkép'
    },
    cel: 'A gyermekek szókincsének bővítése az őszi természeti jelenségekről.',
    nevelesi_feladatok: 'A társak figyelmes meghallgatása.',
    didaktikai_feladatok: 'A levélformák megfigyelése és megnevezése.',
    kepessegfejlesztes: 'Hallási figyelem és ritmusérzék fejlesztése.',
    modszerek: ['beszélgetés', 'bemutatás', 'játék'],
    eszkozok: ['falevelek', 'kosár', 'bábu'],
    kidolgozas_tablazat: [
      { ido: '2 p', tevekenyseg_menete: ['**Szervezési feladatok:** A gyermekek félkörben ülnek, a leveleket a kosárba helyezem.'], modszerek_megjegyzesek: 'Tanulásszervezés módja: kötetlen.' },
      { ido: '7 perc', tevekenyseg_menete: ['**Motiváció:** A bábu levelet hoz.', '*„Nézzétek, milyen színes levelet találtam!”*'], modszerek_megjegyzesek: 'Tanulásszervezés módja: kötetlen.\n\n*„Ki látott már ilyen levelet?”*' },
      { ido: '8 p', tevekenyseg_menete: ['**1. Tevékenységi egység – Süss fel, nap:**', '*Süss fel, nap, fényes nap,\nkertek alatt a ludaim\nmegfagynak.*'], modszerek_megjegyzesek: 'Differenciálás: *„Az ügyesebbek egyedül is elmondják.”*\n\nHibajavítás: a pedagógus újra elmondja a sort.' },
      { ido: '3 p', tevekenyseg_menete: ['**Elköszönés:** *„Köszönöm a mai játékot!”*'], modszerek_megjegyzesek: 'Tanulásszervezés módja: kötetlen.' }
    ],
    felhasznalt_irodalom: 'Forrai Katalin: Ének az óvodában. Editio Musica, Budapest, 1974. (ÉNÓ)\nLukács Józsefné – Ferencz Éva: Kerek egy esztendő. (KEE)\nÓvodai nevelés országos alapprogramja (ONAP)',
    ...overrides
  };
}

function makeThematicPayload(overrides = {}) {
  return makePayload({ planMode: 'academic', planKind: 'weekly', duration: 'Heti', includeDailyBreakdown: false, dateValue: '2026-W45', studentName: 'Minta Hallgató', ...overrides });
}

function makeThematicResponse(overrides = {}) {
  return {
    tema: 'Az ősz ajándékai',
    hetek: [{
      foteme: 'Őszi erdő',
      altema: 'Falevelek és termések',
      teruletek: {
        kulso_vilag: ['Falevelek gyűjtése és csoportosítása az udvaron.'],
        matematika: ['Levelek sorba rendezése nagyság szerint.'],
        verseles_meseles: {
          versek: ['Weöres Sándor: Falevél (KEE 45.)'],
          ismetles: ['Népköltés: *Süss fel, nap* (KEE 12.)'],
          mesek: ['Népmese: A répa (KEE 60.)'],
          szolasok_kozmondasok: ['*Ősszel minden hasznos.*'],
          talalos_kerdesek: ['*Se lába, se keze, mégis felmegy a fára. Mi az?*'],
          nyelvtorok: []
        },
        enek_zene: {
          enekes_jatek: ['*Ég a gyertya, ég* (ÉNÓ 173.)'],
          kiszamolo: ['*Egy, kettő, három*'],
          zenehallgatas: ['Vivaldi: Az évszakok – Ősz (részlet)']
        },
        rajzolas: ['Levélnyomat készítése zsírkrétával.'],
        mozgas: ['Levéltánc: futás és guggolás a szél irányába.']
      },
      keretrendszer: {
        celok: ['Az őszi természeti jelenségek megismerése.'],
        feladatok: ['Megfigyelés, gyűjtés, csoportosítás.'],
        kiemelt_fejlesztesi_terulet: {
          kulso_vilag: 'Természeti megfigyelések.',
          matematika: 'Sorbarendezés.',
          verseles_meseles: 'Szókincsbővítés.',
          enek_zene: 'Ritmusérzék.',
          rajzolas: 'Finommotorika.',
          mozgas: 'Egyensúlyérzék.'
        },
        modszerek: ['megfigyelés', 'játék'],
        eszkozok: ['falevelek', 'zsírkréta']
      }
    }],
    megjegyzes_egyeb_tevekenysegek: null,
    felhasznalt_irodalom: 'Forrai Katalin: Ének az óvodában. (ÉNÓ)\nLukács Józsefné – Ferencz Éva: Kerek egy esztendő. (KEE)\nÓvodai nevelés országos alapprogramja (ONAP)',
    ...overrides
  };
}

module.exports = { makePayload, makePlan, makeAcademicPayload, makeAcademicResponse, makeThematicPayload, makeThematicResponse };
// A jsdom-tesztek nem töltenek külső fájlokat, ezért minden helyi <script src> tartalmát (az eredeti sorrendben) a lapba ágyazzuk;
// a config.js kivétel, mert a tesztek a saját APP_CONFIG-jukat adják.
function readPage(name) {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'frontend');
  return fs.readFileSync(path.join(root, name), 'utf8')
    .replace(/<script src="([^":?]+)(?:\?v=\d+)?"><\/script>/g, (tag, file) => {
      const target = path.join(root, file);
      return file !== 'js/config.js' && fs.existsSync(target) ? `<script>${fs.readFileSync(target, 'utf8')}</script>` : tag;
    });
}
module.exports.readPage = readPage;
