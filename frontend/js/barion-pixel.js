// Barion Base Pixel. Csak akkor töltődik be, ha az aktív fizetési szolgáltató a Barion (a /api/config paymentProvider mezője);
// az azonosító a /api/config-ból vagy a config.js-ből jön (barionPixelId). Hiányzó vagy érvénytelen értéknél semmit nem tölt be.
(function loadBarionPixel() {
  function start(config) {
    try {
      if (config.paymentProvider !== undefined && config.paymentProvider !== 'barion') return;
      const tracking = config.trackingConfig;
      const pixelId = String(tracking && Object.prototype.hasOwnProperty.call(tracking, 'barion_pixel_id') ? tracking.barion_pixel_id : config.barionPixelId || '').trim();
      if (!/^BP-[A-Za-z0-9-]{4,60}$/.test(pixelId)) return;
      window.bp = window.bp || function bp() {
        (window.bp.q = window.bp.q || []).push(arguments);
      };
      window.bp.l = 1 * new Date();
      window.barion_pixel_id = pixelId;
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://pixel.barion.com/bp.js';
      document.head.appendChild(script);
      window.bp('init', 'addBarionPixelId', pixelId);
    } catch (error) {
      console.warn('A Barion Pixel nem tölthető be:', error);
    }
  }
  if (typeof window.loadRuntimeConfig === 'function') window.loadRuntimeConfig().then(start);
  else start(window.APP_CONFIG || {});
}());

// Teljes (Full) Barion Pixel e-kereskedelmi események. Minden hívás védett: ha a Pixel le van tiltva vagy blokkolva, az oldal működése nem változik.
(function fullBarionPixel(root) {
  const CURRENCY = 'HUF';
  const PURCHASES_KEY = 'oviKretaBarionPurchases';
  // A listaárak nem ide vannak beégetve: a /api/config árait (OviPricing) használja; a csomagnevek maradnak.
  const CATALOG_ITEMS = [
    { id: 'daily', name: 'Napi tervezet' },
    { id: 'weekly_summary', name: 'Heti összesítő' },
    { id: 'weekly_package', name: 'Teljes heti csomag' },
    { id: 'academic_daily', name: 'Oktatási célú tervezet' }
  ];

  function catalog() {
    const pricing = root.OviPricing;
    if (!pricing || !pricing.isLoaded()) return [];
    return CATALOG_ITEMS.map((item) => ({ ...item, price: pricing.priceFor(item.id, 5) }));
  }

  function contentsOf(items) {
    return items.map((item) => ({ id: String(item.id), name: String(item.name), quantity: 1, unitPrice: Number(item.price), price: Number(item.price), currency: CURRENCY }));
  }

  // Az alap Pixel csökkenti a csalás kockázatát, ezért hozzájárulás nélkül is betölthet; az e-kereskedelmi események viszont csak marketing-hozzájárulással mennek el.
  function marketingAllowed() {
    return Boolean(root.OviConsent?.has?.('marketing'));
  }

  function track(eventName, params) {
    try {
      if (!marketingAllowed()) return false;
      if (typeof root.bp !== 'function') return false;
      root.bp('track', eventName, params);
      return true;
    } catch (error) {
      console.warn('A Barion Pixel esemény nem küldhető el:', error);
      return false;
    }
  }

  function readPurchases() {
    try { return JSON.parse(root.localStorage.getItem(PURCHASES_KEY) || '[]'); } catch (_e) { return []; }
  }

  const api = {
    CATALOG_ITEMS,
    catalog,
    track,
    contentView(items = catalog()) {
      if (!items.length) {
        console.error('A Barion Pixel contentView nem küldhető: az árak még nem töltődtek be.');
        return false;
      }
      return track('contentView', { contentType: 'Product', currency: CURRENCY, contents: contentsOf(items) });
    },
    addToCart(item) {
      return track('addToCart', { contentType: 'Product', currency: CURRENCY, value: Number(item.price), contents: contentsOf([item]) });
    },
    initiateCheckout(item) {
      return track('initiateCheckout', { contentType: 'Product', currency: CURRENCY, step: 1, stepDescription: 'Barion fizetés indítása', totalItemPrice: Number(item.price), contents: contentsOf([item]) });
    },
    // Ugyanazt a tranzakciót oldalfrissítéskor sem küldi el újra (az azonosítók a böngészőben maradnak, személyes adat nélkül).
    purchase(order) {
      const id = String(order?.id || '');
      if (!id || !(Number(order.price) > 0)) return false;
      const seen = readPurchases();
      if (seen.includes(id)) return false;
      if (!track('purchase', { id, transactionId: id, contentType: 'Product', currency: CURRENCY, revenue: Number(order.price), contents: contentsOf([{ id: order.itemId, name: order.name, price: order.price }]) })) return false;
      try { root.localStorage.setItem(PURCHASES_KEY, JSON.stringify([...seen, id].slice(-50))); } catch (_e) { /* a tárolás hiánya csak a duplikációvédelmet gyengíti */ }
      return true;
    }
  };

  root.barionPixel = api;
  if (root.document && root.document.getElementById && /tervezo(\.html)?$/.test(root.location?.pathname || '')) {
    // Az árak a /api/config-ból érkeznek; a megtekintés egyszer, az árak betöltése után megy el.
    let sent = false;
    const send = () => {
      if (sent || !root.OviPricing?.isLoaded() || !marketingAllowed()) return;
      sent = true;
      api.contentView();
    };
    root.document.addEventListener('pricing-loaded', send);
    root.document.addEventListener('ovi:consent-changed', send);
    send();
  }
}(typeof window !== 'undefined' ? window : globalThis));
