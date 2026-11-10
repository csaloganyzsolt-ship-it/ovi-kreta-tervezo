// Mindkét oldal közös része: téma, jogi tájékoztatók (modal) és a lábléc cégadatai.
const LEGAL_TEXTS = {
  terms: ['Általános Szerződési Feltételek (ÁSZF)', `
<h3>1. A Szolgáltató adatai</h3>
<ul>
<li>Szolgáltató neve: CSB-Villamosság Kft.</li>
<li>Székhely: 9153 Öttevény, Arany János utca 10.</li>
<li>Cégjegyzékszám: 08 09 031727 (Győri Törvényszék Cégbírósága)</li>
<li>Adószám: 27891788-2-08</li>
<li>Ügyfélszolgálati e-mail: info@csb-vill.com</li>
<li>Tárhelyszolgáltató: Nethely Kft. (1115 Budapest, Halmi utca 29., e-mail: info@nethely.hu)</li>
</ul>
<h3>2. A szolgáltatás jellege</h3>
<p>Az OviTervező (ovitervezo.hu) webes, mesterséges intelligenciával támogatott digitális pedagógiai tervezőszoftver, amely óvodapedagógusok számára nyújt segítséget napi és heti foglalkozástervezetek, tematikus vázlatok összeállításához. A szoftver által előállított dokumentumok (.docx és .pdf formátumban) pedagógiai segédanyagnak, ötlettárnak, szakmai kiindulópontnak minősülnek, és nem váltják ki a pedagógus szakmai felelősségét. A tartalom helyi sajátosságokhoz, csoportigényekhez és az Óvodai Nevelés Országos Alapprogramjához (ONAP) történő végső igazítása, szakmai felülvizsgálata és a Kréta OVI rendszerbe történő beillesztése kizárólag a Felhasználó (pedagógus) felelőssége.</p>
<p>Az űrlap témamezőibe személyes adat (pl. gyermek neve, sajátos nevelési igényének személyhez köthető részletei) nem adható meg, kizárólag általános pedagógiai célok és témák.</p>
<h3>3. Megrendelés, árak és fizetés</h3>
<ul>
<li>1 db Napi tervezet: 390 Ft (bruttó)</li>
<li>1 db Heti komplex csomag (heti keretterv + 5 napi részletes tervezet): 890 Ft (bruttó)</li>
</ul>
<p>Az árak magyar forintban (HUF) értendők, és tartalmazzák a 27%-os általános forgalmi adót (ÁFA).</p>
<p>A szolgáltatás igénybevétele egyszeri díjas. Nem minősül előfizetésnek, a megadott bankkártyát a Szolgáltató a jövőben semmilyen automatikus vagy ismétlődő díjjal nem terheli meg.</p>
<p>A fizetés a Stripe nemzetközi, biztonságos, PCI-DSS minősítésű felületén történik bankkártyával. A Szolgáltató bankkártyaadatokat nem kezel és nem tárol.</p>
<h3>4. Teljesítés és az elállási jog kizárása</h3>
<p>A teljesítés a sikeres bankkártyás fizetést követően azonnal megtörténik: a rendszer a tervezetet a böngészőben letölthetővé teszi, valamint ezzel párhuzamosan elektronikus levélben elküldi a Felhasználó által megadott e-mail címre.</p>
<p>A fogyasztó és a vállalkozás közötti szerződések részletes szabályairól szóló 45/2014. (II. 26.) Korm. rendelet 29. § (1) bekezdés m) pontja alapján a Felhasználó kifejezetten tudomásul veszi és beleegyezik, hogy nem tárgyi adathordozón nyújtott digitális adattartalom esetén a teljesítés a fizetéssel azonnal megkezdődik, amelynek következtében a Felhasználó a szerződéskötést követően elveszíti a 14 napos indokolás nélküli elállási jogát. A fizetés indításával a Felhasználó ezt a feltételt kifejezetten elfogadja; ezt fizetés előtt külön jelölőnégyzettel is megerősíti.</p>
<h3>5. Szellemi tulajdon és felhasználási jogok</h3>
<p>Az OviTervező weboldal felülete, forráskódja, grafikai elemei és adatbázisai a Szolgáltató kizárólagos szellemi tulajdonát képezik. A megvásárolt tervezetek tekintetében a Szolgáltató nem kizárólagos, határozatlan idejű felhasználási jogot biztosít a vásárlónak saját, illetve intézményi pedagógiai munkájához (szabadon módosítható, kinyomtatható, beilleszthető az óvodai naplóba). A megvásárolt anyagok és a szoftver viszonteladása, nyilvános kereskedelmi terjesztése vagy tömeges továbbértékesítése szigorúan tilos.</p>
<h3>6. Szavatosság és felelősségkorlátozás</h3>
<ul>
<li>A Szolgáltató a szoftver technikai működéséért és a dokumentumok (.docx, .pdf) letölthetőségéért felel. Hibás teljesítés (pl. kézbesítetlen e-mail, sérült fájl) esetén a Felhasználó az info@csb-vill.com címen kérheti az anyag díjmentes újraküldését vagy javítását. A fogyasztót a Polgári Törvénykönyv szerinti kellékszavatossági jogok megilletik: kijavítást vagy kicserélést kérhet, ennek teljesíthetetlensége esetén árleszállítást, illetve a szerződéstől való elállást.</li>
<li>A Szolgáltató nem vállal felelősséget a generált pedagógiai tartalom maradéktalan szakmai tévedésmentességéért, intézményi ellenőrzéseken való megfelelőségéért vagy az internetszolgáltatásból eredő külső kiesésekért. Ez a korlátozás a fogyasztó jogszabályból eredő jogait nem érinti.</li>
</ul>
<h3>7. Panaszkezelés és jogérvényesítés</h3>
<ul>
<li>Panaszaival a Felhasználó az info@csb-vill.com e-mail címen élhet. A Szolgáltató a beérkezett panaszokat 30 napon belül érdemben kivizsgálja és megválaszolja.</li>
<li>Fogyasztói jogvita esetén a Felhasználó jogosult a lakóhelye vagy a Szolgáltató székhelye szerinti Békéltető Testülethez fordulni: Győr-Moson-Sopron Vármegyei Békéltető Testület, 9021 Győr, Szent István út 10/a., e-mail: bekelteto.testulet@gymsmkik.hu</li>
<li>Az Európai Unió online vitarendezési platformja: <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener">ec.europa.eu/consumers/odr</a></li>
</ul>`],
  privacy: ['Adatkezelési Tájékoztató (GDPR)', `
<h3>1. Az Adatkezelő adatai</h3>
<ul>
<li>Adatkezelő: CSB-Villamosság Kft.</li>
<li>Székhely: 9153 Öttevény, Arany János utca 10.</li>
<li>Cégjegyzékszám: 08 09 031727 (Győri Törvényszék Cégbírósága)</li>
<li>Adószám: 27891788-2-08</li>
<li>Kapcsolattartási e-mail: info@csb-vill.com</li>
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
</ul>
<h3>3. Bankkártyás fizetés</h3>
<p>A bankkártyás fizetést a Stripe nemzetközi szolgáltató kezeli. A bankkártya érzékeny adataihoz (kártyaszám, lejárati idő, CVC kód) a CSB-Villamosság Kft. és az OviTervező szerverei semmilyen formában nem férnek hozzá, azokat nem ismerik és nem tárolják.</p>
<h3>4. Címzettek és adatfeldolgozók köre</h3>
<p>Az adatkezelés során az Adatkezelő az alábbi technológiai partnereket veszi igénybe adatfeldolgozóként:</p>
<ol>
<li>Stripe Payments Europe, Ltd. (Írország) – bankkártyás fizetési infrastruktúra.</li>
<li>KBOSS.hu Kft. (Számlázz.hu, Magyarország) – elektronikus számlakiállítás.</li>
<li>Nethely Kft. (Magyarország) – weboldal domain és DNS kiszolgálás, statikus tárhely.</li>
<li>Render Services, Inc. (USA / EU) – backend szerverkörnyezet és API futtatás.</li>
<li>Google Ireland Limited / Google LLC – tervezetszövegek generálása (Gemini API), valamint a vásárlási nyilvántartás és a számlamásolat mentése (Google Táblázatok és Drive).</li>
</ol>
<h3>5. Az érintettek jogai</h3>
<p>Kérheted az Adatkezelőtől a rád vonatkozó személyes adatokhoz való hozzáférést, azok helyesbítését, törlését (kivéve a számviteli törvény által kötelezően előírt 8 éves számlaadatokat), illetve az adatkezelés korlátozását. Kérelmet az info@csb-vill.com címre küldhetsz.</p>
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
<p>A fizetés a Stripe (Stripe Payments Europe Ltd.) titkosított, PCI-DSS Level 1 minősítésű rendszerén keresztül történik.</p>
<ul>
<li>A fizetéshez nincs szükség külön regisztrációra vagy fióknyitásra.</li>
<li>A kártyaadatok (kártyaszám, lejárati dátum, CVC/CVV kód) megadása közvetlenül a Stripe védett szerverein történik.</li>
<li>Az OviTervező weboldal és a CSB-Villamosság Kft. a bankkártyaadatokat nem látja, nem naplózza és nem tárolja.</li>
</ul>
<h3>2. Csomagok és díjszabás</h3>
<ul>
<li>Napi tervezet: 390 Ft (bruttó)</li>
<li>Heti komplex csomag (heti keretterv + 5 napi részletes tervezet): 890 Ft (bruttó)</li>
</ul>
<p>Minden vásárlás egyszeri díjfizetést jelent. Az OviTervezőnél nincs havidíj, nincs előfizetés és nincs automatikus megújuló terhelés. Pontosan és kizárólag azt az összeget vonjuk le, amelyet az adott tervezet kiválasztásakor jóváhagysz.</p>
<h3>3. Számlázás és bizonylatkiállítás</h3>
<ul>
<li>A számlát a CSB-Villamosság Kft. állítja ki a jogszabályoknak megfelelően a Számlázz.hu (KBOSS.hu Kft.) rendszerén keresztül.</li>
<li>A fizetés jóváhagyását követően a rendszer azonnal kiállítja az elektronikus számlát (e-számlát).</li>
<li>Az e-számla PDF formátumban automatikusan megérkezik a vásárláskor megadott e-mail címedre, a megrendelt tervezet Word és PDF fájljaival együtt.</li>
<li>Kérjük, fizetéskor ügyelj a számlázási adatok és az e-mail cím pontos megadására, mert a számla kiállítása teljesen automatizált.</li>
</ul>
<h3>4. Kérdés, számlamódosítás, segítségnyújtás</h3>
<p>Ha a fizetéssel vagy a kiállított számlával kapcsolatban kérdésed van, fordulj az ügyfélszolgálatunkhoz: info@csb-vill.com</p>`]
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

function openLegalModal(key) {
  const [title, items] = LEGAL_TEXTS[key];
  document.getElementById('legalModalTitle').textContent = title;
  const contact = window.APP_CONFIG?.company?.email || 'info@csb-vill.com';
  document.getElementById('legalModalBody').innerHTML = items.split('info@csb-vill.com').join(siteEscapeHtml(contact));
  openModal('legalModal');
}

function initSite() {
  if (window.__oviKretaSiteInitialized) return;
  window.__oviKretaSiteInitialized = true;
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('oviKretaTheme') === 'dark' ? 'dark' : 'light'; } catch (_error) {}
  applyTheme(savedTheme, false);
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  const company = window.APP_CONFIG?.company || {};
  const fill = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  fill('footerCompanyName', company.name || 'CSB-Villamosság Kft.');
  fill('footerTaxId', company.taxId || '27891788-2-08');
  fill('footerRegNo', company.regNo || '08 09 031727');
  fill('footerAddress', company.address || '9153 Öttevény, Arany János utca 10.');
  const email = company.email || 'info@csb-vill.com';
  const mail = document.getElementById('footerEmail');
  if (mail) { mail.textContent = email; mail.href = `mailto:${email}`; }
  document.addEventListener('click', (event) => {
    const legal = event.target.closest('[data-legal]');
    if (legal) { event.preventDefault(); openLegalModal(legal.dataset.legal); return; }
    if (event.target.closest('[data-close-modal]') || event.target.classList.contains('modal-backdrop')) closeModals();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModals(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSite);
else initSite();
