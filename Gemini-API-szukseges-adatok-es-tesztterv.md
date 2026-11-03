# Gemini API és teljes tesztelési terv az Ovi-Kréta Tervező Asszisztenshez

## 1. Milyen adatokra van szükség?

### 1.1. API hozzáférés
- Gemini API kulcs (Google AI Studio / API key)
- Modell neve, például: `gemini-2.0-flash` vagy újabb stabil modell
- API végpont és region, ha Vertex AI használatával dolgozunk
- Backend környezeti változók:
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL`
  - `GEMINI_API_BASE_URL`
  - `APP_ENV` (development / staging / production)

### 1.2. Felhasználói adatok a terv létrehozásához
A weboldalból be kell gyűjteni ezeket az információkat:
- időtartam: napi / heti
- korcsoport: kiscsoport / középső / nagycsoport / vegyes csoport
- téma / projekt címe
- nevelési területek: pl. nyelv, mozgás, rajzolás, zene, környezetismeret
- csoportlétszám
- csoport hangulata / energiaszint
- iskola-előkészítő gyermekek jelenléte
- speciális nevelési igények (SNI / BTMN), ha vannak
- kötelező mese / vers / dal / konkrét készségek
- saját ötletek, eszközök, anyagok
- saját egyéni kívánságok vagy megjegyzések
- opcionális: korábbi tervekből visszahívható sablonok

### 1.3. Kimenet specifikációja
A Gemini API-nak tudatni kell, hogy mit várunk vissza:
- Kréta-rubrikák szerinti szövegformátum
- rövid, jól tagolt bekezdések
- szakmai, óvodapedagógiai nyelvezet
- OH-kompatibilis célkifejezések
- szülői tájékoztató külön verzió
- PDF és DOCX export formátumokhoz külön tartalmi szerkezet

### 1.4. Adatvédelmi és biztonsági szempontok
- Ne küldjünk személyes adatokat a Gemini API-nak, ha nem szükséges
- Kisebb, anonimizált promptok előnyösebbek
- Minden API hívásnál logolni kell a promptet és a választet, de biztonságosan
- A felhasználói adatok kezelése legyen GDPR-kompatibilis
- Ha a rendszerben dokumentumok kerülnek feltöltésre, ellenőrizni kell a fájlméretet és típusát

---

## 2. Mit kell elküldeni a Gemini API-nak?

### 2.1. Prompt struktúra
Javasolt rendszer-prompt:

"Te egy szakértő magyar óvodapedagógus vagy. Készíts egy {időtartam} tervezetet a {korcsoport} számára {téma} témában. A csoport hangulata {energiaszint}, a csoportban {gyerekek_szama} gyermek van. Figyelembe vett speciális igények: {sni_igények}. Az óvodai nevelés célja a következő területek fejlesztése: {nevelési_területek}. Kérjük, hogy a terv tartalmazza a cél- és feladatrendszert, a tevékenységeket, a differenciálást, az eszközszükségletet, valamint a szülői tájékoztatót. A kimenet szerkezete legyen Kréta-kompatibilis, jól olvasható, rövid bekezdésekkel, szakmai nyelvvel."

### 2.2. Kimenet formátuma
A model válaszában a következőt érdemes elvárni:
- `title`
- `duration`
- `ageGroup`
- `theme`
- `goals`
- `activities`
- `differentiation`
- `materials`
- `parentInfo`
- `outputFormat`: `kreta` vagy `parent`

### 2.3. Validáció
A backendnek ellenőriznie kell, hogy:
- a response nem üres
- a JSON valid
- a kötelező mezők megvannak
- a szöveg nem túl hosszú
- a tartalom nem tartalmaz furcsa, idegen nyelvű vagy irreleváns részeket

---

## 3. Teljes tesztelés a generáláshoz

### 3.1. Unit tesztek
- formadatok validálása
- prompt összeállítás ellenőrzése
- alapértelmezett értékek ellenőrzése
- SNI / BTMN logika működése
- korábbi terv behívása funkció
- file export hívások helyessége

### 3.2. Integrációs tesztek
- egész API hívás a Gemini-hez
- válasz JSON feldolgozása
- fallback, ha a Gemini hibaüzenetet ad vissza
- timeout kezelés
- korlátozott prompt hossz kezelése
- növekvő túlterhelés / rate limit kezelése

### 3.3. E2E tesztelés
A teljes felhasználói flowet le kell tesztelni:
1. kitöltés a 1. lépésben
2. 2. lépésben csoportadatok
3. 3. lépésben extra készségek és ötletek
4. 4. lépésben generálás
5. eredmény megjelenése
6. másolás
7. PDF export
8. DOCX export

### 3.4. PDF export teszt
A PDF létrehozásához szükséges:
- a kész terv HTML vagy markdown fájlként összerakása
- PDF generátor, például:
  - Node.js: `pdf-lib`, `html-pdf`, `playwright` print-to-pdf
  - Python: `reportlab`, `weasyprint`
- ellenőrizni kell:
  - magyar karakterek megjelennek
  - fejléc / cím / szakaszok helyesek
  - nincsenek törött sorok
  - nyomtatási méretezés jó

### 3.5. DOCX export teszt
A DOCX készítéséhez szükséges:
- `docx` JavaScript könyvtár, vagy
- Python `python-docx` könyvtár
- a tervben a megfelelő fejlécek és szakaszok betöltése
- ellenőrizni kell:
  - címek helyes formátuma
  - listák és bekezdések rendben vannak
  - magyar ékezetek megjelennek
  - fájl megnyitható a Wordben

---

## 4. Javasolt teszt adatok
A teszteléshez hasznos néhány példa:
- tema: `Őszi falevelek`
- korcsoport: `Nagycsoport`
- időtartam: `Napi`
- csoportlétszám: `20`
- célterület: `rajzolás`, `mesélés`, `környezetismeret`, `mozgás`
- kötelező dal: `Süni, süni, sünikém`
- speciális igény: `figyelemzavar / hiperaktivitás`
- igazolt diák: `iskola-előkészítő`

---

## 5. Példa API hívás

### JavaScript például
```js
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `Készíts óvodai tervet...`
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2000
      }
    })
  }
);
```

### Várt válaszkezelés
- ellenőrizni kell a `candidates` mezőt
- a `text` érték kibontása
- JSON parse, ha a model strukturált adatokat kér
- hibás vagy üres válasz esetén fallback

---

## 6. Ajánlott fejlesztési lépcső
1. HTML/JS frontend elkészítése
2. formadatok validálása a kliens oldalon
3. backend API végpont létrehozása
4. Gemini hívás implementálása
5. prompt + output schema stabilizálása
6. PDF export implementálása
7. DOCX export implementálása
8. Playwright E2E tesztek
9. staging környezetben való tesztelés
10. production deploy és monitoring

---

## 7. Összegzés
A rendszerhez szükséges a következő fő elemek:
- Gemini API kulcs és modell
- felhasználói űrlap adatok
- strukturált prompt- és output-séma
- validáció és hibakezelés
- PDF/DOCX export motorok
- end-to-end tesztelés a teljes generálási flowhoz

Ha szeretnéd, a következő lépésben tudok készíteni a projektnek egy konkrét backend tervet is, például Node.js + Express + Gemini API + PDF/DOCX export implementációval.
