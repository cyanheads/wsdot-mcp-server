/**
 * @fileoverview Renders a ferry time for `format()` as its Pacific wall-clock form followed by the
 * UTC instant it was derived from.
 * @module mcp-server/tools/local-time
 */

/**
 * Formats a UTC time and its `…Local` sibling for `content[]`: `<local> (<utc>)`, local first, so
 * the clock time a caller quotes leads. Without a sibling — the value was not an instant — the UTC
 * value renders alone.
 */
export function localThenUtc(utc: string, local?: string): string {
  return local ? `${local} (${utc})` : utc;
}
