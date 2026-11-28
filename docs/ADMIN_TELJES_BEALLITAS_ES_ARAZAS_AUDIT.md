# Admin Központ – teljes beállítási és árazási audit

Készült: 2026-11-28 · Típus: csak olvasási felmérés (kód nem módosult) · Állapot: a `main` ágon, a „vizuális Tervező űrlap" commit (`3f6547d`) után.

Vizsgált fájlok: `frontend/admin.html`, `frontend/js/admin.js`, `backend/routes/admin.js`, `backend/services/settingsService.js`, `adminService.js`, `auditLog.js`, `pricing.js`, `stripeService.js`, `barionService.js`, `orderService.js`, `invoiceService.js`, `coupons.js`, `backend/routes/payment.js`, `generationCap.js`, `frontend/index.html`, `frontend/tervezo.html`, `frontend/js/*` (főleg `site.js`, `tervezo-init.js`, `tervezo-paywall.js`, `tervezo-preview.js`, `barion-pixel.js`), `supabase/migrations/*`.

---

## 0. Vezetői összefoglaló

**Ami jól működik**
- Az **árak szerver-igazsága** rendben van: az összeget mindig a szerver számolja (`pricing.productFor` → `system_settings.pricing`), a kliens ára figyelmen kívül marad (Barion `Total`/`UnitPrice`, Stripe `unit_amount`, számla `gross`). A Barion-callback összeget, pénznemet és `PaymentRequestId`-t is egyeztet (`barionService.js` ~242–244).
- A beállítás-validáció szigorú (egész szám 1–100 000, https-link, e-mail, modellnév-minta, ismeretlen kulcs → 400).
- A Tervező űrlap és a Téma-ajánlók **naplózva és egy kattintással visszaállíthatók**.

**Legfontosabb problémák**

| # | Szint | Mit találtam |
|---|-------|--------------|
| 1 | **Magas** | A fizetésindításnál a **csomagkulcsot a kliens adja** (`body.plan`), a szerver nem veti össze a mentett tervezet típusával. Heti csomag tervezetre `plan: "daily"` küldésével olcsóbban lehet feloldani (`payment.js` `createCheckout` / `applyCoupon` / `checkoutBarion` → `parsePlan(body.plan)`). Az új, `selectedDays`-függő árazás előtt **kötelezően javítandó**. |
| 2 | **Magas** | Az ár **8+ helyen beégetve** is szerepel: `index.html` (meta-leírás, JSON-LD, ártábla, GYIK, FAQ-schema), `site.js` (ÁSZF-szövegek), `barion-pixel.js`, `tervezo-paywall.js`, `pricing.js`. Az Admin-ármentés ezeket **nem frissíti**. |
| 3 | **Közepes** | A **Beállítások nagy része nem állítható vissza** `↺ Visszaállítás`-sal: csak `planner_config` és a téma-ajánlók (`auditLog.isRestorableKey`). Árak, AI, számlázási profil, fizetési szolgáltató stb. csak megtekinthetők az Előzményekben, kézzel kell visszaírni. |
| 4 | **Közepes** | **Kuponok létrehozása/módosítása/archiválása nincs auditnaplózva** (csak a kárpótlási kupon kap `logger.info` sort); a `coupons` tábla nincs a `system_settings_history`-ban. |
| 5 | **Közepes** | **AI-modell:** csak a névminta ellenőrzött (`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`), a létezést nem. Elgépelt modellnévvel **minden generálás hibára fut**. Nincs „Alapértelmezett modell/prompt" gomb, nincs próbahívás mentés előtt. |
| 6 | **Közepes** | `DAILY_GENERATION_CAP` környezeti változó **felülírja** az Admin plafont – ilyenkor az Admin mező „halott". A számláló szerverpéldányonként memóriában él. |
| 7 | **Alacsony** | Az ármezőkre nincs értelmességi korlát (pl. heti ≥ napi, 3900 elütés átmegy), nincs megerősítő párbeszéd. |
| 8 | **Alacsony** | Duplikált logika: `getSelectedDays` (`server.js` ~259) és `weeklySummary.daysOf` (~131) azonos kódja. |

Kupon-megjegyzés: **fix összegű kupon nincs** – csak százalékos (`discount_percent` 1–100). A kérésben szereplő „fix összegű" kuponhoz sémabővítés kell (lásd 3.6).

---

## 1. Bekötési mátrix – minden Admin fül és mező

Jelmagyarázat – **Bekötés:** ✅ végig bekötve · ⚠️ részben / beégetett érték is van · ❌ halott.
**Napló:** a `system_settings_history`-ba kerül-e. **↺:** működik-e az 1 kattintásos visszaállítás.

