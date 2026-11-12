/**
 * @fileoverview Wire-level tests for `wsdot_get_ferry_fares`. Only the upstream HTTP boundary is
 * stubbed, with WSF's own captured bodies: the real `FerryApiService` builds the two fares requests,
 * retries and classifies their failures under one deadline, and normalizes the payloads, while
 * `runToolContract` carries each call through schema validation, the handler, the shared rejection
 * mapping, `format()`, enrichment, and the production error envelope. The clock is faked throughout,
 * so retry backoff and the call's deadline run without waiting.
 * @module tests/tools/ferry-fares.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

import { getFerryFares } from '@/mcp-server/tools/definitions/get-ferry-fares.tool.js';
import { initFerryApiService } from '@/services/ferry/ferry-service.js';
import { formattedText, markdownText, wireError } from '../helpers/assertions.js';
import {
  DISABILITY_LINE,
  FARES_DATE_REJECTION,
  FARES_DEPARTING_REJECTION,
  FARES_PAIR_REJECTION,
  FARES_TRIP_DATE,
  type FareCapture,
  fareLineItems,
  TERMINAL_COMBOS,
} from '../helpers/wsf-fares.js';

const API = 'https://www.wsdot.wa.gov/Ferries/API';

/** Noon on the day before the captures' trip date, Pacific — "today" for a call with no tripDate. */
const NOW = new Date('2026-11-12T20:00:00Z');

const lineItemsFor = (date: string, from: number, to: number, roundTrip = false) =>
  new RegExp(`/Fares/rest/farelineitems/${date}/${from}/${to}/${roundTrip}\\?`);
const comboFor = (date: string, from: number, to: number) =>
  new RegExp(`/Fares/rest/terminalcombo/${date}/${from}/${to}\\?`);
const routesFor = (date: string) => new RegExp(`/Schedule/rest/routes/${date}\\?`);

/** A route WSF lists on the date, which makes a pair rejection a pair fault. */
const ANA_SJ = { RouteID: 9, RouteAbbrev: 'ana-sj', Description: 'Anacortes / San Juan Islands' };

/** WSF's verbatim rejection of an unregistered access code (HTTP 400). */
const UNREGISTERED_CODE = {
  Message:
    "Use of WSDOT Traveler API failed.  Please make sure you've registered (at this location https://wsdot.wa.gov/traffic/api/) for a developer Access Code.  This value should then be passed with every service request.",
};

const http = createFetchMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  initFerryApiService({} as never, {} as never);
  http.reset();
  http.install();
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
type FaresInput = Parameters<typeof runToolContract<typeof getFerryFares>>[1];

interface WireFare {
  amountInDollars?: number;
  category?: string;
  description?: string;
  directionIndependent?: boolean;
  fareLineItemId?: number;
}

interface WireFares {
  arrivingTerminalName?: string;
  collectionDescription?: string;
  departingTerminalName?: string;
  fares: WireFare[];
  notice?: string;
  roundTrip: boolean;
  totalCount: number;
  tripDate: string;
}

/** Run the tool, letting every retry backoff and timer elapse on the fake clock. */
async function call(input: FaresInput): Promise<ContractResult> {
  const pending = runToolContract(getFerryFares, input);
  await vi.runAllTimersAsync();
  return pending;
}

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

/** Stub a captured pair's two fares requests for the captures' trip date. */
function stubCapture(from: number, to: number, capture: FareCapture, roundTrip = false) {
  const combo = TERMINAL_COMBOS[`${from}-${to}` as keyof typeof TERMINAL_COMBOS];
  http.route(
    {
      match: lineItemsFor(FARES_TRIP_DATE, from, to, roundTrip),
      respond: Response.json(fareLineItems(capture)),
    },
    { match: comboFor(FARES_TRIP_DATE, from, to), respond: Response.json(combo) },
  );
}

const byId = (fares: WireFare[], id: number) => fares.find((f) => f.fareLineItemId === id);

