# Ovi-Kréta Tervező – Állandó Fejlesztési Irányelvek

## 1. Projekt Kontextus és Architektúra
- **Frontend:** Tiszta HTML/JS/CSS (`index.html`), amely közvetlenül böngészőben vagy GitHub Pages-en fut.
- **Backend:** Node.js / Express (`server.js`), amely Render.com-on fut és a Gemini API-t hívja meg (alapból `gemini-3.1-pro-preview`, prémium kapcsolóval `gemini-4-argon`; a `requestedModel` paraméter alapján).
- **Konfiguráció:** A frontend a `config.js` fájlból veszi a backend URL-jét (`apiBaseUrl`).
- **Cél:** Hivatalos, ONOAP- és Kréta-kompatibilis óvodai napi és heti tervezetek generálása.

## 2. Kötelező Munkafolyamat Minden Módosítás Végén (Deploy & Teszt)
Minden feladat vagy kódmódosítás befejezése után az AI KÖTELES elvégezni az alábbi lépéseket:
1. **Szintaxis és tesztellenőrzés:** Futtasd le a teszteket (`npm test`) és ellenőrizd a szintaxist (`node --check server.js`). Csak hibátlan kód mehet tovább!
2. **Git Commit:** Készíts tiszta, leíró üzenetű commitot a módosításokról (pl. `git add . && git commit -m "..."`).
3. **Automatikus feltöltés (Push):** Futtasd le a `git push` parancsot a távoli ágra (`main`), hogy a GitHub Actions CI lefusson, és a módosítás azonnal élesedjen a neten (GitHub Pages / Render) a felhasználói teszteléshez!
4. **Jelentés:** Röviden közöld, hogy mi módosult, átmentek-e a tesztek, és sikeresen felment-e a kód a GitHubra.

## 3. Minőségi és Kódolási Szabályok
- **Nincs csendes Fallback/Mock:** SOHA ne rejts el hibákat beégetett kamu táblázatsorokkal vagy sablonszövegekkel. Ha a backend vagy az API hibát dob, az jelenjen meg tisztán a felületen és a terminálban!
- **Biztonság:** A `GEMINI_API_KEY` és más titkos adat soha, semmilyen formában nem kerülhet be a frontendbe, sem a git commitokba! Mindig környezeti változóból (`process.env`) olvassa a backend.
- **Tervezetek kidolgozottsága:** Az óvodai napi és heti tervezetek generálásakor szigorúan tilos az elcsépelt, ismétlődő sablonok használata (pl. ne ismételje a "szemléltetés, frontális munka" kifejezést). Mindig életszerű, differenciált, módszertanilag gazdag leírásokat kell kikényszeríteni az AI promptban.
- **Formázás:** A tömbként érkező bekezdéseket a felületen mindig `<br><br>` tagekkel, olvashatóan kell renderelni.
- **Összegző lista teljessége:** A 4. lépés összefoglaló listájának kivétel nélkül minden létező és jövőbeli beállítási mezőt meg kell jeleníteni a felhasználó számára.

