/**
 * @fileoverview Tests for FerryApiService normalization logic: raw → domain type
 * mapping, WCF date decoding, HTTP error handling, sparse upstream payloads,
 * schedule path selection, and terminal sailing space flattening.
 * All external HTTP is mocked — no real network calls.
 * @module tests/services/ferry-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { FerryApiService } from '@/services/ferry/ferry-service.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: unknown, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// FerryApiService.toFerryDate — static utility
// ---------------------------------------------------------------------------

describe('FerryApiService.toFerryDate', () => {
  it('returns YYYY-MM-DD from a valid ISO 8601 date', () => {
    expect(FerryApiService.toFerryDate('2026-05-23')).toBe('2026-05-23');
  });

  it('strips time component from full ISO datetime', () => {
    expect(FerryApiService.toFerryDate('2026-05-23T10:30:00Z')).toBe('2026-05-23');
  });

  it('strips leading/trailing whitespace', () => {
    expect(FerryApiService.toFerryDate('  2026-05-23  ')).toBe('2026-05-23');
  });

  it('throws validationError for an invalid date string', () => {
    expect(() => FerryApiService.toFerryDate('not-a-date')).toThrow(/Invalid date/);
  });

  it('throws validationError for empty string', () => {
    expect(() => FerryApiService.toFerryDate('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FerryApiService.todayFerryDate — returns YYYY-MM-DD for today
// ---------------------------------------------------------------------------

describe('FerryApiService.todayFerryDate', () => {
  it('returns a string matching YYYY-MM-DD format', () => {
    const today = FerryApiService.todayFerryDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the current date', () => {
    const today = FerryApiService.todayFerryDate();
    expect(today).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// getTerminals — normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getTerminals', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps all raw terminal fields to domain fields', async () => {
    const raw = [
      {
        TerminalID: 3,
        TerminalName: 'Bainbridge Island',
        TerminalAbbrev: 'BI',
        Latitude: 47.6237,
        Longitude: -122.5112,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].terminalId).toBe(3);
    expect(terminals[0].terminalName).toBe('Bainbridge Island');
    expect(terminals[0].terminalAbbrev).toBe('BI');
    expect(terminals[0].latitude).toBe(47.6237);
    expect(terminals[0].longitude).toBe(-122.5112);
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        TerminalAbbrev: null,
        Latitude: null,
        Longitude: null,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);
    const t = terminals[0];
    expect(t.terminalId).toBe(7);
    expect(t.terminalName).toBe('Seattle');
    expect('terminalAbbrev' in t).toBe(false);
    expect('latitude' in t).toBe(false);
    expect('longitude' in t).toBe(false);
  });

  it('falls back to defaults when TerminalID/Name are null', async () => {
    const raw = [{ TerminalID: null, TerminalName: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);
    expect(terminals[0].terminalId).toBe(0);
    expect(terminals[0].terminalName).toBe('Unknown');
  });

  it('returns empty array when API returns []', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);
    expect(terminals).toHaveLength(0);
  });

  it('returns empty array when API returns null', async () => {
    mockFetch.mockResolvedValue(makeResponse(null));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);
    expect(terminals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getRoutes — normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getRoutes', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps all raw route fields to domain fields', async () => {
    const raw = [{ RouteID: 1, RouteAbbrev: 'SEA-BI', Description: 'Seattle/Bainbridge Island' }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const routes = await svc.getRoutes('2026-05-23', ctx);

    expect(routes).toHaveLength(1);
    expect(routes[0].routeId).toBe(1);
    expect(routes[0].routeAbbrev).toBe('SEA-BI');
    expect(routes[0].description).toBe('Seattle/Bainbridge Island');
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [{ RouteID: null, RouteAbbrev: null, Description: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const routes = await svc.getRoutes('2026-05-23', ctx);
    expect('routeId' in routes[0]).toBe(false);
    expect('routeAbbrev' in routes[0]).toBe(false);
    expect('description' in routes[0]).toBe(false);
  });

  it('includes the trip date in the request URL', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getRoutes('2026-05-23', ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('2026-05-23');
  });
});

// ---------------------------------------------------------------------------
// getSchedule — path selection and normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getSchedule', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  const scheduleRaw = {
    TerminalCombos: [
      {
        DepartingTerminalName: 'Seattle',
        ArrivingTerminalName: 'Bainbridge Island',
        Times: [
          {
            DepartingTime: '/Date(1700000000000-0800)/',
            ArrivingTime: '/Date(1700002100000-0800)/',
            IsCancelled: false,
            VesselName: 'Yakima',
          },
        ],
      },
    ],
  };

  it('uses scheduletoday path when tripDate is today', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    const today = FerryApiService.todayFerryDate();
    await svc.getSchedule(7, 3, today, false, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('scheduletoday');
  });

  it('uses schedule path for a future date', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', false, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/schedule/2027-01-01/');
  });

  it('passes remainingOnly=true in URL for today', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    const today = FerryApiService.todayFerryDate();
    await svc.getSchedule(7, 3, today, true, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('scheduletoday/7/3/true');
  });

  it('ignores remainingOnly=true for a future date — uses schedule path', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', true, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/schedule/2027-01-01/');
    expect(url).not.toContain('scheduletoday');
  });

  it('includes terminal IDs in URL', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', false, ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('7');
    expect(url).toContain('3');
  });

  it('extracts terminal names from TerminalCombos', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    const schedule = await svc.getSchedule(7, 3, '2026-05-23', false, ctx);
    expect(schedule.departingTerminalName).toBe('Seattle');
    expect(schedule.arrivingTerminalName).toBe('Bainbridge Island');
  });

  it('decodes WCF dates in sailing times', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    const schedule = await svc.getSchedule(7, 3, '2026-05-23', false, ctx);
    expect(schedule.sailings[0].departureTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(schedule.sailings[0].arrivalTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty sailings array when TerminalCombos is empty', async () => {
    mockFetch.mockResolvedValue(makeResponse({ TerminalCombos: [] }));
    const ctx = createMockContext();
    const schedule = await svc.getSchedule(7, 3, '2026-05-23', false, ctx);
    expect(schedule.sailings).toHaveLength(0);
  });

  it('handles null TerminalCombos', async () => {
    mockFetch.mockResolvedValue(makeResponse({ TerminalCombos: null }));
    const ctx = createMockContext();
    const schedule = await svc.getSchedule(7, 3, '2026-05-23', false, ctx);
    expect(schedule.sailings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getVesselLocations — normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getVesselLocations', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps all raw vessel fields to domain fields', async () => {
    const raw = [
      {
        VesselID: 20,
        VesselName: 'Yakima',
        InService: true,
        AtDock: false,
        DepartingTerminalID: 7,
        DepartingTerminalName: 'Seattle',
        ArrivingTerminalID: 3,
        ArrivingTerminalName: 'Bainbridge Island',
        Latitude: 47.5938,
        Longitude: -122.4699,
        Speed: 12.5,
        Heading: 270,
        LeftDock: '/Date(1700000000000-0800)/',
        Eta: '/Date(1700002100000-0800)/',
        ScheduledDeparture: '/Date(1700000000000-0800)/',
        OpRouteAbbrev: ['SEA-BI'],
        TimeStamp: '/Date(1700000000000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const vessels = await svc.getVesselLocations(ctx);

    expect(vessels).toHaveLength(1);
    const v = vessels[0];
    expect(v.vesselId).toBe(20);
    expect(v.vesselName).toBe('Yakima');
    expect(v.inService).toBe(true);
    expect(v.atDock).toBe(false);
    expect(v.speed).toBe(12.5);
    expect(v.heading).toBe(270);
    expect(v.opRouteAbbrev).toEqual(['SEA-BI']);
    // WCF dates decoded to ISO 8601
    expect(v.leftDock).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(v.eta).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('opRouteAbbrev defaults to [] when null', async () => {
    const raw = [{ VesselID: 5, VesselName: 'Wenatchee', OpRouteAbbrev: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const vessels = await svc.getVesselLocations(ctx);
    expect(vessels[0].opRouteAbbrev).toEqual([]);
  });

  it('omits boolean fields when raw values are null', async () => {
    const raw = [
      { VesselID: 5, VesselName: 'Wenatchee', InService: null, AtDock: null, OpRouteAbbrev: [] },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const vessels = await svc.getVesselLocations(ctx);
    expect('inService' in vessels[0]).toBe(false);
    expect('atDock' in vessels[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTerminalSailingSpace — flattening logic
// ---------------------------------------------------------------------------

describe('FerryApiService.getTerminalSailingSpace', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('flattens SpaceForArrivalTerminals into one row per arrival terminal', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            IsCancelled: false,
            VesselName: 'Yakima',
            MaxSpaceCount: 202,
            SpaceForArrivalTerminals: [
              {
                TerminalName: 'Bainbridge Island',
                DriveUpSpaceCount: 50,
                ReservableSpaceCount: 100,
                DriveUpSpaceHexColor: '#00FF00',
              },
              {
                TerminalName: 'Kingston',
                DriveUpSpaceCount: 30,
                ReservableSpaceCount: 80,
                DriveUpSpaceHexColor: '#FFFF00',
              },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    expect(spaces).toHaveLength(1);
    expect(spaces[0].terminalId).toBe(7);
    // One entry per arrival terminal
    expect(spaces[0].departingSpaces).toHaveLength(2);
    expect(spaces[0].departingSpaces[0].arrivingTerminalName).toBe('Bainbridge Island');
    expect(spaces[0].departingSpaces[0].driveUpSpaceCount).toBe(50);
    expect(spaces[0].departingSpaces[1].arrivingTerminalName).toBe('Kingston');
  });

  it('emits a single row with vessel info when SpaceForArrivalTerminals is empty', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            VesselName: 'Yakima',
            MaxSpaceCount: 202,
            SpaceForArrivalTerminals: [],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);
    expect(spaces[0].departingSpaces).toHaveLength(1);
    expect(spaces[0].departingSpaces[0].vesselName).toBe('Yakima');
    expect('arrivingTerminalName' in spaces[0].departingSpaces[0]).toBe(false);
  });

  it('decodes WCF dates in departure times', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            SpaceForArrivalTerminals: [{ TerminalName: 'BI', DriveUpSpaceCount: 50 }],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);
    expect(spaces[0].departingSpaces[0].departure).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty departingSpaces array when DepartingSpaces is null', async () => {
    const raw = [{ TerminalID: 7, TerminalName: 'Seattle', DepartingSpaces: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);
    expect(spaces[0].departingSpaces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAlerts — normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getAlerts', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('maps BulletinID to alertId and RouteAlertText to alertDescription', async () => {
    const raw = [
      {
        BulletinID: 201,
        RouteAlertText: 'Vessel out of service.',
        AffectedRouteIDs: [1, 2],
        PublishDate: '/Date(1700000000000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);

    expect(alerts[0].alertId).toBe(201);
    expect(alerts[0].alertDescription).toBe('Vessel out of service.');
    expect(alerts[0].impactedRouteIds).toEqual([1, 2]);
    expect(alerts[0].publishDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to AlertFullTitle when RouteAlertText is absent', async () => {
    const raw = [
      {
        BulletinID: 202,
        RouteAlertText: null,
        AlertFullTitle: 'Maintenance Notice',
        AffectedRouteIDs: [],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);
    expect(alerts[0].alertDescription).toBe('Maintenance Notice');
  });

  it('impactedRouteIds defaults to [] when AffectedRouteIDs is null', async () => {
    const raw = [{ BulletinID: 203, AffectedRouteIDs: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);
    expect(alerts[0].impactedRouteIds).toEqual([]);
  });

  it('returns empty array when API returns []', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);
    expect(alerts).toHaveLength(0);
  });

  it('returns empty array when API returns null', async () => {
    mockFetch.mockResolvedValue(makeResponse(null));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);
    expect(alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP error handling
// ---------------------------------------------------------------------------

describe('FerryApiService — HTTP error handling', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('throws serviceUnavailable on HTTP 503', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const ctx = createMockContext();
    await expect(svc.getTerminals(ctx)).rejects.toThrow(/503/);
  });

  it('throws serviceUnavailable when Content-Type is text/html', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html>Login</html>', 200, 'text/html'));
    const ctx = createMockContext();
    await expect(svc.getTerminals(ctx)).rejects.toThrow(/HTML page/);
  });

  it('throws serviceUnavailable when body is an HTML document', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve('<!DOCTYPE html><html><body>Login</body></html>'),
    });
    const ctx = createMockContext();
    await expect(svc.getTerminals(ctx)).rejects.toThrow(/HTML content/);
  });

  it('throws validationError when API returns {"Message":"..."} body', async () => {
    const errorBody = { Message: 'Invalid terminal IDs provided.' };
    mockFetch.mockResolvedValue(makeResponse(errorBody));
    const ctx = createMockContext();
    await expect(svc.getSchedule(9999, 9998, '2026-05-23', false, ctx)).rejects.toThrow(
      /Invalid terminal IDs/,
    );
  });

  it('appends apiaccesscode to every request URL', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getTerminals(ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('apiaccesscode=test-access-code');
  });

  it('uses ferry BASE_URL prefix', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getTerminals(ctx);
    const url: string = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://www.wsdot.wa.gov/Ferries/API');
  });
});
