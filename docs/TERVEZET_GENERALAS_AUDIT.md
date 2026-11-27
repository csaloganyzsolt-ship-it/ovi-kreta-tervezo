# Tervezetgenerálás és dokumentum-előállítás – műszaki és tartalmi audit

Állapot: csak olvasási audit, alkalmazáskód nem módosult. Hivatkozások: `fájl` › függvény.

---

## 1. Áttekintés és tervezettípusok

A rendszerben két **mód** (`planMode`: `standard` | `academic`) és két **időtartam** (`duration`: `Napi` | `Heti`) van. Ebből a szerver (`backend/services/pricing.js`) és a kliens (`frontend/js/tervezo-paywall.js` › `planKind`, `PAYWALL_PRICES`) az alábbi termékkulcsokat képzi.

| Termékkulcs | Mikor jön létre | Ár (bruttó) | Eredmény-JSON | Dokumentumok |
|---|---|---|---|---|
| `daily` | standard + Napi | 390 Ft | napi séma | 1 db (`ovi-kreta-terv`) |
| `weekly` („heti alapcsomag”) | standard + Heti, **`includeDailyBreakdown` nélkül** | 390 Ft | napi séma `duration:'Heti'`-vel | 1 db |
| `weekly_detailed` | standard + Heti + `includeDailyBreakdown` | 890 Ft | `is_weekly` séma (keretterv + napok) | 1 keretterv + legfeljebb 5 napi dokumentum, ZIP |
| `academic_daily` | academic + Napi | 690 Ft | academic napi séma („Foglalkozási/tevékenységi terv”) | 1 db |
| `academic_weekly` | academic + Heti | 690 Ft | `is_thematic` séma („Tematikus terv”, **pontosan 1 hét**) | 1 db, fekvő A4 |

Fontos megállapítások:

1. **A „heti alapcsomag” (`weekly`, 390 Ft) a felületről gyakorlatilag elérhetetlen.** `tervezo-form.js` › `getWeeklyDailyBreakdown()` minden standard Heti kijelölésnél `true`-t ad, így a kliens mindig `weekly_detailed`-et kap. A `weekly` csak közvetlen API-hívással jön létre. Ilyenkor a napi promptot kapja, `duration:'Heti'`-vel, vagyis ez nem heti összesítő, hanem egy napi dokumentum heti címkével.
2. **Árazás forrása:** a szerver (`system_settings.pricing`, 4 kategória: `daily`, `weekly`, `academic_daily`, `academic_weekly`). A `settingsService` alapérték `weekly: 890`; a `weekly_detailed` a `weekly` kategóriába esik, a `weekly` (alapcsomag) pedig a `daily` kategóriába. A kliens `PAYWALL_PRICES` csak megjelenítés. A szerver a mérvadó, egyezésüket teszt ellenőrzi.
3. **Technikai különbség:** mind az öt típus **egyetlen Gemini-hívás**, de eltér a prompt (`buildPrompt` / `buildWeeklyPrompt` / `academicPlan`), a `maxOutputTokens`, a timeout, a normalizáló és a dokumentumsablon.
4. **Az academic mód felülírja a heti bontást:** academic módban `includeDailyBreakdown` hamis, a Heti = tematikus mátrix, napi kidolgozás nélkül.

---

## 2. Bemeneti adatok (űrlaptól a backendig)

### 2.1. Kliens: `tervezo-form.js` › `buildGenerationPayload()` → `POST /api/generate`

A `tervezo-generate.js` (~181–185. sor) `preview:true`-val egészíti ki, ha a paywall aktív.

| Mező | Forrás az űrlapon | Típusok |
|---|---|---|
| `duration` | Napi/Heti szegmens | mind |
| `planMode`, `planKind` | módválasztó kártya; `planKind` = Heti→`weekly` | mind |
| `includeDailyBreakdown` | **nem külön pipa**: `Heti && !academic` | csak heti standard |
| `selectedDays` | napválasztó chipek (alap: H–P) | heti |
| `weeklyProgressionType` | `progressive` / `area_focused` | heti |
| `fridayClosingType` | legördülő (alap: „Kiállítás a csoportszobában”) | heti |
| `weeklyFocusAreas` | terület → nap hozzárendelés (`{nap:[terület]}`) | heti |
| `weeklyAreaAssignments` | terület → nap (`{terület:nap}`) | heti |
| `focusAreas` | nevelési terület kártyák | mind |
| `studentName` | csak academic | academic |
| `theme`, `group`, `groupName`, `kindergartenName`, `kindergartenProfile`, `teacherName` | szabad szöveg / legördülő | mind |
| `dateValue` | napi: dátum; heti: hét (`week-value`) | mind |
| `tevekenysegForma`, `elozmeny` | szöveg | mind |
| `childCount`, `energyLevel`, `hasPreschoolers` | szám / szegmens / pipa | mind |
| `availableTools`, `blacklist` | szabad szöveg | mind |
| `iktEnabled`, `iktTools`, `iktCustomApp`, `iktSummary` | IKT panel | mind |
| `selectedGoals`, `specialNeeds` (SNI) | aktív chipek / pipák | mind |
| `customNote`, `customNotes{primary, groupNote, requiredText, customRequest, specialNeeds}` | szövegmezők | mind |
| `detailLevel` (30 | 68), `detail` (`concise`|`detailed`) | részletesség szegmens | mind |
| `showLiteratureAtBottom` | pipa (academic: mindig `true`) | mind |
| `previousPlanContext` | csatolt korábbi terv (max 20 000 kar.) | mind |
| `contact_website`, `turnstileToken` | honeypot / botvédelem | mind |