A `system_settings_history` DB-trigger (`log_system_settings_change`, migráció `20261203090000`) minden `UPDATE`-nél naplóz, a `changed_by` az `updated_by`-ból töltődik. Az `INSERT` (első mentés) a triggerben nincs; a seed-migrációk miatt ez a gyakorlatban nem jelentkezik, a `planner_config`-nál az explicit `auditLog.recordChange` pótolja.

### 1.1 Áttekintés (`tabOverview`)

| Elem | Mit csinál | Bekötés | Napló / ↺ | Kockázat |
|------|------------|---------|-----------|----------|
| Statisztika (`GET /admin/stats`) | Rendelések, bevétel, generálások, téma-statisztika | ✅ (közös `themeStats` forrás, lásd előző kör) | – (csak olvasás) | Alacsony |
| Napi generálás számláló (`dailyGeneration`) | A mai generálások a plafon mellett | ✅ (`generationCap.js`, példányszintű memória) | – | Alacsony; több Render-példánynál a szám nem összesített |
| Eszköz-linkek (`adminToolsList`) | A Beállítások › Linkek gyorsgombjai | ✅ `rel="noopener noreferrer"`, https-szűrt | – | Alacsony |

### 1.2 Kuponkezelő (`tabCoupons`)

| Elem | Mit csinál | Bekötés | Napló / ↺ | Kockázat és védőkorlát |
|------|------------|---------|-----------|------------------------|
| Kupon létrehozás (`POST /admin/coupons`) | Kód, `discount_percent`, `max_uses`, `valid_until`, megjegyzés | ✅ `coupons.lookup` a fizetésnél | ❌ nincs history, nincs ↺ | **Közepes.** Védőkorlát: kód `^[A-Z0-9_-]{1,40}$`, százalék egész 1–100, lejárat ellenőrzés. Hiányzik: 100%-os kupon létrehozásának megerősítése, napló. |
| Módosítás (`PATCH`) / „törlés" (`DELETE`) | Aktív/inaktív, keret, lejárat; a törlés archiválás (`is_active=false`, `valid_until` tegnap, `[Archiválva/Törölve]`) | ✅ | ❌ | Közepes: véletlen archiválás nem naplózott, nincs visszavonás. |
| Kárpótlási kupon (`POST /admin/support/coupon`) | 100%-os, 1 használatos kupon e-mailre | ✅ | `logger.info` (rendszernapló), nem history | Alacsony |
| Beváltás (`payment.js` `applyCoupon`) | 100% → fizetés/számla megkerülése, 1–99% → csökkentett Barion-összeg | ✅ szerver-oldali `computeDiscount` | Beváltás: `coupon_redemptions` | Alacsony; a részleges kupon a Barion-összeget **szerveren** számolja. |
| Fix összegű kupon | – | ❌ **nem létezik** | – | Lásd 3.6. |

### 1.3 Rendelések és számlák (`tabOrders`)

| Elem | Mit csinál | Bekötés | Napló / ↺ | Kockázat |
|------|------------|---------|-----------|----------|
| Rendeléslista, szűrők | `orders` tábla | ✅ | – | Alacsony |
| Újraküldés / csak számla küldése | E-mail újraküldés (`resend`, `send-invoice`) | ✅ `mailService` | rendszernapló | Alacsony |
| Számlakiállítás (`issue-invoice`) | Számlázz.hu Agent XML | ✅ `invoiceService.buildInvoiceXml` | rendszernapló | **Közepes**: valódi számla keletkezik; az aktív számlázási profilt használja. 0 Ft-os rendelésnél blokkolt. |
| Számla PDF (`/orders/:n/invoice`) | Élő letöltés, mentés nélkül (GDPR-barát) | ✅ | – | Alacsony (fájlnév szűrt) |

### 1.4 Felhasználók, Értékelések, Hírlevél, Rendszernapló

| Fül | Funkció | Bekötés | Napló / ↺ | Kockázat |
|-----|---------|---------|-----------|----------|
| Felhasználók | Lista, hírlevél-állapot kapcsoló | ✅ | rendszernapló | Alacsony |
| Értékelések | Moderálás (státusz, törlés, válasz e-mail) | ✅ | `logger.info` (`admin_reviews`), nem history; végleges törlés **nem** visszaállítható | Közepes (véglegesen törölhető) |
| Hírlevél | Előnézet, küldés (`sendLimiter`), kampánylista | ✅ | kampánytábla | **Közepes**: tömeges kiküldés; a küldés elindulása után nincs visszavonás |
| Rendszernapló | Naplók + „Módosítási napló" (history) | ✅ | – | Alacsony; a titkos nevű mezők maszkoltak (`adminService.maskValue`) |

### 1.5 Téma-ajánlók (`tabThemes`)

