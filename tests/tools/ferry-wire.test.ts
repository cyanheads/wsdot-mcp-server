/**
 * @fileoverview Wire-level tests for the WSF ferry tools. Only the upstream HTTP boundary is stubbed:
 * the real `FerryApiService` builds URLs, classifies statuses and WSF's rejection bodies, and
 * normalizes payloads, while `runToolContract` carries each call through schema validation, the
 * handler, `format()`, enrichment, and the production error envelope. Each assertion is therefore
 * about what a client receives on `structuredContent` and `content[]`.
 * @module tests/tools/ferry-wire.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

import { getFerryAlerts } from '@/mcp-server/tools/definitions/get-ferry-alerts.tool.js';
import { getFerryRoutes } from '@/mcp-server/tools/definitions/get-ferry-routes.tool.js';
import { getFerrySchedule } from '@/mcp-server/tools/definitions/get-ferry-schedule.tool.js';
import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { getTerminalSpace } from '@/mcp-server/tools/definitions/get-terminal-space.tool.js';
import { getVesselLocations } from '@/mcp-server/tools/definitions/get-vessel-locations.tool.js';
import { initFerryApiService } from '@/services/ferry/ferry-service.js';
import { wireError } from '../helpers/assertions.js';
import { DATE_ROLLED_REJECTION, scheduleCapture } from '../helpers/wsf-schedule.js';

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

/** The recovery the dated ferry tools declare for a call that spends its 50 s budget. */
const DEADLINE_HINT =
  'Retry in 30 seconds. If the issue persists, check wsdot.wa.gov/ferries for service status.';

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
      departureTimeLocal: '2026-09-25T06:50:00.000-07:00',
      arrivalTime: '2026-09-25T14:05:00.000Z',
      arrivalTimeLocal: '2026-09-25T07:05:00.000-07:00',
      serviceDate: TRIP_DATE,
      vesselName: 'Chelan',
    });
    expect(structured.sailings[1]).toMatchObject({
      departureTime: '2026-09-25T15:55:00.000Z',
      departureTimeLocal: '2026-09-25T08:55:00.000-07:00',
      arrivalTime: '2026-09-25T16:10:00.000Z',
      arrivalTimeLocal: '2026-09-25T09:10:00.000-07:00',
      serviceDate: TRIP_DATE,
      vesselName: 'Yakima',
    });
    const text = wireText(result);
    expect(text).toContain('## Ferry Schedule — Orcas Island → Shaw Island');
    // Each time renders as its Pacific form with the UTC instant after it, then its service day.
    expect(text).toContain(
      '- 2026-09-25T06:50:00.000-07:00 (2026-09-25T13:50:00.000Z) → 2026-09-25T07:05:00.000-07:00 (2026-09-25T14:05:00.000Z) | serviceDate 2026-09-25 | Chelan',
    );
    expect(text).toContain(
      '- 2026-09-25T08:55:00.000-07:00 (2026-09-25T15:55:00.000Z) → 2026-09-25T09:10:00.000-07:00 (2026-09-25T16:10:00.000Z) | serviceDate 2026-09-25 | Yakima',
    );
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
// Pacific local time beside the UTC times of the live-status tools (the schedule's is pinned
// above). WSF sends each time as a WCF date; both surfaces carry the UTC value and its sibling.
// ---------------------------------------------------------------------------