// ---------------------------------------------------------------------------
// WSF's fares on both surfaces
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_fares — WSF’s fares on both surfaces', () => {
  it('returns 1 → 10’s 22 line items in WSF’s order, leading content[] with the collection statement', async () => {
    stubCapture(1, 10, '1-10-oneway');
    const result = await call({
      departingTerminalId: 1,
      arrivingTerminalId: 10,
      tripDate: FARES_TRIP_DATE,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as unknown as WireFares;
    expect(structured).toMatchObject({
      departingTerminalName: 'Anacortes',
      arrivingTerminalName: 'Friday Harbor',
      collectionDescription: TERMINAL_COMBOS['1-10'].CollectionDescription,
      tripDate: FARES_TRIP_DATE,
      roundTrip: false,
      totalCount: 22,
    });
    expect(structured).not.toHaveProperty('notice');
    expect(structured.fares.map((f) => f.fareLineItemId)).toEqual(
      fareLineItems('1-10-oneway').map((f) => f.FareLineItemID),
    );
    expect(byId(structured.fares, 1)).toEqual({
      fareLineItemId: 1,
      description: 'Adult (age 19 - 64)',
      category: 'Passenger',
      amountInDollars: 18,
      directionIndependent: false,
    });
    expect(byId(structured.fares, 178)?.amountInDollars).toBe(64.15);

    const lines = wireText(result).split('\n');
    expect(lines.slice(0, 2)).toEqual([
      '## Ferry Fares — Anacortes → Friday Harbor',
      `**Fare collection:** ${TERMINAL_COMBOS['1-10'].CollectionDescription}`,
    ]);
    expect(lines).toContain(
      '- Adult (age 19 - 64): $18.00 | fareLineItemId 1 | directionIndependent: false',
    );
    expect(lines).toContain(
      "- Vehicle Under 22' (standard veh) & Driver: $64.15 | fareLineItemId 178 | directionIndependent: false",
    );
    expect(lines).toContain('### Vehicle Length-Based');
    expect(requestedPaths()).toEqual([
      `/Fares/rest/farelineitems/${FARES_TRIP_DATE}/1/10/false`,
      `/Fares/rest/terminalcombo/${FARES_TRIP_DATE}/1/10`,
    ]);
  });

  it('returns 10 → 1’s same 22 lines with 18 at 0, the four multi-ride cards keeping their amounts', async () => {
    stubCapture(10, 1, '10-1-oneway');
    stubCapture(1, 10, '1-10-oneway');
    const back = (
      await call({ departingTerminalId: 10, arrivingTerminalId: 1, tripDate: FARES_TRIP_DATE })
    ).structuredContent as unknown as WireFares;
    const out = (
      await call({ departingTerminalId: 1, arrivingTerminalId: 10, tripDate: FARES_TRIP_DATE })
    ).structuredContent as unknown as WireFares;
    expect(back.fares.map((f) => f.fareLineItemId)).toEqual(out.fares.map((f) => f.fareLineItemId));
    expect(back.fares.filter((f) => f.amountInDollars === 0)).toHaveLength(18);
    expect(
      back.fares
        .filter((f) => f.directionIndependent)
        .map((f) => [f.fareLineItemId, f.amountInDollars]),
    ).toEqual([
      [4, 120.5],
      [170, 193.25],
      [180, 241.8],
      [16, 206.9],
    ]);
    expect(back.collectionDescription).toBe(
      'No fares are collected at Friday Harbor, while passenger and vehicle/driver fares are collected at Anacortes.',
    );
  });

  it('returns 3 → 7 with no passenger fare and the vehicle fare, under WSF’s statement of why', async () => {
    stubCapture(3, 7, '3-7-oneway');
    const result = await call({
      departingTerminalId: 3,
      arrivingTerminalId: 7,
      tripDate: FARES_TRIP_DATE,
    });
    const structured = result.structuredContent as unknown as WireFares;
    expect(byId(structured.fares, 1)?.amountInDollars).toBe(0);
    expect(byId(structured.fares, 178)?.amountInDollars).toBe(20.25);
    expect(structured.collectionDescription).toBe(TERMINAL_COMBOS['3-7'].CollectionDescription);
    expect(wireText(result)).toContain('- Adult (age 19 - 64): $0.00 | fareLineItemId 1');
  });

  it('returns 7 → 3’s round-trip totals when roundTrip is true', async () => {
    stubCapture(7, 3, '7-3-roundtrip', true);
    const result = await call({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: FARES_TRIP_DATE,
      roundTrip: true,
    });
    const structured = result.structuredContent as unknown as WireFares;
    expect(structured.roundTrip).toBe(true);
    expect(byId(structured.fares, 178)?.amountInDollars).toBe(40.5);
    expect(byId(structured.fares, 1)?.amountInDollars).toBe(11.35);
    expect(wireText(result)).toContain("- Vehicle Under 22' (standard veh) & Driver: $40.50");
    expect(requestedPaths()[0]).toBe(`/Fares/rest/farelineitems/${FARES_TRIP_DATE}/7/3/true`);
  });

  it('returns 1 → 10’s one-way figures for its round trip, whose return leg collects nothing', async () => {
    stubCapture(1, 10, '1-10-oneway');
    stubCapture(1, 10, '1-10-roundtrip', true);
    const input = { departingTerminalId: 1, arrivingTerminalId: 10, tripDate: FARES_TRIP_DATE };
    const oneWay = (await call(input)).structuredContent as unknown as WireFares;
    const roundTrip = (await call({ ...input, roundTrip: true }))
      .structuredContent as unknown as WireFares;
    expect(roundTrip.fares).toEqual(oneWay.fares);
    expect(roundTrip.roundTrip).toBe(true);
  });

  it('carries the Disability link’s destination as "text (url)" on both surfaces', async () => {
    stubCapture(1, 10, '1-10-oneway');
    const result = await call({
      departingTerminalId: 1,
      arrivingTerminalId: 10,
      tripDate: FARES_TRIP_DATE,
    });
    const structured = result.structuredContent as unknown as WireFares;
    expect(byId(structured.fares, 2)?.description).toBe(DISABILITY_LINE.text);
    expect(markdownText(wireText(result))).toContain(
      `${DISABILITY_LINE.text}: $9.00 | fareLineItemId 2`,
    );
    expect(JSON.stringify(result)).not.toMatch(/<a\b|href=/);
  });

  it('renders every field of every line in content[] — parity with structuredContent', async () => {
    stubCapture(7, 3, '7-3-oneway');
    const result = await call({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: FARES_TRIP_DATE,
    });
    const structured = result.structuredContent as unknown as WireFares;
    const decoded = markdownText(wireText(result)).split('\n');
    expect(structured.fares).toHaveLength(23);
    for (const fare of structured.fares) {
      const dollars = `$${fare.amountInDollars?.toFixed(2)}`;
      expect(decoded).toContain(
        `${fare.description}: ${dollars} | fareLineItemId ${fare.fareLineItemId} | directionIndependent: ${fare.directionIndependent}`,
      );
    }
    const categories = [...new Set(structured.fares.map((f) => f.category))];
    expect(categories).toEqual([
      'Passenger',
      'Vehicle, Motorcycle, and Stowage Fares',
      'Vehicle Length-Based',
    ]);
    for (const category of categories) expect(decoded).toContain(category);
    for (const value of [
      'Seattle',
      'Bainbridge Island',
      TERMINAL_COMBOS['7-3'].CollectionDescription,
    ]) {
      expect(markdownText(wireText(result))).toContain(value);
    }
  });

  it('answers an empty line-item list with fares: [] and a notice naming the pair and date', async () => {
    http.route(
      { match: lineItemsFor(FARES_TRIP_DATE, 1, 10), respond: Response.json([]) },
      { match: comboFor(FARES_TRIP_DATE, 1, 10), respond: Response.json(TERMINAL_COMBOS['1-10']) },
    );
    const result = await call({
      departingTerminalId: 1,
      arrivingTerminalId: 10,
      tripDate: FARES_TRIP_DATE,
    });
    const structured = result.structuredContent as unknown as WireFares;
    expect(structured.fares).toEqual([]);
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toBe(
      `WSF lists no fare line items for terminal 1 → 10 on ${FARES_TRIP_DATE}. Check the pair against terminalPairs from wsdot_get_ferry_routes for ${FARES_TRIP_DATE}.`,
    );
    const text = wireText(result);
    expect(text).toContain('No fares listed for this pair and date.');
    expect(markdownText(text)).toContain('WSF lists no fare line items for terminal 1 → 10');
  });

  it('defaults a blank tripDate to today’s Pacific service day', async () => {
    http.route(
      {
        match: lineItemsFor('2026-11-12', 1, 10),
        respond: Response.json(fareLineItems('1-10-oneway')),
      },
      { match: comboFor('2026-11-12', 1, 10), respond: Response.json(TERMINAL_COMBOS['1-10']) },
    );
    const result = await call({ departingTerminalId: 1, arrivingTerminalId: 10, tripDate: '  ' });
    expect((result.structuredContent as unknown as WireFares).tripDate).toBe('2026-11-12');
  });
});

