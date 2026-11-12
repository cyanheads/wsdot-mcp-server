/**
 * @fileoverview The rejection mapping `wsdot_get_ferry_schedule` and `wsdot_get_ferry_fares` share,
 * tabled at its own seam: which failures pass through untouched, which ask for the date's routes, and
 * how each lookup words the failure it maps to. The tool suites prove only that each handler calls it.
 * @module tests/tools/ferry-trip-rejection.test
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasRoutes =
  vi.fn<(tripDate: string, ctx: unknown, deadlineAt?: number) => Promise<boolean>>();

vi.mock('@/services/ferry/ferry-service.js', () => ({
  getFerryApiService: () => ({ hasRoutes }),
}));

import { type TripLookup, tripLookupFailure } from '@/mcp-server/tools/ferry-trip-rejection.js';

/** The contract entries the mapping produces, as both tools declare them. */
const ERRORS = [
  {
    reason: 'invalid_terminal_pair',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No service for the pair.',
    recovery: 'Pick a pair from terminalPairs on wsdot_get_ferry_routes.',
  },
  {
    reason: 'invalid_date',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No sailings on the date.',
    retryable: false,
    recovery: 'Use a date on which wsdot_get_ferry_routes lists routes.',
  },
] as const;

const lookup = (subject: TripLookup['subject'], deadlineAt?: number): TripLookup => ({
  subject,
  departingTerminalId: 7,
  arrivingTerminalId: 1,
  tripDate: '2026-11-13',
  ...(deadlineAt !== undefined && { deadlineAt }),
});

/** Run the mapping with a context whose `fail` carries {@link ERRORS}. */
function map(err: unknown, trip = lookup('fares')) {
  const ctx = createMockContext({ errors: ERRORS });
  return tripLookupFailure(err, trip, ctx.fail, ctx);
}

/** An upstream non-2xx as the service throws it. */
const upstream = (status: number) =>
  new McpError(JsonRpcErrorCode.ServiceUnavailable, `WSF Ferry API returned HTTP ${status}.`, {
    reason: 'api_unavailable',
    status,
    ...(status < 500 && { retryable: false }),
  });

beforeEach(() => {
  hasRoutes.mockReset();
  hasRoutes.mockResolvedValue(true);
});

describe('failures that pass through untouched, with no routes check', () => {
  it.each([
    ['a throw that is not an McpError', new TypeError('defect')],
    [
      'an access-code rejection',
      new McpError(JsonRpcErrorCode.ConfigurationError, 'WSDOT_ACCESS_CODE is not registered.', {
        reason: 'invalid_access_code',
        status: 400,
      }),
    ],
    [
      'WSF’s own trip-date rejection, whatever its status',
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'WSF has no fares for the requested trip date.',
        {
          reason: 'invalid_date',
          status: 400,
          retryable: false,
        },
      ),
    ],
    ['a 5xx (HTTP 500, the first status past the 4xx band)', upstream(500)],
    ['a 5xx (HTTP 503)', upstream(503)],
    [
      'a timeout, which carries no status',
      timeout('WSF Ferry API request timed out after 15000ms.'),
    ],
  ])('%s', async (_label, err) => {
    expect(await map(err)).toBe(err);
    expect(hasRoutes).not.toHaveBeenCalled();
  });
});

describe('rejections that ask for the date’s routes', () => {
  it.each([
    ['HTTP 400, the first 4xx', upstream(400)],
    ['HTTP 404', upstream(404)],
    ['HTTP 499, the last 4xx', upstream(499)],
    [
      'an HTTP 200 carrying {"Message"}',
      new McpError(JsonRpcErrorCode.ValidationError, 'WSF Ferry API error: Invalid terminal pair.'),
    ],
    [
      'an HTTP 200 carrying {"Message"}, classified by its code rather than its wording',
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid terminal pair.'),
    ],
  ])(
    'maps %s to invalid_terminal_pair on a date with routes, keeping it as cause',
    async (_l, err) => {
      const mapped = (await map(err)) as McpError;
      expect(mapped).toBeInstanceOf(McpError);
      expect(mapped.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mapped.data).toEqual({ reason: 'invalid_terminal_pair' });
      expect(mapped.cause).toBe(err);
      expect(hasRoutes).toHaveBeenCalledTimes(1);
    },
  );

  it('maps a rejection on a date with no routes to non-retryable invalid_date', async () => {
    hasRoutes.mockResolvedValue(false);
    const err = upstream(400);
    const mapped = (await map(err)) as McpError;
    expect(mapped.data).toEqual({ retryable: false, reason: 'invalid_date' });
    expect(mapped.cause).toBe(err);
  });

  it('rejects with the routes check’s own failure when that check fails', async () => {
    const outage = upstream(503);
    hasRoutes.mockRejectedValue(outage);
    await expect(map(upstream(400))).rejects.toBe(outage);
  });

  it('checks the lookup’s own trip date under the call’s deadline', async () => {
    await map(upstream(400), lookup('fares', 1_790_000_050_000));
    expect(hasRoutes).toHaveBeenCalledWith('2026-11-13', expect.anything(), 1_790_000_050_000);
  });

  it('forwards no deadline when the call has none', async () => {
    await map(upstream(400), lookup('schedule'));
    expect(hasRoutes).toHaveBeenCalledWith('2026-11-13', expect.anything(), undefined);
  });
});

describe('each lookup words the failure for what it looked up', () => {
  it.each([
    [
      'schedule',
      'No ferry schedule for terminal 7 → 1 on 2026-11-13. These terminals may not have direct service, or a terminal ID may be invalid.',
    ],
    [
      'fares',
      'No ferry fares for terminal 7 → 1 on 2026-11-13. These terminals may not have direct service, or a terminal ID may be invalid.',
    ],
  ] as const)('%s — a pair WSF does not serve that day', async (subject, message) => {
    expect(((await map(upstream(400), lookup(subject))) as McpError).message).toBe(message);
  });

  it.each([
    [
      'schedule',
      'WSF lists no routes on 2026-11-13, so no terminal pair has a schedule that day. The date is inside the window WSF accepts, but no sailings are loaded for it yet.',
    ],
    [
      'fares',
      'WSF lists no routes on 2026-11-13, so no terminal pair has fares that day. The date is inside the window WSF accepts, but no sailings are loaded for it yet.',
    ],
  ] as const)('%s — a date with no sailings loaded', async (subject, message) => {
    hasRoutes.mockResolvedValue(false);
    expect(((await map(upstream(400), lookup(subject))) as McpError).message).toBe(message);
  });
});