### 2.2. Szerver: `backend/services/generateValidation.js`

Fehérlistás másolat (ismeretlen kulcs eldobva), hosszkorlátokkal: `theme` 300, `elozmeny` 4000, `childCount` 1–40, `detailLevel` 0–100, `focusAreas` 12, `specialNeeds` 20, `selectedGoals` 30, `iktTools` 20, `previousPlanContext` 20 000 stb. Honeypot + Turnstile ellenőrzés a validáció után.

### 2.3. Bekért, de a promptban (részben) fel nem használt mezők

| Mező | Megállapítás |
|---|---|
| `iktSummary` | Validálva, de a `buildPrompt` `settings` objektumában **nincs**; az IKT-hez `iktEnabled`, `iktTools`, `iktCustomApp` kerül be. Redundáns. |
| `detail` | Validálva, a promptban nincs; csak a `detailLevel` számít. Redundáns. |
| `weeklyAreaAssignments` | Validálva (max 12), a promptban nincs; csak a `weeklyFocusAreas` megy be. Redundáns, ráadásul inverz reprezentáció. |
| `selectedDays` | Heti breakdownnál meghatározza a napok számát (a `normalizeWeeklyResponse` pontosan ennyit vár). A heti keretterv fejlécében és a dokumentumban nem jelenik meg külön. |
| `customNote` | Duplán szerepel (`customNote` és `customNotes.primary`). |
| `childCount`, `energyLevel`, `hasPreschoolers`, `kindergartenProfile` | Bekerülnek a promptba. A dokumentumfejlécben nem jelennek meg (csak óvoda, pedagógus, csoport). Ez elfogadható. |
| `studentName` | Csak academic fejlécben használatos (`request.studentName || request.teacherName`). |
| `fridayClosingType` | Csak a heti promptban számít; academic/napi módban figyelmen kívül marad (a kliens akkor is elküldi az alapértéket). |
| `request.topic` | A logok erre hivatkoznak, de a mező neve `theme`, ezért a naplókban üres lehet. |

---

## 3. Prompt-felépítés és Gemini-hívások

### 3.1. Közös: `backend/services/geminiService.js` › `callGemini`

- **Modell:** `settings.ai_config.model` (`settingsService.resolveAiModel`, alap `gemini-3.1-pro-preview`); a kliens `requestedModel` csak a FAST_MODEL lehet.
- **`systemInstruction`** = `ai_config.system_prompt` (alap: `defaultSystemPrompt.js` = BASE_PROMPT + `LITERATURE_RULES`; adminból szerkeszthető, max 100 000 kar.) + fix záró mondat (teljes magyar foglalkozásterv, egyetlen valid JSON, nincs markdown) + `LITERATURE_PRIORITY_RULE` + opcionális blacklist-szabály.
- **`contents`:** egyetlen user rész = a típusonkénti prompt.
- **`generationConfig`:** `temperature: 0.9`, `topP: 0.95`, `maxOutputTokens: 12288` (heti breakdown és academic: 16384), `responseMimeType: 'application/json'`.
- **Nincs `responseSchema`**: a szerkezetet a prompt szövege írja le, a szigorú szerveroldali olvasók ellenőrzik utólag.
- Timeout: 120 s (heti és academic: 290 s). Újrapróbálkozás: max. 2×, csak 500/503/529-re.
- `thought` részek kiszűrve; `finishReason === MAX_TOKENS` vagy bármely nem-STOP ok, illetve üres szöveg → **hiba** (nincs csonka dokumentum, helyes: nincs csendes fallback).
- **Generálásonként pontosan 1 API-hívás**, minden típusnál.

### 3.2. Napi: `backend/server.js` › `buildPrompt` (~369)

- A teljes beállításkészlet JSON-ként a promptban (`theme, group, kindergartenName, kindergartenProfile, teacherName, groupName, dateValue, duration, planMode, includeDailyBreakdown, selectedDays, weeklyProgressionType, fridayClosingType, tevekenysegForma, elozmeny, childCount, energyLevel, hasPreschoolers, focusAreas, weeklyFocusAreas, selectedGoals, specialNeeds, customNote, availableTools, blacklist, iktEnabled, iktTools, iktCustomApp, customNotes, detailLevel, outputMode, previousPlanContext (≤3000), showLiteratureAtBottom`).
- Szabályblokkok: `buildBlacklistRule`, `buildKindergartenProfileRule`, `buildIktRule`, `buildMathematicsRule`, `buildPreviousPlanContextRule`, `MIXED_GROUP_RULE` (vegyes csoport: 3 szintű differenciálás), `NO_PLATFORM_NAME_RULE`, `buildLiteratureSwitchLine`.
- `getDetailProfile(detailLevel)`: ≤35 tömör; 36–79 (alap 68) 2–3 bekezdés; ≥80 min. 3 bekezdés, 1400–2000 szó. **A felület csak 30 és 68 értéket küld**, tehát a „1400–2000 szavas” ág a felületről sosem érhető el.
- A `kidolgozas_tablazat` 5 fázisát (szervezés, ráhangolódás, fő tevékenység, gyakorlás/differenciálás, összegzés) a rendszerprompt írja elő.

### 3.3. Heti: `buildWeeklyPrompt` (~304–360)

