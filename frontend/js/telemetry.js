// Belső, névtelen eseménykövetés és látogatói útvonal (tölcsér). Csak statisztikai süti-hozzájárulással (OviConsent: analytics) működik:
// hozzájárulás nélkül SEMMI nem megy ki. A munkamenet-azonosító (ovi_analytics_sid) véletlen, a böngésző munkamenet-tárhelyében él,
// IP-címet és ujjlenyomatot nem tárolunk; visszavonáskor az azonosítót az OviConsent törli.
(function () {
  'use strict';

  const SESSION_KEY = 'ovi_analytics_sid';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

  const analyticsAllowed = () => Boolean(window.OviConsent?.has?.('analytics'));

  function apiBase() {
    const configured = String(window.APP_CONFIG?.apiBaseUrl || '').trim().replace(/\/+$/, '');
    if (configured === 'same-origin') return window.location.origin;
    if (configured) return configured;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || !host ? 'http://localhost:4000' : '';
  }

  function deviceType() {
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    return width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
  }

  function referrerDomain() {
    try {
      const host = new URL(document.referrer).hostname;
      return host && host !== window.location.hostname ? host : null;
    } catch {
      return null;
    }
  }

  function utmSource() {
    return new URLSearchParams(window.location.search).get('utm_source') || undefined;
  }

  function randomSessionId() {
    const bytes = new Uint8Array(24);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  }

  // Csak hozzájárulás után hoz létre azonosítót; tárhely nélkül egy oldalbetöltésre szóló memóriaértéket használ.
  let memorySid = '';
  function sessionId() {
    if (!analyticsAllowed()) return '';
    try {
      let sid = window.sessionStorage.getItem(SESSION_KEY);
      if (!sid || !/^[A-Za-z0-9_-]{16,64}$/.test(sid)) {
        sid = randomSessionId();
        window.sessionStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    } catch (_error) {
      memorySid = memorySid || randomSessionId();
      return memorySid;
    }
  }

  function logEvent(eventName, metadata = {}) {
    if (!analyticsAllowed()) return;
    const base = apiBase();
    if (!base) return;
    const body = JSON.stringify({
      eventName,
      sessionId: sessionId(),
      deviceType: deviceType(),
      referrerDomain: referrerDomain(),
      metadata: { utm_source: utmSource(), ...metadata }
    });
    // A telemetria hibája nem zavarhatja a felhasználót, ezért itt (és csak itt) nem jelzünk a felületen.
    fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
  }

  // Tölcsér-lépés (landing_view, planner_step_N, paywall_opened, ...): ugyanaz a küldés, külön név a hívási helyeken.
  const logFunnel = (step, metadata) => logEvent(step, metadata);

  window.telemetry = { logEvent, logFunnel };

  function isLanding() {
    return /(^|\/)(index\.html)?$/.test(window.location.pathname);
  }

  let started = false;
  function startPage() {
    if (started || !analyticsAllowed()) return;
    started = true;
    logEvent('page_view');
    if (isLanding()) logFunnel('landing_view');
  }

  startPage();
  // Hozzájárulás oldalbetöltés közben: ekkor indul a követés újratöltés nélkül.
  document.addEventListener('ovi:consent-changed', startPage);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('#downloadDocxBtn')) logEvent('download_docx');
    else if (target.closest('#downloadPdfBtn')) logEvent('download_pdf');
    else if (target.closest('#authBtn')) logEvent('auth_modal_opened');
  });

  document.addEventListener('focusin', (event) => {
    if (event.target instanceof Element && event.target.id === 'couponCode') logEvent('coupon_box_opened');
  });
}());
