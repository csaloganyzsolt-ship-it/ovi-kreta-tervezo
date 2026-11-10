# OviTervező – Adatok és beállítások (`tervezo.html`)

A tervező 4 lépésből áll. A lépések neve a felületen: **1. Alapadatok**, **2. A mi csoportunk**, **3. Konkrétumok és kívánságok** (a „Speciális beállítások” itt, lenyitható blokkban található), **4. Összegzés és generálás**.

A „Mező” oszlop a `data-field` / `id` azonosítót adja. A payload-kulcs a `buildGenerationPayload()` által a `POST /api/generate` végpontnak küldött JSON mezője. A „Kötelező” oszlop azt jelzi, hogy a felület kikényszeríti-e a kitöltést; jelenleg egyetlen mező kitöltését sem blokkolja az űrlap, az üres mezőket a backend „nincs megadva” értékként kezeli.

## 1. lépés – Alapadatok

| Mező | Típus | Kötelező | Alapérték | Payload-kulcs | Megjegyzés |
|---|---|---|---|---|---|
| Időtartam (`.segment[data-group="duration"]`) | rádiószerű gombok | igen (mindig van kiválasztva) | `Napi` | `duration`, `planMode` | `Napi` = 1 napi tervezet; `Heti` = heti keretterv + a kiválasztott napok részletes tervezete |
| Napválasztó (`#weeklyDayPicker`, `.day-chip[data-day]`) | 5 kapcsolható chip | igen, legalább 1 nap | mind az 5 nap aktív | `selectedDays` | Csak `Heti` esetén látszik (`#weeklySettingsPanel`). Az utolsó aktív nap nem kapcsolható ki, figyelmeztetés: „Legalább egy napot ki kell választani!”. A sorrend mindig hétfő–péntek |
| `group` | select | igen (mindig van értéke) | `Nagycsoport` | `group` | Kiscsoport, Középső csoport, Nagycsoport, Vegyes csoport |
| `kindergarten-name` | szöveg | nem | üres | `kindergartenName` | |
| `teacher-name` | szöveg | nem | üres | `teacherName` | |
| `group-name` | szöveg | nem | üres | `groupName` | |
| `theme` | szöveg | nem | üres | `theme` | Téma / projekt címe |
| `tevekenyseg-forma` | szöveg | nem | üres | `tevekenysegForma` | |
| `available-tools` (`#availableTools`) | szövegterület | nem | üres | `availableTools` | Ha üres, a modell általános óvodai alapeszközökkel tervez |
| `elozmeny` | szövegterület | nem | üres | `elozmeny` | A tevékenység előzménye |
| `date-value` (`#dailyDateField`) | dátum | nem | üres | `dateValue` | Csak `Napi` esetén |
| `week-value` (`#weeklyDateField`) | hét (`type="week"`) | nem | üres | `dateValue` | Csak `Heti` esetén |
| `data-focus-area` jelölőnégyzetek | checkbox-csoport | nem | egyik sincs | `focusAreas` | Külső világ tevékeny megismerése; Verselés, mesélés; Ének, zene, énekes játék; Rajzolás, mintázás, kézimunka; Mozgás |
| OH-kompatibilis sablonkifejezések | `.chip` kapcsolók | nem | „finommotorika fejlesztése” és „szociális kompetenciák erősítése” aktív | `selectedGoals` | A három lépés chipjei közös listába kerülnek |
| `custom-note` | szövegterület | nem | üres | `customNote`, `customNotes.primary` | Saját megjegyzés |

## 2. lépés – A mi csoportunk

| Mező | Típus | Kötelező | Alapérték | Payload-kulcs | Megjegyzés |
|---|---|---|---|---|---|
| `child-count` | szám (min. 1) | nem | üres | `childCount` | |
| `energy-level` | csúszka 0–100 | igen (mindig van értéke) | `65` | `energyLevel` | |
| `has-preschoolers` | kapcsoló (checkbox) | igen (mindig van értéke) | bekapcsolva | `hasPreschoolers` | Iskola-előkészítős gyermekek |
| Sablonkifejezések (pl. figyelem tartósítása, differenciált feladatok) | `.chip` kapcsolók | nem | „figyelem tartósítása” és „differenciált feladatok” aktív | `selectedGoals` | |
| `data-sni-label` jelölőnégyzetek | checkbox-csoport | nem | egyik sincs | `specialNeeds` | Figyelemzavar / hiperaktivitás; Beszédfejlődési elmaradás; Autizmus spektrumzavar; Mozgásfejlődési elmaradás |
| `group-note` | szövegterület | nem | üres | `customNotes.groupNote`, `specialNeeds` | Saját válasz / más szempont |

