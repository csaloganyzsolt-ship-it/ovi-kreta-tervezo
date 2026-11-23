/**
 * Telemetria modul (frontend): Anonim, GDPR-kompatibilis eseménynaplózás
 * - Küld névtelen eseményeket a backend /api/telemetry végpontjára
 * - Nincs sütik, localStorage azonosítók vagy PII
 * - Eszköztípus detektálása, referrer domain kinyerése
 * - navigator.sendBeacon fallback fetch-hez
 */

(function setupTelemetry() {
  'use strict';

  const API_ENDPOINT = '/api/telemetry';
  const BUFFER_SIZE = 10;
  const BUFFER_FLUSH_MS = 30000; // 30 másodperc

  let eventBuffer = [];
  let flushTimeout = null;

  /**
   * Eszköztípus detektálása a viewport szélességéből
   */
  function detectDeviceType() {
    const width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    if (width < 768) return 'mobile';
    if (width < 1024) return 'tablet';
    return 'desktop';
  }

  /**
   * Referrer domain kinyerése (parse URL)
   */
  function extractReferrerDomain() {
    if (!document.referrer) return null;
    try {
      const url = new URL(document.referrer);
      return url.hostname || null;
    } catch {
      return null;
    }
  }

  /**
   * Telemetria API hívás (sendBeacon fallback fetch-hez)
   */
  async function sendTelemetryBatch(events) {
    if (!events || events.length === 0) return;

    const payload = JSON.stringify(events);

    // Jelenlegi oldalon dolgozunk-e meg vagy navigáció közben
    // Utolsó kísérlet: sendBeacon (legmegbízhatóbb az oldal elhagyásakor)
    if (navigator.sendBeacon) {
      try {
        // sendBeacon a Blob-ot is elfogadja; payload előkészítés
        const blob = new Blob([payload], { type: 'application/json' });
        const success = navigator.sendBeacon(API_ENDPOINT, blob);
        if (success) {
          console.debug('[telemetry] Batch sent via sendBeacon', events.length);
          return;
        }
      } catch (error) {
        console.debug('[telemetry] sendBeacon fallback:', error.message);
      }
    }

    // Fallback: fetch keepalive módban
    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      });

      if (!response.ok) {
        console.warn('[telemetry] HTTP error', response.status);
      } else {
        console.debug('[telemetry] Batch sent via fetch', events.length);
      }
    } catch (error) {
      console.error('[telemetry] Send error:', error.message);
    }
  }

  /**
   * Buffer kiürítése időzítéssel
   */
  function scheduleFlush() {
    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(() => {
      flushBuffer();
    }, BUFFER_FLUSH_MS);
  }

  /**
   * Buffer tartalmának küldése
   */
  async function flushBuffer() {
    if (eventBuffer.length === 0) return;
    const batch = eventBuffer.splice(0, eventBuffer.length);
    await sendTelemetryBatch(batch);
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
  }

  /**
   * Felhasználó által szerkesztett metaadatok beállítása (pl. korosztály, témakör)
   * Ezt az alkalmazás állítja be az egyes lépésekben
   */
  window.telemetry = {
    metadata: {},

    /**
     * Esemény naplózása (az alkalmazás által hívható)
     * @param {string} eventName - Engedélyezett eseménynév (page_view, generator_started, stb.)
     * @param {object} extra - Opcionális extra metaadatok ({plan_mode, age_group, theme_category, stb.})
     */
    logEvent(eventName, extra = {}) {
      if (!eventName || typeof eventName !== 'string') {
        console.warn('[telemetry] Invalid eventName:', eventName);
        return;
      }

      const event = {
        eventName,
        deviceType: detectDeviceType(),
        referrerDomain: extractReferrerDomain(),
        metadata: {
          ...window.telemetry.metadata,
          ...extra,
          timestamp: new Date().toISOString()
        }
      };

      // Buffer hozzáadás
      eventBuffer.push(event);
      console.debug('[telemetry] Event buffered:', eventName, eventBuffer.length);

      // Buffer kiürítés ha túl nagy
      if (eventBuffer.length >= BUFFER_SIZE) {
        flushBuffer();
      } else {
        scheduleFlush();
      }
    },

    /**
     * Globális metaadatok beállítása (az alkalmazás által)
     */
    setMetadata(metadata) {
      if (typeof metadata === 'object' && metadata !== null) {
        window.telemetry.metadata = { ...window.telemetry.metadata, ...metadata };
        console.debug('[telemetry] Metadata updated:', window.telemetry.metadata);
      }
    },

    /**
     * Buffer kiürítés azonnalban (lehetséges adatvesztés nélkül)
     */
    async flush() {
      await flushBuffer();
    }
  };

  // Oldal betöltésének naplózása
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.telemetry.logEvent('page_view');
    });
  } else {
    window.telemetry.logEvent('page_view');
  }

  // Oldal elhagyásakor: buffer kiürítés (sendBeacon-nal)
  window.addEventListener('beforeunload', async () => {
    // Szinkrón flushBuffer lehet problémás, de sendBeacon-nal szinkrón
    if (eventBuffer.length > 0) {
      await flushBuffer();
    }
  });

  // Pagehide is támogatása (Safari, stb.)
  window.addEventListener('pagehide', async () => {
    if (eventBuffer.length > 0) {
      await flushBuffer();
    }
  });

  console.info('[telemetry] Module initialized');
})();
