# Adatok és beállítások – a tervező űrlapja

A `tervezo.html` három kitöltendő lépésből és egy összegző (4.) lépésből áll. A mezők azonosítója a `data-field` attribútum (ahol nincs, ott a megjelölt osztály). A payloadot a `buildGenerationPayload()` állítja össze.

## 1. lépés – Miről szól a hét/nap? (Téma és időkeret)

| Mező | Azonosító | Típus | Kötelező | Alapérték |
|---|---|---|---|---|
| Korábbi terv betöltése | `#loadPreviousBtn` | gomb (lépés tetején) | opcionális | – |
| Óvoda neve | `kindergarten-name` | szöveg | opcionális | üres |
| Óvodapedagógus neve | `teacher-name` | szöveg | opcionális | üres |
| Csoport neve | `group-name` | szöveg | opcionális | üres |
| Időtartam | `.segment[data-group="duration"]` | rádió jellegű gomb: Napi / Heti | kötelező | Napi |
| Napválasztó (csak Heti) | `.day-chip[data-day]` | 5 kapcsológomb (Hétfő–Péntek) | legalább 1 nap | mind az 5 aktív |
| Dátum / hét | dátummező | dátum | kötelező | aktuális nap / hét |
| Téma | `theme` | szöveg | kötelező | üres |
| Tevékenység formája | `tevekenyseg-forma` | select | kötelező | Kezdeményezett tevékenység (kötetlen) |
| Nevelési területek | `data-focus-area` | jelölőnégyzetek | min. 1 ajánlott | – |
| Saját megjegyzés | `custom-note` | szöveg | opcionális | üres |

A „Tevékenység formája” opciói: *Kezdeményezett tevékenység (kötetlen)*, *Irányított / szervezett foglalkozás (kötött)*, *Mikrocsoportos / egyéni fejlesztés*.

Heti időtartamnál a kijelölt napok a `selectedDays` tömbben mennek a szerverre; az utolsó aktív nap nem kapcsolható ki („Legalább egy napot ki kell választani!”).

## 2. lépés – Kiknek tervezünk? (A csoport profilja)

| Mező | Azonosító | Típus | Kötelező | Alapérték |
|---|---|---|---|---|
| Korcsoport | `group` | select (Vegyes csoport is) | kötelező | – |
| Gyereklétszám | `child-count` | szám | opcionális | – |
| Hangulat, mozgékonyság | `.segment[data-group="energy"]` | 3 opciós választó | opcionális | Átlagos |
| Iskola-előkészítő gyermekek | `has-preschoolers` | checkbox | opcionális | bekapcsolva |
| Speciális nevelési igények | `data-sni-label` | jelölőnégyzetek | opcionális | – |
| Csoportmegjegyzés | `group-note` | szöveg | opcionális | üres |

Energia opciók (a payload `energyLevel` mezője a feliratot küldi): *Nyugodt, kiegyensúlyozott*, *Átlagos*, *Nagyon mozgékony, eleven*.

**Vegyes csoport:** ha a korcsoport „Vegyes csoport”, a prompt kötelező 3 szintű differenciálást ír elő (kicsik – egyszerűsített, középsősök, nagyok/iskola-előkészítősök – összetett, szabálykövető).

Gyermekek személyes adatait az űrlap nem kéri be.

## 3. lépés – Mit szeretnénk látni? (Pedagógiai kívánságok)

| Mező | Azonosító | Típus | Kötelező | Alapérték |
|---|---|---|---|---|
| Rendelkezésre álló eszközök és saját ötletek | `available-tools` | többsoros szöveg | opcionális | üres (általános alapfelszerelés) |
| Kötelező mese, vers vagy dal | `required-text` | szöveg | opcionális | üres |
| Célkifejezések | `.chip` (nem `data-theme-option`) | többválasztós chipek | opcionális | 6 előre bejelölt |
| Külön kérés | `custom-request` | szöveg | opcionális | üres |
| Kidolgozottság | `.segment[data-group="detail"]` | 2 opciós választó | kötelező | Részletesen kidolgozott tervezet |

Kidolgozottság → `detailLevel`: *Tömör vázlat* = 30, *Részletesen kidolgozott tervezet* = 68 (a szerver ebből választ részletességi profilt).

### Speciális beállítások (harmonika)

Automatikusan kinyílik, ha bármelyik mezője tartalmat kap.

| Mező | Azonosító | Típus | Alapérték |
|---|---|---|---|
| Tiltólista | `blacklist` | szöveg | üres |
| Előzmény | `elozmeny` | szöveg | üres |
| Irodalomjegyzék megjelenítése | `show-literature` | checkbox | kikapcsolva |
| Heti építkezés típusa | `weeklyProgressionType` | select (`progressive` / `area_focused`) | progressive |
| Pénteki lezárás formája | `fridayClosingType` | select | Kiállítás a csoportszobában |

A két heti mező csak Heti időtartamnál érvényes.

## 4. lépés – Összegzés és generálás

Az ellenőrző kártya (`renderSummaryChecklist()`) a fizetés és generálás előtt öt blokkban listáz minden beállítást:

| Blokk | Tartalom |
|---|---|
| Téma és időkeret | Időtartam (heti tervnél a napok felsorolva, pl. „Heti tervezet (Hétfő, Kedd)”), dátum/hét, téma, tevékenységi forma, nevelési területek, óvoda, pedagógus, csoportnév, saját megjegyzés |
| A csoport profilja | Korcsoport, létszám, hangulat/mozgékonyság, iskola-előkészítők, SNI, csoportmegjegyzés |
| Pedagógiai kívánságok | Eszközök és saját ötletek, kötelező mese/vers/dal, célkifejezések, külön kérés, kidolgozottság |
| Speciális beállítások | Tiltólista, előzmény, irodalomjegyzék, heti építkezés, pénteki zárás |
| Generálási beállítások | Modell, kimeneti forma („Szakmai tervezet”) |

Új beállítási mezőt az összegzésbe is fel kell venni.

Ár: napi tervezet bruttó 390 Ft, heti tervezet (keretterv + a kiválasztott napok) bruttó 890 Ft, a napok számától függetlenül. Az igazságforrás a szerver (`services/stripeService.js`).

A generált dokumentumban és az előnézetben a „Kréta” szó nem szerepelhet; a szerver a modell válaszából is eltávolítja.

## Jövőbeli bővítési lehetőségek

Ezek ötletek, jelenleg nincsenek megvalósítva.

| Ötlet | Leírás | Érintett rész |
|---|---|---|
| Egyéni fejlesztési tervek | Gyermekenkénti célok személyes adat nélküli (betűjeles) megjelöléssel | 2. lépés, prompt |
| Egyedi intézményi napirend | Saját napirend időkeretei, amelyekhez az `ido` oszlop igazodik | 3. lépés, prompt |
| Heti árazás napok szerint | Kevesebb nap kedvezményes csomaggal | `services/stripeService.js` |
| Több hét / havi terv | Egymásra épülő hetek egy projekten belül | `duration`, prompt |
| Saját fejléc és logó | Az óvoda arculata a dokumentumban | exportálás |
| Szülői tájékoztató testreszabása | Hangnem és hosszúság | `outputMode` |
| Sablonok mentése | Névvel mentett beállításcsomagok | helyi tárolás |
| Ünnepek és hagyományok naptára | Időpont alapján javasolt témák | 1. lépés |
