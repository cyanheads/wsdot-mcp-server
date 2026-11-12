/**
 * @fileoverview WSF (Washington State Ferries) API service — terminals, routes,
 * schedules, fares, vessel locations, terminal space, and alerts.
 * @module services/ferry/ferry-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { htmlTextField, nonBlank, nonBlankHtml, textField } from '@/services/text-field.js';
import { decodeWcfDate, pacificParts, wcfDateFieldWithLocal } from '@/services/wcf-date.js';
import { assertUpstreamJson, fetchUpstream, redactUrl } from '@/services/wsdot-http.js';
import type {
  FareLineItem,
  FareTerminalCombo,
  FerryAlert,
  FerryFares,
  FerryRoute,
  FerrySchedule,
  FerryTerminal,
  RawFareLineItem,
  RawFareTerminalCombo,
  RawFerryAlert,
  RawFerryRoute,
  RawFerrySchedule,
  RawFerryTerminal,
  RawSailing,
  RawTerminalPair,
  RawTerminalSailingSpace,
  RawVesselLocation,
  Sailing,
  TerminalPair,
  TerminalSailingSpace,
  VesselLocation,
} from './types.js';

const BASE_URL = 'https://www.wsdot.wa.gov/Ferries/API';
const TIMEOUT_MS = 15_000;
const SERVICE = 'WSF Ferry API';

/**
 * Budget for every WSF request one tool call makes — each attempt, backoff, and chained request —
 * kept under the 60 s request timeout MCP SDK clients default to, so a slow upstream reaches the
 * caller as this server's classified `Timeout` rather than as a transport timeout. A caller passes
 * `Date.now() + CALL_BUDGET_MS` as the `deadlineAt` of each request the call makes.
 */
export const CALL_BUDGET_MS = 50_000;

/** Most `terminalsandmatesbyroute` lookups one routes call keeps in flight. */
const PAIR_LOOKUP_CONCURRENCY = 5;

/**
 * Pacific hour (0–23) before which a remaining-sailings query for today also reads the previous
 * service day's schedule. WSF's service day runs past midnight — the latest such departure in the
 * Fall 2026 and Winter 2027 seasons is 02:10 (Seattle → Bainbridge, weekend and holiday service
 * days), the earliest morning one 04:05 — and WSF drops the previous day from its dated window at
 * 03:00, after which a request for it is rejected. So this bounds the extra request, not
 * correctness: nothing departs between 02:10 and 04:05 for a later hour to reach.
 */
export const PREVIOUS_SERVICE_DAY_CUTOFF_HOUR = 3;

/** The Pacific calendar date (`YYYY-MM-DD`) and hour (0–23) at an instant. */
function pacificClock(at: number): { date: string; hour: number } {
  const part = pacificParts(at);
  return { date: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) };
}

/** The calendar date before a `YYYY-MM-DD` date. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A server-authored phrase naming why a WSF request failed, for the notice that discloses it. */
function failureDetail(err: unknown): string {
  if (!(err instanceof McpError)) return 'the request failed';
  if (err.code === JsonRpcErrorCode.Timeout) return 'the request timed out';
  const status = err.data?.status;
  return typeof status === 'number' && status >= 400
    ? `WSF answered HTTP ${status}`
    : 'the request failed';
}

/**
 * Whether WSF refused the request's inputs — its trip date, or the terminal pair on that date —
 * rather than failing to answer: a date outside its window (`invalid_date`) or an HTTP 200 carrying
 * a `{"Message"}` body (both `ValidationError`s), or an HTTP 400 that is not about the access code.
 * Any other 4xx, a 429 included, is a failure to answer.
 */
function isInputRejection(err: unknown): boolean {
  if (!(err instanceof McpError)) return false;
  if (err.code === JsonRpcErrorCode.ValidationError) return true;
  return err.data?.status === 400 && err.data?.reason === 'api_unavailable';
}

