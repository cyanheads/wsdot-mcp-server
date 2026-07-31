/**
 * @fileoverview Tests for WSDOT traffic tools: mountain passes, alerts, travel times,
 * toll rates, border waits, and cameras.
 * @module tests/tools/traffic-tools.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted so vi.mock factory runs before imports) ---

const mockService = {
  getMountainPasses: vi.fn(),
  searchAlerts: vi.fn(),
  getTravelTimes: vi.fn(),
  getTollRates: vi.fn(),
  getBorderCrossings: vi.fn(),
  searchCameras: vi.fn(),
};

vi.mock('@/services/traffic/traffic-service.js', () => ({
  getTrafficApiService: () => mockService,
}));

// --- Import tools after mocks are set up ---

import { getBorderWaits } from '@/mcp-server/tools/definitions/get-border-waits.tool.js';
import { getMountainPasses } from '@/mcp-server/tools/definitions/get-mountain-passes.tool.js';
import { getTollRates } from '@/mcp-server/tools/definitions/get-toll-rates.tool.js';
import { getTravelTimes } from '@/mcp-server/tools/definitions/get-travel-times.tool.js';
import { searchAlerts } from '@/mcp-server/tools/definitions/search-alerts.tool.js';
import { searchCameras } from '@/mcp-server/tools/definitions/search-cameras.tool.js';
import { describePaginationContract } from '../helpers/pagination.js';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Zero-padded so no row's marker is a substring of another's. */
const pad = (index: number) => String(index).padStart(3, '0');

// ---------------------------------------------------------------------------
// Upstream failure contract — shared by every traffic tool
// ---------------------------------------------------------------------------

