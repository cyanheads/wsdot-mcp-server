/**
 * @fileoverview Tests for route-designation matching — the shared comparison behind the
 * `stateRoute` filters on alerts and cameras and the `route` filter on travel times.
 * @module tests/services/route-match.test
 */

import { describe, expect, it } from 'vitest';

import { routeMatches } from '@/services/traffic/route-match.js';

describe('routeMatches', () => {
  it('resolves natural, zero-padded, and bare forms of the same route', () => {
    expect(routeMatches('I-90', '090')).toBe(true);
    expect(routeMatches('90', 'I-90')).toBe(true);
    expect(routeMatches('SR 520', '520')).toBe(true);
    expect(routeMatches('sr520', 'SR 520')).toBe(true);
    expect(routeMatches('I-5', '005')).toBe(true);
    expect(routeMatches('US 2', '002')).toBe(true);
  });

  it('keeps routes whose digits are substrings distinct (90 vs 290)', () => {
    expect(routeMatches('90', 'SR 290')).toBe(false);
    expect(routeMatches('SR 290', 'SR 290')).toBe(true);
  });

  it('compares the route-type prefix when both sides carry one (SR 26 is not US 26)', () => {
    expect(routeMatches('SR 26', 'US 26')).toBe(false);
    expect(routeMatches('SR 26', 'SR 26')).toBe(true);
    expect(routeMatches('US 26', 'US 26')).toBe(true);
    // Oregon routes ride in the same camera feed under their own prefix.
    expect(routeMatches('SR 217', 'ORE217')).toBe(false);
  });

  it('treats a lettered suffix as part of the route (US 97 is not US 97A)', () => {
    expect(routeMatches('US 97', 'US 97A')).toBe(false);
    expect(routeMatches('US 97A', 'US 97A')).toBe(true);
    expect(routeMatches('97', 'US 97A')).toBe(false);
  });

  it('falls back to the route number when either side is bare', () => {
    // Alert road names are always bare, and the travel-times feed reports both forms for the
    // same corridor — a prefixed filter has to match them.
    expect(routeMatches('I-5', '005')).toBe(true);
    expect(routeMatches('SR 26', '026')).toBe(true);
    expect(routeMatches('26', 'US 26')).toBe(true);
    expect(routeMatches('26', 'SR 26')).toBe(true);
    expect(routeMatches('217', 'ORE217')).toBe(true);
  });

  it('ignores leading text that is not a route type', () => {
    expect(routeMatches('highway 2', 'US 2')).toBe(true);
    expect(routeMatches('US 395 NSC', 'US 395')).toBe(true);
    // A route type has to be its own word — the "us" ending "bus" is not one.
    expect(routeMatches('bus 5', 'SR 5')).toBe(true);
  });

  it('resolves a long non-route filter without scanning it quadratically', () => {
    // The filter reaches this matcher once per record in a feed of thousands, so a designation
    // that is all leading text must not cost more than a linear pass over it.
    const filter = 'a'.repeat(50_000);
    const started = performance.now();
    expect(routeMatches(filter, 'I-5')).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('matches unnumbered designations only against themselves', () => {
    expect(routeMatches('Ferries', 'Ferries')).toBe(true);
    expect(routeMatches('Ferries', 'I-5')).toBe(false);
    expect(routeMatches('I-5', 'Airports')).toBe(false);
  });

  it('is symmetric', () => {
    const pairs: Array<[string, string]> = [
      ['SR 26', 'US 26'],
      ['I-5', '005'],
      ['US 97', 'US 97A'],
      ['90', 'SR 290'],
    ];
    for (const [a, b] of pairs) {
      expect(routeMatches(a, b)).toBe(routeMatches(b, a));
    }
  });
});