| Elem | Bekötés | Napló / ↺ | Kockázat |
|------|---------|-----------|----------|
| Téma CRUD, aktív kapcsoló, prioritás, időszak | ✅ DB → `GET /api/theme-suggestions` → tervező chipek (beépített fallback hibánál) | ✅ `theme_suggestion:<id>` kulcs, **↺ működik** (`restoreAudit`) | Alacsony. Védőkorlát: SQL `CHECK`-ek (`category`, `season`, `MM-DD`), szerver-validáció. |
| `Használat` oszlop | ✅ `usage_count` + közös téma-statisztika | – | Alacsony |

### 1.6 Tervező űrlap (`tabPlanner`)

| Elem | Bekötés | Napló / ↺ | Kockázat |
|------|---------|-----------|----------|
| Szövegek (címkék, súgók, placeholderek, összegző feliratok) | ✅ `system_settings.planner_config` → `/api/config` → `applyPlannerConfig` / `plannerText` | ✅ explicit `auditLog.recordChange`, **↺ működik** | Alacsony. Szerver-fehérlista (ismeretlen kulcs → 400), hosszkorlát (label 140, egyéb 400), `textContent` renderelés. |
| Opciólisták (csoport, forma, energia, SNI/BTMN, IKT, péntek) | ✅ stabil `id`-k, `/api/generate` validáció elfogadja az átnevezettet | ✅ / **↺ működik** | Közepes: a címke a promptba is bekerül (tisztított). Gyári opció nem törölhető, csak rejthető. |
| Védett (Piros) elemek | 🔒 csak megjelenítés | – | Védve (validáció 400) |
| „Minden alapértékre" (`reset`) | ✅ | ✅ naplózva | Alacsony; megerősítő kérés javasolt (nem vizsgáltam) |

### 1.7 Beállítások › Általános & Árazás (`subTabGeneral`)

| Mező | Mit csinál | Bekötés | Napló / ↺ | Veszélyesség és védőkorlát |
|------|------------|---------|-----------|----------------------------|
| `setMaintenance` (`maintenance_mode`) | Karbantartás: új generálás tiltása | ✅ `server.js` ~659 (`MAINTENANCE_MODE` hiba) + `appConfig.maintenance` a tervezőben | trigger ✅ / ↺ ❌ | **Közepes**: bekapcsolva azonnal leáll az új generálás. Csak boolean-validáció. A fizetés/kézbesítés nem áll le (szándékos lehet). |
| `setPriceDaily` (`pricing.daily`) | Napi ár **és a heti összesítő ára is** | ⚠️ szerver ✅ (`pricing.js`, Barion, Stripe, számla), felület részben, **beégetett másolatok**, lásd 2. fejezet | trigger ✅ / ↺ ❌ | **Magas** üzleti hatás. Védőkorlát: egész 1–100 000. Hiányzik: relációs ellenőrzés, megerősítés. |
| `setPriceWeekly` (`pricing.weekly`) | Teljes heti csomag fix ára | ⚠️ mint fent | trigger ✅ / ↺ ❌ | Magas |
| `setPriceAcademicDaily` / `…Weekly` | Oktatási célú napi/heti ár | ⚠️ mint fent | trigger ✅ / ↺ ❌ | Magas |
| `setDailyCap` (`daily_generation_cap`) | Napi szerver-plafon (Gemini-költségvédelem) | ⚠️ `generationCap.js`, de a **`DAILY_GENERATION_CAP` env felülírja** | trigger ✅ / ↺ ❌ | Közepes: 1–100 000. Túl alacsony → leáll a szolgáltatás; túl magas → költségkockázat. |
| `setAnnouncementEnabled` / `setAnnouncementText` | Főoldali hirdetősáv (≤200 kar.) | ✅ `/api/config` → `site.js` `textContent` | trigger ✅ / ↺ ❌ | Alacsony: `textContent` (XSS-mentes); bekapcsolt sávhoz szöveg kötelező. Csak az `index.html` (`data-announcement-bar`) mutatja. |

### 1.8 Beállítások › AI (`subTabAi`)

