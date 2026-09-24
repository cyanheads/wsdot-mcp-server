/**
 * @fileoverview Wire-level tests for the WSF ferry tools. Only the upstream HTTP boundary is stubbed:
 * the real `FerryApiService` builds URLs, classifies statuses and WSF's rejection bodies, and
 * normalizes payloads, while `runToolContract` carries each call through schema validation, the
 * handler, `format()`, enrichment, and the production error envelope. Each assertion is therefore
 * about what a client receives on `structuredContent` and `content[]`.
 * @module tests/tools/ferry-wire.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

import { getFerryRoutes } from '@/mcp-server/tools/definitions/get-ferry-routes.tool.js';
import { getFerrySchedule } from '@/mcp-server/tools/definitions/get-ferry-schedule.tool.js';
import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { initFerryApiService } from '@/services/ferry/ferry-service.js';

const API = 'https://www.wsdot.wa.gov/Ferries/API';

/** A future trip date — the dated `schedule/{TripDate}/…` path, never `scheduletoday`. */
const TRIP_DATE = '2026-09-25';

const routesFor = (date: string) => new RegExp(`/Schedule/rest/routes/${date}\\?`);
const scheduleFor = (date: string, from: number, to: number) =>
  new RegExp(`/Schedule/rest/schedule/${date}/${from}/${to}\\?`);
const TERMINALS = /\/Terminals\/rest\/terminal(basics|locations)\?/;
const BY_ROUTE = /\/Schedule\/rest\/terminalsandmatesbyroute\/(\d{4}-\d{2}-\d{2})\/(\d+)\?/;
const CACHE_FLUSH = /\/Schedule\/rest\/cacheflushdate\?/;

/** WSF's verbatim rejection of a date outside its published window (served as HTTP 400). */
const TRIP_DATE_REJECTION = {
  Message:
    "The TripDate 1/1/2099 is not valid. The valid range begins with today's date (9/24/2026) and extends to the end of the most recently posted schedule (3/20/2027).",
};

/** WSF's verbatim rejection of a pair it has no schedule for (HTTP 400). */
const pairRejection = (from: number, to: number, date: string) => ({
  Message: `The terminal combination DepartingTerminalID ${from} and ArrivingTerminalID ${to} is not valid for a TripDate of ${date}.`,
});

/** WSF's verbatim rejection of an unregistered access code (HTTP 400). */
const UNREGISTERED_CODE = {
  Message:
    "Use of WSDOT Traveler API failed.  Please make sure you've registered (at this location https://wsdot.wa.gov/traffic/api/) for a developer Access Code.  This value should then be passed with every service request.",
};

const LIVE_ROUTE = {
  RouteID: 5,
  RouteAbbrev: 'sea-bi',
  Description: 'Seattle / Bainbridge Island',
  RegionID: 4,
  ServiceDisruptions: [],
};

const SEA_BI_PAIRS = [
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
];

/** One interisland pair as WSF serves it: mixed loading rules, HTML in both note fields. */
const ORCAS_SHAW_SCHEDULE = {
  ScheduleID: 198,
  ScheduleName: 'Fall 2026',
  TerminalCombos: [
    {
      DepartingTerminalID: 15,
      DepartingTerminalName: 'Orcas Island',
      ArrivingTerminalID: 18,
      ArrivingTerminalName: 'Shaw Island',
      SailingNotes: '',
      Annotations: [
        'No interisland vehicles. Foot passenger and bikes okay.',
        "This interisland trip travels in a 'T' pattern: FH-Lopez-Shaw-Orcas, then Orcas-Shaw-Lopez-FH.",
      ],
      AnnotationsIVR: [
        'No interisland vehicles. Foot passengers and bikes okay.',
        "This interisland trip travels in a 'T' pattern: FH-Lopez-Shaw-Orcas, then Orcas-Shaw-Lopez-FH.",
      ],
      Times: [
        {
          DepartingTime: '/Date(1790344200000-0700)/',
          ArrivingTime: '/Date(1790345100000-0700)/',
          LoadingRule: 3,
          VesselID: 2,
          VesselName: 'Chelan',
          VesselHandicapAccessible: true,
          VesselPositionNum: 1,
          Routes: [9],
          AnnotationIndexes: [],
        },
        {
          DepartingTime: '/Date(1790351700000-0700)/',
          ArrivingTime: '/Date(1790352600000-0700)/',
          LoadingRule: 1,
          VesselID: 38,
          VesselName: 'Yakima',
          VesselHandicapAccessible: true,
          VesselPositionNum: 2,
          Routes: [9],
          AnnotationIndexes: [0, 1],
        },
      ],
    },
  ],
};

