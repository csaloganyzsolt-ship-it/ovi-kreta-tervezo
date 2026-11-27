'use strict';

// Oktatási célú (egyetemi / hospitálási) tervezet: prompt és válaszellenőrzés.
// Napi terv: Foglalkozási/tevékenységi terv (3 oszlopos kidolgozás). Heti terv: Tematikus terv (7 oszlopos mátrix).

const { generationError, readText, readStringArray, readParagraphs } = require('./responseReaders');
const { LITERATURE_PRIORITY_RULE } = require('./literatureRules');

// Az ONAP hat tevékenységi területe; a kulcsok a Gemini-válasz mezői, a feliratok a mátrix fejlécei.
const AREA_COLUMNS = Object.freeze([
  { key: 'kulso_vilag', label: 'A külső világ tevékeny megismerése' },
  { key: 'matematika', label: 'Matematikai tartalmú tapasztalatok' },
  { key: 'verseles_meseles', label: 'Verselés, mesélés' },
  { key: 'enek_zene', label: 'Ének, zene, énekes játék, gyermektánc' },
  { key: 'rajzolas', label: 'Rajzolás, festés, mintázás, kézimunka' },
  { key: 'mozgas', label: 'Mozgás / Testnevelés' }
]);

// [kulcs, felirat, kötelezően legalább egy tétel]
const VERSELES_GROUPS = Object.freeze([
  ['versek', 'Versek:', true],
  ['ismetles', 'Ismétlés:', false],
  ['mesek', 'Mesék:', true],
  ['szolasok_kozmondasok', 'Szólások, közmondások:', false],
  ['talalos_kerdesek', 'Találós kérdések:', false],
  ['nyelvtorok', 'Nyelvtörők:', false]
]);

const ENEK_GROUPS = Object.freeze([
  ['enekes_jatek', 'Énekes játék:', true],
  ['kiszamolo', 'Kiszámoló:', false],
  ['zenehallgatas', 'Zenehallgatás:', true]
]);

const MEGJEGYZES_GROUPS = Object.freeze([
  ['jatekbovites', 'Játékbővítés'],
  ['anyanyelvi_jatekok', 'Anyanyelvi játékok'],
  ['fejlesztojatek', 'Fejlesztőjáték'],
  ['kirandulas_setak', 'Kirándulás, séta']
]);

const DAILY_TEXT_FIELDS = [
  'tevekenyseg_forma', 'elozmeny', 'tema', 'cel',
  'nevelesi_feladatok', 'didaktikai_feladatok', 'kepessegfejlesztes'
];

const CONTENT_FIELDS = ['uj_anyag', 'ismetles', 'keszsegfejlesztes', 'zenehallgatas'];

const MIN_DAILY_ROWS = 3;
const THEMATIC_WEEK_COUNT = 1;
const MAX_ACADEMIC_OUTPUT_TOKENS = 16384;
const ACADEMIC_TIMEOUT_MS = 290000;

function isAcademic(payload = {}) {
  return payload.planMode === 'academic';
}

function isThematic(payload = {}) {
  return isAcademic(payload) && payload.duration === 'Heti';
}

const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];

// A hét hétfője (UTC) az ISO-hét vagy a naptári nap alapján; érvénytelen értéknél null (a dátumot nem találjuk ki).
function mondayOf(dateValue) {
  const value = String(dateValue || '').trim();
  const week = value.match(/^(\d{4})-W(\d{1,2})$/i);
  if (week) {
    const jan4 = new Date(Date.UTC(Number(week[1]), 0, 4));
    const week1Monday = Date.UTC(Number(week[1]), 0, 4 - ((jan4.getUTCDay() || 7) - 1));
    return new Date(week1Monday + (Number(week[2]) - 1) * 7 * 86400000);
  }
  const day = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (day) {
    const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    if (Number.isNaN(date.getTime())) return null;
    return new Date(date.getTime() - ((date.getUTCDay() || 7) - 1) * 86400000);
  }
  return null;
}

