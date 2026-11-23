/**
 * Telemetria és Analytics tesztek
 */

const test = require('node:test');
const assert = require('node:assert');
const telemetryService = require('../services/telemetryService');
const analyticsService = require('../services/analyticsService');

test('Telemetry: Device type detection', () => {
  assert.strictEqual(telemetryService.detectDeviceType(0), null);
  assert.strictEqual(telemetryService.detectDeviceType(500), 'mobile');
  assert.strictEqual(telemetryService.detectDeviceType(900), 'tablet');
  assert.strictEqual(telemetryService.detectDeviceType(1200), 'desktop');
});

test('Telemetry: Referrer domain extraction', () => {
  assert.strictEqual(telemetryService.extractReferrerDomain(null), null);
  assert.strictEqual(telemetryService.extractReferrerDomain(''), null);
  assert.strictEqual(telemetryService.extractReferrerDomain('https://example.com/path'), 'example.com');
  assert.strictEqual(telemetryService.extractReferrerDomain('http://www.ovitervezo.hu/'), 'www.ovitervezo.hu');
  
  // Érvénytelen URL
  assert.strictEqual(telemetryService.extractReferrerDomain('not-a-valid-url'), null);
});

test('Telemetry: Whitelist validation', () => {
  assert.ok(telemetryService.ALLOWED_EVENTS.has('page_view'));
  assert.ok(telemetryService.ALLOWED_EVENTS.has('generator_started'));
  assert.ok(telemetryService.ALLOWED_EVENTS.has('document_generated'));
  assert.ok(telemetryService.ALLOWED_EVENTS.has('download_docx'));
  assert.ok(!telemetryService.ALLOWED_EVENTS.has('invalid_event'));
  assert.ok(!telemetryService.ALLOWED_EVENTS.has('user_id_logged'));
});

test('Telemetry: PII detection and metadata sanitising', () => {
  assert.ok(telemetryService.isPIIDetected('user@example.com'));
  assert.ok(telemetryService.isPIIDetected('192.168.1.1'));
  assert.ok(!telemetryService.isPIIDetected('Nagycsoport'));
  assert.deepEqual(telemetryService.sanitizeMetadata({ plan_mode: 'daily', user_id: 'x', email: 'a@b.hu' }), { plan_mode: 'daily' });
});

test('Analytics: Stats aggregation with mock data', async () => {
  // Mock Supabase kliens
  const mockClient = {
    from: () => ({
      select: () => ({
        gte: () => ({
          data: [
            { event_name: 'page_view', device_type: 'mobile', metadata: { theme_category: 'Animals', age_group: '3-4 years' }, created_at: '2026-11-24T10:00:00Z' },
            { event_name: 'page_view', device_type: 'desktop', metadata: { theme_category: 'Animals', age_group: '3-4 years' }, created_at: '2026-11-24T10:01:00Z' },
            { event_name: 'generator_started', device_type: 'tablet', metadata: { plan_mode: 'daily' }, created_at: '2026-11-24T10:02:00Z' },
            { event_name: 'document_generated', device_type: 'mobile', metadata: { age_group: '5-6 years' }, created_at: '2026-11-24T10:03:00Z' },
            { event_name: 'download_docx', device_type: 'desktop', metadata: {}, created_at: '2026-11-24T10:04:00Z' },
            { event_name: 'download_pdf', device_type: 'mobile', metadata: {}, created_at: '2026-11-24T10:05:00Z' }
          ],
          error: null
        })
      })
    })
  };

  const stats = await analyticsService.getAnalyticsStats(mockClient, 7);

  assert.strictEqual(stats.total_events, 6);
  assert.strictEqual(stats.funnel.page_views, 2);
  assert.strictEqual(stats.funnel.generator_started, 1);
  assert.strictEqual(stats.funnel.document_generated, 1);
  assert.strictEqual(stats.downloads.docx, 1);
  assert.strictEqual(stats.downloads.pdf, 1);

  // Eszközmegoszlás (%)
  assert.ok(stats.devices.mobile);
  assert.ok(stats.devices.desktop);
  assert.ok(stats.devices.tablet);

  // Top topics
  assert.ok(Array.isArray(stats.top_topics));
  assert.ok(stats.top_topics.some((t) => t.name === 'Animals'));

  // Top age groups
  assert.ok(Array.isArray(stats.top_age_groups));
  assert.ok(stats.top_age_groups.some((a) => a.name === '3-4 years'));

  console.log('Analytics stats:', JSON.stringify(stats, null, 2));
});

test('Analytics: Null client handling', async () => {
  const stats = await analyticsService.getAnalyticsStats(null, 7);
  assert.strictEqual(stats, null);
});

test('Analytics: Empty events handling', async () => {
  const mockClient = {
    from: () => ({
      select: () => ({
        gte: () => ({
          data: [],
          error: null
        })
      })
    })
  };

  const stats = await analyticsService.getAnalyticsStats(mockClient, 7);
  assert.strictEqual(stats.total_events, 0);
  assert.deepStrictEqual(stats.funnel, {
    page_views: 0,
    generator_started: 0,
    document_generated: 0,
    paywall_opened: 0
  });
});
