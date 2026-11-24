# OviTervező – műszaki állapotfelmérés és biztonsági audit

Dátum: 2026-11-24. Csak olvasási audit készült, a kódot nem módosítottam. A tesztet (`npm test`) nem futtattam, mert írhat a `data/` mappába.

Az összeállítás célzott olvasáson és grepen alapul, nem minden sor átolvasásán. A `>400` soros fájlokat nem olvastam végig (pl. `mailService.js`, `planStore.js`, `adminService.js`).

## 1. Fájltérkép

A projektgyökér git-gyökér is. A `.agents/` alatt 40 követett skill-fájl van (supabase, postgres best-practices).

**a) HTML és CSS**
- Oldalak: `index.html` (landing), `tervezo.html`, `profil.html`, `admin.html`, `ertekeles.html`, `leiratkozas.html`.
- Közös stíluslap: `styles.css` (2385 sor).
- SEO és ikonok: `sitemap.xml`, `robots.txt`, `favicon.svg`, `favicon.ico`, `logo.svg`, `assets/og-preview.png`, `assets/Barion adatok/{png,svg}`.

**b) Frontend JS – betöltési sorrend oldalanként**

| Oldal | Fejben | Lap alján (sorrend) |
|---|---|---|
| `index.html` | `theme-init`, `barion-pixel`, `telemetry` | `config` → `site` → `auth` |
| `tervezo.html` | `theme-init`, `barion-pixel`, `telemetry` | `config` → `site` → `auth` → `tervezo-core` → `-academic` → `-form` → `-preview` → `-export` → `-generate` → `-paywall` → `-history` → `-init` |
| `profil.html` | `theme-init` | `config` → `site` → `auth` → `profil` |
| `admin.html` | `theme-init` | `config` → `site` → `auth` → `admin` |
| `leiratkozas.html` | `theme-init` | `config` → `site` → `leiratkozas` |
| `ertekeles.html` | – | `config` → `site` (nincs `theme-init`) |

**c) Backend**
- Belépési pont: `server.js` (870 sor), valamint `app.js` (Nethely/Passenger indító, `require('./server').start`).
- Route-ok: `routes/account.js`, `routes/admin.js`, `routes/payment.js`.
- Service-ek:
  - Fizetés és számlázás: `barionService`, `stripeService`, `invoiceService`, `coupons`, `pricing`, `orderService`.
  - AI és tervek: `geminiService`, `academicPlan`, `generateValidation`, `responseReaders`, `defaultSystemPrompt`, `planStore`.
  - Levelek és adminisztráció: `mailService`, `newsletterService`, `sheetsService`, `adminService`.
  - Felhasználó, beállítások, mérés: `authService`, `profileService`, `settingsService`, `supabaseService`, `siteConstants`, `analyticsService`, `telemetryService`.
- Segédek: `utils/logger.js`, `utils/rateLimits.js`, `services/assets/mail-logo.png`.

**d) Build és deploy**
- `package.json`, `render.yaml`, `.htaccess`.
- `.github/workflows/{test,deploy,deploy-nethely}.yml`.
- `scripts/`: `build-nethely`, `build-pages`, `cache-bust`, `copy-assets`, `check-site`, `restart-local`, `sync-system-settings`, `import-csv-orders`, `test-email`.
- `.vscode/tasks.json`.
- A `dist-nethely/` és `dist-pages/` generált és gitignore-olt.

**e) Tesztek, SQL, dokumentáció**
- 20 tesztfájl a `tests/` alatt, plusz `fixtures.js`, `pdf-helpers.js` és `golden/*`.
- 9 migráció a `supabase/migrations/` alatt.
- Dokumentáció: `README.md`, `docs/ADATOK_ES_BEALLITASOK.md`, `Terv.md`, `audit_report.md`, `Gemini-API-szukseges-adatok-es-tesztterv.md`, `supabase_email_templates.md`, `Parancsok.md`.
- `.github/copilot-instructions.md` módosított állapotban van.

**f) Gyanús, árva vagy felesleges**

| Fájl | Megjegyzés |
|---|---|
| `krumpli.md` | Gitignore-ban, a mappában van, nem követett. |
| `.DS_Store` | Gitignore-ban. |
| `Parancsok.md` | 4 soros jegyzet. |
| `Terv.md`, `audit_report.md` | Régi tervek és jelentések, nincs rájuk hivatkozás. |
| `Gemini-API-szukseges-adatok-es-tesztterv.md` | Régi dokumentum. |
| `skills-lock.json` | Az `.agents/skills` zárfájlja. |
| `scripts/sync-system-settings.js`, `import-csv-orders.js` | Egyszer használatos, nincs rájuk hivatkozás. |
| `services/defaultSystemPrompt.js` | Csak egy fájl hivatkozik rá. |
| `assets/Barion adatok/Dev guide.pdf` | A szerver nem szolgálja ki, a másoló sem viszi át. |
| `.github/workflows/deploy.yml` | A GitHub Pages staging kimenet. A `copilot-instructions.md` szerint a Pages deploy már nem cél. |