// Pl. "2026. november 2–6." vagy "2026. október 26. – november 30."
function weekRangeLabel(dateValue, weekIndex = 0) {
  const monday = mondayOf(dateValue);
  if (!monday) return '';
  const start = new Date(monday.getTime() + weekIndex * 7 * 86400000);
  const end = new Date(start.getTime() + 4 * 86400000);
  const [y1, m1, d1] = [start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()];
  const [y2, m2, d2] = [end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()];
  if (y1 === y2 && m1 === m2) return `${y1}. ${MONTHS[m1]} ${d1}–${d2}.`;
  if (y1 === y2) return `${y1}. ${MONTHS[m1]} ${d1}. – ${MONTHS[m2]} ${d2}.`;
  return `${y1}. ${MONTHS[m1]} ${d1}. – ${y2}. ${MONTHS[m2]} ${d2}.`;
}

const SOURCE_RULES = `FORRÁSKÓDOK ÉS SZAKIRODALOM (szigorú szabályok):
- ${LITERATURE_PRIORITY_RULE}
- Rövidítések: ÉNÓ = Forrai Katalin: Ének az óvodában; KEE = Lukács Józsefné – Ferencz Éva: Kerek egy esztendő; ONAP = Óvodai nevelés országos alapprogramja (363/2012. (XII. 17.) Korm. rendelet). Törzsök Béla: Zenehallgatás az óvodában szintén használható zenehallgatási anyaghoz.
- Minden vers, mondóka, mese, dal, énekes játék, kiszámoló és zenehallgatási anyag mellett tüntesd fel a gyűjteményi forráskódot (pl. (ÉNÓ 173.), (KEE 45.)). Oldalszámot csak akkor írj, ha biztosan tudod; bizonytalan oldalszám helyett csak a rövidítést add meg, vagy válassz másik, biztosan azonosítható művet. Oldalszámot, kiadót, évszámot SOHA ne találj ki.
- A dokumentum legvégére, a "felhasznalt_irodalom" mezőbe kerüljön a "Felhasznált irodalom:" szakirodalmi jegyzék (a mező szövege már ne ismételje a címet): soronként egy tétel, szerző szerinti ábécésorrendben, KÖTELEZŐEN APA 7 (7th edition) magyar formátumban ("Szerző, V. (Év). *Mű címe*. Kiadó."; jogszabály: "363/2012. (XII. 17.) Korm. rendelet az Óvodai nevelés országos alapprogramjáról."; a műcím *csillagok* között, dőlt jelöléssel; ismeretlen évszám helyett (é. n.)). Csak valós, létező magyar óvodapedagógiai szakkönyvek és a dokumentumban ténylegesen hivatkozott művek szerepelhetnek; ha az ONOAP szerepel, azt jogszabályként, APA 7 alakban add meg (ábécérendben, nem a lista végén). Ha egy kiadói adatot nem tudsz biztosan, hagyd el az adott adatot, de ne találj ki helyette másikat. A tételeket új sorral válaszd el.
- SZERZŐI JOG: vers, mondóka vagy dalszöveg teljes szövegét csak akkor írd ki, ha az népköltészeti/közkincs, a szerző halála óta legalább 70 év eltelt, saját alkotás, vagy a felhasználó adta meg. Védett mű esetén add meg a szerzőt, a címet, a forráskódot és a kezdősort, a teljes szöveg helyett pedig a feldolgozás lépéseit; jelezd, hogy a teljes szöveg a hivatkozott kiadványban olvasható.`;

const TYPOGRAPHY_RULES = `TIPOGRÁFIAI JELÖLÉS (csak ez a két jelölés használható, más markdown nem):
- *szöveg* = dőlt betű. Dőlttel írd: minden vers és mondóka teljes szövegét, minden dal- és játékkezdősort, a szó szerinti pedagógusi kérdéseket, instrukciókat és idézeteket. A verssorokat új sorral (\\n) tagold a dőlt jelölésen belül.
- **szöveg** = félkövér. Csak címkékhez és fázisnevekhez használd.
- A módszertani magyarázatok, leírások és indoklások normál (álló) betűvel szerepeljenek. Címsort (#), listajelet vagy táblázat-jelölést ne használj.`;

function toolsLine(settings) {
  return settings.availableTools
    ? `Rendelkezésre álló eszközök és a pedagógus saját ötletei (availableTools): ${JSON.stringify(settings.availableTools)}. Az eszközöknél és a feladatoknál ELSŐSORBAN ezeket használd; csak indokolt esetben egészítsd ki általánosan elérhető alapeszközzel.`
    : 'Nincs megadott eszközkészlet: az óvodákban általánosan megtalálható alapfelszerelésekkel (papír, olló, ceruza, labda stb.) tervezz.';
}

