'use strict';

// A heti terv napjainak és típusának egyetlen forrása: a generálás, az árazás és a fizetés is innen veszi a napszámot és a csomagtípust.
const WEEKDAYS = Object.freeze(['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek']);

// A kiválasztott napok hétfői–pénteki sorrendben, duplikáció nélkül (1–5 nap); hiányzó vagy érvénytelen érték esetén mind az 5 nap.
function selectedDaysOf(payload = {}) {
  const requested = Array.isArray(payload?.selectedDays) ? payload.selectedDays : [];
  const days = WEEKDAYS.filter((day) => requested.includes(day));
  return days.length ? days : [...WEEKDAYS];
}

// 'summary' = csak heti összesítő, 'package' = összesítő + napi tervek, null = nem standard heti terv.
function standardWeeklyScope(payload = {}) {
  if (payload?.duration !== 'Heti' || payload?.planMode === 'academic') return null;
  return payload.weeklyScope === 'package' ? 'package' : 'summary';
}

// A mentett tervezet valódi besorolása (a kliens kérésétől független): termékkulcs, mód, hatókör és a kidolgozott napok.
function classifyStoredPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const request = plan.request && typeof plan.request === 'object' ? plan.request : {};
  const academic = plan.planMode === 'academic' || plan.is_thematic === true || request.planMode === 'academic';
  if (academic) {
    const planKey = plan.is_thematic === true || request.duration === 'Heti' ? 'academic_weekly' : 'academic_daily';
    return { planMode: 'academic', planKey, weeklyScope: null, selectedDays: [] };
  }
  if (plan.is_weekly === true && Array.isArray(plan.napok)) {
    const generated = WEEKDAYS.filter((day) => plan.napok.some((entry) => entry?.nap_neve === day));
    return { planMode: 'standard', planKey: 'weekly_package', weeklyScope: 'package', selectedDays: generated.length ? generated : selectedDaysOf(request) };
  }
  if (plan.is_weekly_summary === true) {
    return { planMode: 'standard', planKey: 'weekly_summary', weeklyScope: 'summary', selectedDays: [] };
  }
  return { planMode: 'standard', planKey: 'daily', weeklyScope: null, selectedDays: [] };
}

module.exports = { WEEKDAYS, selectedDaysOf, standardWeeklyScope, classifyStoredPlan };
