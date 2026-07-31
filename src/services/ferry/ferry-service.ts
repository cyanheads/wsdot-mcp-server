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
  RawTerminalSailingSpace,
  RawVesselLocation,
  TerminalSailingSpace,
  VesselLocation,
} from './types.js';

const BASE_URL = 'https://www.wsdot.wa.gov/Ferries/API';
const TIMEOUT_MS = 15_000;
const SERVICE = 'WSF Ferry API';

export class FerryApiService {
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
    const raw = await this.fetchJson<RawFerryTerminal[]>('Terminals/rest/terminalbasics', ctx);
    return (raw ?? []).map((t) => ({
      terminalId: t.TerminalID ?? 0,
      terminalName: t.TerminalName ?? 'Unknown',
      ...(t.TerminalAbbrev != null && { terminalAbbrev: t.TerminalAbbrev }),
      ...(t.Latitude != null && { latitude: t.Latitude }),
      ...(t.Longitude != null && { longitude: t.Longitude }),
    }));
  }

  async getRoutes(tripDate: string, ctx: Context): Promise<FerryRoute[]> {
    ctx.log.info('Fetching ferry routes', { tripDate });
    const raw = await this.fetchJson<RawFerryRoute[]>(`Schedule/rest/routes/${tripDate}`, ctx);
    return (raw ?? []).map((r) => ({
      ...(r.RouteID != null && { routeId: r.RouteID }),
      ...(r.RouteAbbrev != null && { routeAbbrev: r.RouteAbbrev }),
      ...(r.Description != null && { description: r.Description }),
    }));
  }

  async getSchedule(
    departingTerminalId: number,
    arrivingTerminalId: number,
    tripDate: string,
    remainingOnly: boolean,
    ctx: Context,
  ): Promise<FerrySchedule> {
    let path: string;
    const todayDate = FerryApiService.todayFerryDate();
    const isToday = tripDate === todayDate;

    // remainingOnly is only meaningful for today's sailings; ignore it for future dates
    if (isToday) {
      const flag = remainingOnly ? 'true' : 'false';
      path = `Schedule/rest/scheduletoday/${departingTerminalId}/${arrivingTerminalId}/${flag}`;
    } else {
      path = `Schedule/rest/schedule/${tripDate}/${departingTerminalId}/${arrivingTerminalId}`;
    }

    ctx.log.info('Fetching ferry schedule', {
      departingTerminalId,
      arrivingTerminalId,
      tripDate,
      remainingOnly,
    });
    const raw = await this.fetchJson<RawFerrySchedule>(path, ctx);

    // Schedule response nests sailings in TerminalCombos[0].Times
    const combo = raw.TerminalCombos?.[0];
    return {
      ...(combo?.DepartingTerminalName != null && {
        departingTerminalName: combo.DepartingTerminalName,
      }),
      ...(combo?.ArrivingTerminalName != null && {
        arrivingTerminalName: combo.ArrivingTerminalName,
      }),
      tripDate,
      sailings: (combo?.Times ?? []).map((s) => ({
        ...wcfDateField('departureTime', s.DepartingTime),
        ...wcfDateField('arrivalTime', s.ArrivingTime),
        ...(s.VesselName != null && { vesselName: s.VesselName }),
      })),
    };
  }

  async getVesselLocations(ctx: Context): Promise<VesselLocation[]> {
    ctx.log.info('Fetching vessel locations');
    const raw = await this.fetchJson<RawVesselLocation[]>('Vessels/rest/vessellocations', ctx);
    return (raw ?? []).map((v) => ({
      ...(v.VesselID != null && { vesselId: v.VesselID }),
      ...(v.VesselName != null && { vesselName: v.VesselName }),
      ...(typeof v.InService === 'boolean' && { inService: v.InService }),
      ...(typeof v.AtDock === 'boolean' && { atDock: v.AtDock }),
      ...(v.DepartingTerminalID != null && { departingTerminalId: v.DepartingTerminalID }),
      ...(v.DepartingTerminalName != null && { departingTerminalName: v.DepartingTerminalName }),
      ...(v.ArrivingTerminalID != null && { arrivingTerminalId: v.ArrivingTerminalID }),
      ...(v.ArrivingTerminalName != null && { arrivingTerminalName: v.ArrivingTerminalName }),
      ...(v.Latitude != null && { latitude: v.Latitude }),
      ...(v.Longitude != null && { longitude: v.Longitude }),
      ...(v.Speed != null && { speed: v.Speed }),
      ...(v.Heading != null && { heading: v.Heading }),
      ...wcfDateField('leftDock', v.LeftDock),
      ...wcfDateField('eta', v.Eta),
      ...wcfDateField('scheduledDeparture', v.ScheduledDeparture),
      opRouteAbbrev: v.OpRouteAbbrev ?? [],
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
      ...(t.TerminalName != null && { terminalName: t.TerminalName }),
      departingSpaces: (t.DepartingSpaces ?? []).flatMap((s) => {
        // Space counts are nested per arriving terminal; expand into one entry per arrival terminal
        const arrivalTerminals = s.SpaceForArrivalTerminals ?? [];
        if (arrivalTerminals.length === 0) {
          // Departure with no arrival terminal breakdowns — emit a row with just the vessel/departure info
          return [
            {
              ...wcfDateField('departure', s.Departure),
              ...(typeof s.IsCancelled === 'boolean' && { isCancelled: s.IsCancelled }),
              ...(s.VesselName != null && { vesselName: s.VesselName }),
              ...(s.MaxSpaceCount != null && { maxSpaceCount: s.MaxSpaceCount }),
            },
          ];
        }
        return arrivalTerminals.map((a) => ({
          ...wcfDateField('departure', s.Departure),
          ...(typeof s.IsCancelled === 'boolean' && { isCancelled: s.IsCancelled }),
          ...(s.VesselName != null && { vesselName: s.VesselName }),
          // TerminalName is an itinerary string and its sibling TerminalID is the *departing*
          // terminal on multi-stop routes; ArrivalTerminalIDs is the only reliable destination.
          ...(a.TerminalName != null && { itineraryLabel: a.TerminalName }),
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
          ...(a.DriveUpSpaceHexColor != null && { driveUpSpaceHexColor: a.DriveUpSpaceHexColor }),
        }));
      }),
    }));
  }

  async getAlerts(ctx: Context): Promise<FerryAlert[]> {
    ctx.log.info('Fetching ferry alerts');
    const raw = await this.fetchJson<RawFerryAlert[]>('Schedule/rest/alerts', ctx);
    return (raw ?? []).map((a) => ({
      ...(a.BulletinID != null && { alertId: a.BulletinID }),
      // Prefer plain-text RouteAlertText; fall back to AlertFullTitle when absent
      ...(a.RouteAlertText != null
        ? { alertDescription: a.RouteAlertText }
        : a.AlertFullTitle != null
          ? { alertDescription: a.AlertFullTitle }
          : {}),
      impactedRouteIds: a.AffectedRouteIDs ?? [],
      ...wcfDateField('publishDate', a.PublishDate),
    }));
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
