/**
 * @fileoverview The one rule every optional upstream string follows at the service boundary: a
 * blank or whitespace-only value is absent, a populated one is kept with its ends trimmed. WSDOT and
 * WSF ship `""` where they have nothing to say (a pass's `WeatherCondition`, most alerts'
 * `ExtendedDescription`) and pad some names (`"Coupeville "`). Normalizing here keeps
 * `structuredContent` and `format()` — which gates on truthiness — carrying the same fields, and
 * matches how the tools treat a blank optional filter input.
 * @module services/text-field
 */

import { htmlToText } from '@/services/html-text.js';

/**
 * The upstream string with its ends trimmed, or `undefined` when it is absent, empty, or only
 * whitespace (JS `trim()` covers tabs, line breaks, and NBSP). Internal whitespace is kept.
 */
export function nonBlank(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * Spread-ready string field: `{ [key]: trimmed }`, or `{}` when the value is blank, so the field
 * is omitted from the normalized object.
 *
 * @example
 * return { ...textField('weatherCondition', p.WeatherCondition) };
 */
export function textField<K extends string>(
  key: K,
  raw: string | null | undefined,
): Record<K, string> | Record<string, never> {
  const text = nonBlank(raw);
  return text == null ? {} : ({ [key]: text } as Record<K, string>);
}

/**
 * {@link nonBlank} for a value authored in a rich-text editor: the markup is rendered to plain text
 * first, so a value that held only markup or entity whitespace (`<p></p>`, `&nbsp;`) is absent
 * along with a blank one. For list elements; a single field uses {@link htmlTextField}.
 */
export function nonBlankHtml(value: string | null | undefined): string | undefined {
  return nonBlank(value == null ? value : htmlToText(value));
}

/** {@link textField} for a field authored in a rich-text editor — see {@link nonBlankHtml}. */
export function htmlTextField<K extends string>(
  key: K,
  raw: string | null | undefined,
): Record<K, string> | Record<string, never> {
  return textField(key, nonBlankHtml(raw));
}
