/**
 * @fileoverview Route-designation matching for WSDOT road names — compares a caller's route
 * filter against the `roadName` values the traffic feeds carry.
 * @module services/traffic/route-match
 */

/** A parsed route designation. */
interface ParsedRoute {
  /** Route number, leading zeros stripped, any suffix letter retained: "5", "90", "97a". */
  number: string;
  /** Canonical route-type prefix ("i", "sr", "us", "ore"), absent when the designation is bare. */
  prefix?: string;
}

/** The route number: any leading zeros, the digits, and a single suffix letter. */
const ROUTE_NUMBER = /0*(\d+)([a-z]?)/;

/**
 * A route type sitting immediately before the number, separated only by spaces or hyphens —
 * the prefixes the WSDOT feeds use, plus `ore` for the Oregon routes in the Portland-area camera
 * feed. The leading `[^a-z]` keeps it to a whole word, so the "us" ending "bus" is not a route
 * type. Any other text in front of the number (a corridor nickname, a word such as "highway")
 * leaves the designation bare, which matches on the number alone rather than dropping the record.
 *
 * Both patterns are written to run in linear time on any input: neither can backtrack across a
 * long run of leading text, so a pathological filter cannot stall the per-record match loop.
 */
const ROUTE_PREFIX = /(?:^|[^a-z])(i|sr|us|ore)[\s-]*$/;

function parseRoute(route: string): ParsedRoute | undefined {
  const text = route.trim().toLowerCase();
  const number = ROUTE_NUMBER.exec(text);
  if (!number) return;
  const [, digits = '', suffix = ''] = number;
  const [, prefix] = ROUTE_PREFIX.exec(text.slice(0, number.index)) ?? [];
  return {
    ...(prefix != null && { prefix }),
    number: `${digits}${suffix}`,
  };
}

/**
 * Reports whether two route designations name the same highway. Natural forms ("I-90", "SR 520",
 * "US 2"), zero-padded ("090") and bare ("90") numbers all resolve to the same route number, so a
 * filter matches whichever form the feed happens to carry — the travel-times feed reports both
 * `005` and `I-5` for the same corridor, and alert road names are always bare.
 *
 * The route-type prefix is compared only when *both* designations carry one, so "SR 26" does not
 * match "US 26" while a bare "26" still matches either. A suffix letter is part of the number,
 * keeping "US 97" and "US 97A" distinct. Designations with no number (the camera feed's "Ferries",
 * "Airports") compare as plain strings, so they match themselves and nothing numbered.
 */
export function routeMatches(a: string, b: string): boolean {
  const left = parseRoute(a);
  const right = parseRoute(b);
  if (!left || !right) return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (left.number !== right.number) return false;
  return left.prefix === undefined || right.prefix === undefined || left.prefix === right.prefix;
}
