# Audit jelentés – OviTervező

Hatókör: frontend (`tervezo-*.js`, `tervezo.html`, `styles.css`), backend (`server.js`, `routes/`, `services/`), build-szkriptek és tesztek. Új funkció: belső kuponrendszer.

## 1. Talált logikai hibák

| # | Hiba | Ok | Javítás |
|---|------|----|---------|
| 1 | A „Teljes tervezet és letöltés feloldása” doboz látszott generálás közben. | A `resetGeneratedResult()` törölte a tervet, de a fizetési gombok állapotát (`updateExportLock()`) csak a generálás végén frissítette a kód. Az előző, zárolt terv gombjai végig látszottak. | A gombok és a lebegő sáv csak akkor látszanak, ha a terv zárolt, az előnézet kész (`previewReady`), nem fut generálás, és a zárolt előnézet (`#paywallGate`) a DOM-ban van. A `resetGeneratedResult()` és a `generatePlan()` azonnal frissíti az állapotot. A fizetési ablak generálás közben nem nyitható. |
| 2 | **Biztonsági rés:** a zárolást a kliens kikapcsolhatta. | A `shouldLockPlan` a kérésből jövő `preview: false` vagy `unlocked: true` értékre feloldott tervet adott. | A bypass megszűnt. A zárolást csak a szerver `PAYWALL_ENABLED` értéke kapcsolhatja ki; a kliens csak szigorúbbat kérhet (`preview: true`). Fizetőfalnál a kliens mindig `preview: true`-t küld. |
| 3 | A GitHub Pages eredet fizetés nélkül, valódi tartalommal kapott kiszolgálást. | `isFreeTestOrigin` ág a `shouldLockPlan`-ben. | Törölve. Minden eredet zárolt, a GitHub Pages build is `paywallEnabled: true`. |
| 4 | A helyi `.env` `PAYWALL_ENABLED` értéke belefolyhatott a tesztekbe. | A `dotenv` a teszt indulásakor is betölt. | A `tests/fixtures.js` rögzíti: `PAYWALL_ENABLED=false`; a fizetőfalas tesztek maguk kapcsolják be. |

## 2. Összesítő képernyő

Átnézve: a típus (Óvodai / Oktatási célú), hallgató neve, időtartam, dátum, csoport, téma, tevékenységi forma, nevelési területek, óvoda adatai, SNI, célkifejezések, eszközök, tiltólista, előzmény, IKT, heti beállítások mind megjelennek. Hiányzott az előző tervezet csatolásának jelzése, és a csatolás/törlés nem frissítette az összesítőt. Pótolva (`Előző tervezet csatolva: …`). Kivezetett beállítás (margó, tájolás, elrendezés) nincs az összesítőben; ezt teszt őrzi.

## 3. Eltávolított felesleges kód

- `isFreeTestOrigin` és `FREE_TEST_ORIGINS` (a Turnstile-mentesség önálló, `TURNSTILE_EXEMPT_ORIGINS` néven maradt, lásd 6. pont).
- Tesztkézbesítés: `/api/test-deliver`, `testDeliver`, `testDeliveryAllowed`, `testRateLimited`, `sendTestDeliveryEmail`, a levélsablon `test` ága, a `TEST_DELIVERY_*` környezeti változók, a `testDelivery` config, a `#testDeliverRow` felület, `sendTestDelivery()`, a hozzá tartozó CSS. A kuponrendszer váltja ki; a funkció egyébként is csak kikapcsolt fizetőfalnál élt volna.
- `outputMode` a kliens kérésében és a validátorban (a szerver prompt konstansa változatlan).
- `unlocked`, `includeLiterature` kérésmező és a `showLiteratureAtBottom ?? includeLiterature` visszaesés.
- Halott CSS: `.export-settings-panel`, `.export-settings-grid`, `.setting-option`, `.setting-row` (a hozzájuk tartozó sötét témás és reszponzív szabályokkal), valamint a `data-export-section` kulcs az automentésben.
- `docSettings` nem fordult elő a kódban.

Szándékosan nem érintve: a prompt `settings` objektuma (`outputMode`, `ideaNote` konstansok/üres mezők). Ezek a prompt JSON-jának részei, törlésük megváltoztatná a modellnek küldött szöveget, és a golden tesztek bájtazonos promptot várnak.

## 4. Generálási folyamat egysége

A webes nézet a `buildDocumentHtml()` kimenete. A DOCX (`renderDocxBlob`) és a PDF (`renderPdfBlob` → `buildPdfDefinition`) egyaránt a `buildExportModel()`-ből épül, ez pedig ugyanazt a `buildDocumentHtml()`-et hívja. A ZIP és az e-mailes kézbesítés ugyanezeket a renderelőket használja. Más helyen nem épül dokumentum. Teszt őrzi: a modellt csak három hely hívja, a cím és a táblázatsorok száma megegyezik a webes nézettel.

