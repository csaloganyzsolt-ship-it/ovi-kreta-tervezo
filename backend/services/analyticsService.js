'use strict';

const { FUNNEL_STEPS } = require('./telemetryService');

/**
 * Admin statisztika modul: anonim telemetria adat aggregáció
 */

const FUNNEL_ROW_LIMIT = 10000;
const FUNNEL_PAGE_SIZE = 1000;

// Munkamenetenként a látott lépések alapján: elért (reached), tovább lépett (később is van esemény) és lemorzsolódott (az utolsó elért lépés ez volt).
function computeFunnel(rows, steps = FUNNEL_STEPS) {
  const indexOf = new Map(steps.map((name, index) => [name, index]));
  const bySession = new Map();
  for (const row of rows || []) {
    const index = indexOf.get(row?.event_name);
    if (index === undefined || !row.session_id) continue;
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, new Set());
    bySession.get(row.session_id).add(index);
  }
  const reached = steps.map(() => 0);
  const dropped = steps.map(() => 0);
  const continued = steps.map(() => 0);
  for (const seen of bySession.values()) {
    const last = Math.max(...seen);
    dropped[last] += 1;
    for (const index of seen) {
      reached[index] += 1;
      if (index < last) continued[index] += 1;
    }
  }
  const totalSessions = bySession.size;
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
  const result = steps.map((name, index) => ({
    step: name,
    reached: reached[index],
    continued: continued[index],
    continued_pct: pct(continued[index], reached[index]),
    dropped: dropped[index],
    dropped_pct: pct(dropped[index], totalSessions),
    biggest_drop: false
  }));
  // A záró lépésnél (sikeres fizetés) „megállni” nem lemorzsolódás.
  let worst = -1;
  result.slice(0, -1).forEach((entry, index) => {
    if (entry.dropped > 0 && (worst < 0 || entry.dropped > result[worst].dropped)) worst = index;
  });
  if (worst >= 0) result[worst].biggest_drop = true;
  return { total_sessions: totalSessions, steps: result };
}

async function getFunnelStats(client, timePeriodDays = null) {
  try {
    const rows = [];
    let truncated = false;
    for (let from = 0; from < FUNNEL_ROW_LIMIT; from += FUNNEL_PAGE_SIZE) {
      let query = client.from('analytics_events').select('session_id, event_name');
      if (timePeriodDays && typeof timePeriodDays === 'number' && timePeriodDays > 0) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - timePeriodDays);
        query = query.gte('created_at', startDate.toISOString());
      }
      const { data, error } = await query.not('session_id', 'is', null).order('created_at', { ascending: false }).range(from, from + FUNNEL_PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < FUNNEL_PAGE_SIZE) break;
      if (from + FUNNEL_PAGE_SIZE >= FUNNEL_ROW_LIMIT) truncated = true;
    }
    return { ...computeFunnel(rows), truncated, row_limit: FUNNEL_ROW_LIMIT };
  } catch (error) {
    console.error('[analytics] A látogatói útvonal lekérdezése sikertelen:', error.message);
    return null;
  }
}

async function getAnalyticsStats(client, timePeriodDays = null) {
  if (!client) return null;

  try {
    // Időszak szűrése
    let query = client.from('analytics_events').select('*');
    
    if (timePeriodDays && typeof timePeriodDays === 'number' && timePeriodDays > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - timePeriodDays);
      query = query.gte('created_at', startDate.toISOString());
    }

    const { data: events, error } = await query;

    if (error) {
      console.error('[analytics] Supabase query error:', error.message);
      return null;
    }

    const funnelPath = await getFunnelStats(client, timePeriodDays);

    if (!events || events.length === 0) {
      return {
        funnel_path: funnelPath,
        total_events: 0,
        funnel: {
          page_views: 0,
          generator_started: 0,
          document_generated: 0,
          paywall_opened: 0
        },
        devices: {},
        downloads: { docx: 0, pdf: 0 },
        top_age_groups: [],
        top_referrers: [],
        time_period_days: timePeriodDays || 'all'
      };
    }

    // Funnel elemzés (konverziós tölcsér)
    const funnel = {
      page_views: 0,
      generator_started: 0,
      document_generated: 0,
      paywall_opened: 0,
      successful_purchases: 0
    };

    // Eszköztípus megoszlás
    const devices = { mobile: 0, tablet: 0, desktop: 0, unknown: 0 };

    // Korosztály (metaadatokból); a témák statisztikája a közös themeStats-ból jön, nem a telemetriából
    const ageGroups = {};

    // Referrer domainek
    const referrers = {};

    // Letöltések
    const downloads = { docx: 0, pdf: 0 };

    // Áttérés esélye a funnel-en belül
    const conversionRates = {};

    // Események feldolgozása
    events.forEach((event) => {
      // Funnel számlálás
      switch (event.event_name) {
        case 'page_view':
          funnel.page_views += 1;
          break;
        case 'generator_started':
          funnel.generator_started += 1;
          break;
        case 'document_generated':
          funnel.document_generated += 1;
          break;
        case 'paywall_opened':
          funnel.paywall_opened += 1;
          break;
      }

      // Eszköztípus
      if (event.device_type) {
        devices[event.device_type] = (devices[event.device_type] || 0) + 1;
      } else {
        devices.unknown += 1;
      }

      // Metaadatok feldolgozása
      if (event.metadata && typeof event.metadata === 'object') {
        const { age_group } = event.metadata;

        if (age_group) {
          ageGroups[age_group] = (ageGroups[age_group] || 0) + 1;
        }
      }

      // Referrer domain
      if (event.referrer_domain) {
        referrers[event.referrer_domain] = (referrers[event.referrer_domain] || 0) + 1;
      }

      // Letöltések
      if (event.event_name === 'download_docx') {
        downloads.docx += 1;
      } else if (event.event_name === 'download_pdf') {
        downloads.pdf += 1;
      }
    });

    // Konverziós ráták számítása (%)
    if (funnel.page_views > 0) {
      conversionRates.generator_started_rate = ((funnel.generator_started / funnel.page_views) * 100).toFixed(2);
      conversionRates.document_generated_rate = ((funnel.document_generated / funnel.page_views) * 100).toFixed(2);
      conversionRates.paywall_opened_rate = ((funnel.paywall_opened / funnel.page_views) * 100).toFixed(2);
    }

    // Top 5 korcsoport
    const topAgeGroups = Object.entries(ageGroups)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Top referrerek
    const topReferrers = Object.entries(referrers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    // Eszközmegoszlás (%)
    const totalEvents = events.length;
    const deviceBreakdown = {
      mobile: ((devices.mobile / totalEvents) * 100).toFixed(1),
      tablet: ((devices.tablet / totalEvents) * 100).toFixed(1),
      desktop: ((devices.desktop / totalEvents) * 100).toFixed(1),
      unknown: ((devices.unknown / totalEvents) * 100).toFixed(1)
    };

    return {
      funnel_path: funnelPath,
      total_events: totalEvents,
      funnel: {
        page_views: funnel.page_views,
        generator_started: funnel.generator_started,
        document_generated: funnel.document_generated,
        paywall_opened: funnel.paywall_opened
      },
      conversion_rates: conversionRates,
      devices: deviceBreakdown,
      device_counts: devices,
      downloads,
      top_age_groups: topAgeGroups,
      top_referrers: topReferrers,
      time_period_days: timePeriodDays || 'all'
    };
  } catch (error) {
    console.error('[analytics] Error processing stats:', error.message);
    return null;
  }
}

module.exports = {
  computeFunnel,
  getFunnelStats,
  getAnalyticsStats
};
