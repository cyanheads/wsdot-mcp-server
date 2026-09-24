/**
 * @fileoverview WSF (Washington State Ferries) API service — terminals, routes,
 * schedules, vessel locations, terminal space, and alerts.
 * @module services/ferry/ferry-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { htmlTextField, nonBlank, nonBlankHtml, textField } from '@/services/text-field.js';
import { wcfDateField } from '@/services/wcf-date.js';
import { assertUpstreamJson, fetchUpstream, redactUrl } from '@/services/wsdot-http.js';
import type {
  FerryAlert,
  FerryRoute,
  FerrySchedule,
  FerryTerminal,
  RawFerryAlert,
  RawFerryRoute,
  RawFerrySchedule,
  RawFerryTerminal,
  RawTerminalPair,
  RawTerminalSailingSpace,
  RawVesselLocation,
  TerminalPair,
  TerminalSailingSpace,
  VesselLocation,
} from './types.js';

const BASE_URL = 'https://www.wsdot.wa.gov/Ferries/API';
const TIMEOUT_MS = 15_000;
const SERVICE = 'WSF Ferry API';

/** Most `terminalsandmatesbyroute` lookups one routes call keeps in flight. */
const PAIR_LOOKUP_CONCURRENCY = 5;

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
 */
function assertTripDateAccepted(
  message: string | undefined,
  endpoint: string,
  status: number,
  ctx: Context,
): void {
  if (message === undefined || !TRIP_DATE_REJECTED.test(message)) return;
  throw validationError(`WSF has no schedule for the requested trip date. ${message}`, {
    url: endpoint,
    status,
    reason: 'invalid_date',
    retryable: false,
    ...ctx.recoveryFor('invalid_date'),
  });
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

  private fetchJson<T>(path: string, ctx: Context): Promise<T> {
    const url = this.buildUrl(path);
    const endpoint = redactUrl(url);
    return withRetry(
      async () => {
        const response = await fetchUpstream(url, endpoint, SERVICE, TIMEOUT_MS, ctx);
        // The body is read before any status check: WSF explains an unregistered access code in
        // the body of a 400, which a status-first throw discards unread.
        const body = await response.text();
        // A trip date outside WSF's window is an input error whatever the status it arrives with,
        // so it is classified before a non-2xx falls through to api_unavailable.
        if (!response.ok) assertTripDateAccepted(wsfMessage(body), endpoint, response.status, ctx);
        assertUpstreamJson({ body, endpoint, response, service: SERVICE }, ctx);

        const parsed = JSON.parse(body) as T;
        // Ferry API returns HTTP 200 with {"Message":"..."} for validation errors
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'Message' in (parsed as Record<string, unknown>)
        ) {
          const msg = (parsed as Record<string, unknown>).Message as string;
          assertTripDateAccepted(msg, endpoint, response.status, ctx);
          throw validationError(`WSF Ferry API error: ${msg}`, { url: endpoint });
        }
        return parsed;
      },
      {
        operation: 'FerryApiService.fetchJson',
        baseDelayMs: 1000,
        signal: ctx.signal,
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
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
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

  private async fetchRoutes(tripDate: string, ctx: Context): Promise<RawFerryRoute[]> {
    return (
      (await this.fetchJson<RawFerryRoute[] | null>(`Schedule/rest/routes/${tripDate}`, ctx)) ?? []
    );
  }

  /**
   * Whether WSF lists any route for the trip date. A date inside WSF's window whose season has no
   * sailings loaded yet lists none — and WSF then rejects every terminal pair on it exactly as it
   * rejects a pair that never has service, so this is what tells the two apart.
   */
  async hasRoutes(tripDate: string, ctx: Context): Promise<boolean> {
    ctx.log.info('Checking for ferry routes', { tripDate });
    return (await this.fetchRoutes(tripDate, ctx)).length > 0;
  }

  async getRoutes(tripDate: string, ctx: Context): Promise<FerryRoute[]> {
    ctx.log.info('Fetching ferry routes', { tripDate });
    const raw = await this.fetchRoutes(tripDate, ctx);
    const routeIds = [...new Set(raw.flatMap((r) => (r.RouteID != null ? [r.RouteID] : [])))];
    const pairs = await this.terminalPairsByRoute(tripDate, routeIds, ctx);
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
  ): Promise<Map<number, TerminalPair[]>> {
    const pairs = new Map<number, TerminalPair[]>();
    if (routeIds.length === 0) return pairs;

    const stamp = JSON.stringify(
      await this.fetchJson<unknown>('Schedule/rest/cacheflushdate', ctx),
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

  async getSchedule(
    departingTerminalId: number,
    arrivingTerminalId: number,
    tripDate: string,
    remainingOnly: boolean,
    ctx: Context,
  ): Promise<FerrySchedule> {
    // remainingOnly applies only to today's sailings — the dated endpoint has no such filter — so
    // the value reported back is the one that actually shaped the result.
    const isToday = tripDate === FerryApiService.todayFerryDate();
    const effectiveRemainingOnly = isToday && remainingOnly;
    const path = isToday
      ? `Schedule/rest/scheduletoday/${departingTerminalId}/${arrivingTerminalId}/${effectiveRemainingOnly}`
      : `Schedule/rest/schedule/${tripDate}/${departingTerminalId}/${arrivingTerminalId}`;

    ctx.log.info('Fetching ferry schedule', {
      departingTerminalId,
      arrivingTerminalId,
      tripDate,
      remainingOnly: effectiveRemainingOnly,
    });
    const raw = await this.fetchJson<RawFerrySchedule>(path, ctx);

    // Schedule response nests sailings in TerminalCombos[0].Times
    const combo = raw.TerminalCombos?.[0];

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

    return {
      ...textField('departingTerminalName', combo?.DepartingTerminalName),
      ...textField('arrivingTerminalName', combo?.ArrivingTerminalName),
      tripDate,
      remainingOnly: effectiveRemainingOnly,
      ...(combo?.Annotations != null && { annotations }),
      ...htmlTextField('sailingNotes', combo?.SailingNotes),
      sailings: (combo?.Times ?? []).map((s) => ({
        ...wcfDateField('departureTime', s.DepartingTime),
        ...wcfDateField('arrivalTime', s.ArrivingTime),
        ...textField('vesselName', s.VesselName),
        ...(s.VesselID != null && { vesselId: s.VesselID }),
        ...(s.LoadingRule != null && { loadingRule: s.LoadingRule }),
        ...(typeof s.VesselHandicapAccessible === 'boolean' && {
          vesselHandicapAccessible: s.VesselHandicapAccessible,
        }),
        ...(s.AnnotationIndexes != null && {
          annotationIndexes: s.AnnotationIndexes.flatMap((i) => keptAt.get(i) ?? []),
        }),
      })),
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
      ...wcfDateField('leftDock', v.LeftDock),
      ...wcfDateField('eta', v.Eta),
      ...wcfDateField('scheduledDeparture', v.ScheduledDeparture),
      opRouteAbbrev: (v.OpRouteAbbrev ?? []).flatMap((abbrev) => nonBlank(abbrev) ?? []),
      ...wcfDateField('timestamp', v.TimeStamp),
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
              ...wcfDateField('departure', s.Departure),
              ...(typeof s.IsCancelled === 'boolean' && { isCancelled: s.IsCancelled }),
              ...textField('vesselName', s.VesselName),
              ...(s.MaxSpaceCount != null && { maxSpaceCount: s.MaxSpaceCount }),
            },
          ];
        }
        return arrivalTerminals.map((a) => ({
          ...wcfDateField('departure', s.Departure),
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
        ...wcfDateField('publishDate', a.PublishDate),
      };
    });
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
