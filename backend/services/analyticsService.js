'use strict';

/**
 * Admin statisztika modul: anonim telemetria adat aggregáció
 */

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

    if (!events || events.length === 0) {
      return {
        total_events: 0,
        funnel: {
          page_views: 0,
          generator_started: 0,
          document_generated: 0,
          paywall_opened: 0
        },
        devices: {},
        downloads: { docx: 0, pdf: 0 },
        top_topics: [],
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

    // Téma és korosztály (metaadatokból)
    const topics = {};
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
        const { theme_category, age_group } = event.metadata;
        
        if (theme_category) {
          topics[theme_category] = (topics[theme_category] || 0) + 1;
        }
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

    // Top 5 témák és korcsoportok
    const topTopics = Object.entries(topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

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
      top_topics: topTopics,
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
  getAnalyticsStats
};