Gyermekek személyes adatait az űrlap nem kéri be.

## 3. lépés – Konkrétumok és kívánságok

| Mező | Típus | Kötelező | Alapérték | Payload-kulcs | Megjegyzés |
|---|---|---|---|---|---|
| `required-text` | szövegterület | nem | üres | `customNotes.requiredText` | Kötelező mese, vers vagy dal |
| `idea-note` | szövegterület | nem | üres | `customNotes.ideaNote` | Saját ötletek, eszközök |
| Célkifejezések | `.chip` kapcsolók | nem | „megfigyelés fejlesztése” és „ritmusérzék fejlesztése” aktív | `selectedGoals` | |
| Korábbi terv behívása (`#loadPreviousBtn`) | gomb | nem | – | – | A böngészőben mentett korábbi tervekből tölt vissza (helyi tárolás) |
| `custom-request` | szövegterület | nem | üres | `customNotes.customRequest` | |
| `detail-level` | csúszka 0–100 | igen (mindig van értéke) | `68` | `detailLevel` | Generálás hossza és kidolgozottsága |
| `premium-quality` | kapcsoló | nem | letiltva („Hamarosan elérhető”) | `requestedModel` | Mindig a `gemini-3.1-pro-preview` modell fut |

### Speciális beállítások (lenyitható, `#advancedSettings`)

| Mező | Típus | Kötelező | Alapérték | Payload-kulcs | Megjegyzés |
|---|---|---|---|---|---|
| `blacklist` (`#blacklist`) | szövegterület | nem | üres | `blacklist` | Tiltások: amit a modell nem használhat |
| `show-literature` | checkbox | nem | kikapcsolva | `showLiteratureAtBottom` | Irodalomjegyzék megjelenítése |
| `weeklyProgressionType` | select | csak `Heti` esetén releváns | `progressive` | `weeklyProgressionType` | `progressive` (szervesen egymásra épülő projekt) vagy `area_focused` (klasszikus területváltó) |
| `fridayClosingType` | select | csak `Heti` esetén releváns | `Kiállítás a csoportszobában` | `fridayClosingType` | Kiállítás a csoportszobában; Dramatikus közös játék; Ünnepi szokás/Kóstoló; Projektzáró élményséta. Csak akkor érvényesül, ha a Péntek ki van választva |

## 4. lépés – Összegzés és generálás

| Mező | Típus | Kötelező | Alapérték | Payload-kulcs | Megjegyzés |
|---|---|---|---|---|---|
| Kimeneti forma (`.mode-pill[data-mode]`) | gombok | igen (mindig van kiválasztva) | `Kréta` | `outputMode` | `Kréta` vagy `Szülői tájékoztató` |
| Dokumentum beállítások (`data-export-section`) | 5 checkbox | nem | mind bekapcsolva | – (kliensoldali) | Összefoglaló, Célok, Tevékenység kidolgozása, Differenciálás, Eszközök. Fizetés előtt a „Tevékenység kidolgozása” kikapcsolt és letiltott |
| Tájolás (`#pageOrientationSelect`) | select | nem | `portrait` | – (kliensoldali) | Álló / Fekvő |
| Oldalmargó (`#pageMarginSelect`) | select | nem | `comfortable` | – (kliensoldali) | Kompakt / Normál / Tágas |
| Teszt kézbesítés (`#testDeliverEmail`) | e-mail | csak a teszt (GitHub Pages) környezetben | üres | – | Fizetés nélküli e-mailes kézbesítés, élesben nem jelenik meg |

### Az ellenőrző kártya (`renderSummaryChecklist()`)