A `scripts/copy-assets.js` és a `cache-bust.js` csak más szkriptek hivatkozzák, ez rendben van.

**Az `.env.example` elavult.** A használt változókból 27 hiányzik belőle, tíz, a kódban már nem használt változó viszont szerepel benne (lista a 2. pontban).

## 2. Betöltési lánc és környezeti változók

**Kiszolgálás és másolás**
- A `server.js` (134. sortól) fehérlistával szolgálja ki a fájlokat: `PAGES + SITE_ASSETS` (`siteConstants.js`), `/assets` csak képkiterjesztéssel, valamint `SEO_FILES`.
- A `/config.js` dinamikus, a környezeti változókból készül (`server.js:165`).
- A `build-nethely.js` és a `build-pages.js` a `PAGES` fájlokat a `cache-bust`-on át írja `dist-*`-ba, a `SITE_ASSETS`-et és a `SEO_FILES`-t másolja, az `assets/`-et a `copy-assets` viszi át, a `config.js`-t generálja, és a `.htaccess`-t másolja.
- Az `app.js` a Nethely Passenger-hez készült belépési pont.

**Környezeti változók, amelyek nincsenek a `.env.example`-ben**
- Korlátok és kuponok: `ACCOUNT_RATE_LIMIT`, `ACCOUNT_DELETE_RATE_LIMIT`, `ADMIN_RATE_LIMIT`, `ADMIN_SEND_RATE_LIMIT`, `API_RATE_LIMIT`, `COUPON_RATE_LIMIT`, `GENERATE_RATE_LIMIT`, `PAYMENT_RATE_LIMIT`, `COUPON_CODES`, `GEMINI_RETRY_DELAY_MS`.
- Backend címek: `API_BASE_URL`, `BACKEND_URL`, `RENDER_EXTERNAL_URL`.
- Barion és számlázás: `BARION_PAYEE_EMAIL`, `BARION_PIXEL_ID`, `BARION_POS_KEY`, `BARION_TEST_MODE`, `BILLING_PROFILE`, `SZAMLAZZ_API_KEY`, `SZAMLAZZ_API_KEY_EV`, `SZAMLAZZ_API_KEY_KFT`, `SZAMLAZZ_INVOICE_PREFIX`, `SZAMLAZZ_VAT_RATE`.
- Titkok és tárolás: `DATABASE_URL`, `FEEDBACK_SECRET`, `INVOICE_STORE_PATH`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TURNSTILE_SITE_KEY`.
- A `SUPABASE_URL` és a `SUPABASE_SECRET_KEY` nélkül a fiókok, a rendelések, a kuponok és a naplózás nem működik. A `FEEDBACK_SECRET` védelmi funkciót lát el (lásd 3. pont).

**Dokumentált, de a kódban nem használt változók:** `COMPANY_NAME`, `COMPANY_TAX_ID`, `COMPANY_REG_NO`, `COMPANY_ADDRESS`, `GEMINI_MODEL`, `SZAMLAZZ_AFA`, `SZAMLAZZ_PREFIX`, `TEST_DELIVERY_ENABLED`, `TEST_DELIVERY_ORIGINS`, `TEST_DELIVERY_RECIPIENTS`.

**A `render.yaml`-ból hiányzik** (a kód használja): `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`/`STRIPE_WEBHOOK_SECRET` (csak a `_EV`/`_KFT` változat van benne), `TURNSTILE_SECRET_KEY`, `DAILY_GENERATION_CAP`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `FEEDBACK_SECRET`, `BACKEND_URL`.

A `render.yaml` éles beállításai közül kettő eltér a várt éles értéktől: `SZAMLAZZ_SANDBOX=true` és `BARION_TEST_MODE=true`.

## 3. Biztonsági audit

Nem találtam kódba égetett titkot. A git-történetben `sk_live_`, `whsec_`, `AIza`, `sb_secret` vagy privát kulcs nincs, csak tesztfixtúrák. A `config.js`-ben publikus értékek vannak: Supabase publishable kulcs, Turnstile site key, Barion pixel ID és a cégadatok. A `.env` a gitignore-ban van és nincs követve.

### Magas

| # | Hely | Probléma |
|---|---|---|
| 1 | `services/stripeService.js:163` | A mock ágban bármilyen `cs_mock_*` azonosító `paid:true`-t ad (`mockSessions.get(id) \|\| {}`). A védelem csak `NODE_ENV=production`-nél él (`assertPaymentsAvailable`). Ha a Nethely/Passenger alatt a `NODE_ENV` nincs beállítva és nincs Stripe-kulcs, a fizetőfal megkerülhető. A Render-en ez rendben van (`render.yaml`). |
| 2 | `services/mailService.js:107` | A `FEEDBACK_SECRET` és a Stripe-kulcs hiányában a HMAC-kulcs a beégetett `'ovitervezo-feedback-key'`. Ezzel bárki érvényes aláírást gyárthat bármelyik e-mailhez a `/api/feedback` (`server.js:773`) hívásához, és a rendszer spamet küldhet az adminnak. A `FEEDBACK_SECRET` nincs a `render.yaml`-ban és a `.env.example`-ben sem. |
| 3 | `routes/payment.js:96`, `server.js:127` (`/api/deliver/:id`) | A kuponos beváltás (`applyCoupon`) a kliens által megadott, nem ellenőrzött e-mail címet menti. A kézbesítés ezután akár 18 MB-nyi, kliens által küldött mellékletet küld erre a címre a te SMTP-dről. Az `/api/deliver/:id` 25 MB-os body limittel az általános rate limiter előtt van. Kuponkóddal rendelkező támadó levélrelayként használhatja (phishing, spam). |
| 4 | `server.js:545` | A `getClientIp` elsőként a kliens által küldhető `CF-Connecting-IP`/`X-Forwarded-For` fejlécet olvassa. A Render nem Cloudflare mögött van, ezért a fejléc hamisítható: megkerülhető a generálás IP-limitje és az `activeGenerationsByIp` védelem. Fennmarad a napi plafon (250) és a Turnstile. |

### Közepes

| # | Hely | Probléma |
|---|---|---|
| 5 | `server.js:607` | A Turnstile alól az `Origin: https://csaloganyzsolt-ship-it.github.io` fejléc mentesít, és ez hamisítható. A `TURNSTILE_SECRET_KEY` hiányában a `verifyTurnstileToken` `true`-t ad (615. sor), tehát fail-open. A `render.yaml`-ban a kulcs nincs felvéve. |
| 6 | `render.yaml:61`, `services/coupons.js:11` | A `COUPON_CODES=TEST100` egy 100%-os, nyilvános kuponkód a commitban. Ha a Supabase `coupons` tábla nincs bekötve, ez az élesben beváltható kupon. A beváltás és a `max_uses` ellenőrzés sem atomikus (versenyhelyzet). |
| 7 | `server.js:758` | A `/api/generate` hibaválasza a `details: reason` mezőben belső hibaszöveget ad vissza (Gemini hibák, URL-részletek). |
| 8 | `server.js:112-118`, `.htaccess:17` | A CSP csak `Report-Only`, tehát nem véd. Nincs `report-uri`. A `connect-src` `https://*.onrender.com` túl széles. |
| 9 | `routes/payment.js:353` | A `/api/create-checkout-session` nem kapott dedikált limitert (csak a globális 120/perc). A `GET /api/checkout-session/:id` és `/api/invoice/:id` hitelesítés nélküli: a session ID a bizonyíték. A Barion ID 96 bit véletlen, ez elfogadható, de a számla-PDF személyes adatot tartalmaz. |
| 10 | `services/sheetsService.js:28` | Név, e-mail és számlázási cím kerül egy Google Apps Script webhookra. Ez adatfeldolgozói viszony: GDPR-tájékoztató és megőrzési szabály kell hozzá. Az URL titok, a végpont hitelesítése nem látszik. |
| 11 | `barionService.js:57-75`, `invoiceService.js:122-162` | A fizetési rekordok és a számla-PDF-ek helyi fájlban vannak (`data/`). A Render free-nél ez nem tartós, deploy után elvész: a fizető vásárló nem tudja feloldani a tervét, és a 8 éves számla-megőrzés sem teljesül. A fájlírás nem atomikus (olvasás-módosítás-írás). |
| 12 | `supabase/migrations/` | A kód használja a `coupons`, `coupon_redemptions` és `documents` táblákat, de nincs hozzájuk migráció a repóban. A RLS és a jogosultságok nem ellenőrizhetők, és a séma nem reprodukálható. |

