/**
 * @fileoverview Tests for WSDOT traffic tools: mountain passes, alerts, travel times,
 * toll rates, border waits, and cameras.
 * @module tests/tools/traffic-tools.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  type ErrorContract,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
import { formattedText, nth, rejection } from '../helpers/assertions.js';
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
      const byReason = new Map<string, ErrorContract>(t.errors!.map((e) => [e.reason, e]));
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
    const err = await rejection(() =>
      getMountainPasses.handler(getMountainPasses.input.parse({}), ctx),
    );
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
    const err = await rejection(() =>
      getMountainPasses.handler(getMountainPasses.input.parse({}), ctx),
    );
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
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const input = getMountainPasses.input.parse({});
    const result = await getMountainPasses.handler(input, ctx);
    expect(result.passes).toHaveLength(1);
    expect(nth(result.passes).mountainPassId).toBe(1);
    expect(nth(result.passes).mountainPassName).toBe('Snoqualmie Pass');
  });

  it('enriches with totalCount', async () => {
    mockService.getMountainPasses.mockResolvedValue([passFixture]);
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const input = getMountainPasses.input.parse({});
    await getMountainPasses.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no passes returned', async () => {
    mockService.getMountainPasses.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getMountainPasses.errors });
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
    expect(nth(blocks).type).toBe('text');
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
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({});
    const result = await searchAlerts.handler(input, ctx);
    expect(result.alerts).toHaveLength(1);
    expect(nth(result.alerts).alertId).toBe(101);
  });

  it('enriches with totalCount and empty appliedFilters', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
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
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedFilters).toEqual({ stateRoute: '090' });
  });

  it('enriches notice on empty results with filters', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('filter');
  });

  it('enriches notice on empty results with no filters', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({});
    await searchAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No active');
  });

  it('passes stateRoute filter to service', async () => {
    mockService.searchAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({ stateRoute: '090' });
    await searchAlerts.handler(input, ctx);
    expect(mockService.searchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ stateRoute: '090' }),
      ctx,
    );
  });

  it('passes region filter to service', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
    const input = searchAlerts.input.parse({ region: 'Northwest' });
    await searchAlerts.handler(input, ctx);
    expect(mockService.searchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'Northwest' }),
      ctx,
    );
  });

  it('strips whitespace-only stateRoute filter', async () => {
    mockService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchAlerts.errors });
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
        createMockContext({ errors: searchAlerts.errors }),
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
    const result = await searchAlerts.handler(
      searchAlerts.input.parse({}),
      createMockContext({ errors: searchAlerts.errors }),
    );
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
        createMockContext({ errors: searchAlerts.errors }),
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
  createContext: () => createMockContext({ errors: searchAlerts.errors }),
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
  defaultLimit: 20,
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toHaveLength(1);
  });

  it('enriches with totalCount and no routeFilter when no filter', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({});
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.routeFilter).toBeUndefined();
  });

  it('enriches routeFilter when filter is provided', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({ route: 'I-5' });
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.routeFilter).toBe('i-5');
  });

  it('enriches notice when no corridors matched', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({ route: 'SR 999' });
    await getTravelTimes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('filters corridors by route name', async () => {
    const sr520 = { ...corridorFixture, name: 'SR 520 EB: 148th to I-5', travelTimeId: 2 };
    mockService.getTravelTimes.mockResolvedValue([corridorFixture, sr520]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({ route: 'SR 520' });
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toHaveLength(1);
    expect(nth(result.corridors).name).toContain('SR 520');
  });

  it('filter is case-insensitive', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const result = await getTravelTimes.handler(
      getTravelTimes.input.parse({ route: 'Everett' }),
      ctx,
    );
    expect(result.corridors.map((c) => c.travelTimeId)).toEqual([40]);
  });

  it('calculates delayInMinutes as current minus average', async () => {
    mockService.getTravelTimes.mockResolvedValue([corridorFixture]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(nth(result.corridors).delayInMinutes).toBe(6); // 18 - 12
  });

  it('omits delayInMinutes when currentTime or averageTime is missing', async () => {
    mockService.getTravelTimes.mockResolvedValue([{ travelTimeId: 3, name: 'I-405 SB' }]);
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    expect(nth(result.corridors).delayInMinutes).toBeUndefined();
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
    const result = await getTravelTimes.handler(getTravelTimes.input.parse({}), ctx);
    const corridor = nth(result.corridors);
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
  createContext: () => createMockContext({ errors: getTravelTimes.errors }),
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
    const ctx = createMockContext({ errors: getTravelTimes.errors });
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
    const ctx = createMockContext({ errors: getTollRates.errors });
    const input = getTollRates.input.parse({});
    const result = await getTollRates.handler(input, ctx);
    expect(result.rates).toHaveLength(1);
    expect(nth(result.rates).tollRateInDollars).toBe(1.25);
  });

  it('enriches with totalCount', async () => {
    mockService.getTollRates.mockResolvedValue([rateFixture]);
    const ctx = createMockContext({ errors: getTollRates.errors });
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
    const ctx = createMockContext({ errors: getTollRates.errors });
    const input = getTollRates.input.parse({});
    await getTollRates.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty rates list', async () => {
    mockService.getTollRates.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getTollRates.errors });
    const input = getTollRates.input.parse({});
    const result = await getTollRates.handler(input, ctx);
    expect(result.rates).toHaveLength(0);
  });

  it('formats rates with key fields', () => {
    const output = { rates: [rateFixture] };
    const blocks = getTollRates.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('099tp03060');
    expect(text).toContain('SR 99');
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
  createContext: () => createMockContext({ errors: getTollRates.errors }),
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
    const ctx = createMockContext({ errors: getBorderWaits.errors });
    const input = getBorderWaits.input.parse({});
    const result = await getBorderWaits.handler(input, ctx);
    expect(result.crossings).toHaveLength(1);
    expect(nth(result.crossings).crossingName).toBe('I5');
    expect(nth(result.crossings).waitTimeInMinutes).toBe(25);
  });

  it('enriches with totalCount', async () => {
    mockService.getBorderCrossings.mockResolvedValue([crossingFixture]);
    const ctx = createMockContext({ errors: getBorderWaits.errors });
    const input = getBorderWaits.input.parse({});
    await getBorderWaits.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no crossings returned', async () => {
    mockService.getBorderCrossings.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getBorderWaits.errors });
    const input = getBorderWaits.input.parse({});
    await getBorderWaits.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty crossings list', async () => {
    mockService.getBorderCrossings.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getBorderWaits.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
    const input = searchCameras.input.parse({ stateRoute: '090' });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toHaveLength(1);
    expect(nth(result.cameras).cameraId).toBe(1001);
    expect(mockService.searchCameras).toHaveBeenCalledWith(
      expect.objectContaining({ stateRoute: '090' }),
      ctx,
    );
  });

  it('enriches with totalCount and stateRoute filter', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext({ errors: searchCameras.errors });
    const input = searchCameras.input.parse({ stateRoute: '090' });
    await searchCameras.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.appliedFilters).toEqual({ stateRoute: '090' });
  });

  it('enriches notice with copyright when results fit inline', async () => {
    mockService.searchCameras.mockResolvedValue([cameraFixture]);
    const ctx = createMockContext({ errors: searchCameras.errors });
    const input = searchCameras.input.parse({});
    await searchCameras.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('copyright');
  });

  it('pages results and reports continuation metadata when the total exceeds the page limit', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext({ errors: searchCameras.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
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
    const ctx = createMockContext({ errors: searchCameras.errors });
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

  it('returns an empty page with actionable guidance when the offset is past the end', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext({ errors: searchCameras.errors });
    const result = await searchCameras.handler(searchCameras.input.parse({ offset: 40 }), ctx);
    expect(result.cameras).toEqual([]);
    const enrichment = getEnrichment(ctx);
    // totalCount stays the full match count so the agent can compute a reachable offset.
    expect(enrichment.totalCount).toBe(25);
    expect(enrichment.hasMore).toBe(false);
    expect(enrichment.nextOffset).toBeNull();
    expect(enrichment.notice).toContain('Offset 40 is past the end of 25 matching cameras');
    expect(enrichment.notice).toContain('between 0 and 24');
    expect(formattedText(searchCameras.format!(result))).toContain('No cameras found');
  });

  it('rejects a limit above the maximum and a negative offset', () => {
    expect(() => searchCameras.input.parse({ limit: 501 })).toThrow();
    expect(() => searchCameras.input.parse({ offset: -1 })).toThrow();
  });

  it('strips whitespace-only stateRoute filter', async () => {
    mockService.searchCameras.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchCameras.errors });
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
   * The camera feed serves one 1,700-row set in more than one order, and the response budget
   * holds a page to under a hundred cameras, so a full walk takes about twenty fetches and an
   * unordered page window straddles the reorder.
   */
  const cameras = Array.from({ length: 12 }, (_, i) => ({
    cameraId: 5000 + i,
    title: `Cam ${pad(i)}`,
  }));

  const pageOf = async (arrival: typeof cameras, offset: number, limit: number) => {
    mockService.searchCameras.mockResolvedValue(arrival);
    const result = await searchCameras.handler(
      searchCameras.input.parse({ offset, limit }),
      createMockContext({ errors: searchCameras.errors }),
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
    const result = await searchCameras.handler(
      searchCameras.input.parse({}),
      createMockContext({ errors: searchCameras.errors }),
    );
    expect(result.cameras.map((c) => c.cameraId)).toEqual([5000, 5001, undefined]);
  });

  it('resolves cameras tied on cameraId from row content, not arrival position', async () => {
    const tied = ['A', 'B', 'C', 'D'].map((t) => ({ cameraId: 5100, title: `Tied ${t}` }));
    const rows = [{ cameraId: 5001, title: 'Before' }, ...tied];
    const titlesAt = async (arrival: typeof rows) => {
      mockService.searchCameras.mockResolvedValue(arrival);
      const result = await searchCameras.handler(
        searchCameras.input.parse({ offset: 2, limit: 2 }),
        createMockContext({ errors: searchCameras.errors }),
      );
      return result.cameras.map((c) => c.title);
    };
    const forward = await titlesAt([...rows]);
    expect(forward).toHaveLength(2);
    expect(await titlesAt([...rows].reverse())).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------
// format() parity — sparse, false, and empty shapes
//
// A field carried by structuredContent needs a representation in content[] whatever its value.
// Coordinates, image dimensions, and roadway detail are each independently optional upstream, so
// a guard requiring the whole group drops the members that did arrive.
// ---------------------------------------------------------------------------

describe('traffic format() parity — one-sided and partial values', () => {
  const render = formattedText;

  describe('getBorderWaits', () => {
    it('keeps a populated latitude when the longitude is absent', () => {
      const text = render(
        getBorderWaits.format!({
          crossings: [{ crossingName: 'I5', location: { description: 'I-5', latitude: 49.002 } }],
        }),
      );
      expect(text).toContain('**Coords:** 49.002, longitude not reported');
    });

    it('keeps a populated longitude when the latitude is absent', () => {
      const text = render(
        getBorderWaits.format!({
          crossings: [
            { crossingName: 'I5', location: { description: 'I-5', longitude: -122.755 } },
          ],
        }),
      );
      expect(text).toContain('**Coords:** latitude not reported, -122.755');
    });

    it('names the four routes and every lane class the feed returns', () => {
      // The feed returns eleven lanes: I5 and I5Nexus; SR539, SR539Nexus, SR539Trucks; SR543,
      // SR543Nexus, SR543Trucks, SR543TrucksFast; SR9 and SR9Nexus. Pacific Highway is SR 543,
      // not I-5, and the truck lanes are not exclusive to it.
      const description = getBorderWaits.description ?? '';
      for (const route of ['I-5', 'SR 543', 'SR 539', 'SR 9', 'Pacific Highway']) {
        expect(description).toContain(route);
      }
      expect(description).toMatch(/SR 539 adds a truck lane/);
      expect(description).toMatch(/SR 543 adds truck and FAST truck lanes/);
      expect(description).toContain('eleven entries in crossings[], one per lane');
      expect(description).not.toMatch(/no current data is omitted/);
    });
  });

  describe('getMountainPasses', () => {
    it('keeps a populated latitude when the longitude is absent', () => {
      const text = render(
        getMountainPasses.format!({
          passes: [{ mountainPassId: 1, mountainPassName: 'Snoqualmie Pass', latitude: 47.4273 }],
        }),
      );
      expect(text).toContain('**Coords:** 47.4273, longitude not reported');
    });

    it('renders a pass with no ID or name under a generic heading, keeping its other fields', () => {
      const text = render(
        getMountainPasses.format!({
          passes: [{ roadCondition: 'Bare and dry', weatherCondition: 'Clear' }],
        }),
      );
      expect(text).toContain('### Mountain pass\n');
      expect(text).toContain('**Road:** Bare and dry');
      expect(text).toContain('**Weather:** Clear');
      expect(text).not.toContain('**ID:**');
      expect(text).not.toContain('undefined');
    });

    it('headings a pass with an ID but no name by the generic label, keeping the ID line', () => {
      const text = render(getMountainPasses.format!({ passes: [{ mountainPassId: 7 }] }));
      expect(text).toContain('### Mountain pass\n');
      expect(text).toContain('**ID:** 7');
    });
  });

  describe('getTollRates', () => {
    it('renders an Interstate route as I-, not a blanket SR prefix', () => {
      const text = render(getTollRates.format!({ rates: [{ tripName: 't', stateRoute: '405' }] }));
      expect(text).toContain('**Route:** I-405');
      expect(text).not.toContain('SR 405');
    });

    it('strips the upstream zero padding from a state route', () => {
      const text = render(getTollRates.format!({ rates: [{ tripName: 't', stateRoute: '099' }] }));
      expect(text).toContain('**Route:** SR 99');
      expect(text).not.toContain('SR 099');
    });

    it('renders the other tolled facilities with their own designations', () => {
      const text = render(
        getTollRates.format!({
          rates: [
            { tripName: 'a', stateRoute: '167' },
            { tripName: 'b', stateRoute: '509' },
            { tripName: 'c', stateRoute: '520' },
          ],
        }),
      );
      expect(text).toContain('**Route:** SR 167');
      expect(text).toContain('**Route:** SR 509');
      expect(text).toContain('**Route:** SR 520');
    });

    it('leads with the readable segment and keeps the opaque trip key as a field', () => {
      const text = render(
        getTollRates.format!({
          rates: [
            {
              tripName: '099tp03268',
              startLocationName: 'SB S Portal',
              endLocationName: 'NB S Portal',
            },
          ],
        }),
      );
      expect(text).toContain('### SB S Portal → NB S Portal');
      expect(text).not.toContain('### 099tp03268');
      expect(text).toContain('**Trip:** 099tp03268');
    });

    it('collapses a segment whose two ends carry the same name', () => {
      // The SR 509 rows report "SR 509 Toll" on both ends.
      const text = render(
        getTollRates.format!({
          rates: [
            {
              tripName: '509tp02093',
              startLocationName: 'SR 509 Toll',
              endLocationName: 'SR 509 Toll',
            },
          ],
        }),
      );
      expect(text).toContain('### SR 509 Toll\n');
      expect(text).not.toContain('SR 509 Toll → SR 509 Toll');
    });

    it('falls back to the trip key when neither end is named', () => {
      const text = render(getTollRates.format!({ rates: [{ tripName: '167tp02565' }] }));
      expect(text).toContain('### 167tp02565');
    });

    it('keeps one-sided start and end coordinates', () => {
      const text = render(
        getTollRates.format!({
          rates: [{ tripName: 't', startLatitude: 47.6266, endLongitude: -122.3387 }],
        }),
      );
      expect(text).toContain('**Start Coords:** 47.6266, longitude not reported');
      expect(text).toContain('**End Coords:** latitude not reported, -122.3387');
    });

    it('lists the facilities the feed returns and drops the ones it does not', () => {
      expect(getTollRates.description).toContain('SR 509');
      expect(getTollRates.description).not.toContain('I-90');
    });
  });

  describe('searchAlerts', () => {
    it('keeps one-sided start and end coordinates', () => {
      const text = render(
        searchAlerts.format!({
          alerts: [
            {
              alertId: 1,
              headlineDescription: 'Closure',
              startRoadwayLocation: { roadName: 'I-90', latitude: 47.5 },
              endRoadwayLocation: { roadName: 'I-90', longitude: -121.7 },
            },
          ],
        }),
      );
      expect(text).toContain('**Coords:** 47.5, longitude not reported');
      expect(text).toContain('**End Coords:** latitude not reported, -121.7');
    });
  });

  describe('searchCameras', () => {
    it('renders direction and milepost for a camera that reports no road name', () => {
      const text = render(
        searchCameras.format!({
          cameras: [{ cameraId: 1, title: 'Cam', direction: 'EB', milePost: 52 }],
        }),
      );
      expect(text).toContain('**Location:** EB MP 52');
    });

    it('renders a width reported without a height, and the reverse', () => {
      const wide = render(
        searchCameras.format!({ cameras: [{ cameraId: 1, title: 'Cam', imageWidth: 320 }] }),
      );
      expect(wide).toContain('**Size:** 320px wide (height not reported)');

      const tall = render(
        searchCameras.format!({ cameras: [{ cameraId: 2, title: 'Cam', imageHeight: 240 }] }),
      );
      expect(tall).toContain('**Size:** 240px tall (width not reported)');
    });

    it('keeps a populated latitude when the longitude is absent', () => {
      const text = render(
        searchCameras.format!({ cameras: [{ cameraId: 1, title: 'Cam', latitude: 47.4 }] }),
      );
      expect(text).toContain('**Coords:** 47.4, longitude not reported');
    });
  });
});

// ---------------------------------------------------------------------------
// Wire-level filter contract — runToolContract runs the real handler, output parse, enrichment,
// and error envelope, so these assert what a client actually receives.
// ---------------------------------------------------------------------------

/** Rows in the toll feed's own order, one or more per tolled facility. */
const tollFeed = [
  {
    tripName: '099tp03268',
    stateRoute: '099',
    travelDirection: 'S',
    startMilepost: 33,
    endMilepost: 30,
    tollRateInDollars: 1.25,
    startLocationName: 'SB S Portal',
    endLocationName: 'NB S Portal',
  },
  {
    tripName: '099tp03060',
    stateRoute: '099',
    travelDirection: 'S',
    startMilepost: 30,
    endMilepost: 33,
    tollRateInDollars: 1.25,
    startLocationName: 'NB S Portal',
    endLocationName: 'SB S Portal',
  },
  {
    tripName: '405tp01351',
    stateRoute: '405',
    travelDirection: 'N',
    startMilepost: 1.35,
    endMilepost: 3.5,
    tollRateInDollars: 0.75,
    startLocationName: 'SR 167',
    endLocationName: 'NE 4th',
  },
  {
    tripName: '167tp02565',
    stateRoute: '167',
    travelDirection: 'S',
    startMilepost: 25.6,
    endMilepost: 18.4,
    tollRateInDollars: 1,
    startLocationName: 'S 180th',
    endLocationName: 'SR 18',
  },
  {
    tripName: '509tp02093',
    stateRoute: '509',
    travelDirection: 'S',
    startMilepost: 20.92,
    endMilepost: 20.5,
    tollRateInDollars: 1.3,
    startLocationName: 'SR 509 Toll',
    endLocationName: 'SR 509 Toll',
  },
  {
    tripName: '405tp02718',
    stateRoute: '405',
    travelDirection: 'S',
    startMilepost: 27.18,
    endMilepost: 23,
    tollRateInDollars: 2.5,
    startLocationName: 'SR 527',
    endLocationName: 'NE 160th',
  },
  {
    tripName: '520tp00422',
    stateRoute: '520',
    travelDirection: 'E',
    startMilepost: 4.2,
    endMilepost: 1.6,
    tollRateInDollars: 3.4,
    startLocationName: 'WB 78th Ave',
    endLocationName: 'EB 78th Ave',
  },
  {
    tripName: '520tp00421',
    stateRoute: '520',
    travelDirection: 'E',
    startMilepost: 1.6,
    endMilepost: 4.2,
    tollRateInDollars: 3.4,
    startLocationName: 'EB 78th Ave',
    endLocationName: 'WB 78th Ave',
  },
];

/**
 * The I-90 MP 50–55 window as the live camera feed serves it — six cameras, two of them titled
 * for Snoqualmie — plus cameras elsewhere so a filter has something to exclude. Arrival order is
 * deliberately not cameraId order.
 */
const snoqualmieWindow = [
  {
    cameraId: 1100,
    title: 'I-90 at MP 52: Snoqualmie Summit',
    roadName: 'I-90',
    milePost: 52,
    region: 'SC',
  },
  {
    cameraId: 1099,
    title: 'I-90 at MP 51.3: Franklin Falls',
    roadName: 'I-90',
    milePost: 51.3,
    region: 'SC',
  },
  {
    cameraId: 9428,
    title: 'I-90 at MP 53.4: East Snoqualmie Summit',
    roadName: 'I-90',
    milePost: 53.4,
    region: 'SC',
  },
  {
    cameraId: 1102,
    title: 'I-90 at MP 55.1: Hyak',
    roadName: 'I-90',
    milePost: 55.1,
    region: 'SC',
  },
  {
    cameraId: 10296,
    title: 'I-90 at MP 54.5: Hyak Hill',
    roadName: 'I-90',
    milePost: 54.5,
    region: 'SC',
  },
  { cameraId: 10070, title: 'I-90 at MP 55.2: ', roadName: 'I-90', milePost: 55.2, region: 'SC' },
];
const elsewhereCameras = [
  { cameraId: 3059, title: 'I-205 at Stafford Rd.', roadName: 'I-205', milePost: 3, region: 'OS' },
  { cameraId: 9818, title: 'Anacortes Airport Fuel Pump', roadName: 'Airports', region: 'WA' },
  {
    cameraId: 1500,
    title: 'SR 18 at MP 1: Snoqualmie Parkway',
    roadName: 'SR 18',
    milePost: 1,
    region: 'NW',
  },
];

const alertFeed = [
  {
    alertId: 702,
    headlineDescription: 'Right lane closed on I-90 EB',
    region: 'South Central',
    startRoadwayLocation: { roadName: '090', direction: 'E', milePost: 52 },
    endRoadwayLocation: { roadName: '090', direction: 'E', milePost: 54 },
  },
  {
    alertId: 701,
    headlineDescription: 'Collision on I-5 NB',
    region: 'Northwest',
    startRoadwayLocation: { roadName: '005', direction: 'N', milePost: 165 },
  },
];

/** The text of a contract result's single text block. */
function wireText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

describe('unfiltered calls — pinned wire output', () => {
  it('wsdot_get_toll_rates serves every feed row in feed order, rendered unchanged', async () => {
    mockService.getTollRates.mockResolvedValue(tollFeed);
    const result = await runToolContract(getTollRates, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "nextOffset": null,
        "notice": "Showing toll rates 1–8 of 8.",
        "rates": [
          {
            "endLocationName": "NB S Portal",
            "endMilepost": 30,
            "startLocationName": "SB S Portal",
            "startMilepost": 33,
            "stateRoute": "099",
            "tollRateInDollars": 1.25,
            "travelDirection": "S",
            "tripName": "099tp03268",
          },
          {
            "endLocationName": "SB S Portal",
            "endMilepost": 33,
            "startLocationName": "NB S Portal",
            "startMilepost": 30,
            "stateRoute": "099",
            "tollRateInDollars": 1.25,
            "travelDirection": "S",
            "tripName": "099tp03060",
          },
          {
            "endLocationName": "NE 4th",
            "endMilepost": 3.5,
            "startLocationName": "SR 167",
            "startMilepost": 1.35,
            "stateRoute": "405",
            "tollRateInDollars": 0.75,
            "travelDirection": "N",
            "tripName": "405tp01351",
          },
          {
            "endLocationName": "SR 18",
            "endMilepost": 18.4,
            "startLocationName": "S 180th",
            "startMilepost": 25.6,
            "stateRoute": "167",
            "tollRateInDollars": 1,
            "travelDirection": "S",
            "tripName": "167tp02565",
          },
          {
            "endLocationName": "SR 509 Toll",
            "endMilepost": 20.5,
            "startLocationName": "SR 509 Toll",
            "startMilepost": 20.92,
            "stateRoute": "509",
            "tollRateInDollars": 1.3,
            "travelDirection": "S",
            "tripName": "509tp02093",
          },
          {
            "endLocationName": "NE 160th",
            "endMilepost": 23,
            "startLocationName": "SR 527",
            "startMilepost": 27.18,
            "stateRoute": "405",
            "tollRateInDollars": 2.5,
            "travelDirection": "S",
            "tripName": "405tp02718",
          },
          {
            "endLocationName": "EB 78th Ave",
            "endMilepost": 1.6,
            "startLocationName": "WB 78th Ave",
            "startMilepost": 4.2,
            "stateRoute": "520",
            "tollRateInDollars": 3.4,
            "travelDirection": "E",
            "tripName": "520tp00422",
          },
          {
            "endLocationName": "WB 78th Ave",
            "endMilepost": 4.2,
            "startLocationName": "EB 78th Ave",
            "startMilepost": 1.6,
            "stateRoute": "520",
            "tollRateInDollars": 3.4,
            "travelDirection": "E",
            "tripName": "520tp00421",
          },
        ],
        "totalCount": 8,
      }
    `);
    expect(wireText(result)).toMatchInlineSnapshot(`
      "### SB S Portal → NB S Portal
      **Trip:** 099tp03268
      **Route:** SR 99
      **Direction:** S
      **From:** SB S Portal
      **To:** NB S Portal
      **Start MP:** 33
      **End MP:** 30
      **Rate:** $1.25

      ### NB S Portal → SB S Portal
      **Trip:** 099tp03060
      **Route:** SR 99
      **Direction:** S
      **From:** NB S Portal
      **To:** SB S Portal
      **Start MP:** 30
      **End MP:** 33
      **Rate:** $1.25

      ### SR 167 → NE 4th
      **Trip:** 405tp01351
      **Route:** I-405
      **Direction:** N
      **From:** SR 167
      **To:** NE 4th
      **Start MP:** 1.35
      **End MP:** 3.5
      **Rate:** $0.75

      ### S 180th → SR 18
      **Trip:** 167tp02565
      **Route:** SR 167
      **Direction:** S
      **From:** S 180th
      **To:** SR 18
      **Start MP:** 25.6
      **End MP:** 18.4
      **Rate:** $1.00

      ### SR 509 Toll
      **Trip:** 509tp02093
      **Route:** SR 509
      **Direction:** S
      **From:** SR 509 Toll
      **To:** SR 509 Toll
      **Start MP:** 20.92
      **End MP:** 20.5
      **Rate:** $1.30

      ### SR 527 → NE 160th
      **Trip:** 405tp02718
      **Route:** I-405
      **Direction:** S
      **From:** SR 527
      **To:** NE 160th
      **Start MP:** 27.18
      **End MP:** 23
      **Rate:** $2.50

      ### WB 78th Ave → EB 78th Ave
      **Trip:** 520tp00422
      **Route:** SR 520
      **Direction:** E
      **From:** WB 78th Ave
      **To:** EB 78th Ave
      **Start MP:** 4.2
      **End MP:** 1.6
      **Rate:** $3.40

      ### EB 78th Ave → WB 78th Ave
      **Trip:** 520tp00421
      **Route:** SR 520
      **Direction:** E
      **From:** EB 78th Ave
      **To:** WB 78th Ave
      **Start MP:** 1.6
      **End MP:** 4.2
      **Rate:** $3.40



      **totalCount:** 8
      **nextOffset:** null
      **hasMore:** false
      > Showing toll rates 1–8 of 8."
    `);
  });

  it('wsdot_search_cameras serves every camera in cameraId order, rendered unchanged', async () => {
    mockService.searchCameras.mockResolvedValue([...snoqualmieWindow, ...elsewhereCameras]);
    const result = await runToolContract(searchCameras, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "appliedFilters": {},
        "cameras": [
          {
            "cameraId": 1099,
            "milePost": 51.3,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 51.3: Franklin Falls",
          },
          {
            "cameraId": 1100,
            "milePost": 52,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 52: Snoqualmie Summit",
          },
          {
            "cameraId": 1102,
            "milePost": 55.1,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 55.1: Hyak",
          },
          {
            "cameraId": 1500,
            "milePost": 1,
            "region": "NW",
            "roadName": "SR 18",
            "title": "SR 18 at MP 1: Snoqualmie Parkway",
          },
          {
            "cameraId": 3059,
            "milePost": 3,
            "region": "OS",
            "roadName": "I-205",
            "title": "I-205 at Stafford Rd.",
          },
          {
            "cameraId": 9428,
            "milePost": 53.4,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 53.4: East Snoqualmie Summit",
          },
          {
            "cameraId": 9818,
            "region": "WA",
            "roadName": "Airports",
            "title": "Anacortes Airport Fuel Pump",
          },
          {
            "cameraId": 10070,
            "milePost": 55.2,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 55.2: ",
          },
          {
            "cameraId": 10296,
            "milePost": 54.5,
            "region": "SC",
            "roadName": "I-90",
            "title": "I-90 at MP 54.5: Hyak Hill",
          },
        ],
        "hasMore": false,
        "nextOffset": null,
        "notice": "Showing cameras 1–9 of 9. Camera images are copyright WSDOT.",
        "totalCount": 9,
      }
    `);
    expect(wireText(result)).toMatchInlineSnapshot(`
      "### I-90 at MP 51.3: Franklin Falls
      **Location:** I-90 MP 51.3
      **Region:** SC
      **ID:** 1099

      ### I-90 at MP 52: Snoqualmie Summit
      **Location:** I-90 MP 52
      **Region:** SC
      **ID:** 1100

      ### I-90 at MP 55.1: Hyak
      **Location:** I-90 MP 55.1
      **Region:** SC
      **ID:** 1102

      ### SR 18 at MP 1: Snoqualmie Parkway
      **Location:** SR 18 MP 1
      **Region:** NW
      **ID:** 1500

      ### I-205 at Stafford Rd.
      **Location:** I-205 MP 3
      **Region:** OS
      **ID:** 3059

      ### I-90 at MP 53.4: East Snoqualmie Summit
      **Location:** I-90 MP 53.4
      **Region:** SC
      **ID:** 9428

      ### Anacortes Airport Fuel Pump
      **Location:** Airports
      **Region:** WA
      **ID:** 9818

      ### I-90 at MP 55.2: 
      **Location:** I-90 MP 55.2
      **Region:** SC
      **ID:** 10070

      ### I-90 at MP 54.5: Hyak Hill
      **Location:** I-90 MP 54.5
      **Region:** SC
      **ID:** 10296



      **totalCount:** 9
      **Applied Filters:** none
      **nextOffset:** null
      **hasMore:** false
      > Showing cameras 1–9 of 9. Camera images are copyright WSDOT."
    `);
  });

  it('wsdot_search_alerts serves every alert in alertId order, rendered unchanged', async () => {
    mockService.searchAlerts.mockResolvedValue(alertFeed);
    const result = await runToolContract(searchAlerts, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "alerts": [
          {
            "alertId": 701,
            "headlineDescription": "Collision on I-5 NB",
            "region": "Northwest",
            "startRoadwayLocation": {
              "direction": "N",
              "milePost": 165,
              "roadName": "005",
            },
          },
          {
            "alertId": 702,
            "endRoadwayLocation": {
              "direction": "E",
              "milePost": 54,
              "roadName": "090",
            },
            "headlineDescription": "Right lane closed on I-90 EB",
            "region": "South Central",
            "startRoadwayLocation": {
              "direction": "E",
              "milePost": 52,
              "roadName": "090",
            },
          },
        ],
        "appliedFilters": {},
        "hasMore": false,
        "nextOffset": null,
        "notice": "Showing alerts 1–2 of 2.",
        "totalCount": 2,
      }
    `);
    expect(wireText(result)).toMatchInlineSnapshot(`
      "### Collision on I-5 NB #701
      **Region:** Northwest
      **Location:** 005 N MP 165

      ### Right lane closed on I-90 EB #702
      **Region:** South Central
      **Location:** 090 E MP 52
      **End Location:** 090 E MP 54



      **totalCount:** 2
      **Applied Filters:** none
      **nextOffset:** null
      **hasMore:** false
      > Showing alerts 1–2 of 2."
    `);
  });
});

/**
 * `format()` output byte for byte, for the multi-row shapes the wire tests above do not reach:
 * a corridor page, and an alert page with a multi-paragraph headline and extended description.
 * Each row renders as its own block, blocks are separated by one blank line, and the text ends
 * with a single newline.
 */
describe('format() — pinned multi-row layout', () => {
  it('wsdot_get_travel_times renders each corridor as its own block', () => {
    const text = formattedText(
      getTravelTimes.format!({
        corridors: [
          {
            travelTimeId: 1,
            name: 'I-5 NB: Northgate to Downtown',
            description: 'I-5 northbound',
            currentTimeInMinutes: 18,
            averageTimeInMinutes: 12,
            delayInMinutes: 6,
            distanceInMiles: 6.2,
            startPoint: { roadName: 'I-5', direction: 'N', milePost: 168 },
            endPoint: { roadName: 'I-5', direction: 'N', milePost: 174 },
            timeUpdated: '2023-11-14T22:13:20.000Z',
          },
          { averageTimeInMinutes: 10 },
          {
            name: 'SR 520 EB',
            currentTimeInMinutes: 8,
            averageTimeInMinutes: 10,
            delayInMinutes: -2,
          },
        ],
      }),
    );
    expect(text).toBe(
      [
        '### I-5 NB: Northgate to Downtown',
        'I-5 northbound',
        '**Current:** 18 min',
        '**Average:** 12 min',
        '**Delay:** +6 min (congested)',
        '**Distance:** 6.2 mi',
        '**From:** I-5 N MP 168',
        '**To:** I-5 N MP 174',
        '**Updated:** 2023-11-14T22:13:20.000Z',
        '**ID:** 1',
        '',
        '### Corridor',
        '**Current:** Not available — WSDOT reports no measurement for this corridor',
        '**Average:** 10 min',
        '',
        '### SR 520 EB',
        '**Current:** 8 min',
        '**Average:** 10 min',
        '**Delay:** -2 min',
        '',
      ].join('\n'),
    );
  });

  it('wsdot_search_alerts keeps multi-line headline and description text inside its block', () => {
    const text = formattedText(
      searchAlerts.format!({
        alerts: [
          {
            alertId: 5,
            headlineDescription: 'Line one\nLine two',
            extendedDescription: 'Para A\n\nPara B',
            eventCategory: 'Closure',
            eventStatus: 'Active',
            priority: 'High',
            region: 'Northwest',
            county: 'King',
            startRoadwayLocation: {
              roadName: '090',
              direction: 'E',
              milePost: 52,
              latitude: 47.5,
              longitude: -121.7,
            },
            endRoadwayLocation: { roadName: '090', direction: 'E', milePost: 54, latitude: 47.6 },
            startTime: '2026-09-01T08:00:00.000Z',
            endTime: '2026-09-30T08:00:00.000Z',
            lastUpdatedTime: '2026-09-02T08:00:00.000Z',
          },
          { eventCategory: 'Incident' },
        ],
      }),
    );
    expect(text).toBe(
      [
        '### Line one #5',
        'Line two',
        '**Category:** Closure',
        '**Status:** Active',
        '**Priority:** High',
        '**Region:** Northwest',
        '**County:** King',
        '**Location:** 090 E MP 52',
        '**Coords:** 47.5, -121.7',
        '**End Location:** 090 E MP 54',
        '**End Coords:** 47.6, longitude not reported',
        'Para A',
        '',
        'Para B',
        '**Start:** 2026-09-01T08:00:00.000Z',
        '**End:** 2026-09-30T08:00:00.000Z',
        '**Updated:** 2026-09-02T08:00:00.000Z',
        '',
        '### Alert',
        '**Category:** Incident',
        '',
      ].join('\n'),
    );
  });
});

describe('filter inputs the tools accept today', () => {
  it.each(['Northwest', 'northwest', ' Northwest ', 'NORTHWEST'])(
    'wsdot_search_alerts accepts region %j and echoes it trimmed',
    async (region) => {
      mockService.searchAlerts.mockResolvedValue([]);
      const result = await runToolContract(searchAlerts, { region });
      expect(result.isError).toBeFalsy();
      expect(mockService.searchAlerts).toHaveBeenCalledWith(
        { region: region.trim() },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({ appliedFilters: { region: region.trim() } });
    },
  );

  it.each(['NW', 'nw', ' Nw '])(
    'wsdot_search_cameras accepts region %j and echoes it trimmed',
    async (region) => {
      mockService.searchCameras.mockResolvedValue([]);
      const result = await runToolContract(searchCameras, { region });
      expect(result.isError).toBeFalsy();
      expect(mockService.searchCameras).toHaveBeenCalledWith(
        { region: region.trim() },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({ appliedFilters: { region: region.trim() } });
    },
  );

  describe.each(['', '   '])('blank value %j is treated as omitted', (blank) => {
    it('wsdot_search_alerts: region and stateRoute', async () => {
      mockService.searchAlerts.mockResolvedValue(alertFeed);
      const result = await runToolContract(searchAlerts, { region: blank, stateRoute: blank });
      expect(result.isError).toBeFalsy();
      expect(mockService.searchAlerts).toHaveBeenCalledWith({}, expect.anything());
      expect(result.structuredContent).toMatchObject({ appliedFilters: {}, totalCount: 2 });
      expect(wireText(result)).toContain('**Applied Filters:** none');
    });

    it('wsdot_search_cameras: region and stateRoute', async () => {
      mockService.searchCameras.mockResolvedValue(snoqualmieWindow);
      const result = await runToolContract(searchCameras, { region: blank, stateRoute: blank });
      expect(result.isError).toBeFalsy();
      expect(mockService.searchCameras).toHaveBeenCalledWith({}, expect.anything());
      expect(result.structuredContent).toMatchObject({ appliedFilters: {}, totalCount: 6 });
      expect(wireText(result)).toContain('**Applied Filters:** none');
    });

    it('wsdot_get_travel_times: route', async () => {
      mockService.getTravelTimes.mockResolvedValue([{ travelTimeId: 1, name: 'Seattle-Everett' }]);
      const result = await runToolContract(getTravelTimes, { route: blank });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ totalCount: 1 });
      expect(result.structuredContent).not.toHaveProperty('routeFilter');
    });
  });

  describe.each([
    { tool: 'wsdot_search_alerts', run: (input: object) => runToolContract(searchAlerts, input) },
    { tool: 'wsdot_search_cameras', run: (input: object) => runToolContract(searchCameras, input) },
  ])('$tool milepost bounds', ({ run }) => {
    beforeEach(() => {
      mockService.searchAlerts.mockResolvedValue([]);
      mockService.searchCameras.mockResolvedValue([]);
    });

    it.each([
      { startMilepost: 10 },
      { endMilepost: 100 },
      { startMilepost: 52, endMilepost: 52 },
      { startMilepost: 10, endMilepost: 100 },
    ])('accepts %j and forwards it', async (bounds) => {
      const result = await run(bounds);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ appliedFilters: bounds });
    });
  });
});

interface WireError {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string } } & Record<string, unknown>;
  message: string;
}

/** The error a contract result carries, failing when the call succeeded instead. */
function wireError(result: Awaited<ReturnType<typeof runToolContract>>): WireError {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error?: WireError } | undefined)?.error;
  if (!error) throw new Error('Expected structuredContent.error on a failed call.');
  return error;
}

// ---------------------------------------------------------------------------
// Region vocabulary and milepost order are checked before any upstream call
// ---------------------------------------------------------------------------

describe('region values outside the tool vocabulary fail with invalid_region', () => {
  const ALERT_REGIONS = [
    'Eastern',
    'North Central',
    'Northwest',
    'Olympic',
    'South Central',
    'Southwest',
  ];
  const CAMERA_REGIONS = ['ER', 'NC', 'NW', 'OL', 'OS', 'SC', 'SW', 'WA'];

  it.each(['NW', 'nw', 'East', 'Puget Sound'])(
    'wsdot_search_alerts rejects region %j and lists the region names it takes',
    async (region) => {
      mockService.searchAlerts.mockResolvedValue(alertFeed);
      const result = await runToolContract(searchAlerts, { region });
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_region');
      expect(error.message).toContain('region');
      expect(error.message).toContain(`"${region}"`);
      const hint = error.data?.recovery?.hint ?? '';
      for (const name of ALERT_REGIONS) expect(hint).toContain(name);
      expect(wireText(result)).toContain(hint);
      expect(mockService.searchAlerts).not.toHaveBeenCalled();
    },
  );

  it.each(['East', 'Northwest', 'northwest', 'XX'])(
    'wsdot_search_cameras rejects region %j and lists the region codes it takes',
    async (region) => {
      mockService.searchCameras.mockResolvedValue(snoqualmieWindow);
      const result = await runToolContract(searchCameras, { region });
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_region');
      expect(error.message).toContain('region');
      expect(error.message).toContain(`"${region}"`);
      const hint = error.data?.recovery?.hint ?? '';
      for (const code of CAMERA_REGIONS) expect(hint).toContain(code);
      expect(hint).not.toContain('Northwest');
      expect(wireText(result)).toContain(hint);
      expect(mockService.searchCameras).not.toHaveBeenCalled();
    },
  );

  it('declares invalid_region on both search tools with the ValidationError code', () => {
    for (const t of [searchAlerts, searchCameras]) {
      const entry = t.errors?.find((e) => e.reason === 'invalid_region');
      expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
    }
  });
});

describe('a reversed milepost range fails with invalid_milepost_range', () => {
  it.each([
    { name: 'wsdot_search_alerts', run: (input: object) => runToolContract(searchAlerts, input) },
    { name: 'wsdot_search_cameras', run: (input: object) => runToolContract(searchCameras, input) },
  ])('$name rejects startMilepost 100 with endMilepost 10', async ({ run }) => {
    mockService.searchAlerts.mockResolvedValue(alertFeed);
    mockService.searchCameras.mockResolvedValue(snoqualmieWindow);
    const result = await run({ startMilepost: 100, endMilepost: 10 });
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_milepost_range');
    expect(error.message).toContain('startMilepost');
    expect(error.message).toContain('endMilepost');
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toContain('startMilepost');
    expect(wireText(result)).toContain(hint);
    expect(mockService.searchAlerts).not.toHaveBeenCalled();
    expect(mockService.searchCameras).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wsdot_get_toll_rates — stateRoute filter
// ---------------------------------------------------------------------------

describe('wsdot_get_toll_rates stateRoute filter', () => {
  const tripsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { rates: { tripName?: string }[] }).rates.map((r) => r.tripName);

  beforeEach(() => mockService.getTollRates.mockResolvedValue(tollFeed));

  it.each(['SR 520', '520', '0520', 'sr520', 'SR-520', ' SR 520 '])(
    '%j returns exactly the SR 520 rows',
    async (stateRoute) => {
      const result = await runToolContract(getTollRates, { stateRoute });
      expect(result.isError).toBeFalsy();
      expect(tripsOf(result)).toEqual(['520tp00422', '520tp00421']);
      expect(result.structuredContent).toMatchObject({
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        appliedFilters: { stateRoute: stateRoute.trim() },
      });
    },
  );

  it.each(['I-405', '405', 'i-405', '0405'])(
    '%j returns exactly the I-405 rows',
    async (stateRoute) => {
      const result = await runToolContract(getTollRates, { stateRoute });
      expect(tripsOf(result)).toEqual(['405tp01351', '405tp02718']);
      expect(result.structuredContent).toMatchObject({ totalCount: 2 });
    },
  );

  it('matches on the posted designation, so SR 99 and 099 both reach the tunnel rows', async () => {
    for (const stateRoute of ['SR 99', '99', '099']) {
      const result = await runToolContract(getTollRates, { stateRoute });
      expect(tripsOf(result)).toEqual(['099tp03268', '099tp03060']);
    }
  });

  it.each(['SR 405', 'I-520', 'SR 2', 'US 2', 'I-90'])(
    '%j names a route with no tolled facility — an empty page naming the tolled routes',
    async (stateRoute) => {
      const result = await runToolContract(getTollRates, { stateRoute });
      expect(result.isError).toBeFalsy();
      expect(tripsOf(result)).toEqual([]);
      const sc = result.structuredContent as { notice: string };
      expect(result.structuredContent).toMatchObject({
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        appliedFilters: { stateRoute },
      });
      expect(sc.notice).toContain('SR 99, SR 167, I-405, SR 509, SR 520');
      const text = wireText(result);
      expect(text).toContain('No toll rate data available.');
      expect(text).toContain(sc.notice);
      expect(text).toContain(`**Applied Filters:**\n- **Route:** ${stateRoute}`);
    },
  );

  it('lists each tolled route once when the feed pads one route two ways', async () => {
    mockService.getTollRates.mockResolvedValue([
      { tripName: '099tp03268', stateRoute: '099' },
      { tripName: '99tp03060', stateRoute: '99' },
      { tripName: '520tp00422', stateRoute: '520' },
    ]);
    const result = await runToolContract(getTollRates, { stateRoute: 'SR 2' });
    const sc = result.structuredContent as { notice: string };
    expect(sc.notice).toContain('The feed carries tolls on SR 99, SR 520 —');
  });

  it.each(['', '   '])(
    'a blank stateRoute %j is treated as omitted — output identical to an unfiltered call',
    async (blank) => {
      const unfiltered = await runToolContract(getTollRates, {});
      const result = await runToolContract(getTollRates, { stateRoute: blank });
      expect(result.structuredContent).toEqual(unfiltered.structuredContent);
      expect(wireText(result)).toBe(wireText(unfiltered));
      expect(result.structuredContent).not.toHaveProperty('appliedFilters');
    },
  );

  it('renders the filtered page in content[] with the filter echoed in the trailer', async () => {
    const result = await runToolContract(getTollRates, {
      stateRoute: 'I-405',
      limit: 1,
      offset: 1,
    });
    expect(tripsOf(result)).toEqual(['405tp02718']);
    const text = wireText(result);
    expect(text.match(/^### /gm)?.length).toBe(1);
    expect(text).toContain('**Trip:** 405tp02718');
    expect(text).not.toContain('405tp01351');
    expect(text).toContain('**Applied Filters:**\n- **Route:** I-405');
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      hasMore: false,
      nextOffset: null,
    });
  });

  describe('paging walks the filtered set', () => {
    /** SR 167 and I-405 rows interleaved the way the live feed serves them. */
    const bigFeed = Array.from({ length: 100 }, (_, i) => ({
      tripName: `${i % 5 === 0 ? '405' : '167'}tp${pad(i)}`,
      stateRoute: i % 5 === 0 ? '405' : '167',
      startMilepost: i,
    }));
    const sr167 = bigFeed.filter((r) => r.stateRoute === '167').map((r) => r.startMilepost);

    beforeEach(() => mockService.getTollRates.mockResolvedValue(bigFeed));

    const page = async (input: object) => {
      const result = await runToolContract(getTollRates, { stateRoute: 'SR 167', ...input });
      const sc = result.structuredContent as {
        hasMore: boolean;
        nextOffset: number | null;
        notice: string;
        rates: { startMilepost?: number }[];
        totalCount: number;
      };
      return { sc, markers: sc.rates.map((r) => r.startMilepost) };
    };

    it('reports the matching count and continues within it on the default page', async () => {
      const { sc, markers } = await page({});
      expect(markers).toEqual(sr167.slice(0, 50));
      expect(sc.totalCount).toBe(80);
      expect(sc.hasMore).toBe(true);
      expect(sc.nextOffset).toBe(50);
      expect(sc.notice).toContain('of 80');
    });

    it('visits every matching row exactly once, in feed order', async () => {
      const seen: (number | undefined)[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const { sc, markers } = await page({ offset, limit: 7 });
        expect(sc.totalCount).toBe(80);
        seen.push(...markers);
        offset = sc.nextOffset;
      }
      expect(seen).toEqual(sr167);
    });

    it('reports an offset past the end of the matching set', async () => {
      const { sc, markers } = await page({ offset: 80 });
      expect(markers).toEqual([]);
      expect(sc.notice).toContain('Offset 80 is past the end of 80');
    });
  });

  it('describes the input forms, the bare output value, and the fixed direction codes', () => {
    const inputDescription = getTollRates.input.shape.stateRoute.description ?? '';
    expect(inputDescription).toContain('"SR 520"');
    expect(inputDescription).toContain('"I-405"');
    const rate = getTollRates.output.shape.rates.element.shape;
    expect(rate.stateRoute.description).toContain('"099"');
    expect(rate.travelDirection.description).toMatch(/SR 99.*SR 509.*SR 520/);
    expect(rate.travelDirection.description).not.toMatch(
      /^Travel direction code for this toll segment/,
    );
  });
});

// ---------------------------------------------------------------------------
// wsdot_search_cameras — titleContains
// ---------------------------------------------------------------------------

describe('wsdot_search_cameras titleContains', () => {
  const idsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { cameras: { cameraId?: number }[] }).cameras.map(
      (c) => c.cameraId,
    );

  beforeEach(() =>
    mockService.searchCameras.mockResolvedValue([...snoqualmieWindow, ...elsewhereCameras]),
  );

  it('returns the cameras whose titles contain the text, case-insensitively', async () => {
    const result = await runToolContract(searchCameras, { titleContains: 'snoqualmie' });
    expect(result.isError).toBeFalsy();
    expect(idsOf(result)).toEqual([1100, 1500, 9428]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 3,
      appliedFilters: { titleContains: 'snoqualmie' },
    });
    // The filter runs on this side; the service is never asked to apply it.
    expect(mockService.searchCameras).toHaveBeenCalledWith({}, expect.anything());
  });

  it.each(['Snoqualmie Summit', 'Summit Snoqualmie', '  SUMMIT   snoqualmie '])(
    'requires every token of %j in any order',
    async (titleContains) => {
      const result = await runToolContract(searchCameras, { titleContains });
      expect(idsOf(result)).toEqual([1100, 9428]);
      expect(result.structuredContent).toMatchObject({
        totalCount: 2,
        appliedFilters: { titleContains: titleContains.trim() },
      });
    },
  );

  it('composes with the route and milepost filters the service applied', async () => {
    mockService.searchCameras.mockResolvedValue(snoqualmieWindow);
    const result = await runToolContract(searchCameras, {
      stateRoute: 'I-90',
      startMilepost: 50,
      endMilepost: 55,
      titleContains: 'Snoqualmie',
    });
    expect(mockService.searchCameras).toHaveBeenCalledWith(
      { stateRoute: 'I-90', startMilepost: 50, endMilepost: 55 },
      expect.anything(),
    );
    expect(idsOf(result)).toEqual([1100, 9428]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      appliedFilters: {
        stateRoute: 'I-90',
        startMilepost: 50,
        endMilepost: 55,
        titleContains: 'Snoqualmie',
      },
    });
  });

  it('excludes a camera with no title rather than throwing', async () => {
    mockService.searchCameras.mockResolvedValue([
      { cameraId: 1, roadName: 'I-90' },
      ...snoqualmieWindow,
    ]);
    const result = await runToolContract(searchCameras, { titleContains: 'I-90' });
    expect(result.isError).toBeFalsy();
    expect(idsOf(result)).toEqual([1099, 1100, 1102, 9428, 10070, 10296]);
  });

  it('answers a title matching nothing with an empty page, a filtered notice, and the echo', async () => {
    const result = await runToolContract(searchCameras, { titleContains: 'Stevens Pass' });
    expect(idsOf(result)).toEqual([]);
    const sc = result.structuredContent as { notice: string };
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      hasMore: false,
      nextOffset: null,
      appliedFilters: { titleContains: 'Stevens Pass' },
    });
    expect(sc.notice).toContain('No cameras matched the applied filters');
    expect(sc.notice).toContain('titleContains');
    const text = wireText(result);
    expect(text).toContain('No cameras found');
    expect(text).toContain('**Applied Filters:**\n- **Title contains:** Stevens Pass');
    expect(text).toContain(sc.notice);
  });

  it.each(['', '   '])(
    'a blank titleContains %j is treated as omitted — output identical to an unfiltered call',
    async (blank) => {
      const unfiltered = await runToolContract(searchCameras, {});
      const result = await runToolContract(searchCameras, { titleContains: blank });
      expect(result.structuredContent).toEqual(unfiltered.structuredContent);
      expect(wireText(result)).toBe(wireText(unfiltered));
    },
  );

  describe('paging walks the filtered set', () => {
    const cameras = Array.from({ length: 100 }, (_, i) => ({
      cameraId: 2000 + i,
      title: i % 5 === 0 ? `SR 18 at MP ${i}: Echo Lake` : `I-90 at MP ${i}: Hyak ${pad(i)}`,
      roadName: i % 5 === 0 ? 'SR 18' : 'I-90',
    }));
    const hyak = cameras.filter((c) => c.title.includes('Hyak')).map((c) => c.cameraId);

    beforeEach(() => mockService.searchCameras.mockResolvedValue([...cameras].reverse()));

    it('reports the matching count on the default page and continues within it', async () => {
      const result = await runToolContract(searchCameras, { titleContains: 'hyak' });
      expect(idsOf(result)).toEqual(hyak.slice(0, 50));
      expect(result.structuredContent).toMatchObject({
        totalCount: 80,
        hasMore: true,
        nextOffset: 50,
      });
    });

    it('visits every matching camera exactly once', async () => {
      const seen: (number | undefined)[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result: Awaited<ReturnType<typeof runToolContract>> = await runToolContract(
          searchCameras,
          { titleContains: 'hyak', offset, limit: 9 },
        );
        seen.push(...idsOf(result));
        offset = (result.structuredContent as { nextOffset: number | null }).nextOffset;
      }
      expect(seen).toEqual(hyak);
    });

    it('reports an offset past the end of the matching set', async () => {
      const result = await runToolContract(searchCameras, { titleContains: 'hyak', offset: 85 });
      expect(idsOf(result)).toEqual([]);
      expect((result.structuredContent as { notice: string }).notice).toContain(
        'Offset 85 is past the end of 80 matching cameras',
      );
    });

    it('renders exactly the filtered page in content[]', async () => {
      const result = await runToolContract(searchCameras, {
        titleContains: 'hyak',
        offset: 3,
        limit: 2,
      });
      const ids = idsOf(result);
      expect(ids).toEqual(hyak.slice(3, 5));
      const text = wireText(result);
      expect(text.match(/^### /gm)?.length).toBe(2);
      for (const id of ids) expect(text).toContain(`**ID:** ${id}`);
      expect(text).toContain('- **Title contains:** hyak');
    });
  });

  it('describes the title match and steers route filtering to stateRoute', () => {
    const description = searchCameras.input.shape.titleContains.description ?? '';
    expect(description).toContain('Snoqualmie');
    expect(description).toContain('stateRoute');
  });
});

describe('camera region descriptions name what the codes hold', () => {
  it('OS is the Oregon (Portland-area) set and WA the airport and ferry cameras', () => {
    const description = searchCameras.input.shape.region.description ?? '';
    expect(description).not.toContain('Olympic South');
    expect(description).not.toContain('statewide');
    expect(description).toMatch(/OS \([^)]*Oregon/);
    expect(description).toMatch(/WA \([^)]*airport[^)]*ferr/i);
  });
});
