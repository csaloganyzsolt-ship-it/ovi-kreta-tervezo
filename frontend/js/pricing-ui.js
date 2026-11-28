// Közös árszámítás a felületeknek: az árak kizárólag a /api/config (Admin) beállításaiból jönnek, beégetett tartalék nincs.
// A szerver (backend/services/pricing.js) a mérvadó; ez csak tájékoztató kijelzés ugyanazzal a képlettel.
(function (root) {
  const TIERS = ['daily', 'weekly_summary', 'weekly_extra_day', 'academic_daily', 'academic_weekly'];
  let prices = null;
  let warned = false;

  function setPricing(pricing) {
    const next = {};
    for (const tier of TIERS) {
      const value = Number(pricing?.[tier]);
      if (!Number.isInteger(value) || value < 0) {
        prices = null;
        return false;
      }
      next[tier] = value;
    }
    prices = next;
    if (root.document && root.CustomEvent) root.document.dispatchEvent(new root.CustomEvent('pricing-loaded'));
    return true;
  }

  const isLoaded = () => prices !== null;

  function warnMissing() {
    if (warned) return;
    warned = true;
    console.error('Az árak nem töltődtek be a /api/config végpontról, ezért az ár nem jeleníthető meg.');
    if (root.document) root.document.dispatchEvent(new root.CustomEvent('pricing-missing'));
  }

  function formatHuf(value) {
    return `${String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Ft`;
  }

  function dayCount(selectedDays) {
    const count = Array.isArray(selectedDays) ? selectedDays.length : Number(selectedDays);
    return Number.isInteger(count) && count >= 1 && count <= 5 ? count : 5;
  }

  // kind: daily | weekly_summary | weekly_package | academic_daily | academic_weekly. Hiányzó konfigurációnál null.
  function priceFor(kind, selectedDays) {
    if (!prices) {
      warnMissing();
      return null;
    }
    if (kind === 'weekly_package') return prices.weekly_summary + dayCount(selectedDays) * prices.weekly_extra_day;
    if (kind === 'weekly_summary') return prices.weekly_summary;
    return prices[kind] ?? null;
  }

  const priceLabel = (kind, selectedDays) => {
    const price = priceFor(kind, selectedDays);
    return price === null ? null : formatHuf(price);
  };

  const api = { TIERS, setPricing, isLoaded, priceFor, priceLabel, formatHuf, dayCount, get prices() { return prices; } };
  root.OviPricing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
