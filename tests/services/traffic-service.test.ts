/**
 * @fileoverview Tests for TrafficApiService normalization logic: raw → domain type
 * mapping, HTTP error handling, HTML detection, and sparse upstream payloads.
 * All external HTTP is mocked — no real network calls.
 * @module tests/services/traffic-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Inline TrafficApiService so we can call normalization helpers directly
// without triggering the global init singleton.
// We import the class directly (not the singleton accessor).
// ---------------------------------------------------------------------------

// Mock getServerConfig so the class doesn't read env vars at instantiation
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

// Mock withRetry to execute the wrapped function immediately (no retries)
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { getMountainPasses } from '@/mcp-server/tools/definitions/get-mountain-passes.tool.js';
import { TrafficApiService } from '@/services/traffic/traffic-service.js';

/**
 * Obviously-fake stand-in for the credential. It matches the value returned by the mocked
 * `getServerConfig` above, so a leak assertion checks the real thing the service builds URLs with.
 */
const ACCESS_CODE = 'test-access-code';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to build a Response-like object
function makeResponse(body: unknown, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('TrafficApiService — mountain pass normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps all raw fields to domain fields', async () => {
    const raw = [
      {
        MountainPassId: 1,
        MountainPassName: 'Snoqualmie Pass',
        ElevationInFeet: 3022,
        TemperatureInFahrenheit: 28,
        WeatherCondition: 'Snow',
        RoadCondition: 'Snow and Ice Covered',
        TravelAdvisoryActive: true,
        RestrictionOne: {
          RestrictionText: 'Traction Tires Required',
          TravelDirection: 'Eastbound',
        },
        DateUpdated: '/Date(1700000000000-0800)/',
        Latitude: 47.4273,
        Longitude: -121.4128,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);

    expect(passes).toHaveLength(1);
    const p = passes[0];
    expect(p.mountainPassId).toBe(1);
    expect(p.mountainPassName).toBe('Snoqualmie Pass');
    expect(p.elevation).toBe(3022);
    expect(p.temperatureInFahrenheit).toBe(28);
    expect(p.weatherCondition).toBe('Snow');
    expect(p.roadCondition).toBe('Snow and Ice Covered');
    expect(p.travelAdvisoryActive).toBe(true);
    expect(p.restrictionOne?.text).toBe('Traction Tires Required');
    expect(p.restrictionOne?.travelDirection).toBe('Eastbound');
    // WCF date decoded to ISO 8601
    expect(p.dateUpdated).toBe('2023-11-14T22:13:20.000Z');
    expect(p.latitude).toBe(47.4273);
    expect(p.longitude).toBe(-121.4128);
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [
      {
        MountainPassId: 2,
        MountainPassName: 'Blewett Pass',
        ElevationInFeet: null,
        TemperatureInFahrenheit: null,
        WeatherCondition: null,
        RoadCondition: null,
        TravelAdvisoryActive: null,
        RestrictionOne: null,
        Latitude: null,
        Longitude: null,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);

    const p = passes[0];
    expect(p.mountainPassId).toBe(2);
    expect(p.mountainPassName).toBe('Blewett Pass');
    expect('elevation' in p).toBe(false);
    expect('temperatureInFahrenheit' in p).toBe(false);
    expect('weatherCondition' in p).toBe(false);
    expect('roadCondition' in p).toBe(false);
    expect('travelAdvisoryActive' in p).toBe(false);
    expect('restrictionOne' in p).toBe(false);
    expect('latitude' in p).toBe(false);
    expect('longitude' in p).toBe(false);
  });

  it('falls back to defaults when MountainPassId/Name are null', async () => {
    const raw = [{ MountainPassId: null, MountainPassName: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);
    expect(passes[0].mountainPassId).toBe(0);
    expect(passes[0].mountainPassName).toBe('Unknown');
  });

  it('omits restrictionOne when both text and travelDirection are absent', async () => {
    const raw = [
      {
        MountainPassId: 3,
        MountainPassName: 'White Pass',
        RestrictionOne: { RestrictionText: null, TravelDirection: null },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);
    expect('restrictionOne' in passes[0]).toBe(false);
  });

  it('omits dateUpdated when DateUpdated is the .NET MinValue sentinel', async () => {
    const raw = [
      {
        MountainPassId: 4,
        MountainPassName: 'Cayuse Pass',
        DateUpdated: '/Date(-62135568000000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);
    expect('dateUpdated' in passes[0]).toBe(false);
  });

  it('returns empty array when API returns []', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);
    expect(passes).toHaveLength(0);
  });
});

describe('TrafficApiService — alert normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps raw alert fields to domain fields', async () => {
    const raw = [
      {
        AlertID: 101,
        HeadlineDescription: 'I-90 Closure',
        ExtendedDescription: 'All lanes blocked',
        EventCategory: 'Closure',
        EventStatus: 'Active',
        Priority: 'High',
        Region: 'Northwest',
        County: 'King',
        StartRoadwayLocation: {
          RoadName: 'I-90',
          Direction: 'Both',
          MilePost: 30,
          Latitude: 47.5,
          Longitude: -121.7,
        },
        StartTime: '/Date(1700000000000-0800)/',
        LastUpdatedTime: '/Date(1700001000000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.searchAlerts({}, ctx);

    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.alertId).toBe(101);
    expect(a.headlineDescription).toBe('I-90 Closure');
    expect(a.eventCategory).toBe('Closure');
    expect(a.region).toBe('Northwest');
    expect(a.startRoadwayLocation?.roadName).toBe('I-90');
    expect(a.startRoadwayLocation?.milePost).toBe(30);
    // WCF dates decoded to ISO 8601
    expect(a.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.lastUpdatedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [
      {
        AlertID: 102,
        HeadlineDescription: null,
        EventCategory: null,
        StartRoadwayLocation: null,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.searchAlerts({}, ctx);
    const a = alerts[0];
    expect(a.alertId).toBe(102);
    expect('headlineDescription' in a).toBe(false);
    expect('eventCategory' in a).toBe(false);
    expect('startRoadwayLocation' in a).toBe(false);
  });

  it('always uses GetAlertsAsJson endpoint (no SearchAlertsAsJson)', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.searchAlerts({ stateRoute: '090' }, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('GetAlertsAsJson');
    expect(url).not.toContain('SearchAlertsAsJson');
  });

  it('filters alerts by stateRoute client-side against roadName', async () => {
    const raw = [
      {
        AlertID: 1,
        Region: 'Northwest',
        StartRoadwayLocation: { RoadName: '090', MilePost: 30 },
      },
      {
        AlertID: 2,
        Region: 'Northwest',
        StartRoadwayLocation: { RoadName: '005', MilePost: 170 },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.searchAlerts({ stateRoute: '090' }, ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertId).toBe(1);
  });

  it('matches natural stateRoute forms and rejects substring false positives (I-90 vs SR 290)', async () => {
    const raw = [
      { AlertID: 1, StartRoadwayLocation: { RoadName: 'I-90', MilePost: 30 } },
      { AlertID: 2, StartRoadwayLocation: { RoadName: 'SR 290', MilePost: 8 } },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    const natural = await svc.searchAlerts({ stateRoute: 'I-90' }, createMockContext());
    expect(natural.map((a) => a.alertId)).toEqual([1]);

    // "90" must match I-90 but NOT SR 290 — the old .includes() substring bug.
    mockFetch.mockResolvedValue(makeResponse(raw));
    const bare = await svc.searchAlerts({ stateRoute: '90' }, createMockContext());
    expect(bare.map((a) => a.alertId)).toEqual([1]);
  });

  it('matches an end-location roadName when the start location does not', async () => {
    const raw = [
      {
        AlertID: 7,
        StartRoadwayLocation: { RoadName: 'I-5', MilePost: 100 },
        EndRoadwayLocation: { RoadName: 'SR 520', MilePost: 5 },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const alerts = await svc.searchAlerts({ stateRoute: '520' }, createMockContext());
    expect(alerts.map((a) => a.alertId)).toEqual([7]);
  });

  it('filters alerts by region client-side (case-insensitive)', async () => {
    const raw = [
      { AlertID: 1, Region: 'Northwest' },
      { AlertID: 2, Region: 'Eastern' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.searchAlerts({ region: 'northwest' }, ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertId).toBe(1);
  });

  it("matches a prefixed stateRoute against the feed's bare road names", async () => {
    // Alert road names are always bare zero-padded numbers, so a prefixed filter has to fall
    // back to comparing the number alone.
    const raw = [
      { AlertID: 1, StartRoadwayLocation: { RoadName: '005', MilePost: 100 } },
      { AlertID: 2, StartRoadwayLocation: { RoadName: '026', MilePost: 12 } },
      { AlertID: 3, StartRoadwayLocation: { RoadName: '520', MilePost: 3 } },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ stateRoute: 'I-5' }, createMockContext())).map((a) => a.alertId),
    ).toEqual([1]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ stateRoute: 'SR 26' }, createMockContext())).map((a) => a.alertId),
    ).toEqual([2]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ stateRoute: 'SR 520' }, createMockContext())).map((a) => a.alertId),
    ).toEqual([3]);
  });

  it('filters alerts by milepost range client-side', async () => {
    const raw = [
      { AlertID: 1, StartRoadwayLocation: { MilePost: 10, RoadName: '005' } },
      { AlertID: 2, StartRoadwayLocation: { MilePost: 60, RoadName: '005' } },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.searchAlerts({ startMilepost: 5, endMilepost: 50 }, ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertId).toBe(1);
  });

  it('keeps an alert whose extent spans the requested milepost range', async () => {
    // The alert starts before the range and runs into it — testing the start point alone drops it.
    const raw = [
      {
        AlertID: 1,
        StartRoadwayLocation: { RoadName: '005', MilePost: 10, Latitude: 47.1, Longitude: -122.1 },
        EndRoadwayLocation: { RoadName: '005', MilePost: 30, Latitude: 47.3, Longitude: -122.3 },
      },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ startMilepost: 20 }, createMockContext())).map((a) => a.alertId),
    ).toEqual([1]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ startMilepost: 20, endMilepost: 25 }, createMockContext())).map(
        (a) => a.alertId,
      ),
    ).toEqual([1]);

    // An extent wholly outside the range is still excluded.
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      await svc.searchAlerts({ startMilepost: 40, endMilepost: 50 }, createMockContext()),
    ).toEqual([]);
  });

  it('handles an extent whose start milepost is greater than its end', async () => {
    // Mileposts descend on a decreasing-direction record; the span is still MP 10–30.
    const raw = [
      {
        AlertID: 2,
        StartRoadwayLocation: { RoadName: '395', MilePost: 30, Latitude: 47.3, Longitude: -117.3 },
        EndRoadwayLocation: { RoadName: '395', MilePost: 10, Latitude: 47.1, Longitude: -117.1 },
      },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ startMilepost: 20, endMilepost: 25 }, createMockContext())).map(
        (a) => a.alertId,
      ),
    ).toEqual([2]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(await svc.searchAlerts({ endMilepost: 5 }, createMockContext())).toEqual([]);
  });

  it('treats an unpopulated end location as absent, not as an extent reaching MP 0', async () => {
    // WSDOT fills the end location of a point alert with zeros; reading them as a real endpoint
    // would stretch every such alert from MP 0 and match almost any range.
    const raw = [
      {
        AlertID: 3,
        StartRoadwayLocation: {
          RoadName: '101',
          MilePost: 164.95,
          Latitude: 47.71,
          Longitude: -124.41,
        },
        EndRoadwayLocation: {
          RoadName: '101',
          Direction: 'B',
          MilePost: 0,
          Latitude: 0,
          Longitude: 0,
        },
      },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    const [alert] = await svc.searchAlerts({}, createMockContext());
    expect(alert.endRoadwayLocation).toEqual({ roadName: '101', direction: 'B' });

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(
      (await svc.searchAlerts({ startMilepost: 160 }, createMockContext())).map((a) => a.alertId),
    ).toEqual([3]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(await svc.searchAlerts({ endMilepost: 50 }, createMockContext())).toEqual([]);
  });

  it('keeps an alert reporting no milepost at all', async () => {
    const raw = [{ AlertID: 4, StartRoadwayLocation: { RoadName: '005' } }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const alerts = await svc.searchAlerts(
      { startMilepost: 20, endMilepost: 25 },
      createMockContext(),
    );
    expect(alerts.map((a) => a.alertId)).toEqual([4]);
  });
});

describe('TrafficApiService — travel time normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps raw travel time fields to domain fields', async () => {
    const raw = [
      {
        TravelTimeID: 1,
        Name: 'I-5 NB: Northgate to Downtown',
        Description: 'I-5 northbound',
        CurrentTime: 18,
        AverageTime: 12,
        TimeUpdated: '/Date(1700000000000-0800)/',
        Distance: 6.2,
        StartPoint: { RoadName: 'I-5', Direction: 'N', MilePost: 168 },
        EndPoint: { RoadName: 'I-5', Direction: 'N', MilePost: 174 },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const times = await svc.getTravelTimes(ctx);

    expect(times).toHaveLength(1);
    const t = times[0];
    expect(t.travelTimeId).toBe(1);
    expect(t.name).toBe('I-5 NB: Northgate to Downtown');
    expect(t.currentTimeInMinutes).toBe(18);
    expect(t.averageTimeInMinutes).toBe(12);
    expect(t.distanceInMiles).toBe(6.2);
    expect(t.startPoint?.roadName).toBe('I-5');
    expect(t.endPoint?.milePost).toBe(174);
    expect(t.timeUpdated).toBe('2023-11-14T22:13:20.000Z');
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [{ TravelTimeID: null, Name: null, CurrentTime: null, AverageTime: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const times = await svc.getTravelTimes(ctx);
    const t = times[0];
    expect('travelTimeId' in t).toBe(false);
    expect('name' in t).toBe(false);
    expect('currentTimeInMinutes' in t).toBe(false);
    expect('averageTimeInMinutes' in t).toBe(false);
  });

  it('drops the 0 sentinel on a corridor with distance rather than reporting a zero-minute trip', async () => {
    const raw = [
      {
        TravelTimeID: 10,
        Name: 'Everett-Seattle EL',
        CurrentTime: 0,
        AverageTime: 0,
        Distance: 26.72,
        StartPoint: { RoadName: '005', Direction: 'S', MilePost: 192 },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const [t] = await svc.getTravelTimes(createMockContext());
    expect('currentTimeInMinutes' in t).toBe(false);
    expect('averageTimeInMinutes' in t).toBe(false);
    expect(t.distanceInMiles).toBe(26.72);
    expect(t.name).toBe('Everett-Seattle EL');
  });

  it('keeps a measured time on an express-lane corridor (the sentinel is the value, not the name)', async () => {
    // The opposite-direction reversible lanes carry real measurements under the same naming —
    // suppressing by corridor name would drop live data.
    const raw = [
      {
        TravelTimeID: 11,
        Name: 'Seattle-Everett EL',
        CurrentTime: 47,
        AverageTime: 39,
        Distance: 26.94,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const [t] = await svc.getTravelTimes(createMockContext());
    expect(t.currentTimeInMinutes).toBe(47);
    expect(t.averageTimeInMinutes).toBe(39);
  });

  it('keeps a 0 when the corridor reports no distance to contradict it', async () => {
    const raw = [
      { TravelTimeID: 12, Name: 'Zero-length corridor', CurrentTime: 0, AverageTime: 0 },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const [t] = await svc.getTravelTimes(createMockContext());
    expect(t.currentTimeInMinutes).toBe(0);
    expect(t.averageTimeInMinutes).toBe(0);
  });
});

describe('TrafficApiService — toll rate normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps raw toll rate fields to domain fields', async () => {
    const raw = [
      {
        TripName: '099tp03060',
        StateRoute: '099',
        TravelDirection: 'S',
        StartMilepost: 33.0,
        EndMilepost: 30.0,
        CurrentToll: 125,
        CurrentMessage: null,
        StartLocationName: 'SB S Portal',
        EndLocationName: 'NB S Portal',
        StartLatitude: 47.626665944,
        StartLongitude: -122.343652437,
        EndLatitude: 47.587648851,
        EndLongitude: -122.338771924,
        TimeUpdated: '/Date(1700000000000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const rates = await svc.getTollRates(ctx);

    expect(rates).toHaveLength(1);
    const r = rates[0];
    expect(r.tripName).toBe('099tp03060');
    expect(r.stateRoute).toBe('099');
    expect(r.travelDirection).toBe('S');
    // CurrentToll 125 cents → $1.25
    expect(r.tollRateInDollars).toBeCloseTo(1.25);
    expect(r.startLocationName).toBe('SB S Portal');
    expect(r.endLocationName).toBe('NB S Portal');
    expect(r.startLatitude).toBeCloseTo(47.626665944);
    expect(r.endLatitude).toBeCloseTo(47.587648851);
    expect(r.timeUpdated).toBe('2023-11-14T22:13:20.000Z');
    // CurrentMessage was null — should be omitted
    expect('message' in r).toBe(false);
  });

  it('converts CurrentToll integer cents to dollars', async () => {
    const raw = [{ TripName: 'test', CurrentToll: 350 }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const rates = await svc.getTollRates(ctx);
    expect(rates[0].tollRateInDollars).toBeCloseTo(3.5);
  });

  it('omits tollRateInDollars when CurrentToll is null', async () => {
    const raw = [{ TripName: null, CurrentToll: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const rates = await svc.getTollRates(ctx);
    expect('tripName' in rates[0]).toBe(false);
    expect('tollRateInDollars' in rates[0]).toBe(false);
  });

  it('maps CurrentMessage to message field', async () => {
    const raw = [{ TripName: 'test', CurrentToll: 200, CurrentMessage: 'HOV 2+ free' }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const rates = await svc.getTollRates(ctx);
    expect(rates[0].message).toBe('HOV 2+ free');
  });
});

describe('TrafficApiService — border crossing normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps raw border crossing fields to domain fields', async () => {
    const raw = [
      {
        CrossingName: 'I5',
        WaitTime: 25,
        Time: '/Date(1700000000000-0800)/',
        BorderCrossingLocation: {
          Description: 'I-5 General Purpose',
          RoadName: '005',
          Direction: 'N',
          MilePost: 0,
          Latitude: 49.002,
          Longitude: -122.755,
        },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const crossings = await svc.getBorderCrossings(ctx);

    expect(crossings).toHaveLength(1);
    const c = crossings[0];
    expect(c.crossingName).toBe('I5');
    expect(c.waitTimeInMinutes).toBe(25);
    expect(c.location?.description).toBe('I-5 General Purpose');
    expect(c.location?.roadName).toBe('005');
    expect(c.location?.latitude).toBe(49.002);
    // WCF date decoded to ISO 8601 (field is `Time`, not `UpdateTime`)
    expect(c.updateTime).toBe('2023-11-14T22:13:20.000Z');
  });

  it('omits location when BorderCrossingLocation is null', async () => {
    const raw = [{ CrossingName: 'Sumas', WaitTime: null, BorderCrossingLocation: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const crossings = await svc.getBorderCrossings(ctx);
    expect('location' in crossings[0]).toBe(false);
    expect('waitTimeInMinutes' in crossings[0]).toBe(false);
  });

  it('omits waitTimeInMinutes when WaitTime is the -1 sentinel', async () => {
    const raw = [{ CrossingName: 'SR9', WaitTime: -1, BorderCrossingLocation: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const crossings = await svc.getBorderCrossings(ctx);
    expect(crossings[0].crossingName).toBe('SR9');
    expect('waitTimeInMinutes' in crossings[0]).toBe(false);
  });
});

describe('TrafficApiService — camera normalization', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps raw camera fields to domain fields (CameraLocation nested)', async () => {
    const raw = [
      {
        CameraID: 1001,
        Title: 'I-90 at Snoqualmie Pass',
        Description: 'Summit viewpoint',
        ImageURL: 'https://images.wsdot.wa.gov/nc/090vc12345.jpg',
        ImageWidth: 320,
        ImageHeight: 240,
        CameraLocation: {
          RoadName: 'I-90',
          Direction: 'EB',
          MilePost: 52,
          Latitude: 47.4,
          Longitude: -121.4,
        },
        Region: 'NW',
        IsActive: true,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const cameras = await svc.searchCameras({}, ctx);

    expect(cameras).toHaveLength(1);
    const c = cameras[0];
    expect(c.cameraId).toBe(1001);
    expect(c.title).toBe('I-90 at Snoqualmie Pass');
    expect(c.imageUrl).toBe('https://images.wsdot.wa.gov/nc/090vc12345.jpg');
    expect(c.imageWidth).toBe(320);
    expect(c.region).toBe('NW');
    // Location fields from nested CameraLocation
    expect(c.roadName).toBe('I-90');
    expect(c.direction).toBe('EB');
    expect(c.milePost).toBe(52);
    expect(c.latitude).toBe(47.4);
    expect(c.longitude).toBe(-121.4);
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [{ CameraID: null, Title: null, ImageURL: null, CameraLocation: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const cameras = await svc.searchCameras({}, ctx);
    expect('cameraId' in cameras[0]).toBe(false);
    expect('title' in cameras[0]).toBe(false);
    expect('imageUrl' in cameras[0]).toBe(false);
    expect('roadName' in cameras[0]).toBe(false);
    expect('latitude' in cameras[0]).toBe(false);
  });

  it('always uses GetCamerasAsJson endpoint (no SearchCamerasAsJson)', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.searchCameras({ stateRoute: '090' }, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('GetCamerasAsJson');
    expect(url).not.toContain('SearchCamerasAsJson');
  });

  it('filters cameras by stateRoute client-side (zero-padded route number)', async () => {
    const raw = [
      {
        CameraID: 1,
        Region: 'NW',
        CameraLocation: {
          RoadName: 'I-90',
          MilePost: 52,
          Latitude: 47.4,
          Longitude: -121.4,
          Direction: 'EB',
        },
      },
      {
        CameraID: 2,
        Region: 'NW',
        CameraLocation: {
          RoadName: 'I-5',
          MilePost: 172,
          Latitude: 47.6,
          Longitude: -122.3,
          Direction: 'NB',
        },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const cameras = await svc.searchCameras({ stateRoute: '090' }, ctx);
    expect(cameras).toHaveLength(1);
    expect(cameras[0].cameraId).toBe(1);
  });

  it('filters cameras by natural stateRoute forms (I-90, SR 520)', async () => {
    const raw = [
      { CameraID: 1, CameraLocation: { RoadName: 'I-90' } },
      { CameraID: 2, CameraLocation: { RoadName: 'SR 520' } },
      { CameraID: 3, CameraLocation: { RoadName: 'I-5' } },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    const i90 = await svc.searchCameras({ stateRoute: 'I-90' }, createMockContext());
    expect(i90.map((c) => c.cameraId)).toEqual([1]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    const sr520 = await svc.searchCameras({ stateRoute: 'SR 520' }, createMockContext());
    expect(sr520.map((c) => c.cameraId)).toEqual([2]);
  });

  it('does not match a prefixed stateRoute against a different route type (SR 26 vs US 26)', async () => {
    const raw = [
      { CameraID: 1, CameraLocation: { RoadName: 'SR 26' } },
      { CameraID: 2, CameraLocation: { RoadName: 'US 26' } },
      { CameraID: 3, CameraLocation: { RoadName: 'US 97' } },
      { CameraID: 4, CameraLocation: { RoadName: 'US 97A' } },
    ];

    mockFetch.mockResolvedValue(makeResponse(raw));
    const sr26 = await svc.searchCameras({ stateRoute: 'SR 26' }, createMockContext());
    expect(sr26.map((c) => c.cameraId)).toEqual([1]);

    mockFetch.mockResolvedValue(makeResponse(raw));
    const us26 = await svc.searchCameras({ stateRoute: 'US 26' }, createMockContext());
    expect(us26.map((c) => c.cameraId)).toEqual([2]);

    // A lettered suffix is part of the route number, so US 97 does not pull in US 97A.
    mockFetch.mockResolvedValue(makeResponse(raw));
    const us97 = await svc.searchCameras({ stateRoute: 'US 97' }, createMockContext());
    expect(us97.map((c) => c.cameraId)).toEqual([3]);

    // A bare number carries no route type, so it still returns both 26s.
    mockFetch.mockResolvedValue(makeResponse(raw));
    const bare26 = await svc.searchCameras({ stateRoute: '26' }, createMockContext());
    expect(bare26.map((c) => c.cameraId)).toEqual([1, 2]);
  });

  it('does not substring-match "90" against SR 290 (camera)', async () => {
    const raw = [
      { CameraID: 1, CameraLocation: { RoadName: 'I-90' } },
      { CameraID: 2, CameraLocation: { RoadName: 'SR 290' } },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const cameras = await svc.searchCameras({ stateRoute: '90' }, createMockContext());
    expect(cameras.map((c) => c.cameraId)).toEqual([1]);
  });

  it('filters cameras by region client-side (case-insensitive)', async () => {
    const raw = [
      { CameraID: 1, Region: 'NW', CameraLocation: null },
      { CameraID: 2, Region: 'ER', CameraLocation: null },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const cameras = await svc.searchCameras({ region: 'nw' }, ctx);
    expect(cameras).toHaveLength(1);
    expect(cameras[0].cameraId).toBe(1);
  });

  it('filters cameras by milepost range client-side', async () => {
    const raw = [
      {
        CameraID: 1,
        Region: 'NW',
        CameraLocation: {
          RoadName: 'I-90',
          MilePost: 10,
          Latitude: 47.4,
          Longitude: -121.4,
          Direction: 'EB',
        },
      },
      {
        CameraID: 2,
        Region: 'NW',
        CameraLocation: {
          RoadName: 'I-90',
          MilePost: 60,
          Latitude: 47.5,
          Longitude: -121.5,
          Direction: 'EB',
        },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const cameras = await svc.searchCameras({ startMilepost: 5, endMilepost: 50 }, ctx);
    expect(cameras).toHaveLength(1);
    expect(cameras[0].cameraId).toBe(1);
  });
});

describe('TrafficApiService — HTTP error handling', () => {
  let svc: TrafficApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('throws serviceUnavailable on HTTP 503', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const ctx = createMockContext();
    await expect(svc.getMountainPasses(ctx)).rejects.toThrow(/503/);
  });

  it('resolves the api_unavailable contract on a non-2xx (reason + recovery hint)', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({
      reason: 'api_unavailable',
      status: 503,
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
  });

  it('surfaces the upstream body on a non-2xx instead of discarding it', async () => {
    mockFetch.mockResolvedValue(makeResponse('Upstream is draining', 503, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).message).toContain('Upstream is draining');
    expect((err as McpError).data).toMatchObject({ body: 'Upstream is draining' });
  });

  it('classifies HTTP 401 as invalid_access_code naming WSDOT_ACCESS_CODE', async () => {
    mockFetch.mockResolvedValue(makeResponse('Unauthorized', 401, 'text/plain'));
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).message).toMatch(/401/);
    expect((err as McpError).message).toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_access_code',
      status: 401,
      recovery: { hint: expect.stringContaining('WSDOT_ACCESS_CODE') },
    });
  });

  it('reads the 400 body an unregistered access code produces (text/html "Bad Request")', async () => {
    // WSDOT answers an unregistered code with HTTP 400 + Content-Type text/html + body "Bad Request".
    // Before the fix the status check threw first and the body was never read.
    mockFetch.mockResolvedValue(makeResponse('Bad Request', 400, 'text/html'));
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).message).toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).message).toContain('Bad Request');
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_access_code',
      status: 400,
      body: 'Bad Request',
    });
  });

  it('marks 4xx errors non-retryable (data.retryable === false)', async () => {
    mockFetch.mockResolvedValue(makeResponse('Bad Request', 400, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ retryable: false, status: 400 });
  });

  it('does not mark 5xx errors non-retryable', async () => {
    mockFetch.mockResolvedValue(makeResponse('Server Error', 503, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).data?.retryable).toBeUndefined();
  });

  it('treats an HTML page (Content-Type) as an access-code failure', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html>Login</html>', 200, 'text/html'));
    const ctx = createMockContext();
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).message).toMatch(/HTML page/);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('treats an HTML document body (no CT header) as an access-code failure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve('<!DOCTYPE html><html><body>Login</body></html>'),
    });
    const ctx = createMockContext();
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).message).toMatch(/HTML content/);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('keeps a 5xx HTML outage page as a retryable api_unavailable', async () => {
    // IIS and CDN outage pages are HTML too. Blaming the access code for an upstream outage sends
    // the operator after their credential and drops the retry the failure deserves.
    mockFetch.mockResolvedValue(
      makeResponse('<html><body>503 Service Unavailable</body></html>', 503, 'text/html'),
    );
    const ctx = createMockContext({ errors: getMountainPasses.errors });
    const err = await svc.getMountainPasses(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).not.toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable', status: 503 });
    expect((err as McpError).data?.retryable).toBeUndefined();
  });

  it('appends AccessCode to every request URL', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getMountainPasses(ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('AccessCode=test-access-code');
  });

  it('uses BASE_URL prefix', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getMountainPasses(ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://www.wsdot.wa.gov/Traffic/api');
  });
});

describe('TrafficApiService — access code never reaches the error payload', () => {
  let svc: TrafficApiService;

  /**
   * Everything a client or log sink would see from a thrown service error, including own
   * properties the runtime hung off it — Bun and Node attach the requested URL as `path`, which
   * a log sink serializing the error would pick up.
   */
  function wirePayload(err: unknown): string {
    const mcp = err as McpError;
    return JSON.stringify({
      ...(err as object),
      code: mcp.code,
      message: mcp.message,
      data: mcp.data,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new TrafficApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('strips the query string from data.url on a non-2xx', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const err = await svc.getMountainPasses(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data?.url).toBe(
      'https://www.wsdot.wa.gov/Traffic/api/MountainPassConditions/MountainPassConditionsREST.svc/GetMountainPassConditionsAsJson',
    );
  });

  it('strips the query string on an access-code rejection', async () => {
    mockFetch.mockResolvedValue(makeResponse('Bad Request', 400, 'text/html'));
    const err = await svc.getMountainPasses(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect(String((err as McpError).data?.url)).not.toContain('?');
  });

  it('scrubs an upstream body that echoes the request query string', async () => {
    // ASP.NET error pages echo the request line — the credential must not ride back out in data.body.
    mockFetch.mockResolvedValue(
      makeResponse(
        `Server Error in '/Traffic' Application. GET /Traffic/api/x?AccessCode=${ACCESS_CODE} failed.`,
        500,
        'text/plain',
      ),
    );
    const err = await svc.getMountainPasses(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data?.body).toContain('[credential redacted]');
    // An echoed query parameter must not be mistaken for the upstream naming the credential.
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable' });
  });

  it('strips the query string when the network layer fails', async () => {
    // Bun and Node hang the requested URL off network errors as `error.path`.
    const networkError = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      {
        path: `https://www.wsdot.wa.gov/Traffic/api/x?AccessCode=${ACCESS_CODE}`,
        code: 'ConnectionRefused',
      },
    );
    mockFetch.mockRejectedValue(networkError);
    const err = await svc.getMountainPasses(createMockContext()).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable' });
  });

  it('classifies an upstream timeout as Timeout without the query string', async () => {
    const timeoutError = new Error('The operation timed out.');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValue(timeoutError);
    const err = await svc.getMountainPasses(createMockContext()).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
  });
});
