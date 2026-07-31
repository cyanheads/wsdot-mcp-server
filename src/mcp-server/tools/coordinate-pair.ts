/**
 * @fileoverview Renders a latitude/longitude pair for `format()` without dropping a
 * one-sided value.
 * @module mcp-server/tools/coordinate-pair
 */

/**
 * Formats a coordinate pair for `content[]`.
 *
 * Latitude and longitude are independently optional in both upstream feeds, so a guard
 * requiring both drops a populated side from `content[]` while `structuredContent` still
 * carries it. Naming the absent side keeps the two surfaces equivalent.
 *
 * @param latitude - Latitude, or undefined when the feed omits it.
 * @param longitude - Longitude, or undefined when the feed omits it.
 * @returns The rendered pair, or undefined when neither side is present.
 */
export function coordinatePair(latitude?: number, longitude?: number): string | undefined {
  if (latitude == null && longitude == null) return;
  return `${latitude ?? 'latitude not reported'}, ${longitude ?? 'longitude not reported'}`;
}