/**
 * One schedule sailing.
 *
 * @param serviceDate - The Pacific service day whose schedule lists it.
 * @param noteAt - Where one of the sailing's `AnnotationIndexes` sits in the response's
 *   annotations, or `undefined` when it resolves to no note (the index is dropped).
 */
function normalizeSailing(
  s: RawSailing,
  serviceDate: string,
  noteAt: (index: number) => number | undefined,
): Sailing {
  return {
    ...wcfDateFieldWithLocal('departureTime', s.DepartingTime),
    ...wcfDateFieldWithLocal('arrivalTime', s.ArrivingTime),
    serviceDate,
    ...textField('vesselName', s.VesselName),
    ...(s.VesselID != null && { vesselId: s.VesselID }),
    ...(s.LoadingRule != null && { loadingRule: s.LoadingRule }),
    ...(typeof s.VesselHandicapAccessible === 'boolean' && {
      vesselHandicapAccessible: s.VesselHandicapAccessible,
    }),
    ...(s.AnnotationIndexes != null && {
      annotationIndexes: s.AnnotationIndexes.flatMap((i) => noteAt(i) ?? []),
    }),
  };
}

/**
 * WSF's rejection of a trip date outside the window it has published — "The TripDate 1/1/2099 is
 * not valid. The valid range begins with today's date (…) and extends to the end of the most
 * recently posted schedule (…)." Distinct from a terminal-pair rejection, which names the TripDate
 * only after "is not valid".
 */
const TRIP_DATE_REJECTED = /\bTripDate\s+\S+\s+is not valid\b/i;

/** The `Message` WSF puts in a JSON error body, or `undefined` when the body carries none. */
function wsfMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && 'Message' in parsed) {
      const { Message } = parsed as { Message: unknown };
      return typeof Message === 'string' ? Message : undefined;
    }
  } catch {
    // Not JSON — an HTML page or plain text, which assertUpstreamJson classifies.
  }
  return undefined;
}

/**
 * Throw `invalid_date` when WSF rejected the request's trip date. WSF's message is kept whole: it
 * states the window it accepts, measured from its own Pacific service day.
 *
 * @param missing - What WSF has none of for the date: `fares` from the Fares API, `schedule` from
 *   every other dated endpoint.
 */
function assertTripDateAccepted(
  message: string | undefined,
  endpoint: string,
  status: number,
  missing: 'fares' | 'schedule',
): void {
  if (message === undefined || !TRIP_DATE_REJECTED.test(message)) return;
  throw validationError(`WSF has no ${missing} for the requested trip date. ${message}`, {
    url: endpoint,
    status,
    reason: 'invalid_date',
    retryable: false,
  });
}

/** One `farelineitems` item. The fare's name is HTML in places, rendered to plain text here. */
function normalizeFareLineItem(raw: RawFareLineItem): FareLineItem {
  return {
    ...(raw.FareLineItemID != null && { fareLineItemId: raw.FareLineItemID }),
    ...htmlTextField('description', raw.FareLineItem),
    ...textField('category', raw.Category),
    ...(raw.Amount != null && { amountInDollars: raw.Amount }),
    ...(typeof raw.DirectionIndependent === 'boolean' && {
      directionIndependent: raw.DirectionIndependent,
    }),
  };
}

/**
 * The pair's terminal combo from its settled request. The line items answer a fares call on their
 * own, so a combo failure on a call whose line items arrived degrades to `unavailable` — the tool
 * discloses it — except the two failures that are never upstream unavailability: the caller's
 * cancellation and an access-code rejection (a server configuration fault). A throw that is not a
 * classified `McpError` is a defect and is rethrown too.
 */
