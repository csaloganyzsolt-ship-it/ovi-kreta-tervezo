# A tervező szerkeszthetősége az Adminból – műszaki és biztonsági felmérés

> **Állapot:** csak felmérés, a funkció NINCS megvalósítva. A leltár a `frontend/tervezo.html`, a `frontend/js/tervezo-form.js`, a `backend/services/generateValidation.js` és a `backend/services/settingsService.js` aktuális állapotán alapul.

## 1. Összefoglaló

A tervező szövegeinek és tisztán szöveges listáinak nagy része biztonságosan szerkeszthetővé tehető. A tervezettípust, az időtartamot, a heti mátrixot, a részletességi szinteket és a paywall-kapukat viszont **nem szabad** adminból szerkeszthetővé tenni, mert ezekre a szerver validációja, a prompt-ágak, az árazás és a tesztek épülnek.

Az ajánlott irány egy szigorúan validált, **szűk JSON-konfig** a `system_settings` táblában, beépített kódbeli alapértékekkel és „Alapértelmezés visszaállítása” gombbal. Az admin csak azt módosíthatja, ami a kódban az engedélyezett kulcsok fehérlistáján szerepel.

Már van hasonló minta a rendszerben: a `settingsService.js` az `OBJECT_SETTINGS` (`pricing`, `ai_config`, `announcement_bar`, `external_links`) értékeket szigorúan validálja, és a hibás értéket elutasítja.

## 2. Teljes leltár (1–4. lépés)

A „Kapcsolódás” oszlop azt mutatja, mi törhet el, ha az elem értéke megváltozik.

### 1. lépés – „Miről szól a hét/nap?”

| Elem | Típus | Kapcsolódás |
|---|---|---|
| Tervezettípus: Normál / Oktatási (`data-plan-mode`) | kártya | `planMode` validáció (`standard`/`academic`), `academicPlan.js` prompt-ág, oktatási irodalom-pipa kényszer, `planStore` kitakarás, export |
| Hallgató neve (oktatási módban) | szöveg | `studentName` (200 karakter), oktatási fejléc |
| Időtartam: Napi / Heti (`data-group="duration"`) | szegmens | `duration` (`Napi`/`Heti`) és `planKind`; árazás (390 / 890 Ft), prompt-ág, export tájolás |
| Heti beállítások: „Mit szeretnél kapni?”, napválasztó | szegmens, jelölőnégyzet | `weeklyScope` (`summary`/`package`), `selectedDays` (`WEEKDAYS`), láncolt generálás |
| Dátum / hét (`date-value`, `week-value`) | dátum, hét | `dateValue`, téma-ajánló lekérdezés (`/api/theme-suggestions`) |
| Csoport: Kiscsoport / Középső / Nagycsoport / Vegyes | legördülő | `group` szöveg a promptban, összegző, telemetria `age_group` |
| Téma / projekt címe + téma-ajánló chipek | szöveg, chip | `theme`, `themeSuggestionId`, `theme_suggestions` tábla (már adminból szerkeszthető) |
| Tevékenységi forma (3 érték) | legördülő | `tevekenysegForma` szövege a promptban és a dokumentumban |
| Kiemelt nevelési területek (6 ONOAP-terület) + napválasztók | jelölőnégyzet, legördülő | `focusAreas` (max. 12), `weeklyFocusAreas`, a heti mátrix oszlopai, `weeklySummary.js`, export |
| Heti haladás típusa (`progressive` / `area_focused`) | legördülő | `weeklyProgressionType` validáció, prompt-ág |
| Óvoda neve, profilja, pedagógus, csoportnév | szöveg | fejléc a dokumentumban, `kindergartenProfile` a promptban |
| Megjegyzés (`custom-note`) | szövegdoboz | `customNotes`, a prompt része |
| Honeypot (`contact_website`) | rejtett mező | botvédelem, **soha ne legyen szerkeszthető** |

### 2. lépés – „Kiknek tervezünk?”

| Elem | Típus | Kapcsolódás |
|---|---|---|
| Gyerekek száma | szám | `childCount`, prompt, összegző |
| Energiaszint (3 érték) | szegmens | `energyLevel` szöveg a promptban |
| Van-e iskolaelőkészítős gyerek | jelölőnégyzet | `hasPreschoolers`, prompt-ág |
| Kiemelt figyelmet igénylő gyerekek (figyelemzavar, beszédfejlődés, autizmus, mozgásfejlődés, SNI, BTMN) | jelölőnégyzet-lista | `specialNeeds` (max. 20 × 200 karakter), prompt, összegző |
| Csoport megjegyzése | szövegdoboz | `groupNote`, prompt |

### 3. lépés – „Mit szeretnénk látni?”

