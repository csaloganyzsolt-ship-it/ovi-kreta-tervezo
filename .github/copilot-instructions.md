# OviTervező – Projekt és fejlesztési irányelvek

## 1. Üzleti cél és termékek
Az **OviTervező** (`ovitervezo.hu`, üzemeltető: Csalogány Zsolt egyéni vállalkozó) egy AI-alapú magyar óvodai és egyetemi pedagógiai tervezetkészítő webalkalmazás.
- **5 támogatott termékcsomag** (`backend/services/pricing.js`):
  1. `daily` – Napi óvodai tervezet
  2. `weekly` – Heti óvodai keretterv
  3. `weekly_detailed` – Heti komplex csomag (heti keretterv + választható napokra bontott részletes napi tervezetek)
  4. `academic_daily` – Oktatási célú (hallgatói/egyetemi) napi foglalkozási terv (A4 álló, percre bontott 3 oszlopos táblázat, szakirodalmi hivatkozásokkal)
  5. `academic_weekly` – Oktatási célú egyhetes tematikus terv (A4 fekvő, 7 oszlopos mátrix)
- **Árazás és AI-beállítások:** Nem beégetett konstansokból, hanem a Supabase `system_settings` táblából töltődnek be (`GET /api/config`, `backend/services/settingsService.js`).
- **Fizetés és számlázás:** Elsődleges fizetési mód a **Barion** (másodlagos/fallback: Stripe), automatikus e-számla kiállítás a **Számlázz.hu** API-n keresztül.
- **Nyelv és tilalmak:** Minden felhasználói felület, hibaüzenet, e-mail és dokumentumszöveg magyar nyelvű. A generált tervezetekben és az új kódban TILOS a régi munkanév (`OviKréta`) vagy külső elektronikus naplórendszerek nevének használata.

## 2. Mappaszerkezet és architektúra
- `backend/` – Node.js + Express (CommonJS):
  - `server.js` (fő Express alkalmazás és `/api/generate`, `/api/config`, `/api/feedback`, `/api/telemetry`), `app.js` (Nethely Passenger belépési pont).
  - `routes/` (`account.js`, `admin.js`, `payment.js`).
  - `services/` (üzleti logika: AI, fizetés, számlázás, Supabase, levelezés, admin).
  - `utils/` (`logger.js`, `rateLimits.js`).
- `frontend/` – Vanilla HTML, CSS (`styles.css`) és klasszikus globális hatókörű JS fájlok (`frontend/js/`):
  - **FONTOS:** A frontend JS fájlok **nem ES modulok** (`type="module"` nélkül, `<script src="js/...">` sorrendben töltődnek be, a felső szintű függvények/változók közös globális hatókörben élnek). A `tervezo.html` betöltési sorrendje kötött: `js/config.js` → `js/site.js` → `js/auth.js` → `js/tervezo-core.js` → `js/tervezo-academic.js` → `js/tervezo-form.js` → `js/tervezo-preview.js` → `js/tervezo-export.js` → `js/tervezo-generate.js` → `js/tervezo-paywall.js` → `js/tervezo-history.js` → `js/tervezo-init.js`.
  - A `js/config.js` fejlesztéskor a repóban lévő fájl, a backend `/js/config.js` útvonala dinamikusan állítja elő; a Nethely build a `dist-nethely/js/config.js` fájlt generálja.
  - Az új frontend fájlokat a `backend/services/siteConstants.js` `PAGES` / `SITE_ASSETS` listájába is fel kell venni (útvonal a `frontend/` gyökeréhez képest, pl. `js/site.js`), különben nem kerülnek be a buildbe és a backend nem szolgálja ki őket.
  - A statikus kiszolgálás a backendben (`STATIC_ROOT = frontend/`) és a `scripts/build-nethely.js` is a `frontend/` mappából dolgozik; a `.htaccess` a repó gyökerében marad, a build másolja a `dist-nethely/` mappába.
  - A dokumentum-előnézet saját A4-es laptördelőt használ (`paginateDocument`), az exportok kliensoldalon készülnek (`pdfmake`, `docx`, `JSZip`).
- `scripts/` – Build (`build-nethely.js`, `cache-bust.js`, `copy-assets.js`), oldalellenőrző (`check-site.js`) és fejlesztői segédszkriptek.
- `supabase/migrations/` – Adatbázis sémák és RLS szabályok.
- `tests/` – Node beépített test runner (`node --test`) + jsdom tesztek és `golden/` referenciafájlok.
- `docs/` – Műszaki dokumentációk.

## 3. Kötelező fejlesztési és biztonsági szabályok
1. **Titkok és konfiguráció:** Soha ne írj API-kulcsot, jelszót vagy fallback titkot a kódba. Minden új környezeti változót dokumentálj a `.env.example` fájlban is.
2. **Fizetőfal és árak:** A fizetőfal zárolását (`shouldLockPlan`) és a csomagárakat kizárólag a backend határozhatja meg; a kliensoldali értékekben soha ne bízz meg.
3. **XSS és injektálás elleni védelem:** Minden AI-választ és felhasználói bemenetet `escapeHtml` / `formatTableCell` / `escapeXml` függvényen át jeleníts meg.
4. **Hiba- és adatkezelés:** Ne nyelj el hibákat csendben (üres objektummal visszatérve). Adatbázis-változtatáshoz mindig készíts új SQL migrációs fájlt a `supabase/migrations/` mappába RLS szabályokkal.
5. **Ellenőrzés minden módosítás után:** Bármilyen fájlmozgatás, útvonal-módosítás vagy logikai változtatás után kötelező futtatni:
   - `npm test`
   - `node scripts/build-nethely.js`