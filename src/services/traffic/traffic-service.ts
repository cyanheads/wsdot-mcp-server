/**
 * @fileoverview WSDOT Traffic API service — mountain passes, alerts, travel times,
 * toll rates, border crossings, and cameras.
 * @module services/traffic/traffic-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { htmlTextField, textField } from '@/services/text-field.js';
import { wcfDateField } from '@/services/wcf-date.js';
import { assertUpstreamJson, fetchUpstream, redactUrl } from '@/services/wsdot-http.js';
import { routeMatches } from './route-match.js';
import type {
  BorderCrossing,
  Camera,
  HighwayAlert,
  MountainPass,
  RawBorderCrossing,
  RawCamera,
  RawHighwayAlert,
  RawMountainPass,
  RawRoadwayLocation,
  RawTollRate,
  RawTravelRestriction,
  RawTravelTime,
  RoadwayLocation,
  TollRate,
  TravelRestriction,
  TravelTime,
} from './types.js';

const BASE_URL = 'https://www.wsdot.wa.gov/Traffic/api';
const TIMEOUT_MS = 15_000;
const SERVICE = 'WSDOT Traffic API';

/** Alert search parameters (client-side filtering against GetAlertsAsJson). */
export interface AlertSearchParams {
  endMilepost?: number;
  region?: string;
  startMilepost?: number;
  stateRoute?: string;
}

/** Camera search parameters (client-side filtering against GetCamerasAsJson). */
export interface CameraSearchParams {
  endMilepost?: number;
  region?: string;
  startMilepost?: number;
  stateRoute?: string;
}

export class TrafficApiService {
  constructor(_config: AppConfig, _storage: StorageService) {}

  private accessCode(): string {
    return getServerConfig().accessCode;
  }

