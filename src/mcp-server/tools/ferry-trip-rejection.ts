/**
 * @fileoverview The one mapping from a failed WSF trip lookup — a schedule or fares request keyed by
 * a directed terminal pair and a trip date — to the failure its tool reports.
 * `wsdot_get_ferry_schedule` and `wsdot_get_ferry_fares` both call it, so a pair or a date WSF
 * rejects reads the same from either. Also here: the local `invalid_date` failure for a trip date
 * that is not a real calendar date, which the dated ferry tools (routes included) share.
 * @module mcp-server/tools/ferry-trip-rejection
 */

import type { Context, TypedFail } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { FerryApiService, getFerryApiService } from '@/services/ferry/ferry-service.js';

/**
 * The service day a dated ferry tool looks up: the caller's `tripDate` normalized to `YYYY-MM-DD`,
 * or today's Pacific service day when it is absent or blank.
 *
 * @param fail - The calling tool's `ctx.fail`.
 * @returns The date to query.
 * @throws The tool's `invalid_date` failure when `tripDate` is not a real calendar date.
 */
export function resolveTripDate(
  tripDate: string | undefined,
  fail: TypedFail<'invalid_date'>,
): string {
  try {
    return tripDate?.trim()
      ? FerryApiService.toFerryDate(tripDate.trim())
      : FerryApiService.todayFerryDate();
  } catch {
    throw fail(
      'invalid_date',
      `Invalid date: "${tripDate}". Expected YYYY-MM-DD format (e.g. 2026-05-23).`,
    );
  }
}

/** The trip lookup that failed, as its tool was asked for it. */
export interface TripLookup {
  arrivingTerminalId: number;
  /** Epoch ms the tool call must settle by, when it has one. The routes check shares it. */
  deadlineAt?: number;
  departingTerminalId: number;
  /** What the tool looked up, which the mapped failure names. */
  subject: 'fares' | 'schedule';
  tripDate: string;
}

/** How each lookup's failures name what WSF has none of. */
const WORDING = {
  fares: { forPair: 'No ferry fares', forDay: 'fares' },
  schedule: { forPair: 'No ferry schedule', forDay: 'a schedule' },
} as const;

/**
 * The error a failed trip lookup throws.
 *
 * The service has already classified an unregistered access code (a server configuration fault)
 * and a trip date outside WSF's window; both keep their own reason, as does an outage. What remains
 * of a rejection — a 200 + `{"Message"}` body (the service's `ValidationError`) or a real HTTP 4xx —
 * means WSF has nothing for this pair on this date. WSF rejects every pair on an in-window date
 * whose season has no sailings loaded, in the same words it uses for a pair that never has service,
 * so the date's route list tells the two apart: no routes is `invalid_date`, otherwise
 * `invalid_terminal_pair`. That check runs only on a call that is already failing.
 *
 * @param fail - The calling tool's `ctx.fail`; its contract supplies each reason's code and hint.
 * @returns The error to throw: the caught one unchanged, or the mapped failure with it as `cause`.
 *   Rejects with the routes check's own failure when that check fails.
 */
export async function tripLookupFailure(
  err: unknown,
  lookup: TripLookup,
  fail: TypedFail<'invalid_date' | 'invalid_terminal_pair'>,
  ctx: Context,
): Promise<unknown> {
  if (!(err instanceof McpError)) return err;
  const reason = err.data?.reason;
  if (reason === 'invalid_access_code' || reason === 'invalid_date') return err;
  const status = err.data?.status;
  const rejected =
    err.code === JsonRpcErrorCode.ValidationError ||
    (typeof status === 'number' && status >= 400 && status < 500);
  if (!rejected) return err;

  const { arrivingTerminalId, deadlineAt, departingTerminalId, subject, tripDate } = lookup;
  const wording = WORDING[subject];
  if (!(await getFerryApiService().hasRoutes(tripDate, ctx, deadlineAt))) {
    return fail(
      'invalid_date',
      `WSF lists no routes on ${tripDate}, so no terminal pair has ${wording.forDay} that day. The date is inside the window WSF accepts, but no sailings are loaded for it yet.`,
      undefined,
      { cause: err },
    );
  }
  return fail(
    'invalid_terminal_pair',
    `${wording.forPair} for terminal ${departingTerminalId} → ${arrivingTerminalId} on ${tripDate}. These terminals may not have direct service, or a terminal ID may be invalid.`,
    undefined,
    { cause: err },
  );
}
