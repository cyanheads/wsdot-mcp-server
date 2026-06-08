/**
 * @fileoverview Tests for WSDOT traffic tools: mountain passes, alerts, travel times,
 * toll rates, border waits, and cameras.
 * @module tests/tools/traffic-tools.test
 */

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
    restrictionOne: { comment: 'Traction Tires Required', type: 'TractionsRequired' },
    dateUpdated: '/Date(1700000000000-0800)/',
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
    startTime: '/Date(1700000000000-0800)/',
    lastUpdatedTime: '/Date(1700001000000-0800)/',
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
    timeUpdated: '/Date(1700000000000-0800)/',
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
    timeUpdated: '/Date(1700000000000-0800)/',
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
    crossingName: 'Peace Arch',
    waitTimeInMinutes: 25,
    updateTime: '/Date(1700000000000-0800)/',
    location: {
      roadName: 'I-5',
      direction: 'N',
      milePost: 275,
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
    expect(result.crossings[0].crossingName).toBe('Peace Arch');
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
    expect(text).toContain('Peace Arch');
    expect(text).toContain('25 min');
    expect(text).toContain('I-5');
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

  it('enriches truncation notice when more than 20 cameras returned', async () => {
    const manyCameras = Array.from({ length: 25 }, (_, i) => ({ ...cameraFixture, cameraId: i }));
    mockService.searchCameras.mockResolvedValue(manyCameras);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({});
    await searchCameras.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(25);
    expect(enrichment.notice).toContain('first 20');
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

  it('formats empty cameras list', () => {
    const output = { cameras: [] };
    const blocks = searchCameras.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Empty cameras → empty text (no header since no results)
    expect(text).toBeDefined();
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
