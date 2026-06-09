/**
 * @fileoverview WSDOT Traffic API service — mountain passes, alerts, travel times,
 * toll rates, border crossings, and cameras.
 * @module services/traffic/traffic-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { wcfDateField } from '@/services/wcf-date.js';
import type {
  BorderCrossing,
  Camera,
  HighwayAlert,
  MountainPass,
  RawBorderCrossing,
  RawCamera,
  RawHighwayAlert,
  RawMountainPass,
  RawTollRate,
  RawTravelTime,
  TollRate,
  TravelTime,
} from './types.js';

const BASE_URL = 'https://www.wsdot.wa.gov/Traffic/api';
const TIMEOUT_MS = 15_000;

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
    return withRetry(
      async () => {
        const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
        const signal = ctx.signal.aborted
          ? ctx.signal
          : AbortSignal.any([ctx.signal, timeoutSignal]);
        const response = await fetch(url, { signal });
        if (!response.ok) {
          // 4xx is a client error that won't succeed on retry — mark non-retryable so withRetry
          // fails fast instead of burning all attempts (the data.retryable === false opt-out).
          const isClientError = response.status >= 400 && response.status < 500;
          throw serviceUnavailable(`WSDOT Traffic API returned HTTP ${response.status}.`, {
            url,
            status: response.status,
            ...(isClientError && { retryable: false }),
          });
        }
        // Auth failure returns HTML, not JSON — detect by Content-Type
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          throw serviceUnavailable(
            'WSDOT Traffic API returned an HTML page instead of JSON. Verify that WSDOT_ACCESS_CODE is set to a valid access code.',
            { url },
          );
        }
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'WSDOT Traffic API returned HTML content. Verify that WSDOT_ACCESS_CODE is set to a valid access code.',
            { url },
          );
        }
        return JSON.parse(text) as T;
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
    return passes.map((p) => ({
      mountainPassId: p.MountainPassId ?? 0,
      mountainPassName: p.MountainPassName ?? 'Unknown',
      ...(p.ElevationInFeet != null && { elevation: p.ElevationInFeet }),
      ...(p.TemperatureInFahrenheit != null && {
        temperatureInFahrenheit: p.TemperatureInFahrenheit,
      }),
      ...(p.WeatherCondition != null && { weatherCondition: p.WeatherCondition }),
      ...(p.RoadCondition != null && { roadCondition: p.RoadCondition }),
      ...(typeof p.TravelAdvisoryActive === 'boolean' && {
        travelAdvisoryActive: p.TravelAdvisoryActive,
      }),
      ...(p.RestrictionOne?.RestrictionText || p.RestrictionOne?.TravelDirection
        ? {
            restrictionOne: {
              ...(p.RestrictionOne.RestrictionText != null && {
                text: p.RestrictionOne.RestrictionText,
              }),
              ...(p.RestrictionOne.TravelDirection != null && {
                travelDirection: p.RestrictionOne.TravelDirection,
              }),
            },
          }
        : {}),
      ...(p.RestrictionTwo?.RestrictionText || p.RestrictionTwo?.TravelDirection
        ? {
            restrictionTwo: {
              ...(p.RestrictionTwo.RestrictionText != null && {
                text: p.RestrictionTwo.RestrictionText,
              }),
              ...(p.RestrictionTwo.TravelDirection != null && {
                travelDirection: p.RestrictionTwo.TravelDirection,
              }),
            },
          }
        : {}),
      ...wcfDateField('dateUpdated', p.DateUpdated),
      ...(p.Latitude != null && { latitude: p.Latitude }),
      ...(p.Longitude != null && { longitude: p.Longitude }),
    }));
  }

  async searchAlerts(params: AlertSearchParams, ctx: Context): Promise<HighwayAlert[]> {
    const result = await this.fetchJson<RawHighwayAlert[]>(
      'HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson',
      ctx,
    );
    let alerts = result.map(normalizeAlert);

    if (params.stateRoute) {
      const route = params.stateRoute.toLowerCase();
      alerts = alerts.filter(
        (a) =>
          a.startRoadwayLocation?.roadName?.toLowerCase().includes(route) ||
          a.endRoadwayLocation?.roadName?.toLowerCase().includes(route),
      );
    }
    if (params.region) {
      const region = params.region.toLowerCase();
      alerts = alerts.filter((a) => a.region?.toLowerCase() === region);
    }
    if (params.startMilepost != null) {
      const minMp = params.startMilepost;
      alerts = alerts.filter(
        (a) => a.startRoadwayLocation?.milePost == null || a.startRoadwayLocation.milePost >= minMp,
      );
    }
    if (params.endMilepost != null) {
      const maxMp = params.endMilepost;
      alerts = alerts.filter(
        (a) => a.startRoadwayLocation?.milePost == null || a.startRoadwayLocation.milePost <= maxMp,
      );
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
      ...(t.Name != null && { name: t.Name }),
      ...(t.Description != null && { description: t.Description }),
      ...(t.CurrentTime != null && { currentTimeInMinutes: t.CurrentTime }),
      ...(t.AverageTime != null && { averageTimeInMinutes: t.AverageTime }),
      ...wcfDateField('timeUpdated', t.TimeUpdated),
      ...(t.Distance != null && { distanceInMiles: t.Distance }),
      ...(t.StartPoint != null && {
        startPoint: {
          ...(t.StartPoint.RoadName != null && { roadName: t.StartPoint.RoadName }),
          ...(t.StartPoint.Direction != null && { direction: t.StartPoint.Direction }),
          ...(t.StartPoint.MilePost != null && { milePost: t.StartPoint.MilePost }),
        },
      }),
      ...(t.EndPoint != null && {
        endPoint: {
          ...(t.EndPoint.RoadName != null && { roadName: t.EndPoint.RoadName }),
          ...(t.EndPoint.Direction != null && { direction: t.EndPoint.Direction }),
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
      ...(r.TripName != null && { tripName: r.TripName }),
      ...(r.StateRoute != null && { stateRoute: r.StateRoute }),
      ...(r.TravelDirection != null && { travelDirection: r.TravelDirection }),
      ...(r.StartMilepost != null && { startMilepost: r.StartMilepost }),
      ...(r.EndMilepost != null && { endMilepost: r.EndMilepost }),
      ...(r.CurrentToll != null && { tollRateInDollars: r.CurrentToll / 100 }),
      ...(r.CurrentMessage != null && { message: r.CurrentMessage }),
      ...(r.StartLocationName != null && { startLocationName: r.StartLocationName }),
      ...(r.EndLocationName != null && { endLocationName: r.EndLocationName }),
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
      ...(c.CrossingName != null && { crossingName: c.CrossingName }),
      // WSDOT emits -1 when a crossing has no current reading — drop it rather than surface a bogus wait.
      ...(c.WaitTime != null && c.WaitTime >= 0 && { waitTimeInMinutes: c.WaitTime }),
      ...wcfDateField('updateTime', c.Time),
      ...(c.BorderCrossingLocation != null && {
        location: {
          ...(c.BorderCrossingLocation.Description != null && {
            description: c.BorderCrossingLocation.Description,
          }),
          ...(c.BorderCrossingLocation.RoadName != null && {
            roadName: c.BorderCrossingLocation.RoadName,
          }),
          ...(c.BorderCrossingLocation.Direction != null && {
            direction: c.BorderCrossingLocation.Direction,
          }),
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
      // Road names use formats like "I-90", "SR 520" — not zero-padded numbers.
      // Strip leading zeros from the input ("090" → "90") and match as a number suffix.
      const routeNum = params.stateRoute.replace(/^0+/, '') || params.stateRoute;
      cameras = cameras.filter((c) => {
        if (!c.roadName) return false;
        // Match "I-90", "SR 520", "SR520", etc.
        return /[-\s]/.test(c.roadName)
          ? c.roadName.split(/[-\s]/).pop() === routeNum
          : c.roadName.replace(/[^0-9]/g, '') === routeNum;
      });
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

function normalizeAlert(a: RawHighwayAlert): HighwayAlert {
  return {
    ...(a.AlertID != null && { alertId: a.AlertID }),
    ...(a.HeadlineDescription != null && { headlineDescription: a.HeadlineDescription }),
    ...(a.ExtendedDescription != null && { extendedDescription: a.ExtendedDescription }),
    ...(a.EventCategory != null && { eventCategory: a.EventCategory }),
    ...(a.EventStatus != null && { eventStatus: a.EventStatus }),
    ...(a.Priority != null && { priority: a.Priority }),
    ...(a.Region != null && { region: a.Region }),
    ...(a.County != null && { county: a.County }),
    ...(a.StartRoadwayLocation != null && {
      startRoadwayLocation: {
        ...(a.StartRoadwayLocation.RoadName != null && {
          roadName: a.StartRoadwayLocation.RoadName,
        }),
        ...(a.StartRoadwayLocation.Direction != null && {
          direction: a.StartRoadwayLocation.Direction,
        }),
        ...(a.StartRoadwayLocation.MilePost != null && {
          milePost: a.StartRoadwayLocation.MilePost,
        }),
        ...(a.StartRoadwayLocation.Latitude != null && {
          latitude: a.StartRoadwayLocation.Latitude,
        }),
        ...(a.StartRoadwayLocation.Longitude != null && {
          longitude: a.StartRoadwayLocation.Longitude,
        }),
      },
    }),
    ...(a.EndRoadwayLocation != null && {
      endRoadwayLocation: {
        ...(a.EndRoadwayLocation.RoadName != null && { roadName: a.EndRoadwayLocation.RoadName }),
        ...(a.EndRoadwayLocation.Direction != null && {
          direction: a.EndRoadwayLocation.Direction,
        }),
        ...(a.EndRoadwayLocation.MilePost != null && { milePost: a.EndRoadwayLocation.MilePost }),
        ...(a.EndRoadwayLocation.Latitude != null && { latitude: a.EndRoadwayLocation.Latitude }),
        ...(a.EndRoadwayLocation.Longitude != null && {
          longitude: a.EndRoadwayLocation.Longitude,
        }),
      },
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
    ...(c.Title != null && { title: c.Title }),
    ...(c.Description != null && { description: c.Description }),
    ...(c.ImageURL != null && { imageUrl: c.ImageURL }),
    ...(c.ImageWidth != null && { imageWidth: c.ImageWidth }),
    ...(c.ImageHeight != null && { imageHeight: c.ImageHeight }),
    ...(loc?.RoadName != null && { roadName: loc.RoadName }),
    ...(loc?.Direction != null && { direction: loc.Direction }),
    ...(loc?.MilePost != null && { milePost: loc.MilePost }),
    ...(c.Region != null && { region: c.Region }),
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
