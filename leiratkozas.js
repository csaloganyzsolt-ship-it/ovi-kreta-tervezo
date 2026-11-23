// Egykattintásos hírlevél-leiratkozás (leiratkozas.html): az URL-ben kapott ?token=... azonosítóval hívja a nyilvános leiratkozó végpontot.
// Klasszikus script (nem ES modul). A leiratkozás szándékosan JavaScriptből, POST-tal fut, hogy a levélszűrők linkellenőrzése ne iratkoztasson le senkit.
(function () {
  'use strict';

  const SECTIONS = ['unsubLoading', 'unsubSuccess', 'unsubInvalid', 'unsubError'];

  function byId(id) { return document.getElementById(id); }

  function show(id) {
    SECTIONS.forEach((section) => { byId(section).hidden = section !== id; });
  }

  function apiBaseUrl() {
    const configured = String(window.APP_CONFIG?.apiBaseUrl || '').trim().replace(/\/+$/, '');
    if (configured === 'same-origin') return window.location.origin;
    if (configured) return configured;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || !host ? 'http://localhost:4000' : window.location.origin;
  }

  async function unsubscribe() {
    const token = (new URLSearchParams(window.location.search).get('token') || '').trim();
    if (!token) {
      show('unsubInvalid');
      return;
    }
    show('unsubLoading');
    try {
      const response = await fetch(`${apiBaseUrl()}/api/newsletter/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (response.status === 404) {
        show('unsubInvalid');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
      show('unsubSuccess');
    } catch (error) {
      byId('unsubErrorText').textContent = `A leiratkozás nem sikerült: ${error.message}. Kérjük, próbáld újra később.`;
      show('unsubError');
    }
  }

  byId('unsubRetry').addEventListener('click', unsubscribe);
  unsubscribe();
})();
