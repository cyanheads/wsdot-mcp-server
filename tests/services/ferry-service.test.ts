/**
 * @fileoverview Tests for FerryApiService normalization logic: raw → domain type
 * mapping, WCF date decoding, HTTP error handling, sparse upstream payloads,
 * schedule path selection, and terminal sailing space flattening.
 * All external HTTP is mocked — no real network calls.
 * @module tests/services/ferry-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { FerryApiService } from '@/services/ferry/ferry-service.js';
import { nth } from '../helpers/assertions.js';
import {
  DISABILITY_LINE,
  FARES_DATE_REJECTION,
  FARES_PAIR_REJECTION,
  FARES_TRIP_DATE,
  fareLineItems,
  TERMINAL_COMBOS,
} from '../helpers/wsf-fares.js';
import {
  DATE_ROLLED_REJECTION,
  PAIR_REJECTION_1111,
  scheduleCapture,
} from '../helpers/wsf-schedule.js';

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

/**
 * A request no test stubbed rejects, naming the endpoint (query string dropped, so the credential
 * never enters the message). The file-level reset below restores this default before every test,
 * so one test's `mockResolvedValue` cannot answer a later test's request.
 */
const mockFetch = vi.fn<(url: string | URL | Request) => Promise<unknown>>((url) =>
  Promise.reject(new Error(`Unstubbed fetch: ${String(url).split('?')[0]}`)),
);
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function makeResponse(body: unknown, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** WSF's cache-flush stamp — a bare WCF date string, served JSON-encoded. */
const FLUSH_STAMP = '/Date(1790284800913-0700)/';

/** The cache-flush response carrying `stamp`. */
const flushResponse = (stamp = FLUSH_STAMP) => makeResponse(JSON.stringify(stamp));

/** 2026-11-12 12:00 PST — "today" is 11/12, hours past the previous service day's last sailing. */
const PACIFIC_NOON = new Date('2026-11-12T20:00:00Z');

/** Answer each request with the response of the first entry whose path fragment its URL contains. */
function stubByPath(table: [fragment: string, response: ReturnType<typeof makeResponse>][]) {
  mockFetch.mockImplementation((url) => {
    const path = String(url).split('?')[0] ?? '';
    const hit = table.find(([fragment]) => path.includes(fragment));
    return hit ? Promise.resolve(hit[1]) : Promise.reject(new Error(`Unstubbed fetch: ${path}`));
  });
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
    expect(nth(terminals).terminalId).toBe(3);
    expect(nth(terminals).terminalName).toBe('Bainbridge Island');
    expect(nth(terminals).terminalAbbrev).toBe('BI');
    expect(nth(terminals).latitude).toBe(47.6237);
    expect(nth(terminals).longitude).toBe(-122.5112);
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
    const t = nth(terminals);
    expect(t.terminalId).toBe(7);
    expect(t.terminalName).toBe('Seattle');
    expect('terminalAbbrev' in t).toBe(false);
    expect('latitude' in t).toBe(false);
    expect('longitude' in t).toBe(false);
  });

  it('keeps a terminal with no ID or name without fabricating either', async () => {
    const raw = [
      { TerminalID: null, TerminalName: null, TerminalAbbrev: 'COU' },
      { Latitude: 48.1597, Longitude: -122.6725 },
      { TerminalID: 11, TerminalName: '  ' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const terminals = await svc.getTerminals(ctx);
    expect(terminals).toEqual([
      { terminalAbbrev: 'COU' },
      { latitude: 48.1597, longitude: -122.6725 },
      { terminalId: 11 },
    ]);
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
    stubByPath([
      ['/routes/', makeResponse(raw)],
      ['/cacheflushdate', flushResponse()],
      ['/terminalsandmatesbyroute/', makeResponse([])],
    ]);
    const ctx = createMockContext();
    const routes = await svc.getRoutes('2026-05-23', ctx);

    expect(routes).toHaveLength(1);
    expect(nth(routes).routeId).toBe(1);
    expect(nth(routes).routeAbbrev).toBe('SEA-BI');
    expect(nth(routes).description).toBe('Seattle/Bainbridge Island');
  });

  it('omits optional fields when raw values are null', async () => {
    const raw = [{ RouteID: null, RouteAbbrev: null, Description: null }];
    stubByPath([
      ['/routes/', makeResponse(raw)],
      ['/cacheflushdate', flushResponse()],
    ]);
    const ctx = createMockContext();
    const routes = await svc.getRoutes('2026-05-23', ctx);
    expect('routeId' in nth(routes)).toBe(false);
    expect('routeAbbrev' in nth(routes)).toBe(false);
    expect('description' in nth(routes)).toBe(false);
  });

  it('includes the trip date in the request URL', async () => {
    stubByPath([
      ['/routes/', makeResponse([])],
      ['/cacheflushdate', flushResponse()],
    ]);
    const ctx = createMockContext();
    await svc.getRoutes('2026-05-23', ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('/Schedule/rest/routes/2026-05-23?');
  });
});

// ---------------------------------------------------------------------------
// getRoutes — the terminal pairs each route serves
// ---------------------------------------------------------------------------

describe('FerryApiService.getRoutes — terminal pairs', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    svc = new FerryApiService({} as never, {} as never);
  });

  const ROUTES = [
    { RouteID: 5, RouteAbbrev: 'sea-bi', Description: 'Seattle / Bainbridge Island' },
    { RouteID: 9, RouteAbbrev: 'ana-sj', Description: 'Anacortes / San Juan Islands' },
    { RouteID: 21, RouteAbbrev: 'x', Description: 'A route with no pairs today' },
  ];

  const PAIRS: Record<number, unknown> = {
    5: [
      {
        DepartingTerminalID: 3,
        DepartingDescription: 'Bainbridge Island',
        ArrivingTerminalID: 7,
        ArrivingDescription: 'Seattle',
      },
      {
        DepartingTerminalID: 7,
        DepartingDescription: 'Seattle',
        ArrivingTerminalID: 3,
        ArrivingDescription: 'Bainbridge Island',
      },
    ],
    9: [
      {
        DepartingTerminalID: 15,
        DepartingDescription: 'Orcas Island ',
        ArrivingTerminalID: 18,
        ArrivingDescription: '  ',
      },
      // A pair missing a terminal ID cannot be passed to the schedule tool, so it is not listed.
      { DepartingTerminalID: 15, DepartingDescription: 'Orcas Island' },
    ],
    21: [],
  };

  /** Serve routes, a flush stamp, and per-route pairs; count the pair lookups by route. */
  function stubFerry(options: { flush?: () => string; routes?: unknown[] } = {}) {
    const lookups: number[] = [];
    mockFetch.mockImplementation((url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/Schedule/rest/routes/')) {
        return Promise.resolve(makeResponse(options.routes ?? ROUTES));
      }
      if (path.endsWith('/Schedule/rest/cacheflushdate')) {
        return Promise.resolve(flushResponse(options.flush?.()));
      }
      const byRoute = /\/terminalsandmatesbyroute\/(\d{4}-\d{2}-\d{2})\/(\d+)$/.exec(path);
      if (byRoute) {
        const routeId = Number(byRoute[2]);
        lookups.push(routeId);
        return Promise.resolve(makeResponse(PAIRS[routeId] ?? []));
      }
      return Promise.reject(new Error(`Unstubbed fetch: ${path}`));
    });
    return lookups;
  }

  it('looks up each route’s pairs for the trip date and maps them', async () => {
    const lookups = stubFerry();
    const routes = await svc.getRoutes('2026-09-25', createMockContext());

    expect(lookups.sort((a, b) => a - b)).toEqual([5, 9, 21]);
    const byRouteUrls = mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('terminalsandmatesbyroute'));
    for (const url of byRouteUrls) {
      expect(url).toMatch(/\/Schedule\/rest\/terminalsandmatesbyroute\/2026-09-25\/\d+\?/);
    }
    expect(routes).toEqual([
      {
        routeId: 5,
        routeAbbrev: 'sea-bi',
        description: 'Seattle / Bainbridge Island',
        terminalPairs: [
          {
            departingTerminalId: 3,
            departingTerminalName: 'Bainbridge Island',
            arrivingTerminalId: 7,
            arrivingTerminalName: 'Seattle',
          },
          {
            departingTerminalId: 7,
            departingTerminalName: 'Seattle',
            arrivingTerminalId: 3,
            arrivingTerminalName: 'Bainbridge Island',
          },
        ],
      },
      {
        routeId: 9,
        routeAbbrev: 'ana-sj',
        description: 'Anacortes / San Juan Islands',
        // Padded name trimmed, blank name dropped, ID-less pair dropped.
        terminalPairs: [
          {
            departingTerminalId: 15,
            departingTerminalName: 'Orcas Island',
            arrivingTerminalId: 18,
          },
        ],
      },
      {
        routeId: 21,
        routeAbbrev: 'x',
        description: 'A route with no pairs today',
        terminalPairs: [],
      },
    ]);
  });

  it('gives a route whose pair lookup returns null an empty list, not a failure', async () => {
    mockFetch.mockImplementation((url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return Promise.resolve(makeResponse([ROUTES[0]]));
      if (path.endsWith('/cacheflushdate')) return Promise.resolve(flushResponse());
      return Promise.resolve(makeResponse(null));
    });
    const routes = await svc.getRoutes('2026-09-25', createMockContext());
    expect(nth(routes).terminalPairs).toEqual([]);
  });

  it('carries no terminalPairs for a route with no ID, and looks nothing up for it', async () => {
    const lookups = stubFerry({ routes: [{ RouteAbbrev: 'anon', Description: 'No ID' }] });
    const routes = await svc.getRoutes('2026-09-25', createMockContext());
    expect(routes).toEqual([{ routeAbbrev: 'anon', description: 'No ID' }]);
    expect(lookups).toEqual([]);
  });

  it('makes no pair lookup and no flush check when the date lists no routes', async () => {
    const lookups = stubFerry({ routes: [] });
    expect(await svc.getRoutes('2027-01-15', createMockContext())).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it('answers a repeat call for the same date from the cache while the flush stamp holds', async () => {
    const lookups = stubFerry();
    const first = await svc.getRoutes('2026-09-25', createMockContext());
    expect(lookups).toHaveLength(3);

    mockFetch.mockClear();
    const second = await svc.getRoutes('2026-09-25', createMockContext());
    expect(second).toEqual(first);
    expect(lookups).toHaveLength(3);
    const paths = mockFetch.mock.calls.map(([url]) => String(url).split('?')[0]);
    expect(paths).toEqual([
      'https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/routes/2026-09-25',
      'https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/cacheflushdate',
    ]);
  });

  it('looks the pairs up again once the flush stamp changes', async () => {
    let stamp = FLUSH_STAMP;
    const lookups = stubFerry({ flush: () => stamp });
    await svc.getRoutes('2026-09-25', createMockContext());
    await svc.getRoutes('2026-09-25', createMockContext());
    expect(lookups).toHaveLength(3);

    stamp = '/Date(1790371200000-0700)/';
    await svc.getRoutes('2026-09-25', createMockContext());
    expect(lookups).toHaveLength(6);
    await svc.getRoutes('2026-09-25', createMockContext());
    expect(lookups).toHaveLength(6);
  });

  it('caches per trip date — another date gets its own lookups', async () => {
    const lookups = stubFerry();
    await svc.getRoutes('2026-09-25', createMockContext());
    await svc.getRoutes('2026-09-27', createMockContext());
    expect(lookups).toHaveLength(6);
    const dates = mockFetch.mock.calls
      .map(([url]) => /terminalsandmatesbyroute\/([\d-]+)\//.exec(String(url))?.[1])
      .filter(Boolean);
    expect(new Set(dates)).toEqual(new Set(['2026-09-25', '2026-09-27']));
  });

  it('fails the whole call when one pair lookup fails — no partial route list', async () => {
    mockFetch.mockImplementation((url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return Promise.resolve(makeResponse(ROUTES));
      if (path.endsWith('/cacheflushdate')) return Promise.resolve(flushResponse());
      if (path.endsWith('/9')) {
        return Promise.resolve(makeResponse('Service Unavailable', 503, 'text/plain'));
      }
      return Promise.resolve(makeResponse([]));
    });
    const err = (await svc
      .getRoutes('2026-09-25', createMockContext())
      .catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({
      reason: 'api_unavailable',
      status: 503,
      url: 'https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/terminalsandmatesbyroute/2026-09-25/9',
    });
  });

  it('classifies an access-code rejection on a pair lookup as invalid_access_code', async () => {
    mockFetch.mockImplementation((url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return Promise.resolve(makeResponse(ROUTES));
      if (path.endsWith('/cacheflushdate')) return Promise.resolve(flushResponse());
      return Promise.resolve(makeResponse(UNREGISTERED_CODE_BODY, 400));
    });
    const err = (await svc
      .getRoutes('2026-09-25', createMockContext())
      .catch((e) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(err.data).toMatchObject({ reason: 'invalid_access_code' });
  });

  it('does not cache pairs a call fetched under a flush stamp that changed before they arrived', async () => {
    /** Pairs WSF serves for route 5 before and after its schedule flush. */
    const before = [{ DepartingTerminalID: 3, ArrivingTerminalID: 7 }];
    const after = [{ DepartingTerminalID: 7, ArrivingTerminalID: 3 }];
    let stamp = FLUSH_STAMP;
    let pairs: unknown = before;
    let releaseHeld: (() => void) | undefined;
    let holdNext = true;
    mockFetch.mockImplementation(async (url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return makeResponse([ROUTES[0]]);
      if (path.endsWith('/cacheflushdate')) return flushResponse(stamp);
      // The first lookup answers with the pre-flush pairs, but only once the test releases it.
      const body = pairs;
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
      }
      return makeResponse(body);
    });

    const slow = svc.getRoutes('2026-09-25', createMockContext());
    await vi.waitFor(() => expect(releaseHeld).toBeDefined());

    // WSF flushes; a second call reads the new stamp and caches the new pairs.
    stamp = '/Date(1790371200000-0700)/';
    pairs = after;
    const fresh = await svc.getRoutes('2026-09-25', createMockContext());
    expect(nth(fresh).terminalPairs).toEqual([{ departingTerminalId: 7, arrivingTerminalId: 3 }]);

    // The slow call's pre-flush lookup lands last.
    releaseHeld?.();
    await slow;

    const next = await svc.getRoutes('2026-09-25', createMockContext());
    expect(nth(next).terminalPairs).toEqual([{ departingTerminalId: 7, arrivingTerminalId: 3 }]);
  });

  it('serves concurrent calls for the same date the same pairs', async () => {
    const lookups = stubFerry();
    const [a, b] = await Promise.all([
      svc.getRoutes('2026-09-25', createMockContext()),
      svc.getRoutes('2026-09-25', createMockContext()),
    ]);
    expect(a).toEqual(b);
    expect(nth(a).terminalPairs).toHaveLength(2);
    // Both calls missed the empty cache, so each looked every route up once.
    expect(lookups).toHaveLength(6);
    await svc.getRoutes('2026-09-25', createMockContext());
    expect(lookups).toHaveLength(6);
  });

  it('caches the routes a failed call did look up, and looks up only the rest again', async () => {
    let fail = true;
    const lookups: number[] = [];
    const many = Array.from({ length: 7 }, (_, i) => ({ RouteID: i + 1, Description: `R${i}` }));
    mockFetch.mockImplementation(async (url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return makeResponse(many);
      if (path.endsWith('/cacheflushdate')) return flushResponse();
      const routeId = Number(path.split('/').at(-1));
      lookups.push(routeId);
      // Route 7 sits in the second batch of five.
      if (routeId === 7 && fail) return makeResponse('Service Unavailable', 503, 'text/plain');
      return makeResponse([{ DepartingTerminalID: routeId, ArrivingTerminalID: routeId + 100 }]);
    });

    await expect(svc.getRoutes('2026-09-25', createMockContext())).rejects.toBeInstanceOf(McpError);
    expect(lookups.toSorted((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    fail = false;
    lookups.length = 0;
    const routes = await svc.getRoutes('2026-09-25', createMockContext());
    // The first batch completed and was cached; the failed batch is looked up again in full.
    expect(lookups.toSorted((x, y) => x - y)).toEqual([6, 7]);
    for (const r of routes) {
      expect(r.terminalPairs).toEqual([
        { departingTerminalId: r.routeId, arrivingTerminalId: (r.routeId ?? 0) + 100 },
      ]);
    }
  });

  it('keeps at most five pair lookups in flight', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ RouteID: i + 1, Description: `R${i}` }));
    let inFlight = 0;
    let peak = 0;
    mockFetch.mockImplementation(async (url) => {
      const path = String(url).split('?')[0] ?? '';
      if (path.includes('/routes/')) return makeResponse(many);
      if (path.endsWith('/cacheflushdate')) return flushResponse();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return makeResponse([]);
    });
    const routes = await svc.getRoutes('2026-09-25', createMockContext());
    expect(routes).toHaveLength(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// getSchedule — path selection and normalization
// ---------------------------------------------------------------------------

describe('FerryApiService.getSchedule', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Noon Pacific: a same-day query outside the hours that also read the previous service day.
    vi.useFakeTimers();
    vi.setSystemTime(PACIFIC_NOON);
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

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
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('scheduletoday');
  });

  it('uses schedule path for a future date', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', false, ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('/schedule/2027-01-01/');
  });

  it('passes remainingOnly=true in URL for today', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    const today = FerryApiService.todayFerryDate();
    await svc.getSchedule(7, 3, today, true, ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('scheduletoday/7/3/true');
  });

  it('ignores remainingOnly=true for a future date — uses schedule path', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', true, ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('/schedule/2027-01-01/');
    expect(url).not.toContain('scheduletoday');
  });

  it('includes terminal IDs in URL', async () => {
    mockFetch.mockResolvedValue(makeResponse(scheduleRaw));
    const ctx = createMockContext();
    await svc.getSchedule(7, 3, '2027-01-01', false, ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
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
    expect(nth(schedule.sailings).departureTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(nth(schedule.sailings).arrivalTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    expect('isCancelled' in nth(schedule.sailings)).toBe(false);
    expect(nth(schedule.sailings).vesselName).toBe('Yakima');
  });
});

// ---------------------------------------------------------------------------
// getSchedule — per-sailing loading rule, vessel, and annotations
// ---------------------------------------------------------------------------

describe('FerryApiService.getSchedule — loading rule, vessel, and annotations', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    svc = new FerryApiService({} as never, {} as never);
  });

  const sailing = (overrides: Record<string, unknown>) => ({
    DepartingTime: '/Date(1790344200000-0700)/',
    ArrivingTime: '/Date(1790345100000-0700)/',
    VesselName: 'Chelan',
    VesselPositionNum: 1,
    Routes: [9],
    ...overrides,
  });

  it('maps each sailing’s loading rule, vessel ID, and accessibility on a pair that mixes rules', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Orcas Island',
            ArrivingTerminalName: 'Shaw Island',
            Annotations: ['No interisland vehicles. Foot passenger and bikes okay.'],
            Times: [
              sailing({
                LoadingRule: 3,
                VesselID: 2,
                VesselHandicapAccessible: true,
                AnnotationIndexes: [],
              }),
              sailing({
                LoadingRule: 1,
                VesselID: 38,
                VesselName: 'Yakima',
                VesselHandicapAccessible: false,
                AnnotationIndexes: [0],
              }),
            ],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(15, 18, '2026-09-25', false, createMockContext());
    expect(schedule.annotations).toEqual([
      'No interisland vehicles. Foot passenger and bikes okay.',
    ]);
    expect(schedule.sailings).toEqual([
      {
        departureTime: '2026-09-25T13:50:00.000Z',
        departureTimeLocal: '2026-09-25T06:50:00.000-07:00',
        arrivalTime: '2026-09-25T14:05:00.000Z',
        arrivalTimeLocal: '2026-09-25T07:05:00.000-07:00',
        serviceDate: '2026-09-25',
        vesselName: 'Chelan',
        vesselId: 2,
        loadingRule: 3,
        vesselHandicapAccessible: true,
        annotationIndexes: [],
      },
      {
        departureTime: '2026-09-25T13:50:00.000Z',
        departureTimeLocal: '2026-09-25T06:50:00.000-07:00',
        arrivalTime: '2026-09-25T14:05:00.000Z',
        arrivalTimeLocal: '2026-09-25T07:05:00.000-07:00',
        serviceDate: '2026-09-25',
        vesselName: 'Yakima',
        vesselId: 38,
        loadingRule: 1,
        vesselHandicapAccessible: false,
        annotationIndexes: [0],
      },
    ]);
    // Undocumented upstream fields stay out.
    expect(JSON.stringify(schedule)).not.toMatch(/VesselPositionNum|vesselPositionNum|routes/);
  });

  it('normalizes the HTML in both note fields to plain text, keeping link destinations', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Kingston',
            ArrivingTerminalName: 'Edmonds',
            SailingNotes:
              '<p><a href="https://tinyurl.com/mptshczh" target="_blank" rel="noopener noreferrer">Boarding pass required for vehicles</a> 8 a.m.–8 p.m. to hold your place in line at Kingston. Ferry tickets sold separately.</p>',
            Annotations: [
              'The 5:30am sailing from Kingston will operate approximately 10 minutes late.',
              '<a href="https://tinyurl.com/mptshczh">Boarding Pass</a> required for vehicles.',
              'Loads foot passengers, motorcycles, and pre-registered carpools and vanpools <i>only</i>.',
            ],
            Times: [sailing({ AnnotationIndexes: [0, 1, 2] })],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(12, 8, '2026-09-25', false, createMockContext());
    expect(schedule.sailingNotes).toBe(
      'Boarding pass required for vehicles (https://tinyurl.com/mptshczh) 8 a.m.–8 p.m. to hold your place in line at Kingston. Ferry tickets sold separately.',
    );
    expect(schedule.annotations).toEqual([
      'The 5:30am sailing from Kingston will operate approximately 10 minutes late.',
      'Boarding Pass (https://tinyurl.com/mptshczh) required for vehicles.',
      'Loads foot passengers, motorcycles, and pre-registered carpools and vanpools only.',
    ]);
    expect(JSON.stringify(schedule)).not.toMatch(/<[a-z/]/i);
  });

  it('drops blank annotations and remaps every index onto the entries kept', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            SailingNotes: '<p>&nbsp;</p>',
            Annotations: ['First.', '  ', '<p></p>', 'Fourth.'],
            Times: [
              sailing({ AnnotationIndexes: [0, 3] }),
              sailing({ AnnotationIndexes: [1, 2] }),
              // An index past the end resolves to nothing, so it is not carried.
              sailing({ AnnotationIndexes: [3, 7] }),
            ],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(15, 18, '2026-09-25', false, createMockContext());
    expect(schedule.annotations).toEqual(['First.', 'Fourth.']);
    expect(schedule.sailings.map((s) => s.annotationIndexes)).toEqual([[0, 1], [], [1]]);
    expect('sailingNotes' in schedule).toBe(false);
    for (const s of schedule.sailings) {
      for (const i of s.annotationIndexes ?? []) expect(schedule.annotations?.[i]).toBeDefined();
    }
  });

  it('keeps every remapped index on the text it pointed at — duplicates too — and drops ones that point at nothing', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            Annotations: ['', 'Second.', ' ', 'Fourth.', '<br>', 'Sixth.'],
            Times: [
              sailing({ AnnotationIndexes: [5, 1, 5] }),
              sailing({ AnnotationIndexes: [-1, 1.5, 6, 0, 2, 4] }),
              sailing({ AnnotationIndexes: [3] }),
            ],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(15, 18, '2026-09-25', false, createMockContext());
    const resolved = schedule.sailings.map((s) =>
      (s.annotationIndexes ?? []).map((i) => schedule.annotations?.[i]),
    );
    expect(resolved).toEqual([['Sixth.', 'Second.', 'Sixth.'], [], ['Fourth.']]);
  });

  it('gives a sailing no indexes when the pair sends indexes but no annotations', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ TerminalCombos: [{ Times: [sailing({ AnnotationIndexes: [0, 1] })] }] }),
    );
    const schedule = await svc.getSchedule(15, 18, '2026-09-25', false, createMockContext());
    expect('annotations' in schedule).toBe(false);
    expect(nth(schedule.sailings).annotationIndexes).toEqual([]);
  });

  it('omits every new field from a sparse payload that sends none of them', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Seattle',
            ArrivingTerminalName: 'Bainbridge Island',
            Times: [{ DepartingTime: '/Date(1790344200000-0700)/', VesselName: 'Wenatchee' }],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(7, 3, '2026-09-25', false, createMockContext());
    expect(schedule).toEqual({
      departingTerminalName: 'Seattle',
      arrivingTerminalName: 'Bainbridge Island',
      tripDate: '2026-09-25',
      remainingOnly: false,
      // No ArrivingTime upstream, so neither arrivalTime nor its Pacific sibling appears.
      sailings: [
        {
          departureTime: '2026-09-25T13:50:00.000Z',
          departureTimeLocal: '2026-09-25T06:50:00.000-07:00',
          serviceDate: '2026-09-25',
          vesselName: 'Wenatchee',
        },
      ],
    });
  });

  it('keeps an empty annotations list the pair sends as a stated empty list', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [{ Annotations: [], Times: [sailing({ AnnotationIndexes: [] })] }],
      }),
    );
    const schedule = await svc.getSchedule(7, 3, '2026-09-25', false, createMockContext());
    expect(schedule.annotations).toEqual([]);
    expect(nth(schedule.sailings).annotationIndexes).toEqual([]);
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
    const v = nth(vessels);
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
    expect(nth(vessels).opRouteAbbrev).toEqual([]);
  });

  it('omits boolean fields when raw values are null', async () => {
    const raw = [
      { VesselID: 5, VesselName: 'Wenatchee', InService: null, AtDock: null, OpRouteAbbrev: [] },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const vessels = await svc.getVesselLocations(ctx);
    expect('inService' in nth(vessels)).toBe(false);
    expect('atDock' in nth(vessels)).toBe(false);
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
    expect('leftDock' in nth(vessels)).toBe(false);
    expect('leftDockLocal' in nth(vessels)).toBe(false);
  });

  it('gives every vessel time its Pacific sibling', async () => {
    const raw = [
      {
        VesselID: 20,
        LeftDock: '/Date(1794481510000-0800)/',
        Eta: '/Date(1794483600000-0800)/',
        ScheduledDeparture: '/Date(1794481200000-0800)/',
        OpRouteAbbrev: ['sea-bi'],
        TimeStamp: '/Date(1794481597000-0800)/',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(nth(await svc.getVesselLocations(createMockContext()))).toEqual({
      vesselId: 20,
      leftDock: '2026-11-12T11:05:10.000Z',
      leftDockLocal: '2026-11-12T03:05:10.000-08:00',
      eta: '2026-11-12T11:40:00.000Z',
      etaLocal: '2026-11-12T03:40:00.000-08:00',
      scheduledDeparture: '2026-11-12T11:00:00.000Z',
      scheduledDepartureLocal: '2026-11-12T03:00:00.000-08:00',
      opRouteAbbrev: ['sea-bi'],
      timestamp: '2026-11-12T11:06:37.000Z',
      timestampLocal: '2026-11-12T03:06:37.000-08:00',
    });
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
    expect(nth(spaces).terminalId).toBe(7);
    // One entry per arrival terminal
    expect(nth(spaces).departingSpaces).toHaveLength(2);
    expect(nth(nth(spaces).departingSpaces).itineraryLabel).toBe('Bainbridge Island');
    expect(nth(nth(spaces).departingSpaces).arrivingTerminalIds).toEqual([3]);
    expect(nth(nth(spaces).departingSpaces).displayReservableSpace).toBe(true);
    expect(nth(nth(spaces).departingSpaces).driveUpSpaceCount).toBe(50);
    expect(nth(nth(spaces).departingSpaces, 1).itineraryLabel).toBe('Kingston');
    expect(nth(nth(spaces).departingSpaces, 1).arrivingTerminalIds).toEqual([12]);
    expect(nth(nth(spaces).departingSpaces, 1).displayReservableSpace).toBe(false);
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

    const rows = nth(spaces).departingSpaces;
    expect(rows).toHaveLength(2);
    // The departing terminal's ID never leaks into the destinations.
    expect(nth(rows).arrivingTerminalIds).toEqual([15, 18, 13]);
    expect(nth(rows, 1).arrivingTerminalIds).toEqual([15, 18]);
    // The shared itinerary string is kept, but labelled as such rather than as a terminal name.
    expect(nth(rows).itineraryLabel).toBe('Anacortes -> Orcas Island -> Shaw Island -> Anacortes');
    expect(nth(rows).itineraryLabel).toBe(nth(rows, 1).itineraryLabel);
    expect('arrivingTerminalName' in nth(rows)).toBe(false);
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

    const rows = nth(spaces).departingSpaces;
    expect(rows).toHaveLength(2);
    expect('arrivingTerminalIds' in nth(rows)).toBe(false);
    expect('arrivingTerminalIds' in nth(rows, 1)).toBe(false);
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

    const row = nth(nth(spaces).departingSpaces);
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

    const row = nth(nth(spaces).departingSpaces);
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

    const rows = nth(spaces).departingSpaces;
    expect(rows).toHaveLength(2);
    expect(nth(rows).isCancelled).toBe(true);
    expect(nth(rows, 1).isCancelled).toBe(true);
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
    expect(nth(spaces).departingSpaces).toHaveLength(1);
    expect(nth(nth(spaces).departingSpaces).vesselName).toBe('Yakima');
    expect('itineraryLabel' in nth(nth(spaces).departingSpaces)).toBe(false);
    expect('arrivingTerminalIds' in nth(nth(spaces).departingSpaces)).toBe(false);
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
    expect(nth(nth(spaces).departingSpaces).departure).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives the departure its Pacific sibling on both departure-row shapes', async () => {
    const raw = [
      {
        TerminalID: 7,
        DepartingSpaces: [
          {
            Departure: '/Date(1790344200000-0700)/',
            SpaceForArrivalTerminals: [{ ArrivalTerminalIDs: [3], DriveUpSpaceCount: 50 }],
          },
          { Departure: '/Date(1790351700000-0700)/', SpaceForArrivalTerminals: [] },
        ],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(nth(await svc.getTerminalSailingSpace(createMockContext())).departingSpaces).toEqual([
      {
        departure: '2026-09-25T13:50:00.000Z',
        departureLocal: '2026-09-25T06:50:00.000-07:00',
        arrivingTerminalIds: [3],
        driveUpSpaceCount: 50,
      },
      {
        departure: '2026-09-25T15:55:00.000Z',
        departureLocal: '2026-09-25T08:55:00.000-07:00',
      },
    ]);
  });

  it('returns empty departingSpaces array when DepartingSpaces is null', async () => {
    const raw = [{ TerminalID: 7, TerminalName: 'Seattle', DepartingSpaces: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const spaces = await svc.getTerminalSailingSpace(ctx);
    expect(nth(spaces).departingSpaces).toHaveLength(0);
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

    expect(nth(alerts).alertId).toBe(201);
    expect(nth(alerts).alertDescription).toBe('Vessel out of service.');
    expect(nth(alerts).impactedRouteIds).toEqual([1, 2]);
    expect(nth(alerts).publishDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives publishDate its Pacific sibling at the same millisecond precision', async () => {
    mockFetch.mockResolvedValue(
      makeResponse([{ BulletinID: 204, PublishDate: '/Date(1794481421917-0800)/' }]),
    );
    expect(nth(await svc.getAlerts(createMockContext()))).toEqual({
      alertId: 204,
      impactedRouteIds: [],
      publishDate: '2026-11-12T11:03:41.917Z',
      publishDateLocal: '2026-11-12T03:03:41.917-08:00',
    });
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
    expect(nth(alerts).alertDescription).toBe('Maintenance Notice');
  });

  it('impactedRouteIds defaults to [] when AffectedRouteIDs is null', async () => {
    const raw = [{ BulletinID: 203, AffectedRouteIDs: null }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx);
    expect(nth(alerts).impactedRouteIds).toEqual([]);
  });

  it('maps the title, type, and all-routes flag alongside the summary', async () => {
    const raw = [
      {
        BulletinID: 116850,
        AlertFullTitle: 'Edm/King - First vessel #2 roundtrip cancelled on Sunday, July 26',
        RouteAlertText: 'Edm/King - First #2 roundtrip cancelled on Sunday, 7/26.',
        AlertType: 'All Alerts',
        AllRoutesFlag: false,
        AffectedRouteIDs: [6],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));

    expect(a.alertTitle).toBe('Edm/King - First vessel #2 roundtrip cancelled on Sunday, July 26');
    expect(a.alertDescription).toBe('Edm/King - First #2 roundtrip cancelled on Sunday, 7/26.');
    expect(a.alertType).toBe('All Alerts');
    expect(a.affectsAllRoutes).toBe(false);
    expect(a.impactedRouteIds).toEqual([6]);
  });

  it('normalizes the HTML bulletin body to plain text, keeping link destinations', async () => {
    const raw = [
      {
        BulletinID: 116851,
        RouteAlertText: 'Edm/King - First #2 roundtrip cancelled on Sunday, 7/26.',
        BulletinText:
          '<p><span data-contrast="none">Due to crew hold overs, the 7:00 a.m. from Kingston is cancelled.</span></p>\r\n' +
          '<p><b>Vessel #2 Puyallup will begin service with the 8:40 a.m. from Kingston.</b></p>\r\n' +
          '<p><span>Check the </span><a href="https://wsdot.wa.gov/ferries/sailing-schedules/schedule-route" target="_blank" rel="noopener">online schedule</a><span>.<br /></span></p>',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));

    expect(a.bulletinText).toBe(
      'Due to crew hold overs, the 7:00 a.m. from Kingston is cancelled.\n' +
        'Vessel #2 Puyallup will begin service with the 8:40 a.m. from Kingston.\n' +
        'Check the online schedule (https://wsdot.wa.gov/ferries/sailing-schedules/schedule-route).',
    );
    // The replacement sailing exists only in the bulletin body, not in the marquee summary.
    expect(a.alertDescription).not.toContain('Puyallup');
    expect(a.bulletinText).not.toContain('<');
  });

  it('strips the Word-paste attribute cruft the bulletin editor emits', async () => {
    const raw = [
      {
        BulletinID: 116798,
        BulletinText:
          '<ol><li><span data-contrast="none" xml:lang="EN-US" class="TextRun SCXW180249970 BCX8">Follow the signal.</span>' +
          '<span data-ccp-props="{&quot;134233117&quot;:false,&quot;201341983&quot;:0}"> </span></li>' +
          '<li><span data-contrast="none">Take a pass.</span></li></ol><o:p></o:p>',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));
    expect(a.bulletinText).toBe('Follow the signal.\nTake a pass.');
    expect(a.bulletinText).not.toContain('data-ccp-props');
    expect(a.bulletinText).not.toContain('&quot;');
  });

  it('marks a fleet-wide alert so an empty impactedRouteIds is not read as "no routes"', async () => {
    // No alert in the live feed sets AllRoutesFlag, so the correctness case is built by hand:
    // fleet-wide alerts enumerate no route IDs, and the flag is the only thing distinguishing
    // that from an alert that genuinely names none.
    const raw = [
      {
        BulletinID: 116999,
        AlertFullTitle: 'System-wide service change',
        AllRoutesFlag: true,
        AffectedRouteIDs: [],
      },
      {
        BulletinID: 117000,
        AlertFullTitle: 'Local notice',
        AllRoutesFlag: false,
        AffectedRouteIDs: [],
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const alerts = await svc.getAlerts(createMockContext());
    const fleetWide = nth(alerts);
    const local = nth(alerts, 1);

    expect(fleetWide.affectsAllRoutes).toBe(true);
    expect(fleetWide.impactedRouteIds).toEqual([]);
    expect(local.affectsAllRoutes).toBe(false);
    expect(local.impactedRouteIds).toEqual([]);
  });

  it('omits the new fields when upstream sends none of them', async () => {
    const raw = [
      {
        BulletinID: 204,
        RouteAlertText: 'Summary only.',
        AlertFullTitle: null,
        BulletinText: null,
        AlertType: null,
        AllRoutesFlag: null,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));
    expect('alertTitle' in a).toBe(false);
    expect('bulletinText' in a).toBe(false);
    expect('alertType' in a).toBe(false);
    expect('affectsAllRoutes' in a).toBe(false);
    expect(a.alertDescription).toBe('Summary only.');
  });

  it('omits bulletinText when the body carries only markup', async () => {
    const raw = [{ BulletinID: 205, RouteAlertText: 'Summary.', BulletinText: '<p></p><br />' }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));
    expect('bulletinText' in a).toBe(false);
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
// Blank and padded upstream strings — a blank or whitespace-only string is absent from the
// normalized record; a populated one is kept with its ends trimmed.
// ---------------------------------------------------------------------------

describe('FerryApiService — blank and padded upstream strings', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    svc = new FerryApiService({} as never, {} as never);
  });

  /** Every optional upstream string each ferry feed maps, set to `blank`. */
  function blankFeeds(blank: string) {
    return {
      terminals: [{ TerminalID: 1, TerminalName: blank, TerminalAbbrev: blank }],
      routes: [{ RouteID: 1, RouteAbbrev: blank, Description: blank }],
      pairs: [
        {
          DepartingTerminalID: 3,
          DepartingDescription: blank,
          ArrivingTerminalID: 7,
          ArrivingDescription: blank,
        },
      ],
      schedule: {
        TerminalCombos: [
          {
            DepartingTerminalName: blank,
            ArrivingTerminalName: blank,
            SailingNotes: blank,
            Annotations: [blank, blank],
            Times: [
              {
                DepartingTime: blank,
                ArrivingTime: blank,
                VesselName: blank,
                AnnotationIndexes: [0, 1],
              },
            ],
          },
        ],
      },
      vessels: [
        {
          VesselID: 1,
          VesselName: blank,
          DepartingTerminalName: blank,
          ArrivingTerminalName: blank,
          LeftDock: blank,
          Eta: blank,
          ScheduledDeparture: blank,
          TimeStamp: blank,
          OpRouteAbbrev: [blank, blank],
        },
      ],
      space: [
        {
          TerminalID: 1,
          TerminalName: blank,
          DepartingSpaces: [
            {
              Departure: blank,
              VesselName: blank,
              SpaceForArrivalTerminals: [
                { TerminalName: blank, DriveUpSpaceHexColor: blank, DriveUpSpaceCount: 4 },
              ],
            },
            {
              Departure: blank,
              VesselName: blank,
              MaxSpaceCount: 10,
              SpaceForArrivalTerminals: [],
            },
          ],
        },
      ],
      alerts: [
        {
          BulletinID: 1,
          AlertFullTitle: blank,
          RouteAlertText: blank,
          BulletinText: blank,
          AlertType: blank,
          PublishDate: blank,
          AffectedRouteIDs: [],
        },
      ],
    };
  }

  describe.each([
    ['empty', ''],
    ['whitespace-only', ' \t\r\n   '],
  ])('an all-%s fixture yields no string field from any mapper', (_label, blank) => {
    const feeds = blankFeeds(blank);

    it('terminals', async () => {
      mockFetch.mockResolvedValue(makeResponse(feeds.terminals));
      expect(await svc.getTerminals(createMockContext())).toEqual([{ terminalId: 1 }]);
    });

    it('routes, terminal pairs included', async () => {
      stubByPath([
        ['/routes/', makeResponse(feeds.routes)],
        ['/cacheflushdate', flushResponse()],
        ['/terminalsandmatesbyroute/', makeResponse(feeds.pairs)],
      ]);
      expect(await svc.getRoutes('2026-05-23', createMockContext())).toEqual([
        {
          routeId: 1,
          terminalPairs: [{ departingTerminalId: 3, arrivingTerminalId: 7 }],
        },
      ]);
    });

    it('schedule, sailings included', async () => {
      mockFetch.mockResolvedValue(makeResponse(feeds.schedule));
      expect(await svc.getSchedule(7, 3, '2027-01-01', false, createMockContext())).toEqual({
        tripDate: '2027-01-01',
        remainingOnly: false,
        // Every annotation was blank, so none is kept and no sailing points at one. serviceDate is
        // the server's own, not an upstream string.
        annotations: [],
        sailings: [{ serviceDate: '2027-01-01', annotationIndexes: [] }],
      });
    });

    it('vessel locations, route abbreviations included', async () => {
      mockFetch.mockResolvedValue(makeResponse(feeds.vessels));
      expect(await svc.getVesselLocations(createMockContext())).toEqual([
        { vesselId: 1, opRouteAbbrev: [] },
      ]);
    });

    it('terminal sailing space, both departure-row shapes included', async () => {
      mockFetch.mockResolvedValue(makeResponse(feeds.space));
      expect(await svc.getTerminalSailingSpace(createMockContext())).toEqual([
        { terminalId: 1, departingSpaces: [{ driveUpSpaceCount: 4 }, { maxSpaceCount: 10 }] },
      ]);
    });

    it('alerts', async () => {
      mockFetch.mockResolvedValue(makeResponse(feeds.alerts));
      expect(await svc.getAlerts(createMockContext())).toEqual([
        { alertId: 1, impactedRouteIds: [] },
      ]);
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['absent', undefined],
  ])('falls back to the alert title when RouteAlertText is %s', async (_label, routeAlertText) => {
    const raw = [
      { BulletinID: 202, RouteAlertText: routeAlertText, AlertFullTitle: 'Maintenance Notice' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    const a = nth(await svc.getAlerts(createMockContext()));
    expect(a.alertDescription).toBe('Maintenance Notice');
    expect(a.alertTitle).toBe('Maintenance Notice');
  });

  it('drops a bulletin body holding only markup or entity whitespace', async () => {
    const raw = [
      { BulletinID: 205, RouteAlertText: 'Summary.', BulletinText: '<p>&nbsp;</p><br />' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect('bulletinText' in nth(await svc.getAlerts(createMockContext()))).toBe(false);
  });

  it('drops blank route abbreviations and trims the rest, keeping the array', async () => {
    const raw = [{ VesselID: 2, OpRouteAbbrev: [' pt-key ', '', '  ', 'sea-bi'] }];
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(nth(await svc.getVesselLocations(createMockContext())).opRouteAbbrev).toEqual([
      'pt-key',
      'sea-bi',
    ]);
  });

  it('trims the padded Coupeville name wherever a feed carries it', async () => {
    mockFetch.mockResolvedValue(
      makeResponse([{ TerminalID: 11, TerminalName: 'Coupeville ', TerminalAbbrev: 'COU' }]),
    );
    expect(await svc.getTerminals(createMockContext())).toEqual([
      { terminalId: 11, terminalName: 'Coupeville', terminalAbbrev: 'COU' },
    ]);

    mockFetch.mockResolvedValue(
      makeResponse([
        {
          VesselID: 3,
          DepartingTerminalName: 'Coupeville ',
          ArrivingTerminalName: ' Port Townsend',
          OpRouteAbbrev: ['pt-key'],
        },
      ]),
    );
    const vessel = nth(await svc.getVesselLocations(createMockContext()));
    expect(vessel.departingTerminalName).toBe('Coupeville');
    expect(vessel.arrivingTerminalName).toBe('Port Townsend');

    mockFetch.mockResolvedValue(
      makeResponse({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Port Townsend',
            ArrivingTerminalName: 'Coupeville ',
            Times: [],
          },
        ],
      }),
    );
    const schedule = await svc.getSchedule(17, 11, '2027-01-01', false, createMockContext());
    expect(schedule.arrivingTerminalName).toBe('Coupeville');

    mockFetch.mockResolvedValue(
      makeResponse([
        {
          TerminalID: 11,
          TerminalName: 'Coupeville ',
          DepartingSpaces: [
            {
              Departure: '/Date(1700000000000-0800)/',
              SpaceForArrivalTerminals: [
                { TerminalName: 'Port Townsend -> Coupeville ', ArrivalTerminalIDs: [11] },
              ],
            },
          ],
        },
      ]),
    );
    const space = nth(await svc.getTerminalSailingSpace(createMockContext()));
    expect(space.terminalName).toBe('Coupeville');
    expect(nth(space.departingSpaces).itineraryLabel).toBe('Port Townsend -> Coupeville');
  });

  it('trims a padded alert summary, keeping its internal spacing', async () => {
    const raw = [
      { BulletinID: 9, RouteAlertText: 'Muk/Clin - Construction  activity at Clinton  ' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));
    expect(nth(await svc.getAlerts(createMockContext())).alertDescription).toBe(
      'Muk/Clin - Construction  activity at Clinton',
    );
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

  it('names the api_unavailable reason on a non-2xx and leaves the hint to the tool contract', async () => {
    mockFetch.mockResolvedValue(makeResponse('Service Unavailable', 503, 'text/plain'));
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ reason: 'api_unavailable', status: 503 });
    expect((err as McpError).data).not.toHaveProperty('recovery');
  });

  it('reads the WSF explanation on a 400 from an unregistered access code', async () => {
    // Before the fix the status check threw first and this body was discarded unread.
    mockFetch.mockResolvedValue(makeResponse(UNREGISTERED_CODE_BODY, 400));
    const ctx = createMockContext();
    const err = await svc.getTerminals(ctx).catch((e) => e);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((err as McpError).message).toContain('WSDOT_ACCESS_CODE');
    expect((err as McpError).message).toContain('Use of WSDOT Traveler API failed');
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_access_code', status: 400 });
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
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('apiaccesscode=test-access-code');
  });

  it('uses ferry BASE_URL prefix', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();
    await svc.getTerminals(ctx);
    const url: string = nth(mockFetch.mock.calls)[0] as string;
    expect(url).toContain('https://www.wsdot.wa.gov/Ferries/API');
  });
});

// ---------------------------------------------------------------------------
// Trip dates WSF has no schedule for
// ---------------------------------------------------------------------------

describe('FerryApiService — trip dates WSF has no schedule for', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    svc = new FerryApiService({} as never, {} as never);
  });

  /** WSF's rejection of a trip date outside its window, as served for a future and a past date. */
  const tripDateRejection = (date: string) => ({
    Message: `The TripDate ${date} is not valid. The valid range begins with today's date (9/24/2026) and extends to the end of the most recently posted schedule (3/20/2027).`,
  });

  it.each([
    ['past the posted schedule', '2099-01-01', '1/1/2099'],
    ['before today', '2026-09-23', '9/23/2026'],
  ])(
    'classifies an HTTP 400 TripDate rejection %s as non-retryable invalid_date',
    async (_label, iso, wsf) => {
      mockFetch.mockResolvedValue(makeResponse(tripDateRejection(wsf), 400));
      const err = (await svc.getRoutes(iso, createMockContext()).catch((e) => e)) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.message).toContain(`The TripDate ${wsf} is not valid`);
      expect(err.message).toContain('(3/20/2027)');
      expect(err.data).toMatchObject({
        reason: 'invalid_date',
        retryable: false,
        status: 400,
        url: `https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/routes/${iso}`,
      });
      // The hint is the routes tool's declared one, filled in on the wire (ferry-wire.test.ts).
      expect(err.data).not.toHaveProperty('recovery');
      expect(JSON.stringify(err.data)).not.toContain(ACCESS_CODE);
    },
  );

  it('classifies the same rejection on the schedule endpoint', async () => {
    mockFetch.mockResolvedValue(makeResponse(tripDateRejection('1/1/2099'), 400));
    const err = (await svc
      .getSchedule(7, 3, '2099-01-01', false, createMockContext())
      .catch((e) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'invalid_date', retryable: false });
    // The Schedule API's rejection names a schedule; the Fares API's names fares (getFares below).
    expect(err.message).toBe(
      `WSF has no schedule for the requested trip date. ${tripDateRejection('1/1/2099').Message}`,
    );
  });

  it('classifies a TripDate rejection served with HTTP 200', async () => {
    mockFetch.mockResolvedValue(makeResponse(tripDateRejection('1/1/2099')));
    const err = (await svc
      .getRoutes('2099-01-01', createMockContext())
      .catch((e) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'invalid_date', retryable: false, status: 200 });
  });

  it('leaves a terminal-combination rejection unclassified for the schedule tool to judge', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        {
          Message:
            'The terminal combination DepartingTerminalID 7 and ArrivingTerminalID 1 is not valid for a TripDate of 9/25/2026.',
        },
        400,
      ),
    );
    const err = (await svc
      .getSchedule(7, 1, '2026-09-25', false, createMockContext())
      .catch((e) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'api_unavailable', status: 400 });
  });

  it.each([
    [[{ RouteID: 5 }], true],
    [[], false],
    [null, false],
  ])('hasRoutes reads routes/{TripDate} (%j → %s)', async (routes, expected) => {
    mockFetch.mockResolvedValue(makeResponse(routes));
    expect(await svc.hasRoutes('2027-01-15', createMockContext())).toBe(expected);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(nth(mockFetch.mock.calls)[0])).toContain('/Schedule/rest/routes/2027-01-15?');
  });
});

describe('FerryApiService.getSchedule — the effective remainingOnly', () => {
  let svc: FerryApiService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PACIFIC_NOON);
    svc = new FerryApiService({} as never, {} as never);
    mockFetch.mockResolvedValue(makeResponse({ TerminalCombos: [] }));
  });

  afterEach(() => vi.useRealTimers());

  it('reports false for a future date even when true was requested', async () => {
    const schedule = await svc.getSchedule(7, 3, '2099-01-01', true, createMockContext());
    expect(schedule.remainingOnly).toBe(false);
  });

  it('reports the requested value for today', async () => {
    const today = FerryApiService.todayFerryDate();
    expect((await svc.getSchedule(7, 3, today, true, createMockContext())).remainingOnly).toBe(
      true,
    );
    expect((await svc.getSchedule(7, 3, today, false, createMockContext())).remainingOnly).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// getSchedule — the previous service day's sailings still to depart after midnight
// ---------------------------------------------------------------------------

describe('FerryApiService.getSchedule — the previous service day after midnight', () => {
  const TODAY = '/Schedule/rest/scheduletoday/7/3/true';
  const PREVIOUS = '/Schedule/rest/schedule/2026-11-11/7/3';
  /** 2026-11-12 00:53 PST: 11/11's 01:35 sailing (09:35Z) has not departed yet. */
  const AT_0053 = new Date('2026-11-12T08:53:00Z');
  let svc: FerryApiService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_0053);
    svc = new FerryApiService({} as never, {} as never);
  });

  afterEach(() => vi.useRealTimers());

  /** Paths requested, in order, credential query string dropped. */
  const requested = () =>
    mockFetch.mock.calls.map(
      ([url]) =>
        String(url).split('?')[0]?.replace('https://www.wsdot.wa.gov/Ferries/API', '') ?? '',
    );

  /** `scheduletoday` serving the 11/12 capture, and the previous day's read answered `previous`. */
  const stubToday = (previous: ReturnType<typeof makeResponse>) =>
    stubByPath([
      [TODAY, makeResponse(scheduleCapture('scheduletoday-2026-11-12-7-3-true'))],
      [PREVIOUS, previous],
    ]);

  /** Today's 23 departures as [UTC instant, serviceDate], read straight off the capture. */
  const TODAYS_LIST = (
    scheduleCapture('scheduletoday-2026-11-12-7-3-true').TerminalCombos?.[0]?.Times ?? []
  ).map((s) => [
    new Date(Number(/\d+/.exec(s.DepartingTime ?? '')?.[0])).toISOString(),
    '2026-11-12',
  ]);
  const listed = (schedule: { sailings: { departureTime?: string; serviceDate: string }[] }) =>
    schedule.sailings.map((s) => [s.departureTime, s.serviceDate]);

  it('leads at 00:53 with the 01:35 sailing under the previous serviceDate, then today’s under today’s', async () => {
    stubToday(makeResponse(scheduleCapture('schedule-2026-11-11-7-3')));
    const schedule = await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext());
    expect(requested()).toEqual([TODAY, PREVIOUS]);
    expect(schedule).toMatchObject({ tripDate: '2026-11-12', remainingOnly: true });
    expect(schedule).not.toHaveProperty('previousServiceDayUnread');
    expect(schedule.sailings).toHaveLength(24);
    expect(schedule.sailings[0]).toEqual({
      departureTime: '2026-11-12T09:35:00.000Z',
      departureTimeLocal: '2026-11-12T01:35:00.000-08:00',
      serviceDate: '2026-11-11',
      vesselName: 'Puyallup',
      vesselId: 25,
      loadingRule: 3,
      vesselHandicapAccessible: true,
      annotationIndexes: [],
    });
    expect(schedule.sailings[1]).toMatchObject({
      departureTime: '2026-11-12T13:30:00.000Z',
      departureTimeLocal: '2026-11-12T05:30:00.000-08:00',
      serviceDate: '2026-11-12',
    });
    expect(new Set(schedule.sailings.slice(1).map((s) => s.serviceDate))).toEqual(
      new Set(['2026-11-12']),
    );
  });

  it('equals today’s list before 03:00 once the previous day’s sailings have all departed', async () => {
    vi.setSystemTime(new Date('2026-11-12T10:30:00Z')); // 02:30 PST
    stubToday(makeResponse(scheduleCapture('schedule-2026-11-11-7-3')));
    const schedule = await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext());
    expect(requested()).toEqual([TODAY, PREVIOUS]);
    expect(TODAYS_LIST).toHaveLength(23);
    expect(listed(schedule)).toEqual(TODAYS_LIST);
  });

  it.each([
    ['02:59:59.999', '2026-11-12T10:59:59.999Z', [TODAY, PREVIOUS]],
    ['03:00:00.000', '2026-11-12T11:00:00.000Z', [TODAY]],
    ['noon', '2026-11-12T20:00:00.000Z', [TODAY]],
  ])('at %s PST asks for the previous day only before 03:00', async (_label, at, paths) => {
    vi.setSystemTime(new Date(at));
    stubToday(makeResponse(scheduleCapture('schedule-2026-11-11-7-3')));
    const schedule = await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext());
    expect(requested()).toEqual(paths);
    expect(listed(schedule)).toEqual(TODAYS_LIST);
  });

  it('carries the weekend 02:10 sailing at 02:05 on Sunday, and leaves it once it departs at 02:10:00', async () => {
    const stubWeekend = () =>
      stubByPath([
        [TODAY, makeResponse(scheduleCapture('schedule-2026-11-15-7-3'))],
        [
          '/Schedule/rest/schedule/2026-11-14/7/3',
          makeResponse(scheduleCapture('schedule-2026-11-14-7-3')),
        ],
      ]);
    vi.setSystemTime(new Date('2026-11-15T10:05:00Z')); // 02:05 PST
    stubWeekend();
    const carried = await svc.getSchedule(7, 3, '2026-11-15', true, createMockContext());
    expect(carried.sailings).toHaveLength(23);
    expect(carried.sailings[0]).toMatchObject({
      departureTime: '2026-11-15T10:10:00.000Z',
      departureTimeLocal: '2026-11-15T02:10:00.000-08:00',
      serviceDate: '2026-11-14',
      vesselName: 'Wenatchee',
    });
    expect(carried.sailings[1]).toMatchObject({ serviceDate: '2026-11-15' });

    // A sailing departing at the very instant of the call has left: only "after now" carries over.
    vi.setSystemTime(new Date('2026-11-15T10:10:00Z'));
    stubWeekend();
    const departed = await svc.getSchedule(7, 3, '2026-11-15', true, createMockContext());
    expect(departed.sailings).toHaveLength(22);
    expect(departed.sailings.every((s) => s.serviceDate === '2026-11-15')).toBe(true);
  });

  it('reads no previous day for the whole day today, or for an explicit tripDate of the previous day', async () => {
    stubByPath([
      [
        '/Schedule/rest/scheduletoday/7/3/false',
        makeResponse(scheduleCapture('scheduletoday-2026-11-12-7-3-true')),
      ],
      [PREVIOUS, makeResponse(scheduleCapture('schedule-2026-11-11-7-3'))],
    ]);
    const whole = await svc.getSchedule(7, 3, '2026-11-12', false, createMockContext());
    expect(whole.sailings.every((s) => s.serviceDate === '2026-11-12')).toBe(true);

    const yesterday = await svc.getSchedule(7, 3, '2026-11-11', true, createMockContext());
    expect(yesterday.remainingOnly).toBe(false);
    expect(yesterday.sailings).toHaveLength(23);
    expect(yesterday.sailings.every((s) => s.serviceDate === '2026-11-11')).toBe(true);
    expect(requested()).toEqual(['/Schedule/rest/scheduletoday/7/3/false', PREVIOUS]);
  });

  describe('annotations, whose list WSF varies by service day', () => {
    /** 2026-11-14 00:00 PST, Saturday: Friday's 00:15 and 01:30 Vashon → Southworth boats remain. */
    const SAT_MIDNIGHT = new Date('2026-11-14T08:00:00Z');
    const FRIDAY_NOTE = 'Via Fauntleroy, crossing time approximately 50 minutes.';

    /**
     * Friday's capture with its last sailing (01:30) citing `indexes` — no live carried-over
     * sailing has cited one, so the citation is set here — and Saturday's with `notes` as its list.
     */
    function stubVashon(indexes: number[], notes: string[] | null) {
      const friday = scheduleCapture('schedule-2026-11-13-22-20');
      const fridayTimes = friday.TerminalCombos?.[0]?.Times ?? [];
      const last = fridayTimes[fridayTimes.length - 1];
      if (last) last.AnnotationIndexes = indexes;
      const saturday = scheduleCapture('schedule-2026-11-14-22-20');
      const saturdayCombo = saturday.TerminalCombos?.[0];
      if (saturdayCombo) {
        saturdayCombo.Annotations = notes;
        const first = saturdayCombo.Times?.[0];
        if (first && notes?.length) first.AnnotationIndexes = [0];
      }
      stubByPath([
        ['/Schedule/rest/scheduletoday/22/20/true', makeResponse(saturday)],
        ['/Schedule/rest/schedule/2026-11-13/22/20', makeResponse(friday)],
      ]);
    }

    const resolved = (schedule: Awaited<ReturnType<FerryApiService['getSchedule']>>) =>
      schedule.sailings.map((s) =>
        (s.annotationIndexes ?? []).map((i) => schedule.annotations?.[i]),
      );

    beforeEach(() => vi.setSystemTime(SAT_MIDNIGHT));

    it('appends a note a carried-over sailing cites, so its index resolves to what Friday attached', async () => {
      stubVashon([0], []);
      const schedule = await svc.getSchedule(22, 20, '2026-11-14', true, createMockContext());
      expect(schedule.annotations).toEqual([FRIDAY_NOTE]);
      expect(
        schedule.sailings
          .slice(0, 2)
          .map((s) => [s.departureTime, s.serviceDate, s.annotationIndexes]),
      ).toEqual([
        ['2026-11-14T08:15:00.000Z', '2026-11-13', []],
        ['2026-11-14T09:30:00.000Z', '2026-11-13', [0]],
      ]);
      expect(schedule.sailings).toHaveLength(24);
    });

    it('reuses the entry when today’s list already holds the same note, and appends after today’s otherwise', async () => {
      stubVashon([0], ['Other note.', FRIDAY_NOTE]);
      const shared = await svc.getSchedule(22, 20, '2026-11-14', true, createMockContext());
      expect(shared.annotations).toEqual(['Other note.', FRIDAY_NOTE]);
      expect(resolved(shared)[1]).toEqual([FRIDAY_NOTE]);
      expect(resolved(shared)[2]).toEqual(['Other note.']);

      stubVashon([0, 0], ['Other note.']);
      const appended = await svc.getSchedule(22, 20, '2026-11-14', true, createMockContext());
      expect(appended.annotations).toEqual(['Other note.', FRIDAY_NOTE]);
      expect(resolved(appended)[1]).toEqual([FRIDAY_NOTE, FRIDAY_NOTE]);
      expect(resolved(appended)[2]).toEqual(['Other note.']);
    });

    it('adds no note only a departed Friday sailing cites, and drops an index that points at nothing', async () => {
      // Friday's 04:05 sailing cites note 0, but it departed a day ago.
      stubVashon([3, -1], []);
      const schedule = await svc.getSchedule(22, 20, '2026-11-14', true, createMockContext());
      expect(schedule.annotations).toEqual([]);
      expect(schedule.sailings[1]?.annotationIndexes).toEqual([]);
    });

    it('carries the list when only a carried-over sailing has notes and today sent no list', async () => {
      stubVashon([0], null);
      const schedule = await svc.getSchedule(22, 20, '2026-11-14', true, createMockContext());
      expect(schedule.annotations).toEqual([FRIDAY_NOTE]);
      expect(resolved(schedule)[1]).toEqual([FRIDAY_NOTE]);
    });
  });

  describe('the previous day’s read is best-effort', () => {
    const timeoutError = () =>
      Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

    /**
     * Each way the previous-day request can fail, against what 0.5.0 answered for the same call:
     * today's list (it never made the request). A rejection of the date or pair means nothing to
     * carry over, so no notice; anything else is disclosed.
     */
    it.each([
      [
        'WSF rejecting the date (its window rolled)',
        makeResponse(DATE_ROLLED_REJECTION, 400),
        undefined,
      ],
      ['WSF rejecting the pair on that date', makeResponse(PAIR_REJECTION_1111, 400), undefined],
      [
        'an HTTP 200 carrying {"Message"}',
        makeResponse({ Message: 'Invalid terminal combination.' }),
        undefined,
      ],
      ['an HTTP 404', makeResponse('Not Found', 404, 'text/plain'), 'WSF answered HTTP 404'],
      [
        'an HTTP 429',
        makeResponse('Too Many Requests', 429, 'text/plain'),
        'WSF answered HTTP 429',
      ],
      ['an HTTP 401', makeResponse('Unauthorized', 401, 'text/plain'), 'WSF answered HTTP 401'],
      ['a 5xx', makeResponse('Service Unavailable', 503, 'text/plain'), 'WSF answered HTTP 503'],
      [
        'a 5xx outage page',
        makeResponse('<html>Down</html>', 502, 'text/html'),
        'WSF answered HTTP 502',
      ],
      [
        'a bot-check page served as HTTP 200',
        makeResponse('<!DOCTYPE html><html>Check</html>', 200, 'text/html'),
        'the request failed',
      ],
      [
        'an HTTP 200 body that is not JSON',
        makeResponse('not json', 200, 'text/plain'),
        'the request failed',
      ],
    ])('answers %s with today’s list', async (_label, response, detail) => {
      stubToday(response);
      const schedule = await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext());
      expect(listed(schedule)).toEqual(TODAYS_LIST);
      if (detail === undefined) expect(schedule).not.toHaveProperty('previousServiceDayUnread');
      else expect(schedule.previousServiceDayUnread).toEqual({ serviceDate: '2026-11-11', detail });
    });

    it.each([
      ['a timeout', timeoutError(), 'the request timed out'],
      ['a network failure', new Error('Unable to connect.'), 'the request failed'],
    ])(
      'answers %s with today’s list and says the previous day went unchecked',
      async (_label, error, detail) => {
        mockFetch.mockImplementation((url) =>
          String(url).includes(PREVIOUS)
            ? Promise.reject(error)
            : Promise.resolve(makeResponse(scheduleCapture('scheduletoday-2026-11-12-7-3-true'))),
        );
        const schedule = await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext());
        expect(listed(schedule)).toEqual(TODAYS_LIST);
        expect(schedule.previousServiceDayUnread).toEqual({ serviceDate: '2026-11-11', detail });
      },
    );

    it('fails the call when the caller cancels, rather than returning today’s list', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation((url) => {
        if (String(url).includes(PREVIOUS)) {
          controller.abort();
          return Promise.reject(Object.assign(new Error('Aborted.'), { name: 'AbortError' }));
        }
        return Promise.resolve(makeResponse(scheduleCapture('scheduletoday-2026-11-12-7-3-true')));
      });
      const err = (await svc
        .getSchedule(7, 3, '2026-11-12', true, createMockContext({ signal: controller.signal }))
        .catch((e) => e)) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toBe('WSF Ferry API request cancelled.');
    });

    it.each([
      ['answered', makeResponse(scheduleCapture('schedule-2026-11-11-7-3'))],
      ['failed too', makeResponse('Service Unavailable', 503, 'text/plain')],
    ])(
      'fails the call on a scheduletoday failure whatever the previous day’s read %s',
      async (_label, previous) => {
        stubByPath([
          [TODAY, makeResponse('Service Unavailable', 504, 'text/plain')],
          [PREVIOUS, previous],
        ]);
        const err = (await svc
          .getSchedule(7, 3, '2026-11-12', true, createMockContext())
          .catch((e) => e)) as McpError;
        expect(err.data).toMatchObject({
          reason: 'api_unavailable',
          status: 504,
          url: `https://www.wsdot.wa.gov/Ferries/API${TODAY}`,
        });
      },
    );
  });

  describe('one deadline across both reads', () => {
    let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

    beforeEach(() => {
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => timeoutSpy.mockRestore());

    it.each([
      ['before 03:00, both reads', AT_0053, 2],
      ['from 03:00, the one read', new Date('2026-11-12T11:00:00Z'), 1],
    ])(
      'bounds each read’s timeout by what is left of the budget — %s',
      async (_label, at, reads) => {
        vi.setSystemTime(at);
        stubToday(makeResponse(scheduleCapture('schedule-2026-11-11-7-3')));
        await svc.getSchedule(7, 3, '2026-11-12', true, createMockContext(), Date.now() + 7_500);
        expect(timeoutSpy.mock.calls).toEqual(Array(reads).fill([7_500]));
      },
    );
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
      'https://www.wsdot.wa.gov/Ferries/API/Terminals/rest/terminallocations',
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
        `Server Error. GET /Ferries/API/Terminals/rest/terminallocations?apiaccesscode=${ACCESS_CODE} failed.`,
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
        path: `https://www.wsdot.wa.gov/Ferries/API/Terminals/rest/terminallocations?apiaccesscode=${ACCESS_CODE}`,
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

describe('FerryApiService — the fetch stub', () => {
  it('rejects a request no test stubbed, naming the endpoint without the credential', async () => {
    const svc = new FerryApiService({} as never, {} as never);
    const err = await svc.getTerminals(createMockContext()).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toContain(
      'Unstubbed fetch: https://www.wsdot.wa.gov/Ferries/API/Terminals/rest/terminallocations',
    );
    expect((err as McpError).message).not.toContain(ACCESS_CODE);
  });
});

// ---------------------------------------------------------------------------
// Fares — the line items and the terminal combo under one deadline
// ---------------------------------------------------------------------------

describe('FerryApiService.getFares', () => {
  const LINE_ITEMS = `/Fares/rest/farelineitems/${FARES_TRIP_DATE}/1/10/false`;
  const COMBO = `/Fares/rest/terminalcombo/${FARES_TRIP_DATE}/1/10`;
  /** A deadline no test reaches; withRetry is stubbed to one attempt, so nothing reads the clock. */
  const NO_RUSH = Number.MAX_SAFE_INTEGER;

  type Reply = ReturnType<typeof makeResponse> | Error;

  let svc: FerryApiService;

  beforeEach(() => {
    svc = new FerryApiService({} as never, {} as never);
  });

  /** Answer the 1 → 10 one-way pair's two requests; anything else is unstubbed. */
  function stubFares(lineItems: Reply, combo: Reply) {
    mockFetch.mockImplementation((url) => {
      const path = String(url).split('?')[0] ?? '';
      const reply = path.endsWith(LINE_ITEMS)
        ? lineItems
        : path.endsWith(COMBO)
          ? combo
          : new Error(`Unstubbed fetch: ${path}`);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    });
  }

  /** What the network layer throws when a request's own timeout fires. */
  const timeoutError = () =>
    Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

  const getFares = (ctx = createMockContext()) =>
    svc.getFares(1, 10, FARES_TRIP_DATE, false, ctx, NO_RUSH);

  it('requests the line items and the terminal combo for the trip and maps every field in WSF’s order', async () => {
    const captured = fareLineItems('1-10-oneway');
    stubFares(makeResponse(captured), makeResponse(TERMINAL_COMBOS['1-10']));
    const result = await getFares();
    expect(mockFetch.mock.calls.map(([url]) => String(url).split('?')[0])).toEqual([
      `https://www.wsdot.wa.gov/Ferries/API${LINE_ITEMS}`,
      `https://www.wsdot.wa.gov/Ferries/API${COMBO}`,
    ]);
    expect(result.combo).toEqual({
      kind: 'read',
      departingTerminalName: 'Anacortes',
      arrivingTerminalName: 'Friday Harbor',
      collectionDescription:
        'Passenger and vehicle/driver fares are collected at Anacortes, while no fares are collected at Friday Harbor.',
    });
    expect(result.fares).toHaveLength(22);
    expect(result.fares.map((f) => f.fareLineItemId)).toEqual(
      captured.map((f) => f.FareLineItemID),
    );
    expect(nth(result.fares)).toEqual({
      fareLineItemId: 1,
      description: 'Adult (age 19 - 64)',
      category: 'Passenger',
      amountInDollars: 18,
      directionIndependent: false,
    });
    expect(result.fares.find((f) => f.fareLineItemId === 178)).toEqual({
      fareLineItemId: 178,
      description: "Vehicle Under 22' (standard veh) & Driver",
      category: 'Vehicle, Motorcycle, and Stowage Fares',
      amountInDollars: 64.15,
      directionIndependent: false,
    });
  });

  it('renders the HTML fare name to plain text, keeping the link destination', async () => {
    expect(nth(fareLineItems('1-10-oneway'), 1).FareLineItem).toBe(DISABILITY_LINE.raw);
    stubFares(makeResponse(fareLineItems('1-10-oneway')), makeResponse(TERMINAL_COMBOS['1-10']));
    const result = await getFares();
    expect(nth(result.fares, 1).description).toBe(DISABILITY_LINE.text);
    expect(JSON.stringify(result)).not.toMatch(/<a\b|href=/);
  });

  it('asks for WSF’s round-trip totals when roundTrip is true', async () => {
    mockFetch.mockImplementation((url) =>
      Promise.resolve(
        makeResponse(String(url).includes('/farelineitems/') ? [] : TERMINAL_COMBOS['7-3']),
      ),
    );
    await svc.getFares(7, 3, FARES_TRIP_DATE, true, createMockContext(), NO_RUSH);
    expect(String(nth(mockFetch.mock.calls)[0])).toContain(
      `/Fares/rest/farelineitems/${FARES_TRIP_DATE}/7/3/true?`,
    );
  });

  it('keeps a 0 amount and a false flag, and omits only what WSF leaves out', async () => {
    stubFares(
      makeResponse([
        {
          FareLineItemID: 3,
          FareLineItem: 'Youth (age 18 and under)',
          Category: 'Passenger',
          DirectionIndependent: false,
          Amount: 0,
        },
        {
          FareLineItemID: null,
          FareLineItem: '  ',
          Category: null,
          DirectionIndependent: null,
          Amount: null,
        },
        {},
      ]),
      makeResponse({ DepartingDescription: '', ArrivingDescription: null }),
    );
    const result = await getFares();
    expect(result.fares).toEqual([
      {
        fareLineItemId: 3,
        description: 'Youth (age 18 and under)',
        category: 'Passenger',
        amountInDollars: 0,
        directionIndependent: false,
      },
      {},
      {},
    ]);
    expect(result.combo).toEqual({ kind: 'read' });
  });

  it('answers null line items and a null combo with an empty list and no names', async () => {
    stubFares(makeResponse(null), makeResponse(null));
    expect(await getFares()).toEqual({ fares: [], combo: { kind: 'read' } });
  });

  describe('a failed line-items request fails the call, whatever the combo did', () => {
    it.each([
      [
        'a trip date outside WSF’s fares window (HTTP 400)',
        makeResponse(FARES_DATE_REJECTION, 400),
        {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_date', retryable: false, status: 400 },
        },
      ],
      [
        'the same rejection served with HTTP 200',
        makeResponse(FARES_DATE_REJECTION),
        {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_date', retryable: false, status: 200 },
        },
      ],
      [
        'a pair WSF has no fares for (HTTP 400), left for the tool to judge',
        makeResponse(FARES_PAIR_REJECTION, 400),
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'api_unavailable', retryable: false, status: 400 },
        },
      ],
      [
        'another 4xx (HTTP 404), left for the tool to judge',
        makeResponse('Not Found', 404, 'text/plain'),
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'api_unavailable', retryable: false, status: 404 },
        },
      ],
      [
        'a 5xx (HTTP 503)',
        makeResponse('Service Unavailable', 503, 'text/plain'),
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'api_unavailable', status: 503 },
        },
      ],
      [
        'a timeout',
        timeoutError(),
        {
          code: JsonRpcErrorCode.Timeout,
          message: 'WSF Ferry API request timed out after 15000ms.',
        },
      ],
      [
        'an unregistered access code (HTTP 400)',
        makeResponse(UNREGISTERED_CODE_BODY, 400),
        {
          code: JsonRpcErrorCode.ConfigurationError,
          data: { reason: 'invalid_access_code', status: 400 },
        },
      ],
    ])('%s', async (_label, lineItems, expected) => {
      stubFares(lineItems, makeResponse(TERMINAL_COMBOS['1-10']));
      const err = await getFares().catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject(expected);
    });

    it('leaves a 5xx retryable, so the retry ladder takes another attempt', async () => {
      stubFares(
        makeResponse('Service Unavailable', 503, 'text/plain'),
        makeResponse(TERMINAL_COMBOS['1-10']),
      );
      const err = (await getFares().catch((e) => e)) as McpError;
      expect(err.data).not.toHaveProperty('retryable');
    });

    it('fails on the line items even when the combo failed too', async () => {
      stubFares(
        makeResponse(FARES_PAIR_REJECTION, 400),
        makeResponse('Bad Gateway', 502, 'text/plain'),
      );
      const err = (await getFares().catch((e) => e)) as McpError;
      expect(err.data).toMatchObject({ reason: 'api_unavailable', status: 400 });
    });

    it('words a trip-date rejection for fares, keeping WSF’s stated range whole', async () => {
      stubFares(makeResponse(FARES_DATE_REJECTION, 400), makeResponse(TERMINAL_COMBOS['1-10']));
      const err = (await getFares().catch((e) => e)) as McpError;
      expect(err.message).toBe(
        `WSF has no fares for the requested trip date. ${FARES_DATE_REJECTION.Message}`,
      );
      expect(err.message).toContain('11/11/2026 - 3/20/2027');
      expect(err.data?.url).toBe(`https://www.wsdot.wa.gov/Ferries/API${LINE_ITEMS}`);
    });
  });

  describe('a failed terminal-combo request, on a call whose line items arrived', () => {
    it.each([
      ['a trip-date rejection', makeResponse(FARES_DATE_REJECTION, 400), 'WSF answered HTTP 400'],
      ['a pair rejection', makeResponse(FARES_PAIR_REJECTION, 400), 'WSF answered HTTP 400'],
      ['another 4xx', makeResponse('Not Found', 404, 'text/plain'), 'WSF answered HTTP 404'],
      ['a 5xx', makeResponse('Service Unavailable', 503, 'text/plain'), 'WSF answered HTTP 503'],
      [
        'an HTTP 200 carrying {"Message"}',
        makeResponse({ Message: 'Invalid terminal combination.' }),
        'the request failed',
      ],
      ['a timeout', timeoutError(), 'the request timed out'],
      ['a network failure', new Error('Unable to connect.'), 'the request failed'],
    ])('degrades on %s to the line items alone, saying why', async (_label, combo, detail) => {
      stubFares(makeResponse(fareLineItems('1-10-oneway')), combo);
      const result = await getFares();
      expect(result.combo).toEqual({ kind: 'unavailable', detail });
      expect(result.fares).toHaveLength(22);
    });

    it('fails the call on an access-code rejection — a configuration fault, not an outage', async () => {
      stubFares(
        makeResponse(fareLineItems('1-10-oneway')),
        makeResponse(UNREGISTERED_CODE_BODY, 400),
      );
      const err = (await getFares().catch((e) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(err.data).toMatchObject({ reason: 'invalid_access_code' });
    });

    it('fails the call when the caller cancels, rather than returning a degraded answer', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation((url) => {
        if (String(url).includes('/terminalcombo/')) {
          controller.abort();
          return Promise.reject(Object.assign(new Error('Aborted.'), { name: 'AbortError' }));
        }
        return Promise.resolve(makeResponse(fareLineItems('1-10-oneway')));
      });
      const err = (await getFares(createMockContext({ signal: controller.signal })).catch(
        (e) => e,
      )) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toBe('WSF Ferry API request cancelled.');
    });

    it('rethrows a failure that is not a classified upstream error', async () => {
      stubFares(makeResponse(fareLineItems('1-10-oneway')), makeResponse('not json'));
      await expect(getFares()).rejects.toBeInstanceOf(SyntaxError);
    });
  });

  describe('one deadline across the call', () => {
    let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it.each([
      ['plenty of budget left', 50_000, 15_000],
      ['less than one attempt’s timeout left', 4_000, 4_000],
      ['none left', -1_000, 0],
    ])(
      'bounds each fares request’s timeout by what is left of the budget — %s',
      async (_label, leftMs, expectedMs) => {
        stubFares(
          makeResponse(fareLineItems('1-10-oneway')),
          makeResponse(TERMINAL_COMBOS['1-10']),
        );
        await svc.getFares(1, 10, FARES_TRIP_DATE, false, createMockContext(), Date.now() + leftMs);
        expect(timeoutSpy.mock.calls).toEqual([[expectedMs], [expectedMs]]);
      },
    );

    it('gives the routes check what is left of the same deadline', async () => {
      mockFetch.mockResolvedValue(makeResponse([{ RouteID: 9 }]));
      expect(await svc.hasRoutes(FARES_TRIP_DATE, createMockContext(), Date.now() + 7_500)).toBe(
        true,
      );
      expect(timeoutSpy.mock.calls).toEqual([[7_500]]);
    });

    it('keeps the 15 s per-attempt timeout on a request with no deadline (characterization)', async () => {
      mockFetch.mockResolvedValue(makeResponse([{ RouteID: 9 }]));
      await svc.hasRoutes(FARES_TRIP_DATE, createMockContext());
      expect(timeoutSpy.mock.calls).toEqual([[15_000]]);
    });
  });
});
