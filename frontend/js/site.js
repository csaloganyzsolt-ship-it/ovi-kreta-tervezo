// Mindkét oldal közös része: téma, jogi tájékoztatók (modal) és a lábléc cégadatai.
// Böngészős tartalék, ha a config.js nem ad e-mailt; a services/siteConstants.js értékével egyeznie kell (teszt védi).
const DEFAULT_SUPPORT_EMAIL = 'info@ovitervezo.hu';
// Böngészős tartalék az egyéni vállalkozói profilra, ha a config.js nem ad cégadatot (a services/siteConstants.js ev profiljával egyeznie kell, teszt védi).
const DEFAULT_COMPANY = {
  name: 'Csalogány Zsolt egyéni vállalkozó',
  taxId: '68274568-1-28',
  regLabel: 'EV nyilvántartási szám',
  regNo: '51507048',
  court: '',
  address: '9153 Öttevény, Kossuth Lajos utca 26.',
  vatNote: 'Alanyi adómentes (AAM) értékesítés, az árak 0 Ft ÁFÁ-t tartalmaznak.'
};
const LEGAL_TEXTS = {
  terms: ['Általános Szerződési Feltételek (ÁSZF)', `
<h3>1. A Szolgáltató adatai</h3>
<ul>
<li>Szolgáltató neve: {{COMPANY_NAME}}</li>
<li>Székhely: {{COMPANY_ADDRESS}}</li>
<li>{{COMPANY_REG}}</li>
<li>Adószám: {{COMPANY_TAX_ID}}</li>
<li>Ügyfélszolgálati e-mail: {{SUPPORT_EMAIL}}</li>
<li>Tárhelyszolgáltató: Nethely Kft. (1115 Budapest, Halmi utca 29., e-mail: info@nethely.hu)</li>
</ul>
<h3>2. A szolgáltatás jellege</h3>
<p>Az OviTervező (ovitervezo.hu) webes, mesterséges intelligenciával támogatott digitális pedagógiai tervezőszoftver, amely óvodapedagógusok számára nyújt segítséget napi és heti foglalkozástervezetek, tematikus vázlatok összeállításához. A szoftver által előállított dokumentumok (.docx és .pdf formátumban) pedagógiai segédanyagnak, ötlettárnak, szakmai kiindulópontnak minősülnek, és nem váltják ki a pedagógus szakmai felelősségét. A tartalom helyi sajátosságokhoz, csoportigényekhez és a hatályos óvodapedagógiai előírásokhoz történő végső igazítása, szakmai felülvizsgálata és az elektronikus naplóba történő beillesztése kizárólag a Felhasználó (pedagógus) felelőssége.</p>
<p>Az űrlap témamezőibe személyes adat (pl. gyermek neve, sajátos nevelési igényének személyhez köthető részletei) nem adható meg, kizárólag általános pedagógiai célok és témák.</p>
<h3>3. Megrendelés, árak és fizetés</h3>
<ul>
<li>1 db Napi tervezet: 390 Ft (bruttó)</li>
<li>1 db Heti komplex csomag (heti keretterv + 5 napi részletes tervezet): 890 Ft (bruttó)</li>
<li>1 db Oktatási célú tervezet (napi foglalkozásterv vagy heti tematikus terv): 690 Ft (bruttó)</li>
</ul>
<p>{{VAT_NOTE}}</p>
<p>A szolgáltatás igénybevétele egyszeri díjas. Nem minősül előfizetésnek, a megadott bankkártyát a Szolgáltató a jövőben semmilyen automatikus vagy ismétlődő díjjal nem terheli meg.</p>
<p>A fizetés a Barion Payment Zrt. biztonságos, PCI-DSS minősítésű felületén történik bankkártyával (vagy Barion-egyenleggel). A Szolgáltató bankkártyaadatokat nem kezel és nem tárol.</p>
<h3>4. Teljesítés és az elállási jog kizárása</h3>
<p>A teljesítés a sikeres bankkártyás fizetést követően azonnal megtörténik: a rendszer a tervezetet a böngészőben letölthetővé teszi, valamint ezzel párhuzamosan elektronikus levélben elküldi a Felhasználó által megadott e-mail címre.</p>
<p>A fogyasztó és a vállalkozás közötti szerződések részletes szabályairól szóló 45/2014. (II. 26.) Korm. rendelet 29. § (1) bekezdés m) pontja alapján a Felhasználó kifejezetten tudomásul veszi és beleegyezik, hogy nem tárgyi adathordozón nyújtott digitális adattartalom esetén a teljesítés a fizetéssel azonnal megkezdődik, amelynek következtében a Felhasználó a szerződéskötést követően elveszíti a 14 napos indokolás nélküli elállási jogát. A fizetés indításával a Felhasználó ezt a feltételt kifejezetten elfogadja; ezt fizetés előtt külön jelölőnégyzettel is megerősíti.</p>
<h3>5. Szellemi tulajdon és felhasználási jogok</h3>
<p>Az OviTervező weboldal felülete, forráskódja, grafikai elemei és adatbázisai a Szolgáltató kizárólagos szellemi tulajdonát képezik. A megvásárolt tervezetek tekintetében a Szolgáltató nem kizárólagos, határozatlan idejű felhasználási jogot biztosít a vásárlónak saját, illetve intézményi pedagógiai munkájához (szabadon módosítható, kinyomtatható, beilleszthető az óvodai naplóba). A megvásárolt anyagok és a szoftver viszonteladása, nyilvános kereskedelmi terjesztése vagy tömeges továbbértékesítése szigorúan tilos.</p>
<h3>6. Szavatosság és felelősségkorlátozás</h3>
<ul>
<li>A Szolgáltató a szoftver technikai működéséért és a dokumentumok (.docx, .pdf) letölthetőségéért felel. Hibás teljesítés (pl. kézbesítetlen e-mail, sérült fájl) esetén a Felhasználó az {{SUPPORT_EMAIL}} címen kérheti az anyag díjmentes újraküldését vagy javítását. A fogyasztót a Polgári Törvénykönyv szerinti kellékszavatossági jogok megilletik: kijavítást vagy kicserélést kérhet, ennek teljesíthetetlensége esetén árleszállítást, illetve a szerződéstől való elállást.</li>
<li>A Szolgáltató nem vállal felelősséget a generált pedagógiai tartalom maradéktalan szakmai tévedésmentességéért, intézményi ellenőrzéseken való megfelelőségéért vagy az internetszolgáltatásból eredő külső kiesésekért. Ez a korlátozás a fogyasztó jogszabályból eredő jogait nem érinti.</li>
</ul>
<h3>7. Panaszkezelés és jogérvényesítés</h3>
<ul>
<li>Panaszaival a Felhasználó az {{SUPPORT_EMAIL}} e-mail címen élhet. A Szolgáltató a beérkezett panaszokat 30 napon belül érdemben kivizsgálja és megválaszolja.</li>
<li>Fogyasztói jogvita esetén a Felhasználó jogosult a lakóhelye vagy a Szolgáltató székhelye szerinti Békéltető Testülethez fordulni: Győr-Moson-Sopron Vármegyei Békéltető Testület, 9021 Győr, Szent István út 10/a., e-mail: bekelteto.testulet@gymsmkik.hu</li>
<li>Az Európai Unió online vitarendezési platformja: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a></li>
</ul>`],
  privacy: ['Adatkezelési Tájékoztató (GDPR)', `
<h3>1. Az Adatkezelő adatai</h3>
<ul>
<li>Adatkezelő: {{COMPANY_NAME}}</li>
<li>Székhely: {{COMPANY_ADDRESS}}</li>
<li>{{COMPANY_REG}}</li>
<li>Adószám: {{COMPANY_TAX_ID}}</li>
<li>Kapcsolattartási e-mail: {{SUPPORT_EMAIL}}</li>
</ul>
<h3>2. A kezelt adatok köre, célja és jogalapja</h3>
<p><strong>a) Számlázási és kapcsolattartási adatok</strong></p>
<ul>
<li>Kezelt adatok: a vevő neve, számlázási címe (irányítószám, város, utca, házszám), e-mail címe, a tranzakció összege és dátuma, valamint a tervezet témájának címe.</li>
<li>Cél: a vásárlási tranzakció lebonyolítása, a megvásárolt anyagok e-mailben történő kézbesítése, jogszabályban előírt elektronikus számla kiállítása.</li>
<li>Jogalap: a szerződés teljesítése (GDPR 6. cikk (1) bek. b) pont), valamint a számvitelről szóló 2000. évi C. törvény 169. § (2) bekezdése szerinti jogi kötelezettség teljesítése (GDPR 6. cikk (1) bek. c) pont).</li>
<li>Megőrzési idő: a számviteli bizonylatokat a törvényi előírásnak megfelelően 8 évig köteles megőrizni az Adatkezelő.</li>
</ul>
<p><strong>b) Tervezési és csoportadatok</strong></p>
<ul>
<li>Kezelt adatok: az űrlapon megadott általános adatok (korcsoport, heti téma, tevékenységi terület, célok).</li>
<li>Kérjük, hogy az űrlap kitöltésekor GYERMEKEK SZEMÉLYES ADATAIT (név, születési idő, sajátos nevelési igény személyhez köthető adatai) SZIGORÚAN NE ADD MEG!</li>
<li>A megadott tervezési paraméterek a dokumentum előállításához a Google Gemini szolgáltatásnak kerülnek továbbításra. Az Adatkezelő ezeket nem rendeli profilba gyermekekhez vagy pedagógusokhoz, és nem archiválja személyazonosításra alkalmas módon; a vásárlás nyilvántartásában csak a tervezet témájának címe szerepel.</li>
</ul>
<p><strong>c) Technikai adatok</strong></p>
<ul>
<li>A helyi beállítások (pl. világos/sötét mód, az űrlap ideiglenes állapota) a böngésző saját helyi tárhelyén (localStorage) tárolódnak, ezekhez az Adatkezelő szervere nem fér hozzá.</li>
<li>Az oldal a Barion Base Pixelt használja csalásmegelőzési (fraud prevention) célból, a Barion Payment Zrt. előírásainak megfelelően. A pixel a böngésző és az eszköz technikai adatait (pl. IP-cím, böngészőazonosító) továbbítja a Barion Payment Zrt.-nek, kizárólag a fizetések biztonságos lebonyolítása és a visszaélések kiszűrése érdekében; marketing célra nem használjuk. Jogalap: jogos érdek (GDPR 6. cikk (1) bek. f) pont), a fizetési csalások megelőzése.</li>
<li>A Teljes (Full) Barion Pixel a fizetési folyamat e-kereskedelmi eseményeit (tervezet megtekintése, csomag kosárba helyezése, fizetés indítása, sikeres vásárlás) küldi a Barion Payment Zrt.-nek a csomag nevével, azonosítójával és árával; a megadott név, e-mail cím és számlázási adat nem kerül továbbításra. Jogalap: jogos érdek (GDPR 6. cikk (1) bek. f) pont), a fizetési szolgáltatás biztonságos és ellenőrizhető nyújtása.</li>
</ul>
<p><strong>d) Opcionális felhasználói fiók</strong></p>
<ul>
<li>A fiók létrehozása nem kötelező, az OviTervező regisztráció nélkül is használható. Belépéskor a megadott e-mail cím a Supabase (Supabase Inc.) hitelesítési szolgáltatásához kerül, ahová jelszó nélküli belépési linket küldünk.</li>
<li>Kezelt adatok: e-mail cím, a fiókhoz kötött tervezetek (az űrlap általános adatai és a generált dokumentum). Cél: a tervezetek felhős mentése és több eszközről való elérése. Jogalap: a Felhasználó hozzájárulása és a szerződés teljesítése (GDPR 6. cikk (1) bek. a) és b) pont).</li>
<li>A fiók és a hozzá kötött tervezetek törlését az {{SUPPORT_EMAIL}} címen kérheted.</li>
</ul>
<h3>3. Bankkártyás fizetés</h3>
<p>A bankkártyás fizetést a Barion Payment Zrt. (Magyarország) fizetési szolgáltató kezeli. A bankkártya érzékeny adataihoz (kártyaszám, lejárati idő, CVC kód) a {{COMPANY_NAME}} és az OviTervező szerverei semmilyen formában nem férnek hozzá, azokat nem ismerik és nem tárolják.</p>
<h3>4. Címzettek és adatfeldolgozók köre</h3>
<p>Az adatkezelés során az Adatkezelő az alábbi technológiai partnereket veszi igénybe adatfeldolgozóként:</p>
<ol>
<li>Barion Payment Zrt. (Magyarország) – bankkártyás fizetési szolgáltatás és csalásmegelőzés (Barion Base Pixel).</li>
<li>KBOSS.hu Kft. (Számlázz.hu, Magyarország) – elektronikus számlakiállítás.</li>
<li>Nethely Kft. (Magyarország) – weboldal domain és DNS kiszolgálás, statikus tárhely.</li>
<li>Render Services, Inc. (USA / EU) – backend szerverkörnyezet és API futtatás.</li>
<li>Google Ireland Limited / Google LLC – tervezetszövegek generálása (Gemini API), valamint a vásárlási nyilvántartás és a számlamásolat mentése (Google Táblázatok és Drive).</li>
<li>Cloudflare, Inc. (USA) – Turnstile robotvédelmi szolgáltatás: az űrlap visszaélés elleni védelme a böngésző és az IP-cím technikai adatainak kiértékelésével.</li>
</ol>
<h3>5. Az érintettek jogai</h3>
<p>Kérheted az Adatkezelőtől a rád vonatkozó személyes adatokhoz való hozzáférést, azok helyesbítését, törlését (kivéve a számviteli törvény által kötelezően előírt 8 éves számlaadatokat), illetve az adatkezelés korlátozását. Kérelmet az {{SUPPORT_EMAIL}} címre küldhetsz.</p>
<h3>6. Jogorvoslati lehetőségek</h3>
<p>Ha megítélésed szerint személyes adataid kezelése sérti a hatályos adatvédelmi jogszabályokat, panasszal fordulhatsz a felügyeleti hatósághoz:</p>
<ul>
<li>Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH)</li>
<li>Székhely: 1055 Budapest, Falk Miksa utca 9-11.</li>
<li>Postacím: 1363 Budapest, Pf. 9.</li>
<li>Telefon: +36 (1) 391-1400</li>
<li>E-mail: ugyfelszolgalat@naih.hu</li>
<li>Weboldal: <a href="https://naih.hu" target="_blank" rel="noopener">naih.hu</a></li>
</ul>
<p>Jogaidat bírósági úton (a lakóhelyed szerinti törvényszék előtt) is érvényesítheted.</p>`],
  billing: ['Fizetési és Számlázási Tájékoztató', `
<h3>1. Fizetési mód: biztonságos bankkártyás fizetés</h3>
<p>A fizetés a Barion Payment Zrt. titkosított, PCI-DSS minősítésű rendszerén keresztül történik.</p>
<ul>
<li>A fizetéshez nincs szükség külön regisztrációra vagy fióknyitásra.</li>
<li>A kártyaadatok (kártyaszám, lejárati dátum, CVC/CVV kód) megadása közvetlenül a Barion védett szerverein történik.</li>
<li>Az OviTervező weboldal és a {{COMPANY_NAME}} a bankkártyaadatokat nem látja, nem naplózza és nem tárolja.</li>
</ul>
<h3>2. Csomagok és díjszabás</h3>
<ul>
<li>Napi tervezet: 390 Ft (bruttó)</li>
<li>Heti komplex csomag (heti keretterv + 5 napi részletes tervezet): 890 Ft (bruttó)</li>
<li>Oktatási célú tervezet (napi foglalkozásterv vagy heti tematikus terv): 690 Ft (bruttó)</li>
</ul>
<p>Minden vásárlás egyszeri díjfizetést jelent. Az OviTervezőnél nincs havidíj, nincs előfizetés és nincs automatikus megújuló terhelés. Pontosan és kizárólag azt az összeget vonjuk le, amelyet az adott tervezet kiválasztásakor jóváhagysz.</p>
<h3>3. Számlázás és bizonylatkiállítás</h3>
<ul>
<li>A számlát a {{COMPANY_NAME}} állítja ki a jogszabályoknak megfelelően a Számlázz.hu (KBOSS.hu Kft.) rendszerén keresztül.</li>
<li>A fizetés jóváhagyását követően a rendszer azonnal kiállítja az elektronikus számlát (e-számlát).</li>
<li>A számla PDF formátumban automatikusan megérkezik a vásárláskor megadott e-mail címedre, a megrendelt tervezet Word és PDF fájljaival együtt.</li>
<li>Kérjük, fizetéskor ügyelj a számlázási adatok és az e-mail cím pontos megadására, mert a számla kiállítása teljesen automatizált.</li>
</ul>
<h3>4. Kérdés, számlamódosítás, segítségnyújtás</h3>
<p>Ha a fizetéssel vagy a kiállított számlával kapcsolatban kérdésed van, fordulj az ügyfélszolgálatunkhoz: {{SUPPORT_EMAIL}}</p>`]
};

