/**
 * @fileoverview Paging on the four traffic collection tools, asserted on the assembled
 * `CallToolResult` — `structuredContent` with its enrichment merged in, and `content[]` with the
 * enrichment trailer appended — through the same argument parsing a client's call meets. A page
 * ends only at `limit` or at the end of the matching set, however much its rows weigh, and a
 * `limit` above the maximum is clamped with a notice unless WSDOT_CLAMP_LIMITS=false rejects it.
 * The clamp mechanism itself is tabled in `paging.test.ts`; these cases prove each tool's wiring.
 * @module tests/tools/traffic-paging.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireError } from '../helpers/assertions.js';

const mockService = {
  searchAlerts: vi.fn(),
  searchCameras: vi.fn(),
  getTravelTimes: vi.fn(),
  getTollRates: vi.fn(),
};

vi.mock('@/services/traffic/traffic-service.js', () => ({
  getTrafficApiService: () => mockService,
}));

import { getTollRates } from '@/mcp-server/tools/definitions/get-toll-rates.tool.js';
import { getTravelTimes } from '@/mcp-server/tools/definitions/get-travel-times.tool.js';
import { searchAlerts } from '@/mcp-server/tools/definitions/search-alerts.tool.js';
import { searchCameras } from '@/mcp-server/tools/definitions/search-cameras.tool.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type WireResult = Awaited<ReturnType<typeof runToolContract>>;

/** Zero-padded so no row's marker is a substring of another's. */
const pad = (index: number) => String(index).padStart(3, '0');

/**
 * Free text of `bytes` UTF-8 bytes (±a few) mixing multi-byte characters, quotes, and newlines —
 * the characters that make a row's JSON and its rendered text differ in size.
 */
function longText(bytes: number): string {
  const unit = 'Détour "right lane" closed — expect delays.\n';
  const text = unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)));
  return text.slice(0, Math.max(0, Math.floor(bytes * (text.length / Buffer.byteLength(text)))));
}

function enrichmentOf(result: WireResult) {
  const sc = result.structuredContent as Record<string, unknown>;
  return {
    totalCount: sc.totalCount as number,
    nextOffset: sc.nextOffset as number | null,
    hasMore: sc.hasMore as boolean,
    notice: sc.notice as string,
  };
}

/** Every text block of `content[]`, joined: the rendered rows and the enrichment trailer. */
function textOf(result: WireResult): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

interface PagingCase {
  defaultLimit: number;
  /** Row markers of the returned page, in order. */
  markers: (result: WireResult) => number[];
  name: string;
  /** A filter value far past the schema cap, which the tool echoes back when it accepts it. */
  oversized: Record<string, unknown>;
  /** How the past-the-end notice names the matching set. */
  pastEndUnit: string;
  /** Row `i` carrying `textBytes` bytes in the tool's free-text field. */
  row: (i: number, textBytes: number) => object;
  run: (input: Record<string, unknown>) => Promise<WireResult>;
  stub: (rows: object[]) => void;
  /** Noun as the tool's window notice spells it. */
  unit: string;
}

const page = (result: WireResult, key: string) =>
  ((result.structuredContent as Record<string, unknown>)[key] ?? []) as Record<string, unknown>[];