- Akkor aktív, ha `isWeeklyBreakdown` (Heti + `includeDailyBreakdown` + nem academic).
- Plusz szabályok: `buildWeeklyFocusAreasRule`, `weeklyProgressionType` (`progressive` = szervesen egymásra épülő projekt; `area_focused` = klasszikus területváltó), `fridayClosingType`.

**Heti tervezet működése (a kért külön kérdések):**

1. **Egyetlen hívás vagy több?** Egyetlen Gemini-hívásban készül a heti összesítő (`heti_keretterv`) **és** az összes (max. 5) napi terv. Nincs láncolt vagy párhuzamos hívás.
2. **Okoz-e tömörítést?** Igen, szerkezetileg:
   - Egy hívás kimeneti plafonja 16 384 token, így egy napra ≈ 3 000 token jut. A külön Napi tervezetnél 12 288 token jut 1 napra, és a keretterv + 5 nap együtt ugyanazon a plafonon osztozik.
   - A `detailLevel`-ből adódó „2–3 bekezdés / 1400–2000 szó” utasítás egy napra értelmeződik, a modell azonban 5 napot ír. Gyakorlatban a napi táblázatok rövidebbek.
   - **A heti napi sorok sémája lényegesen szűkebb**: csak `nap_neve`, `tevekenyseg_forma`, `napi_cel`, `kidolgozas_tablazat`. Nincs napi `elozmeny`, `tema`, `nevelesi_feladatok`, `didaktikai_feladatok`, `kepessegfejlesztes`, `modszerek`, `eszkozok`, `felhasznalt_irodalom`. A heti napi terv tehát **nem teljes értékű, önálló napi tervezet**, csak egy táblázat és egy cél.
3. **Összefüggés biztosítása:** kizárólag prompt-szinten: `weeklyProgressionType` szabály, `weeklyFocusAreas` kiosztás, a rendszerprompt „szerves láncolat” és „napok nem lehetnek egymás mechanikus másolatai” szabálya. **Nincs kényszerített láncolás**: a napok nem kapják meg az előző nap kimenetét, nincs szerveroldali ellenőrzés a hivatkozásokra, és nincs ismétlés-detektálás. Az önállóság a szűk napi séma miatt gyenge, mert a napok közös kontextusa (téma, előzmény, eszközök) csak a keretterv fejlécében él.

### 3.4. Oktatási célú: `backend/services/academicPlan.js`

- **Napi academic** („Foglalkozási/tevékenységi terv”, ONAP-struktúra): prompt a mezőkről (`tartalom{uj_anyag, ismetles, keszsegfejlesztes, zenehallgatas}` stb.), min. 3 táblázatsor, `ido` „N p” alakban; `SOURCE_RULES` (ÉNÓ/KEE/ONAP forráskódok, szerzői jog), `TYPOGRAPHY_RULES` (`*dőlt*`, `**félkövér**`).
- **Heti academic** („Tematikus terv”): `THEMATIC_WEEK_COUNT = 1`, 7 oszlopos fekvő mátrix, 6 ONAP-terület; a tételek „egy-két soros” kifejtésűek.
- **Miért lehet hiányos vagy sekély a végeredmény:**
  1. Egyetlen hívás, 16 384 token, akárcsak a többi típusnál; a mélységet nem lehet léptékezni.
  2. A tematikus terv **nem tartalmaz napi kidolgozást**, csak mátrixtételeket. Egy egyetemi/portfólió célú hallgató számára ez módszertanilag kevés.
  3. A `kidolgozas_tablazat` `ido` mezői összeadódnak (`ossz_ido_perc`), de **nincs ellenőrizve** a tényleges foglalkozási időhöz vagy a korcsoport normaidejéhez (pl. nagycsoport ≈ 30 perc). A modell által adott összeg bármi lehet.
  4. A `detailLevel` az academic ágban nem skálázza a hosszt a standard ág logikája szerint.
  5. Nincs kötelező didaktikai elemzés (reflexió, differenciálás indoklása, értékelési szempontok, szakirodalmi hivatkozás a szövegben), a séma erre nem tartalmaz mezőt.
  6. A „heti” academic mód csak 1 hetet támogat, többheti tematikus terv nincs.

---

## 4. Visszakapott JSON-struktúra

### 4.1. Napi (`kidolgozas_tablazat` alapú)

| Kulcs | Típus | Szerep |
|---|---|---|
| `tevekenyseg_forma` | string | a foglalkozás formája |
| `elozmeny` | string | előzmény |
| `tema` | string | téma |
| `cel` | string | cél |
| `nevelesi_feladatok` | string | nevelési feladatok |
| `didaktikai_feladatok` | string | didaktikai feladatok |
| `kepessegfejlesztes` | string | képességfejlesztés |
| `modszerek` | string[] | módszerek listája |
| `eszkozok` | string[] | eszközök listája |
| `kidolgozas_tablazat` | `[{ido, tevekenyseg_menete: string[], modszerek_megjegyzesek}]` | a foglalkozás menete (5 fázis) |
| `felhasznalt_irodalom` | string | irodalomjegyzék |
| *szerver adja:* `summary`, `showLiteratureAtBottom`, `request`, `generationId` | | |

### 4.2. Heti (`is_weekly: true`)

