/**
 * @fileoverview Deterministic row ordering for the paged traffic feeds. WSDOT serves some feeds
 * in more than one row order, and every page a caller requests is backed by a fresh upstream
 * fetch, so a page window taken in arrival order both skips and repeats rows as the caller walks
 * the offsets. Ordering a feed here before it is sliced makes a given offset reproducible.
 * @module services/traffic/stable-order
 */

/**
 * Builds a comparator that orders rows by a numeric id, rows without one last.
 *
 * The order is **total**: rows the id leaves tied — a repeated id, or two rows that both lack
 * one — fall back to their serialized content. Without that fallback a tie group keeps whatever
 * order upstream sent, and a page boundary landing inside the group reintroduces exactly the
 * skip-and-repeat the ordering exists to prevent. Rows whose content is identical compare equal,
 * which is harmless: either page carries the same record.
 *
 * @param idOf - Reads the row's numeric identifier, or `undefined` when the feed omitted it.
 */
export function byIdThenContent<T>(idOf: (row: T) => number | undefined) {
  return (a: T, b: T): number => {
    const byId = (idOf(a) ?? Number.MAX_SAFE_INTEGER) - (idOf(b) ?? Number.MAX_SAFE_INTEGER);
    if (byId !== 0) return byId;
    const keyA = JSON.stringify(a);
    const keyB = JSON.stringify(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  };
}