function buildAcademicDailyPrompt(settings, detail, commonRules) {
  return `Feladat: hallgatói gyakorlatra, hospitálásra és zárótanításra alkalmas, hivatalos "Foglalkozási/tevékenységi terv" dokumentum készítése az Óvodai nevelés országos alapprogramja (ONAP) szerint. A szerepet és az irodalmi szabályokat a rendszerutasítás tartalmazza.

Beállítások (JSON):
${JSON.stringify(settings)}

${toolsLine(settings)}
${commonRules}

A DOKUMENTUM TARTALMA (szigorú szabályok):
1. Fejléc-mezők (a csoportot, időpontot és az óvodapedagógus nevét a rendszer tölti ki, ezeket te ne add vissza):
   - tevekenyseg_forma: a tevékenység formája (a beállított tevekenysegForma-hoz igazodva, szakmai megnevezéssel);
   - elozmeny: a tevékenység előzménye; ha a beállításokban nincs megadva előzmény, üres szöveg (ne találj ki megtörtént eseményt);
   - tema: a tevékenység/foglalkozás tartalmának/témájának rövid, pontos címe;
   - tartalom: objektum, az alábbi alpontokkal (mindegyik szöveg, a hivatkozott művek forráskóddal, pl. (ÉNÓ 173.)): uj_anyag (kötelező, nem üres), ismetles, keszsegfejlesztes, zenehallgatas. Amelyik alpont az adott foglalkozásban nem szerepel, annak értéke üres szöveg;
   - cel: a tevékenység célja;
   - nevelesi_feladatok, didaktikai_feladatok, kepessegfejlesztes: a feladatok HÁROM külön alpontja (Nevelési feladatok, Didaktikai feladatok, Képesség- és készségfejlesztés), mindegyik önálló, konkrét, nem sablonos szöveg;
   - modszerek: az alkalmazott módszerek és eljárások listája; eszkozok: az eszközök listája.
2. kidolgozas_tablazat ("A tevékenység/foglalkozás kidolgozása"): legalább ${MIN_DAILY_ROWS} sor, a foglalkozás ténylegesen lejátszható, percre pontos menete. Minden sor három oszlopa:
   - ido: kizárólag "N p" alakban (pl. "2 p", "7 p", "8 p", "3 p"); az idők összege a teljes foglalkozási idő legyen;
   - tevekenyseg_menete (a "A fejlesztő tevékenység felépítése, a foglalkozás menete" oszlop): bekezdéstömb. A sorok sorrendje: **Szervezési feladatok:**, **Motiváció:**, majd a tevékenységi egységek (pl. **1. Tevékenységi egység – cím:**), végül **Elköszönés:**. A versek, mondókák teljes szövege (a szerzői jogi szabály szerint) dőlt betűs;
   - modszerek_megjegyzesek (a "A fejlesztés módszerei, munkaformák, eszközök, megjegyzések" oszlop): szöveg, bekezdéseit üres sor választja el. Kötelező tartalma soronként: "Tanulásszervezés módja: kötetlen." (vagy a valódi munkaforma), a pedagógus konkrét, szó szerinti kérdései és instrukciói dőlten, differenciálás (pl. *„Az ügyesebbek…”*), valamint hibajavítási/segítségnyújtási megoldás, és az eszközök.
3. Kidolgozottság (${detail.level}/100): ${detail.instruction}

${TYPOGRAPHY_RULES}

${SOURCE_RULES}

Válasz: egyetlen valid JSON objektum, markdown-kódblokk nélkül, pontosan ezekkel a mezőkkel:
{
  "tevekenyseg_forma": "string",
  "elozmeny": "string",
  "tema": "string",
  "tartalom": { "uj_anyag": "string", "ismetles": "string", "keszsegfejlesztes": "string", "zenehallgatas": "string" },
  "cel": "string",
  "nevelesi_feladatok": "string",
  "didaktikai_feladatok": "string",
  "kepessegfejlesztes": "string",
  "modszerek": ["string"],
  "eszkozok": ["string"],
  "kidolgozas_tablazat": [ { "ido": "2 p", "tevekenyseg_menete": ["string"], "modszerek_megjegyzesek": "string" } ],
  "felhasznalt_irodalom": "string"
}
Minden mezőt adj vissza.`;
}