```
{ is_weekly, summary, showLiteratureAtBottom,
  heti_keretterv: { tema, heti_fo_cel, nevelesi_feladatok, didaktikai_feladatok,
                    teruletek_heti_eloszlasa: [{nap, fo_terulet, csoportos_tevekenyseg, mikrocsoportos_tevekenyseg}],
                    eszkozok: string[], felhasznalt_irodalom },
  napok: [{ nap_neve, tevekenyseg_forma, napi_cel,
            kidolgozas_tablazat: [{ido, tevekenyseg_menete[], modszerek_megjegyzesek}] }] }
```
- A `mikrocsoportos_tevekenyseg` a `csoportos_tevekenyseg` szerveroldali másolata (`normalizeWeeklyResponse`).
- A `napok` hossza pontosan `selectedDays.length` kell legyen, különben hiba.

### 4.3. Oktatási célú

**Napi:** a napi séma + `tartalom{uj_anyag, ismetles, keszsegfejlesztes, zenehallgatas}`; a szerver hozzáadja: `planMode:'academic'`, `ossz_ido_perc`, `summary`, `showLiteratureAtBottom:true`.

**Tematikus:**
```
{ is_thematic, tema, summary, felhasznalt_irodalom, megjegyzes_egyeb_tevekenysegek (1 hétnél null),
  hetek: [{ het_szama, datum, foteme, altema,
            teruletek: { kulso_vilag[], matematika[],
                         verseles_meseles{versek, ismetles, mesek, szolasok_kozmondasok, talalos_kerdesek, nyelvtorok},
                         enek_zene{enekes_jatek, kiszamolo, zenehallgatas}, rajzolas[], mozgas[] },
            keretrendszer: { celok, feladatok, kiemelt_fejlesztesi_terulet{6 kulcs}, modszerek, eszkozok } }] }
```
A `is_thematic`, `het_szama`, `datum` (`weekRangeLabel`) és `summary` szerveroldali kiegészítés.

### 4.4. Szerveroldali utófeldolgozás

- **Validáció:** `responseReaders.js` (`readText`, `readStringArray`, `normalizeTable`) szigorú; hiányzó/hibás mező → hiba. **Nem pótol és nem csonkol** (a kód „never shorten text” elve). Egyetlen pótlás a `summary` és a `mikrocsoportos_tevekenyseg`.
- **Tárolás memóriában:** `planStore` `plans` Map (max 500, TTL 48 óra, kivéve feloldott/felhasználóhoz rendelt).
- **Tárolás Supabase-ben:** `documents` tábla: `document_id` (PK), `plan_mode` (`academic`|`standard`), `unlocked`, `data` jsonb = `{plan, meta}`, `user_id`, `user_email`, `created_at`, `updated_at`. A `plan` a **teljes nyers terv** + `request` + `generationId`; a maszkolt mirror nem tárolódik. A `request` sanitizálva (tiltott kulcsok kihagyva, stringek ≤4000 kar., 16 000 kar. fölött a nagy szabad szövegek kimaradnak). A `generations`/`orders` az árat és a rendelést tartja; a tervet a `documents` (`orders.documentId` hivatkozik rá).
- **Fizetés előtti előnézet:** `shouldLockPlan` (`payload.preview === true` vagy `PAYWALL_ENABLED=true`) → `planStore.createMirrorPlan` latin töltelékszöveggel (`generateFillerText`), azonos szerkezettel, `locked_meta{is_locked, table_count, activity_count, summary_text}`. Feloldás: `planStore.updateDocument({unlocked:true})` (fizetés, webhook, kupon); a teljes tervet a `payment.js` `planData` mezője adja vissza.

### 4.5. Maszkolási rés (üzleti kockázat, jelölendő)

A `createMirrorPlan` csak a táblázatsorokat és az irodalmat maszkolja. **Olvashatóan kimegy az előnézetben:**

- Napi: `cel`, `nevelesi_feladatok`, `didaktikai_feladatok`, `kepessegfejlesztes`, `modszerek`, `eszkozok`, `tema`, `elozmeny`, `tevekenyseg_forma`.
- Heti: a teljes `heti_keretterv` (heti fő cél, feladatok, területek heti elosztása, eszközök), valamint minden `napok[].napi_cel` és `tevekenyseg_forma`. A heti keretterv ezzel gyakorlatilag ingyen letölthető/kimásolható.
- Academic napi: `tartalom{...}`, `modszerek`, `eszkozok`.
- Thematic: `foteme`, `altema`.

A kliens oldali paywall UI-kapu is csak a megjelenítést zárja; a szerveroldali visszatartás a mirror szerkezet miatt részleges.

---

## 5. Dokumentumok előállítása

### 5.1. Architektúra (a legfontosabb tény)

**A frontend HTML a kanonikus forrás.** A `.docx` és a `.pdf` is ugyanabból a HTML-ből készül, ezért ami nincs a HTML-ben, az sem a Wordben, sem a PDF-ben nem jelenik meg.

