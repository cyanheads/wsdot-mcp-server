/**
 * @fileoverview Tests for route-designation matching — the shared comparison behind the
 * `stateRoute` filters on alerts, cameras, and toll rates and the `route` filter on travel times —
 * and for reading designations out of a filter or a corridor name.
 * @module tests/services/route-match.test
 */

import { describe, expect, it } from 'vitest';

import {
  designationsIn,
  isRouteDesignation,
  routeMatches,
} from '@/services/traffic/route-match.js';
import { expectSubQuadratic } from '../helpers/timing.js';

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

describe('isRouteDesignation', () => {
  it.each([
    '5',
    '005',
    'I5',
    'I-5',
    'i 5',
    'I - 5',
    'SR 520',
    'sr-520',
    'us-26',
    'US26',
    'ORE 217',
    ' I-90 ',
  ])('reads %j as a designation: an optional route type, then digits only', (text) => {
    expect(isRouteDesignation(text)).toBe(true);
  });

  it.each([
    // A trailing letter keeps the text free: the travel-times segment labels run 1A through 6A.
    '1A',
    '5A',
    'US 97A',
    'I-5 NB',
    'Everett',
    'highway 2',
    'via 90',
    '5 5',
    'SR',
    '',
    '   ',
  ])('reads %j as free text', (text) => {
    expect(isRouteDesignation(text)).toBe(false);
  });
});

describe('designationsIn', () => {
  it.each([
    // Names from the live travel-times feed.
    ['Woodinville-Seattle via 90', ['90']],
    ['Woodinville-Seattle via 522 and 5 EL', ['522']],
    ['Bellevue-SR 522 HOV', ['sr-522']],
    ['3A JBLM Main Gate-Lakewood SR512 (NB)', ['sr-512']],
    ['SR14 and 171st Ave to I-205 and I-84 JCT', ['sr-14', 'i-205', 'i-84']],
    ['I-5 SB and 159th to I-84JCT', ['i-5', 'i-84']],
    ['020 SR14 and Cascade Pk to I-205 to I-5 and I-84 JCT', ['sr-14', 'i-205', 'i-5', 'i-84']],
    ['Hazel Dell to I-405-US26', ['i-405', 'us-26']],
    ['I-405-US 26 to Hazel Dell', ['i-405', 'us-26']],
    ['Tualatin OR to Salmon Creek WA - via I-205', ['i-205']],
    ['1A Lacey-Olympia (SB)', []],
    ['Seattle-Everett', []],
    ['Federal Way-SeaTac HOV', []],
  ] as const)('reads %j as %j', (name, expected) => {
    expect(designationsIn(name)).toEqual(expected);
  });

  it('takes a route type or "via" only as a whole word', () => {
    // "us" ending "bus", "i" ending "taxi", and "via" ending "previa" are not route words.
    expect(designationsIn('Bus 5 to Taxi 7 and Previa 9')).toEqual([]);
    expect(designationsIn('ORE217 to SR-500')).toEqual(['ore-217', 'sr-500']);
  });

  it('finds no designation where a type or "via" carries no number', () => {
    expect(designationsIn('via the I-way to SR Main')).toEqual([]);
  });

  it('reads every designation named against routeMatches', () => {
    // How the travel-times filter uses it: a filter matches a name that writes its route.
    const name = 'Seattle-Redmond via 520 to I-405';
    expect(designationsIn(name).some((d) => routeMatches('SR 520', d))).toBe(true);
    expect(designationsIn(name).some((d) => routeMatches('405', d))).toBe(true);
    expect(designationsIn(name).some((d) => routeMatches('5', d))).toBe(false);
    expect(designationsIn(name).some((d) => routeMatches('20', d))).toBe(false);
  });
});

describe('route reading stays linear on long upstream text', () => {
  /**
   * Corridor names and feed road names are upstream text with no length cap. Each shape doubles
   * from 5,000 to 320,000 characters; none crosses the size where Bun's regex engine changes
   * strategy, so every shape carries the full 64× span.
   */
  const designationShapes: [string, (chars: number) => string][] = [
    ['a route type repeated with no number', (n) => 'i-'.repeat(n / 2)],
    ['one route type before a long separator run', (n) => `i${'-'.repeat(n)}`],
    ['"via" before a long space run', (n) => `via${' '.repeat(n)}`],
    ['"via" repeated with no number', (n) => 'via '.repeat(n / 4)],
    ['overlapping route-type words', (n) => 'sr - us '.repeat(n / 8)],
    ['one long line ending in a break', (n) => `${'x'.repeat(n)}\ny`],
    ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['a designation in every word', (n) => 'I-5 '.repeat(n / 4)],
  ];

  for (const [label, build] of designationShapes) {
    it(`designationsIn: ${label}`, () => expectSubQuadratic(build, designationsIn), 0);
  }

  it('routeMatches: a long road name that is all leading text', () => {
    expect(routeMatches('a'.repeat(50_000), 'I-5')).toBe(false);
    expectSubQuadratic(
      (n) => 'a'.repeat(n),
      (text) => routeMatches('I-5', text),
    );
  }, 0);
});
