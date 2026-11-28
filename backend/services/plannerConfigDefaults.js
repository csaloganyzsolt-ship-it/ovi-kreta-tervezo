// A tervező űrlap Adminból szerkeszthető része (Zöld: szövegek, Sárga: opciólisták).
// A Piros elemek (tervezettípus, időtartam, ONOAP-területek, részletességi szint, irodalom-pipa, árazás stb.) szándékosan NINCSENEK itt.
// A tárolt érték csak az alapértékektől eltérő részt tartalmazza: { texts: { kulcs: szöveg }, optionLists: { lista: [{ id, label, active }] } }.

class PlannerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlannerConfigError';
    this.status = 400;
  }
}

const SHORT = 140;
const LONG = 400;

// kulcs: [szekció, típus (label|hint|placeholder), alapérték]; a szövegek a tervezo.html data-cfg-* elemeivel egyeznek.
const TEXT_META = {
  step1Title: [1, 'label', '1. Miről szól a hét/nap?'],
  step1Subhead: [1, 'hint', 'Téma és időkeret: add meg, mikorra és miről készüljön a tervezet.'],
  studentNameLabel: [1, 'label', 'Hallgató / Óvodapedagógus neve (opcionális)'],
  studentNamePlaceholder: [1, 'placeholder', 'Pl.: Kovács Anna'],
  groupLabel: [1, 'label', 'Korcsoport'],
  themeLabel: [1, 'label', 'Téma / projekt címe'],
  tevekenysegFormaLabel: [1, 'label', 'Tevékenységi forma'],
  kindergartenNameLabel: [1, 'label', 'Óvoda neve'],
  kindergartenNamePlaceholder: [1, 'placeholder', 'Pl.: Bölcsőde és Óvoda Péter Pál'],
  kindergartenProfileLabel: [1, 'label', 'Óvoda arculata (opcionális)'],
  kindergartenProfilePlaceholder: [1, 'placeholder', 'pl. Zöld Óvoda, néphagyományőrző, Boldog Óvoda, mozgásfejlesztő...'],
  teacherNameLabel: [1, 'label', 'Óvodapedagógus neve'],
  teacherNamePlaceholder: [1, 'placeholder', 'Pl.: Nagy Eszter'],
  groupNameLabel: [1, 'label', 'Csoport neve'],
  groupNamePlaceholder: [1, 'placeholder', 'Pl.: Napfény csoport'],
  customNoteLabel: [1, 'label', 'Saját megjegyzés / egyéni kiegészítés'],
  customNotePlaceholder: [1, 'placeholder', 'Pl.: A csoport sokat mozog, ezért több mozgásos bevezető játékot szeretnék beépíteni.'],
  step2Title: [2, 'label', '2. Kiknek tervezünk?'],
  step2Subhead: [2, 'hint', 'A csoport profilja: létszám, hangulat és speciális igények, hogy az AI személyre szabottabban dolgozzon.'],
  childCountLabel: [2, 'label', 'Hány gyerek van a csoportban?'],
  childCountPlaceholder: [2, 'placeholder', 'Pl.: 20'],
  energyLabel: [2, 'label', 'Milyen a csoport hangulata, mozgékonysága?'],
  preschoolersLabel: [2, 'label', 'Iskola-előkészítős gyermekek'],
  specialNeedsLabel: [2, 'label', 'Speciális nevelési igények'],
  specialNeedsHeading: [2, 'label', 'Milyen kiemelt figyelmet igénylő gyerekek vannak jelen?'],
  groupNoteLabel: [2, 'label', 'Saját válasz / más szempont'],
  groupNotePlaceholder: [2, 'placeholder', 'Pl.: Egy gyermeknek több vizuális jelzésre van szüksége a feladatokhoz.'],
  step3Title: [3, 'label', '3. Mit szeretnénk látni?'],
  step3Subhead: [3, 'hint', 'Konkrét pedagógiai kívánságok: eszközök, kötelező szövegek, célok és a kidolgozottság.'],
  availableToolsLabel: [3, 'label', 'Rendelkezésre álló eszközök és saját ötletek'],
  availableToolsHint: [3, 'hint', 'Ha ide nem írsz semmit, az AI az óvodákban általánosan megtalálható alapfelszereléseket (papír, olló, ceruza, labda, stb.) fogja alapul venni.'],
  availableToolsPlaceholder: [3, 'placeholder', 'Pl.: színes papír, olló, gyurma, hangszerek (xilofon, dob), nagy labdák, bábok; gyűjtött gesztenye és falevelek a barkácsoláshoz'],
  requiredTextLabel: [3, 'label', 'Van kötelező mese, vers vagy dal?'],
  requiredTextPlaceholder: [3, 'placeholder', 'Pl.: Mindig legyen benne a „Süni, süni, sünikém” című dal.'],
  customRequestLabel: [3, 'label', 'Saját kérés vagy további elképzelés'],
  customRequestPlaceholder: [3, 'placeholder', 'Pl.: Szeretném, ha a tervben több nyelvi játék és rövidebb, fókuszált blokk legyen.'],
  blacklistLabel: [3, 'label', 'Tiltások / Amit NE használjon'],
  blacklistPlaceholder: [3, 'placeholder', 'Pl.: Ne legyen gyurma, ne használja a Süss fel napot.'],
  blacklistHint: [3, 'hint', 'Témák, dalok, eszközök vagy szavak, amelyeket az AI szigorúan kerüljön.'],
  elozmenyLabel: [3, 'label', 'A tevékenység előzménye'],
  elozmenyPlaceholder: [3, 'placeholder', 'Pl.: ébredő természet megfigyelése, előzetes beszélgetés a látható évszaki jelenségekről.'],
  iktLabel: [3, 'label', 'IKT / Digitális eszközök beépítése'],
  iktPanelLabel: [3, 'label', 'Választható IKT eszközcsoportok és alkalmazások'],
  iktCustomAppLabel: [3, 'label', 'Egyéb IKT eszköz vagy alkalmazás'],
  iktCustomAppPlaceholder: [3, 'placeholder', 'Pl.: saját fejlesztő játék, YouTube zenei illusztráció, fényasztal...'],
  fridayClosingLabel: [3, 'label', 'Pénteki lezárás formája'],
  step4Title: [4, 'label', '4. Összegzés és elkészítés'],
  step4Subhead: [4, 'hint', 'Mielőtt elindítod az elkészítést, ellenőrizd a beállításokat.'],
  checklistTitle: [4, 'label', 'Ellenőrző lista']
};

