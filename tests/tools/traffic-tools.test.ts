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

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(enrichment.notice).toBeUndefined();
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
    expect(enrichment.notice).toBeUndefined();
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
