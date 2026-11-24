// Anonim, GDPR-kompatibilis eseménykövetés: nincs süti, nincs localStorage/sessionStorage, nincs azonosító.
// Csak az eseménynév, az eszköztípus (képernyőméretből), a küldő domain és néhány névtelen szakmai adat megy ki.
(function () {
  'use strict';

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

  function logEvent(eventName, metadata = {}) {
    const base = apiBase();
    if (!base) return;
    const body = JSON.stringify({
      eventName,
      deviceType: deviceType(),
      referrerDomain: referrerDomain(),
      metadata: { utm_source: utmSource(), ...metadata }
    });
    // A telemetria hibája nem zavarhatja a felhasználót, ezért itt (és csak itt) nem jelzünk a felületen.
    fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
  }

  window.telemetry = { logEvent };

  logEvent('page_view');

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
})();
