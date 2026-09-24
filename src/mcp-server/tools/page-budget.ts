/**
 * @fileoverview Per-surface byte budget for the paged traffic collection tools
 * (`wsdot_search_alerts`, `wsdot_search_cameras`, `wsdot_get_travel_times`,
 * `wsdot_get_toll_rates`). A page ends at `limit` or at the budget, whichever comes first, so
 * one call stays within a bounded share of a model's context however large `limit` is or however
 * long an upstream free-text field runs. Rows are rendered once here for both `format()` and the
 * charge, so the bytes counted are the bytes sent.
 * @module mcp-server/tools/page-budget
 */

/**
 * Ceiling on each surface of a page, in UTF-8 bytes: the serialized `structuredContent` and the
 * joined `content[]` text, enrichment included on both.
 */
export const PAGE_BYTE_BUDGET = 24_000;

/**
 * Bytes held back from the rows for what every page carries besides them: the output wrapper
 * (`{"alerts":[…]}`), the enrichment counters and notice in `structuredContent`, and the
 * `content[]` trailer that renders them with their labels. Caller-supplied filter values the
 * enrichment echoes back are charged per call instead: capped at {@link MAX_FILTER_LENGTH}
 * characters, one can still escape to about 1,200 JSON bytes (a control character serializes as a
 * six-byte `\u` escape), and a camera search echoes two, which a fixed reserve would take from
 * every page.
 */
export const PAGE_OVERHEAD_RESERVE_BYTES = 1_000;

/**
 * Longest value, in characters, a traffic tool's free-text filter accepts (`stateRoute`, `route`,
 * `titleContains`, `region`). Each filter is echoed back on both surfaces, so an unbounded one
 * would let the caller's own input push a response past the budget. The longest live value a
 * filter is matched against is a 73-character corridor name; camera titles run to 50.
 */
export const MAX_FILTER_LENGTH = 200;

/** Separates two rendered rows in `content[]`: one blank line. */
const ROW_SEPARATOR = '\n\n';

const utf8Bytes = (text: string) => Buffer.byteLength(text);

/**
 * The `content[]` text of a page: each row's block, separated by a blank line, ending in a
 * newline. `format()` renders through this so the text matches what {@link fitPageToBudget}
 * charged.
 */
export function renderPage<T>(rows: readonly T[], renderRow: (row: T) => string): string {
  return `${rows.map(renderRow).join(ROW_SEPARATOR)}\n`;
}

/**
 * The leading rows of `window` (a page already sliced to `limit`) that fit the budget. Each row
 * is charged at the larger of its JSON and its rendered block, plus a separator, so one running
 * total bounds both surfaces. The page stops before the row that would cross the budget and
 * always keeps the first row, so a row larger than the whole budget comes back alone rather than
 * blocking the walk.
 *
 * @param window - Rows from `offset` up to `limit`, in page order.
 * @param renderRow - The per-row renderer `format()` uses.
 * @param echoed - Caller-supplied values the page's enrichment repeats (e.g. `appliedFilters`).
 * @returns The rows to return; shorter than `window` exactly when the budget ended the page.
 */
export function fitPageToBudget<T>(
  window: readonly T[],
  renderRow: (row: T) => string,
  echoed?: unknown,
): T[] {
  let remaining =
    PAGE_BYTE_BUDGET -
    PAGE_OVERHEAD_RESERVE_BYTES -
    (echoed === undefined ? 0 : utf8Bytes(JSON.stringify(echoed)));
  for (const [index, row] of window.entries()) {
    remaining -=
      Math.max(utf8Bytes(JSON.stringify(row)), utf8Bytes(renderRow(row))) + ROW_SEPARATOR.length;
    if (remaining < 0) return window.slice(0, Math.max(index, 1));
  }
  return [...window];
}

/**
 * The continuation sentence of a page that has more rows after it. A page the budget ended says
 * so, so a caller reads a short page as a size cut rather than the end of the set.
 */
export function continuationNotice(nextOffset: number, budgetEnded: boolean): string {
  return budgetEnded
    ? `The ${PAGE_BYTE_BUDGET.toLocaleString('en-US')}-byte response budget ended this page before limit — pass offset=${nextOffset} for the next page.`
    : `Pass offset=${nextOffset} for the next page.`;
}