const cases: PagingCase[] = [
  {
    name: 'wsdot_search_alerts',
    run: (input) => runToolContract(searchAlerts, input),
    stub: (rows) => mockService.searchAlerts.mockResolvedValue(rows),
    row: (i, textBytes) => ({
      alertId: i,
      headlineDescription: `Alert ${pad(i)}`,
      eventCategory: 'Construction',
      region: 'Northwest',
      startRoadwayLocation: { roadName: '090', direction: 'E', milePost: i, latitude: 47.5 },
      ...(textBytes > 0 && { extendedDescription: longText(textBytes) }),
    }),
    markers: (result) => page(result, 'alerts').map((a) => a.alertId as number),
    unit: 'alerts',
    pastEndUnit: 'matching alerts',
    defaultLimit: 20,
    oversized: { stateRoute: `SR ${'9'.repeat(30_000)}` },
  },
  {
    name: 'wsdot_search_cameras',
    run: (input) => runToolContract(searchCameras, input),
    stub: (rows) => mockService.searchCameras.mockResolvedValue(rows),
    row: (i, textBytes) => ({
      cameraId: i,
      title: `Cam ${pad(i)}`,
      imageUrl: `https://images.wsdot.wa.gov/nw/090vc${pad(i)}.jpg`,
      roadName: 'I-90',
      milePost: i,
      region: 'NW',
      ...(textBytes > 0 && { description: longText(textBytes) }),
    }),
    markers: (result) => page(result, 'cameras').map((c) => c.cameraId as number),
    unit: 'cameras',
    pastEndUnit: 'matching cameras',
    defaultLimit: 50,
    oversized: { titleContains: 'i '.repeat(15_000) },
  },
  {
    name: 'wsdot_get_travel_times',
    run: (input) => runToolContract(getTravelTimes, input),
    stub: (rows) => mockService.getTravelTimes.mockResolvedValue(rows),
    row: (i, textBytes) => ({
      travelTimeId: i,
      name: `Corridor ${pad(i)}`,
      currentTimeInMinutes: 20,
      averageTimeInMinutes: 15,
      startPoint: { roadName: '005', direction: 'N', milePost: i },
      ...(textBytes > 0 && { description: longText(textBytes) }),
    }),
    markers: (result) => page(result, 'corridors').map((c) => c.travelTimeId as number),
    unit: 'corridors',
    pastEndUnit: 'matching corridors',
    defaultLimit: 50,
    // Matches nothing, so the no-match notice repeats it beside routeFilter.
    oversized: { route: 'X'.repeat(30_000) },
  },
  {
    name: 'wsdot_get_toll_rates',
    run: (input) => runToolContract(getTollRates, input),
    stub: (rows) => mockService.getTollRates.mockResolvedValue(rows),
    row: (i, textBytes) => ({
      tripName: `Trip ${pad(i)}`,
      stateRoute: '520',
      travelDirection: 'E',
      startMilepost: i,
      tollRateInDollars: 1.25,
      startLocationName: `Start ${pad(i)}`,
      ...(textBytes > 0 && { message: longText(textBytes) }),
    }),
    markers: (result) => page(result, 'rates').map((r) => r.startMilepost as number),
    unit: 'toll rates',
    pastEndUnit: 'toll rate entries',
    defaultLimit: 50,
    // Matches no facility, so the no-facility notice repeats it beside appliedFilters.
    oversized: { stateRoute: `SR ${'9'.repeat(30_000)}` },
  },
];

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe.each(cases)('$name — paging', (c) => {
  const rowsOf = (count: number, textBytes: (i: number) => number) =>
    range(0, count).map((i) => c.row(i, textBytes(i)));

  it('returns every row of a long-text page at limit 500, on both surfaces', async () => {
    c.stub(rowsOf(200, () => 3000));
    const result = await c.run({ limit: 500 });
    expect(result.isError).toBeFalsy();
    expect(c.markers(result)).toEqual(range(0, 200));
    expect(textOf(result).match(/^### /gm)).toHaveLength(200);

    const enrichment = enrichmentOf(result);
    expect(enrichment).toMatchObject({ totalCount: 200, hasMore: false, nextOffset: null });
    expect(enrichment.notice).toMatch(new RegExp(`^Showing ${c.unit} 1–200 of 200\\.`));
    expect(enrichment.notice).not.toContain('budget');
    expect(enrichment.notice).not.toContain('next page');
  });

  it('returns rows 3–5 when row 3 alone outweighs 24 KB', async () => {
    c.stub(rowsOf(6, (i) => (i === 3 ? 30_000 : 0)));
    const from3 = await c.run({ offset: 3, limit: 10 });
    expect(c.markers(from3)).toEqual([3, 4, 5]);
    expect(enrichmentOf(from3)).toMatchObject({ hasMore: false, nextOffset: null, totalCount: 6 });
    expect(enrichmentOf(from3).notice).toMatch(new RegExp(`^Showing ${c.unit} 4–6 of 6\\.`));

    const from0 = await c.run({ offset: 0, limit: 10 });
    expect(c.markers(from0)).toEqual(range(0, 6));
  });

  it('returns min(limit, totalCount − offset) rows whatever the rows weigh', async () => {
    for (const textBytes of [0, 3000, 30_000]) {
      c.stub(rowsOf(40, () => textBytes));
      const middle = await c.run({ offset: 7, limit: 25 });
      expect(c.markers(middle), `${textBytes} B rows`).toEqual(range(7, 32));
      expect(enrichmentOf(middle)).toMatchObject({ hasMore: true, nextOffset: 32 });
      const tail = await c.run({ offset: 32, limit: 25 });
      expect(c.markers(tail), `${textBytes} B rows`).toEqual(range(32, 40));
      expect(enrichmentOf(tail)).toMatchObject({ hasMore: false, nextOffset: null });
    }
  });

  it('walks every row exactly once, each page but the last holding limit rows', async () => {
    // Heavy rows in pairs three apart, one pair per twenty rows: row weight never moves a boundary.
    c.stub(rowsOf(60, (i) => (i % 20 === 0 || i % 20 === 3 ? 11_000 : 150)));
    const seen: number[] = [];
    const sizes: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await c.run({ offset, limit: 8 });
      const markers = c.markers(result);
      const enrichment = enrichmentOf(result);
      expect(enrichment.totalCount).toBe(60);
      const window = `Showing ${c.unit} ${offset + 1}–${offset + markers.length} of 60.`;
      expect(enrichment.notice).toMatch(new RegExp(`^${window}`));
      expect(enrichment.notice).not.toContain('budget');
      if (enrichment.hasMore) {
        expect(enrichment.nextOffset).toBe(offset + markers.length);
        expect(enrichment.notice).toMatch(
          new RegExp(`\\. Pass offset=${offset + markers.length} for the next page\\.$`),
        );
      }
      seen.push(...markers);
      sizes.push(markers.length);
      offset = enrichment.nextOffset;
    }
    expect(seen).toEqual(range(0, 60));
    expect(sizes).toEqual([8, 8, 8, 8, 8, 8, 8, 4]);
  });

  it('keeps the past-the-end notice unchanged', async () => {
    c.stub(rowsOf(200, () => 3000));
    const result = await c.run({ offset: 999 });
    expect(c.markers(result)).toEqual([]);
    expect(enrichmentOf(result)).toMatchObject({
      hasMore: false,
      nextOffset: null,
      totalCount: 200,
    });
    expect(enrichmentOf(result).notice).toBe(
      `Offset 999 is past the end of 200 ${c.pastEndUnit}. Use an offset between 0 and 199.`,
    );
  });

  it('returns an empty page with no continuation when nothing matched', async () => {
    c.stub([]);
    const result = await c.run({ limit: 500 });
    expect(result.isError).toBeFalsy();
    expect(c.markers(result)).toEqual([]);
    expect(enrichmentOf(result)).toMatchObject({ hasMore: false, nextOffset: null, totalCount: 0 });
  });

  it(`defaults to a page of ${c.defaultLimit} small rows`, async () => {
    c.stub(rowsOf(120, () => 0));
    const result = await c.run({});
    expect(c.markers(result)).toEqual(range(0, c.defaultLimit));
    expect(enrichmentOf(result).nextOffset).toBe(c.defaultLimit);
  });

  it('rejects a filter value past the schema cap', async () => {
    c.stub(rowsOf(5, () => 0));
    const result = await c.run(c.oversized);
    expect(result.isError).toBe(true);
  });

  describe('a limit above 500, with WSDOT_CLAMP_LIMITS unset', () => {
    beforeEach(() => {
      vi.stubEnv('WSDOT_CLAMP_LIMITS', undefined);
    });

    it('serves limit 501 as 500 and appends the clamp sentence to the page notice', async () => {
      c.stub(rowsOf(600, () => 0));
      const result = await c.run({ limit: 501 });
      expect(result.isError).toBeFalsy();
      expect(c.markers(result)).toEqual(range(0, 500));
      expect(enrichmentOf(result)).toMatchObject({
        totalCount: 600,
        hasMore: true,
        nextOffset: 500,
      });
      const { notice } = enrichmentOf(result);
      expect(notice).toMatch(new RegExp(`^Showing ${c.unit} 1–500 of 600\\.`));
      expect(notice).toMatch(
        /Pass offset=500 for the next page\. limit 501 exceeds the maximum of 500; using limit 500\.$/,
      );
    });

    it('clamps the numeric string "600" the framework repairs to a number', async () => {
      c.stub(rowsOf(600, () => 0));
      const result = await c.run({ limit: '600' });
      expect(result.isError).toBeFalsy();
      expect(c.markers(result)).toEqual(range(0, 500));
      expect(enrichmentOf(result).notice).toMatch(
        /limit 600 exceeds the maximum of 500; using limit 500\.$/,
      );
    });

    it('continues at offset plus the rows returned when the clamped page reaches the end', async () => {
      c.stub(rowsOf(84, () => 0));
      const result = await c.run({ offset: 80, limit: 100_000 });
      expect(c.markers(result)).toEqual([80, 81, 82, 83]);
      expect(enrichmentOf(result)).toMatchObject({ hasMore: false, nextOffset: null });
      expect(enrichmentOf(result).notice).toMatch(
        new RegExp(
          `^Showing ${c.unit} 81–84 of 84\\..* limit 100000 exceeds the maximum of 500; using limit 500\\.$`,
        ),
      );
    });

    it('leaves a page within the maximum without the clamp sentence', async () => {
      c.stub(rowsOf(600, () => 0));
      const result = await c.run({ limit: 500 });
      expect(c.markers(result)).toEqual(range(0, 500));
      expect(enrichmentOf(result).notice).not.toContain('exceeds the maximum');
    });
  });

  describe('a limit above 500, with WSDOT_CLAMP_LIMITS=false', () => {
    beforeEach(() => {
      vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
    });

    it('rejects limit 501 and "600" with the bound in the message, before the service runs', async () => {
      c.stub(rowsOf(600, () => 0));
      for (const limit of [501, '600']) {
        const result = await c.run({ limit });
        expect(wireError(result).message).toContain('limit: Too big: expected number to be <=500');
      }
      expect(Object.values(mockService).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    });

    it('serves limit 500 whole', async () => {
      c.stub(rowsOf(600, () => 0));
      const result = await c.run({ limit: 500 });
      expect(c.markers(result)).toEqual(range(0, 500));
      expect(enrichmentOf(result).notice).not.toContain('exceeds the maximum');
    });
  });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
  ])(
    'rejects 0, -1, 2.5, and "abc" with their own messages when the flag is %s',
    async (_mode, flag) => {
      vi.stubEnv('WSDOT_CLAMP_LIMITS', flag);
      c.stub(rowsOf(5, () => 0));
      const messages = await Promise.all(
        [0, -1, 2.5, 'abc'].map(async (limit) => wireError(await c.run({ limit })).message),
      );
      expect(messages[0]).toContain('limit: Too small: expected number to be >=1');
      expect(messages[1]).toContain('limit: Too small: expected number to be >=1');
      expect(messages[2]).toContain('limit: Invalid input: expected int, received number');
      expect(messages[3]).toContain('limit: Invalid input: expected number, received string');
    },
  );
});
