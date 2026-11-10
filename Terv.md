OviTervező asszisztens – Rendszerterv és UX/UI Koncepció

1. Alapelvek a Célcsoport Számára (50-60 éves óvodapedagógusok)

Letisztult dizájn: Nagy betűk, pasztell színek, hatalmas és egyértelmű gombok (pl. "Tervezet elkészítése", "Következő lépés").

Szakmai nyelvezet: A "Prompt" vagy "AI generálás" szavak helyett "Tervezet összeállítása", "Szakmai célok finomhangolása" kifejezések használata.

Fokozatosság (Varázsló / Wizard forma): Ne egyetlen hatalmas, végtelenül görgethető űrlap legyen. 3-4 rövid lépésre kell bontani a folyamatot, felül egy folyamatjelzővel (pl. 1. Alapok -> 2. Csoport -> 3. Tevékenységek -> 4. Kész tervezet).

Másolhatóság: A végeredmény egy az egyben másolható legyen az elektronikus napló rovataiba.

2. A Weboldal Felépítése (Lépésről lépésre)

1. Lépés: Alapadatok (Kötelező, gyorsan kitölthető)

Ezen az oldalon csak a legszükségesebb, adminisztratív adatokat kérjük be.

Időtartam: Rádiógombok (Napi foglalkozásterv / Heti tematikus terv).

Korcsoport: Legördülő menü (Kiscsoport / Középső csoport / Nagycsoport / Vegyes csoport).

Téma / Projekt címe: Szövegdoboz (pl. "Márton-nap", "Őszi falevelek", "Téli álmot alvó állatok").

Melyik nevelési területek lesznek fókuszban? Jelölőnégyzetek (Többet is kiválaszthat).

[ ] Külső világ tevékeny megismerése

[ ] Verselés, mesélés

[ ] Ének, zene, énekes játék

[ ] Rajzolás, mintázás, kézimunka

[ ] Mozgás

2. Lépés: A Mi Csoportunk (Opcionális finomhangolás)

Ez az oldal teszi igazán "személyessé" az AI által generált tervet.

Hány gyerek van a csoportban? (Számmező, alapértelmezett: 20).

Csúszka 1: Csoport energiaszintje / hangulata.

Bal szél: Nyugodt, elmélyült (Több ültetős, finommotorikus feladat generálása).

Jobb szél: Mozgékony, pörgős (Több mozgásos, nagymotoros levezető játék generálása).

Iskola-előkészítős (tanköteles) gyermekek: Van/Nincs kapcsoló.

(Háttérlogika: Ha bekapcsolja, az AI az OH szabályoknak megfelelően automatikusan generál egy erős "Differenciálás nagycsoportosoknak" bekezdést).

-> [ Gomb: Speciális nevelési igények (SNI / BTMN) megadása ] (Ez egy lenyíló panel, hogy ne zavarja azt, akinek nincs ilyen a csoportban).

Ha lenyitja: "Milyen kiemelt figyelmet igénylő gyerekek vannak jelen?" (Jelölőnégyzetek).

[ ] Figyelemzavar / Hiperaktivitás (Rövidebb, fókuszáltabb blokkok).

[ ] Beszédfejlődési elmaradás (Több artikulációs, hangutánzó játék).

[ ] Autizmus spektrumzavar (Erősen strukturált, vizuálisan támogatott folyamatok).

[ ] Mozgásfejlődési elmaradás.

3. Lépés: Konkrétumok és Kívánságok (Szakmai tartalom)

Itt adhatja meg az óvónő azokat a fix elemeket, amiket ő már kinézett, vagy kötelező leadnia.

Van kötelező mese, vers vagy dal? Szövegdoboz. (pl. "Mindenképp legyen benne a Süni, süni, sünikém című dal").

Saját ötletek, eszközök, amiket felhasználnál: Szövegdoboz. (pl. "Gyűjtöttünk gesztenyét, azt szeretném használni barkácsoláshoz").

Ha ezeket üresen hagyja, az AI magától talál ki az életkornak és a témának megfelelő dalokat, verseket és kézműves feladatokat.

4. Lépés: Várakozás és Generálás

Míg az AI dolgozik, egy barátságos animáció jelenik meg: "A tervezet összeállítása folyamatban... Keresem a legjobb játékokat... Formázom a szakmai rovatokhoz..."

3. A Végeredmény Megjelenítése (Kimenet)

A generált terv nem egy egybefüggő, hosszú szövegként jelenik meg, hanem a szakmai rovatok logikáját követő, jól elkülönülő dobozokban. Minden doboz mellett egy "Másolás" ikon található, így a pedagógus csak rákattint, és beilleszti a Krétába.

A generált nézet blokkjai:

Cél- és feladatrendszer (Kognitív, szocio-emocionális és motoros célok).

Tevékenységek (Területenként bontva) - A megadott mesével/dallal kiegészítve.

Kiemelt differenciálás (A csúszkák és SNI beállítások alapján generálva).

Eszközszükséglet (Pontos lista).

Letöltési opciók a lap alján:

[ PDF letöltése ] (Nyomtatáshoz, vezetőnek leadáshoz).

[ Word / DOCX letöltése ] (Későbbi szerkesztéshez).

4. AI (Prompt) Háttérlogika a fejlesztéshez

Amikor a pedagógus a végén rányom a gombra, a weboldal a háttérben összefűzi a válaszokat egy strukturált rendszer-prompttá.
Példa egy háttérben futó prompt vázra: "Te egy szakértő magyar óvodapedagógus vagy. Készíts egy {időtartam} tervezetet a {korcsoport} számára, {téma} témában. A csoport {energiaszint}, és van jelen {sni_tipus} gyermek, valamint iskola-előkészítős gyermek. A tervezet tartalmazza a következőket: {kötelező_elemek}. A kimenet szigorúan kövesse a 2026-os magyar Óvodai Nevelés Országos Alapprogramja szerinti tagolást..."