| Cél | Fájl › függvény |
|---|---|
| Dokumentumlista (hány fájl, fájlnév, azonosító) | `tervezo-preview.js` › `getDocumentList(result)` |
| Tájolás (csak thematic fekvő) | `getDocOrientation` |
| HTML tartalom (napi/heti/keret/nap) | `tervezo-preview.js` › `buildDocumentHtml(result, request, docId)` |
| Academic napi / tematikus HTML | `tervezo-academic.js` › `buildAcademicDailyHtml`, `buildThematicHtml`, `thematicMatrixTable`, `thematicFrameHtml`, `thematicNotesHtml`, `academicProcessTable` |
| Tevékenységtábla (Idő / felépítés / módszerek) | `buildActivityTable` |
| Képernyős előnézet + A4 tördelés | `renderResultDocument`, `paginateDocument` |
| Zárolt szakasz kártya | `buildLockedBoundaryCard`, `applyPaywall` |
| Kliensoldali szerkezeti validáció | `validateGeneratedPlan` |
| HTML → köztes modell | `tervezo-export.js` › `buildExportModel(docId)` (`.doc-header`, `.doc-meta-block`, `H3`, `TABLE`, `P`) |
| **PDF** | `buildPdfDefinition` → `renderPdfBlob` (pdfmake) |
| **DOCX** | `renderDocxBlob` (docx lib), azonos modellből |
| **ZIP (heti)** | `buildZipBlob` (JSZip: mindegyik dokumentumhoz PDF + DOCX) |
| Letöltés (in-app böngésző kezelés) | `downloadBlob` |
| **E-mail melléklet (kliens)** | `tervezo-paywall.js` › `buildDeliveryFiles()` + `deliverPurchaseEmail()` → `POST /api/deliver/:id` |
| **E-mail melléklet (szerver, admin „Csomag küldése”)** | `backend/services/documentExport.js` › `buildDeliveryFiles(plan)`: a frontend szkripteket (`tervezo-core, tervezo-academic, tervezo-preview, tervezo-export`) jsdomban futtatja; hívja: `routes/admin.js` › `loadPlanAttachments` |
| Csatolmány-ellenőrzés | `mailService.sanitizeAttachments` (max 20 fájl, 18 MB) |
| Kézbesítés | `routes/payment.js` › `deliverPurchase` (~307), `deliverCouponPurchase` |

Az e-mailes melléklet tehát ugyanaz a PDF + DOCX, mint a letöltés (napi: PDF + DOCX; heti: `OviTervezo_heti_csomag.zip`). A szerver és a kliens azonos kódot használ, így a két út tartalmilag egyezik. Karbantartási kockázat: a szerver jsdom-környezet a frontend szkriptek globáljaitól függ.

### 5.2. Mező-hozzárendelési térkép

#### A) Napi tervezet (standard) – `buildDocumentHtml` utolsó ága

Dokumentumcím: „Napi tervezet”.

| Dokumentumrész | JSON/forrás mező |
|---|---|
| Projekt (összegző sor) | `result.summary` (vagy `tema • group • duration • dateValue`) |
| Meta: Óvoda | `request.kindergartenName` |
| Meta: Óvodapedagógus | `request.teacherName` |
| Meta: Csoport | `request.groupName` ‖ `request.group` |
| Meta: Nevelési terület | `request.focusAreas` (nem a Gemini válaszából!) |
| Meta: Forma | `tevekenyseg_forma` |
| Meta: Előzmény | `elozmeny` |
| Meta: Téma | `tema` |
| Meta: Cél | `cel` |
| Meta: Eszközök | `eszkozok` (vesszővel) |
| Cél- és feladatrendszer | `nevelesi_feladatok`, `didaktikai_feladatok`, `kepessegfejlesztes`, `modszerek` (vesszővel) |
| A tevékenység kidolgozása (3 oszlopos táblázat) | `kidolgozas_tablazat[].ido`, `.tevekenyseg_menete`, `.modszerek_megjegyzesek` |
| Felhasznált irodalom | `felhasznalt_irodalom` (csak ha a „irodalom megjelenítése” pipa be van kapcsolva) |

**Kimaradó adat:** `request.dateValue` (a napi dokumentumon nincs dátum, csak a `summary` tartalmazza), `request.childCount`, `request.energyLevel`, `request.specialNeeds`/SNI és `selectedGoals` (nem szerepelnek a fejlécben). Az `elozmeny` a meta-táblában, nem külön fejezetben van. A cím a `request.planMode === 'weekly'` feltételtől függ, ami sosem teljesül (a planMode értéke standard/academic), így ez holt ág. A `showLiterature` az **élő DOM pipától** függ (`document.querySelector('[data-field="show-literature"]')`), nem a mentett értéktől: a szerveroldali jsdom-ban és egy később megnyitott tervnél más lehet, mint a generáláskori beállítás.

#### B) Heti keretterv (`docId === 'keret'`)

Cím: „Heti tervezet”.

| Dokumentumrész | JSON/forrás mező |
|---|---|
| Projekt | `summary` (vagy `heti_keretterv.tema • group • duration • dateValue`) |
| Meta: Óvoda / Pedagógus / Csoport | `request.*` |
| Meta: Téma | `heti_keretterv.tema` |
| Meta: Heti fő cél | `heti_keretterv.heti_fo_cel` |
| Meta: Eszközök | `heti_keretterv.eszkozok` |
| Cél- és feladatrendszer | `heti_keretterv.nevelesi_feladatok`, `.didaktikai_feladatok` |
| Területek heti elosztása (Nap / Fő terület / Csoportos tevékenység) | `heti_keretterv.teruletek_heti_eloszlasa[].nap, .fo_terulet, .csoportos_tevekenyseg` ‖ `.mikrocsoportos_tevekenyseg` |
| Felhasznált irodalom | `heti_keretterv.felhasznalt_irodalom` (pipa függő) |