function buildAcademicThematicPrompt(settings, detail, commonRules) {
  const range = weekRangeLabel(settings.dateValue);
  return `Feladat: hallgatói gyakorlatra és hospitálásra alkalmas "Tematikus terv" dokumentum készítése pontosan ${THEMATIC_WEEK_COUNT} hétre, az Óvodai nevelés országos alapprogramja (ONAP) szerint. A szerepet és az irodalmi szabályokat a rendszerutasítás tartalmazza.${range ? ` A hét időszaka: ${range}` : ''}

Beállítások (JSON):
${JSON.stringify(settings)}

${toolsLine(settings)}
${commonRules}

A DOKUMENTUM TARTALMA (szigorú szabályok):
1. "tema": a tematikus terv fő témája (rövid, pontos cím). A "hetek" tömb pontosan ${THEMATIC_WEEK_COUNT} elemet tartalmazzon.
2. Minden hét: "foteme" (a hét főtémája) és "altema" (a hét altémája), majd a "teruletek" objektum, amely az ONAP mind a 6 tevékenységi területét külön mezőben tartalmazza:
   - kulso_vilag (A külső világ tevékeny megismerése), matematika (Matematikai tartalmú tapasztalatok), rajzolas (Rajzolás, festés, mintázás, kézimunka), mozgas (Mozgás / Testnevelés): mindegyik szöveglista (legalább 1 tétel), a tételek konkrét tevékenységek;
   - verseles_meseles (Verselés, mesélés): objektum a KÖTELEZŐ belső alcsoportokkal, mindegyik szöveglista: versek, ismetles, mesek, szolasok_kozmondasok, talalos_kerdesek, nyelvtorok. A versek és a mesék legalább 1 tételt tartalmazzanak, a többit is töltsd ki, amennyire a téma engedi;
   - enek_zene (Ének, zene, énekes játék, gyermektánc): objektum a KÖTELEZŐ belső alcsoportokkal, mindegyik szöveglista: enekes_jatek, kiszamolo, zenehallgatas. Az énekes játék és a zenehallgatás legalább 1 tételt tartalmazzon.
   - Minden műnél (vers, mese, mondóka, dal, zenehallgatási anyag) a tétel alakja: "Szerző: Cím (forráskód)", pl. "Weöres Sándor: Falevél (KEE 45.)"; néphagyományi műnél "Népköltés: Cím (forráskód)". A kiszámolók, énekes játékok, szólások, közmondások, találós kérdések és nyelvtörők szövegét/kezdősorát dőlten add meg a szerzői jogi szabály szerint.
   - Egy cella tételei rövidek és tömörek legyenek (egy tétel egy-két sor), hogy a 7 oszlopos fekvő táblázat olvasható maradjon.
3. Minden hét "keretrendszer" objektuma (a hét táblázata alatt jelenik meg):
   - celok: szöveglista (a hét céljai); feladatok: szöveglista (a hét feladatai);
   - kiemelt_fejlesztesi_terulet: objektum a 6 tevékenységi terület kulcsaival (kulso_vilag, matematika, verseles_meseles, enek_zene, rajzolas, mozgas), mindegyik értéke egy konkrét kiemelt fejlesztési mondat;
   - modszerek: szöveglista; eszkozok: szöveglista.
4. "megjegyzes_egyeb_tevekenysegek": egyhetes tervnél null. (Többhetes tervnél a dokumentum végén objektum lenne: jatekbovites, anyanyelvi_jatekok, fejlesztojatek, kirandulas_setak szöveglistákkal.)
5. Kidolgozottság (${detail.level}/100): ${detail.instruction} A terjedelmet a mátrix tartalmi gazdagságára és a pontos forrásmegjelölésekre fordítsd.

${TYPOGRAPHY_RULES}

${SOURCE_RULES}

Válasz: egyetlen valid JSON objektum, markdown-kódblokk nélkül, pontosan ebben a szerkezetben:
{
  "tema": "string",
  "hetek": [
    {
      "foteme": "string",
      "altema": "string",
      "teruletek": {
        "kulso_vilag": ["string"],
        "matematika": ["string"],
        "verseles_meseles": { "versek": ["string"], "ismetles": ["string"], "mesek": ["string"], "szolasok_kozmondasok": ["string"], "talalos_kerdesek": ["string"], "nyelvtorok": ["string"] },
        "enek_zene": { "enekes_jatek": ["string"], "kiszamolo": ["string"], "zenehallgatas": ["string"] },
        "rajzolas": ["string"],
        "mozgas": ["string"]
      },
      "keretrendszer": {
        "celok": ["string"],
        "feladatok": ["string"],
        "kiemelt_fejlesztesi_terulet": { "kulso_vilag": "string", "matematika": "string", "verseles_meseles": "string", "enek_zene": "string", "rajzolas": "string", "mozgas": "string" },
        "modszerek": ["string"],
        "eszkozok": ["string"]
      }
    }
  ],
  "megjegyzes_egyeb_tevekenysegek": null,
  "felhasznalt_irodalom": "string"
}
Minden mezőt adj vissza.`;
}