## 4. Nethely üzemeltetés és szervizréteg (OviTervező – ovitervezo.hu)
- **Belépési pont:** `app.js` (Nethely/cPanel „Application startup file”). A `server.js` exportálja a `start()` függvényt, a port a `process.env.PORT` változóból jön. Egy domain és port szolgál ki mindent.
- **Statikus kiszolgálás:** csak kifejezetten felsorolt útvonalak (`/`, `/index.html`, `/config.js`); SOHA ne `express.static('.')`, mert a `server.js` és a `.env` letölthetővé válna. A `/config.js` a környezeti változókból épül (`PAYWALL_ENABLED`, `COMPANY_*`, `SUPPORT_EMAIL`), titkos kulcs nem kerülhet bele.
- **Környezeti változók:** lásd `.env.example` (`GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `SZAMLAZZ_KEY`, `SZAMLAZZ_AFA`, `BASE_URL`). Titok soha nem kerül a frontendbe vagy gitbe.
- **Szervizréteg:** `services/stripeService.js` (Checkout Session, árak: napi 390 Ft, heti 890 Ft, szerver az igazságforrás), `services/invoiceService.js` (Számlázz.hu Agent XML, idempotens számlázás), `routes/payment.js` (`POST /api/create-checkout-session`, `GET /api/checkout-session/:id`, `POST /api/webhook/stripe` – utóbbi `express.raw`-val, az `express.json` ELŐTT).
- **Mock mód:** kulcsok nélkül csak fejlesztői módban, egyértelmű `mock: true` jelzéssel; `NODE_ENV=production` mellett 503 a hiányzó kulcsra.
- **Fizetési kapu:** `PAYWALL_ENABLED=true` esetén a frontend teaser + feloldás. Ez felületi kapu; a szerveroldali visszatartás külön fejlesztés. A jogi szövegeket jogásznak kell jóváhagyni.
- **Teszt üzemmód:** `sk_test_`/`pk_test_` kulcsokkal a Stripe Checkout valódi tesztmódban fut (tesztkártya: 4242 4242 4242 4242); `SZAMLAZZ_SANDBOX=true` csak teszt-üzem jelzés (a bizonylat rendes e-számla marad); az ügyfélszolgálati e-mail a `SUPPORT_EMAIL` (alapérték: info@csb-vill.com). Cégadatok (székhely, adószám, cégjegyzékszám, e-mail) alapértéke a `server.js` `/config.js` útvonalában és a `.env.example`-ben van.
- **Egyszeri fizetés:** a feloldás (`oviKretaUnlocked`, `oviKretaPaidSessions`) egy konkrét generált tervhez (`generationId`) tartozik; bármely űrlapmező-módosítás (`revokeIfPlanChanged`) vagy új generálás azonnal zárol. A „Tevékenység kidolgozása” kapcsoló fizetés előtt `disabled` és kikapcsolt.
- **Számla és közös e-mail:** a Számlázz.hu Agent `sendEmail=false`, `szamlaLetoltes=true`; a számla PDF-et a szerver a `data/invoices/<session>.pdf` fájlban tartja (`GET /api/invoice/:id`). `services/mailService.js` (SMTP_* változók) egyetlen levélben küldi a tervezetfájlokat (a böngésző állítja elő, `POST /api/deliver/:id`) és a számlát; SMTP nélkül csak a felületi letöltés működik. Render ingyenes csomagján a fájlrendszer ideiglenes.
- **Zárolt előnézet:** fizetés előtt csak a célok/eszközök és a táblázat első két sora látszik, ott is csak rövid kivonattal; a részletes foglalkozásmenet és a módszerek oszlop nem kerül a DOM-ba. A feloldó gombok (`.unlock-cta`) a „Tervezet elkészítése” mellett, az előnézet felső és alsó sávjában és a teaserben vannak, feloldás után a „Feloldva” jelvény váltja őket.

## 5. Árazás, zárolás és modell (rögzített szabályok)
- Három csomag: `daily` 390 Ft, `weekly` (napi bontás nélkül) 390 Ft, `weekly_detailed` (napi bontással) 890 Ft. A szerver (`services/stripeService.js` `PRODUCTS`) az egyetlen igazságforrás.
- Fizetés előtt a dokumentum nem tartalmazza a tevékenységi/foglalkozásmenet szekciót (`getExportSettings` → `activities=false` zárolt állapotban); csak a feloldó kapu és az értesítés jelenik meg.
- A „Prémium generálás” le van tiltva („Hamarosan elérhető”). Minden Gemini hívás kizárólag a `gemini-3.1-pro-preview` modellt használhatja (`resolveModel`, `callGemini`).
- Lépések közötti navigáció és űrlapmódosítás soha nem zárja vissza a kifizetett tervet; a feloldás csak új generálással (megerősítő ablak után) szűnik meg. Az előnézeti konténer (`#previewPanel`) kész dokumentum nélkül és az 1–3. lépésben rejtett.

## 6. Két környezet
- Nethely = éles (`build-nethely.js`, paywall be); GitHub Pages = staging (`build-pages.js`, paywall ki, `testDelivery`, `/api/test-deliver` csak `TEST_DELIVERY_ENABLED=true` mellett). Mindkettő a `main` pushra deployol.
