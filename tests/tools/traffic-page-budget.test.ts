/**
 * @fileoverview The per-surface byte budget on the four paged traffic collection tools, asserted
 * on the assembled `CallToolResult` — `structuredContent` with its enrichment merged in, and
 * `content[]` with the enrichment trailer appended — since `format()` alone never sees the
 * trailer. Rows carry multi-KB free text so the budget, not `limit`, ends the page.
 * @module tests/tools/traffic-page-budget.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

type WireResult = Awaited<ReturnType<typeof runToolContract>>;

/** The ceiling each surface of a response must stay within, in UTF-8 bytes. */
const CEILING = 24_000;

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

/** UTF-8 bytes of each surface a client can read. */
function surfaces(result: WireResult) {
  const text = result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
  return {
    json: Buffer.byteLength(JSON.stringify(result.structuredContent)),
    text: Buffer.byteLength(text),
  };
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

interface BudgetCase {
  defaultLimit: number;
  /** Input that still matches every row while the enrichment echoes a long caller-supplied value. */
  longEcho: Record<string, unknown>;
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

const cases: BudgetCase[] = [
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
    // The service applies stateRoute, and the stub ignores it, so a maximum-length value still
    // matches; control characters make its JSON echo six bytes per character.
    longEcho: {
      stateRoute: '\u0001'.repeat(200),
      region: 'north central',
      startMilepost: -1.7976931348623157e308,
      endMilepost: 1.7976931348623157e308,
    },
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
    // Every title carries "cam", so a maximum-length title filter repeating it still matches every
    // row; the stub ignores stateRoute, whose quotes escape to two JSON bytes each.
    longEcho: { titleContains: 'cam '.repeat(50), stateRoute: '"'.repeat(200), region: 'nw' },
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
    // Text ahead of a route number leaves the designation bare, so this still matches every "005"
    // corridor; its control characters make the routeFilter echo six JSON bytes per character.
    longEcho: { route: `${'\u0001'.repeat(197)}005` },
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
    // A bare route number matches SR 520 whatever text precedes it, so every row stays on the page
    // while the appliedFilters echo carries six JSON bytes per control character.
    longEcho: { stateRoute: `${'\u0001'.repeat(197)}520` },
    // Matches no facility, so the no-facility notice repeats it beside appliedFilters.
    oversized: { stateRoute: `SR ${'9'.repeat(30_000)}` },
  },
];

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe.each(cases)('$name — 24,000-byte page budget', (c) => {
  const rowsOf = (count: number, textBytes: (i: number) => number) =>
    range(0, count).map((i) => c.row(i, textBytes(i)));

  it('keeps both surfaces within the budget on a long-text page at limit 500', async () => {
    c.stub(rowsOf(200, () => 3000));
    const result = await c.run({ limit: 500 });
    expect(result.isError).toBeFalsy();
    const size = surfaces(result);
    expect(size.json).toBeLessThanOrEqual(CEILING);
    expect(size.text).toBeLessThanOrEqual(CEILING);

    const markers = c.markers(result);
    expect(markers.length).toBeGreaterThan(1);
    expect(markers.length).toBeLessThan(200);
    expect(markers).toEqual(range(0, markers.length));

    const enrichment = enrichmentOf(result);
    expect(enrichment.totalCount).toBe(200);
    expect(enrichment.hasMore).toBe(true);
    expect(enrichment.nextOffset).toBe(markers.length);
    expect(enrichment.notice).toContain(`Showing ${c.unit} 1–${markers.length} of 200.`);
    expect(enrichment.notice).toContain('24,000-byte response budget');
    expect(enrichment.notice).toContain(`offset=${markers.length}`);
  });

  it('returns a row larger than the whole budget alone, continuing at the next offset', async () => {
    c.stub(rowsOf(6, (i) => (i === 3 ? 30_000 : 0)));
    const alone = await c.run({ offset: 3, limit: 10 });
    expect(c.markers(alone)).toEqual([3]);
    expect(enrichmentOf(alone)).toMatchObject({ hasMore: true, nextOffset: 4, totalCount: 6 });
    expect(enrichmentOf(alone).notice).toContain('24,000-byte response budget');
    expect(enrichmentOf(alone).notice).toContain('offset=4');

    const before = await c.run({ offset: 0, limit: 10 });
    expect(c.markers(before)).toEqual([0, 1, 2]);
    expect(enrichmentOf(before)).toMatchObject({ hasMore: true, nextOffset: 3 });
    expect(surfaces(before).json).toBeLessThanOrEqual(CEILING);
    expect(surfaces(before).text).toBeLessThanOrEqual(CEILING);
  });

  it('ends an over-budget last row with the end-of-set notice', async () => {
    c.stub(rowsOf(4, (i) => (i === 3 ? 30_000 : 0)));
    const result = await c.run({ offset: 3 });
    expect(c.markers(result)).toEqual([3]);
    expect(enrichmentOf(result)).toMatchObject({ hasMore: false, nextOffset: null });
    expect(enrichmentOf(result).notice).toMatch(new RegExp(`^Showing ${c.unit} 4–4 of 4\\.`));
    expect(enrichmentOf(result).notice).not.toContain('budget');
  });

  it('walks every row exactly once whether pages end at the budget or at limit', async () => {
    // Heavy rows come in pairs three apart, one pair per twenty rows: a page reaching the second
    // of a pair fills the budget, a page holding one heavy row reaches limit first.
    c.stub(rowsOf(60, (i) => (i % 20 === 0 || i % 20 === 3 ? 11_000 : 150)));
    const seen: number[] = [];
    const endings = { budget: 0, limit: 0, end: 0 };
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await c.run({ offset, limit: 8 });
      const markers = c.markers(result);
      const enrichment = enrichmentOf(result);
      expect(markers.length).toBeGreaterThan(0);
      expect(enrichment.totalCount).toBe(60);
      expect(surfaces(result).json).toBeLessThanOrEqual(CEILING);
      expect(surfaces(result).text).toBeLessThanOrEqual(CEILING);
      const window = `Showing ${c.unit} ${offset + 1}–${offset + markers.length} of 60.`;
      if (!enrichment.hasMore) {
        endings.end++;
        expect(enrichment.notice).toMatch(new RegExp(`^${window}`));
      } else if (markers.length === 8) {
        endings.limit++;
        expect(enrichment.notice).toMatch(new RegExp(`^${window}`));
        expect(enrichment.notice).toMatch(
          new RegExp(`\\. Pass offset=${offset + 8} for the next page\\.$`),
        );
        expect(enrichment.notice).not.toContain('budget');
      } else {
        endings.budget++;
        expect(enrichment.notice).toContain('24,000-byte response budget');
      }
      seen.push(...markers);
      offset = enrichment.nextOffset;
    }
    expect(seen).toEqual(range(0, 60));
    expect(endings.budget).toBeGreaterThan(0);
    expect(endings.limit).toBeGreaterThan(0);
    expect(endings.end).toBe(1);
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

  it('accepts limit 500 and rejects limit 501', async () => {
    c.stub(rowsOf(3, () => 0));
    expect((await c.run({ limit: 500 })).isError).toBeFalsy();
    expect((await c.run({ limit: 501 })).isError).toBe(true);
  });

  it('rejects a filter value past the schema cap instead of echoing it over the budget', async () => {
    c.stub(rowsOf(5, () => 0));
    const result = await c.run(c.oversized);
    expect(result.isError).toBe(true);
    const size = surfaces(result);
    expect(size.json).toBeLessThanOrEqual(CEILING);
    expect(size.text).toBeLessThanOrEqual(CEILING);
  });

  it('holds the ceiling on the assembled result across row sizes', async () => {
    for (let textBytes = 0; textBytes <= 7000; textBytes += 211) {
      c.stub(rowsOf(300, (i) => textBytes + (i % 5) * 97));
      const result = await c.run({ limit: 500, ...c.longEcho });
      expect(result.isError).toBeFalsy();
      const size = surfaces(result);
      expect(size.json, `JSON at ${textBytes} B rows`).toBeLessThanOrEqual(CEILING);
      expect(size.text, `text at ${textBytes} B rows`).toBeLessThanOrEqual(CEILING);
      expect(c.markers(result).length).toBeGreaterThan(0);
    }
  });
});
