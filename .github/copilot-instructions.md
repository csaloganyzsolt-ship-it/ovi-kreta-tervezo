# OviTervező – Állandó Fejlesztési Irányelvek

## 1. Projekt Kontextus és Architektúra
- **Kétoldalas felépítés:**
  * `index.html`: Kizárólag a konverziós és SEO fogadóoldal (Hero, 3 lépés, előnykártyák, tevékenységi területek, GYIK, lábléc és jogi modálok). Itt alkalmazáskód NEM futhat.
  * `tervezo.html`: A tényleges pedagógiai tervező webalkalmazás a 4 lépéses űrlappal, előnézettel és Paywall-kezeléssel.
- **Backend:** Node.js / Express (`server.js`), amely Render.com-on fut, kiszolgálja az API végpontokat, és a Gemini API-t hívja (`gemini-3.1-pro-preview`).
- **Infrastruktúra:** Statikus frontend a Nethely tárhelyen (`ovitervezo.hu`), automatikus CI/CD deploy GitHub Actions segítségével.
- **Konfiguráció:** A frontend a dinamikusan injektált vagy kiszolgált `config.js` fájlból veszi a backend URL-jét (`apiBaseUrl`).

## 2. Arculat és Design Rendszer (Egységes Márka)
- **Márkaszínek:** Letisztult mentazöld paletta (fő szín: `--primary` = `#3fae84` a `styles.css`-ben / pasztell menta kiemelések). Barna vagy narancssárga színek használata szigorúan tilos!
- **Sötét és világos mód:** A `styles.css` közös CSS változókat (`:root` és `[data-theme="dark"]`) használ. Sötét módban a tervező és a főoldal azonos kontrasztos, sötét palettát és világosabb menta fókuszokat alkalmaz.
- **Logó és Favicon:**
  * Vektoros (SVG) "OT" monogram lekerekített sarkú mentazöld kártyán, mellette tipográfiai "OviTervező" felirat.
  * Hivatkozások: `favicon.svg` és `favicon.ico` mindkét oldalon.
- **Tranzakciós levelek (`services/mailService.js`):** A vásárlói visszaigazoló e-mail fejlécében diszkrét menta sáv és beágyazott CID csatolmányú "OT" logó szerepel. Narancssárga gomb vagy elem nem maradhat a levélben.

## 3. Cache-Busting és Gyorsítótár Szabályzat
- **Verziózás a build során (`scripts/cache-bust.js`):** A belső CSS, JS és médiafájlok (`styles.css`, `site.js`, `config.js`, ikonok) minden Nethely és GitHub Pages build során dinamikus `?v=ÉÉÉÉHHNNÓÓPP` időbélyeget kapnak a HTML-ben. A külső CDN linkeket és horgonyokat érintetlenül kell hagyni.
- **Nethely `.htaccess`:**
  * A HTML fájlokra kötelező a `Cache-Control: no-cache, no-store, must-revalidate` fejléc, hogy a belépési oldal mindig friss maradjon.
  * A verziózott (`?v=`) statikus fájlok hatékonyan gyorsítótárazhatók (`immutable`).

## 4. Keresőoptimalizálás (SEO) és Strukturált Adatok
- **Meta címkék:** Az `index.html` célzott kulcsszavai: *óvodai tervezet*, *óvodai tervezet készítés*, *heti tervezet*, *foglalkozásterv minta*.
- **Schema.org JSON-LD:** A `<head>` kötelezően tartalmazza az érvényes `SoftwareApplication` és a látható tartalommal szó szerint megegyező `FAQPage` blokkokat.
- **Indexelési fájlok:** A `sitemap.xml` és a `robots.txt` a kiadási csomag részét képezi, a Nethely gyökérkönyvtárába kerül.

## 5. Kötelező Munkafolyamat Minden Módosítás Végén (Deploy & Teszt)
Minden feladat vagy kódmódosítás befejezése után az AI KÖTELES elvégezni az alábbi lépéseket:
1. **Szintaxis és tesztellenőrzés:** Futtasd le a teszteket (`npm test`) és ellenőrizd a szintaxist (`node --check server.js`). Csak hibátlan, 100%-ban zöld kód mehet tovább!
2. **Git Commit:** Készíts tiszta, leíró üzenetű commitot a módosításokról.
3. **Automatikus feltöltés (Push):** Futtasd le a `git push origin main` parancsot, hogy a GitHub Actions CI lefusson (Nethely FTP és GitHub Pages deploy).
4. **Jelentés:** Röviden közöld, hogy mi módosult, zöldek-e a tesztek, és sikeresen lefutott-e a pipeline.

## 6. Minőségi és Biztonsági Szabályok
- **Nincs csendes Fallback/Mock:** SOHA ne rejts el hibákat beégetett kamu táblázatsorokkal. Ha a backend vagy az API hibát dob, az jelenjen meg tisztán a felületen és a terminálban!
- **Titkok védelme:** Titkos kulcs (`GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `SZAMLAZZ_KEY`, stb.) soha nem kerülhet be a frontend kódba vagy a git commitokba. A `build-nethely.js` toleránsan tisztítsa a `GOOGLE_SITE_VERIFICATION` tokent.
- **Tervezetek szakmai nyelve:** Szigorúan tilos az elcsépelt, ismétlődő sablonok használata. Mindig életszerű, differenciált, a magyar óvodapedagógiai irányelveknek megfelelő tartalmat kell generálni.
- **Adatvédelem (GDPR):** Gyermekek személyes adatait az űrlapon tilos bekérni vagy tárolni. A számlázási adatokat a számviteli törvény szerint 8 évig kell megőrizni.

## 7. Fizetés, Számlázás és Szervizréteg
- **Árazás (Szerver az igazságforrás):** Napi tervezet: bruttó 390 Ft, heti komplex csomag (heti keretterv + 5 napi részletes tervezet): bruttó 890 Ft. Egyszeri díj, nincs előfizetés.
- **Fizetési kapu:** `services/stripeService.js` (Checkout Session). A webhook (`/api/webhook/stripe`) `express.raw` feldolgozást igényel a sima `express.json` előtt.
- **Számlázás:** `services/invoiceService.js` (Számlázz.hu Agent XML), számla előtag: `OVITE`, bizonylatszám és tiszta rendelésszám generálás. A PDF számlák archiválása és továbbítása közös e-mailben történik a megrendelt Word és PDF fájlokkal.
- **Zárolt előnézet:** Fizetés előtt a foglalkozásmenet és a részletes módszerek nem kerülnek a DOM-ba; feloldás után az anyag szerkeszthető és letölthető.