| Mező | Mit csinál | Bekötés | Napló / ↺ | Veszélyesség |
|------|------------|---------|-----------|--------------|
| `setAiModel` (`ai_config.model`) | Gemini modellnév | ✅ `settingsService.resolveAiModel` → `server.js` ~666 | trigger ✅ / ↺ ❌ | **Közepes–Magas**: csak a névminta ellenőrzött, a létezés nem → elgépelés = minden generálás hibás (a hiba hangosan jelenik meg, nincs csendes tartalék). A kód alapmodellje `FAST_MODEL` (`server.js:38`) csak formailag érvénytelen névnél lép be. |
| `setAiPrompt` (`ai_config.system_prompt`) | Rendszer prompt | ✅ `server.js` ~549, ~708 | trigger ✅ (a teljes szöveg a naplóban) / ↺ ❌ | **Magas**: nem üres, ≤100 000 kar.; **nincs** ellenőrzés arra, hogy a JSON-kimeneti szerződés és a szakmai szabályok megmaradnak-e. Nincs „Gyári prompt" gomb az Adminban. |
| Token-limit | – | ❌ **nem Admin-beállítás**: `maxOutputTokens`/`timeout` a kódban rögzített (`server.js` ~710, `weeklySummary`, `academicPlan`) | – | Nem elrontható az Adminból (jó), de nem is állítható. |

### 1.9 Beállítások › Számlázás és fizetés (`subTabBilling`)

| Mező | Mit csinál | Bekötés | Napló / ↺ | Veszélyesség |
|------|------------|---------|-----------|--------------|
| Szerver állapota (`billingStatusList`) | Csak olvasható: kulcsok/hozzáférések megléte | ✅ `/admin/billing-status` | – | Alacsony (értékek nem jelennek meg) |
| `setBillingProfile` (`ev` / `kft`) | Aktív kibocsátó (számla, e-mail lábléc, cégadatok) | ✅ `setActiveBillingProfile`, `invoiceService`, `siteConstants` | trigger ✅ / ↺ ❌ | **Magas**: rossz profil = hibás kibocsátó a számlán (számviteli/jogi kockázat). Csak enum-validáció, megerősítés nincs. A mentett érték felülírja a `BILLING_PROFILE` env-et. |
| `setPaymentProvider` (`barion` / `stripe`) | Aktív fizetési szolgáltató | ✅ `/api/config` → `site.js`, `tervezo-paywall.js`, `barion-pixel.js` | trigger ✅ / ↺ ❌ | **Magas**: ha a másik szolgáltató kulcsai/webhookja nincs kész, a vásárlók fizetése hibára fut (hangos hiba). Nincs előellenőrzés a mentéskor. |
| `notification_email`, `billing_…`, `error_…` | Üzemeltetői értesítési címek | ✅ `resolveNotificationEmail` (admin > közös > env) | trigger ✅ / ↺ ❌ | Alacsony–Közepes: e-mail formátum-ellenőrzés van; rossz cím = elveszett riasztás. |

### 1.10 Beállítások › Linkek, E-mail sablonok

| Mező | Bekötés | Napló / ↺ | Veszélyesség |
|------|---------|-----------|--------------|
| 5 külső link (`external_links`) | ✅ Áttekintés › Eszközök gombjai | trigger ✅ / ↺ ❌ | Alacsony: csak `https:`, ≤500 kar., nincs user:pass; `rel="noopener noreferrer"`. Nem ellenőrzött a célhoszt (adminnak szóló gombok). |
| E-mail sablonok (`base_layout`, `welcome_email`, `payment_success`, `feedback_request`, `password_reset`, `invoice_only`, egyedi) | ✅ `settingsService.getTemplates` → `mailService` | ✅ `email_template:<id>` kulccsal (`logTemplateChange`) / **↺ ❌** a napló-oldalon; a sablonszerkesztőben „Alapértékre állítás" gomb van | Közepes: a HTML-be kerülő változókat a validáció ellenőrzi (`validateTemplateContent`); hibás sablon a vevői levelet rontja el. |

### 1.11 Naplózási lefedettség összesítve

| Terület | History | ↺ |
|---------|---------|---|
| `planner_config` | ✅ | ✅ |
| `theme_suggestion:*` | ✅ | ✅ |
| `pricing`, `ai_config`, `maintenance_mode`, `daily_generation_cap`, `announcement_bar`, `external_links`, `billing_profile`, `payment_provider`, értesítési címek | ✅ (trigger) | ❌ |
| `email_template:*` | ✅ | ❌ |
| `coupons` | ❌ | ❌ |
| Értékelések / rendelés-műveletek | rendszernapló (`system_logs`) | ❌ |

**Javaslat:** a visszaállítható kulcsok körét ki lehet bővíteni a skaláris/JSON beállításokra (`pricing`, `ai_config`, `announcement_bar`, `external_links`, `maintenance_mode`, `daily_generation_cap`) – a `restoreAudit` már a `old_value`-t írja vissza, csak az `isRestorableKey` fehérlista és a hozzá tartozó validáció (`validatePatch`) kell. Becslés: **kicsi–közepes**. A `billing_profile`/`payment_provider` visszaállítását érdemes megerősítéshez kötni.

---

## 2. Árazási lánc nagyító alatt

### 2.1 A mostani út