### Alacsony

| # | Hely | Probléma |
|---|---|---|
| 13 | `barionService.js:49-53` | A callback URL a `BACKEND_URL`/`RENDER_EXTERNAL_URL` hiányában a `Host` fejlécből épül. |
| 14 | `routes/payment.js:21` | A `recordOwner` leírása sérült szöveget tartalmaz (`******`). Kód nem sérült, a komment javítandó. |
| 15 | `services/newsletterService.js:28-34` | A `sanitizeHtml` regexes tiltólista. Védi a sandboxolt admin-iframe (`sandbox=""`), a levelezők pedig nem futtatnak scriptet, ezért az igazi kockázat alacsony. A `ctaUrl` https-ellenőrzött. |
| 16 | `profileService` | Feltételezem, hogy a newsletter-token hossza és entrópiája megfelelő, de nem ellenőriztem. |

### Amit rendben találtam
- **Hitelesítés:** a Supabase token ellenőrzése a szerveren történik (`authService.js`), megerősített e-mail kell hozzá. Az admin kettős ellenőrzést kap: `ADMIN_EMAIL` egyezés és `profiles.is_admin = true` (`authService.js:76-95`). Az admin route-ok mind `requireAdmin` mögött vannak.
- **Fizetés:**
  - A Barion visszahívás csak a `paymentId`-t használja, az állapotot a Barion API-tól kérdezi le. Ellenőrzi az összeget, a pénznemet és a `PaymentRequestId`-t (`barionService.js:265-267`).
  - A Stripe webhook aláírása ellenőrzött (`constructWebhookEvent`), a nyers body a JSON parser előtt érkezik.
  - Az ár a szerverről jön, a kliens csak a csomagkulcsot adja.
  - A zárolást csak a szerver kapcsolhatja ki (`shouldLockPlan`).