function readFareCombo(
  settled: PromiseSettledResult<RawFareTerminalCombo | null>,
  ctx: Context,
): FareTerminalCombo {
  if (settled.status === 'fulfilled') {
    const raw = settled.value;
    return {
      kind: 'read',
      ...textField('departingTerminalName', raw?.DepartingDescription),
      ...textField('arrivingTerminalName', raw?.ArrivingDescription),
      ...textField('collectionDescription', raw?.CollectionDescription),
    };
  }
  const err: unknown = settled.reason;
  if (
    ctx.signal.aborted ||
    !(err instanceof McpError) ||
    err.data?.reason === 'invalid_access_code'
  ) {
    throw err;
  }
  const detail = failureDetail(err);
  ctx.log.warning('Fare terminal combo unavailable; returning the line items without it', {
    detail,
  });
  return { kind: 'unavailable', detail };
}

/**
 * A route's pairs as `terminalsandmatesbyroute` lists them. A pair missing either terminal ID is left
 * out — it exists to be passed to the schedule tool, which needs both.
 */
function normalizeTerminalPairs(raw: RawTerminalPair[] | null): TerminalPair[] {
  return (raw ?? []).flatMap((p) =>
    p.DepartingTerminalID != null && p.ArrivingTerminalID != null
      ? [
          {
            departingTerminalId: p.DepartingTerminalID,
            ...textField('departingTerminalName', p.DepartingDescription),
            arrivingTerminalId: p.ArrivingTerminalID,
            ...textField('arrivingTerminalName', p.ArrivingDescription),
          },
        ]
      : [],
  );
}

export class FerryApiService {
  /**
   * Terminal pairs keyed by `{tripDate}/{routeId}`. WSF lists the lookup as cacheable until its
   * `cacheflushdate` stamp changes, so the entries hold only while {@link pairCacheStamp} matches it;
   * a new stamp empties the map. Public upstream data, so it is shared across tenants.
   */
  private readonly pairCache = new Map<string, TerminalPair[]>();
  private pairCacheStamp: string | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {}

  private accessCode(): string {
    return getServerConfig().accessCode;
  }

  private buildUrl(path: string): string {
    return `${BASE_URL}/${path}?apiaccesscode=${this.accessCode()}`;
  }

