// Mindkét oldal közös része: téma, jogi tájékoztatók (modal) és a lábléc cégadatai.
const LEGAL_TEXTS = {
  terms: ['Általános Szerződési Feltételek (ÁSZF)', `
<h3>1. Szolgáltató</h3>
<p>CSB-Villamosság Kft. · Székhely: 9153 Öttevény, Arany János utca 10. · Adószám: 27891788-2-08 · Cégjegyzékszám: 08 09 031727 · E-mail: info@csb-vill.com</p>
<h3>2. A szolgáltatás</h3>
<p>Az OviTervező (ovitervezo.hu) digitális pedagógiai segédlet: óvodai napi és heti tervezetek összeállítására szolgáló tervezőszoftver. A generált tervezet segédanyag; a tartalom végleges ellenőrzése és felhasználása a pedagógus felelőssége.</p>
<h3>3. Árak és fizetés</h3>
<p>1 db napi tervezet: 390 Ft, 1 db heti csomag (keretterv + 5 napi tervezet): 890 Ft. Az árak forintban, az ÁFA-t tartalmazva értendők. A fizetés bankkártyával, a Stripe biztonságos felületén történik regisztráció nélkül.</p>
<h3>4. Teljesítés, elállási jog</h3>
<p>A megvásárolt tervezet azonnal, elektronikusan letölthetővé válik. Nem fizikai adathordozón nyújtott digitális adattartalom esetén a fogyasztó a teljesítés megkezdésével, kifejezett előzetes hozzájárulása és tudomásulvétele alapján elveszíti elállási jogát (45/2014. (II. 26.) Korm. rendelet 29. § (1) m) pont). A fizetés előtt ezt külön jelölőnégyzettel kell elfogadni.</p>
<h3>5. Szellemi tulajdon</h3>
<p>A szoftver és annak felülete a Szolgáltató szellemi tulajdona. A megvásárolt tervezetet a vásárló saját pedagógiai munkájához szabadon felhasználhatja, de a szoftvert nem másolhatja és nem értékesítheti tovább.</p>
<h3>6. Szavatosság, panaszkezelés</h3>
<p>Hibás teljesítés (pl. sikertelen letöltés) esetén írj az info@csb-vill.com címre; a panaszt legfeljebb 30 napon belül kivizsgáljuk. A Szolgáltató a generált tartalom pedagógiai pontosságáért nem vállal felelősséget.</p>`],
  privacy: ['Adatkezelési Tájékoztató (GDPR)', `
<h3>1. Adatkezelő</h3>
<p>CSB-Villamosság Kft., 9153 Öttevény, Arany János utca 10., adószám: 27891788-2-08, cégjegyzékszám: 08 09 031727, e-mail: info@csb-vill.com.</p>
<h3>2. Kezelt adatok és cél</h3>
<p>Fizetéskor a számlázási név, a számlázási cím és az e-mail cím. Cél: a vásárlás teljesítése és a számla kiállítása. Jogalap: szerződés teljesítése (GDPR 6. cikk (1) b) pont) és jogi kötelezettség (számviteli törvény, 6. cikk (1) c) pont). Az adatokat a számviteli előírások szerint 8 évig őrizzük.</p>
<h3>3. Bankkártyaadatok</h3>
<p>A fizetési adatokat kizárólag a Stripe kezeli. A bankkártyaszámok nem futnak át az OviTervező szerverén, és nem tároljuk őket.</p>
<h3>4. Adatfeldolgozók</h3>
<p>Stripe (fizetés), Számlázz.hu – KBOSS.hu Kft. (e-számlázás), tárhelyszolgáltató (Nethely). A kitöltött tervezési adatok a generáláshoz a Google Gemini szolgáltatásnak kerülnek továbbításra; ezek a böngésződben is mentődnek (localStorage), nálunk nem kerülnek profilba.</p>
<h3>5. Jogaid</h3>
<p>Kérhetsz hozzáférést, helyesbítést, törlést (a jogszabályi megőrzési kötelezettség kivételével), korlátozást, tiltakozhatsz, és panasszal fordulhatsz a NAIH-hoz (naih.hu). Kapcsolat: info@csb-vill.com.</p>`],
  billing: ['Fizetési és Számlázási Tájékoztató', `
<h3>Bankkártyás fizetés</h3>
<p>A fizetés a Stripe biztonságos, titkosított felületén történik. A kártyaadataidat az OviTervező nem látja és nem tárolja.</p>
<h3>Árak</h3>
<p>Napi tervezet: 390 Ft · Heti csomag (keretterv + 5 napi tervezet): 890 Ft. Az ár tartalmazza az ÁFA-t, további díj nincs.</p>
<h3>Számlázás</h3>
<p>Sikeres fizetés után a CSB-Villamosság Kft. a Számlázz.hu rendszeren keresztül automatikusan e-számlát állít ki, és elküldi a megadott e-mail címre. Kérjük, helyes e-mail címet adj meg.</p>
<h3>Kapcsolat</h3>
<p>Fizetéssel vagy számlával kapcsolatos kérdés esetén: info@csb-vill.com.</p>`]
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