function applyTheme(theme, persist = true) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.textContent = isDark ? 'Világos mód' : 'Sötét mód';
    toggle.setAttribute('aria-pressed', String(isDark));
  }
  if (persist) {
    try { localStorage.setItem('oviKretaTheme', isDark ? 'dark' : 'light'); } catch (_error) {}
  }
}

function siteEscapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModals() { document.querySelectorAll('.modal-backdrop.open').forEach((m) => m.classList.remove('open')); }

// A config.js company objektuma a kezdőérték, a /api/config (loadRuntimeConfig) az igazságforrás; hiányzó mezőkre az egyéni vállalkozói tartalék lép.
function getCompany() {
  const configured = window.APP_CONFIG?.company || {};
  const company = { ...DEFAULT_COMPANY, email: DEFAULT_SUPPORT_EMAIL };
  for (const [key, value] of Object.entries(configured)) if (typeof value === 'string') company[key] = value;
  return company;
}

function siteApiBaseUrl() {
  const configured = String(window.APP_CONFIG?.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (configured === 'same-origin') return window.location.origin;
  if (configured) return configured;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || !host ? 'http://localhost:4000' : '';
}

// Az aktív fizetési szolgáltató; amíg a /api/config nem érkezett meg, a Barion az alapértelmezés.
function activePaymentProvider() {
  return window.APP_CONFIG?.paymentProvider === 'stripe' ? 'stripe' : 'barion';
}

// A /api/config egyszer töltődik be oldalanként (az Admin Központban állított cégprofil és fizetési szolgáltató ezen át ér el a böngészőig).
// Hiba esetén a config.js kezdőértékei maradnak, a hiba pedig a konzolban látszik.
function loadRuntimeConfig() {
  if (!window.__runtimeConfigPromise) {
    window.__runtimeConfigPromise = (async () => {
      try {
        const response = await fetch(`${siteApiBaseUrl()}/api/config`, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
        const config = window.APP_CONFIG = window.APP_CONFIG || {};
        if (data.company && typeof data.company === 'object') config.company = { ...(config.company || {}), ...data.company };
        config.paymentProvider = data.paymentProvider === 'stripe' ? 'stripe' : 'barion';
        config.barionPixelId = String(data.barionPixelId || '');
        if (data.announcement_bar && typeof data.announcement_bar === 'object') config.announcementBar = { enabled: data.announcement_bar.enabled === true, text: String(data.announcement_bar.text || '') };
        if (data.stripePublishableKey !== undefined) config.stripePublishableKey = data.stripePublishableKey;
        if (data.stripeTestMode !== undefined && config.company) config.company.stripeTestMode = data.stripeTestMode;
      } catch (error) {
        console.error('A /api/config nem tölthető be, a config.js kezdőértékei maradnak:', error.message);
      }
      return window.APP_CONFIG || {};
    })();
  }
  return window.__runtimeConfigPromise;
}

function renderFooterCompany() {
  const company = getCompany();
  const fill = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  fill('footerCompanyName', company.name);
  fill('footerTaxId', company.taxId);
  fill('footerRegLabel', company.regLabel);
  fill('footerRegNo', company.regNo);
  fill('footerAddress', company.address);
  fill('footerCourt', company.court);
  const courtRow = document.getElementById('footerCourtRow');
  if (courtRow) courtRow.hidden = !company.court;
  const mail = document.getElementById('footerEmail');
  if (mail) { mail.textContent = company.email; mail.href = `mailto:${company.email}`; }
}

// Stripe módban a Barion jelzései (logócsík, trust badge, fizetés gomb) teljesen rejtettek, helyettük a kártyás Stripe-jelvény látszik; Barion módban fordítva.
function applyPaymentProvider() {
  const isBarion = activePaymentProvider() === 'barion';
  document.querySelectorAll('[data-barion-strip], [data-barion-badge], [data-barion-only]').forEach((el) => { el.hidden = !isBarion; });
  document.querySelectorAll('[data-stripe-badge], [data-stripe-only]').forEach((el) => { el.hidden = isBarion; });
  document.dispatchEvent(new CustomEvent('ovi:payment-provider', { detail: { provider: activePaymentProvider() } }));
}

// Főoldali akciós sáv (Admin Központ › Beállítások): csak a <body data-announcement-bar> oldalon, csak bekapcsolva és kitöltött szöveggel; a szöveg textContent-tel kerül ki.
function renderAnnouncementBar() {
  const existing = document.getElementById('announcementBar');
  const bar = window.APP_CONFIG?.announcementBar;
  const text = bar?.enabled === true ? String(bar.text || '').trim() : '';
  if (!document.body.hasAttribute('data-announcement-bar') || !text) {
    existing?.remove();
    return;
  }
  const el = existing || document.createElement('div');
  el.id = 'announcementBar';
  el.className = 'announcement-bar';
  el.setAttribute('role', 'status');
  el.textContent = text;
  if (!existing) document.body.insertBefore(el, document.body.firstChild);
}

function openLegalModal(key) {
  const [title, items] = LEGAL_TEXTS[key];
  document.getElementById('legalModalTitle').textContent = title;
  const company = getCompany();
  const reg = `${company.regLabel}: ${company.regNo}${company.court ? ` (${company.court})` : ''}`;
  const values = {
    SUPPORT_EMAIL: company.email,
    COMPANY_NAME: company.name,
    COMPANY_ADDRESS: company.address,
    COMPANY_TAX_ID: company.taxId,
    COMPANY_REG: reg,
    VAT_NOTE: company.vatNote
  };
  document.getElementById('legalModalBody').innerHTML = items.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => siteEscapeHtml(values[key] ?? ''));
  openModal('legalModal');
}

// ---------- „Pedagógusok mondták rólunk”: az adatbázisból érkező, jóváhagyott vélemények ----------

const REVIEWS_PER_PAGE = 6;
const REVIEW_AVATAR_CLASSES = 6;

// Monogram a névből: az első és az utolsó név kezdőbetűje („Kovácsné T. Judit” → KJ); egyetlen névnél az első két betű.
function reviewMonogram(name) {
  const base = String(name || '').split(/\s+[–-]\s+|,/)[0];
  const words = base.split(/\s+/).map((word) => word.replace(/[^\p{L}]/gu, '')).filter(Boolean);
  if (!words.length) return 'Ó';
  const letters = words.length === 1 ? Array.from(words[0]).slice(0, 2).join('') : `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`;
  return letters.toLocaleUpperCase('hu');
}

// Relatív idő a naptári napok alapján: Ma, Tegnap, X napja, X hete, X hónapja, X éve.
function reviewRelativeTime(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = (value) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.max(0, Math.round((day(now) - day(date)) / 86400000));
  if (days === 0) return 'Ma';
  if (days === 1) return 'Tegnap';
  if (days < 7) return `${days} napja`;
  if (days < 30) return `${Math.floor(days / 7)} hete`;
  if (days < 365) return `${Math.floor(days / 30)} hónapja`;
  return `${Math.floor(days / 365)} éve`;
}

function reviewAvatarClass(name) {
  let hash = 0;
  for (const char of String(name || '')) hash = (hash * 31 + char.codePointAt(0)) % 1000;
  return `avatar-${(hash % REVIEW_AVATAR_CLASSES) + 1}`;
}

function buildReviewCard(review, now) {
  const card = document.createElement('div');
  card.className = 'review-card';
  const header = document.createElement('div');
  header.className = 'review-card-header';
  const avatar = document.createElement('div');
  avatar.className = `review-avatar ${reviewAvatarClass(review.name)}`;
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = reviewMonogram(review.name);
  const meta = document.createElement('div');
  meta.className = 'review-meta';
  const name = document.createElement('strong');
  name.className = 'review-name';
  name.textContent = String(review.name || '').trim() || 'Óvodapedagógus';
  const role = document.createElement('span');
  role.className = 'review-role-date';
  role.textContent = [String(review.role || '').trim() || 'Óvodapedagógus', reviewRelativeTime(review.createdAt, now)].filter(Boolean).join(' • ');
  meta.append(name, role);
  header.append(avatar, meta);
  const rating = Math.max(1, Math.min(5, Number(review.rating) || 5));
  const stars = document.createElement('div');
  stars.className = 'review-stars';
  stars.textContent = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  stars.setAttribute('aria-label', `${rating} csillag az 5-ből`);
  const text = document.createElement('p');
  text.className = 'review-text';
  text.textContent = `„${String(review.comment || '').trim()}”`;
  card.append(header, stars, text);
  return card;
}

// Egyetlen közös rács; a lapozó csak 6-nál több jóváhagyott vélemény esetén látszik, és nincs vélemény → a szekció rejtett.
function renderReviews(data, now = new Date()) {
  const section = document.getElementById('testimonials');
  const grid = document.getElementById('reviewsGrid');
  if (!section || !grid) return;
  const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
  grid.replaceChildren(...reviews.map((review) => buildReviewCard(review, now)));
  section.hidden = reviews.length === 0;
  const totalPages = Math.max(1, Number(data?.totalPages) || 1);
  const page = Math.min(totalPages, Math.max(1, Number(data?.page) || 1));
  const pager = document.getElementById('reviewsPager');
  pager.hidden = !(Number(data?.total) > REVIEWS_PER_PAGE && totalPages > 1);
  document.getElementById('reviewsPageInfo').textContent = `${page} / ${totalPages}`;
  document.getElementById('reviewsPrev').disabled = page <= 1;
  document.getElementById('reviewsNext').disabled = page >= totalPages;
  section.dataset.page = String(page);
}

function loadReviews(page = 1) {
  if (!document.getElementById('testimonials') || typeof fetch !== 'function') return Promise.resolve();
  return fetch(`${siteApiBaseUrl()}/api/reviews/public?page=${page}&pageSize=${REVIEWS_PER_PAGE}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => { if (data && data.success) renderReviews(data); })
    .catch(() => {});
}

function initReviews() {
  const section = document.getElementById('testimonials');
  if (!section) return;
  const go = (delta) => () => {
    const target = Math.max(1, Number(section.dataset.page || 1) + delta);
    loadReviews(target).then(() => section.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };
  document.getElementById('reviewsPrev').addEventListener('click', go(-1));
  document.getElementById('reviewsNext').addEventListener('click', go(1));
  loadReviews(1);
}

function initSite() {
  if (window.__oviKretaSiteInitialized) return;
  window.__oviKretaSiteInitialized = true;
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('oviKretaTheme') === 'dark' ? 'dark' : 'light'; } catch (_error) {}
  applyTheme(savedTheme, false);
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  renderFooterCompany();
  applyPaymentProvider();
  loadRuntimeConfig().then(() => { renderFooterCompany(); applyPaymentProvider(); renderAnnouncementBar(); });
  initReviews();
  document.addEventListener('click', (event) => {
    const sample = event.target.closest('[data-sample-modal]');
    if (sample) { event.preventDefault(); openModal('sampleModal'); return; }
    const legal = event.target.closest('[data-legal]');
    if (legal) { event.preventDefault(); openLegalModal(legal.dataset.legal); return; }
    if (event.target.closest('[data-close-modal]') || event.target.classList.contains('modal-backdrop')) closeModals();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModals(); });
}

function formatExtentSummary(tableCount, activityCount) {
  return `A teljes dokumentum elkészült: ${tableCount} részletes táblázat és ${activityCount} kidolgozott tevékenységi egység vár feloldásra.`;
}

function getLockedMeta(result) {
  if (!result || typeof result !== 'object') {
    return { table_count: 0, activity_count: 0, summary_text: formatExtentSummary(0, 0) };
  }
  if (result.locked_meta) {
    const table_count = Number(result.locked_meta.table_count) || 0;
    const activity_count = Number(result.locked_meta.activity_count) || 0;
    return {
      table_count,
      activity_count,
      summary_text: formatExtentSummary(table_count, activity_count)
    };
  }
  if (result.is_weekly === true && Array.isArray(result.napok)) {
    let table_count = 0;
    let activity_count = 0;
    for (const day of result.napok) {
      if (Array.isArray(day?.kidolgozas_tablazat) && day.kidolgozas_tablazat.length) {
        table_count += 1;
        activity_count += day.kidolgozas_tablazat.length;
      }
    }
    return { table_count, activity_count, summary_text: formatExtentSummary(table_count, activity_count) };
  }
  const rows = Array.isArray(result.kidolgozas_tablazat) ? result.kidolgozas_tablazat.length : 0;
  return {
    table_count: rows > 0 ? 1 : 0,
    activity_count: rows,
    summary_text: formatExtentSummary(rows > 0 ? 1 : 0, rows)
  };
}

if (typeof window !== 'undefined') {
  window.formatExtentSummary = formatExtentSummary;
  window.getLockedMeta = getLockedMeta;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatExtentSummary, getLockedMeta, LEGAL_TEXTS, reviewMonogram, reviewRelativeTime, renderReviews };
}

function initPage() {
  initSite();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage);
else initPage();