// ---------------------------------------------------------------------------
// How each failure of the two requests settles the call
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_fares — a failed line-items request fails the call', () => {
  const TRIP = { departingTerminalId: 7, arrivingTerminalId: 1, tripDate: FARES_TRIP_DATE };

  /** Stub the 7 → 1 line items with `respond` and the combo with WSF's pair rejection. */
  function stubLineItems(respond: Response | (() => Response | Promise<Response>)) {
    http.route(
      { match: lineItemsFor(FARES_TRIP_DATE, 7, 1), respond },
      {
        match: comboFor(FARES_TRIP_DATE, 7, 1),
        respond: Response.json(FARES_PAIR_REJECTION, { status: 400 }),
      },
    );
  }

  it('reports a trip date outside WSF’s fares window as non-retryable invalid_date, worded for fares', async () => {
    stubLineItems(Response.json(FARES_DATE_REJECTION, { status: 400 }));
    const result = await call(TRIP);
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_date',
      retryable: false,
      recovery: { hint: expect.stringContaining('through the end of the posted fares') },
    });
    expect(error.message).toBe(
      `WSF has no fares for the requested trip date. ${FARES_DATE_REJECTION.Message}`,
    );
    expect(error.message).not.toContain('WSF has no schedule');
    expect(wireText(result)).toContain('(reason invalid_date · not retryable)');
    // WSF named the date as the fault, so no routes check runs.
    expect(requestedPaths()).toEqual([
      `/Fares/rest/farelineitems/${FARES_TRIP_DATE}/7/1/false`,
      `/Fares/rest/terminalcombo/${FARES_TRIP_DATE}/7/1`,
    ]);
  });

  it('reports a pair WSF has no fares for on a date with routes as invalid_terminal_pair', async () => {
    stubLineItems(Response.json(FARES_PAIR_REJECTION, { status: 400 }));
    http.route({ match: routesFor(FARES_TRIP_DATE), respond: Response.json([ANA_SJ]) });
    const result = await call(TRIP);
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      `No ferry fares for terminal 7 → 1 on ${FARES_TRIP_DATE}. These terminals may not have direct service, or a terminal ID may be invalid.`,
    );
    expect(error.data).toMatchObject({
      reason: 'invalid_terminal_pair',
      recovery: { hint: expect.stringContaining('terminalPairs') },
    });
    expect(error.data).not.toHaveProperty('reason', 'api_unavailable');
    expect(requestedPaths()).toContain(`/Schedule/rest/routes/${FARES_TRIP_DATE}`);
  });

  it('reports another 4xx (HTTP 404) the same way', async () => {
    stubLineItems(new Response('Not Found', { status: 404 }));
    http.route({ match: routesFor(FARES_TRIP_DATE), respond: Response.json([ANA_SJ]) });
    expect(wireError(await call(TRIP)).data?.reason).toBe('invalid_terminal_pair');
  });

  it('reports a departing terminal with no sailings loaded on an in-window date as invalid_terminal_pair', async () => {
    const winter = '2027-01-15';
    http.route(
      {
        match: lineItemsFor(winter, 7, 3),
        respond: Response.json(FARES_DEPARTING_REJECTION, { status: 400 }),
      },
      {
        match: comboFor(winter, 7, 3),
        respond: Response.json(FARES_DEPARTING_REJECTION, { status: 400 }),
      },
      { match: routesFor(winter), respond: Response.json([ANA_SJ]) },
    );
    const error = wireError(
      await call({ departingTerminalId: 7, arrivingTerminalId: 3, tripDate: winter }),
    );
    expect(error.data?.reason).toBe('invalid_terminal_pair');
    expect(error.message).toContain(`7 → 3 on ${winter}`);
  });

  it('reports a pair rejection on a date with no routes as invalid_date, worded for fares', async () => {
    stubLineItems(Response.json(FARES_PAIR_REJECTION, { status: 400 }));
    http.route({ match: routesFor(FARES_TRIP_DATE), respond: Response.json([]) });
    const error = wireError(await call(TRIP));
    expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
    expect(error.message).toBe(
      `WSF lists no routes on ${FARES_TRIP_DATE}, so no terminal pair has fares that day. The date is inside the window WSF accepts, but no sailings are loaded for it yet.`,
    );
  });

  it('keeps an access-code rejection as invalid_access_code, with no routes check', async () => {
    stubLineItems(Response.json(UNREGISTERED_CODE, { status: 400 }));
    const error = wireError(await call(TRIP));
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_access_code',
      recovery: { hint: expect.stringContaining('WSDOT_ACCESS_CODE') },
    });
    expect(requestedPaths()).not.toContain(`/Schedule/rest/routes/${FARES_TRIP_DATE}`);
  });

  it('reports a 5xx that outlasts its retries as retryable api_unavailable, with no routes check', async () => {
    stubLineItems(new Response('Service Unavailable', { status: 503 }));
    const result = await call(TRIP);
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'api_unavailable',
      status: 503,
      retryAttempts: 4,
      // The retry ladder names what it retried on the wire, so the label is the caller's wording.
      operation: 'WSF Ferry API request',
      recovery: { hint: expect.stringContaining('Retry in 30 seconds') },
    });
    expect(error.data).not.toHaveProperty('retryable', false);
    expect(requestedPaths().filter((p) => p.startsWith('/Fares/rest/farelineitems/'))).toHaveLength(
      4,
    );
    expect(requestedPaths()).not.toContain(`/Schedule/rest/routes/${FARES_TRIP_DATE}`);
  });

  it('reports a request that keeps timing out as a Timeout, with no routes check', async () => {
    stubLineItems(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const error = wireError(await call(TRIP));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain('WSF Ferry API request timed out');
    expect(requestedPaths()).not.toContain(`/Schedule/rest/routes/${FARES_TRIP_DATE}`);
  });

  it('rejects a malformed tripDate locally as invalid_date, before any request', async () => {
    const error = wireError(await call({ ...TRIP, tripDate: '11/13/2026' }));
    expect(error.data).toMatchObject({ reason: 'invalid_date', retryable: false });
    expect(http.calls).toHaveLength(0);
  });
});