const DEFAULT_TEXTS = Object.fromEntries(Object.entries(TEXT_META).map(([key, meta]) => [key, meta[2]]));
const TEXT_KEYS = Object.keys(DEFAULT_TEXTS);

const OPTION_META = {
  group: { section: 1, title: 'Korcsoport', selected: 'nagycsoport' },
  tevekenysegForma: { section: 1, title: 'Tevékenységi forma' },
  energyLevel: { section: 2, title: 'Csoport hangulata, mozgékonysága', selected: 'atlagos' },
  specialNeeds: { section: 2, title: 'Speciális nevelési igények' },
  iktTools: { section: 3, title: 'IKT eszközcsoportok' },
  fridayClosingType: { section: 3, title: 'Pénteki lezárás formája' }
};

const item = (id, label) => ({ id, label, active: true });

const DEFAULT_OPTION_LISTS = {
  group: [item('kiscsoport', 'Kiscsoport'), item('kozepso', 'Középső csoport'), item('nagycsoport', 'Nagycsoport'), item('vegyes', 'Vegyes csoport')],
  tevekenysegForma: [
    item('kezdemenyezett', 'Kezdeményezett tevékenység (kötetlen)'),
    item('iranyitott', 'Irányított / szervezett foglalkozás (kötött)'),
    item('mikrocsoportos', 'Mikrocsoportos / egyéni fejlesztés')
  ],
  energyLevel: [item('nyugodt', 'Nyugodt, kiegyensúlyozott'), item('atlagos', 'Átlagos'), item('mozgekony', 'Nagyon mozgékony, eleven')],
  specialNeeds: [
    item('figyelemzavar', 'Figyelemzavar / hiperaktivitás'),
    item('beszed', 'Beszédfejlődési elmaradás'),
    item('autizmus', 'Autizmus spektrumzavar'),
    item('mozgas', 'Mozgásfejlődési elmaradás'),
    item('sni', 'Sajátos nevelési igény (SNI)'),
    item('btmn', 'Beilleszkedési, tanulási, magatartási nehézség (BTMN)')
  ],
  iktTools: [
    item('padlorobot', 'Padlórobotok (Bee-Bot, Andy, Edison)'),
    item('interaktiv_tabla', 'Interaktív tábla és gyakorlóprogramok (Smart Board, Okos Doboz, Wordwall, LearningApps)'),
    item('tablet', 'Tablet, diagnosztika és kreatív/3D appok (eDia, Quiver, Kids Doodle, Paint, AutoDraw)'),
    item('nyelvi', 'Nyelvi-kommunikációs és mese appok (BOOKR Kids, Diavetítő appok, Szörnyek Háza, Játékosan magyarul)')
  ],
  fridayClosingType: [
    item('kiallitas', 'Kiállítás a csoportszobában'),
    item('dramatikus', 'Dramatikus közös játék'),
    item('unnepi', 'Ünnepi szokás/Kóstoló'),
    item('elmenyseta', 'Projektzáró élményséta')
  ]
};
const LIST_KEYS = Object.keys(DEFAULT_OPTION_LISTS);