describe('traffic tools — upstream failure contract', () => {
  const trafficTools = [
    getBorderWaits,
    getMountainPasses,
    getTollRates,
    getTravelTimes,
    searchAlerts,
    searchCameras,
  ];

  for (const t of trafficTools) {
    it(`${t.name} declares api_unavailable and invalid_access_code with distinct recovery`, () => {
      const byReason = new Map(t.errors!.map((e) => [e.reason, e]));
      expect(byReason.get('api_unavailable')?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(byReason.get('invalid_access_code')?.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(byReason.get('invalid_access_code')?.retryable).toBe(false);
      expect(byReason.get('api_unavailable')?.recovery).not.toBe(
        byReason.get('invalid_access_code')?.recovery,
      );
    });
  }

  it('surfaces api_unavailable with its recovery hint when the service reports an outage', async () => {
    // Mirrors what TrafficApiService.fetchJson throws for a non-2xx.
    mockService.getMountainPasses.mockImplementation((c: Context) => {
      throw serviceUnavailable('WSDOT Traffic API returned HTTP 503.', {
        status: 503,
        reason: 'api_unavailable',
        ...c.recoveryFor('api_unavailable'),
      });
    });
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await getMountainPasses
      .handler(getMountainPasses.input.parse({}), ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({
      reason: 'api_unavailable',
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
  });

  it('surfaces invalid_access_code with a configuration-repair recovery hint', async () => {
    mockService.getMountainPasses.mockImplementation((c: Context) => {
      throw configurationError(
        'WSDOT Traffic API returned an HTML page instead of JSON — WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
        {
          status: 400,
          reason: 'invalid_access_code',
          ...c.recoveryFor('invalid_access_code'),
        },
      );
    });
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await getMountainPasses
      .handler(getMountainPasses.input.parse({}), ctx)
      .catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_access_code',
      recovery: { hint: expect.stringContaining('WSDOT_ACCESS_CODE') },
    });
  });
});

// ---------------------------------------------------------------------------
// getMountainPasses
// ---------------------------------------------------------------------------

describe('getMountainPasses', () => {
  const passFixture = {
    mountainPassId: 1,
    mountainPassName: 'Snoqualmie Pass',
    elevation: 3022,
    temperatureInFahrenheit: 28,
    weatherCondition: 'Snow',
    roadCondition: 'Snow and Ice Covered',
    travelAdvisoryActive: true,
    restrictionOne: { text: 'Traction Tires Required', travelDirection: 'Eastbound' },
    dateUpdated: '2023-11-14T22:13:20.000Z',
    latitude: 47.4273,
    longitude: -121.4128,
  };

  it('returns passes from the service', async () => {
    mockService.getMountainPasses.mockResolvedValue([passFixture]);
    const ctx = createMockContext();
    const input = getMountainPasses.input.parse({});
    const result = await getMountainPasses.handler(input, ctx);
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0].mountainPassId).toBe(1);
    expect(result.passes[0].mountainPassName).toBe('Snoqualmie Pass');
  });

  it('enriches with totalCount', async () => {
    mockService.getMountainPasses.mockResolvedValue([passFixture]);
    const ctx = createMockContext();
    const input = getMountainPasses.input.parse({});
    await getMountainPasses.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no passes returned', async () => {
    mockService.getMountainPasses.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getMountainPasses.input.parse({});
    const result = await getMountainPasses.handler(input, ctx);
    expect(result.passes).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('formats passes with key fields', () => {
    const output = {
      passes: [passFixture],
    };
    const blocks = getMountainPasses.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Snoqualmie Pass');
    expect(text).toContain('3022');
    expect(text).toContain('28');
    expect(text).toContain('Snow');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('1'); // mountainPassId
  });

  it('formats empty passes list', () => {
    const blocks = getMountainPasses.format!({ passes: [] });
    expect((blocks[0] as { text: string }).text).toContain('No mountain pass data');
  });

  it('handles sparse pass (minimal fields only)', () => {
    const sparsePass = { mountainPassId: 99, mountainPassName: 'Test Pass' };
    const output = { passes: [sparsePass] };
    const blocks = getMountainPasses.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Test Pass');
    expect(text).toContain('99');
  });
});

// ---------------------------------------------------------------------------
// searchAlerts
// ---------------------------------------------------------------------------

describe('searchAlerts', () => {
  const alertFixture = {
    alertId: 101,
    headlineDescription: 'I-90 Lane Closure',
    extendedDescription: 'All lanes blocked at MP 30',
    eventCategory: 'Closure',
    eventStatus: 'Active',
    priority: 'High',
    region: 'Northwest',
    county: 'King',
    startRoadwayLocation: {
      roadName: 'I-90',
      direction: 'Both',
      milePost: 30,
      latitude: 47.5,
      longitude: -121.7,
    },
    startTime: '2023-11-14T22:13:20.000Z',
    lastUpdatedTime: '2023-11-14T22:30:00.000Z',
  };

  it('returns all alerts when no filters provided', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({});
    const result = await searchAlerts.handler(input, ctx);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].alertId).toBe(101);
  });

  it('enriches with totalCount and empty appliedFilters', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({});
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.appliedFilters).toEqual({});
    expect(enrichment.hasMore).toBe(false);
    expect(enrichment.nextOffset).toBeNull();
    expect(enrichment.notice).toBe('Showing alerts 1–1 of 1.');
  });

  it('enriches appliedFilters with stateRoute', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedFilters.stateRoute).toBe('090');
  });

  it('enriches notice on empty results with filters', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('filter');
  });

  it('enriches notice on empty results with no filters', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({});
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No active');
  });

  it('passes stateRoute filter to service', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    expect(mockService.searchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ stateRoute: '090' }),
      ctx,
    );
  });

  it('passes region filter to service', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ region: 'Northwest' });
    await searchAlerts.handler(input, ctx);
    expect(mockService.searchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'Northwest' }),
      ctx,
    );
  });

  it('strips whitespace-only stateRoute filter', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: '   ' });
    await searchAlerts.handler(input, ctx);
    // whitespace-only stateRoute is treated as absent — service receives no stateRoute key
    expect(mockService.searchAlerts).toHaveBeenCalledWith(
      expect.not.objectContaining({ stateRoute: expect.anything() }),
      ctx,
    );
  });

  it('formats alerts with key fields', () => {
    const output = { alerts: [alertFixture] };
    const blocks = searchAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('I-90 Lane Closure');
    expect(text).toContain('101');
    expect(text).toContain('Closure');
    expect(text).toContain('Northwest');
    expect(text).toContain('I-90');
  });

  it('formats empty alerts list', () => {
    const blocks = searchAlerts.format!({ alerts: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active alerts');
  });

  it('renders a normalized description with its inlined link destination', () => {
    // The service hands format() plain text, so the markdown surface carries the same string
    // structuredContent does — including the URL the anchor used to hide.
    const normalized = {
      alertId: 705368,
      headlineDescription: 'Ramp closed near Tacoma.',
      extendedDescription: 'Read the travel advisory (https://content.govdelivery.com/x/420b6e6).',
      impactedRouteIds: [],
    };
    const text = (searchAlerts.format!({ alerts: [normalized] })[0] as { text: string }).text;
    expect(text).toContain('https://content.govdelivery.com/x/420b6e6');
    expect(text).not.toContain('<a');
  });

  it('keeps the alert ID on the heading when a headline runs to several lines', () => {
    // A normalized headline can carry paragraph breaks; putting the whole thing in the `###`
    // heading buried the ID at the end of the last paragraph.
    const multiline = {
      alertId: 706220,
      headlineDescription: 'Overnight lane closures on I-5.\nSpeed limit reduced to 55 mph.',
    };
    const text = (searchAlerts.format!({ alerts: [multiline] })[0] as { text: string }).text;
    expect(text).toContain('### Overnight lane closures on I-5. #706220');
    expect(text).toContain('Speed limit reduced to 55 mph.');
  });
});