**Kimaradó adat:** `request.selectedDays`, `request.weeklyProgressionType`, `request.fridayClosingType` (a péntek lezárás típusa sehol nem jelenik meg), `request.dateValue` (csak a `summary`-n át). A heti keretterv a napi tervek **tartalmát nem összegzi** (nincs napi cél sor, nincs a napi tervekre való hivatkozás vagy kereszttáblázat), az összefüggés a „Területek heti elosztása” táblán kívül nem látszik.

#### C) Heti napi terv (`docId === 'nap-N'`)

Cím: „Napi tervezet – {nap_neve}”.

| Dokumentumrész | JSON/forrás mező |
|---|---|
| Meta: Óvoda / Pedagógus / Csoport | `request.*` |
| Meta: Nevelési terület | `request.weeklyFocusAreas[nap]` ‖ `heti_keretterv.teruletek_heti_eloszlasa[nap].fo_terulet` |
| Meta: Téma | `heti_keretterv.tema` |
| Meta: Forma | `napok[i].tevekenyseg_forma` |
| Meta: Napi cél | `napok[i].napi_cel` |
| Kidolgozás (táblázat) | `napok[i].kidolgozas_tablazat[]` |

**Kimaradó / szegényes:**
- A napi dokumentumon **nincs** Előzmény, Nevelési feladatok, Didaktikai feladatok, Képességfejlesztés, Módszerek, Eszközök, Felhasznált irodalom, és nincs „Projekt” összegző sor és dátum sem. A JSON-ban ezek a napokra nem is léteznek (3.3. pont), tehát nem hiányzik adat, hanem a séma szűk.
- A napi dokumentum nem hivatkozik az előző/következő napra, a heti keretre, és nem mutatja a napi dátumot.
- A napi dokumentum fejléce (4 meta-sor + táblázat) szerkezetileg eltér a külön generált Napi tervezetétől, így a két termék ugyanazt a címet („Napi tervezet”) viseli, de eltérő tartalmi mélységet.

#### D) Academic napi – `tervezo-academic.js` › `buildAcademicDailyHtml`

Cím: „Foglalkozási/tevékenységi terv”.

| Dokumentumrész | Mező |
|---|---|
| Az óvodapedagógus neve | `request.studentName` ‖ `request.teacherName` |
| Csoport | `request.groupName` ‖ `request.group` |
| Tevékenységi forma | `tevekenyseg_forma` |
| Időpont | `request.dateValue` + `ossz_ido_perc` |
| Előzmény | `elozmeny` |
| Tartalom/téma | `tema` + `tartalom.uj_anyag / ismetles / keszsegfejlesztes / zenehallgatas` |
| Cél | `cel` |
| Feladatok | `nevelesi_feladatok`, `didaktikai_feladatok`, `kepessegfejlesztes` |
| Módszerek / Eszközök | `modszerek[]`, `eszkozok[]` |
| Kidolgozás (3 oszlop: Idő / menet / módszerek, munkaformák, eszközök, megjegyzések) | `kidolgozas_tablazat[]` |
| Felhasznált irodalom (soronként) | `felhasznalt_irodalom` |

**Kimaradó adat:** `request.kindergartenName` (az intézmény neve nincs a fejlécben), `request.focusAreas`, `childCount`, `specialNeeds`. Az `*dőlt*`/`**félkövér**` jelölést a `formatRichText` kezeli.

#### E) Tematikus (academic heti) – `buildThematicHtml`

Cím: „Tematikus terv”. Fejléc: pedagógus neve, csoport, időszak (`hetek[0].datum`), fő téma (`tema`). Utána hetenként: 7 oszlopos mátrix (Főtéma, hét száma, dátum, altéma + 6 terület: `kulso_vilag, matematika, verseles_meseles, enek_zene, rajzolas, mozgas`), majd „Cél, - feladatrendszer” (`keretrendszer.celok, .feladatok`), „Kiemelt fejlesztési terület” (6 kulcs), „Módszerek, eszközök”, „Megjegyzés, egyéb tevékenységek”, irodalom. Oszlopszélesség: `THEMATIC_COLUMN_WIDTHS = [12,14,13,19,17,12.5,12.5]`.

**Hiányosságok:** nincs napi kidolgozás vagy részletes foglalkozásterv; a mátrixcellák rövid listák; az intézmény neve hiányzik; nincs értékelési/reflexiós rész.

### 5.3. Összefoglalás a kért kiemelésekre

1. **JSON-adat, ami nem jut a dokumentumba:** `request.dateValue` (napi, keret, heti nap), `fridayClosingType`, `weeklyProgressionType`, `selectedDays`, `childCount`, `energyLevel`, `specialNeeds`/`selectedGoals` (SNI-differenciálás nem látszik a fejlécben), `kindergartenName` (academic), a `summary` heti napi dokumentumban, `weeklyAreaAssignments`, `detail`, `iktSummary` (nem is jut át a promptig).
2. **Heti összesítő és napi bontás összemosódása:** a keretterv és a napok közös `buildDocumentHtml` függvényben, közös stílusban készülnek, a napi lap azonos „Napi tervezet” címet kap, de a szerkezete szegényebb. A keretterv nem tartalmaz napi összefoglaló táblát (cél + tevékenység + eszköz napokra bontva), a napi lapok nem tartalmaznak visszautalást a keretre. A ZIP fájlnevek (`00_heti-keretterv_…`, `NN_<nap>-<terület>_<dátum>`) rendezettek, de a dokumentumok között nincs tartalomjegyzék.
3. **Academic sablon módszertani mélysége:** nincs külön pedagógiai indoklás, differenciálási terv, értékelési szempontrendszer, reflexió/önértékelés szakasz, szakirodalmi hivatkozás a szövegben; a tematikus terv napi bontás nélküli; az idők nincsenek normaidőhöz kötve.

