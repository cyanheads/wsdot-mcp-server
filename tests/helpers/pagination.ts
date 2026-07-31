/**
 * @fileoverview Shared assertions for the offset/limit paging contract the row-collection
 * tools implement. The contract is identical across tools — full-set `totalCount`, a sliced
 * page, `nextOffset`/`hasMore` continuation metadata, a past-the-end notice, and bounded
 * inputs — so the assertions live here once and each tool supplies only what differs: how to
 * stub its service, how to build a distinguishable row, and how to read the page back out.
 * @module tests/helpers/pagination
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { formattedText } from './assertions.js';

/**
 * The slice of a tool definition these assertions exercise. `format` is typed structurally
 * rather than against the SDK's `ContentBlock` so this helper adds no direct dependency on a
 * package the server only carries transitively, and stays optional so a `ToolDefinition`
 * satisfies it — the parity case checks for it instead. `TCtx` is whatever context the tool's
 * own handler declares, which carries a contract-bound `fail` when the tool declares `errors[]`.
 */
interface PageableTool<TInput, TOutput, TCtx> {
  format?: ((result: TOutput) => readonly { type: string }[]) | undefined;
  handler: (input: TInput, ctx: TCtx) => Promise<TOutput> | TOutput;
  input: { parse: (value: unknown) => TInput };
  name: string;
}

export interface PaginationContractOptions<TInput, TOutput, TCtx> {
  /** Input fields merged into every call (a filter the paging must be applied after). */
  baseInput?: Record<string, unknown>;
  /** Creates a mock context; the caller owns the import so its mocks stay file-local. */
  createContext: () => TCtx;
  /** The tool's DEFAULT_LIMIT. */
  defaultLimit: number;
  /** Total rows to stub — must exceed `defaultLimit` so the default-page case actually pages. */
  fixtureSize: number;
  /** Builds `count` rows; row `i` carries marker `i` in whatever field identifies it. */
  makeRows: (count: number) => unknown[];
  /** A string that appears in `format()` output for row `i` and for no other row. */
  markerText: (index: number) => string;
  /** The tool's MAX_LIMIT. */
  maxLimit: number;
  /** Reads back the marker of every row on the returned page, in order. */
  pageMarkers: (result: TOutput) => number[];
  /** Stubs the tool's service call to resolve the given rows. */
  stubRows: (rows: unknown[]) => void;
  /** Tool definition under test. */
  tool: PageableTool<TInput, TOutput, TCtx>;
  /** Noun for the paged unit as it reads in the tool's notices ("alerts", "terminals"). */
  unit: string;
}

/**
 * Registers the paging-contract suite for one tool. Every case stubs a fixture larger than the
 * tool's default page, so no assertion can pass vacuously over a set that never needed paging.
 */
export function describePaginationContract<TInput, TOutput, TCtx extends Context>(
  options: PaginationContractOptions<TInput, TOutput, TCtx>,
): void {
  const {
    tool,
    createContext,
    stubRows,
    makeRows,
    pageMarkers,
    markerText,
    fixtureSize,
    defaultLimit,
    maxLimit,
    unit,
    baseInput = {},
  } = options;

  if (fixtureSize <= defaultLimit) {
    throw new Error(
      `${tool.name} paging fixture (${fixtureSize}) must exceed its default limit (${defaultLimit}) or the page assertions are vacuous.`,
    );
  }

  const format = tool.format;
  if (!format) {
    throw new Error(`${tool.name} declares no format(), so the content[] parity case cannot run.`);
  }

  const parse = (input: Record<string, unknown>) => tool.input.parse({ ...baseInput, ...input });
  const run = async (input: Record<string, unknown>) => {
    stubRows(makeRows(fixtureSize));
    const ctx = createContext();
    const result = await tool.handler(parse(input), ctx);
    return { enrichment: getEnrichment(ctx), result, page: pageMarkers(result) };
  };

  describe(`${tool.name} — offset/limit paging`, () => {
    it(`applies the default limit of ${defaultLimit} and reports the full count`, async () => {
      const { enrichment, page } = await run({});
      expect(page).toEqual(Array.from({ length: defaultLimit }, (_, i) => i));
      expect(enrichment.totalCount).toBe(fixtureSize);
      expect(enrichment.hasMore).toBe(true);
      expect(enrichment.nextOffset).toBe(defaultLimit);
      expect(enrichment.notice).toContain(`offset=${defaultLimit}`);
    });

    it('returns the requested page and keeps totalCount at the full count', async () => {
      const { enrichment, page } = await run({ offset: 2, limit: 3 });
      expect(page).toEqual([2, 3, 4]);
      expect(enrichment.totalCount).toBe(fixtureSize);
      expect(enrichment.nextOffset).toBe(5);
      expect(enrichment.hasMore).toBe(true);
      expect(enrichment.notice).toContain(`3–5 of ${fixtureSize}`);
    });

    it('walks every row exactly once across consecutive pages', async () => {
      const seen: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const { enrichment, page } = await run({ offset, limit: 3 });
        seen.push(...page);
        offset = enrichment.nextOffset as number | null;
      }
      expect(seen).toEqual(Array.from({ length: fixtureSize }, (_, i) => i));
    });

    it('reports hasMore false and a null nextOffset on the final page', async () => {
      const { enrichment, page } = await run({ offset: fixtureSize - 2, limit: 10 });
      expect(page).toEqual([fixtureSize - 2, fixtureSize - 1]);
      expect(enrichment.hasMore).toBe(false);
      expect(enrichment.nextOffset).toBeNull();
      expect(enrichment.notice).not.toContain('next page');
    });

    it('returns an empty page with actionable guidance when the offset is past the end', async () => {
      const pastEnd = fixtureSize + 10;
      const { enrichment, page } = await run({ offset: pastEnd, limit: 5 });
      expect(page).toEqual([]);
      expect(enrichment.totalCount).toBe(fixtureSize);
      expect(enrichment.hasMore).toBe(false);
      expect(enrichment.nextOffset).toBeNull();
      expect(enrichment.notice).toContain(`Offset ${pastEnd} is past the end of ${fixtureSize}`);
      expect(enrichment.notice).toContain(unit);
      expect(enrichment.notice).toContain(`0 and ${fixtureSize - 1}`);
    });

    it('renders exactly the structuredContent page in content[] (parity)', async () => {
      const { result, page } = await run({ offset: 1, limit: 3 });
      expect(page).toEqual([1, 2, 3]);
      const text = formattedText(format(result));
      for (const marker of page) expect(text).toContain(markerText(marker));
      expect(text).not.toContain(markerText(0));
      expect(text).not.toContain(markerText(fixtureSize - 1));
      expect(text.match(/^### /gm)?.length).toBe(3);
    });

    it(`rejects a limit above ${maxLimit}, a zero limit, and a non-integer or negative offset`, () => {
      expect(() => parse({ limit: maxLimit + 1 })).toThrow();
      expect(() => parse({ limit: 0 })).toThrow();
      expect(() => parse({ offset: -1 })).toThrow();
      expect(() => parse({ offset: 1.5 })).toThrow();
    });
  });
}
