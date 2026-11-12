/**
 * @fileoverview Shared pieces of the paged list tools (`wsdot_search_alerts`,
 * `wsdot_search_cameras`, `wsdot_get_travel_times`, `wsdot_get_toll_rates`,
 * `wsdot_get_terminal_space`). A page holds exactly `limit` rows, fewer only at the end of the
 * matching set. A `limit` above the tool's maximum is clamped to it with a notice, or rejected
 * when WSDOT_CLAMP_LIMITS=false. Also here: slicing a page out of the matching set, the page text
 * `format()` renders, the continuation sentence, and the length cap on the traffic tools'
 * free-text filters.
 * @module mcp-server/tools/paging
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampLimitsEnabled } from '@/config/server-config.js';

/**
 * Longest value, in characters, a traffic tool's free-text filter accepts (`stateRoute`, `route`,
 * `titleContains`, `region`). The longest live value a filter is matched against is a
 * 73-character corridor name; camera titles run to 50.
 */
export const MAX_FILTER_LENGTH = 200;

/** Every `limit` clamped to its tool's maximum, attributed by tool name. */
const limitClamps = createCounter(
  'wsdot.limit.clamps',
  'Paged-tool limit values above the maximum, clamped to it',
  '{clamp}',
);

/**
 * The `content[]` text of a page: each row's block, separated by a blank line, ending in a
 * newline.
 */
export function renderPage<T>(rows: readonly T[], renderRow: (row: T) => string): string {
  return `${rows.map(renderRow).join('\n\n')}\n`;
}

/** The continuation sentence of a page that has more rows after it. */
export function continuationNotice(nextOffset: number): string {
  return `Pass offset=${nextOffset} for the next page.`;
}

/** A page's "showing" sentence, followed by the continuation sentence when rows remain. */
export function withContinuation(shown: string, nextOffset: number | null): string {
  return nextOffset === null ? shown : `${shown} ${continuationNotice(nextOffset)}`;
}

/** One page of a matching set. */
export interface PageSlice<T> {
  /** True when rows remain after this page. */
  hasMore: boolean;
  /** Offset of the next page, or null on the last. */
  nextOffset: number | null;
  /** The page's rows; empty when `offset` is past the end. */
  rows: T[];
}

/** Takes the page of `items` that starts at `offset` and holds at most `limit` rows. */
export function slicePage<T>(items: readonly T[], offset: number, limit: number): PageSlice<T> {
  const rows = items.slice(offset, offset + limit);
  const end = offset + rows.length;
  const hasMore = end < items.length;
  return { rows, hasMore, nextOffset: hasMore ? end : null };
}

/** How one paged tool sizes its pages. */
export interface PageLimitSpec {
  /** Rows a page holds when the caller passes no `limit`. */
  defaultLimit: number;
  /** Most rows one page holds. */
  maxLimit: number;
  /** Sentence the `limit` description ends with in both modes. */
  note?: string;
  /** Tool name, attributed on the clamp log line and counter. */
  tool: string;
  /** Plural noun for the paged unit, as the `limit` description names it ("alerts", "terminals"). */
  unit: string;
}

/**
 * A paged tool's `limit` input: a positive integer, optional. While clamping (WSDOT_CLAMP_LIMITS
 * unset or true) it advertises no `maximum`, and a larger value reaches the handler for
 * {@link clampPageLimit}. Under WSDOT_CLAMP_LIMITS=false it advertises `maximum` and rejects a
 * larger value with the message `.max()` gives. The flag is read on every check and every schema
 * emission, never at import: `tool()` emits each input schema when its module loads, which under
 * Node is before `.env` is loaded.
 */
export function pageLimitSchema(spec: PageLimitSpec) {
  const { defaultLimit, maxLimit, note, unit } = spec;
  const ending = note ? ` ${note}` : '';
  return z
    .number()
    .int()
    .min(1)
    .check((payload) => {
      if (payload.value > maxLimit && !clampLimitsEnabled()) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: maxLimit,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .optional()
    .meta({
      // `.int()` alone emits maximum 9007199254740991; undefined drops it from the emitted schema.
      get maximum() {
        return clampLimitsEnabled() ? undefined : maxLimit;
      },
      get description() {
        return clampLimitsEnabled()
          ? `Maximum ${unit} to return in this page. Defaults to ${defaultLimit}; a larger value returns at most ${maxLimit} and says so.${ending}`
          : `Maximum ${unit} to return in this page (1–${maxLimit}). Defaults to ${defaultLimit}.${ending}`;
      },
    });
}

/** The rows a page may hold, and how a clamp to them is disclosed. */
export interface PageLimit {
  /** Sentence disclosing that a larger `limit` was clamped; absent when none was. */
  clampNotice?: string;
  /** The caller's `limit`, its default, or the maximum a larger one was clamped to. */
  limit: number;
}

/**
 * Resolves a page's `limit`: the default when absent, the maximum when larger. A clamp writes one
 * log line and one counter increment. Under WSDOT_CLAMP_LIMITS=false the schema has already
 * rejected a larger value, so no clamp happens here.
 */
export function clampPageLimit(
  spec: PageLimitSpec,
  requested: number | undefined,
  ctx: Context,
): PageLimit {
  const limit = requested ?? spec.defaultLimit;
  if (limit <= spec.maxLimit) return { limit };
  ctx.log.info('Clamped limit', { tool: spec.tool, requested: limit, applied: spec.maxLimit });
  limitClamps.add(1, { [ATTR_MCP_TOOL_NAME]: spec.tool });
  return {
    limit: spec.maxLimit,
    clampNotice: `limit ${limit} exceeds the maximum of ${spec.maxLimit}; using limit ${spec.maxLimit}.`,
  };
}

/** A page's notice, followed by the clamp sentence when its `limit` was clamped. */
export function withClampNotice(notice: string, page: PageLimit): string {
  return page.clampNotice ? `${notice} ${page.clampNotice}` : notice;
}
