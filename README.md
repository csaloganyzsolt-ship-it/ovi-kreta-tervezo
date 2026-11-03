# Ovi-Kréta Tervező Asszisztens

Ez a projekt egy egyszerű, GitHub Pages-en futtatható statikus weboldal, amely az óvodai tervkészítő felületet mutatja be.

## Jellemzők
- 4 lépéses varázsló flow
- egyszerű, pedagógusbarát dizájn
- előnézet csak a végső generálás után
- GitHub Actions alapú automatizált ellenőrzés és deployment

## Lokális futtatás

```bash
python3 -m http.server 8000
```

A böngészőben ezt nyisd meg:

```text
http://localhost:8000
```

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
