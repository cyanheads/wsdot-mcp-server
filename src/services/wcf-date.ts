/**
 * @fileoverview Shared decoder for WCF JSON date strings (`/Date(ms±offset)/`) emitted by
 * the WSDOT Traffic and WSF Ferry APIs. Centralizes ISO 8601 conversion and the
 * .NET `DateTime.MinValue` sentinel so every mapper handles upstream dates identically.
 * @module services/wcf-date
 */

import { nonBlank } from '@/services/text-field.js';

/** Decoded dates before this year are treated as the .NET `DateTime.MinValue` "no timestamp" sentinel. */
const MIN_VALID_YEAR = 1900;

/**
 * Decode a WCF JSON date string (`/Date(ms±offset)/`) to an ISO 8601 UTC string.
 *
 * - `null` / `undefined`, or a blank or whitespace-only string → `undefined` (the {@link nonBlank}
 *   rule every upstream string follows); a populated value is trimmed before decoding.
 * - A value that doesn't match the WCF pattern is returned as-is (already ISO, or unknown shape).
 * - `.NET DateTime.MinValue` (year 0001, e.g. `/Date(-62135568000000-0800)/`) is WSDOT's
 *   "no timestamp" sentinel and decodes to `undefined`, so callers omit the field rather than
 *   surfacing a year-0001 date.
 */
export function decodeWcfDate(raw: string | null | undefined): string | undefined {
  const value = nonBlank(raw);
  if (value == null) return;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < MIN_VALID_YEAR) return;
  return date.toISOString();
}

/**
 * Spread-ready ISO date field. Decodes a WCF date and returns `{ [key]: iso }`, or `{}` when the
 * value is absent, blank, or the MinValue sentinel — so the field is omitted from the normalized
 * object.
 *
 * @example
 * return { ...wcfDateField('dateUpdated', p.DateUpdated) };
 */
export function wcfDateField<K extends string>(
  key: K,
  raw: string | null | undefined,
): Record<K, string> | Record<string, never> {
  const iso = decodeWcfDate(raw);
  return iso == null ? {} : ({ [key]: iso } as Record<K, string>);
}