describe('searchAlerts — page windows are reproducible across upstream row orders', () => {
  /**
   * The alerts endpoint serves the same alert set in more than one row order, so two fetches of
   * one page can differ unless the handler imposes an order. Same alerts, shuffled arrival order.
   */
  const alerts = Array.from({ length: 12 }, (_, i) => ({
    alertId: 700_100 + i,
    headlineDescription: `Alert ${pad(i)}`,
  }));

  it('orders by alertId so the same offset selects the same alerts', async () => {
    const pageOf = async (rows: typeof alerts) => {
      mockService.searchAlerts.mockResolvedValue(rows);
      const result = await searchAlerts.handler(
        searchAlerts.input.parse({ offset: 4, limit: 4 }),
        createMockContext(),
      );
      return result.alerts.map((a) => a.alertId);
    };
    const inOrder = await pageOf([...alerts]);
    const shuffled = await pageOf([...alerts].reverse());
    expect(inOrder).toEqual([700_104, 700_105, 700_106, 700_107]);
    expect(shuffled).toEqual(inOrder);
  });

  it('sorts an alert carrying no alertId to the end rather than dropping it', async () => {
    mockService.searchAlerts.mockResolvedValue([
      { headlineDescription: 'No ID' },
      ...alerts.slice(0, 2),
    ]);
    const result = await searchAlerts.handler(searchAlerts.input.parse({}), createMockContext());
    expect(result.alerts.map((a) => a.alertId)).toEqual([700_100, 700_101, undefined]);
  });

  /**
   * A comparator that returns 0 leaves the tied rows in arrival order, so an order decisive on
   * distinct ids but tied elsewhere still hands a page boundary inside a tie group the same
   * skip-and-repeat the ordering exists to prevent. Both ways a tie arises — a repeated alertId
   * and a missing one — resolve from the row's own content instead.
   */
  describe.each([
    {
      case: 'alerts sharing one alertId',
      tied: (label: string) => ({ alertId: 700_500, headlineDescription: label }),
    },
    {
      case: 'alerts carrying no alertId',
      tied: (label: string) => ({ headlineDescription: label }),
    },
  ])('ties resolve from row content — $case', ({ tied }) => {
    /** One tie group wide enough that whole pages land inside it. */
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((l) => `Tied ${l}`);
    const rows = [
      { alertId: 700_001, headlineDescription: 'Before' },
      ...labels.map((label) => tied(label)),
    ];

    const pageOf = async (arrival: typeof rows, offset: number, limit: number) => {
      mockService.searchAlerts.mockResolvedValue(arrival);
      const result = await searchAlerts.handler(
        searchAlerts.input.parse({ offset, limit }),
        createMockContext(),
      );
      return result.alerts.map((a) => a.headlineDescription);
    };

    it('selects the same page from either arrival order', async () => {
      const forward = await pageOf([...rows], 2, 2);
      const reversed = await pageOf([...rows].reverse(), 2, 2);
      expect(forward).toHaveLength(2);
      expect(reversed).toEqual(forward);
    });

    it('walks every alert exactly once when arrival order flips mid-walk', async () => {
      const seen: (string | undefined)[] = [];
      for (let offset = 0; offset < rows.length; offset += 3) {
        // A fresh upstream fetch backs every page, and consecutive fetches disagree on order.
        const arrival = offset % 6 === 0 ? [...rows] : [...rows].reverse();
        seen.push(...(await pageOf(arrival, offset, 3)));
      }
      expect([...seen].sort()).toEqual(['Before', ...labels]);
    });
  });
});