  private fetchJson<T>(path: string, ctx: Context): Promise<T> {
    const url = `${BASE_URL}/${path}${path.includes('?') ? '&' : '?'}AccessCode=${this.accessCode()}`;
    const endpoint = redactUrl(url);
    return withRetry(
      async () => {
        const response = await fetchUpstream(url, endpoint, SERVICE, TIMEOUT_MS, ctx);
        // The body is read before any status check: an unregistered access code comes back as a
        // 400 whose body carries WSDOT's own explanation, which a status-first throw discards.
        const body = await response.text();
        assertUpstreamJson({ body, endpoint, response, service: SERVICE }, ctx);
        return JSON.parse(body) as T;
      },
      {
        operation: 'TrafficApiService.fetchJson',
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  async getMountainPasses(ctx: Context): Promise<MountainPass[]> {
    ctx.log.info('Fetching mountain pass conditions');
    const passes = await this.fetchJson<RawMountainPass[]>(
      'MountainPassConditions/MountainPassConditionsREST.svc/GetMountainPassConditionsAsJson',
      ctx,
    );
    return passes.map((p) => {
      const restrictionOne = normalizeRestriction(p.RestrictionOne);
      const restrictionTwo = normalizeRestriction(p.RestrictionTwo);
      return {
        ...(p.MountainPassId != null && { mountainPassId: p.MountainPassId }),
        ...textField('mountainPassName', p.MountainPassName),
        ...(p.ElevationInFeet != null && { elevation: p.ElevationInFeet }),
        ...(p.TemperatureInFahrenheit != null && {
          temperatureInFahrenheit: p.TemperatureInFahrenheit,
        }),
        ...textField('weatherCondition', p.WeatherCondition),
        ...textField('roadCondition', p.RoadCondition),
        ...(typeof p.TravelAdvisoryActive === 'boolean' && {
          travelAdvisoryActive: p.TravelAdvisoryActive,
        }),
        ...(restrictionOne && { restrictionOne }),
        ...(restrictionTwo && { restrictionTwo }),
        ...wcfDateField('dateUpdated', p.DateUpdated),
        ...(p.Latitude != null && { latitude: p.Latitude }),
        ...(p.Longitude != null && { longitude: p.Longitude }),
      };
    });
  }

  async searchAlerts(params: AlertSearchParams, ctx: Context): Promise<HighwayAlert[]> {
    const result = await this.fetchJson<RawHighwayAlert[]>(
      'HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson',
      ctx,
    );
    let alerts = result.map(normalizeAlert);

    if (params.stateRoute) {
      // Compare route designations (not a roadName substring) so "90" matches I-90 without also
      // matching SR 290, natural forms ("I-90") resolve against the feed's bare "090", and a
      // prefixed filter such as "SR 26" does not pull in US 26.
      const target = params.stateRoute;
      alerts = alerts.filter((a) => {
        const start = a.startRoadwayLocation?.roadName;
        const end = a.endRoadwayLocation?.roadName;
        return (
          (start != null && routeMatches(target, start)) ||
          (end != null && routeMatches(target, end))
        );
      });
    }
    if (params.region) {
      const region = params.region.toLowerCase();
      alerts = alerts.filter((a) => a.region?.toLowerCase() === region);
    }
    if (params.startMilepost != null || params.endMilepost != null) {
      // An alert is an extent, so the requested range is tested for overlap against the span
      // between the mileposts the alert reports — a closure running from MP 10 to MP 30 covers a
      // request for MP 20. Mileposts descend on a decreasing-direction record, so the span is
      // taken as min/max rather than assuming start <= end. An alert with no milepost is kept.
      const min = params.startMilepost ?? Number.NEGATIVE_INFINITY;
      const max = params.endMilepost ?? Number.POSITIVE_INFINITY;
      alerts = alerts.filter((a) => {
        const posts = [a.startRoadwayLocation?.milePost, a.endRoadwayLocation?.milePost].filter(
          (mp) => mp != null,
        );
        return posts.length === 0 || (Math.min(...posts) <= max && Math.max(...posts) >= min);
      });
    }

    return alerts;
  }

  async getTravelTimes(ctx: Context): Promise<TravelTime[]> {
    ctx.log.info('Fetching travel times');
    const times = await this.fetchJson<RawTravelTime[]>(
      'TravelTimes/TravelTimesREST.svc/GetTravelTimesAsJson',
      ctx,
    );
    return times.map((t) => ({
      ...(t.TravelTimeID != null && { travelTimeId: t.TravelTimeID }),
      ...textField('name', t.Name),
      ...textField('description', t.Description),
      ...(isMeasuredDuration(t.CurrentTime, t.Distance) && { currentTimeInMinutes: t.CurrentTime }),
      ...(isMeasuredDuration(t.AverageTime, t.Distance) && { averageTimeInMinutes: t.AverageTime }),
      ...wcfDateField('timeUpdated', t.TimeUpdated),
      ...(t.Distance != null && { distanceInMiles: t.Distance }),
      ...(t.StartPoint != null && {
        startPoint: {
          ...textField('roadName', t.StartPoint.RoadName),
          ...textField('direction', t.StartPoint.Direction),
          ...(t.StartPoint.MilePost != null && { milePost: t.StartPoint.MilePost }),
        },
      }),
      ...(t.EndPoint != null && {
        endPoint: {
          ...textField('roadName', t.EndPoint.RoadName),
          ...textField('direction', t.EndPoint.Direction),
          ...(t.EndPoint.MilePost != null && { milePost: t.EndPoint.MilePost }),
        },
      }),
    }));
  }

  async getTollRates(ctx: Context): Promise<TollRate[]> {
    ctx.log.info('Fetching toll rates');
    const rates = await this.fetchJson<RawTollRate[]>(
      'TollRates/TollRatesREST.svc/GetTollRatesAsJson',
      ctx,
    );
    return rates.map((r) => ({
      ...textField('tripName', r.TripName),
      ...textField('stateRoute', r.StateRoute),
      ...textField('travelDirection', r.TravelDirection),
      ...(r.StartMilepost != null && { startMilepost: r.StartMilepost }),
      ...(r.EndMilepost != null && { endMilepost: r.EndMilepost }),
      ...(r.CurrentToll != null && { tollRateInDollars: r.CurrentToll / 100 }),
      ...textField('message', r.CurrentMessage),
      ...textField('startLocationName', r.StartLocationName),
      ...textField('endLocationName', r.EndLocationName),
      ...(r.StartLatitude != null && { startLatitude: r.StartLatitude }),
      ...(r.StartLongitude != null && { startLongitude: r.StartLongitude }),
      ...(r.EndLatitude != null && { endLatitude: r.EndLatitude }),
      ...(r.EndLongitude != null && { endLongitude: r.EndLongitude }),
      ...wcfDateField('timeUpdated', r.TimeUpdated),
    }));
  }

  async getBorderCrossings(ctx: Context): Promise<BorderCrossing[]> {
    ctx.log.info('Fetching border crossings');
    const crossings = await this.fetchJson<RawBorderCrossing[]>(
      'BorderCrossings/BorderCrossingsREST.svc/GetBorderCrossingsAsJson',
      ctx,
    );
    return crossings.map((c) => ({
      ...textField('crossingName', c.CrossingName),
      // WSDOT emits -1 when a crossing has no current reading — drop it rather than surface a bogus wait.
      ...(c.WaitTime != null && c.WaitTime >= 0 && { waitTimeInMinutes: c.WaitTime }),
      ...wcfDateField('updateTime', c.Time),
      ...(c.BorderCrossingLocation != null && {
        location: {
          ...textField('description', c.BorderCrossingLocation.Description),
          ...textField('roadName', c.BorderCrossingLocation.RoadName),
          ...textField('direction', c.BorderCrossingLocation.Direction),
          ...(c.BorderCrossingLocation.MilePost != null && {
            milePost: c.BorderCrossingLocation.MilePost,
          }),
          ...(c.BorderCrossingLocation.Latitude != null && {
            latitude: c.BorderCrossingLocation.Latitude,
          }),
          ...(c.BorderCrossingLocation.Longitude != null && {
            longitude: c.BorderCrossingLocation.Longitude,
          }),
        },
      }),
    }));
  }

  async searchCameras(params: CameraSearchParams, ctx: Context): Promise<Camera[]> {
    const result = await this.fetchJson<RawCamera[]>(
      'HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson',
      ctx,
    );
    let cameras = result.map(normalizeCamera);

    if (params.stateRoute) {
      // Match on the route designation so natural forms ("I-90", "SR 520") and padded/bare numbers
      // ("090", "90") all resolve to the same route, "90" can't substring-match a different route
      // such as "SR 290", and the prefixed camera road names stay distinct: "SR 26" is not US 26.
      const target = params.stateRoute;
      cameras = cameras.filter((c) => c.roadName != null && routeMatches(target, c.roadName));
    }
    if (params.region) {
      const region = params.region.toUpperCase();
      cameras = cameras.filter((c) => c.region?.toUpperCase() === region);
    }
    if (params.startMilepost != null) {
      const minMp = params.startMilepost;
      cameras = cameras.filter((c) => c.milePost == null || c.milePost >= minMp);
    }
    if (params.endMilepost != null) {
      const maxMp = params.endMilepost;
      cameras = cameras.filter((c) => c.milePost == null || c.milePost <= maxMp);
    }

    return cameras;
  }
}

// --- Normalization helpers ---

/**
 * Reports whether a travel-time figure is a measurement. WSDOT emits 0 rather than null for a
 * corridor it is not currently measuring — the reversible express lanes report 0 while closed in
 * the queried direction — and a corridor with distance cannot be a zero-minute trip. Keyed on the
 * value, not the corridor name: the opposite-direction express lanes carry real measurements under
 * the same naming. A 0 stands when the feed reports no distance, since nothing contradicts it.
 */
function isMeasuredDuration(
  minutes: number | null | undefined,
  distanceInMiles: number | null | undefined,
): minutes is number {
  if (minutes == null) return false;
  return minutes !== 0 || distanceInMiles == null || distanceInMiles === 0;
}

/**
 * WSDOT fills an *unpopulated* roadway location with zeros rather than omitting it — a point alert
 * carries an end location whose MilePost, Latitude, and Longitude are all 0. Those are placeholders,
 * not a position at MP 0 in the Gulf of Guinea, so they are dropped; the road name and direction
 * the record does carry are kept.
 */
function normalizeRoadwayLocation(loc: RawRoadwayLocation): RoadwayLocation {
  const unpopulated = loc.MilePost === 0 && loc.Latitude === 0 && loc.Longitude === 0;
  return {
    ...textField('roadName', loc.RoadName),
    ...textField('direction', loc.Direction),
    ...(!unpopulated && loc.MilePost != null && { milePost: loc.MilePost }),
    ...(!unpopulated && loc.Latitude != null && { latitude: loc.Latitude }),
    ...(!unpopulated && loc.Longitude != null && { longitude: loc.Longitude }),
  };
}

/**
 * A pass restriction, or `undefined` when neither its text nor its direction carries a value —
 * the gate reads the normalized strings, so a whitespace-only pair leaves no empty object behind.
 */
function normalizeRestriction(
  raw: RawTravelRestriction | null | undefined,
): TravelRestriction | undefined {
  const restriction = {
    ...textField('text', raw?.RestrictionText),
    ...textField('travelDirection', raw?.TravelDirection),
  };
  return Object.keys(restriction).length > 0 ? restriction : undefined;
}

/**
 * WSDOT authors alert descriptions in a rich-text editor and ships the markup through — a
 * "read the advisory" link arrives as a raw `<a href=…>` anchor. Both descriptions are rendered
 * to plain text here, before either response path reads them, so `structuredContent` and the
 * `format()` markdown carry the same normalized string. A description that held nothing but
 * markup or whitespace is dropped rather than surfaced as a blank field.
 */
function normalizeAlert(a: RawHighwayAlert): HighwayAlert {
  return {
    ...(a.AlertID != null && { alertId: a.AlertID }),
    ...htmlTextField('headlineDescription', a.HeadlineDescription),
    ...htmlTextField('extendedDescription', a.ExtendedDescription),
    ...textField('eventCategory', a.EventCategory),
    ...textField('eventStatus', a.EventStatus),
    ...textField('priority', a.Priority),
    ...textField('region', a.Region),
    ...textField('county', a.County),
    ...(a.StartRoadwayLocation != null && {
      startRoadwayLocation: normalizeRoadwayLocation(a.StartRoadwayLocation),
    }),
    ...(a.EndRoadwayLocation != null && {
      endRoadwayLocation: normalizeRoadwayLocation(a.EndRoadwayLocation),
    }),
    ...wcfDateField('startTime', a.StartTime),
    ...wcfDateField('endTime', a.EndTime),
    ...wcfDateField('lastUpdatedTime', a.LastUpdatedTime),
  };
}

function normalizeCamera(c: RawCamera): Camera {
  const loc = c.CameraLocation;
  return {
    ...(c.CameraID != null && { cameraId: c.CameraID }),
    ...textField('title', c.Title),
    ...textField('description', c.Description),
    ...textField('imageUrl', c.ImageURL),
    ...(c.ImageWidth != null && { imageWidth: c.ImageWidth }),
    ...(c.ImageHeight != null && { imageHeight: c.ImageHeight }),
    ...textField('roadName', loc?.RoadName),
    ...textField('direction', loc?.Direction),
    ...(loc?.MilePost != null && { milePost: loc.MilePost }),
    ...textField('region', c.Region),
    ...(loc?.Latitude != null && { latitude: loc.Latitude }),
    ...(loc?.Longitude != null && { longitude: loc.Longitude }),
  };
}

// --- Init/accessor pattern ---

let _service: TrafficApiService | undefined;

export function initTrafficApiService(config: AppConfig, storage: StorageService): void {
  _service = new TrafficApiService(config, storage);
}

export function getTrafficApiService(): TrafficApiService {
  if (!_service) {
    throw new Error('TrafficApiService not initialized — call initTrafficApiService() in setup()');
  }
  return _service;
}