const MAX_ITEMS = 25;
const ID_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const clone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const defaultIds = (list) => new Set(DEFAULT_OPTION_LISTS[list].map((entry) => entry.id));

function defaults() {
  return { texts: clone(DEFAULT_TEXTS), optionLists: clone(DEFAULT_OPTION_LISTS) };
}

function maxLength(key) {
  return TEXT_META[key][1] === 'label' ? SHORT : LONG;
}

function cleanLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function validateText(key, value) {
  if (typeof value !== 'string') throw new PlannerConfigError(`A(z) „${key}” szövegének szövegnek kell lennie.`);
  const text = value.trim();
  if (!text) throw new PlannerConfigError(`A(z) „${key}” szövege nem lehet üres.`);
  if (CONTROL_CHARS.test(text)) throw new PlannerConfigError(`A(z) „${key}” szövege nem tartalmazhat vezérlőkaraktert vagy sortörést.`);
  if (text.length > maxLength(key)) throw new PlannerConfigError(`A(z) „${key}” szövege legfeljebb ${maxLength(key)} karakter lehet.`);
  return text;
}

function validateList(list, entries) {
  const title = OPTION_META[list].title;
  if (!Array.isArray(entries)) throw new PlannerConfigError(`A(z) „${title}” listájának tömbnek kell lennie.`);
  if (entries.length > MAX_ITEMS) throw new PlannerConfigError(`A(z) „${title}” legfeljebb ${MAX_ITEMS} opciót tartalmazhat.`);
  const builtin = defaultIds(list);
  const ids = new Set();
  const labels = new Set();
  const out = entries.map((entry) => {
    if (!isPlainObject(entry)) throw new PlannerConfigError(`A(z) „${title}” egyik eleme érvénytelen.`);
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ID_PATTERN.test(id)) throw new PlannerConfigError(`A(z) „${title}” egyik opciójának azonosítója érvénytelen.`);
    if (typeof entry.label !== 'string') throw new PlannerConfigError(`A(z) „${title}” opcióinak felirata szöveg kell legyen.`);
    const label = entry.label.trim();
    if (!label) throw new PlannerConfigError(`A(z) „${title}” egyik opciójának felirata üres.`);
    if (CONTROL_CHARS.test(label)) throw new PlannerConfigError(`A(z) „${title}” feliratai nem tartalmazhatnak vezérlőkaraktert vagy sortörést.`);
    if (label.length > SHORT) throw new PlannerConfigError(`A(z) „${title}” feliratai legfeljebb ${SHORT} karakteresek lehetnek.`);
    if (typeof entry.active !== 'boolean') throw new PlannerConfigError(`A(z) „${title}” opcióinak aktív jelzője igaz/hamis érték kell legyen.`);
    if (ids.has(id)) throw new PlannerConfigError(`A(z) „${title}” listában ismétlődő azonosító van.`);
    if (labels.has(label.toLowerCase())) throw new PlannerConfigError(`A(z) „${title}” listában két azonos feliratú opció van: „${label}”.`);
    ids.add(id);
    labels.add(label.toLowerCase());
    return { id, label, active: entry.active };
  });
  if (!out.some((entry) => entry.active)) throw new PlannerConfigError(`A(z) „${title}” listában legalább egy opciónak aktívnak kell maradnia.`);
  const missing = [...builtin].filter((id) => !ids.has(id));
  if (missing.length) throw new PlannerConfigError(`A(z) „${title}” alapértelmezett opciói nem törölhetők, csak inaktiválhatók.`);
  return out;
}

