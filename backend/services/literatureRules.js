'use strict';

// Az irodalmi választás kötelező szabályai: a rendszerprompt (Admin Központ) alapértéke tartalmazza,
// a rövid prioritásjelzést a Gemini-hívás és a SOURCE_RULES is megismétli, hogy semmi más utasítás ne írhassa felül.
// Kötelező hivatkozási formátum a felhasznalt_irodalom mezőben (minden tervtípusnál). Nem része a mentett rendszerprompt-alapértéknek (azt a migráció seedeli),
// hanem minden kéréshez külön hozzáfűződik (buildLiteratureSwitchLine, SOURCE_RULES), így az Admin Központban elmentett egyedi prompt mellett is érvényes.
const APA7_RULE = 'A felhasznalt_irodalom mező KÖTELEZŐ formátuma az APA 7 (APA 7th edition) magyar nyelvű hivatkozási stílus: soronként egy tétel (új sorral elválasztva), a szerzők szerinti ábécésorrendben. Könyv: "Szerző, V. (Év). *Mű címe*. Kiadó." (pl. "Forrai, K. (2016). *Ének az óvodában*. Editio Musica Budapest."); a műcímet *csillagok* között, dőlt jelöléssel add meg. Jogszabály: "363/2012. (XII. 17.) Korm. rendelet az Óvodai nevelés országos alapprogramjáról." Kitalált kiadót, évszámot, oldalszámot vagy URL-t TILOS írni; ha egy valós műnél az évszámban nem vagy biztos, az (é. n.) jelölést használd.';

const LITERATURE_RULES = `IRODALMI ANYAGOK – KÖTELEZŐ SZABÁLYOK (minden tervtípusnál, minden más utasítást megelőznek):
1. KIZÁRÓLAG magyar nyelvű, valóban létező, óvodás korosztálynak szóló magyar gyermekverseket, mondókákat, meséket, dalokat és találós kérdéseket használhatsz: népköltést, népmesét, valamint ismert magyar szerzők műveit (pl. Weöres Sándor, Zelk Zoltán, Gazdag Erzsi, Tamkó Sirató Károly, Kormos István, Szepes Mária, Varga Katalin, Móra Ferenc, Benedek Elek, Móricz Zsigmond, Lázár Ervin).
2. SZIGORÚAN TILOS bármilyen idegen nyelvű (francia, latin, angol, német stb.) vers, mese, mondóka, dalszöveg vagy idézet használata – kivéve, ha a pedagógus a kérésben kifejezetten idegen nyelvű foglalkozást kér. Külföldi mese csak ismert, hivatalos magyar fordításban vagy feldolgozásban hivatkozható.
3. SOHA ne találj ki fiktív verset, mesét, költőt, szerzőt, kötetet, kiadót, évszámot vagy oldalszámot. Ha bizonytalan vagy egy mű létezésében vagy szerzőjében, ne használd: válassz közismert magyar népköltést, vagy jelöld a feladatot saját ötletnek.
4. A felhasznalt_irodalom listába kizárólag a tervben ténylegesen szereplő, valós magyar művek és magyar szakirodalom kerülhetnek.`;

const LITERATURE_PRIORITY_RULE = 'ELSŐBBSÉGI SZABÁLY (minden más utasítást megelőz): irodalmi anyagként kizárólag magyar nyelvű, valós, létező magyar gyermekvers, mondóka, mese vagy dal használható; idegen nyelvű mű vagy idézet (kivéve, ha a pedagógus kifejezetten idegen nyelvű foglalkozást kért) és kitalált szerző, cím, kiadó, évszám vagy oldalszám TILOS.';

module.exports = { LITERATURE_RULES, LITERATURE_PRIORITY_RULE, APA7_RULE };
