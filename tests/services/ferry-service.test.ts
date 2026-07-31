/**
 * @fileoverview Tests for FerryApiService normalization logic: raw → domain type
 * mapping, WCF date decoding, HTTP error handling, sparse upstream payloads,
 * schedule path selection, and terminal sailing space flattening.
 * All external HTTP is mocked — no real network calls.
 * @module tests/services/ferry-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { FerryApiService } from '@/services/ferry/ferry-service.js';

/**
 * Obviously-fake stand-in for the credential. It matches the value returned by the mocked
 * `getServerConfig` above, so a leak assertion checks the real thing the service builds URLs with.
 */
const ACCESS_CODE = 'test-access-code';

/** WSF's verbatim response body when the access code is not registered. */
const UNREGISTERED_CODE_BODY = {
  Message:
    "Use of WSDOT Traveler API failed.  Please make sure you've registered (at this location https://wsdot.wa.gov/traffic/api/) for a developer Access Code.  This value should then be passed with every service request.",
};

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

  it('rejects slash-format US dates (does not slip through to the upstream)', () => {
    expect(() => FerryApiService.toFerryDate('06/08/2026')).toThrow(/Invalid date/);
  });

  it('rejects an impossible YYYY-MM-DD date', () => {
    expect(() => FerryApiService.toFerryDate('2026-13-40')).toThrow(/Invalid date/);
  });
});

// ---------------------------------------------------------------------------
// FerryApiService.todayFerryDate — returns YYYY-MM-DD for today
// ---------------------------------------------------------------------------