```
Admin (setPriceDaily/Weekly/AcademicDaily/AcademicWeekly)
 → admin.js ~1152 → PATCH /api/admin/settings
 → settingsService.validatePatch (egész 1–100000) → updateSettings
 → system_settings.pricing (upsert) + history trigger + cache azonnali frissítés (5 perc TTL másik példányon)
 ├─ GET /api/config → publicConfig.pricing → tervezo-init.js applyPublicConfig → PAYWALL_PRICES   ✅ automatikus
 ├─ pricing.productFor → Stripe (unit_amount) / Barion (Total, UnitPrice) / coupon computeDiscount   ✅ automatikus
 ├─ orders.amount → invoiceService.buildInvoiceXml (gross = order.amount)                           ✅ automatikus
 └─ index.html, site.js (ÁSZF), barion-pixel.js, meta/JSON-LD, tesztek                              ❌ beégetett
```

Árkategória-leképezés (`settingsService.pricingTierFor`): `daily` → `daily`; `weekly_summary` → **`daily`** (ugyanaz az ár); `weekly_package` → `weekly`; `academic_*` → saját. Vagyis jelenleg **nincs külön „heti összesítő" ár**.

### 2.2 Hol frissül automatikusan, hol beégetett?

| Hely | Állapot | Megjegyzés |
|------|---------|------------|
| `pricing.js` `PRODUCTS[*].amountHuf` (390/390/890/690/690) | ⚠️ csak DB nélküli alapérték | A `productFor` felülírja a beállítással; elfogadható, de a `DEFAULT_SETTINGS.pricing` (`settingsService.js`) **második másolat** ugyanarra |
| `settingsService.DEFAULT_SETTINGS.pricing` | ⚠️ alapérték | |
| `tervezo-paywall.js:7` `PAYWALL_PRICES` | ✅ felülíródik `/api/config`-ból, de a **kezdeti érték és a `|| 390` tartalék** (`:102`, `tervezo-preview.js:162`) beégetett | A konfig betöltése előtt/hibánál 390 látszana |
| `tervezo-paywall.js` gomb/modál (`Teljes tervezet feloldása – X Ft`, `renderCheckoutPrice`) | ✅ `PAYWALL_PRICES`-ból | |
| `barion-pixel.js:32–34` (`daily` 390, `academic_daily` 690, `weekly_package` 890) | ❌ **beégetett** | Marketing-pixel `unitPrice`; a vásárlás (`purchase`) a szerver `amountHuf`-ját használja, de a `addToCart` a beégetett értéket küldi |
| `index.html` ~70 (`landing-note`: 390 / 890 / 690 Ft) | ❌ beégetett | Főoldali ártábla |
| `index.html` ~107 (GYIK „Mennyibe kerül…") | ❌ beégetett | Látható szöveg |
| `index.html` ~29 (**FAQPage JSON-LD**) | ❌ beégetett | A repo-szabály szerint a látható GYIK-kal **szó szerint egyeznie kell** |
| `index.html` ~26 (**SoftwareApplication** `AggregateOffer` `lowPrice 390`, `highPrice 890`, `offerCount 3`) | ❌ beégetett | Tesztelt (`payment.test.js:760–761`) |
| `site.js:40–42` és `:151–153` (ÁSZF/Adatkezelési modál: 390 / 890 / 690) | ❌ beégetett | **Jogi dokumentum** – árváltozásnál módosítani kell, és verziózni (`CONSENT_VERSION` `payment.js`) |
| `tervezo.html` | ✅ nincs benne ár (a gomb dinamikus) | |
| `mailService` sablonok | ✅ nincs ár a sablonban | az összeg a számlán szerepel |
| `invoiceService` | ✅ `gross` = `order.amount`; ⚠️ a **tételnév** a `PRODUCTS[].invoiceName` statikus szöveg (nem tartalmazza az árat, jó) | |
| Admin ármezők feliratai (`admin.html`) | ⚠️ szövegesen említik a termékkulcsokat (`weekly_summary`, `weekly_package`) | árazási modell-váltáskor átírandó |
| Tesztek (`payment.test.js`, `settings.test.js`, `barion*.test.js`, `frontend.test.js`, `tests/golden/*`) | ❌ 390/890 értékek | az új modellnél frissítendők |

**A SEO/meta szövegekben** a `meta description`/`og:description` **nem** tartalmaz árat (csak a JSON-LD és a látható szöveg).

### 2.3 Fizetésindítás, kupon, számla – a jelenlegi logika

- **Barion** (`barionService.startPayment`): `parsePlan(plan, planMode)` → `product.amountHuf`; részleges kuponnál `computeDiscount(price, percent)` → `Total`/`UnitPrice`; a rendelés `amount`/`listPrice` mentődik; visszahíváskor `Total === order.amount` ellenőrzés.
- **Stripe** (`stripeService.createCheckoutSession`): `unit_amount = amountHuf * 100`.
- **Kupon** (`payment.js applyCoupon`): 100% → `orders.markPaid(amount: 0)`, számla nem készül (`amount > 0` feltétel); 1–99% → a kedvezmény a dokumentum `meta.coupon`-jába kerül, majd `checkoutBarion` a szerveren újra `coupons.lookup`-ol.
- **Számla**: egy tételsor (`invoiceName`), `gross = order.amount`, kuponnál a tételnév „(kupon: -X%)" kiegészítést kap.

### 2.4 Kritikus megállapítás: a csomagkulcs a klienstől jön

`createCheckout`, `applyCoupon` és `checkoutBarion` is `body.plan`-ből számol árat; a `planModeFor` csak a **módot** (standard/academic) olvassa a mentett tervezetből, a **heti/napi/csomag** típust nem. Következmény: a kliens a heti csomag tervezetet `plan: "daily"`-vel is megvásárolhatja (390 Ft). Az új modellben – ahol az ár a `selectedDays`-től is függ – ez még nagyobb rés, ezért az ár **kizárólag a mentett tervezet kérésadataiból** (`planStore.getPlan(generationId).request`) számolandó, a kliens `plan` mezője csak ellenőrzésre szolgáljon.

---

## 3. Új, 3 elemű Admin árazás – hatáselemzés és terv

### 3.1 Célmodell

| Admin mező | Kulcs (javasolt) | Példa | Mikor érvényes |
|------------|------------------|-------|----------------|
| Napi tervezet ára | `daily` | 390 Ft | napi terv |
| Heti összesítő alapára | `weekly_summary` | 590 Ft | `weeklyScope === 'summary'`; **a csomag alapja is** |
| Kidolgozott napi terv felára heti csomagban | `weekly_extra_day` | +100 Ft / nap | `weeklyScope === 'package'` |

Képlet (feltételezés, egyeztetendő): `package = weekly_summary + selectedDays.length × weekly_extra_day`. Példa: 590 + 5×100 = **1090 Ft** (a mostani 890 Ft-tól eltér!). Ha a teljes 5 napos csomag ára 890 maradna, pl. `weekly_summary = 590`, `weekly_extra_day = 60` (590 + 300). Az oktatási célú (academic) árak változatlanok maradnak (4. és 5. mező marad az Adminban).

`selectedDays` normalizálása: üres/érvénytelen → mind az 5 nap (`getSelectedDays`/`daysOf`), tehát a csomag legalább 1, legfeljebb 5 napot jelent; az árazásnak **ugyanezt** a függvényt kell használnia.

### 3.2 Érintett fájlok és függvények

**Backend**

| Fájl | Teendő |
|------|--------|
| `backend/services/settingsService.js` | `PRICE_TIERS` + `DEFAULT_SETTINGS.pricing` bővítése `weekly_summary`, `weekly_extra_day` kulccsal; a `weekly` (fix csomagár) kivezetése vagy legacy-leképezés; `parsePrice` mellé külön szabály az felárra (0 ≤ érték ≤ pl. 10 000; 0 megengedett?); `migrateLegacyPricing` bővítése (régi `weekly` → új kulcsok, hogy a meglévő DB-érték ne vesszen el); `normalizeRows`, `publicConfig`, `pricingTierFor` (`weekly_summary` már ne a `daily`-re mutasson); `validatePatch` relációk (pl. csomag-maximum ≤ `MAX_PRICE_HUF`) |
| `backend/services/pricing.js` | `productFor(plan, planMode, pricing)` → új `priceFor(product, request, pricing)`/`productFor(..., { selectedDays })`; `PRODUCTS.weekly_package` kapjon számított `amountHuf`-ot; a statikus alapértékek (390/590/…) a `DEFAULT_SETTINGS`-ből jöjjenek (egyetlen másolat) |
| `backend/services/stripeService.js` | `parsePlan` / `createCheckoutSession`: a `selectedDays`-t a mentett tervezetből kapja; `toStripeAmount` változatlan |
| `backend/services/barionService.js` | `startPayment`: `parsePlan` hívás új paraméterrel; `Items` – érdemes két sorra bontani (alap + `N × kidolgozott nap`), a `Total` egyezzen; `SKU` |
| `backend/routes/payment.js` | `createCheckout`, `applyCoupon`, `checkoutBarion`: a csomagkulcsot és az árat a mentett tervezetből (`planStore.getPlan(generationId)`: `request.weeklyScope`, `request.selectedDays`, `request.duration`, `planMode`) **származtassa**, a `body.plan` eltérését utasítsa el (400); ez zárja a 2.4 rést |
| `backend/services/planStore.js` | olvasó segéd: a tervezet fizetési besorolása (`planKindOf(stored)`) |
| `backend/services/orderService.js` | `createPending`/`markPaid`: az `amount` mellé érdemes a `selectedDays` számát és az alkalmazott ármodellt a `meta`-ba menteni (reklamáció, utólagos számla) |
| `backend/services/invoiceService.js` | `buildInvoiceXml`: heti csomagnál két tétel (alap + felár × napok) vagy egy összevont tétel a `gross = order.amount`-tal; a tételnév egyezzen a Barion-tétellel; **a számla összege mindig az `order.amount`** |
| `backend/services/coupons.js` | `computeDiscount` változatlan (százalékos) a számított összegre; fix összegű kuponhoz lásd 3.6 |
| `backend/server.js` | `getSelectedDays` / `weeklyScope` közös modulba (pl. `services/weeklyScope.js`), hogy a `pricing.js` körkörös függés nélkül használhassa; `GET /api/config` változatlan (a `publicConfig`-on át megy) |
| `backend/services/weeklySummary.js` | `daysOf` duplikátum megszüntetése |
| `backend/services/adminService.js` | `SETTING_LABELS` – új kulcsok magyar címkéi a Módosítási naplóhoz |
| `supabase/` | Nem szükséges új tábla; ha a `pricing` JSON-t kulcsot cserél, **adatmigráció** (`system_settings` `pricing` sor átalakítása) vagy a kódbeli `migrateLegacyPricing`. A history triggerrel az átállás naplózott. |

**Frontend**

| Fájl | Teendő |
|------|--------|
| `frontend/admin.html` | `Napi tervezet ára`, `Heti összesítő alapára`, `Kidolgozott napi terv felára (Ft / nap)` mezők + élő számolt példa (pl. „5 napos csomag: 1090 Ft"); a régi `setPriceWeekly` felirat átírása |
| `frontend/js/admin.js` ~1072–1075 és ~1152–1156 | betöltés/mentés új kulcsokra; kliens-oldali előellenőrzés (egész szám, ≥ 1) |
| `frontend/js/tervezo-init.js` `applyPublicConfig` (~122) | `PAYWALL_PRICES` helyett ármodell objektum (`daily`, `weekly_summary`, `weekly_extra_day`, academic) |
| `frontend/js/tervezo-paywall.js` | `PAYWALL_PRICES` → `priceFor(result)` függvény (`planKind` + `result.request.selectedDays.length`), minden `PAYWALL_PRICES[kind]` hivatkozás (`:102`, `:126`, `:163`, `:294`, `:356–359`, `:486`) és a `|| 390` tartalékok cseréje; a beégetett tartalék helyett **hangos hiba**, ha a konfig nem töltődött be |
| `frontend/js/tervezo-preview.js:162` | ugyanaz a `priceFor` |
| `frontend/js/tervezo-form.js` | opcionális: az 1. lépésben élő ár-kijelzés a napválasztóhoz („+100 Ft / nap") – a `getSelectedDays()` már megvan |
| `frontend/js/barion-pixel.js:32–34` | statikus lista helyett a fizetéskor kapott tétel és ár (`pixelItem()` már `price` mezőt ad) |
| `frontend/js/site.js` (`LEGAL_TEXTS`, :40–42, :151–153) | az ár kerüljön ki a statikus szövegből vagy kapjon `{{PRICE_*}}` helyőrzőt, amit `openLegalModal` a `/api/config`-ból tölt (a `values` mechanizmus már létezik); a jogi szöveg módosításakor `CONSENT_VERSION` növelése |
| `frontend/index.html` | ártábla (~70) és GYIK (~107): `data-price="…"` hivatkozások, amiket `site.js` tölt a `/api/config`-ból; **JSON-LD** (~26, ~29): a statikus HTML-nek (SEO-bot JS nélkül is lát) a build-ben kell dinamikusan generálódnia |
| `scripts/build-nethely.js` / `scripts/build-pages.js` | a build idején a `/api/config`-ból (vagy `DEFAULT_SETTINGS`-ből) a JSON-LD és a látható ártábla kitöltése, illetve legalább **teszt**, ami a beégetett számokat összeveti az alapértékekkel |

**Tesztek:** `tests/settings.test.js` (négy → három+academic tier), `payment.test.js` (390/890 → új képlet, `plan kinds map…`), `barion*.test.js`, `frontend.test.js`, `tests/golden/*`, `billing.test.js`, `accounts.test.js`; új tesztek: ár `selectedDays` 1/3/5 napra, `body.plan` eltérés → 400, 100% kupon, részleges kupon a számított összegen, Barion `Total` = Σ tételek, számla `gross` = `order.amount`, régi `weekly` DB-érték migrációja.

### 3.3 Hatás a meglévő adatokra és rendelésekre

- A régi rendelések `amount` mezője nem változik; az új rendelés `planKey` értéke (`weekly_package`) maradhat, az összeg viszont napszámtól függ → a `planKey` már nem azonosítja egyértelműen az árat, ezért a `meta`-ba kell a napszám.
- A régi `weekly_detailed`/`weekly` kulcsok a `LEGACY_KEYS`-en át működnek tovább.
- Cache: a mentés a kiszolgáló példány cache-ét azonnal frissíti, más példányon legfeljebb 5 percig a régi ár él; ha az ár a számolásnál és a paywallon eltér, a Barion-összeg a mérvadó (szerver).

### 3.4 Pontosítandó üzleti kérdések

1. A csomag ára tartalmazza-e az alapárat (`590 + N×100`), vagy a csomag = `N × 100` + külön összesítő? (Itt az előbbi van feltételezve.)
2. Mi a minimum napszám (jelenleg 1–5; üres = 5)?
3. Az 5 napos csomag új ára (1090) eltér a mostani 890-től – szándékos?
4. A „Csak heti összesítő" jelenleg a napi árat (390) használja; az új 590 Ft emeli. Szükséges-e átmeneti ármódosítás-jelzés?

### 3.5 Javasolt megvalósítási sorrend

1. **Biztonsági javítás:** az ár a mentett tervezetből, a `body.plan` eltérése → 400 (lásd 2.4). *(kicsi)*
2. Közös `weeklyScope`/`getSelectedDays` modul + `pricing.priceFor`. *(kicsi)*
3. `settingsService` bővítése + adatmigráció + Admin mezők. *(közepes)*
4. Barion/Stripe/számla tételbontás. *(közepes)*
5. Frontend `priceFor` és a beégetett számok kivezetése (paywall, pixel, főoldal, ÁSZF, JSON-LD). *(közepes)*
6. Tesztek frissítése. *(közepes)*

Összes becsült bonyolultság: **közepes–nagy** (főként a jogi/SEO szövegek és a tesztek miatt, a kód maga kicsi–közepes).

### 3.6 Fix összegű kupon (ha szükséges)

Jelenleg csak `discount_percent` (1–100) létezik (`coupons.lookup`, `adminService.parseCouponInput`, `coupons` tábla). Fix összeghez: új oszlop (`discount_type`, `discount_amount_huf`), `lookup`/`computeDiscount` bővítés (`finalPrice = max(0, price − amount)`; 0 Ft esetén a 100%-os ág), az Admin űrlap és az `applyCoupon` ág módosítása, a `coupon_redemptions` oszlopai változatlanok. Becslés: **közepes**, SQL-migrációval.

---

## 4. Egyéb észrevételek

- **`DAILY_GENERATION_CAP` env vs Admin:** az env erősebb; az Admin mező mellé kiírandó, ha az env aktív.
- **Cache-kezelés:** `settingsService` 5 perc TTL, mentéskor a helyi cache frissül; több Render-példánynál a többi példány késik.
- **Karbantartási mód** csak az új generálást állítja le (`/api/generate`), a fizetés és a már generált tervezet kézbesítése él – ez dokumentálandó az Admin súgóban.
- **Hirdetősáv:** csak `index.html`-en jelenik meg; a tervezőben nem. `textContent` → XSS-mentes.
- **Külső linkek:** csak https, de nem hoszt-fehérlistás.
- **E-mail sablonok:** az Admin által szerkesztett HTML a vevői levelekbe kerül; a validáció a kötelező helyőrzőket ellenőrzi, tartalom-szűrés (pl. `<script>`) a levelezőkliensekre van bízva – nem vizsgáltam részletesen.

## 5. Teendők prioritás szerint

1. **Magas:** a csomagtípust a szerver a mentett tervezetből határozza meg (2.4).
2. **Magas:** az árak beégetett másolatainak kivezetése (főoldal, ÁSZF, JSON-LD, pixel, paywall-tartalék).
3. **Közepes:** a skaláris beállítások (`pricing`, `ai_config`, `announcement_bar`, `external_links`, `maintenance_mode`) `↺ Visszaállítás`-a.
4. **Közepes:** a kuponműveletek naplózása.
5. **Közepes:** AI-modell próbahívás/„gyári érték" gomb; gyári prompt visszaállítás.
6. **Alacsony:** ár-relációs ellenőrzés, megerősítő párbeszéd a veszélyes mentéseknél (`billing_profile`, `payment_provider`, `maintenance_mode`, árak).
7. **Alacsony:** `getSelectedDays`/`daysOf` duplikáció megszüntetése.
