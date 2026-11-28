// GDPR süti-hozzájárulás (OviConsent): minden nyilvános oldalon fut, a döntésig (vagy verzióváltásig) megjelenik.
// Nincs sötét minta: a három gomb azonos stílusú és méretű; a hozzájárulás a lábléc „Süti beállítások” gombjával bármikor visszavonható.
// A döntés a localStorage-ban (ovi_cookie_consent) él; az elengedhetetlen kategória mindig aktív. Minden szöveg textContent-tel kerül a DOM-ba.
(function (root) {
  'use strict';

  const STORAGE_KEY = 'ovi_cookie_consent';
  const CONSENT_VERSION = '2026-11-29';
  const ANALYTICS_SESSION_KEY = 'ovi_analytics_sid';
  const EVENT_NAME = 'ovi:consent-changed';
  const CATEGORIES = ['necessary', 'analytics', 'marketing'];

  const listeners = [];
  let memoryConsent = null;
  let banner = null;
  let lastFocus = null;

  // Tárolás nélkül (pl. tiltott localStorage) a döntés csak az oldal élettartamára érvényes; ilyenkor a banner a következő oldalon újra megjelenik.
  function readStored() {
    let raw = null;
    try { raw = root.localStorage.getItem(STORAGE_KEY); } catch (_error) { return memoryConsent; }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CONSENT_VERSION || typeof parsed.analytics !== 'boolean' || typeof parsed.marketing !== 'boolean') return null;
      return { version: parsed.version, necessary: true, analytics: parsed.analytics, marketing: parsed.marketing, ts: String(parsed.ts || '') };
    } catch (_error) {
      return null;
    }
  }

  function get() {
    const stored = readStored();
    return stored ? { ...stored } : null;
  }

  function has(category) {
    if (category === 'necessary') return true;
    if (category !== 'analytics' && category !== 'marketing') return false;
    const stored = readStored();
    return stored ? stored[category] === true : false;
  }

  function onChange(callback) {
    if (typeof callback !== 'function') return () => {};
    listeners.push(callback);
    return () => { const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); };
  }

  function expireCookie(name) {
    const host = root.location?.hostname || '';
    const labels = host.split('.');
    const domains = new Set(['', host, `.${host}`]);
    if (labels.length > 2) domains.add(`.${labels.slice(-2).join('.')}`);
    for (const domain of domains) {
      root.document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }
  }

  function cookieNames() {
    return String(root.document.cookie || '').split(';').map((part) => part.split('=')[0].trim()).filter(Boolean);
  }

  // Visszavonáskor a kategória ismert sütijeit és a belső elemzés munkamenet-azonosítóját töröljük.
  function cleanup(category) {
    try {
      if (category === 'analytics') {
        cookieNames().filter((name) => /^_ga(_.*)?$/.test(name) || name === '_gid' || /^_gat/.test(name)).forEach(expireCookie);
        try { root.sessionStorage.removeItem(ANALYTICS_SESSION_KEY); } catch (_error) { /* nincs tárhely, nincs mit törölni */ }
        try { root.localStorage.removeItem(ANALYTICS_SESSION_KEY); } catch (_error) { /* nincs tárhely, nincs mit törölni */ }
      }
      if (category === 'marketing') cookieNames().filter((name) => name === '_fbp' || name === '_fbc').forEach(expireCookie);
    } catch (error) {
      console.warn('A süti-takarítás nem sikerült:', error);
    }
  }

  function save(choices = {}) {
    const previous = get();
    const consent = { version: CONSENT_VERSION, necessary: true, analytics: choices.analytics === true, marketing: choices.marketing === true, ts: new Date().toISOString() };
    memoryConsent = consent;
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(consent)); } catch (error) { console.warn('A süti-hozzájárulás nem menthető a böngészőben:', error); }
    if (!consent.analytics) cleanup('analytics');
    if (!consent.marketing) cleanup('marketing');
    hide();
    const detail = { consent: { ...consent }, previous };
    for (const callback of listeners.slice()) {
      try { callback(detail.consent, previous); } catch (error) { console.error('Süti-hozzájárulás figyelő hiba:', error); }
    }
    root.document.dispatchEvent(new root.CustomEvent(EVENT_NAME, { detail }));
    return { ...consent };
  }

  const acceptAll = () => save({ analytics: true, marketing: true });
  const acceptNecessary = () => save({ analytics: false, marketing: false });

  // ---------- Felület ----------

  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, id) {
    const node = el('button', 'cc-btn', label);
    node.type = 'button';
    if (id) node.id = id;
    return node;
  }

  function category(key, title, description, details, checked, locked) {
    const wrap = el('div', 'cc-cat');
    const head = el('label', 'cc-cat-head');
    const text = el('span', 'cc-cat-title', title);
    const input = el('input');
    input.type = 'checkbox';
    input.id = `ccCat-${key}`;
    input.checked = checked;
    if (locked) { input.disabled = true; input.setAttribute('aria-disabled', 'true'); }
    head.append(text, input);
    wrap.append(head, el('p', 'cc-cat-desc', description), el('p', 'cc-cat-list', details));
    return { wrap, input };
  }

  function build() {
    const box = el('div', 'cc-banner');
    box.id = 'cookieConsent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-labelledby', 'ccTitle');
    box.setAttribute('aria-describedby', 'ccText');
    box.setAttribute('aria-modal', 'false');

    const close = el('button', 'cc-close', '×');
    close.type = 'button';
    close.id = 'ccClose';
    close.setAttribute('aria-label', 'Bezárás döntés nélkül');
    close.hidden = true;

    const title = el('h2', 'cc-title', 'Sütik és adatvédelem');
    title.id = 'ccTitle';
    title.tabIndex = -1;

    const text = el('p', 'cc-text');
    text.id = 'ccText';
    text.append('Az oldal működéséhez elengedhetetlen sütiket használunk. Statisztikai és marketing sütiket csak a hozzájárulásoddal helyezünk el; döntésed bármikor megváltoztatható. Részletek: ');
    const link = el('a', 'cc-link', 'Adatkezelési és süti-tájékoztató');
    link.href = '#';
    link.dataset.legal = 'privacy';
    text.append(link, '.');

    const details = el('div', 'cc-details');
    details.id = 'ccDetails';
    details.hidden = true;
    const stored = get();
    const necessary = category('necessary', 'Elengedhetetlen működési és biztonsági sütik', 'Mindig aktívak, nélkülük az oldal nem működik biztonságosan.', 'Munkamenet és belépés, a süti-döntés tárolása, Cloudflare Turnstile (robotvédelem), Barion alap csalásmegelőzési Pixel.', true, true);
    const analytics = category('analytics', 'Statisztikai és teljesítmény sütik', 'Segítenek megérteni, hogyan használják az oldalt.', 'Névtelen belső látogatói útvonal-elemzés és Google Analytics 4.', stored?.analytics === true, false);
    const marketing = category('marketing', 'Marketing sütik', 'A hirdetések és a vásárlások hatékonyságának mérése.', 'Meta Pixel és a Barion marketing (e-kereskedelmi) események.', stored?.marketing === true, false);
    details.append(necessary.wrap, analytics.wrap, marketing.wrap);

    const actions = el('div', 'cc-actions');
    const all = button('Összes elfogadása', 'ccAcceptAll');
    const only = button('Csak a szükségesek', 'ccAcceptNecessary');
    const settings = button('Beállítások', 'ccSettings');
    const saveBtn = button('Kiválasztottak mentése', 'ccSave');
    saveBtn.hidden = true;
    actions.append(all, only, settings, saveBtn);

    all.addEventListener('click', acceptAll);
    only.addEventListener('click', acceptNecessary);
    settings.addEventListener('click', () => showDetails(true));
    saveBtn.addEventListener('click', () => save({ analytics: analytics.input.checked, marketing: marketing.input.checked }));
    close.addEventListener('click', hide);

    box.append(close, title, text, details, actions);
    box.addEventListener('keydown', (event) => {
      // Az Esc nem hozzájárulás: legfeljebb bezárja a részletes nézetet / a újranyitott ablakot, a döntés változatlan marad.
      if (event.key !== 'Escape') return;
      if (get()) hide();
      else if (!details.hidden) showDetails(false);
    });
    return box;
  }

  function showDetails(open) {
    if (!banner) return;
    banner.querySelector('#ccDetails').hidden = !open;
    banner.querySelector('#ccSettings').hidden = open;
    banner.querySelector('#ccSave').hidden = !open;
    banner.classList.toggle('cc-expanded', open);
  }

  function hide() {
    if (!banner) return;
    banner.remove();
    banner = null;
    if (lastFocus && typeof lastFocus.focus === 'function' && root.document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function open() {
    if (banner) hide();
    if (!root.document.body) return;
    const reopened = get() !== null;
    lastFocus = reopened ? root.document.activeElement : null;
    banner = build();
    root.document.body.appendChild(banner);
    if (reopened) {
      showDetails(true);
      banner.querySelector('#ccClose').hidden = false;
      banner.querySelector('#ccTitle').focus();
    }
  }

  function init() {
    if (!get()) open();
    root.document.addEventListener('click', (event) => {
      const target = event.target instanceof root.Element ? event.target : null;
      if (target && target.closest('[data-cookie-settings]')) { event.preventDefault(); open(); }
    });
  }

  root.OviConsent = { get, has, onChange, open, acceptAll, acceptNecessary, save, CONSENT_VERSION, STORAGE_KEY, ANALYTICS_SESSION_KEY, EVENT_NAME, CATEGORIES };

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
  else init();
}(window));
