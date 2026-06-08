/**
 * @fileoverview Tests for TrafficApiService normalization logic: raw → domain type
 * mapping, HTTP error handling, HTML detection, and sparse upstream payloads.
 * All external HTTP is mocked — no real network calls.
 * @module tests/services/traffic-service.test
 */

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

import { TrafficApiService } from '@/services/traffic/traffic-service.js';

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
        Elevation: 3022,
        TemperatureInFahrenheit: 28,
        WeatherCondition: 'Snow',
        RoadCondition: 'Snow and Ice Covered',
        TravelAdvisoryActive: true,
        RestrictionOne: {
          TravelRestrictionComment: 'Traction Tires Required',
          RestrictionType: 'TractionsRequired',
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
    expect(p.restrictionOne?.comment).toBe('Traction Tires Required');
    expect(p.restrictionOne?.type).toBe('TractionsRequired');
    expect(p.latitude).toBe(47.4273);
    expect(p.longitude).toBe(-121.4128);
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [
      {
        MountainPassId: 2,
        MountainPassName: 'Blewett Pass',
        Elevation: null,
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

  it('omits restrictionOne when both comment and type are absent', async () => {
    const raw = [
      {
        MountainPassId: 3,
        MountainPassName: 'White Pass',
        RestrictionOne: { TravelRestrictionComment: null, RestrictionType: null },
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const passes = await svc.getMountainPasses(ctx);
    expect('restrictionOne' in passes[0]).toBe(false);
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
        CrossingName: 'Peace Arch',
        WaitTime: 25,
        UpdateTime: '/Date(1700000000000-0800)/',
        BorderCrossingLocation: {
          RoadName: 'I-5',
          Direction: 'N',
          MilePost: 275,
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
    expect(c.crossingName).toBe('Peace Arch');
    expect(c.waitTimeInMinutes).toBe(25);
    expect(c.location?.roadName).toBe('I-5');
    expect(c.location?.latitude).toBe(49.002);
  });

  it('omits location when BorderCrossingLocation is null', async () => {
    const raw = [{ CrossingName: 'Sumas', WaitTime: null, BorderCrossingLocation: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const crossings = await svc.getBorderCrossings(ctx);
    expect('location' in crossings[0]).toBe(false);
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

  it('throws serviceUnavailable on HTTP 401', async () => {
    mockFetch.mockResolvedValue(makeResponse('Unauthorized', 401, 'text/plain'));
    const ctx = createMockContext();
    await expect(svc.getMountainPasses(ctx)).rejects.toThrow(/401/);
  });

  it('throws serviceUnavailable when Content-Type is text/html', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html>Login</html>', 200, 'text/html'));
    const ctx = createMockContext();
    await expect(svc.getMountainPasses(ctx)).rejects.toThrow(/HTML page/);
  });

  it('throws serviceUnavailable when body is an HTML document (no CT header)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve('<!DOCTYPE html><html><body>Login</body></html>'),
    });
    const ctx = createMockContext();
    await expect(svc.getMountainPasses(ctx)).rejects.toThrow(/HTML content/);
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