---

## 6. Architekturális javaslat

### 6.1. Önálló „Csak heti összesítő tervezet”

- **Új termék:** `weekly_summary` (ár: `system_settings.pricing` új kulcs, pl. a `weekly` kategória; a jelenlegi gyakorlatilag használhatatlan `weekly` alapcsomag helyét veheti át).
- **Prompt:** új `buildWeeklySummaryPrompt` a `server.js`-ben (a `buildWeeklyPrompt` keretterv-részéből), magasabb mélységű keretre: heti cél, területek × napok mátrix (cél, tevékenység, eszköz, módszer naponta), differenciálás, értékelési szempontok, irodalom. Mivel nincs napi kidolgozás, a hívás tokenigénye kicsi (≈ 6–8 ezer token), így a 12 288 plafon elég.
- **Séma:** a meglévő `heti_keretterv` bővítése (pl. `napok_attekintes[{nap, fo_terulet, tevekenyseg, cel, eszkozok, modszerek}]`), `is_weekly_summary: true`.
- **Dokumentum:** egyetlen dokumentum (`getDocumentList` → `main`), álló vagy fekvő A4 táblázatos kivitel; új ág a `buildDocumentHtml`-ben.

### 6.2. „Teljes heti csomag” láncolt generálással

Cél: heti összesítő + 5 napi terv, **egyenként teljes napi szintű mélységgel**.

1. **1. lépés – keretterv hívás:** `buildWeeklyFramePrompt` → `heti_keretterv` (a 6.1. séma). Max. 12 288 token.
2. **2–6. lépés – napi hívások (naponta 1):** minden nap a **teljes napi séma** szerint (`buildPrompt` egy napra szabva), és a promptba kerül: a keretterv (JSON), az adott nap kijelölt területe/célja, valamint az **előző napok rövid összefoglalója** (`tema`, `cel`, használt módszerek/eszközök, kulcsélmények, 300–500 token), hogy a nap hivatkozhasson az előzőre, és ne ismételje azt. Mindegyik 12 288 token → a napi mélység megegyezik a külön Napi tervezettel.
3. **Futtatás:** soros (láncolt) a minőségért; ha az idő számít, a napok 1–2 hullámban párhuzamosíthatók az összefoglaló nélküli változattal, de ez az összefüggést rontja. Mivel egy Render-kérés tipikusan 60–120 s lehet, az 1+5 hívás ≈ 5–10 perc, ezért **aszinkron feladat** kell: `POST /api/generate` azonnal `generationId`-t ad, a kliens pollingol (`GET /api/generate/:id/status`), az állapot (lépés 2/6, részeredmények) a `planStore`/Supabase `documents.data.meta`-ban él. A mostani 290 s timeout és az IP-nkénti párhuzamosság-zár (409) ehhez átalakítandó.
4. **Hibakezelés:** nincs csendes fallback; ha egy nap sikertelen, a nap külön újrapróbálható, a már kész napok megmaradnak. Költségkeret: a `reserveDailyGeneration` jelenleg 1 hívást számol; 6 hívásra (vagy 1 csomagra) kell igazítani.
5. **Séma:** a `napok[i]` a teljes napi séma (`elozmeny, tema, cel, nevelesi_feladatok, didaktikai_feladatok, kepessegfejlesztes, modszerek, eszkozok, kidolgozas_tablazat, felhasznalt_irodalom`) + `nap_neve`; a `normalizeWeeklyResponse` helyett napi `normalizeResponse` fut mindegyikre, az összeállítást új `assembleWeeklyPackage` végzi.
6. **Minőségbiztosítás:** szerveroldali ismétlés-ellenőrzés (pl. azonos `tema`/`kidolgozas_tablazat` eleje), és `responseSchema` használata a Gemini-hívásban a séma betartatásához.
7. **Dokumentumok:** a heti összesítő a 6.1. sablon, a napi dokumentumok az **új napi sablon** (6.3), nap- és dátumjelöléssel, hivatkozással a keretre. ZIP: `buildZipBlob`, nincs változás a logikában.

### 6.3. Újratervezett Napi és Oktatási célú sablonok (típusonként külön `.docx`/`.pdf` kialakítás)

- **Napi:** fejléc dátummal, intézménnyel, csoportlétszámmal, SNI/differenciálási megjegyzéssel; külön fejezetek (cél- és feladatrendszer, eszközök, **differenciálás**, **értékelés/reflexió**), a `request` mezők teljes felhasználásával.
- **Academic napi:** módszertani bővítés a sémában (`pedagogiai_indoklas`, `differencialas`, `ertekeles`, `reflexio`, normaidő-ellenőrzés a szerveren), `detailLevel` skálázás, szövegközi hivatkozások az irodalomhoz.
- **Academic tematikus:** több hét támogatása (`THEMATIC_WEEK_COUNT` > 1 láncolt hívásokkal) vagy napi kidolgozások mellékelése.
- **Technikai megoldás:** a `buildDocumentHtml` ágait külön sablonfájlokba (`tervezo-doc-daily.js`, `tervezo-doc-weekly.js`, `tervezo-doc-academic.js`) érdemes bontani, egy közös `buildExportModel` marad. Mivel a `.docx` és `.pdf` a HTML-ből készül, minden új mező egyszer kerül be.