describePaginationContract({
  tool: searchAlerts,
  createContext: () => createMockContext(),
  stubRows: (rows) => mockService.searchAlerts.mockResolvedValue(rows),
  makeRows: (count) =>
    Array.from({ length: count }, (_, i) => ({
      alertId: i,
      headlineDescription: `Alert ${pad(i)}`,
      eventCategory: 'Incident',
    })),
  pageMarkers: (result) => result.alerts.map((a) => a.alertId as number),
  markerText: (i) => `Alert ${pad(i)}`,
  fixtureSize: 120,
  defaultLimit: 50,
  maxLimit: 500,
  unit: 'alerts',
});

// ---------------------------------------------------------------------------
// getTravelTimes
// ---------------------------------------------------------------------------

describe('getTravelTimes', () => {
  const corridorFixture = {
    travelTimeId: 1,
    name: 'I-5 NB: Northgate to Downtown',
    description: 'I-5 northbound',
    currentTimeInMinutes: 18,
    averageTimeInMinutes: 12,
    timeUpdated: '2023-11-14T22:13:20.000Z',
    distanceInMiles: 6.2,
    startPoint: { roadName: 'I-5', direction: 'N', milePost: 168 },
    endPoint: { roadName: 'I-5', direction: 'N', milePost: 174 },
  };

  it('returns all corridors when no route filter provided', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toHaveLength(1);
  });

  it('enriches with totalCount and no routeFilter when no filter', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({});
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.routeFilter).toBeUndefined();
  });

  it('enriches routeFilter when filter is provided', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: 'I-5' });
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.routeFilter).toBe('i-5');
  });

  it('enriches notice when no corridors matched', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: 'SR 999' });
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('filters corridors by route name', async () => {
    const sr520 = { ...corridorFixture, name: 'SR 520 EB: 148th to I-5', travelTimeId: 2 };
    mockService.getTravelTimes.mockResolvedValue([corridorFixture, sr520]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: 'SR 520' });
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toHaveLength(1);
    expect(result.corridors[0].name).toContain('SR 520');
  });

  it('filter is case-insensitive', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: 'i-5' });
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toHaveLength(1);
  });

  it('matches the route against corridor start/end road names, not just the corridor name', async () => {
    // Most corridor names are endpoint pairs with no route in them; the route lives on the points.
    const endpointNamed = {
      travelTimeId: 10,
      name: 'Seattle-Everett',
      startPoint: { roadName: '005', direction: 'N', milePost: 165 },
      endPoint: { roadName: '005', direction: 'N', milePost: 192 },
    };
    const offRoute = {
      travelTimeId: 11,
      name: 'Bellevue-Issaquah',
      startPoint: { roadName: 'I-90', direction: 'E', milePost: 10 },
      endPoint: { roadName: 'I-90', direction: 'E', milePost: 17 },
    };
    mockService.getTravelTimes.mockResolvedValue([endpointNamed, offRoute]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(getTravelTimes.input.parse({ route: 'I-5' }), ctx);
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([10]);
  });

  it("matches a prefixed route filter across the feed's mixed bare and prefixed road names", async () => {
    // The upstream reports both "405" and "I-405" for corridors on the same route.
    const bare = { travelTimeId: 20, name: 'Bellevue-Renton', startPoint: { roadName: '405' } };
    const prefixed = {
      travelTimeId: 21,
      name: 'Renton-Tukwila',
      startPoint: { roadName: 'I-405' },
    };
    const other = { travelTimeId: 22, name: 'Tacoma-Federal Way', startPoint: { roadName: '005' } };
    mockService.getTravelTimes.mockResolvedValue([bare, prefixed, other]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(
      getTravelTimes.input.parse({ route: 'I-405' }),
      ctx,
    );
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([20, 21]);
  });

  it('returns corridors for "SR 520", the form the description advertises', async () => {
    const sr520 = { travelTimeId: 30, name: 'Redmond-Seattle', endPoint: { roadName: '520' } };
    const notOnRoute = { travelTimeId: 31, name: 'Everett-Seattle', endPoint: { roadName: '005' } };
    mockService.getTravelTimes.mockResolvedValue([sr520, notOnRoute]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(
      getTravelTimes.input.parse({ route: 'SR 520' }),
      ctx,
    );
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([30]);
  });

  it('keeps free-text corridor-name matching alongside route matching', async () => {
    const everett = { travelTimeId: 40, name: 'Seattle-Everett', startPoint: { roadName: '005' } };
    const tacoma = { travelTimeId: 41, name: 'Seattle-Tacoma', startPoint: { roadName: '005' } };
    mockService.getTravelTimes.mockResolvedValue([everett, tacoma]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(
      getTravelTimes.input.parse({ route: 'Everett' }),
      ctx,
    );
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([40]);
  });

  it('calculates delayInMinutes as current minus average', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors[0].delayInMinutes).toBe(6); // 18 - 12
  });

  it('omits delayInMinutes when currentTime or averageTime is missing', async () => {
    mockService.getTravelTimes.mockResolvedValue([{ travelTimeId: 3, name: 'I-405 SB' }]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors[0].delayInMinutes).toBeUndefined();
  });

  it('reports no delay and no zero-minute trip for an unmeasured corridor', async () => {
    // The service drops WSDOT's 0 sentinel, so the corridor arrives with no times at all.
    const unmeasured = {
      travelTimeId: 4,
      name: 'Everett-Seattle EL',
      distanceInMiles: 26.72,
      startPoint: { roadName: '005', direction: 'S', milePost: 192 },
    };
    mockService.getTravelTimes.mockResolvedValue([unmeasured]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(getTravelTimes.input.parse({}), ctx);
    const corridor = result.corridors[0];
    expect(corridor.currentTimeInMinutes).toBeUndefined();
    expect(corridor.delayInMinutes).toBeUndefined();

    const text = (getTravelTimes.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Everett-Seattle EL');
    expect(text).toContain('**Current:** Not available');
    expect(text).not.toContain('0 min');
    expect(text).toContain('26.72 mi');
  });

  it('formats corridors with key fields', () => {
    const output = {
      corridors: [{ ...corridorFixture, delayInMinutes: 6 }],
    };
    const blocks = getTravelTimes.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('I-5 NB: Northgate to Downtown');
    expect(text).toContain('18 min');
    expect(text).toContain('12 min');
    expect(text).toContain('+6 min');
    expect(text).toContain('congested');
    expect(text).toContain('6.2 mi');
  });

  it('formats empty corridors list', () => {
    const blocks = getTravelTimes.format!({ corridors: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No corridors matched');
  });
});

describePaginationContract({
  tool: getTravelTimes,
  createContext: () => createMockContext(),
  stubRows: (rows) => mockService.getTravelTimes.mockResolvedValue(rows),
  makeRows: (count) =>
    Array.from({ length: count }, (_, i) => ({
      travelTimeId: i,
      name: `Corridor ${pad(i)}`,
      currentTimeInMinutes: 20,
      averageTimeInMinutes: 15,
      startPoint: { roadName: '005', direction: 'N', milePost: i },
    })),
  pageMarkers: (result) => result.corridors.map((c) => c.travelTimeId as number),
  markerText: (i) => `Corridor ${pad(i)}`,
  fixtureSize: 120,
  defaultLimit: 50,
  maxLimit: 500,
  unit: 'corridors',
});

/** The route filter runs in the handler, so paging must slice what the filter produced. */
describe('getTravelTimes — paging applies after the route filter', () => {
  it('pages the filtered corridors, not the unfiltered feed', async () => {
    const onRoute = Array.from({ length: 60 }, (_, i) => ({
      travelTimeId: i,
      name: `On-route ${pad(i)}`,
      startPoint: { roadName: '005' },
    }));
    const offRoute = Array.from({ length: 40 }, (_, i) => ({
      travelTimeId: 900 + i,
      name: `Off-route ${pad(i)}`,
      startPoint: { roadName: 'I-90' },
    }));
    mockService.getTravelTimes.mockResolvedValue([...offRoute, ...onRoute]);
    const ctx = createMockContext();
    const result = await getTravelTimes.handler(
      getTravelTimes.input.parse({ route: 'I-5', offset: 10, limit: 5 }),
      ctx,
    );
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([10, 11, 12, 13, 14]);
    const enrichment = getEnrichment(ctx);
    // 60 matches, not the 100 the feed carries — totalCount counts the filtered set.
    expect(enrichment.totalCount).toBe(60);
    expect(enrichment.nextOffset).toBe(15);
    expect(enrichment.routeFilter).toBe('i-5');
  });
});

// ---------------------------------------------------------------------------
// getTollRates
// ---------------------------------------------------------------------------

describe('getTollRates', () => {
  const rateFixture = {
    tripName: '099tp03060',
    stateRoute: '099',
    travelDirection: 'S',
    startMilepost: 33.0,
    endMilepost: 30.0,
    tollRateInDollars: 1.25,
    message: undefined,
    startLocationName: 'SB S Portal',
    endLocationName: 'NB S Portal',
    startLatitude: 47.626665944,
    startLongitude: -122.343652437,
    endLatitude: 47.587648851,
    endLongitude: -122.338771924,
    timeUpdated: '2023-11-14T22:13:20.000Z',
  };

  it('returns all toll rates', async () => {
    mockService.getTollRates.mockResolvedValue([rateFixture]);
    const ctx = createMockContext();
    const input = getTollRates.input.parse({});
    const result = await getTollRates.handler(input, ctx);
    expect(result.rates).toHaveLength(1);
    expect(result.rates[0].tollRateInDollars).toBe(1.25);
  });

  it('enriches with totalCount', async () => {
    mockService.getTollRates.mockResolvedValue([rateFixture]);
    const ctx = createMockContext();
    const input = getTollRates.input.parse({});
    await getTollRates.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.hasMore).toBe(false);
    expect(enrichment.nextOffset).toBeNull();
    expect(enrichment.notice).toBe('Showing toll rates 1–1 of 1.');
  });

  it('enriches notice when no rates returned', async () => {
    mockService.getTollRates.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTollRates.input.parse({});
    await getTollRates.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty rates list', async () => {
    mockService.getTollRates.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTollRates.input.parse({});
    const result = await getTollRates.handler(input, ctx);
    expect(result.rates).toHaveLength(0);
  });

  it('formats rates with key fields', () => {
    const output = { rates: [rateFixture] };
    const blocks = getTollRates.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('099tp03060');
    expect(text).toContain('SR 099');
    expect(text).toContain('$1.25');
    expect(text).toContain('SB S Portal');
    expect(text).toContain('NB S Portal');
    expect(text).toContain('Direction');
    expect(text).toContain('S'); // travelDirection
  });

  it('formats empty rates list', () => {
    const blocks = getTollRates.format!({ rates: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No toll rate data');
  });
});

describePaginationContract({
  tool: getTollRates,
  createContext: () => createMockContext(),
  stubRows: (rows) => mockService.getTollRates.mockResolvedValue(rows),
  makeRows: (count) =>
    Array.from({ length: count }, (_, i) => ({
      tripName: `Trip ${pad(i)}`,
      stateRoute: '520',
      startMilepost: i,
      tollRateInDollars: 1.25,
    })),
  pageMarkers: (result) => result.rates.map((r) => r.startMilepost as number),
  markerText: (i) => `Trip ${pad(i)}`,
  fixtureSize: 120,
  defaultLimit: 50,
  maxLimit: 500,
  unit: 'toll rate',
});

// ---------------------------------------------------------------------------
// getBorderWaits
// ---------------------------------------------------------------------------

describe('getBorderWaits', () => {
  const crossingFixture = {
    crossingName: 'I5',
    waitTimeInMinutes: 25,
    updateTime: '2023-11-14T22:13:20.000Z',
    location: {
      description: 'I-5 General Purpose',
      roadName: '005',
      direction: 'N',
      milePost: 0,
      latitude: 49.002,
      longitude: -122.755,
    },
  };

  it('returns all border crossings', async () => {
    mockService.getBorderCrossings.mockResolvedValue([crossingFixture]);
    const ctx = createMockContext();
    const input = getBorderWaits.input.parse({});
    const result = await getBorderWaits.handler(input, ctx);
    expect(result.crossings).toHaveLength(1);
    expect(result.crossings[0].crossingName).toBe('I5');
    expect(result.crossings[0].waitTimeInMinutes).toBe(25);
  });

  it('enriches with totalCount', async () => {
    mockService.getBorderCrossings.mockResolvedValue([crossingFixture]);
    const ctx = createMockContext();
    const input = getBorderWaits.input.parse({});
    await getBorderWaits.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no crossings returned', async () => {
    mockService.getBorderCrossings.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getBorderWaits.input.parse({});
    await getBorderWaits.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty crossings list', async () => {
    mockService.getBorderCrossings.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getBorderWaits.input.parse({});
    const result = await getBorderWaits.handler(input, ctx);
    expect(result.crossings).toHaveLength(0);
  });

  it('formats crossings with key fields', () => {
    const output = { crossings: [crossingFixture] };
    const blocks = getBorderWaits.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('I-5 General Purpose'); // readable heading (location.description)
    expect(text).toContain('I5'); // crossing code line
    expect(text).toContain('25 min');
    expect(text).toContain('005'); // roadName
    expect(text).toContain('49.002');
    expect(text).toContain('-122.755');
  });

  it('shows "Not available" when wait time is missing', () => {
    const sparseOutput = {
      crossings: [{ crossingName: 'Sumas' }],
    };
    const blocks = getBorderWaits.format!(sparseOutput);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Not available');
  });

  it('formats empty crossings list', () => {
    const blocks = getBorderWaits.format!({ crossings: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No border crossing data');
  });
});

// ---------------------------------------------------------------------------
// searchCameras
// ---------------------------------------------------------------------------

describe('searchCameras', () => {
  const cameraFixture = {
    cameraId: 1001,
    title: 'I-90 at Snoqualmie Pass',
    description: 'Summit viewpoint',
    imageUrl: 'https://images.wsdot.wa.gov/nc/090vc12345.jpg',
    imageWidth: 320,
    imageHeight: 240,
    roadName: 'I-90',
    direction: 'EB',
    milePost: 52,
    region: 'NW',
    latitude: 47.4,
    longitude: -121.4,
  };

  it('returns cameras matching filter', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ stateRoute: '090' });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(1);
    expect(result.cameras[0].cameraId).toBe(1001);
    expect(mockService.searchCameras).toHaveBeenCalledWith(
      expect.objectContaining({ stateRoute: '090' }),
      ctx,
    );
  });

  it('enriches with totalCount and stateRoute filter', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ stateRoute: '090' });
    await searchCameras.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.appliedFilters.stateRoute).toBe('090');
  });

  it('enriches notice with copyright when results fit inline', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({});
    await searchCameras.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('copyright');
  });

  it('pages results and reports continuation metadata when the total exceeds the page limit', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ limit: 10 });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(10);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(25); // full match count, not the page size
    expect(enrichment.hasMore).toBe(true);
    expect(enrichment.nextOffset).toBe(10);
    expect(enrichment.notice).toContain('offset=10');
  });

  it('returns all cameras when no filter provided', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({});
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(1);
  });

  it('formats cameras with key fields', () => {
    const output = {
      cameras: [cameraFixture],
    };
    const blocks = searchCameras.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('I-90 at Snoqualmie Pass');
    expect(text).toContain('images.wsdot.wa.gov');
    expect(text).toContain('1001');
    expect(text).toContain('NW');
    expect(text).toContain('320×240px');
    // location fields now present
    expect(text).toContain('I-90');
    expect(text).toContain('MP 52');
  });

  it('formats empty cameras list with a no-match summary', () => {
    const output = { cameras: [] };
    const blocks = searchCameras.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No cameras found');
  });

  it('applies the default page limit on a no-arg call', async () => {
    const manyCameras = Array.from({ length: 80 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({});
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(50); // DEFAULT_LIMIT
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(80);
    expect(enrichment.hasMore).toBe(true);
    expect(enrichment.nextOffset).toBe(50);
  });

  it('returns the requested page via offset/limit and keeps totalCount at the full count', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ offset: 10, limit: 5 });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras.map((c) => c.cameraId)).toEqual([10, 11, 12, 13, 14]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(25);
    expect(enrichment.nextOffset).toBe(15);
    expect(enrichment.hasMore).toBe(true);
  });

  it('reports hasMore false and null nextOffset on the final page', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ offset: 20, limit: 10 });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(5); // records 20..24
    const enrichment = getEnrichment(ctx);
    expect(enrichment.hasMore).toBe(false);
    expect(enrichment.nextOffset).toBeNull();
  });

  it('renders exactly the structuredContent page in content[] (parity)', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({
      ...cameraFixture,
      cameraId: i,
      title: `Cam ${i}`,
    }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ offset: 5, limit: 3 });
    const result = await searchCameras.handler(input, ctx);
    const text = (searchCameras.format!(result)[0] as { text: string }).text;
    // content[] carries the identical page as structuredContent — the 3 sliced records, no more.
    expect(result.cameras.map((c) => c.cameraId)).toEqual([5, 6, 7]);
    for (const c of result.cameras) expect(text).toContain(`Cam ${c.cameraId}`);
    expect(text).not.toContain('Cam 0');
    expect(text).not.toContain('Cam 24');
    expect(text.match(/^### /gm)?.length).toBe(3);
  });

  it('rejects a limit above the maximum and a negative offset', () => {
    expect(() => searchCameras.input.parse({ limit: 501 })).toThrow();
    expect(() => searchCameras.input.parse({ offset: -1 })).toThrow();
  });

  it('strips whitespace-only stateRoute filter', async () => {
    mockService.searchCameras.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ stateRoute: '  ' });
    await searchCameras.handler(input, ctx);
    expect(mockService.searchCameras).toHaveBeenCalledWith(
      expect.not.objectContaining({ stateRoute: expect.anything() }),
      ctx,
    );
  });
});

