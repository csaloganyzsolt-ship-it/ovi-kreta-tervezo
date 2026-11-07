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
