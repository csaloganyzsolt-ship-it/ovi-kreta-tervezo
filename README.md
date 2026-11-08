# OviTervező (ovitervezo.hu)

Ez a projekt egy egyszerű, GitHub Pages-en futtatható statikus weboldal, amely az óvodai tervkészítő felületet mutatja be.

## Jellemzők
- 4 lépéses varázsló flow
- egyszerű, pedagógusbarát dizájn
- előnézet csak a végső generálás után
- backend híd a Gemini API-hoz
- GitHub Actions alapú automatizált ellenőrzés és deployment

## Lokális futtatás

1. Hozz létre egy helyi `.env` fájlt, és add meg a valódi API kulcsot az alábbi konfiguráció szerint.
2. Futtasd a backendet:

```bash
npm install
npm start
```

3. Futtasd a frontend statikus kiszolgálását:

```bash
npm run serve
```

A böngészőben ezt nyisd meg:

```text
http://localhost:8000
```

A backend API itt érhető el:

```text
http://localhost:4000/health
```

## Gemini konfiguráció

A `.env` fájlban legyen ez:

```env
PORT=4000
GEMINI_API_KEY=your_api_key_here
```

A backend két modell közül választ a kérés `requestedModel` mezője alapján (alapértelmezett: `gemini-3.1-pro-preview`, prémium: `gemini-4-argon`); a `GEMINI_MODEL` környezeti változó nem írja felül, és nincs automatikus modellváltás. A modell tényleges API-elérhetősége az adott hozzáféréstől függ. A szerver az API-, JSON- és tokenkeret-hibákat továbbítja a felületnek, nem helyettesíti a választ mintadokumentummal.

## Ellenőrzések és generálási napló

Az `npm test` a statikus oldal ellenőrzése mellett futtatja a szerver normalizálását, a valódi helyi HTTP-végpontot és a kliens DOM-megjelenítését vizsgáló regressziós teszteket is. A külső Gemini-választ a tesztek a hálózati határon helyettesítik, így nem használnak API-kulcsot és nem fogyasztanak kvótát. Éles generálási minőséget ezek a tesztek nem igazolnak.

A generálási napló tartalmazza a modell nevét, a `finishReason` értékét, a bemeneti, kimeneti és gondolkodási tokenszámokat, valamint a visszakapott szöveg és a táblázat hosszát. A `MAX_TOKENS` eredmény hibát okoz, nem csonka előnézetet. A napló nem írja ki az API-kulcsot vagy a teljes, személyes adatokat tartalmazó promptot.

## GitHub repo létrehozása

1. Nyiss meg egy új üres GitHub repository-t.
2. Készítsd el a repo-t nyilvános vagy privát módon.
3. A repository Settings > Pages menüpontban engedélyezd a GitHub Pages-t.
4. Válaszd a Source-t: GitHub Actions.
5. Push-old az itt található fájlokat a main branchre.

## GitHub Actions

A projektben 2 workflow van:
- `test.yml`: ellenőrzi a statikus oldal meglétét és az alapvető tartalmi elemeket
- `deploy.yml`: GitHub Pages-re deployeli a weboldalt

## API biztonság

A Gemini API kulcs soha ne kerüljön a frontendbe vagy a repo-ba nyílt szövegként.
A jövőbeni backend integrációhoz a kulcs legyen repository secret vagy hosting platform secret.

## Fontos megjegyzés

A GitHub Pages csak statikus frontendet tud kiszolgálni. Ha később valódi Gemini API hívásra van szükség, akkor ehhez egy backend szükséges, például:
- Render
- Railway
- Fly.io
- Google Cloud Run
- Azure Functions

A frontend pusztán a felhasználói adatokat küldi el a backendnek, a backend pedig a Gemini API-hoz fordul.

## Üzemeltetés (Nethely)
Indítófájl: `app.js` (a port a `PORT` környezeti változóból jön). Környezeti változók: `.env.example`. Stripe webhook: `BASE_URL/api/webhook/stripe` (esemény: `checkout.session.completed`).

## Hibrid üzem: frontend a Nethelyen, backend a Renderen

1. `node scripts/build-nethely.js` (teszt Stripe-hoz: `--test`; más backendhez: `API_BASE_URL=https://... node scripts/build-nethely.js`).
2. A `dist-nethely/` mappa tartalmát (rejtett `.htaccess` is) FTP-vel töltsd a Nethely `/OviTervezo/` könyvtárba, változtatás nélkül.
3. A Render környezeti változóit lásd a `.env.example` és a `render.yaml` fájlban. A Stripe webhook: `https://<app-név>.onrender.com/api/webhook/stripe`, esemény: `checkout.session.completed`.

### Automatikus Nethely feltöltés (GitHub Actions)
A `.github/workflows/deploy-nethely.yml` minden `main` push után (és kézzel az Actions fülön) lefuttatja a teszteket, a `node scripts/build-nethely.js` buildet, majd FTP-vel szinkronizálja a `dist-nethely/` tartalmát. Szükséges Repository Secret-ek: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`; opcionális: `FTP_PORT` (21), `FTP_SERVER_DIR` (`./`). A kapcsolat FTPS (passzív mód, `security: loose`, 60 s időkorlát).