describe('FerryApiService.todayFerryDate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a string matching YYYY-MM-DD format', () => {
    const today = FerryApiService.todayFerryDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the Washington/Pacific service date, not the UTC date, near the evening boundary', () => {
    // 2026-06-29T05:00:00Z is 2026-06-28 22:00 PDT — UTC has already rolled to the 29th while the
    // Washington service day is still the 28th. The default trip date must follow Pacific time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T05:00:00Z'));
    expect(FerryApiService.todayFerryDate()).toBe('2026-06-28');
    expect(FerryApiService.todayFerryDate()).not.toBe('2026-06-29');
  });

  it('tracks the Pacific date across a year boundary (PST, UTC-8)', () => {
    // 2026-01-01T05:00:00Z is 2025-12-31 21:00 PST.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T05:00:00Z'));
    expect(FerryApiService.todayFerryDate()).toBe('2025-12-31');
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

  it('does not surface a cancellation flag — no schedule endpoint publishes one', async () => {
    // WSF drops a cancelled sailing from the schedule rather than marking it, so an IsCancelled
    // key would be a promise the upstream cannot keep. Even when one appears, it is not mapped.
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Seattle',
            ArrivingTerminalName: 'Bainbridge Island',
            Times: [
              {
                DepartingTime: '/Date(1700000000000-0800)/',
                ArrivingTime: '/Date(1700002100000-0800)/',
                IsCancelled: true,
                VesselName: 'Yakima',
              },
            ],
          },
        ],
      }),
    );
    const ctx = createMockContext();
    const schedule = await svc.getSchedule(7, 3, '2026-05-23', false, ctx);
    expect(schedule.sailings).toHaveLength(1);
    expect('isCancelled' in schedule.sailings[0]).toBe(false);
    expect(schedule.sailings[0].vesselName).toBe('Yakima');
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

  it('omits date fields when the WCF value is the .NET MinValue sentinel', async () => {
    const raw = [
      {
        VesselID: 9,
        VesselName: 'Tacoma',
        LeftDock: '/Date(-62135568000000-0800)/',
        OpRouteAbbrev: [],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const vessels = await svc.getVesselLocations(ctx);
    expect('leftDock' in vessels[0]).toBe(false);
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
                TerminalID: 3,
                TerminalName: 'Bainbridge Island',
                ArrivalTerminalIDs: [3],
                DisplayDriveUpSpace: true,
                DisplayReservableSpace: true,
                DriveUpSpaceCount: 50,
                ReservableSpaceCount: 100,
                DriveUpSpaceHexColor: '#00FF00',
              },
              {
                TerminalID: 12,
                TerminalName: 'Kingston',
                ArrivalTerminalIDs: [12],
                DisplayDriveUpSpace: true,
                DisplayReservableSpace: false,
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
    expect(spaces[0].departingSpaces[0].itineraryLabel).toBe('Bainbridge Island');
    expect(spaces[0].departingSpaces[0].arrivingTerminalIds).toEqual([3]);
    expect(spaces[0].departingSpaces[0].displayReservableSpace).toBe(true);
    expect(spaces[0].departingSpaces[0].driveUpSpaceCount).toBe(50);
    expect(spaces[0].departingSpaces[1].itineraryLabel).toBe('Kingston');
    expect(spaces[0].departingSpaces[1].arrivingTerminalIds).toEqual([12]);
    expect(spaces[0].departingSpaces[1].displayReservableSpace).toBe(false);
  });

  it('derives destinations from ArrivalTerminalIDs on a multi-stop itinerary', async () => {
    // On San Juan sailings the nested TerminalID is the *departing* terminal and TerminalName is a
    // full itinerary string. Two entries can share that string while serving different terminals.
    const raw = [
      {
        TerminalID: 1,
        TerminalName: 'Anacortes',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            VesselName: 'Chelan',
            MaxSpaceCount: 144,
            SpaceForArrivalTerminals: [
              {
                TerminalID: 1,
                TerminalName: 'Anacortes -> Orcas Island -> Shaw Island -> Anacortes',
                ArrivalTerminalIDs: [15, 18, 13],
                DriveUpSpaceCount: 20,
              },
              {
                TerminalID: 1,
                TerminalName: 'Anacortes -> Orcas Island -> Shaw Island -> Anacortes',
                ArrivalTerminalIDs: [15, 18],
                DriveUpSpaceCount: 12,
              },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    const rows = spaces[0].departingSpaces;
    expect(rows).toHaveLength(2);
    // The departing terminal's ID never leaks into the destinations.
    expect(rows[0].arrivingTerminalIds).toEqual([15, 18, 13]);
    expect(rows[1].arrivingTerminalIds).toEqual([15, 18]);
    // The shared itinerary string is kept, but labelled as such rather than as a terminal name.
    expect(rows[0].itineraryLabel).toBe('Anacortes -> Orcas Island -> Shaw Island -> Anacortes');
    expect(rows[0].itineraryLabel).toBe(rows[1].itineraryLabel);
    expect('arrivingTerminalName' in rows[0]).toBe(false);
  });

  it('omits arrivingTerminalIds when upstream sends no arrival terminal IDs', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            SpaceForArrivalTerminals: [
              { TerminalName: 'Bainbridge Island', ArrivalTerminalIDs: null },
              { TerminalName: 'Bremerton', ArrivalTerminalIDs: [] },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    const rows = spaces[0].departingSpaces;
    expect(rows).toHaveLength(2);
    expect('arrivingTerminalIds' in rows[0]).toBe(false);
    expect('arrivingTerminalIds' in rows[1]).toBe(false);
  });

  it('floors negative space counts to zero', async () => {
    // Oversubscribed sailings report a negative remaining count upstream; a caller must not read
    // it as available capacity.
    const raw = [
      {
        TerminalID: 1,
        TerminalName: 'Anacortes',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            MaxSpaceCount: 139,
            SpaceForArrivalTerminals: [
              {
                TerminalName: 'Anacortes -> Friday Harbor',
                ArrivalTerminalIDs: [10],
                DriveUpSpaceCount: -14,
                ReservableSpaceCount: -3,
                DriveUpSpaceHexColor: '#FF0000',
              },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    const row = spaces[0].departingSpaces[0];
    expect(row.driveUpSpaceCount).toBe(0);
    expect(row.reservableSpaceCount).toBe(0);
    expect(row.maxSpaceCount).toBe(139);
  });

  it('leaves non-negative space counts untouched', async () => {
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            SpaceForArrivalTerminals: [
              {
                TerminalName: 'Bainbridge Island',
                ArrivalTerminalIDs: [3],
                DriveUpSpaceCount: 0,
                ReservableSpaceCount: 42,
              },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    const row = spaces[0].departingSpaces[0];
    expect(row.driveUpSpaceCount).toBe(0);
    expect(row.reservableSpaceCount).toBe(42);
  });

  it('maps the per-departure cancellation flag onto every arrival row', async () => {
    // Unlike the schedule feed, this endpoint does publish IsCancelled per departure — it must
    // survive changes to the surrounding space fields.
    const raw = [
      {
        TerminalID: 7,
        TerminalName: 'Seattle',
        DepartingSpaces: [
          {
            Departure: '/Date(1700000000000-0800)/',
            IsCancelled: true,
            SpaceForArrivalTerminals: [
              { TerminalName: 'Bainbridge Island', ArrivalTerminalIDs: [3] },
              { TerminalName: 'Bremerton', ArrivalTerminalIDs: [4] },
            ],
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);

    const rows = spaces[0].departingSpaces;
    expect(rows).toHaveLength(2);
    expect(rows[0].isCancelled).toBe(true);
    expect(rows[1].isCancelled).toBe(true);
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
    expect('itineraryLabel' in spaces[0].departingSpaces[0]).toBe(false);
    expect('arrivingTerminalIds' in spaces[0].departingSpaces[0]).toBe(false);
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

  it('resolves the api_unavailable contract on a non-2xx (reason + recovery hint)', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const ctx = createMockContext({ errors: getFerryTerminals.errors });
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({
      reason: 'api_unavailable',
      status: 503,
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
  });

  it('reads the WSF explanation on a 400 from an unregistered access code', async () => {
    // Before the fix the status check threw first and this body was discarded unread.
    mockFetch.mockResolvedValue(makeResponse(UNREGISTERED_CODE_BODY, 400));
    const ctx = createMockContext({ errors: getFerryTerminals.errors });
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).message).toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).message).toContain('Use of WSDOT Traveler API failed');
    expect((err as McpError).data).toMatchObject({
      reason: 'invalid_access_code',
      status: 400,
      recovery: { hint: expect.stringContaining('WSDOT_ACCESS_CODE') },
    });
  });

  it('classifies HTTP 401 as invalid_access_code naming WSDOT_ACCESS_CODE', async () => {
    mockFetch.mockResolvedValue(makeResponse('Unauthorized', 401, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).message).toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('leaves a 400 that is not about the access code as api_unavailable', async () => {
    // The schedule endpoint answers an invalid terminal pair with a 400 — a request fault,
    // not a credential fault, and the tool maps it to invalid_terminal_pair.
    mockFetch.mockResolvedValue(makeResponse({ Message: 'Invalid terminal pair.' }, 400));
    const ctx = createMockContext();
    const err = await svc.getSchedule(9999, 9998, '2026-05-23', false, ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).message).toMatch(/returned HTTP 400/);
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable', retryable: false });
  });

  it('treats an HTML page (Content-Type) as an access-code failure', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html>Login</html>', 200, 'text/html'));
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect((err as McpError).message).toMatch(/HTML page/);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('treats an HTML document body as an access-code failure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve('<!DOCTYPE html><html><body>Login</body></html>'),
    });
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect((err as McpError).message).toMatch(/HTML content/);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('throws validationError when API returns {"Message":"..."} body', async () => {
    const errorBody = { Message: 'Invalid terminal IDs provided.' };
    mockFetch.mockResolvedValue(makeResponse(errorBody));
    const ctx = createMockContext();
    await expect(svc.getSchedule(9999, 9998, '2026-05-23', false, ctx)).rejects.toThrow(
      /Invalid terminal IDs/,
    );
  });

  it('marks 4xx errors non-retryable (data.retryable === false)', async () => {
    mockFetch.mockResolvedValue(makeResponse('Bad Request', 400, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ retryable: false, status: 400 });
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

// ---------------------------------------------------------------------------
// Credential containment
// ---------------------------------------------------------------------------

describe('FerryApiService — access code never reaches the error payload', () => {
  let svc: FerryApiService;

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
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('strips the query string from data.url on a non-2xx', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data?.url).toBe(
      'https://www.wsdot.wa.gov/Ferries/API/Terminals/rest/terminalbasics',
    );
  });

  it('strips the query string on an access-code rejection', async () => {
    mockFetch.mockResolvedValue(makeResponse(UNREGISTERED_CODE_BODY, 400));
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect(String((err as McpError).data?.url)).not.toContain('?');
  });

  it('strips the query string from the HTTP 200 + {"Message"} validation error', async () => {
    mockFetch.mockResolvedValue(makeResponse({ Message: 'Invalid terminal IDs provided.' }));
    const err = await svc
      .getSchedule(9999, 9998, '2026-05-23', false, createMockContext())
      .catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect(String((err as McpError).data?.url)).not.toContain('?');
  });

  it('scrubs an upstream body that echoes the request query string', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        `Server Error. GET /Ferries/API/Terminals/rest/terminalbasics?apiaccesscode=${ACCESS_CODE} failed.`,
        500,
        'text/plain',
      ),
    );
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data?.body).toContain('[credential redacted]');
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable' });
  });

  it('strips the query string when the network layer fails', async () => {
    const networkError = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      {
        path: `https://www.wsdot.wa.gov/Ferries/API/Terminals/rest/terminalbasics?apiaccesscode=${ACCESS_CODE}`,
        code: 'ConnectionRefused',
      },
    );
    mockFetch.mockRejectedValue(networkError);
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable' });
  });

  it('classifies an upstream timeout as Timeout without the query string', async () => {
    const timeoutError = new Error('The operation timed out.');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValue(timeoutError);
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect(wirePayload(err)).not.toContain(ACCESS_CODE);
  });
});