describe('wsdot_get_ferry_fares — a failed terminal-combo request, on a call whose line items arrived', () => {
  const TRIP = { departingTerminalId: 1, arrivingTerminalId: 10, tripDate: FARES_TRIP_DATE };

  function stubCombo(respond: Response) {
    http.route(
      {
        match: lineItemsFor(FARES_TRIP_DATE, 1, 10),
        respond: Response.json(fareLineItems('1-10-oneway')),
      },
      { match: comboFor(FARES_TRIP_DATE, 1, 10), respond },
    );
  }

  it.each([
    ['a 5xx that outlasts its retries', new Response('Service Unavailable', { status: 503 }), 503],
    ['a 4xx', Response.json(FARES_PAIR_REJECTION, { status: 400 }), 400],
  ])(
    'returns every line item on %s, and says what is missing and how to read a 0',
    async (_label, respond, status) => {
      stubCombo(respond);
      const result = await call(TRIP);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as unknown as WireFares;
      expect(structured.fares).toHaveLength(22);
      expect(structured.totalCount).toBe(22);
      for (const key of [
        'departingTerminalName',
        'arrivingTerminalName',
        'collectionDescription',
      ]) {
        expect(structured).not.toHaveProperty(key);
      }
      expect(structured.notice).toBe(
        `WSF's statement of which terminal collects these fares, and the terminal names, could not be read (WSF answered HTTP ${status}). The fare line items are complete; a 0 amount means the departing terminal does not collect that fare on this leg — query the reverse direction to see where it is charged.`,
      );
      const text = wireText(result);
      expect(text.split('\n').slice(0, 2)).toEqual([
        '## Ferry Fares',
        '**Fare collection:** not reported',
      ]);
      expect(markdownText(text)).toContain(`could not be read (WSF answered HTTP ${status})`);
    },
  );

  it('fails the call on an access-code rejection — a configuration fault, not an outage', async () => {
    stubCombo(Response.json(UNREGISTERED_CODE, { status: 400 }));
    expect(wireError(await call(TRIP)).data?.reason).toBe('invalid_access_code');
  });
});