function buildAcademicPrompt(settings, detail, commonRules) {
  return isThematic(settings)
    ? buildAcademicThematicPrompt(settings, detail, commonRules)
    : buildAcademicDailyPrompt(settings, detail, commonRules);
}

// "7 perc", "7 p" és "7" is elfogadott; a kimenet mindig az "N p" alak.
function readMinutes(value, field) {
  const match = typeof value === 'string' ? value.match(/^\s*(\d{1,3})\s*(?:p|perc)?\b\.?/i) : null;
  if (!match) throw generationError(`Érvénytelen időkeret a Gemini válaszában: ${field} (várt alak: "N p").`);
  return Number(match[1]);
}

function normalizeAcademicTable(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_DAILY_ROWS) {
    throw generationError(`A Gemini válaszában a kidolgozas_tablazat legalább ${MIN_DAILY_ROWS} sort kell, hogy tartalmazzon. Nem készült dokumentum.`);
  }
  let total = 0;
  const table = rows.map((row, index) => {
    const field = `kidolgozas_tablazat[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw generationError(`Hibás táblázatsor a Gemini válaszában: ${field}.`);
    }
    const minutes = readMinutes(row.ido, `${field}.ido`);
    total += minutes;
    return {
      ido: `${minutes} p`,
      tevekenyseg_menete: readParagraphs(row.tevekenyseg_menete, `${field}.tevekenyseg_menete`),
      modszerek_megjegyzesek: readText(row.modszerek_megjegyzesek, `${field}.modszerek_megjegyzesek`)
    };
  });
  return { table, total };
}

function normalizeAcademicDaily(parsed, payload) {
  const result = { planMode: 'academic' };
  for (const field of DAILY_TEXT_FIELDS) {
    result[field] = readText(parsed[field], field, field === 'elozmeny');
  }
  const content = parsed.tartalom;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw generationError('Hiányzó vagy hibás tartalom a Gemini válaszában: tartalom.');
  }
  result.tartalom = {};
  for (const field of CONTENT_FIELDS) {
    result.tartalom[field] = readText(content[field], `tartalom.${field}`, field !== 'uj_anyag');
  }
  result.modszerek = readStringArray(parsed.modszerek, 'modszerek');
  result.eszkozok = readStringArray(parsed.eszkozok, 'eszkozok');
  const { table, total } = normalizeAcademicTable(parsed.kidolgozas_tablazat);
  result.kidolgozas_tablazat = table;
  result.ossz_ido_perc = total;
  result.felhasznalt_irodalom = readText(parsed.felhasznalt_irodalom, 'felhasznalt_irodalom');
  result.summary = [result.tema, payload.group, payload.duration, payload.dateValue].filter(Boolean).join(' • ');
  result.showLiteratureAtBottom = true;
  return result;
}

function readItems(value, field, minItems) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list)) throw generationError(`Hiányzó vagy hibás szöveglista a Gemini válaszában: ${field}.`);
  const items = list.map((item, index) => {
    if (typeof item !== 'string') throw generationError(`Hibás szöveglista-elem a Gemini válaszában: ${field}[${index}].`);
    return item.trim();
  }).filter(Boolean);
  if (items.length < minItems) throw generationError(`Hiányzó tartalom a Gemini válaszában: ${field}.`);
  return items;
}

function readObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw generationError(`Hiányzó vagy hibás objektum a Gemini válaszában: ${field}.`);
  }
  return value;
}

function readGroups(value, field, groups) {
  const source = readObject(value, field);
  const result = {};
  for (const [key, , required] of groups) {
    result[key] = readItems(source[key], `${field}.${key}`, required ? 1 : 0);
  }
  return result;
}

function normalizeWeek(week, index, payload) {
  const field = `hetek[${index}]`;
  const source = readObject(week, field);
  const areas = readObject(source.teruletek, `${field}.teruletek`);
  const frame = readObject(source.keretrendszer, `${field}.keretrendszer`);
  const focus = readObject(frame.kiemelt_fejlesztesi_terulet, `${field}.keretrendszer.kiemelt_fejlesztesi_terulet`);

  const teruletek = {};
  for (const { key } of AREA_COLUMNS) {
    if (key === 'verseles_meseles') teruletek[key] = readGroups(areas[key], `${field}.teruletek.${key}`, VERSELES_GROUPS);
    else if (key === 'enek_zene') teruletek[key] = readGroups(areas[key], `${field}.teruletek.${key}`, ENEK_GROUPS);
    else teruletek[key] = readItems(areas[key], `${field}.teruletek.${key}`, 1);
  }
  const kiemelt = {};
  for (const { key } of AREA_COLUMNS) {
    kiemelt[key] = readText(focus[key], `${field}.keretrendszer.kiemelt_fejlesztesi_terulet.${key}`);
  }

  return {
    het_szama: index + 1,
    datum: weekRangeLabel(payload.dateValue, index),
    foteme: readText(source.foteme, `${field}.foteme`),
    altema: readText(source.altema, `${field}.altema`),
    teruletek,
    keretrendszer: {
      celok: readItems(frame.celok, `${field}.keretrendszer.celok`, 1),
      feladatok: readItems(frame.feladatok, `${field}.keretrendszer.feladatok`, 1),
      kiemelt_fejlesztesi_terulet: kiemelt,
      modszerek: readItems(frame.modszerek, `${field}.keretrendszer.modszerek`, 1),
      eszkozok: readItems(frame.eszkozok, `${field}.keretrendszer.eszkozok`, 1)
    }
  };
}

function normalizeNotes(value, required) {
  if (value === null || value === undefined) {
    if (required) throw generationError('Hiányzó megjegyzes_egyeb_tevekenysegek a többhetes tervből.');
    return null;
  }
  const source = readObject(value, 'megjegyzes_egyeb_tevekenysegek');
  const notes = {};
  for (const [key] of MEGJEGYZES_GROUPS) notes[key] = readItems(source[key] ?? [], `megjegyzes_egyeb_tevekenysegek.${key}`, 0);
  const empty = MEGJEGYZES_GROUPS.every(([key]) => !notes[key].length);
  if (empty && required) throw generationError('Üres megjegyzes_egyeb_tevekenysegek a többhetes tervből.');
  return empty ? null : notes;
}

function normalizeThematic(parsed, payload) {
  if (!Array.isArray(parsed.hetek) || parsed.hetek.length !== THEMATIC_WEEK_COUNT) {
    throw generationError(`A Gemini válasza nem pontosan ${THEMATIC_WEEK_COUNT} hétnyi tematikus tervet tartalmaz (hetek).`);
  }
  const tema = readText(parsed.tema, 'tema');
  const hetek = parsed.hetek.map((week, index) => normalizeWeek(week, index, payload));
  return {
    is_thematic: true,
    planMode: 'academic',
    tema,
    summary: [tema, payload.group, 'Tematikus terv', payload.dateValue].filter(Boolean).join(' • '),
    hetek,
    megjegyzes_egyeb_tevekenysegek: normalizeNotes(parsed.megjegyzes_egyeb_tevekenysegek, hetek.length > 1),
    felhasznalt_irodalom: readText(parsed.felhasznalt_irodalom, 'felhasznalt_irodalom'),
    showLiteratureAtBottom: true
  };
}

function normalizeAcademicResponse(parsed, payload) {
  return isThematic(payload) ? normalizeThematic(parsed, payload) : normalizeAcademicDaily(parsed, payload);
}

module.exports = {
  AREA_COLUMNS, VERSELES_GROUPS, ENEK_GROUPS, MEGJEGYZES_GROUPS, MAX_ACADEMIC_OUTPUT_TOKENS, ACADEMIC_TIMEOUT_MS,
  isAcademic, isThematic, weekRangeLabel, buildAcademicPrompt, normalizeAcademicResponse
};