| Elem | Típus | Kapcsolódás |
|---|---|---|
| Eszközök és saját ötletek + súgószöveg | szövegdoboz | `availableTools`, prompt (üresnél alapfelszerelés) |
| Kötelező szövegrészlet, egyéni kérés | szövegdoboz | `customNotes`, prompt |
| Részletességi szint: Tömör / Részletes / Kibővített | szegmens | `detailLevel` validáció, szószámcél a promptban, tokenkeret, tesztek |
| Speciális beállítások: tiltólista, korábbi terv csatolása, irodalom-pipa, IKT | lenyíló | `blacklist`, `previousPlanContext`, `showLiteratureAtBottom` (oktatásinál kötelezően igaz), `iktTools` |
| IKT eszközcsoportok és saját alkalmazás | jelölőnégyzet, szöveg | `iktTools` (max. 20), prompt |
| Heti: pénteki lezárás formája | legördülő | `fridayClosingType`, prompt, heti csomag |

### 4. lépés – „Összegzés és elkészítés”

| Elem | Típus | Kapcsolódás |
|---|---|---|
| Összegző kártya (`summaryChecklist`) | generált lista | `tervezo-form.js` összegző renderelő, **az 1–3. lépés minden mezőjének tükre** |
| Generálás gomb, hibasáv | gomb | `/api/generate`, Turnstile, napi plafon, rate limit |
| Előnézet, zárolt blokkok | előnézet | `planStore.createMirrorPlan` (szerveroldali kitakarás), `tervezo-preview.js` |
| Fizetési ablak: árak, kupon, Barion/Stripe | modál | `pricing.js` (szerver az igazságforrás), `orderService`, webhookok |
| Letöltés: Word / PDF | gomb | `documentExport`, `tervezo-export.js`, feloldási állapot |

## 3. Kockázati besorolás

### 🟢 Zöld – könnyen és biztonságosan szerkeszthető

Ezek tisztán megjelenítési szövegek. A kódnak nem kell az értékükre támaszkodnia.

- Lépéscímek és alcímek (pl. „1. Miről szól a hét/nap?”), súgók és `placeholder` példaszövegek
- A speciális beállítások összefoglaló felirata
- A tevékenységi forma, az energiaszint és a csoport (Kis- / Középső / Nagycsoport) *megjelenített felirata*, ha az elküldött érték (`value`) rögzített kulcs marad
- Pénteki lezárás formáinak és IKT eszközcsoportoknak a listája, ha tiszta szöveglista és az érték a promptba kerül szövegként
- Az SNI / BTMN és a többi kiemelt figyelmet igénylő opció *felirata*, a prompt viszont a kulcsot használja
- A téma-ajánló chipek (már adminból szerkeszthetők a `theme_suggestions` táblán keresztül)

### 🟡 Sárga – közepes kockázat

Ezek az értékek a promptba, az összegzőbe vagy az exportba is bekerülnek, ezért hibás vagy elütött érték rontja a generálás minőségét.

- Új opció felvétele a `specialNeeds`, a `fridayClosingType` vagy az `iktTools` listába: a szerver validációja listahossz- és karakterhatárt ellenőriz, de értékkészletet nem
- A `tevekenysegForma`, `energyLevel` és `group` *értékeinek* (nem csak a feliratainak) módosítása: a prompt szövegesen hivatkozik rájuk
- Az összegző kártya sorrendje és feliratai: az `tervezo-form.js` összegzője és a tesztek a mezők sorrendjére épülnek
- A telemetria `age_group` mezője a csoportnévből jön, a statisztika csoportosítása megváltozna

### 🔴 Piros – magas kockázat / nem ajánlott

Keményen kódolt üzleti logikához kötött elemek. Ezeket a kód változtatás nélkül nem tudja kezelni.

- **Tervezettípus** (`standard` / `academic`): külön prompt-ág, külön validáció, kötelező irodalom-pipa, külön kitakarási szabályok
- **Időtartam és heti terjedelem** (`Napi` / `Heti`, `summary` / `package`): ez dönti el az árat, a generálási láncot és az export tájolását
- **A 6 ONOAP nevelési terület**: a heti mátrix oszlopai, a `focusAreas` / `weeklyFocusAreas` kulcsai és a heti összesítő mind erre épülnek
- **Részletességi szintek** (`concise` / `detailed` / `extended`): szószámcélhoz, tokenkerethez és Gemini-költséghez kötöttek
- **Heti haladás típusa** (`progressive` / `area_focused`): szerveroldali enum
- **Árak, paywall, kupon, zárolt blokkok**: a pricing a szerveren az igazságforrás; a kliensből szerkeszthető érték csalási felületet nyitna
- **Honeypot, Turnstile, napi plafon**: botvédelem és költségvédelem

## 4. Buktatók és nehézségek

