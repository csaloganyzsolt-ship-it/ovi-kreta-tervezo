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