A kártya a `buildGenerationPayload()` aktuális értékeiből épül, a fizetés és a generálás előtt. Üres szöveges mező helyén „Nincs megadva” áll.

| Szakasz | Sorok |
|---|---|
| Alapadatok | Óvoda; Óvodapedagógus; Csoport neve; Korcsoport; **Időtartam** (Napi, vagy `Heti tervezet (Hétfő, Kedd, Csütörtök)` – a kiválasztott napokkal); Hét / Dátum (az időtartamtól függően); Téma; Tevékenységi forma; Előzmény; Nevelési területek; Saját megjegyzés |
| Csoport profilja | Gyereklétszám; Energiaszint (x / 100); Iskola-előkészítő gyermekek (igen/nem); Speciális nevelési igények (SNI); Csoportmegjegyzés |
| Eszközkészlet | Rendelkezésre álló eszközök (üresen: az alapfelszerelésekre vonatkozó tájékoztató szöveg) |
| Konkrétumok | Kötelező mese/vers/dal; Saját ötletek, eszközök; Kiválasztott célkifejezések; Külön kérés |
| Speciális beállítások | Tiltólista; Irodalomjegyzék megjelenítése (igen/nem); Heti építkezés típusa; Pénteki zárás formája (a két utóbbi `Napi` esetén „(csak heti tervnél érvényes)” megjegyzéssel) |
| Generálási beállítások | Részletességi szint (x / 100); Modell; Kimeneti forma |

## Heti tervezet: napválasztás, generálás és ár

- A `Heti` időtartam mindig heti keretterv + napi bontás. Külön jelölőnégyzet nincs; a payloadban az `includeDailyBreakdown` ennek megfelelően `true`, a `selectedDays` a kijelölt napok tömbje (hétfő–péntek sorrendben).
- A backend (`getSelectedDays` a `server.js`-ben) csak az érvényes napneveket fogadja el; hiányzó vagy üres listánál mind az 5 nap készül.
- A Gemini prompt és a válasz-ellenőrzés pontosan a kiválasztott napok számát várja (`napok` és `heti_keretterv.teruletek_heti_eloszlasa`); eltérő darabszámnál hibaüzenet jelenik meg, csonka dokumentum nem készül.
- A dokumentum-összeállítás (megjelenítés, PDF, DOCX, ZIP) a visszakapott `napok` tömb alapján dolgozik, így csak a kiválasztott napok oldalai készülnek el.
- Ár: a heti tervezet egységesen a heti részletes csomag (`weekly_detailed`, bruttó 890 Ft), függetlenül a kiválasztott napok számától. A napi tervezet bruttó 390 Ft. Az árak forrása a szerver (`services/stripeService.js`).

## Jövőbeli bővítési lehetőségek

Ezek ötletek, jelenleg nincsenek megvalósítva.

| Ötlet | Leírás | Érintett rész |
|---|---|---|
| Egyéni fejlesztési tervek | Gyermekenkénti fejlesztési célok bevonása, személyes adat nélküli (pl. betűjeles) megjelöléssel | 2. lépés, prompt |
| Vegyes korcsoport bontás | Külön célok és differenciálás a kis-, közép- és nagycsoportos gyermekekhez egy csoporton belül | `group` mező, prompt |
| Egyedi intézményi napirend | A saját napirend (étkezés, pihenő, szabad játék) időkereteinek megadása, amelyhez az `ido` oszlop igazodik | 3. lépés, prompt |
| Heti árazás napok szerint | Kevesebb nap kiválasztásakor kedvezményes csomag | `services/stripeService.js` |
| Több hét / havi terv | Egymásra épülő hetek egy projekten belül | `duration`, prompt |
| Saját fejléc és logó | Az óvoda arculatának megjelenítése a dokumentumban | exportálás |
| Szülői tájékoztató testreszabása | Hangnem és hosszúság választása | `outputMode` |
| Sablonok mentése | Beállításcsomagok névvel mentése és újrahasznosítása (jelenleg csak az utolsó profil és a korábbi tervek mentődnek böngészőben) | helyi tárolás |
| Ünnepek és hagyományok naptára | Az időpont alapján javasolt témák | 1. lépés |
