/**
 * @fileoverview Runs the camera and toll filters end to end over the real TrafficApiService:
 * raw upstream JSON through normalization, the service-side route/region/milepost filters, the
 * handler-side title and toll-route filters, paging, and the wire envelope. The tool tests stub
 * the service module; these stub only `fetch`, so the composition the service and handler share
 * is exercised as it runs in production.
 * @module tests/tools/traffic-filters-upstream.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

import { getTollRates } from '@/mcp-server/tools/definitions/get-toll-rates.tool.js';
import { searchCameras } from '@/mcp-server/tools/definitions/search-cameras.tool.js';
import { initTrafficApiService } from '@/services/traffic/traffic-service.js';

const CAMERAS_URL = /\/HighwayCameras\/HighwayCamerasREST\.svc\/GetCamerasAsJson\?/;
const TOLLS_URL = /\/TollRates\/TollRatesREST\.svc\/GetTollRatesAsJson\?/;

const rawCamera = (
  id: number,
  title: string | null,
  roadName: string,
  milePost: number,
  region = 'SC',
) => ({
  CameraID: id,
  Title: title,
  Description: null,
  ImageURL: `https://images.wsdot.wa.gov/sc/${id}.jpg`,
  Region: region,
  CameraLocation: { RoadName: roadName, MilePost: milePost, Direction: 'B' },
});

/** The live I-90 MP 50–55 window, plus a Snoqualmie title off the route and one camera with no title. */
const rawCameras = [
  rawCamera(1099, 'I-90 at MP 51.3: Franklin Falls', 'I-90', 51.3),
  rawCamera(1100, 'I-90 at MP 52: Snoqualmie Summit', 'I-90', 52),
  rawCamera(9428, 'I-90 at MP 53.4: East Snoqualmie Summit', 'I-90', 53.4),
  rawCamera(1102, 'I-90 at MP 55.1: Hyak', 'I-90', 55.1),
  rawCamera(10296, 'I-90 at MP 54.5: Hyak Hill', 'I-90', 54.5),
  rawCamera(10070, 'I-90 at MP 55.2: ', 'I-90', 55.2),
  rawCamera(1500, 'SR 18 at MP 1: Snoqualmie Parkway', 'SR 18', 1, 'NW'),
  rawCamera(1101, null, 'I-90', 52.5),
];

const rawToll = (tripName: string, stateRoute: string, direction: string) => ({
  TripName: tripName,
  StateRoute: stateRoute,
  TravelDirection: direction,
  CurrentToll: 125,
  StartLocationName: 'Start',
  EndLocationName: 'End',
});

const rawTolls = [
  rawToll('099tp03268', '099', 'S'),
  rawToll('405tp01351', '405', 'N'),
  rawToll('167tp02565', '167', 'S'),
  rawToll('520tp00422', '520', 'E'),
  rawToll('405tp02718', '405', 'S'),
];

let http: ReturnType<typeof createFetchMock>;

beforeEach(() => {
  initTrafficApiService({} as never, {} as never);
  // Strict: any request no route matches throws, so an unexpected upstream call fails the test.
  http = createFetchMock([
    { method: 'GET', match: CAMERAS_URL, respond: Response.json(rawCameras) },
    { method: 'GET', match: TOLLS_URL, respond: Response.json(rawTolls) },
  ]);
  http.install();
});

afterEach(() => http.restore());

const ids = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { cameras: { cameraId?: number }[] }).cameras.map((c) => c.cameraId);

describe('wsdot_search_cameras over the real service', () => {
  it('intersects titleContains with the route and milepost filters', async () => {
    const result = await runToolContract(searchCameras, {
      stateRoute: 'I-90',
      startMilepost: 50,
      endMilepost: 55,
      titleContains: 'Snoqualmie',
    });
    expect(result.isError).toBeFalsy();
    expect(ids(result)).toEqual([1100, 9428]);
    expect(result.structuredContent).toMatchObject({ totalCount: 2, hasMore: false });
    expect(http.calls).toHaveLength(1);
  });

  it('drops the route and milepost filters without dropping the title match', async () => {
    const result = await runToolContract(searchCameras, { titleContains: 'Snoqualmie' });
    expect(ids(result)).toEqual([1100, 1500, 9428]);
  });

  it('keeps a camera with no title in an unfiltered call and excludes it from a title match', async () => {
    const all = await runToolContract(searchCameras, { stateRoute: 'I-90' });
    expect(ids(all)).toContain(1101);
    const titled = await runToolContract(searchCameras, {
      stateRoute: 'I-90',
      titleContains: 'i-90',
    });
    expect(titled.isError).toBeFalsy();
    expect(ids(titled)).not.toContain(1101);
    expect(ids(titled)).toHaveLength(6);
  });
});

describe('wsdot_get_toll_rates over the real service', () => {
  const trips = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { rates: { tripName?: string }[] }).rates.map((r) => r.tripName);

  it('matches the normalized feed value against its posted designation', async () => {
    expect(trips(await runToolContract(getTollRates, { stateRoute: 'I-405' }))).toEqual([
      '405tp01351',
      '405tp02718',
    ]);
    expect(trips(await runToolContract(getTollRates, { stateRoute: 'SR 405' }))).toEqual([]);
    expect(trips(await runToolContract(getTollRates, { stateRoute: '0520' }))).toEqual([
      '520tp00422',
    ]);
  });

  it('names the tolled routes present in the feed when a route has no facility', async () => {
    const result = await runToolContract(getTollRates, { stateRoute: 'SR 2' });
    expect((result.structuredContent as { notice: string }).notice).toContain(
      'SR 99, SR 167, I-405, SR 520',
    );
  });
});
