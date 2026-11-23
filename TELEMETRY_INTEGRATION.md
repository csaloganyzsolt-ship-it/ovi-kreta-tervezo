# Telemetria Integráció Útmutató

## Áttekintés

Az OviTervező már rendelkezik egy teljes GDPR-kompatibilis telemetria rendszerrel. Ez az útmutató bemutatja, hogyan kell az eseményeket naplózni az alkalmazásban.

## Frontend Integráció

### 1. Alapvető eseménynaplózás

A `telemetry.js` globális `window.telemetry` objektumot biztosít az eventos:

```javascript
// Egyszerű esemény naplózása
window.telemetry.logEvent('page_view');

// Metaadatokkal
window.telemetry.logEvent('generator_started', {
  plan_mode: 'daily',
  age_group: '3-4 years'
});
```

### 2. Globális metaadatok beállítása

Az alkalmazás indulásakor vagy amikor az adatok megváltoznak, állítsd be a globális metaadatokat:

```javascript
// Az 1. lépésben, amikor a felhasználó kiválasztja az adatokat
window.telemetry.setMetadata({
  plan_mode: formData.planKind,         // 'daily' vagy 'weekly'
  age_group: formData.ageGroup,         // pl. '3-4 years'
  theme_category: formData.themeTitle,  // pl. 'Animals'
  utm_source: new URLSearchParams(location.search).get('utm_source') // marketing tracking
});
```

### 3. Engedélyezett eseménynév

**Whitelist-ellenőrzött események:**
- `page_view` - Oldal betöltéskor (automatikus)
- `generator_started` - Generálás gomb megnyomásakor
- `document_generated` - Sikeres generálás után
- `paywall_opened` - Fizetési ablak megnyitása
- `coupon_box_opened` - Kupon beviteli mező megnyitása
- `download_docx` - Word (.docx) letöltés gomb
- `download_pdf` - PDF letöltés gomb
- `auth_modal_opened` - Login/regisztráció modal megnyitása

### 4. Integráció az alkalmazásban

#### 1. lépés: Téma és időkeret
```javascript
// tervezo-form.js / tervezo-init.js
window.telemetry.setMetadata({
  plan_mode: formState.planKind,
  age_group: formState.ageGroup,
  theme_category: formState.themeTitle
});
```

#### 2. lépés: Csoport profilja
```javascript
// Metaadatok frissítése
window.telemetry.setMetadata({
  kindergarten_name: formState.kindergartenName,
  group_name: formState.groupName
});
```

#### 4. lépés: Generálás
```javascript
// tervezo-generate.js - generálás gomb előtt
window.telemetry.logEvent('generator_started');

// tervezo-generate.js - sikeres generálás után
if (response.success) {
  window.telemetry.logEvent('document_generated', {
    plan_mode: formState.planKind,
    age_group: formState.ageGroup,
    theme_category: formState.themeTitle
  });
}
```

#### Fizetési ablak
```javascript
// tervezo-paywall.js
function openPaywall() {
  window.telemetry.logEvent('paywall_opened', {
    plan_mode: formState.planKind
  });
  // ... paywall logika
}
```

#### Letöltések
```javascript
// tervezo-export.js
async function downloadDocx() {
  window.telemetry.logEvent('download_docx');
  // ... download logika
}

async function downloadPdf() {
  window.telemetry.logEvent('download_pdf');
  // ... download logika
}
```

#### Belépés/Regisztráció
```javascript
// auth.js
function openAuthModal() {
  window.telemetry.logEvent('auth_modal_opened');
  // ... auth modal logika
}
```

## Backend Integráció

### `/api/telemetry` Végpont

Az alkalmazás automatikusan küldi az eseményeket a `POST /api/telemetry` végponton keresztül.

**Paraméterek:**
```json
{
  "eventName": "page_view",
  "deviceType": "mobile",          // automatikusan detektálva
  "referrerDomain": "google.com",  // automatikusan kinyerve
  "metadata": {
    "plan_mode": "daily",
    "age_group": "3-4 years",
    "theme_category": "Animals"
  }
}
```

### Szerveroldali generálás naplózása

A backend a sikeres generálás után automatikusan naplózza az eseményt:

```javascript
// server.js /api/generate végpont
await telemetryService.logEvent('document_generated', {
  deviceType: null,
  referrerDomain: null,
  metadata: {
    plan_mode: request.planKind,
    age_group: request.ageGroup,
    theme_category: request.themeTitle
  }
});
```

## Admin Dashboard

Az Admin Központban (`admin.html`) megtekinthető:

1. **Konverziós tölcsér (Funnel):**
   - Oldalmegjelenítés → Generálás indítva → Tervezet kész → Fizetési ablak → Vásárlás

2. **Eszközmegoszlás:**
   - Mobil/Tablet/Asztali gép percentase

3. **Top témakörök és korcsoportok:**
   - Legtöbbször kiválasztott témák és korcsoportok

4. **Forgalmi források:**
   - Referrer domainek és kattintások száma

5. **Letöltések:**
   - Word (.docx) vs. PDF letöltések

## GDPR Megfelelőség

### Mit logolunk (MEGENGEDETT):
- ✅ Eseménynév (page_view, generator_started, stb.)
- ✅ Eszköztípus (mobile, tablet, desktop)
- ✅ Referrer domain (pl. google.com)
- ✅ Névtelen metaadatok (plan_mode, age_group, theme_category)
- ✅ Közvetett marketing paraméterek (utm_source)

### Mit NEM logolunk (TILOS):
- ❌ IP-cím
- ❌ User ID vagy e-mail
- ❌ Böngésző cookie/sütik
- ❌ Teljes referrer URL (csak domain)
- ❌ Személyes azonosítók (név, cím, stb.)
- ❌ Gyermekek személyes adatai

## Tesztelés

### Frontend

```javascript
// Konzolban tesztelés
window.telemetry.logEvent('page_view');
window.telemetry.logEvent('generator_started', { plan_mode: 'daily' });
window.telemetry.flush(); // Buffer kiürítése azonnal
```

### Backend

```bash
# Telemetria végpont tesztese
curl -X POST http://localhost:4000/api/telemetry \
  -H 'Content-Type: application/json' \
  -d '{
    "eventName": "page_view",
    "deviceType": "desktop",
    "referrerDomain": "example.com",
    "metadata": {"theme_category": "Animals"}
  }'
```

## Teljesítmény

- **Buffer méret:** 10 esemény
- **Buffer kiürítési időkorlát:** 30 másodperc
- **Rate limit:** 100 kérés/perc
- **Küldési módszer:** `navigator.sendBeacon` → `fetch` fallback

## Hibaelhárítás

### Az események nem jelennek meg az admin panelen
1. Ellenőrizd, hogy a Supabase kapcsolat aktív (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`)
2. Nézd meg a szerver logokat a telemetry végponton
3. Ellenőrizd a böngésző konzolt az `[telemetry]` üzenetekért

### PII detektálása
Ha az alkalmazás PII-t észlel a metaadatokban, az esemény nem kerül naplózásra.
- Email címek (@)
- IP-címek (XXX.XXX.XXX.XXX)
- Tokenek és UUID-k

## Referenciák

- [Telemetria Service: `services/telemetryService.js`](../services/telemetryService.js)
- [Frontend Telemetria: `telemetry.js`](../telemetry.js)
- [Analytics Service: `services/analyticsService.js`](../services/analyticsService.js)
- [Admin Route: `routes/admin.js`](../routes/admin.js)
- [Supabase Migration: `supabase/migrations/20261124110000_analytics_events.sql`](../supabase/migrations/20261124110000_analytics_events.sql)