// ---------------------------------------------------------------------------
// One deadline across both fares requests and the routes check a rejection chains
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_fares — one deadline across the call', () => {
  const DEADLINE_HINT =
    'Retry in 30 seconds. If the issue persists, check wsdot.wa.gov/ferries for service status.';
  let timeoutSpy: MockInstance<typeof AbortSignal.timeout>;

  beforeEach(() => {
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  it('gives the chained routes check only what is left of the 50 s budget', async () => {
    http.route(
      {
        match: lineItemsFor(FARES_TRIP_DATE, 7, 1),
        respond: () => {
          vi.setSystemTime(Date.now() + 42_000);
          return Response.json(FARES_PAIR_REJECTION, { status: 400 });
        },
      },
      {
        match: comboFor(FARES_TRIP_DATE, 7, 1),
        respond: Response.json(FARES_PAIR_REJECTION, { status: 400 }),
      },
      { match: routesFor(FARES_TRIP_DATE), respond: Response.json([ANA_SJ]) },
    );
    const error = wireError(
      await call({ departingTerminalId: 7, arrivingTerminalId: 1, tripDate: FARES_TRIP_DATE }),
    );
    expect(error.data?.reason).toBe('invalid_terminal_pair');
    // Line items, then the combo and the routes check once 42 s of the budget are gone.
    expect(timeoutSpy.mock.calls).toEqual([[15_000], [8_000], [8_000]]);
  });

  it('settles as a Timeout once the budget is spent, instead of retrying past the client’s timeout', async () => {
    http.route(
      {
        match: lineItemsFor(FARES_TRIP_DATE, 1, 10),
        respond: () => {
          vi.setSystemTime(Date.now() + 55_000);
          return new Response('Service Unavailable', { status: 503 });
        },
      },
      { match: comboFor(FARES_TRIP_DATE, 1, 10), respond: Response.json(TERMINAL_COMBOS['1-10']) },
    );
    const result = await call({
      departingTerminalId: 1,
      arrivingTerminalId: 10,
      tripDate: FARES_TRIP_DATE,
    });
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    // The caller reads what timed out and what to do next — never an internal class or method.
    expect(error.message).toBe(
      'WSF Ferry API request exceeded its 50000ms retry deadline after 1 attempt.',
    );
    expect(JSON.stringify(result)).not.toMatch(/FerryApiService|fetchJson/);
    expect(error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      recovery: { hint: DEADLINE_HINT },
    });
    expect(wireText(result)).toContain(`Recovery: ${DEADLINE_HINT}`);
    expect(requestedPaths().filter((p) => p.startsWith('/Fares/rest/farelineitems/'))).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// format() on sparse and unusual values
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_fares — format() keeps sparse and unusual values honest', () => {
  const render = (result: Parameters<NonNullable<typeof getFerryFares.format>>[0]) =>
    formattedText(getFerryFares.format!(result)).split('\n');

  it('names what WSF left out instead of inventing it', () => {
    expect(render({ fares: [{}] })).toEqual([
      '## Ferry Fares',
      '**Fare collection:** not reported',
      '',
      '### Category not reported',
      '- Description not reported: amount not reported',
    ]);
  });

  it('opens a heading for each run of one category, keeping WSF’s order when a category recurs', () => {
    const lines = render({
      fares: [
        { description: 'A', category: 'Passenger' },
        { description: 'B', category: 'Passenger' },
        { description: 'C', category: 'Vehicle Length-Based' },
        { description: 'D', category: 'Passenger' },
        { description: 'E' },
      ],
    });
    expect(lines.filter((l) => l.startsWith('### ') || l.startsWith('- '))).toEqual([
      '### Passenger',
      '- A: amount not reported',
      '- B: amount not reported',
      '### Vehicle Length-Based',
      '- C: amount not reported',
      '### Passenger',
      '- D: amount not reported',
      '### Category not reported',
      '- E: amount not reported',
    ]);
  });

  it.each([
    [0, '$0.00'],
    [6.3, '$6.30'],
    [64.15, '$64.15'],
    [6.305, '$6.305'],
  ])('renders %j as %s — cents, or WSF’s finer figure unrounded', (amount, shown) => {
    expect(render({ fares: [{ description: 'Fare', amountInDollars: amount }] })).toContain(
      `- Fare: ${shown}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('wsdot_get_ferry_fares — input', () => {
  it.each([0, -3, 7.5])('rejects departingTerminalId %j before the handler runs', (id) => {
    expect(() =>
      getFerryFares.input.parse({ departingTerminalId: id, arrivingTerminalId: 3 }),
    ).toThrow();
  });

  it('rejects an undeclared argument by name', () => {
    expect(() =>
      getFerryFares.input.parse({ departingTerminalId: 7, arrivingTerminalId: 3, oneWay: true }),
    ).toThrow(/oneWay/);
  });
});