// Szigorú ellenőrzés mentéskor: ismeretlen kulcs, üres/túl hosszú szöveg, 0 aktív opció → 400 magyar üzenettel.
function validatePlannerConfig(input) {
  if (!isPlainObject(input)) throw new PlannerConfigError('A tervező-konfiguráció objektum kell legyen.');
  const extra = Object.keys(input).filter((key) => key !== 'texts' && key !== 'optionLists');
  if (extra.length) throw new PlannerConfigError(`Ismeretlen konfigurációs mező: ${extra.join(', ')}.`);
  const texts = input.texts === undefined ? {} : input.texts;
  const optionLists = input.optionLists === undefined ? {} : input.optionLists;
  if (!isPlainObject(texts)) throw new PlannerConfigError('A „texts” mezőnek objektumnak kell lennie.');
  if (!isPlainObject(optionLists)) throw new PlannerConfigError('Az „optionLists” mezőnek objektumnak kell lennie.');
  const outTexts = {};
  Object.entries(texts).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEXTS, key)) throw new PlannerConfigError(`Ismeretlen vagy nem szerkeszthető szövegkulcs: „${key}”.`);
    outTexts[key] = validateText(key, value);
  });
  const outLists = {};
  Object.entries(optionLists).forEach(([list, entries]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_OPTION_LISTS, list)) throw new PlannerConfigError(`Ismeretlen vagy nem szerkeszthető opciólista: „${list}”.`);
    outLists[list] = validateList(list, entries);
  });
  return { texts: outTexts, optionLists: outLists };
}

// Csak az alapértéktől eltérő részt tartja meg (a tárolt érték így minimális, és az alapértékek frissülhetnek).
function diffFromDefaults(config) {
  const out = { texts: {}, optionLists: {} };
  Object.entries(config.texts || {}).forEach(([key, value]) => {
    if (value !== DEFAULT_TEXTS[key]) out.texts[key] = value;
  });
  Object.entries(config.optionLists || {}).forEach(([list, entries]) => {
    if (JSON.stringify(entries) !== JSON.stringify(DEFAULT_OPTION_LISTS[list])) out.optionLists[list] = entries;
  });
  return out;
}

// Toleráns összefésülés olvasáskor: a hibás vagy ismeretlen tárolt rész eldobódik, az alapérték él tovább.
function mergePlannerConfig(stored) {
  const merged = defaults();
  if (!isPlainObject(stored)) return merged;
  if (isPlainObject(stored.texts)) {
    Object.entries(stored.texts).forEach(([key, value]) => {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEXTS, key)) return;
      try { merged.texts[key] = validateText(key, value); } catch { /* alapérték marad */ }
    });
  }
  if (isPlainObject(stored.optionLists)) {
    Object.entries(stored.optionLists).forEach(([list, entries]) => {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_OPTION_LISTS, list)) return;
      try { merged.optionLists[list] = validateList(list, entries); } catch { /* alapérték marad */ }
    });
  }
  return merged;
}

// Mentési minta: a beérkező részleges módosítást az aktuális effektív konfigra fésüli, majd szigorúan ellenőriz és az eltérést adja vissza.
function applyPatch(currentEffective, patch, { replace = false } = {}) {
  const checked = validatePlannerConfig(patch);
  const base = replace ? defaults() : clone(currentEffective || defaults());
  Object.assign(base.texts, checked.texts);
  Object.assign(base.optionLists, checked.optionLists);
  return diffFromDefaults(base);
}

// A vásárlói felület számára: csak az aktív opciók, azonosítóval és felirattal.
function publicView(stored) {
  const merged = mergePlannerConfig(stored);
  const optionLists = {};
  LIST_KEYS.forEach((list) => {
    optionLists[list] = merged.optionLists[list].filter((entry) => entry.active).map(({ id, label }) => ({ id, label }));
  });
  return { texts: merged.texts, optionLists };
}

function mixedGroupLabels(stored) {
  const labels = new Set(['Vegyes csoport']);
  const entry = mergePlannerConfig(stored).optionLists.group.find((option) => option.id === 'vegyes');
  if (entry) labels.add(entry.label);
  return labels;
}

module.exports = {
  PlannerConfigError,
  TEXT_META,
  DEFAULT_TEXTS,
  TEXT_KEYS,
  OPTION_META,
  DEFAULT_OPTION_LISTS,
  LIST_KEYS,
  MAX_ITEMS,
  defaults,
  validatePlannerConfig,
  diffFromDefaults,
  mergePlannerConfig,
  applyPatch,
  publicView,
  mixedGroupLabels,
  cleanLine
};
