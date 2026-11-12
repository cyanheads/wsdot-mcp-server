/**
 * @fileoverview Tests for the shared WCF date decoder: standard decode, the .NET DateTime.MinValue
 * sentinel, ISO/passthrough, null handling, the wcfDateField spread helper, and the Pacific
 * wall-clock form (toPacificTime, wcfDateFieldWithLocal) across both DST transitions and
 * under process time zones other than Pacific.
 * @module tests/services/wcf-date.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeWcfDate,
  toPacificTime,
  wcfDateField,
  wcfDateFieldWithLocal,
} from '@/services/wcf-date.js';

describe('decodeWcfDate', () => {
  it('decodes a WCF date with a timezone offset to ISO 8601 UTC', () => {
    expect(decodeWcfDate('/Date(1700000000000-0800)/')).toBe('2023-11-14T22:13:20.000Z');
  });

  it('decodes a WCF date without an offset', () => {
    expect(decodeWcfDate('/Date(1700000000000)/')).toBe('2023-11-14T22:13:20.000Z');
  });

  it('returns undefined for the .NET DateTime.MinValue sentinel (year 0001)', () => {
    expect(decodeWcfDate('/Date(-62135568000000-0800)/')).toBeUndefined();
  });

  it('returns undefined for null or undefined input', () => {
    expect(decodeWcfDate(null)).toBeUndefined();
    expect(decodeWcfDate(undefined)).toBeUndefined();
  });

  it('passes through a value that is not WCF-shaped (already ISO)', () => {
    expect(decodeWcfDate('2026-05-23T10:00:00.000Z')).toBe('2026-05-23T10:00:00.000Z');
  });

  it.each(['', '   ', '\t\n'])('returns undefined for the blank value %j', (blank) => {
    expect(decodeWcfDate(blank)).toBeUndefined();
  });

  it('decodes a WCF date that arrives with surrounding whitespace', () => {
    expect(decodeWcfDate(' /Date(1700000000000-0800)/ ')).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('wcfDateField', () => {
  it('returns a single-key object for a valid WCF date', () => {
    expect(wcfDateField('dateUpdated', '/Date(1700000000000-0800)/')).toEqual({
      dateUpdated: '2023-11-14T22:13:20.000Z',
    });
  });

  it('returns an empty object for null input (field omitted)', () => {
    expect(wcfDateField('dateUpdated', null)).toEqual({});
  });

  it('returns an empty object for a blank date (field omitted)', () => {
    expect(wcfDateField('dateUpdated', '')).toEqual({});
    expect(wcfDateField('dateUpdated', '  ')).toEqual({});
  });

  it('returns an empty object for the MinValue sentinel (field omitted)', () => {
    expect(wcfDateField('dateUpdated', '/Date(-62135568000000-0800)/')).toEqual({});
  });

  it('spreads cleanly into an object literal, omitting absent dates', () => {
    const obj = {
      id: 1,
      ...wcfDateField('updatedAt', null),
      ...wcfDateField('createdAt', '/Date(1700000000000)/'),
    };
    expect(obj).toEqual({ id: 1, createdAt: '2023-11-14T22:13:20.000Z' });
  });
});

/**
 * UTC instant → Pacific wall clock. The first four rows straddle both transitions in WSF's current
 * schedule window: PDT→PST at 2026-11-01 02:00 PDT (09:00Z), when 01:00–01:59 occurs twice, and
 * PST→PDT at 2027-03-14 02:00 PST (10:00Z), when 02:00–02:59 never occurs.
 */
const PACIFIC_TABLE = [
  ['2026-11-01T08:59:00.000Z', '2026-11-01T01:59:00.000-07:00'],
  ['2026-11-01T09:00:00.000Z', '2026-11-01T01:00:00.000-08:00'],
  ['2027-03-14T09:59:00.000Z', '2027-03-14T01:59:00.000-08:00'],
  ['2027-03-14T10:00:00.000Z', '2027-03-14T03:00:00.000-07:00'],
  // A morning sailing in standard time.
  ['2026-11-05T13:30:00.000Z', '2026-11-05T05:30:00.000-08:00'],
  // Midnight renders as 00, never 24.
  ['2026-07-01T07:00:00.000Z', '2026-07-01T00:00:00.000-07:00'],
  // Milliseconds are kept, as an alert's publishDate carries them.
  ['2026-11-12T11:03:41.917Z', '2026-11-12T03:03:41.917-08:00'],
  // The local date rolls back across a year boundary.
  ['2026-01-01T07:59:59.999Z', '2025-12-31T23:59:59.999-08:00'],
] as const;

describe('toPacificTime', () => {
  it.each(PACIFIC_TABLE)('renders %s as %s', (utc, local) => {
    expect(toPacificTime(utc)).toBe(local);
  });

  describe.each([
    // The production image runs with no TZ set, which resolves to UTC.
    ['UTC', 9],
    ['Asia/Tokyo', 18],
  ])('with the process time zone set to %s', (zone, hourAtFallBack) => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.TZ;
      process.env.TZ = zone;
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    it.each(PACIFIC_TABLE)('still renders %s as %s', (utc, local) => {
      // The zone change took effect: local-time getters now read the process zone, not Pacific.
      expect(new Date('2026-11-01T09:00:00.000Z').getHours()).toBe(hourAtFallBack);
      expect(toPacificTime(utc)).toBe(local);
    });
  });

  it.each([
    // An instant already carrying an offset, at second precision.
    ['2026-11-05T05:30:00-08:00', '2026-11-05T05:30:00-08:00'],
    ['2026-07-04T12:00:00+09:00', '2026-07-03T20:00:00-07:00'],
    // Minute precision: no seconds are invented.
    ['2026-11-05T13:30Z', '2026-11-05T05:30-08:00'],
    // A fraction keeps its own digits.
    ['2026-11-05T13:30:00.5Z', '2026-11-05T05:30:00.5-08:00'],
  ])('keeps the precision of a passed-through instant: %s → %s', (utc, local) => {
    expect(toPacificTime(utc)).toBe(local);
  });

  it.each([
    // Zoneless: Date.parse would read it in the process time zone.
    '2026-11-05T13:30:00',
    '2026-11-05',
    '6:00 AM',
    'Nov 5 2026 13:30 GMT',
    // ISO-shaped, but no real instant.
    '2026-13-01T00:00:00Z',
    '',
  ])('returns undefined for %j, which is not an instant', (value) => {
    expect(toPacificTime(value)).toBeUndefined();
  });
});

describe('wcfDateFieldWithLocal', () => {
  it('returns the UTC value and its Pacific sibling, in that order', () => {
    const field = wcfDateFieldWithLocal('departureTime', '/Date(1790344200000-0700)/');
    expect(field).toEqual({
      departureTime: '2026-09-25T13:50:00.000Z',
      departureTimeLocal: '2026-09-25T06:50:00.000-07:00',
    });
    expect(Object.keys(field)).toEqual(['departureTime', 'departureTimeLocal']);
  });

  it.each([
    ['null', null],
    ['blank', '  '],
    ['the MinValue sentinel', '/Date(-62135568000000-0800)/'],
  ])('omits both fields for %s', (_label, raw) => {
    expect(wcfDateFieldWithLocal('departureTime', raw)).toEqual({});
  });

  it('gives a passed-through value that is not an instant no sibling', () => {
    expect(wcfDateFieldWithLocal('departureTime', '6:00 AM')).toEqual({ departureTime: '6:00 AM' });
  });
});