const http = createFetchMock();

beforeEach(() => {
  initFerryApiService({} as never, {} as never);
  http.reset();
  http.install();
});

afterEach(() => {
  http.restore();
});

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block of a contract result, joined. */
function wireText(result: ContractResult): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

interface WireError {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

/** The error envelope of a failed call, from `structuredContent.error`. */
function wireError(result: ContractResult): WireError {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error?: WireError } | undefined)?.error;
  if (!error) throw new Error('Expected structuredContent.error on a failed call.');
  return error;
}

/** Paths of every upstream request, credential query string dropped. */
function requestedPaths(): string[] {
  return http.calls.map((c) => c.request.url.split('?')[0]?.replace(API, '') ?? '');
}

/** Stub the requests a successful routes call for `date` makes. */
function stubRoutes(date: string, routes: unknown[], flush = '/Date(1790284800913-0700)/') {
  http.route(
    { match: routesFor(date), respond: Response.json(routes) },
    { match: CACHE_FLUSH, respond: Response.json(flush) },
    {
      match: BY_ROUTE,
      respond: (request) => {
        const routeId = Number(BY_ROUTE.exec(request.url)?.[2]);
        return Response.json(routeId === 5 ? SEA_BI_PAIRS : []);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Characterization — behavior the batch must leave unchanged
// ---------------------------------------------------------------------------

describe('ferry tools on the wire — unchanged behavior', () => {
  it('wsdot_get_ferry_routes keeps routeId, routeAbbrev, and description on both surfaces', async () => {
    stubRoutes(TRIP_DATE, [LIVE_ROUTE]);
    const result = await runToolContract(getFerryRoutes, { tripDate: TRIP_DATE });
    expect(result.isError).toBeFalsy();
    const { routes } = result.structuredContent as { routes: Record<string, unknown>[] };
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeId: 5,
      routeAbbrev: 'sea-bi',
      description: 'Seattle / Bainbridge Island',
    });
    expect(result.structuredContent).toMatchObject({ tripDate: TRIP_DATE, totalCount: 1 });
    const text = wireText(result);
    expect(text).toContain('### Seattle / Bainbridge Island');
    expect(text).toContain('**Abbrev:** sea-bi');
    expect(text).toContain('**Route ID:** 5');
  });

  it('wsdot_get_ferry_schedule keeps its existing fields on both surfaces', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 15, 18),
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: TRIP_DATE,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      sailings: Record<string, unknown>[];
    } & Record<string, unknown>;
    expect(structured).toMatchObject({
      departingTerminalName: 'Orcas Island',
      arrivingTerminalName: 'Shaw Island',
      tripDate: TRIP_DATE,
      totalSailings: 2,
    });
    expect(structured.sailings[0]).toMatchObject({
      departureTime: '2026-09-25T13:50:00.000Z',
      arrivalTime: '2026-09-25T14:05:00.000Z',
      vesselName: 'Chelan',
    });
    expect(structured.sailings[1]).toMatchObject({
      departureTime: '2026-09-25T15:55:00.000Z',
      arrivalTime: '2026-09-25T16:10:00.000Z',
      vesselName: 'Yakima',
    });
    const text = wireText(result);
    expect(text).toContain('## Ferry Schedule — Orcas Island → Shaw Island');
    expect(text).toContain('- 2026-09-25T13:50:00.000Z → 2026-09-25T14:05:00.000Z | Chelan');
    expect(text).toContain('- 2026-09-25T15:55:00.000Z → 2026-09-25T16:10:00.000Z | Yakima');
  });

  it('wsdot_get_ferry_schedule reports a non-through pair on a date with routes as invalid_terminal_pair', async () => {
    http.route(
      {
        match: scheduleFor(TRIP_DATE, 7, 1),
        respond: Response.json(pairRejection(7, 1, '9/25/2026'), { status: 400 }),
      },
      { match: routesFor(TRIP_DATE), respond: Response.json([LIVE_ROUTE]) },
    );
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 7,
      arrivingTerminalId: 1,
      tripDate: TRIP_DATE,
    });
    const error = wireError(result);
    expect(error.data?.reason).toBe('invalid_terminal_pair');
    expect(wireText(result)).toContain('(reason invalid_terminal_pair');
  });

  it('wsdot_get_ferry_schedule keeps an access-code rejection as invalid_access_code', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 7, 3),
      respond: Response.json(UNREGISTERED_CODE, { status: 400 }),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: TRIP_DATE,
    });
    const error = wireError(result);
    expect(error.data?.reason).toBe('invalid_access_code');
    expect(requestedPaths()).toEqual([`/Schedule/rest/schedule/${TRIP_DATE}/7/3`]);
  });

  it('wsdot_get_ferry_terminals keeps the IDs, names, and abbreviations WSF sends', async () => {
    http.route({
      match: TERMINALS,
      respond: Response.json([
        { TerminalID: 1, TerminalName: 'Anacortes', TerminalAbbrev: 'ANA', SortSeq: 10 },
        { TerminalID: 11, TerminalName: 'Coupeville ', TerminalAbbrev: 'COU', SortSeq: 20 },
      ]),
    });
    const result = await runToolContract(getFerryTerminals, {});
    expect(result.isError).toBeFalsy();
    const { terminals } = result.structuredContent as { terminals: Record<string, unknown>[] };
    expect(terminals).toEqual([
      { terminalId: 1, terminalName: 'Anacortes', terminalAbbrev: 'ANA' },
      { terminalId: 11, terminalName: 'Coupeville', terminalAbbrev: 'COU' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #42 — terminal coordinates come from terminallocations
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_terminals on the wire — coordinates', () => {
  const LOCATIONS = /\/Terminals\/rest\/terminallocations\?/;

  it('fetches terminallocations and carries both coordinates on both surfaces', async () => {
    http.route({
      match: LOCATIONS,
      respond: Response.json([
        {
          TerminalID: 1,
          TerminalName: 'Anacortes',
          TerminalAbbrev: 'ANA',
          Latitude: 48.507351,
          Longitude: -122.677,
          AddressLineOne: '2100 Ferry Terminal Road',
          MapLink: 'https://maps.example/ana</p>',
        },
        {
          TerminalID: 11,
          TerminalName: 'Coupeville ',
          TerminalAbbrev: 'COU',
          Latitude: 48.159008,
          Longitude: -122.672603,
        },
      ]),
    });
    const result = await runToolContract(getFerryTerminals, {});
    expect(result.isError).toBeFalsy();
    expect(requestedPaths()).toEqual(['/Terminals/rest/terminallocations']);
    const { terminals } = result.structuredContent as { terminals: Record<string, unknown>[] };
    expect(terminals).toEqual([
      {
        terminalId: 1,
        terminalName: 'Anacortes',
        terminalAbbrev: 'ANA',
        latitude: 48.507351,
        longitude: -122.677,
      },
      {
        terminalId: 11,
        terminalName: 'Coupeville',
        terminalAbbrev: 'COU',
        latitude: 48.159008,
        longitude: -122.672603,
      },
    ]);
    const text = wireText(result);
    expect(text).toContain('- **Anacortes** (ANA) — ID: 1 | 48.507351, -122.677');
    expect(text).toContain('- **Coupeville** (COU) — ID: 11 | 48.159008, -122.672603');
    expect(text).not.toContain('2100 Ferry Terminal Road');
  });

  it('renders the populated side and names the absent one when a coordinate is missing', async () => {
    http.route({
      match: LOCATIONS,
      respond: Response.json([
        { TerminalID: 1, TerminalName: 'Anacortes', TerminalAbbrev: 'ANA', Latitude: 48.507351 },
      ]),
    });
    const result = await runToolContract(getFerryTerminals, {});
    expect((result.structuredContent as { terminals: unknown[] }).terminals).toEqual([
      { terminalId: 1, terminalName: 'Anacortes', terminalAbbrev: 'ANA', latitude: 48.507351 },
    ]);
    expect(wireText(result)).toContain('ID: 1 | 48.507351, longitude not reported');
  });

  it('keeps an outage as api_unavailable and an unregistered code as invalid_access_code', async () => {
    http.route({
      match: LOCATIONS,
      once: true,
      respond: Response.json(UNREGISTERED_CODE, { status: 400 }),
    });
    const rejected = wireError(await runToolContract(getFerryTerminals, {}));
    expect(rejected.data).toMatchObject({
      reason: 'invalid_access_code',
      url: `${API}/Terminals/rest/terminallocations`,
      recovery: { hint: expect.stringContaining('WSDOT_ACCESS_CODE') },
    });

    http.route({ match: LOCATIONS, respond: new Response('Bad Request', { status: 400 }) });
    const outage = wireError(await runToolContract(getFerryTerminals, {}));
    expect(outage.data).toMatchObject({
      reason: 'api_unavailable',
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
  });
});

// ---------------------------------------------------------------------------
// #40 — a date WSF has no schedule for is an input error, not an outage or a bad pair
// ---------------------------------------------------------------------------

describe('ferry dates without a published schedule, on the wire', () => {
  const PAST_REJECTION = {
    Message:
      "The TripDate 9/23/2026 is not valid. The valid range begins with today's date (9/24/2026) and extends to the end of the most recently posted schedule (3/20/2027).",
  };

  it.each([
    ['past the window', '2099-01-01', TRIP_DATE_REJECTION],
    ['before today', '2026-09-23', PAST_REJECTION],
  ])(
    'wsdot_get_ferry_routes fails a date %s as non-retryable invalid_date with WSF’s range',
    async (_label, date, body) => {
      http.route({ match: routesFor(date), respond: Response.json(body, { status: 400 }) });
      const result = await runToolContract(getFerryRoutes, { tripDate: date });
      const error = wireError(result);
      expect(error.code).toBe(-32007);
      expect(error.data).toMatchObject({
        reason: 'invalid_date',
        retryable: false,
        recovery: { hint: expect.stringContaining('posted schedule') },
      });
      expect(error.message).toContain('9/24/2026');
      expect(error.message).toContain('3/20/2027');
      const text = wireText(result);
      expect(text).toContain('Recovery: Use a YYYY-MM-DD date from today');
      expect(text).toContain('(reason invalid_date · not retryable)');
      expect(text).not.toContain('Retry in 30 seconds');
    },
  );

  it.each([
    ['past the window', '2099-01-01', TRIP_DATE_REJECTION],
    ['before today', '2026-09-23', PAST_REJECTION],
  ])(
    'wsdot_get_ferry_schedule fails a date %s as invalid_date, not invalid_terminal_pair',
    async (_label, date, body) => {
      http.route({ match: scheduleFor(date, 7, 3), respond: Response.json(body, { status: 400 }) });
      const result = await runToolContract(getFerrySchedule, {
        departingTerminalId: 7,
        arrivingTerminalId: 3,
        tripDate: date,
      });
      const error = wireError(result);
      expect(error.code).toBe(-32007);
      expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
      expect(error.message).toContain('3/20/2027');
      expect(wireText(result)).toContain('(reason invalid_date · not retryable)');
      // The rejection already names the date as the fault — no second request is needed to tell.
      expect(requestedPaths()).toEqual([`/Schedule/rest/schedule/${date}/7/3`]);
    },
  );

  it.each([getFerryRoutes, getFerrySchedule])(
    '$name rejects a malformed tripDate locally as non-retryable invalid_date',
    async (definition) => {
      const input = { departingTerminalId: 7, arrivingTerminalId: 3, tripDate: '06/08/2026' };
      const result =
        definition === getFerryRoutes
          ? await runToolContract(getFerryRoutes, { tripDate: input.tripDate })
          : await runToolContract(getFerrySchedule, input);
      const error = wireError(result);
      expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
      expect(wireText(result)).toContain('Recovery: Use a YYYY-MM-DD date');
      // A locally rejected date never reached WSF, so no range came back for the hint to point at.
      expect(error.message).not.toMatch(/valid range/);
      expect(wireText(result)).not.toMatch(/the error message states the range/);
      expect(http.calls).toHaveLength(0);
    },
  );

  it('classifies the TripDate rejection whatever the status — here an HTTP 200 carrying it', async () => {
    http.route({ match: routesFor('2099-01-01'), respond: Response.json(TRIP_DATE_REJECTION) });
    const error = wireError(await runToolContract(getFerryRoutes, { tripDate: '2099-01-01' }));
    expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
  });

  it('wsdot_get_ferry_schedule fails an in-window date with no routes loaded as invalid_date', async () => {
    const gap = '2027-01-15';
    http.route(
      {
        match: scheduleFor(gap, 7, 3),
        respond: Response.json(pairRejection(7, 3, '1/15/2027'), { status: 400 }),
      },
      { match: routesFor(gap), respond: Response.json([]) },
    );
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: gap,
    });
    const error = wireError(result);
    expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
    expect(error.message).toContain(gap);
    expect(wireText(result)).toContain('(reason invalid_date · not retryable)');
    expect(requestedPaths()).toEqual([
      `/Schedule/rest/schedule/${gap}/7/3`,
      `/Schedule/rest/routes/${gap}`,
    ]);
  });

  it('wsdot_get_ferry_routes answers a date with no routes with [] and a notice that does not advise a retry', async () => {
    const gap = '2027-01-15';
    stubRoutes(gap, []);
    const result = await runToolContract(getFerryRoutes, { tripDate: gap });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { notice?: string; routes: unknown[] };
    expect(structured.routes).toEqual([]);
    expect(structured.notice).toContain(gap);
    expect(structured.notice).not.toMatch(/retry|temporarily unavailable/i);
    expect(wireText(result)).toContain(structured.notice as string);
  });

  it('reports the effective remainingOnly (false) for a future date on both surfaces', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 15, 18),
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: TRIP_DATE,
      remainingOnly: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ remainingOnly: false, totalSailings: 2 });
    expect(wireText(result)).toContain('**remainingOnly:** false');
    expect(wireText(result)).not.toContain('**remainingOnly:** true');
  });

  it('does not describe an empty future-date schedule as “no remaining sailings today”', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 15, 18),
      respond: Response.json({
        TerminalCombos: [{ ...ORCAS_SHAW_SCHEDULE.TerminalCombos[0], Times: [] }],
      }),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: TRIP_DATE,
      remainingOnly: true,
    });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain(TRIP_DATE);
    expect(notice).not.toContain('remaining sailings today');
  });

  it('keeps same-day remainingOnly: true as requested (characterization)', async () => {
    const { FerryApiService } = await import('@/services/ferry/ferry-service.js');
    const today = FerryApiService.todayFerryDate();
    http.route({
      match: /\/Schedule\/rest\/scheduletoday\/15\/18\/true\?/,
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: today,
      remainingOnly: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ remainingOnly: true, tripDate: today });
    expect(wireText(result)).toContain('**remainingOnly:** true');
  });
});

