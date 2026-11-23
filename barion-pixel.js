// Barion Base Pixel. Az azonosító a config.js-ből jön (APP_CONFIG.barionPixelId); hiányzó vagy érvénytelen értéknél semmit nem tölt be.
(function loadBarionPixel() {
  try {
    const pixelId = String((window.APP_CONFIG || {}).barionPixelId || '').trim();
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
}());

// Teljes (Full) Barion Pixel e-kereskedelmi események. Minden hívás védett: ha a Pixel le van tiltva vagy blokkolva, az oldal működése nem változik.
(function fullBarionPixel(root) {
  const CURRENCY = 'HUF';
  const PURCHASES_KEY = 'oviKretaBarionPurchases';
  const CATALOG = [
    { id: 'daily', name: 'Napi tervezet', price: 390 },
    { id: 'academic_daily', name: 'Oktatási célú tervezet', price: 690 },
    { id: 'weekly_detailed', name: 'Heti részletes csomag', price: 890 }
  ];

  function contentsOf(items) {
    return items.map((item) => ({ id: String(item.id), name: String(item.name), quantity: 1, unitPrice: Number(item.price), price: Number(item.price), currency: CURRENCY }));
  }

  function track(eventName, params) {
    try {
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
    CATALOG,
    track,
    contentView(items = CATALOG) {
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
    const send = () => api.contentView();
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', send); else send();
  }
}(typeof window !== 'undefined' ? window : globalThis));