1. **Validációs eltérés.** A kliens feliratot vagy értéket változtat, a `generateValidation.js` pedig a régit várja (pl. `oneOf` listák). Eredmény: 400-as hiba generáláskor.
2. **Felirat és érték összemosása.** A mostani HTML-ben sok helyen a felirat egyben az elküldött érték (pl. `data-focus-area="Verselés, mesélés"`, tevékenységi forma `value`). Szerkesztés előtt szét kell választani a *stabil kulcsot* és a *megjelenített feliratot*.
3. **Véletlen törlés és elütés.** Egy admin kitörölhet egy opciót, vagy üres feliratot menthet. Kell minimum-darabszám, nem üres feliratok és karakterkorlát.
4. **Tesztek törése.** A tesztek jelenleg a HTML szövegére és a mezők sorrendjére is illesztenek. Dinamikus feliratoknál a tesztek a kulcsokat és az alapértékeket ellenőrizzék.
5. **Kliens–szerver szinkron.** A frontend statikus (Nethely), a backend a Renderen fut. A konfigot a meglévő `GET /api/config` végponton kell kiszolgálni, és a kliensnek a szerver által küldött értéket kell használnia.
6. **Cache és fallback.** A beépített alapértékek legyenek a kódban. Ha a konfig nem töltődik be, a tervező az alapértékekkel működjön, **de a hibát láthatóan jelezze** (nincs csendes fallback: lásd a projekt szabályait). A `settingsService` gyorsítótárát is érvényteleníteni kell mentéskor.
7. **XSS.** Az admin által megadott szöveg a tervező DOM-jába kerül. Csak `textContent` használható, `innerHTML` nem, és a szerver is tisztítsa a bemenetet.
8. **Prompt-injekció az adminon át.** A promptba kerülő feliratokat (pl. SNI-opciók) hossz- és karakterkorláttal kell védeni; a szerver a kulcsot használja, ne a nyers szöveget.
9. **Verziókövetés és visszaállítás.** Hibás mentés után a tervező nem működhet. Kell „Alapértelmezés visszaállítása” és ideális esetben az utolsó jó állapot megőrzése.
10. **GDPR és jogi szöveg.** A kötelező jogi vagy árinformációs szövegek nem lehetnek szerkeszthetők a konfigból.

## 5. Ajánlott architektúra

**Elv:** a kód az igazság, a konfig csak kiegészít. Az admin kizárólag a fehérlistás kulcsok szöveges értékét írhatja felül.

1. **Beépített alapértékek.** Egy `backend/services/plannerConfigDefaults.js` fájl tartalmazza minden szerkeszthető elem alapértékét. Az opcióknál `{ key, label }` párok, ahol a `key` kódban rögzített, a `label` szerkeszthető.
2. **Tárolás.** Egyetlen `planner_config` JSON kulcs a meglévő `system_settings` táblában, az `OBJECT_SETTINGS` mintájára. Külön migráció nem feltétlenül kell, mert a tábla kulcs–érték alapú.
3. **Szigorú validáció mentéskor.** Fehérlistás kulcsok, típusellenőrzés, hosszkorlát (pl. 120 karakter egy felirat), nem üres érték, `key` nem módosítható. Ismeretlen kulcs vagy hiányzó kötelező opció 400-as hiba.
4. **Összefésülés olvasáskor.** `effective = defaults ⊕ stored`. Csak a fehérlistán lévő kulcsokat veszi át. A tárolt, de már nem létező kulcsokat eldobja, így a kód frissítése nem törik el.
5. **Kiszolgálás.** A `/api/config` végpont adja a hatályos feliratokat. A frontend `textContent`-tel írja be őket, és az alapértékekre csak betöltési hibánál esik vissza, a hibát láthatóan jelezve.
6. **Admin felület.** Új „Tervező szövegei” szakasz csoportonként (1–4. lépés), szerkeszthető mezőkkel, élő előnézettel, soronként „Alapértelmezés” gombbal és egy „Mindent visszaállít” gombbal. A piros kategória elemei nem jelennek meg.
7. **Naplózás.** Minden mentés az `admin_*` naplóba kerül (ki, mikor, mit módosított), mint a téma-ajánlóknál.
8. **Tesztek.** Alapértékek és kulcsok egyezése a HTML-lel, érvénytelen konfig elutasítása, összefésülés, visszaállítás, és hogy a piros elemek nem szerkeszthetők.

### Becsült bonyolultság

| Fázis | Tartalom | Bonyolultság |
|---|---|---|
| 1 | Zöld elemek: lépéscímek, súgók, placeholderek, speciális beállítások felirata | **Kicsi** |
| 2 | Opciólisták felirata (pénteki lezárás, IKT, SNI/BTMN, csoport, energiaszint) a kulcs–felirat szétválasztással | **Közepes** |
| 3 | Új opció felvétele listába, összegző és prompt illesztése, teljes tesztfrissítés | **Közepes–nagy** |
| – | Piros elemek szerkeszthetővé tétele | **Nem ajánlott** |

A megvalósítást az 1. fázissal érdemes kezdeni: ott gyakorlatilag nincs üzleti kockázat, és a teljes konfig-infrastruktúra (tárolás, validáció, visszaállítás) kipróbálható.