// ---------------------------------------------------------------------------
// #41 — the terminal pairs each route serves
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_routes on the wire — terminal pairs', () => {
  const ROUTES = [
    LIVE_ROUTE,
    { RouteID: 21, RouteAbbrev: 'x', Description: 'Seasonal route', RegionID: 1 },
  ];

  it('carries every served pair on both surfaces, and states an empty list', async () => {
    stubRoutes(TRIP_DATE, ROUTES);
    const result = await runToolContract(getFerryRoutes, { tripDate: TRIP_DATE });
    expect(result.isError).toBeFalsy();
    const { routes } = result.structuredContent as { routes: Record<string, unknown>[] };
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
      { routeId: 21, routeAbbrev: 'x', description: 'Seasonal route', terminalPairs: [] },
    ]);
    const text = wireText(result);
    expect(text).toContain('- Bainbridge Island (3) → Seattle (7)');
    expect(text).toContain('- Seattle (7) → Bainbridge Island (3)');
    expect(text).toContain('### Seasonal route');
    expect(text).toContain('**Terminal pairs:** none served on this date');
  });

  it('answers a repeat call for the same date without looking the pairs up again', async () => {
    stubRoutes(TRIP_DATE, ROUTES);
    await runToolContract(getFerryRoutes, { tripDate: TRIP_DATE });
    const firstCall = requestedPaths();
    expect(firstCall.filter((p) => p.includes('terminalsandmatesbyroute'))).toHaveLength(2);

    http.reset();
    stubRoutes(TRIP_DATE, ROUTES);
    const repeat = await runToolContract(getFerryRoutes, { tripDate: TRIP_DATE });
    expect(repeat.isError).toBeFalsy();
    expect(requestedPaths()).toEqual([
      `/Schedule/rest/routes/${TRIP_DATE}`,
      '/Schedule/rest/cacheflushdate',
    ]);
    expect(wireText(repeat)).toContain('- Seattle (7) → Bainbridge Island (3)');
  });

  it('fails the call, rather than listing a route without its pairs, when a lookup fails', async () => {
    http.route(
      { match: routesFor(TRIP_DATE), respond: Response.json(ROUTES) },
      { match: CACHE_FLUSH, respond: Response.json('/Date(1790284800913-0700)/') },
      {
        match: /\/terminalsandmatesbyroute\/[\d-]+\/21\?/,
        respond: new Response('Bad Request', { status: 400 }),
      },
      { match: BY_ROUTE, respond: Response.json(SEA_BI_PAIRS) },
    );
    const error = wireError(await runToolContract(getFerryRoutes, { tripDate: TRIP_DATE }));
    expect(error.data).toMatchObject({
      reason: 'api_unavailable',
      url: `${API}/Schedule/rest/terminalsandmatesbyroute/${TRIP_DATE}/21`,
    });
  });

  it('points an invalid_terminal_pair at terminalPairs on wsdot_get_ferry_routes for the same date', async () => {
    http.route(
      {
        match: scheduleFor(TRIP_DATE, 7, 1),
        respond: Response.json(pairRejection(7, 1, '9/25/2026'), { status: 400 }),
      },
      { match: routesFor(TRIP_DATE), respond: Response.json([LIVE_ROUTE]) },
    );
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 7,
      arrivingTerminalId: 1,
      tripDate: TRIP_DATE,
    });
    const error = wireError(result);
    const hint = (error.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
    expect(hint).toContain('terminalPairs');
    expect(hint).toContain('wsdot_get_ferry_routes');
    expect(wireText(result)).toContain(`Recovery: ${hint}`);
  });
});