describe('ferry live-status times on the wire — Pacific beside UTC', () => {
  it('wsdot_get_vessel_locations', async () => {
    http.route({
      match: /\/Vessels\/rest\/vessellocations\?/,
      respond: Response.json([
        {
          VesselID: 38,
          VesselName: 'Yakima',
          LeftDock: '/Date(1794481510000-0800)/',
          Eta: null,
          ScheduledDeparture: '/Date(1794481200000-0800)/',
          OpRouteAbbrev: ['sea-bi'],
          TimeStamp: '/Date(1794481597000-0800)/',
        },
      ]),
    });
    const result = await runToolContract(getVesselLocations, {});
    expect(result.isError).toBeFalsy();
    const [vessel] = (result.structuredContent as { vessels: Record<string, unknown>[] }).vessels;
    expect(vessel).toMatchObject({
      leftDock: '2026-11-12T11:05:10.000Z',
      leftDockLocal: '2026-11-12T03:05:10.000-08:00',
      scheduledDeparture: '2026-11-12T11:00:00.000Z',
      scheduledDepartureLocal: '2026-11-12T03:00:00.000-08:00',
      timestamp: '2026-11-12T11:06:37.000Z',
      timestampLocal: '2026-11-12T03:06:37.000-08:00',
    });
    // No Eta upstream: neither form appears on either surface.
    expect(vessel).not.toHaveProperty('eta');
    expect(vessel).not.toHaveProperty('etaLocal');
    const text = wireText(result);
    expect(text).toContain(
      '**Left Dock:** 2026-11-12T03:05:10.000-08:00 (2026-11-12T11:05:10.000Z)',
    );
    expect(text).toContain(
      '**Scheduled Departure:** 2026-11-12T03:00:00.000-08:00 (2026-11-12T11:00:00.000Z)',
    );
    expect(text).toContain(
      '**Position Timestamp:** 2026-11-12T03:06:37.000-08:00 (2026-11-12T11:06:37.000Z)',
    );
    expect(text).not.toContain('**ETA:**');
  });

  it('wsdot_get_terminal_space', async () => {
    http.route({
      match: /\/Terminals\/rest\/terminalsailingspace\?/,
      respond: Response.json([
        {
          TerminalID: 7,
          TerminalName: 'Seattle',
          DepartingSpaces: [
            {
              Departure: '/Date(1790344200000-0700)/',
              VesselName: 'Wenatchee',
              SpaceForArrivalTerminals: [{ ArrivalTerminalIDs: [3], DriveUpSpaceCount: 50 }],
            },
          ],
        },
      ]),
    });
    const result = await runToolContract(getTerminalSpace, { departingTerminalId: 7 });
    expect(result.isError).toBeFalsy();
    const { terminals } = result.structuredContent as {
      terminals: { departingSpaces: Record<string, unknown>[] }[];
    };
    expect(terminals[0]?.departingSpaces[0]).toMatchObject({
      departure: '2026-09-25T13:50:00.000Z',
      departureLocal: '2026-09-25T06:50:00.000-07:00',
    });
    expect(wireText(result)).toContain(
      '**2026-09-25T06:50:00.000-07:00 (2026-09-25T13:50:00.000Z)** | Wenatchee',
    );
  });

  it('wsdot_get_ferry_alerts', async () => {
    http.route({
      match: /\/Schedule\/rest\/alerts\?/,
      respond: Response.json([
        { BulletinID: 9, AlertFullTitle: 'Notice', PublishDate: '/Date(1794481421917-0800)/' },
      ]),
    });
    const result = await runToolContract(getFerryAlerts, {});
    expect(result.isError).toBeFalsy();
    const [alert] = (result.structuredContent as { alerts: Record<string, unknown>[] }).alerts;
    expect(alert).toMatchObject({
      publishDate: '2026-11-12T11:03:41.917Z',
      publishDateLocal: '2026-11-12T03:03:41.917-08:00',
    });
    expect(wireText(result)).toContain(
      '**Published:** 2026-11-12T03:03:41.917-08:00 (2026-11-12T11:03:41.917Z)',
    );
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
    // Noon Pacific, hours past the previous service day's last sailing: one request.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T20:00:00Z'));
    const today = '2026-11-12';
    http.route({
      match: /\/Schedule\/rest\/scheduletoday\/15\/18\/true\?/,
      respond: Response.json(ORCAS_SHAW_SCHEDULE),
    });
    try {
      const result = await runToolContract(getFerrySchedule, {
        departingTerminalId: 15,
        arrivingTerminalId: 18,
        tripDate: today,
        remainingOnly: true,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ remainingOnly: true, tripDate: today });
      expect(wireText(result)).toContain('**remainingOnly:** true');
      expect(requestedPaths()).toEqual(['/Schedule/rest/scheduletoday/15/18/true']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// #55 — after midnight, remainingOnly leads with the previous service day's sailings still to depart
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_schedule on the wire — the previous service day after midnight', () => {
  const TODAY = '/Schedule/rest/scheduletoday/7/3/true';
  const PREVIOUS = '/Schedule/rest/schedule/2026-11-11/7/3';
  const routeOf = (path: string) => new RegExp(`${path.replaceAll('/', '\\/')}\\?`);
  const INPUT = { departingTerminalId: 7, arrivingTerminalId: 3, remainingOnly: true };

  interface WireSailing {
    departureTime?: string;
    serviceDate: string;
  }
  interface WireSchedule {
    notice?: string;
    sailings: WireSailing[];
    totalSailings: number;
    tripDate: string;
  }

  /** Run the tool, letting every retry backoff and timer elapse on the fake clock. */
  async function call(input: Parameters<typeof runToolContract<typeof getFerrySchedule>>[1]) {
    const pending = runToolContract(getFerrySchedule, input);
    await vi.runAllTimersAsync();
    return pending;
  }

  /** `scheduletoday` serving 11/12's capture, and 11/11's dated read answered by `previous`. */
  function stub(previous: Response | (() => Response)) {
    http.route(
      {
        match: routeOf(TODAY),
        respond: Response.json(scheduleCapture('scheduletoday-2026-11-12-7-3-true')),
      },
      { match: routeOf(PREVIOUS), respond: previous },
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T08:53:00Z')); // 00:53 PST
  });

  afterEach(() => vi.useRealTimers());

  it('leads at 00:53 with 11/11’s 01:35 sailing on both surfaces, each sailing naming its service day', async () => {
    stub(Response.json(scheduleCapture('schedule-2026-11-11-7-3')));
    const result = await call(INPUT);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as WireSchedule;
    expect(structured).toMatchObject({
      tripDate: '2026-11-12',
      remainingOnly: true,
      totalSailings: 24,
    });
    expect(structured).not.toHaveProperty('notice');
    expect(structured.sailings.slice(0, 2)).toMatchObject([
      { departureTime: '2026-11-12T09:35:00.000Z', serviceDate: '2026-11-11' },
      { departureTime: '2026-11-12T13:30:00.000Z', serviceDate: '2026-11-12' },
    ]);
    const lines = wireText(result)
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(24);
    expect(lines[0]).toBe(
      '- 2026-11-12T01:35:00.000-08:00 (2026-11-12T09:35:00.000Z) | serviceDate 2026-11-11 | Puyallup (vesselId 25) | loadingRule 3 | vesselHandicapAccessible: true',
    );
    expect(lines[1]).toMatch(
      /^- 2026-11-12T05:30:00\.000-08:00 \(2026-11-12T13:30:00\.000Z\) \| serviceDate 2026-11-12 \| /,
    );
    expect(requestedPaths().sort()).toEqual([PREVIOUS, TODAY]);
  });

  it('answers a previous-day 5xx that outlasts its retries with today’s list and a notice on both surfaces', async () => {
    stub(new Response('Service Unavailable', { status: 503 }));
    const result = await call(INPUT);
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as WireSchedule;
    expect(structured.totalSailings).toBe(23);
    expect(structured.sailings.every((s) => s.serviceDate === '2026-11-12')).toBe(true);
    const notice =
      "The previous service day's (2026-11-11) late sailings could not be checked: WSF's schedule for that day could not be read (WSF answered HTTP 503), so any of them still to depart are missing from this list. Call again to include them.";
    expect(structured.notice).toBe(notice);
    expect(wireText(result)).toContain(notice);
    expect(requestedPaths().filter((p) => p === PREVIOUS)).toHaveLength(4);
  });

  it('answers WSF rejecting the previous day’s date with today’s list and no notice', async () => {
    stub(Response.json(DATE_ROLLED_REJECTION, { status: 400 }));
    const result = await call(INPUT);
    const structured = result.structuredContent as unknown as WireSchedule;
    expect(structured.totalSailings).toBe(23);
    expect(structured).not.toHaveProperty('notice');
    expect(requestedPaths().filter((p) => p === PREVIOUS)).toHaveLength(1);
  });

  describe('one deadline across the schedule reads and the routes check', () => {
    let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

    beforeEach(() => {
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => timeoutSpy.mockRestore());

    it('gives the routes check a rejection chains only what is left of the 50 s budget', async () => {
      http.route(
        {
          match: /\/Schedule\/rest\/scheduletoday\/7\/1\/true\?/,
          respond: () => {
            vi.setSystemTime(Date.now() + 42_000);
            return Response.json(pairRejection(7, 1, '11/12/2026'), { status: 400 });
          },
        },
        {
          match: /\/Schedule\/rest\/schedule\/2026-11-11\/7\/1\?/,
          respond: Response.json(pairRejection(7, 1, '11/11/2026'), { status: 400 }),
        },
        { match: routesFor('2026-11-12'), respond: Response.json([LIVE_ROUTE]) },
      );
      const error = wireError(await call({ ...INPUT, arrivingTerminalId: 1 }));
      expect(error.data?.reason).toBe('invalid_terminal_pair');
      // scheduletoday, then the previous day's read and the routes check once 42 s are gone (the
      // fetch stub answers inside fetch(), before the second read starts).
      expect(timeoutSpy.mock.calls).toEqual([[15_000], [8_000], [8_000]]);
    });

    it('settles a scheduletoday read that spends the budget as a Timeout', async () => {
      http.route(
        {
          match: routeOf(TODAY),
          respond: () => {
            vi.setSystemTime(Date.now() + 55_000);
            return new Response('Service Unavailable', { status: 503 });
          },
        },
        {
          match: routeOf(PREVIOUS),
          respond: Response.json(scheduleCapture('schedule-2026-11-11-7-3')),
        },
      );
      const result = await call(INPUT);
      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.message).toBe(
        'WSF Ferry API request exceeded its 50000ms retry deadline after 1 attempt.',
      );
      expect(JSON.stringify(result)).not.toMatch(/FerryApiService|fetchJson/);
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        recovery: { hint: DEADLINE_HINT },
      });
      expect(wireText(result)).toContain(`Recovery: ${DEADLINE_HINT}`);
      expect(requestedPaths().filter((p) => p === TODAY)).toHaveLength(1);
    });

    it('settles a previous-day read that spends the budget as today’s list with a timed-out notice', async () => {
      stub(() => {
        vi.setSystemTime(Date.now() + 55_000);
        return new Response('Service Unavailable', { status: 503 });
      });
      const result = await call(INPUT);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as unknown as WireSchedule;
      expect(structured.totalSailings).toBe(23);
      expect(structured.notice).toContain('could not be read (the request timed out)');
      expect(requestedPaths().filter((p) => p === PREVIOUS)).toHaveLength(1);
    });
  });
});

describe('wsdot_get_ferry_routes on the wire — one deadline across the call', () => {
  let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T19:00:00Z'));
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  async function call(tripDate: string) {
    const pending = runToolContract(getFerryRoutes, { tripDate });
    await vi.runAllTimersAsync();
    return pending;
  }

  it('gives the flush-stamp check and the pair lookups only what is left of the 50 s budget', async () => {
    http.route(
      {
        match: routesFor(TRIP_DATE),
        respond: () => {
          vi.setSystemTime(Date.now() + 42_000);
          return Response.json([LIVE_ROUTE]);
        },
      },
      { match: CACHE_FLUSH, respond: Response.json('/Date(1790284800913-0700)/') },
      { match: BY_ROUTE, respond: Response.json(SEA_BI_PAIRS) },
    );
    const result = await call(TRIP_DATE);
    expect(result.isError).toBeFalsy();
    expect(timeoutSpy.mock.calls).toEqual([[15_000], [8_000], [8_000]]);
  });

  it('settles a pair lookup that runs past the budget as a Timeout', async () => {
    http.route(
      { match: routesFor('2026-09-26'), respond: Response.json([LIVE_ROUTE]) },
      { match: CACHE_FLUSH, respond: Response.json('/Date(1790284800913-0700)/') },
      {
        match: BY_ROUTE,
        respond: () => {
          vi.setSystemTime(Date.now() + 55_000);
          return new Response('Service Unavailable', { status: 503 });
        },
      },
    );
    const result = await call('2026-09-26');
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(
      'WSF Ferry API request exceeded its 50000ms retry deadline after 1 attempt.',
    );
    expect(JSON.stringify(result)).not.toMatch(/FerryApiService|fetchJson/);
    expect(error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      recovery: { hint: DEADLINE_HINT },
    });
    expect(wireText(result)).toContain(`Recovery: ${DEADLINE_HINT}`);
  });
});

// ---------------------------------------------------------------------------
// #60 — an empty sailing-space feed, or one that does not cover the terminal, is not an outage
// ---------------------------------------------------------------------------

describe('wsdot_get_terminal_space on the wire — an empty page names its cause', () => {
  const SPACE = /\/Terminals\/rest\/terminalsailingspace\?/;
  /** The 12 terminals WSF's populated feed reported at 03:11 PST on 2026-11-12, names verbatim. */
  const COVERED: [number, string][] = [
    [1, 'Anacortes'],
    [3, 'Bainbridge Island'],
    [5, 'Clinton'],
    [7, 'Seattle'],
    [8, 'Edmonds'],
    [10, 'Friday Harbor'],
    [11, 'Coupeville '],
    [12, 'Kingston'],
    [14, 'Mukilteo'],
    [15, 'Orcas Island'],
    [16, 'Point Defiance'],
    [17, 'Port Townsend'],
  ];
  const EMPTY_FEED =
    'WSF is publishing no sailing-space data right now, so vehicle space cannot be confirmed for any terminal. wsdot_get_ferry_schedule and wsdot_get_ferry_alerts still show the sailings and any disruptions.';

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function call(input: Parameters<typeof runToolContract<typeof getTerminalSpace>>[1]) {
    const pending = runToolContract(getTerminalSpace, input);
    await vi.runAllTimersAsync();
    return pending;
  }

  it.each([
    ['[]', []],
    ['null', null],
  ])(
    'answers an HTTP 200 %s feed, unfiltered or filtered, with the empty-feed notice',
    async (_label, body) => {
      http.route({ match: SPACE, respond: Response.json(body) });
      for (const input of [{}, { departingTerminalId: 7 }, { departingTerminalId: 9999 }]) {
        const result = await call(input);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          terminals: [],
          totalCount: 0,
          hasMore: false,
          nextOffset: null,
          notice: EMPTY_FEED,
        });
        expect(wireText(result)).toContain(`> ${EMPTY_FEED}`);
        expect(wireText(result)).not.toMatch(/retry in 30 seconds|verify valid terminal IDs/i);
      }
    },
  );

  it('answers Fauntleroy (9), which the populated feed omits, by listing the 12 terminals it reports', async () => {
    http.route({
      match: SPACE,
      respond: Response.json(
        COVERED.map(([id, name]) => ({ TerminalID: id, TerminalName: name, DepartingSpaces: [] })),
      ),
    });
    const result = await call({ departingTerminalId: 9 });
    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      'No sailing-space data for terminal ID 9. WSF publishes space only for select terminals; its feed currently reports Anacortes (ID 1), Bainbridge Island (ID 3), Clinton (ID 5), Seattle (ID 7), Edmonds (ID 8), Friday Harbor (ID 10), Coupeville (ID 11), Kingston (ID 12), Mukilteo (ID 14), Orcas Island (ID 15), Point Defiance (ID 16), Port Townsend (ID 17). wsdot_get_ferry_terminals lists every terminal ID to check this one against; for a terminal the feed does not report, space cannot be confirmed, and wsdot_get_ferry_schedule and wsdot_get_ferry_alerts still show its sailings.',
    );
    expect(wireText(result)).toContain(`> ${notice}`);
  });

  it('keeps a non-2xx as api_unavailable with its retry recovery (characterization)', async () => {
    http.route({ match: SPACE, respond: new Response('Service Unavailable', { status: 503 }) });
    const error = wireError(await call({}));
    expect(error.data).toMatchObject({
      reason: 'api_unavailable',
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
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