- **XSS:** a frontend az AI-válaszokat `escapeHtml` és `formatTableCell` után írja be (`tervezo-core.js:87`, `:96`). Az `innerHTML` helyek mind escape-eltek. Az admin és a profil `textContent`-et használ. Az e-mail sablonok `escapeHtml`-t használnak.
- **Számlázz.hu:** minden XML-mező `escapeXml`-en megy át (`invoiceService.js`).
- **Naplózás:** a `utils/logger.js` kiszűri a kulcs/token/jelszó mezőket.
- **Adatbázis:** minden migrációban van RLS és `revoke`, az `is_admin` és a `newsletter_*` oszlopokra a böngészőnek nincs írási joga.

## 4. Kódminőség és technikai adósság

- **Régi elnevezések:** az `oviKreta*` localStorage-kulcsok `tervezo-core.js:43-49` (7 kulcs), `tervezo-paywall.js` (`Unlocked`, `PaidSessions`, `PendingBarion`, `PendingCheckout`, `AppliedCoupon`), `theme-init.js:3`, és a tesztekben. Két stílus keveredik: `oviKreta_dailyCount` aláhúzással, `oviKretaTheme` nélküle. Átnevezéskor migrálni kell, különben a felhasználók elveszítik a feloldott terveiket. Ezen kívül az `ovi-kreta-tervezo` név a Render szolgáltatás (`ovi-kreta-tervezo-api`), a repo neve és a `package.json` neve.
- **Duplikált kód:** a `FAST_MODEL` és `PREMIUM_MODEL` két helyen van, és eltérnek: `server.js:32-33` (a prémium `gemini-4-argon`) és `geminiService.js:3-4` (mindkettő `gemini-3.1-pro-preview`). A `buildBlacklistRule` is dupla: `server.js:48` és `geminiService.js:13`. A CSP szövege három helyen él (`siteConstants.js`, `.htaccess`, a tesztek).
- **Hibakezelés:** a fájlalapú tároló (`readStore`) minden hibát elnyel, és `{}`-t ad vissza, így egy sérült JSON csendben nullázza a fizetési rekordokat. A `server.js` a `/api/generate`-nél a belső hibát visszaadja (lásd #7).
- **Inkonzisztenciák:**
  - Az `app.js` a `.env`-t tölti, a `server.js` nem; a `start:backend` szkript külön `dotenv/config`-ot használ.
  - Az `ertekeles.html`-ben nincs `theme-init`.
  - A tesztben és a `copilot-instructions.md`-ben Stripe szerepel, a gyakorlatban Barion az elsődleges.
  - A két workflow (`deploy.yml` Pages, `deploy-nethely.yml`) párhuzamosan él.
- **Dokumentáció:** az `.env.example` elavult (lásd 2. pont). A korábbi projektleírás Stripe-ot és csak 390/890 Ft-ot említ, a kód ötféle terméket kezel (`pricing.js`: `daily`, `weekly`, `weekly_detailed`, `academic_daily`, `academic_weekly`), az árak pedig a Supabase `system_settings`-ből jönnek.

## 5. Javasolt mappaszerkezet (csak terv)

```
/
├── backend/            server.js, app.js, routes/, services/, utils/
├── frontend/           *.html, *.js (tervezo-*.js → js/), styles.css, assets/, config.js
├── scripts/            build-*.js, cache-bust.js, copy-assets.js, check-site.js …
├── supabase/migrations/
├── tests/
├── docs/               README, Terv, audit_report, Gemini doc …
├── .github/, .vscode/, render.yaml, package.json, .env.example
```

**Az átköltöztetéskor módosítandó helyek:**

| Hely | Teendő |
|---|---|
| `package.json` | `start`, `start:backend`, `dev` → `backend/server.js`. A `test` szkript útvonalai (`scripts/check-site.js`, `tests/*.test.js`) megmaradnak, ha ezek a mappák nem mozognak. |
| `render.yaml` | `startCommand` (`npm start`) változatlan, ha a `package.json` megy. Ellenőrizd a `rootDir`/`buildCommand` beállítást. |
| `server.js:135`, `server.js:146` | `STATIC_ROOT = __dirname` → a frontend mappa (`path.join(__dirname, '..', 'frontend')`). Ugyanígy az `assets` útvonal. |
| `siteConstants.js` | `PAGES`, `SITE_ASSETS`, `SEO_FILES` elé előtag, vagy a `scripts/*` ezeket a `frontend/`-hez oldja fel. |
| `scripts/build-nethely.js`, `build-pages.js` | `root` és a `fs.copyFileSync(path.join(root, file), ...)` hívások a `frontend/` mappából olvassanak. A `.htaccess` marad a gyökérben, vagy a másolás útvonala változik. |
| `scripts/copy-assets.js` | `path.join(root, 'assets', …)` → `frontend/assets`. |
| `scripts/check-site.js` | `process.cwd()`-alapú útvonalak (`path.join(process.cwd(), file)`) a `frontend/`-re. |
| `.github/workflows/deploy-nethely.yml`, `deploy.yml` | A `local-dir: ./dist-nethely/` és `path: ./dist-pages/` nem változik, mert a build kimenet marad. A `test.yml` útvonalait nézd át. |
| `tests/*.test.js`, `tests/fixtures.js` | A `require('../server')` → `../backend/server`, a `require('../services/...')` → `../backend/services/...`. A frontend tesztek (jsdom) betöltött fájljainak útvonala (`frontend.test.js`, `payment.test.js`, `barion.test.js`) a `frontend/`-re mutasson. |
| `.vscode/tasks.json`, `scripts/restart-local.js` | A `server.js` elérési útja. |
| `README.md`, `docs/` | A parancsok és az `app.js` mint Nethely belépési pont leírása. |
| `invoiceService.js:122` | A `data/` útvonal relatív a `services/`-hez (`path.join(__dirname, '..', 'data', …)`). Mozgatáskor ez az útvonal eltolódik, ezért érdemes a `INVOICE_STORE_PATH`-t kötelezően beállítani, és tartós lemezre (vagy Supabase-re) tenni. |

A legnagyobb kockázatú lépések a `STATIC_ROOT`, a build-szkriptek `root`-ja és a tesztek `require` útvonalai. Ezeket az átköltöztetés után a `npm test` és egy `node scripts/build-nethely.js` próbafuttatás ellenőrzi.

## Javasolt következő lépések

Fontossági sorrendben:
1. A `FEEDBACK_SECRET` kötelezővé tétele és a beégetett fallback törlése (#2).
2. A mock fizetési mód tiltása minden olyan környezetben, ahol nincs kifejezett `NODE_ENV=development`/`test` (#1).
3. A `getClientIp` védelme: megbízható proxy-sorszám (`req.ip`), és csak valódi Cloudflare mögött a `CF-Connecting-IP` (#4).
4. A kuponos e-mailcím ellenőrzése, az `/api/deliver` limiterének előrébb hozása, és a melléklet-relay szűkítése (#3).
5. A fizetési rekordok és számlák tartós tárolóra (Supabase vagy Render Disk) tétele (#11), és a hiányzó migrációk pótlása (#12).
6. A `.env.example`, a `render.yaml` és a CSP `Report-Only` → éles CSP átállás (#8).