// ---------------------------------------------------------------------------
// #50 — per-sailing loading rule, vessel ID, and annotations
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_schedule on the wire — loading rule, vessel, and annotations', () => {
  interface WireSailing {
    annotationIndexes?: number[];
    loadingRule?: number;
    vesselHandicapAccessible?: boolean;
    vesselId?: number;
    vesselName?: string;
  }
  interface WireSchedule {
    annotations?: string[];
    sailingNotes?: string;
    sailings: WireSailing[];
  }

  const KINGSTON_EDMONDS = {
    TerminalCombos: [
      {
        DepartingTerminalID: 12,
        DepartingTerminalName: 'Kingston',
        ArrivingTerminalID: 8,
        ArrivingTerminalName: 'Edmonds',
        SailingNotes:
          '<p><a href="https://tinyurl.com/mptshczh" target="_blank" rel="noopener noreferrer">Boarding pass required for vehicles</a> 8 a.m.–8 p.m. to hold your place in line at Kingston.</p>',
        Annotations: [
          'The 5:30am sailing from Kingston will operate approximately 10 minutes late.',
          '<a href="https://tinyurl.com/mptshczh">Boarding Pass</a> required for vehicles.',
        ],
        Times: [
          {
            DepartingTime: '/Date(1790344200000-0700)/',
            ArrivingTime: null,
            LoadingRule: 3,
            VesselID: 25,
            VesselName: 'Puyallup',
            VesselHandicapAccessible: true,
            AnnotationIndexes: [0, 1],
          },
        ],
      },
    ],
  };

  it('reports each sailing’s own loadingRule on a pair that mixes them, on both surfaces', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 15, 18),
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: TRIP_DATE,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as WireSchedule;
    expect(structured.sailings.map((s) => [s.vesselId, s.loadingRule])).toEqual([
      [2, 3],
      [38, 1],
    ]);
    expect(structured.sailings.every((s) => s.vesselHandicapAccessible === true)).toBe(true);
    const text = wireText(result);
    expect(text).toContain(
      '| Chelan (vesselId 2) | loadingRule 3 | vesselHandicapAccessible: true',
    );
    expect(text).toContain(
      '| Yakima (vesselId 38) | loadingRule 1 | vesselHandicapAccessible: true',
    );
  });

  it('resolves every sailing’s annotationIndexes to its pair’s annotations, in content[] on that sailing', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 15, 18),
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 15,
      arrivingTerminalId: 18,
      tripDate: TRIP_DATE,
    });
    const structured = result.structuredContent as WireSchedule;
    const annotations = structured.annotations ?? [];
    expect(annotations).toHaveLength(2);
    for (const s of structured.sailings) {
      for (const i of s.annotationIndexes ?? []) expect(annotations[i]).toBeDefined();
    }
    const text = wireText(result);
    const yakima = text.split('\n- ').find((block) => block.includes('Yakima')) ?? '';
    expect(yakima).toContain(`  - [0] ${annotations[0]}`);
    expect(yakima).toContain(`  - [1] ${annotations[1]}`);
    const chelan = text.split('\n- ').find((block) => block.includes('Chelan')) ?? '';
    expect(chelan).not.toContain('  - [');
  });

  it('carries neither note field as HTML on either surface', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 12, 8),
      respond: Response.json(KINGSTON_EDMONDS),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 12,
      arrivingTerminalId: 8,
      tripDate: TRIP_DATE,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as WireSchedule;
    expect(structured.sailingNotes).toBe(
      'Boarding pass required for vehicles (https://tinyurl.com/mptshczh) 8 a.m.–8 p.m. to hold your place in line at Kingston.',
    );
    expect(structured.annotations?.[1]).toBe(
      'Boarding Pass (https://tinyurl.com/mptshczh) required for vehicles.',
    );
    const text = wireText(result);
    expect(JSON.stringify(structured)).not.toMatch(/<\/?[a-z]/i);
    expect(text).not.toMatch(/<\/?[a-z]/i);
    expect(text).toContain(`**Sailing notes:** ${structured.sailingNotes}`);
    expect(text).toContain(`  - [1] ${structured.annotations?.[1]}`);
  });

  it('states an empty annotations list on both surfaces', async () => {
    http.route({
      match: scheduleFor(TRIP_DATE, 7, 3),
      respond: Response.json({
        TerminalCombos: [
          {
            DepartingTerminalName: 'Seattle',
            ArrivingTerminalName: 'Bainbridge Island',
            SailingNotes: '',
            Annotations: [],
            Times: [
              {
                DepartingTime: '/Date(1790344200000-0700)/',
                ArrivingTime: '/Date(1790346300000-0700)/',
                LoadingRule: 3,
                VesselID: 36,
                VesselName: 'Wenatchee',
                VesselHandicapAccessible: true,
                AnnotationIndexes: [],
              },
            ],
          },
        ],
      }),
    });
    const result = await runToolContract(getFerrySchedule, {
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: TRIP_DATE,
    });
    const structured = result.structuredContent as WireSchedule;
    expect(structured.annotations).toEqual([]);
    expect(structured.sailings[0]?.annotationIndexes).toEqual([]);
    expect('sailingNotes' in structured).toBe(false);
    const text = wireText(result);
    expect(text).toContain('**Annotations:** none');
    expect(text).not.toContain('Sailing notes');
  });
});