  /**
   * GET a WSF path and parse its JSON, retrying transient failures.
   *
   * @param deadlineAt - Epoch ms by which the request must settle, shared by every request one tool
   *   call makes ({@link CALL_BUDGET_MS}). It bounds the retry ladder and each attempt's own
   *   timeout, so an attempt already in flight cannot carry the call past it. Omitted, each attempt
   *   gets {@link TIMEOUT_MS} and the ladder is unbounded.
   */
  private fetchJson<T>(path: string, ctx: Context, deadlineAt?: number): Promise<T> {
    const url = this.buildUrl(path);
    const endpoint = redactUrl(url);
    const missingForDate = path.startsWith('Fares/') ? 'fares' : 'schedule';
    return withRetry(
      async () => {
        const timeoutMs =
          deadlineAt === undefined
            ? TIMEOUT_MS
            : Math.min(TIMEOUT_MS, Math.max(0, deadlineAt - Date.now()));
        const response = await fetchUpstream(url, endpoint, SERVICE, timeoutMs, ctx);
        // The body is read before any status check: WSF explains an unregistered access code in
        // the body of a 400, which a status-first throw discards unread.
        const body = await response.text();
        // A trip date outside WSF's window is an input error whatever the status it arrives with,
        // so it is classified before a non-2xx falls through to api_unavailable.
        if (!response.ok) {
          assertTripDateAccepted(wsfMessage(body), endpoint, response.status, missingForDate);
        }
        assertUpstreamJson({ body, endpoint, response, service: SERVICE });

        const parsed = JSON.parse(body) as T;
        // Ferry API returns HTTP 200 with {"Message":"..."} for validation errors
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'Message' in (parsed as Record<string, unknown>)
        ) {
          const msg = (parsed as Record<string, unknown>).Message as string;
          assertTripDateAccepted(msg, endpoint, response.status, missingForDate);
          throw validationError(`WSF Ferry API error: ${msg}`, { url: endpoint });
        }
        return parsed;
      },
      {
        // Caller-visible: it opens the deadline-exceeded message and rides an exhausted error's
        // data.operation, so it names the request, never this method.
        operation: `${SERVICE} request`,
        baseDelayMs: 1000,
        signal: ctx.signal,
        ...(deadlineAt !== undefined && { deadlineMs: Math.max(0, deadlineAt - Date.now()) }),
      },
    );
  }

  /**
   * Validate and normalize a date for use in ferry API paths. Accepts a `YYYY-MM-DD` date or a full
   * ISO 8601 datetime (the date part is taken); rejects slash-format ("06/08/2026") and impossible
   * dates locally so a malformed value never reaches the upstream as a path segment (which it answers
   * with an HTTP 400).
   */
  static toFerryDate(isoDate: string): string {
    const datePart = isoDate.trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      throw validationError(
        `Invalid date: "${isoDate}". Expected ISO 8601 date (YYYY-MM-DD), e.g. 2026-05-23.`,
      );
    }
    const d = new Date(`${datePart}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== datePart) {
      throw validationError(
        `Invalid date: "${isoDate}". Not a real calendar date (use YYYY-MM-DD).`,
      );
    }
    return datePart;
  }

  /**
   * Return the current Washington service date (`America/Los_Angeles`) in YYYY-MM-DD format.
   * WSF runs on Pacific time, so the default trip date must track the local service day — the UTC
   * date rolls over to tomorrow during the Pacific evening and would query the wrong day's sailings.
   */
  static todayFerryDate(): string {
    return pacificClock(Date.now()).date;
  }

  async getTerminals(ctx: Context): Promise<FerryTerminal[]> {
    ctx.log.info('Fetching ferry terminals');
    // terminallocations carries the same IDs, names, and abbreviations as terminalbasics, in the
    // same order, plus the coordinates terminalbasics never sends.
    const raw = await this.fetchJson<RawFerryTerminal[]>('Terminals/rest/terminallocations', ctx);
    return (raw ?? []).map((t) => ({
      ...(t.TerminalID != null && { terminalId: t.TerminalID }),
      ...textField('terminalName', t.TerminalName),
      ...textField('terminalAbbrev', t.TerminalAbbrev),
      ...(t.Latitude != null && { latitude: t.Latitude }),
      ...(t.Longitude != null && { longitude: t.Longitude }),
    }));
  }

  private async fetchRoutes(
    tripDate: string,
    ctx: Context,
    deadlineAt?: number,
  ): Promise<RawFerryRoute[]> {
    return (
      (await this.fetchJson<RawFerryRoute[] | null>(
        `Schedule/rest/routes/${tripDate}`,
        ctx,
        deadlineAt,
      )) ?? []
    );
  }

  /**
   * Whether WSF lists any route for the trip date. A date inside WSF's window whose season has no
   * sailings loaded yet lists none — and WSF then rejects every terminal pair on it exactly as it
   * rejects a pair that never has service, so this is what tells the two apart.
   *
   * @param deadlineAt - The calling tool call's deadline, when it has one (see `fetchJson`).
   */
  async hasRoutes(tripDate: string, ctx: Context, deadlineAt?: number): Promise<boolean> {
    ctx.log.info('Checking for ferry routes', { tripDate });
    return (await this.fetchRoutes(tripDate, ctx, deadlineAt)).length > 0;
  }

  /**
   * The routes WSF lists on the trip date, each with the terminal pairs it serves.
   *
   * @param deadlineAt - Epoch ms the whole tool call must settle by ({@link CALL_BUDGET_MS}),
   *   shared by the routes request, the flush-stamp check, and every pair lookup.
   */
  async getRoutes(tripDate: string, ctx: Context, deadlineAt?: number): Promise<FerryRoute[]> {
    ctx.log.info('Fetching ferry routes', { tripDate });
    const raw = await this.fetchRoutes(tripDate, ctx, deadlineAt);
    const routeIds = [...new Set(raw.flatMap((r) => (r.RouteID != null ? [r.RouteID] : [])))];
    const pairs = await this.terminalPairsByRoute(tripDate, routeIds, ctx, deadlineAt);
    return raw.map((r) => ({
      ...(r.RouteID != null && { routeId: r.RouteID }),
      ...textField('routeAbbrev', r.RouteAbbrev),
      ...textField('description', r.Description),
      ...(r.RouteID != null && { terminalPairs: pairs.get(r.RouteID) ?? [] }),
    }));
  }

  /**
   * The pairs each route serves on the trip date, from the cache when WSF's flush stamp still
   * matches and otherwise one `terminalsandmatesbyroute` request per route. Any failed request fails
   * the call — a route list with some routes' pairs missing would read as those routes serving none.
   */
  private async terminalPairsByRoute(
    tripDate: string,
    routeIds: number[],
    ctx: Context,
    deadlineAt?: number,
  ): Promise<Map<number, TerminalPair[]>> {
    const pairs = new Map<number, TerminalPair[]>();
    if (routeIds.length === 0) return pairs;

    const stamp = JSON.stringify(
      await this.fetchJson<unknown>('Schedule/rest/cacheflushdate', ctx, deadlineAt),
    );
    if (stamp !== this.pairCacheStamp) {
      this.pairCache.clear();
      this.pairCacheStamp = stamp;
    }

    const missing: number[] = [];
    for (const routeId of routeIds) {
      const cached = this.pairCache.get(`${tripDate}/${routeId}`);
      if (cached) pairs.set(routeId, cached);
      else missing.push(routeId);
    }

    for (let i = 0; i < missing.length; i += PAIR_LOOKUP_CONCURRENCY) {
      const batch = missing.slice(i, i + PAIR_LOOKUP_CONCURRENCY);
      const results = await Promise.all(
        batch.map((routeId) =>
          this.fetchJson<RawTerminalPair[] | null>(
            `Schedule/rest/terminalsandmatesbyroute/${tripDate}/${routeId}`,
            ctx,
            deadlineAt,
          ),
        ),
      );
      batch.forEach((routeId, j) => {
        const routePairs = normalizeTerminalPairs(results[j] ?? null);
        // A concurrent call may have seen a newer stamp while this batch was in flight; pairs
        // fetched under the old one are served to this call but never cached under the new one.
        if (this.pairCacheStamp === stamp) this.pairCache.set(`${tripDate}/${routeId}`, routePairs);
        pairs.set(routeId, routePairs);
      });
    }

    ctx.log.info('Ferry terminal pairs resolved', {
      tripDate,
      routes: routeIds.length,
      lookedUp: missing.length,
      fromCache: routeIds.length - missing.length,
    });
    return pairs;
  }

  /**
   * The pair's sailings on a trip date.
   *
   * WSF's `scheduletoday` follows the Pacific calendar date from midnight, while the previous
   * service day's last boats run past it. So a remaining-sailings query for today made before
   * {@link PREVIOUS_SERVICE_DAY_CUTOFF_HOUR} also reads that day's dated schedule, alongside
   * `scheduletoday` and under the same deadline, and leads with its sailings that depart after now.
   * That read is best-effort: WSF refusing its date or pair means there is nothing to carry over;
   * any other failure returns today's sailings with `previousServiceDayUnread` set. Only a
   * `scheduletoday` failure, or the caller's cancellation, fails the call.
   *
   * @param deadlineAt - Epoch ms the whole tool call must settle by ({@link CALL_BUDGET_MS}).
   */
  async getSchedule(
    departingTerminalId: number,
    arrivingTerminalId: number,
    tripDate: string,
    remainingOnly: boolean,
    ctx: Context,
    deadlineAt?: number,
  ): Promise<FerrySchedule> {
    const now = Date.now();
    const clock = pacificClock(now);
    // remainingOnly applies only to today's sailings — the dated endpoint has no such filter — so
    // the value reported back is the one that actually shaped the result.
    const isToday = tripDate === clock.date;
    const effectiveRemainingOnly = isToday && remainingOnly;
    const previousServiceDate =
      effectiveRemainingOnly && clock.hour < PREVIOUS_SERVICE_DAY_CUTOFF_HOUR
        ? dayBefore(tripDate)
        : undefined;
    const pair = `${departingTerminalId}/${arrivingTerminalId}`;
    const path = isToday
      ? `Schedule/rest/scheduletoday/${pair}/${effectiveRemainingOnly}`
      : `Schedule/rest/schedule/${tripDate}/${pair}`;

    ctx.log.info('Fetching ferry schedule', {
      departingTerminalId,
      arrivingTerminalId,
      tripDate,
      remainingOnly: effectiveRemainingOnly,
      ...(previousServiceDate !== undefined && { previousServiceDate }),
    });
    const [read, previousRead] = await Promise.allSettled([
      this.fetchJson<RawFerrySchedule>(path, ctx, deadlineAt),
      previousServiceDate === undefined
        ? undefined
        : this.fetchJson<RawFerrySchedule>(
            `Schedule/rest/schedule/${previousServiceDate}/${pair}`,
            ctx,
            deadlineAt,
          ),
    ]);
    if (read.status === 'rejected') throw read.reason;

    // Schedule response nests sailings in TerminalCombos[0].Times
    const combo = read.value.TerminalCombos?.[0];

    // Annotations are HTML and some carry nothing once rendered. Dropping a blank one shifts the
    // positions after it, so each sailing's indexes are remapped onto the entries kept — and an
    // index that pointed at nothing is dropped — so every index resolves.
    const annotations: string[] = [];
    const keptAt = new Map<number, number>();
    for (const [i, rawNote] of (combo?.Annotations ?? []).entries()) {
      const note = nonBlankHtml(rawNote);
      if (note == null) continue;
      keptAt.set(i, annotations.length);
      annotations.push(note);
    }
    const sailings = (combo?.Times ?? []).map((s) =>
      normalizeSailing(s, tripDate, (i) => keptAt.get(i)),
    );

    let carryover: Sailing[] = [];
    let previousServiceDayUnread: FerrySchedule['previousServiceDayUnread'];
    if (previousServiceDate !== undefined) {
      if (previousRead.status === 'fulfilled') {
        // WSF's notes differ by service day, so a carried-over sailing's indexes point into the
        // previous day's list. Each note one cites joins the response's list where its text is
        // not already there, and the index is remapped onto it.
        const previousNotes = previousRead.value?.TerminalCombos?.[0]?.Annotations ?? [];
        const noteAt = (i: number): number | undefined => {
          const note = nonBlankHtml(previousNotes[i]);
          if (note == null) return;
          const at = annotations.indexOf(note);
          return at === -1 ? annotations.push(note) - 1 : at;
        };
        carryover = (previousRead.value?.TerminalCombos?.[0]?.Times ?? [])
          .filter((s) => {
            const departure = decodeWcfDate(s.DepartingTime);
            return departure !== undefined && Date.parse(departure) > now;
          })
          .map((s) => normalizeSailing(s, previousServiceDate, noteAt));
      } else if (ctx.signal.aborted) {
        throw previousRead.reason;
      } else if (!isInputRejection(previousRead.reason)) {
        previousServiceDayUnread = {
          serviceDate: previousServiceDate,
          detail: failureDetail(previousRead.reason),
        };
        ctx.log.warning('Previous service day schedule unavailable; returning today without it', {
          previousServiceDate,
          detail: previousServiceDayUnread.detail,
        });
      }
    }

    return {
      ...textField('departingTerminalName', combo?.DepartingTerminalName),
      ...textField('arrivingTerminalName', combo?.ArrivingTerminalName),
      tripDate,
      remainingOnly: effectiveRemainingOnly,
      ...((combo?.Annotations != null || annotations.length > 0) && { annotations }),
      ...htmlTextField('sailingNotes', combo?.SailingNotes),
      sailings: [...carryover, ...sailings],
      ...(previousServiceDayUnread && { previousServiceDayUnread }),
    };
  }

  async getVesselLocations(ctx: Context): Promise<VesselLocation[]> {
    ctx.log.info('Fetching vessel locations');
    const raw = await this.fetchJson<RawVesselLocation[]>('Vessels/rest/vessellocations', ctx);
    return (raw ?? []).map((v) => ({
      ...(v.VesselID != null && { vesselId: v.VesselID }),
      ...textField('vesselName', v.VesselName),
      ...(typeof v.InService === 'boolean' && { inService: v.InService }),
      ...(typeof v.AtDock === 'boolean' && { atDock: v.AtDock }),
      ...(v.DepartingTerminalID != null && { departingTerminalId: v.DepartingTerminalID }),
      ...textField('departingTerminalName', v.DepartingTerminalName),
      ...(v.ArrivingTerminalID != null && { arrivingTerminalId: v.ArrivingTerminalID }),
      ...textField('arrivingTerminalName', v.ArrivingTerminalName),
      ...(v.Latitude != null && { latitude: v.Latitude }),
      ...(v.Longitude != null && { longitude: v.Longitude }),
      ...(v.Speed != null && { speed: v.Speed }),
      ...(v.Heading != null && { heading: v.Heading }),
      ...wcfDateFieldWithLocal('leftDock', v.LeftDock),
      ...wcfDateFieldWithLocal('eta', v.Eta),
      ...wcfDateFieldWithLocal('scheduledDeparture', v.ScheduledDeparture),
      opRouteAbbrev: (v.OpRouteAbbrev ?? []).flatMap((abbrev) => nonBlank(abbrev) ?? []),
      ...wcfDateFieldWithLocal('timestamp', v.TimeStamp),
    }));
  }

  async getTerminalSailingSpace(ctx: Context): Promise<TerminalSailingSpace[]> {
    ctx.log.info('Fetching terminal sailing space');
    const raw = await this.fetchJson<RawTerminalSailingSpace[]>(
      'Terminals/rest/terminalsailingspace',
      ctx,
    );
    return (raw ?? []).map((t) => ({
      ...(t.TerminalID != null && { terminalId: t.TerminalID }),
      ...textField('terminalName', t.TerminalName),
      departingSpaces: (t.DepartingSpaces ?? []).flatMap((s) => {
        // Space counts are nested per arriving terminal; expand into one entry per arrival terminal
        const arrivalTerminals = s.SpaceForArrivalTerminals ?? [];
        if (arrivalTerminals.length === 0) {
          // Departure with no arrival terminal breakdowns — emit a row with just the vessel/departure info
          return [
            {
              ...wcfDateFieldWithLocal('departure', s.Departure),
              ...(typeof s.IsCancelled === 'boolean' && { isCancelled: s.IsCancelled }),
              ...textField('vesselName', s.VesselName),
              ...(s.MaxSpaceCount != null && { maxSpaceCount: s.MaxSpaceCount }),
            },
          ];
        }
        return arrivalTerminals.map((a) => ({
          ...wcfDateFieldWithLocal('departure', s.Departure),
          ...(typeof s.IsCancelled === 'boolean' && { isCancelled: s.IsCancelled }),
          ...textField('vesselName', s.VesselName),
          // TerminalName is an itinerary string and its sibling TerminalID is the *departing*
          // terminal on multi-stop routes; ArrivalTerminalIDs is the only reliable destination.
          ...textField('itineraryLabel', a.TerminalName),
          ...(a.ArrivalTerminalIDs != null &&
            a.ArrivalTerminalIDs.length > 0 && { arrivingTerminalIds: a.ArrivalTerminalIDs }),
          ...(typeof a.DisplayDriveUpSpace === 'boolean' && {
            displayDriveUpSpace: a.DisplayDriveUpSpace,
          }),
          ...(typeof a.DisplayReservableSpace === 'boolean' && {
            displayReservableSpace: a.DisplayReservableSpace,
          }),
          // Oversubscribed sailings report a negative remaining count; floor it so the advertised
          // value never reads as usable space.
          ...(a.DriveUpSpaceCount != null && {
            driveUpSpaceCount: Math.max(0, a.DriveUpSpaceCount),
          }),
          ...(a.ReservableSpaceCount != null && {
            reservableSpaceCount: Math.max(0, a.ReservableSpaceCount),
          }),
          ...(s.MaxSpaceCount != null && { maxSpaceCount: s.MaxSpaceCount }),
          ...textField('driveUpSpaceHexColor', a.DriveUpSpaceHexColor),
        }));
      }),
    }));
  }

  async getAlerts(ctx: Context): Promise<FerryAlert[]> {
    ctx.log.info('Fetching ferry alerts');
    const raw = await this.fetchJson<RawFerryAlert[]>('Schedule/rest/alerts', ctx);
    return (raw ?? []).map((a) => {
      const title = nonBlank(a.AlertFullTitle);
      // Prefer the plain-text marquee summary; fall back to the title when it is absent or blank.
      const description = nonBlank(a.RouteAlertText) ?? title;
      return {
        ...(a.BulletinID != null && { alertId: a.BulletinID }),
        ...(title != null && { alertTitle: title }),
        ...(description != null && { alertDescription: description }),
        // The bulletin body is authored in a rich-text editor and arrives as HTML — nested spans
        // carrying Word-paste attributes, lists, anchors. It is rendered to plain text here, before
        // either response path reads it, so structuredContent and format() carry the same string.
        ...htmlTextField('bulletinText', a.BulletinText),
        ...textField('alertType', a.AlertType),
        // A fleet-wide alert carries no route IDs, so the flag is what separates "every route"
        // from "no route" — it is mapped whenever upstream states it either way.
        ...(typeof a.AllRoutesFlag === 'boolean' && { affectsAllRoutes: a.AllRoutesFlag }),
        impactedRouteIds: a.AffectedRouteIDs ?? [],
        ...wcfDateFieldWithLocal('publishDate', a.PublishDate),
      };
    });
  }

  // --- Fares ---

  /**
   * WSF's fares for one directed trip: the line items, and the pair's terminal combo (its names and
   * WSF's statement of which terminal collects which fares), requested together under one deadline.
   * The line items decide the call — their failure fails it, whatever the combo did; a combo failure
   * on a call whose line items arrived degrades as {@link readFareCombo} describes.
   *
   * @param roundTrip - WSF's round-trip total for a trip starting at the departing terminal, rather
   *   than the one-way fare.
   * @param deadlineAt - Epoch ms the whole tool call must settle by ({@link CALL_BUDGET_MS}).
   */
  async getFares(
    departingTerminalId: number,
    arrivingTerminalId: number,
    tripDate: string,
    roundTrip: boolean,
    ctx: Context,
    deadlineAt: number,
  ): Promise<FerryFares> {
    ctx.log.info('Fetching ferry fares', {
      departingTerminalId,
      arrivingTerminalId,
      tripDate,
      roundTrip,
    });
    const trip = `${tripDate}/${departingTerminalId}/${arrivingTerminalId}`;
    const [items, combo] = await Promise.allSettled([
      this.fetchJson<RawFareLineItem[] | null>(
        `Fares/rest/farelineitems/${trip}/${roundTrip}`,
        ctx,
        deadlineAt,
      ),
      this.fetchJson<RawFareTerminalCombo | null>(
        `Fares/rest/terminalcombo/${trip}`,
        ctx,
        deadlineAt,
      ),
    ]);
    if (items.status === 'rejected') throw items.reason;
    return {
      fares: (items.value ?? []).map(normalizeFareLineItem),
      combo: readFareCombo(combo, ctx),
    };
  }
}

// --- Init/accessor pattern ---

let _service: FerryApiService | undefined;

export function initFerryApiService(config: AppConfig, storage: StorageService): void {
  _service = new FerryApiService(config, storage);
}

export function getFerryApiService(): FerryApiService {
  if (!_service) {
    throw new Error('FerryApiService not initialized — call initFerryApiService() in setup()');
  }
  return _service;
}
