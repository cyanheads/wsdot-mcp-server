/**
 * @fileoverview Tests for the deterministic row comparator the paged traffic feeds sort with.
 * The property under test is totality: the sorted output must be a function of the row multiset
 * alone, so two upstream responses carrying the same rows in different orders sort identically.
 * @module tests/services/stable-order.test
 */

import { describe, expect, it } from 'vitest';
import { byIdThenContent } from '@/services/traffic/stable-order.js';

interface Row {
  id?: number;
  label?: string;
}

const byId = byIdThenContent<Row>((r) => r.id);
const sorted = (rows: Row[]) => rows.toSorted(byId).map((r) => r.label);

describe('byIdThenContent', () => {
  it('orders by the numeric id', () => {
    expect(
      sorted([
        { id: 3, label: 'c' },
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('sorts rows carrying no id last rather than dropping them', () => {
    expect(sorted([{ label: 'none' }, { id: 2, label: 'b' }, { id: 1, label: 'a' }])).toEqual([
      'a',
      'b',
      'none',
    ]);
  });

  it('is total across rows sharing an id — any input order sorts the same', () => {
    const rows: Row[] = [
      { id: 5, label: 'x' },
      { id: 5, label: 'y' },
      { id: 5, label: 'z' },
      { id: 1, label: 'a' },
    ];
    const expected = sorted(rows);
    expect(expected).toHaveLength(4);
    expect(sorted([...rows].reverse())).toEqual(expected);
    expect(sorted([rows[1], rows[3], rows[2], rows[0]] as Row[])).toEqual(expected);
  });

  it('is total across rows carrying no id at all', () => {
    const rows: Row[] = [{ label: 'p' }, { label: 'q' }, { label: 'r' }];
    const expected = sorted(rows);
    expect(sorted([...rows].reverse())).toEqual(expected);
  });

  it('leaves byte-identical rows interchangeable', () => {
    const rows: Row[] = [
      { id: 1, label: 'same' },
      { id: 1, label: 'same' },
    ];
    expect(byId(rows[0] as Row, rows[1] as Row)).toBe(0);
    expect(sorted(rows)).toEqual(['same', 'same']);
  });

  it('separates a missing id from a real one without arithmetic overflow', () => {
    expect(byId({ id: Number.MAX_SAFE_INTEGER - 1 }, {})).toBeLessThan(0);
    expect(byId({}, { id: 0 })).toBeGreaterThan(0);
  });
});
