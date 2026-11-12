/**
 * @fileoverview Shared decoder for WCF JSON date strings (`/Date(ms±offset)/`) emitted by
 * the WSDOT Traffic and WSF Ferry APIs. Centralizes ISO 8601 conversion, the
 * .NET `DateTime.MinValue` sentinel, and the Pacific wall-clock form of a decoded instant,
 * so every mapper handles upstream dates identically.
 * @module services/wcf-date
 */

import { nonBlank } from '@/services/text-field.js';

/** Decoded dates before this year are treated as the .NET `DateTime.MinValue` "no timestamp" sentinel. */
const MIN_VALID_YEAR = 1900;

/**
 * Pacific wall-clock parts of an instant from the `America/Los_Angeles` zone rules, so the result
 * never depends on the process `TZ` (the production image runs in UTC). `h23` renders midnight as 00.
 */
const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'longOffset',
});

/**
 * An ISO 8601 date-time that carries its own zone designator, seconds and fraction optional. A
 * zoneless value would be read in the process time zone, so it is not taken as an instant.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?<seconds>:\d{2}(?<fraction>\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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

/**
 * The Pacific wall-clock parts of an instant, keyed by `Intl` part type: `year`, `month`, `day`,
 * `hour` (00–23), `minute`, `second`, and `timeZoneName` (`GMT-08:00`).
 */
export function pacificParts(ms: number): Record<string, string> {
  return Object.fromEntries(PACIFIC.formatToParts(ms).map((p) => [p.type, p.value]));
}

/**
 * The Pacific wall-clock form of an ISO 8601 instant, with its UTC offset and the precision the
 * input carries: `2026-11-05T13:30:00.000Z` → `2026-11-05T05:30:00.000-08:00`. The offset follows
 * the zone's DST rules for that instant. `undefined` when the value is not an ISO 8601 date-time
 * with a zone designator, or names no real instant.
 */
export function toPacificTime(iso: string): string | undefined {
  const match = ISO_INSTANT.exec(iso);
  const ms = match ? Date.parse(iso) : Number.NaN;
  if (!match || Number.isNaN(ms)) return;
  const at = pacificParts(ms);
  const { seconds, fraction = '' } = match.groups ?? {};
  const clock =
    seconds === undefined
      ? `${at.hour}:${at.minute}`
      : `${at.hour}:${at.minute}:${at.second}${fraction}`;
  // longOffset renders as "GMT-08:00"; the offset is what follows the prefix.
  return `${at.year}-${at.month}-${at.day}T${clock}${at.timeZoneName?.slice(3)}`;
}

/**
 * {@link wcfDateField} with the Pacific wall-clock sibling beside it:
 * `{ [key]: utc, [`${key}Local`]: pacific }`. Both are omitted when the value is absent, blank, or
 * the MinValue sentinel; the sibling alone is omitted when the decoded value is not an instant
 * ({@link toPacificTime}), such as an unrecognized upstream shape passed through as-is.
 *
 * @example
 * return { ...wcfDateFieldWithLocal('departureTime', s.DepartingTime) };
 */
export function wcfDateFieldWithLocal<K extends string>(
  key: K,
  raw: string | null | undefined,
): Partial<Record<K | `${K}Local`, string>> {
  const utc = decodeWcfDate(raw);
  if (utc == null) return {};
  const local = toPacificTime(utc);
  return { [key]: utc, ...(local != null && { [`${key}Local`]: local }) } as Partial<
    Record<K | `${K}Local`, string>
  >;
}