### 6.4. Kapcsolódó javítandó pontok (a fentiek miatt)

- Preview-maszkolás bővítése (`createMirrorPlan`, `countLockedContent`): keretterv, `napi_cel`, `cel`, `feladatok`, `tartalom`, `modszerek`, `eszkozok` is maszkolandó, vagy a szerver csak `locked_meta`-t küldjön.
- Redundáns bemeneti mezők (`iktSummary`, `detail`, `weeklyAreaAssignments`) eltávolítása vagy tényleges felhasználása.
- A `weekly` (alapcsomag) kulcs és a `request.planMode === 'weekly'` holt ág megszüntetése.
- `showLiterature` ne az élő DOM-ból, hanem `result.showLiteratureAtBottom`-ból olvasson.
- `detailLevel` felhasználói skála bővítése (jelenleg csak 30 és 68), hogy a 1400–2000 szavas ág elérhető legyen.

### 6.5. Módosítandó fájlok és függvények (következő lépés)

| Fájl | Függvény / rész | Teendő |
|---|---|---|
| `backend/server.js` | `buildPrompt`, `buildWeeklyPrompt`, `normalizeWeeklyResponse`, `normalizeResponse`, `/api/generate` (~612–735), `getPlanKind`, `isWeeklyBreakdown`, `WEEKLY_MAX_OUTPUT_TOKENS`, `WEEKLY_TIMEOUT_MS` | új prompt-építők (keret, összesítő, nap-láncolt), aszinkron orchestrator, státusz végpont |
| `backend/services/geminiService.js` | `callGemini` | `responseSchema` támogatás, token/timeout paraméterezés lépésenként |
| `backend/services/academicPlan.js` | napi/tematikus prompt, normalizáló, `THEMATIC_WEEK_COUNT`, `MAX_ACADEMIC_OUTPUT_TOKENS` | módszertani mezők, normaidő-ellenőrzés, többhetes mód |
| `backend/services/generateValidation.js` | whitelist | új mezők, redundánsak eltávolítása |
| `backend/services/responseReaders.js` | olvasók | új sémamezők |
| `backend/services/pricing.js`, `settingsService.js` (`pricing`, `pricingTierFor`) | `PRODUCTS`, `resolveProductKey` | új termékkulcsok (`weekly_summary`, `weekly_package`) |
| `backend/services/planStore.js` | `createMirrorPlan`, `countLockedContent`, `savePlan`, `persist`, `sanitizeRequest` | maszkolás bővítése, részeredmények/státusz tárolása |
| `backend/services/documentExport.js` | `buildDeliveryFiles` | új dokumentumtípusok (jsdom szkriptlista) |
| `backend/routes/payment.js` | `deliverPurchase`, `deliverCouponPurchase`, `planData` visszaadás (~155, ~277) | új kulcsok, melléklet-név |
| `backend/routes/admin.js` | `loadPlanAttachments` | új csomag |
| `frontend/js/tervezo-form.js` | `buildGenerationPayload`, `getWeeklyDailyBreakdown`, `getDetailLevel`, `DETAIL_LEVELS` | új csomagválasztó, redundáns mezők eltávolítása |
| `frontend/js/tervezo-generate.js` | `/api/generate` hívás (~181) | aszinkron állapotlekérdezés, folyamatjelző |
| `frontend/js/tervezo-preview.js` | `getDocumentList`, `buildDocumentHtml`, `buildActivityTable`, `validateGeneratedPlan`, `renderResultDocument` | új sablon-ágak, `showLiterature` forrás |
| `frontend/js/tervezo-academic.js` | `buildAcademicDailyHtml`, `buildThematicHtml` | új módszertani szakaszok |
| `frontend/js/tervezo-export.js` | `buildExportModel`, `buildPdfDefinition`, `renderDocxBlob`, `buildZipBlob` | új blokktípusok, ha szükséges |
| `frontend/js/tervezo-paywall.js` | `PAYWALL_PRICES`, `PLAN_LABELS`, `planKind`, `buildDeliveryFiles` | új termékek |
| `frontend/tervezo.html` | csomag-/módválasztó UI | új opciók |
| `supabase/migrations/` | `documents.data` jsonb: nincs sémamódosítás; opcionálisan új `generation_jobs` tábla az aszinkron láncoláshoz | idempotens migráció + `RUN_ALL_PENDING_MIGRATIONS.sql` |
| `tests/*` | generálás, normalizálók, maszkolás, árazás, export, e-mail | frissítés és új tesztek |

---

## 7. Összegző kockázat- és prioritáslista

1. **Magas:** a heti keretterv és a napi célok az előnézetben olvashatók (paywall-megkerülés a tartalom egy részére).
2. **Magas:** a heti napi tervek szűk sémája miatt nem önálló napi tervezetek; egyetlen hívás tömörít.
3. **Közepes:** az academic napi és tematikus kimenet módszertanilag sekély, az idő-összeg nincs validálva.
4. **Közepes:** bemeneti mezők (`iktSummary`, `detail`, `weeklyAreaAssignments`) feleslegesek; több űrlapérték (dátum, SNI, `fridayClosingType`) nem jut a dokumentumba.
5. **Alacsony:** holt kód (`request.planMode === 'weekly'`, `weekly` alapcsomag a UI-ból elérhetetlen, `request.topic` naplózás), `showLiterature` DOM-függése.
