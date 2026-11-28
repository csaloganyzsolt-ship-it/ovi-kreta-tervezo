// Hozzájárulás-vezérelt követés: GA4 (analitikai sütik) és Meta Pixel (marketing sütik).
// A szkriptek csak akkor töltődnek be, ha az azonosító meg van adva (Admin Központ → Analitika & Pixelek) ÉS a látogató hozzájárult;
// minden hívás biztonságos no-op, ha nincs hozzájárulás vagy a szkript nincs betöltve. A vásárlás eseménye rendelésszámonként egyszer megy ki.
(function (root) {
  'use strict';

  const PURCHASES_KEY = 'ovi_tracked_purchases';
  const CURRENCY = 'HUF';
  const GA4_ID_PATTERN = /^G-[A-Z0-9]{6,20}$/;
  const META_ID_PATTERN = /^[0-9]{10,20}$/;
  const MAX_PENDING = 25;

  let ids = { ga4: '', meta: '' };
  let ready = false;
  let ga4Loaded = false;
  let metaLoaded = false;
  const pending = [];

  const allowed = (category) => Boolean(root.OviConsent && typeof root.OviConsent.has === 'function' && root.OviConsent.has(category));
  const ga4Active = () => Boolean(ids.ga4) && ga4Loaded && allowed('analytics');
  const metaActive = () => Boolean(ids.meta) && metaLoaded && allowed('marketing');

  function inject(src) {
    const script = root.document.createElement('script');
    script.async = true;
    script.src = src;
    (root.document.head || root.document.documentElement).appendChild(script);
  }

  function consentState() {
    const marketing = allowed('marketing') ? 'granted' : 'denied';
    return { analytics_storage: allowed('analytics') ? 'granted' : 'denied', ad_storage: marketing, ad_user_data: marketing, ad_personalization: marketing };
  }

  function gtag() { root.dataLayer.push(arguments); }

  function pagePayload() {
    return { page_location: root.location.href, page_path: root.location.pathname, page_title: root.document.title };
  }

  function loadGa4() {
    if (!ids.ga4 || !allowed('analytics')) return;
    if (ga4Loaded) {
      root[`ga-disable-${ids.ga4}`] = false;
      gtag('consent', 'update', consentState());
      return;
    }
    root.dataLayer = root.dataLayer || [];
    root.gtag = gtag;
    // Consent Mode v2: előbb minden tiltott, csak azután frissítünk a tényleges döntésre.
    gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gtag('js', new Date());
    gtag('consent', 'update', consentState());
    gtag('config', ids.ga4, { anonymize_ip: true, send_page_view: false });
    inject(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ids.ga4)}`);
    ga4Loaded = true;
    gtag('event', 'page_view', pagePayload());
  }

  function loadMeta() {
    if (!ids.meta || !allowed('marketing')) return;
    if (metaLoaded) {
      root.fbq('consent', 'grant');
      return;
    }
    if (!root.fbq) {
      const fbq = function fbqStub() { if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments); else fbq.queue.push(arguments); };
      root.fbq = fbq;
      if (!root._fbq) root._fbq = fbq;
      fbq.push = fbq;
      fbq.loaded = true;
      fbq.version = '2.0';
      fbq.queue = [];
    }
    inject('https://connect.facebook.net/en_US/fbevents.js');
    metaLoaded = true;
    root.fbq('consent', 'grant');
    root.fbq('init', ids.meta);
    root.fbq('track', 'PageView');
  }

  function revoke() {
    if (ga4Loaded && ids.ga4) {
      root[`ga-disable-${ids.ga4}`] = !allowed('analytics');
      gtag('consent', 'update', consentState());
    }
    if (metaLoaded && !allowed('marketing') && typeof root.fbq === 'function') root.fbq('consent', 'revoke');
  }

  function sync() {
    if (!ready) return;
    loadGa4();
    loadMeta();
    revoke();
    while (pending.length && (ga4Active() || metaActive())) {
      const [name, params] = pending.shift();
      dispatch(name, params);
    }
    if (!ga4Active() && !metaActive()) pending.length = 0;
  }

  // ---------- Vásárlás duplikációvédelem (rendelésszám + platform) ----------

  function readPurchases() {
    try {
      const parsed = JSON.parse(root.localStorage.getItem(PURCHASES_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function markPurchase(entry) {
    try { root.localStorage.setItem(PURCHASES_KEY, JSON.stringify([...readPurchases(), entry].slice(-100))); } catch (_error) { /* a tárolás hiánya csak a duplikációvédelmet gyengíti */ }
  }

  // ---------- Események ----------

  function commerce(params) {
    const value = Number(params.value);
    return { currency: CURRENCY, value: Number.isFinite(value) ? value : 0 };
  }

  function sendGa4(name, params) {
    if (name === 'purchase') {
      const id = String(params.transaction_id || '');
      if (!id || readPurchases().includes(`ga4:${id}`)) return false;
      gtag('event', 'purchase', { transaction_id: id, ...commerce(params), items: params.items || [] });
      markPurchase(`ga4:${id}`);
      return true;
    }
    if (name === 'view_item' || name === 'begin_checkout') {
      gtag('event', name, { ...commerce(params), items: params.items || [] });
      return true;
    }
    if (name === 'page_view') { gtag('event', 'page_view', pagePayload()); return true; }
    gtag('event', name, params);
    return true;
  }

  function sendMeta(name, params) {
    const contentIds = (params.items || []).map((item) => String(item.item_id));
    const content = { ...commerce(params), content_ids: contentIds, content_type: 'product' };
    if (name === 'page_view') { root.fbq('track', 'PageView'); return true; }
    if (name === 'view_item') { root.fbq('track', 'ViewContent', content); return true; }
    if (name === 'begin_checkout') { root.fbq('track', 'InitiateCheckout', content); return true; }
    if (name === 'purchase') {
      const id = String(params.transaction_id || '');
      if (!id || readPurchases().includes(`meta:${id}`)) return false;
      root.fbq('track', 'Purchase', content, { eventID: id });
      markPurchase(`meta:${id}`);
      return true;
    }
    return false;
  }

  function dispatch(name, params) {
    let sent = false;
    if (ga4Active()) sent = sendGa4(name, params) || sent;
    if (metaActive()) sent = sendMeta(name, params) || sent;
    return sent;
  }

  function track(name, params = {}) {
    try {
      if (typeof name !== 'string' || !name) return false;
      if (!ready) {
        // A /api/config megérkezéséig a hívások sorban várnak (csak ha egyáltalán hozzájárult a látogató).
        if ((allowed('analytics') || allowed('marketing')) && pending.length < MAX_PENDING) pending.push([name, params]);
        return false;
      }
      return dispatch(name, params || {});
    } catch (error) {
      console.warn('A követési esemény nem küldhető el:', error);
      return false;
    }
  }

  // ---------- Indulás ----------

  function applyConfig(config) {
    const tracking = (config && (config.trackingConfig || config.tracking_config)) || {};
    const ga4 = String(tracking.ga4_measurement_id || '').trim();
    const meta = String(tracking.meta_pixel_id || '').trim();
    ids = { ga4: GA4_ID_PATTERN.test(ga4) ? ga4 : '', meta: META_ID_PATTERN.test(meta) ? meta : '' };
    ready = true;
    sync();
  }

  function observePricing() {
    const target = root.document.getElementById('pricingTable') || root.document.querySelector('[data-pricing-section]');
    if (!target) return;
    const fire = () => {
      root.telemetry?.logFunnel?.('pricing_view');
      track('pricing_view');
    };
    if (typeof root.IntersectionObserver !== 'function') { fire(); return; }
    const observer = new root.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); fire(); }
    }, { threshold: 0.3 });
    observer.observe(target);
  }

  root.OviTracking = { track, sync, purchasesKey: PURCHASES_KEY, state: () => ({ ids: { ...ids }, ready, ga4Loaded, metaLoaded }) };

  root.document.addEventListener('ovi:consent-changed', sync);

  const configPromise = typeof root.loadRuntimeConfig === 'function' ? root.loadRuntimeConfig() : Promise.resolve(root.APP_CONFIG || {});
  configPromise.then(applyConfig, (error) => {
    console.error('A követési beállítások nem tölthetők be:', error);
  });

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', observePricing);
  else observePricing();
}(window));