describe('searchCameras — page windows are reproducible across upstream row orders', () => {
  /**
   * The camera feed serves one 1,700-row set in more than one order, and a full walk needs four
   * fetches even at the maximum page size, so an unordered page window straddles the reorder.
   */
  const cameras = Array.from({ length: 12 }, (_, i) => ({
    cameraId: 5000 + i,
    title: `Cam ${pad(i)}`,
  }));

  const pageOf = async (arrival: typeof cameras, offset: number, limit: number) => {
    mockService.searchCameras.mockResolvedValue(arrival);
    const result = await searchCameras.handler(
      searchCameras.input.parse({ offset, limit }),
      createMockContext(),
    );
    return result.cameras.map((c) => c.cameraId);
  };

  it('orders by cameraId so the same offset selects the same cameras', async () => {
    const forward = await pageOf([...cameras], 4, 4);
    const reversed = await pageOf([...cameras].reverse(), 4, 4);
    expect(forward).toEqual([5004, 5005, 5006, 5007]);
    expect(reversed).toEqual(forward);
  });

  it('walks every camera exactly once when arrival order flips mid-walk', async () => {
    const seen: (number | undefined)[] = [];
    for (let offset = 0; offset < cameras.length; offset += 4) {
      const arrival = offset % 8 === 0 ? [...cameras] : [...cameras].reverse();
      seen.push(...(await pageOf(arrival, offset, 4)));
    }
    expect(seen).toEqual(cameras.map((c) => c.cameraId));
  });

  it('sorts a camera carrying no cameraId to the end rather than dropping it', async () => {
    mockService.searchCameras.mockResolvedValue([{ title: 'No ID' }, ...cameras.slice(0, 2)]);
    const result = await searchCameras.handler(searchCameras.input.parse({}), createMockContext());
    expect(result.cameras.map((c) => c.cameraId)).toEqual([5000, 5001, undefined]);
  });

  it('resolves cameras tied on cameraId from row content, not arrival position', async () => {
    const tied = ['A', 'B', 'C', 'D'].map((t) => ({ cameraId: 5100, title: `Tied ${t}` }));
    const rows = [{ cameraId: 5001, title: 'Before' }, ...tied];
    const titlesAt = async (arrival: typeof rows) => {
      mockService.searchCameras.mockResolvedValue(arrival);
      const result = await searchCameras.handler(
        searchCameras.input.parse({ offset: 2, limit: 2 }),
        createMockContext(),
      );
      return result.cameras.map((c) => c.title);
    };
    const forward = await titlesAt([...rows]);
    expect(forward).toHaveLength(2);
    expect(await titlesAt([...rows].reverse())).toEqual(forward);
  });
});