## 5. Belső kuponrendszer

**Konfiguráció** (`services/coupons.js`): a 100%-os kódok a `COUPON_CODES` környezeti változóból jönnek (vesszővel elválasztva). Beállítás nélkül egyetlen kód él: `TEST100`. Üres érték kikapcsolja a kuponokat. A kód kis- és nagybetűre érzéketlen. A `render.yaml` `COUPON_CODES=TEST100` értéket állít be.

**`POST /api/apply-coupon`** (törzs: `code`, `email`, `generationId`, `plan`, `planMode`):

1. IP-nként percenként 10 kísérlet (`COUPON_RATE_LIMIT`), kódtalálgatás ellen.
2. Érvényes e-mail és érvényes kód kell (`400`, `INVALID_COUPON`). A terv a szerveren tárolva kell legyen (`404` különben). A `planMode` a tárolt tervből jön, mint a Stripe-nál.
3. A válasz: `{ success, paid: true, coupon, sessionId: "coupon_…", planData }`. A `planData` a teljes, feloldott terv. A Stripe és a Számlázz.hu nem hívódik; teszt csapdával bizonyítja.
4. Ugyanarra a tervre ismételt beváltás ugyanazt a munkamenetet adja.

**Fulfillment.** A PDF/DOCX a böngészőben készül (az export kliensoldali), ezért a kupon után a frontend állítja elő a fájlokat, és az `/api/deliver/:sessionId` végpontra küldi. A végpont a `coupon_` azonosítót felismeri: nem kérdezi a Stripe-ot, számla nélkül, „a kuponnal feloldott tervezet” tárggyal küldi a levelet a megadott címre, egyszer. A felület ugyanazt a folyamatot futtatja, mint sikeres fizetés után: feloldott terv, „Feloldva” jelvény, letöltés. A számlagomb kuponos munkamenetnél rejtett.

**Frontend.** A fizetési ablakban, a Stripe/Barion gombok fölött: „Kuponkód” mező és „Érvényesítés” gomb. Az Enter a kupont érvényesíti, nem indít Stripe-fizetést. A kuponhoz érvényes e-mail és a két nyilatkozat kell. Hiba esetén az ablakban jelenik meg az üzenet, a terv zárolt marad.

## 6. Kockázatok és megjegyzések

- **A `TEST100` alapból él éles környezetben is**, ha a `COUPON_CODES` nincs beállítva. Aki ismeri a kódot, ingyen kap tervezetet (és a Gemini-költség a tiéd). Éles indulás előtt állítsd át a `COUPON_CODES` értékét, vagy hagyd üresen.
- A kuponmunkamenetek és a tárolt tervek memóriában vannak (mint eddig a `planStore`). Újraindítás után a kuponos kézbesítés ismeretlen azonosítót kap. A letöltés ilyenkor is működik.
- A Turnstile-mentesség a GitHub Pages eredetre megmaradt, mert az oldal nincs felvéve a Turnstile-ba. Ez csak a botvédelmet érinti, a tartalom itt is zárolt. Az `Origin` fejlécet nem böngészős kliens hamisíthatja.
- A kupon-sebességkorlát értékét a tesztek 1000-re emelik (`COUPON_RATE_LIMIT`); a korlátozás működését külön teszt nem fedi.
- A `tests/` futása párhuzamos buildszkripteket indít; ritkán egy `dist-*` mappán versenyezhetnek (korábbról ismert, kupontól független).
- A hivatalos Barion logósor fájlja (`assets/barion-card-strip.png`) továbbra is hiányzik; addig szöveges tartalék látszik.

## 7. Tesztek

- `tests/coupon.test.js` (új): kuponkódok, végpont (siker, hibák, ismétlés, nincs Stripe/számlázás), kuponos kézbesítés (számla nélkül, egyszer), frontend (mező sorrendje, siker, hiba, Enter), fizetési doboz generálás alatt rejtve és utána látható.
- `tests/audit.test.js` (új): összesítő teljessége, kivezetett kód hiánya, egységes dokumentummodell.
- Átírva: a GitHub Pages ingyenes kiszolgálását igazoló tesztek (most zárolást és a kliensoldali bypass elutasítását ellenőrzik), a tesztkézbesítés tesztjei, a `shouldLockPlan` esetek, a golden kérésmezők (`outputMode` nélkül), a levélsablon tesztek.
- `NODE_ENV=test` alatt minden e-mail mockolt (korábbi lépés), a kuponos levél is.
