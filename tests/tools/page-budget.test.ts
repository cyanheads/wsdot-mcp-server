/**
 * @fileoverview Tests for the per-surface page budget the traffic collection tools share: the
 * pinned ceiling, how rows are charged and admitted, the page text `format()` renders, and the
 * continuation sentence.
 * @module tests/tools/page-budget.test
 */

import { describe, expect, it } from 'vitest';
import {
  continuationNotice,
  fitPageToBudget,
  PAGE_BYTE_BUDGET,
  PAGE_OVERHEAD_RESERVE_BYTES,
  renderPage,
} from '@/mcp-server/tools/page-budget.js';

/** Bytes the rows of a page may use: the budget less the fixed overhead reserve. */
const ROW_BYTES = PAGE_BYTE_BUDGET - PAGE_OVERHEAD_RESERVE_BYTES;

/** A row whose JSON is exactly `bytes` long: `{"t":"…"}` carries 8 bytes of wrapper. */
const jsonRow = (bytes: number) => ({ t: 'x'.repeat(bytes - 8) });
const renderShort = () => '#';

describe('page budget', () => {
  it('pins the per-surface ceiling at 24,000 bytes', () => {
    expect(PAGE_BYTE_BUDGET).toBe(24_000);
  });

  it('returns an empty page for an empty window', () => {
    expect(fitPageToBudget([], renderShort)).toEqual([]);
  });

  it('admits every row when the window fits', () => {
    const rows = [jsonRow(100), jsonRow(100), jsonRow(100)];
    expect(fitPageToBudget(rows, renderShort)).toEqual(rows);
  });

  it('stops before the row that would cross the budget, each row charged with its separator', () => {
    // Two rows of (ROW_BYTES / 2 - 2) bytes plus a 2-byte separator each fill the budget exactly.
    const half = ROW_BYTES / 2 - 2;
    const rows = [jsonRow(half), jsonRow(half), jsonRow(10)];
    expect(fitPageToBudget(rows, renderShort)).toHaveLength(2);
    expect(fitPageToBudget([jsonRow(half), jsonRow(half + 1)], renderShort)).toHaveLength(1);
  });

  it('keeps a first row larger than the whole budget, alone', () => {
    const rows = [jsonRow(PAGE_BYTE_BUDGET * 2), jsonRow(10)];
    expect(fitPageToBudget(rows, renderShort)).toEqual([rows[0]]);
  });

  it('charges a row at its rendered text when that outweighs its JSON', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const renderHeavy = () => 'x'.repeat(ROW_BYTES / 2);
    expect(fitPageToBudget(rows, renderHeavy)).toHaveLength(1);
  });

  it('counts UTF-8 bytes, not string length', () => {
    // "é" is one UTF-16 unit but two UTF-8 bytes, so the second row no longer fits.
    const rows = [{ t: 'é'.repeat(ROW_BYTES / 4) }, { t: 'é'.repeat(ROW_BYTES / 4) }];
    expect(fitPageToBudget(rows, renderShort)).toHaveLength(1);
  });

  it('charges the echoed caller input against the rows', () => {
    const rows = [jsonRow(ROW_BYTES / 2 - 2), jsonRow(ROW_BYTES / 2 - 2)];
    expect(fitPageToBudget(rows, renderShort)).toHaveLength(2);
    expect(fitPageToBudget(rows, renderShort, { stateRoute: 'SR 520' })).toHaveLength(1);
  });

  it('renders rows as blank-line separated blocks ending in one newline', () => {
    expect(renderPage(['a', 'b', 'c'], (row) => `### ${row}\nbody`)).toBe(
      '### a\nbody\n\n### b\nbody\n\n### c\nbody\n',
    );
  });

  it('words the continuation by what ended the page', () => {
    expect(continuationNotice(40, false)).toBe('Pass offset=40 for the next page.');
    expect(continuationNotice(12, true)).toBe(
      'The 24,000-byte response budget ended this page before limit — pass offset=12 for the next page.',
    );
  });
});
