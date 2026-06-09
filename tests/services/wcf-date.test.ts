/**
 * @fileoverview Tests for the shared WCF date decoder: standard decode, the .NET DateTime.MinValue
 * sentinel, ISO/passthrough, null handling, and the wcfDateField spread helper.
 * @module tests/services/wcf-date.test
 */

import { describe, expect, it } from 'vitest';
import { decodeWcfDate, wcfDateField } from '@/services/wcf-date.js';

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
