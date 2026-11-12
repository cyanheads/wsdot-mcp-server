/**
 * @fileoverview Tool to fetch named corridor travel times from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/get-travel-times.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  clampPageLimit,
  MAX_FILTER_LENGTH,
  type PageLimitSpec,
  pageLimitSchema,
  renderPage,
  slicePage,
  withClampNotice,
  withContinuation,
} from '@/mcp-server/tools/paging.js';
import {
  designationsIn,
  isRouteDesignation,
  routeMatches,
} from '@/services/traffic/route-match.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const CorridorSchema = z
  .object({
    travelTimeId: z.number().optional().describe('Unique corridor identifier.'),
    name: z.string().optional().describe('Corridor name (e.g. "I-5: Northgate to Downtown").'),
    description: z.string().optional().describe('Additional corridor description.'),
    currentTimeInMinutes: z
      .number()
      .optional()
      .describe(
        'Current travel time in minutes. Absent when WSDOT reports no measurement for the corridor — a reversible express lane closed in this direction reports none.',
      ),
    averageTimeInMinutes: z
      .number()
      .optional()
      .describe(
        'Historical average travel time in minutes. Absent when WSDOT reports no measurement for the corridor.',
      ),
    delayInMinutes: z
      .number()
      .optional()
      .describe(
        'Delay above average in minutes. Positive means congestion. Absent when either travel time is unavailable.',
      ),
    timeUpdated: z
      .string()
      .optional()
      .describe('When the travel time data was last updated (ISO 8601).'),
    distanceInMiles: z.number().optional().describe('Corridor distance in miles.'),
    startPoint: z
      .object({
        roadName: z.string().optional().describe('Road name at the start.'),
        direction: z
          .string()
          .optional()
          .describe('Travel direction code: N (north), S (south), E (east), W (west).'),
        milePost: z.number().optional().describe('Starting milepost.'),
      })
      .optional()
      .describe('Start of the measured corridor.'),
    endPoint: z
      .object({
        roadName: z.string().optional().describe('Road name at the end.'),
        direction: z
          .string()
          .optional()
          .describe('Travel direction code: N (north), S (south), E (east), W (west).'),
        milePost: z.number().optional().describe('Ending milepost.'),
      })
      .optional()
      .describe('End of the measured corridor.'),
  })
  .describe('Travel time data for one highway corridor.');

type Corridor = z.infer<typeof CorridorSchema>;

const LIMIT: PageLimitSpec = {
  tool: 'wsdot_get_travel_times',
  unit: 'corridors',
  defaultLimit: 50,
  maxLimit: 500,
};

export const getTravelTimes = tool('wsdot_get_travel_times', {
  title: 'Get Travel Times',
  description: `Returns current vs. average travel times for named WA highway corridors (I-5, I-405, I-90, SR 520, SR 167, and around Vancouver I-205 and SR 14). Use for "how congested is I-5?" or commute time estimates. A route designation filter ("I-5", "5", "SR 520") returns every corridor that starts or ends on that route or writes it in its name ("via 520"), never digits inside another number. Any other filter text matches corridor names ("Everett"), and the first number in it, read as a route, also matches every corridor that starts or ends on that route, in both directions — "I-405 southbound" returns northbound I-405 corridors too, since the direction word is not applied. When current time exceeds average, the corridor is congested. Results are paged — pass offset/limit to page through the full set.`,
  annotations: { readOnlyHint: true },
  input: z.object({
    route: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'Optional filter. A route designation — an optional route type (I, SR, US) and the route number, such as "I-5", "5", "005", "SR 520", or "520" — matches every corridor whose start or end point is on that route, whichever form the feed reports, or whose name writes the route ("I-5", "SR14", "via 520"). It never matches digits inside another number: "5" does not match I-405 or SR 522. Any other text matches the corridor name as a case-insensitive substring, so "Everett" finds the Seattle-Everett corridors and "1A" the 1A segments. The first number in such text, read as a route with any route type written just before it, also matches every corridor whose start or end point is on that route, in both directions — "I-405 southbound" returns northbound I-405 corridors too, since the direction word is not applied. Omit to return all corridors.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based index of the first corridor to return, for paging. Defaults to 0.'),
    limit: pageLimitSchema(LIMIT),
  }),
  output: z.object({
    corridors: z.array(CorridorSchema).describe('Travel time corridors matching the filter.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total corridors matching the filter across all pages (not just this page).'),
    nextOffset: z
      .number()
      .nullable()
      .describe('Offset to pass to retrieve the next page, or null when this is the last page.'),
    hasMore: z.boolean().describe('True when more corridors remain beyond the current page.'),
    routeFilter: z
      .string()
      .optional()
      .describe('The route name filter applied (lowercased), or absent if no filter was used.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational note about the page window, or guidance when no corridors matched the route filter or the offset ran past the end. Ends with the applied limit when a larger one was clamped.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'WSDOT Traffic API is unreachable or returns a non-2xx response after retries.',
      retryable: true,
      recovery:
        'Retry in 30 seconds. If the issue persists, check wsdot.wa.gov for service status.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSDOT rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const all = await getTrafficApiService().getTravelTimes(ctx);
    const routeFilter = input.route?.trim() ? input.route.trim().toLowerCase() : undefined;
    const designation = routeFilter !== undefined && isRouteDesignation(routeFilter);
    // Two match paths. The filter against the corridor's start/end road names — where the route
    // actually lives, since most corridor names are endpoint pairs ("Seattle-Everett"). And the
    // corridor name: a designation against the routes the name writes ("via 520", "I-84JCT"), so
    // "5" never matches the digits of "405" or "SR 522"; any other text as a substring.
    const namesRoute = (name: string, filter: string) =>
      designation
        ? designationsIn(name).some((written) => routeMatches(filter, written))
        : name.toLowerCase().includes(filter);
    const filtered = routeFilter
      ? all.filter(
          (t) =>
            (t.name != null && namesRoute(t.name, routeFilter)) ||
            [t.startPoint?.roadName, t.endPoint?.roadName].some(
              (roadName) => roadName != null && routeMatches(routeFilter, roadName),
            ),
        )
      : all;

    // Page the full filtered set so structuredContent and content[] carry the identical
    // page (the service stays filter-only; paging is a tool-handler concern). totalCount
    // stays the full match count so the agent knows how much lies beyond this page.
    const totalCount = filtered.length;
    const offset = input.offset ?? 0;
    const page = clampPageLimit(LIMIT, input.limit, ctx);
    const { rows, hasMore, nextOffset } = slicePage(filtered, offset, page.limit);
    const corridors: Corridor[] = rows.map((t) => ({
      ...t,
      delayInMinutes:
        t.currentTimeInMinutes != null && t.averageTimeInMinutes != null
          ? t.currentTimeInMinutes - t.averageTimeInMinutes
          : undefined,
    }));

    ctx.log.info('Travel times fetched', {
      total: all.length,
      totalCount,
      offset,
      limit: page.limit,
      returned: corridors.length,
    });

    ctx.enrich({ totalCount, nextOffset, hasMore, ...(routeFilter && { routeFilter }) });

    if (totalCount === 0) {
      ctx.enrich.notice(
        withClampNotice(
          designation
            ? `No corridor starts or ends on route "${routeFilter}" or names it. Omit the filter to list all corridors.`
            : routeFilter
              ? `No corridors matched the route filter "${routeFilter}". Broaden the filter, or omit it to list all corridors.`
              : 'No travel time data available. The WSDOT API may be temporarily unavailable — retry in 30 seconds.',
          page,
        ),
      );
    } else if (corridors.length === 0) {
      ctx.enrich.notice(
        withClampNotice(
          `Offset ${offset} is past the end of ${totalCount} matching corridors. Use an offset between 0 and ${totalCount - 1}.`,
          page,
        ),
      );
    } else {
      const shown = `Showing corridors ${offset + 1}–${offset + corridors.length} of ${totalCount}.`;
      ctx.enrich.notice(withClampNotice(withContinuation(shown, nextOffset), page));
    }

    return { corridors };
  },

  format: (result) => {
    if (result.corridors.length === 0) {
      return [{ type: 'text', text: 'No corridors matched.' }];
    }
    return [{ type: 'text', text: renderPage(result.corridors, renderCorridor) }];
  },
});

/** One corridor's `content[]` block, as `format()` renders it. */
function renderCorridor(c: Corridor): string {
  const lines = [`### ${escapeMarkdownInline(c.name ?? 'Corridor')}`];
  if (c.description) lines.push(escapeMarkdownInline(c.description));
  lines.push(
    c.currentTimeInMinutes != null
      ? `**Current:** ${c.currentTimeInMinutes} min`
      : '**Current:** Not available — WSDOT reports no measurement for this corridor',
  );
  if (c.averageTimeInMinutes != null) lines.push(`**Average:** ${c.averageTimeInMinutes} min`);
  if (c.delayInMinutes != null) {
    const sign = c.delayInMinutes > 0 ? '+' : '';
    lines.push(
      `**Delay:** ${sign}${c.delayInMinutes} min${c.delayInMinutes > 0 ? ' (congested)' : ''}`,
    );
  }
  if (c.distanceInMiles != null) lines.push(`**Distance:** ${c.distanceInMiles} mi`);
  if (c.startPoint) {
    const sp = [
      c.startPoint.roadName,
      c.startPoint.direction,
      c.startPoint.milePost != null ? `MP ${c.startPoint.milePost}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (sp) lines.push(`**From:** ${escapeMarkdownInline(sp)}`);
  }
  if (c.endPoint) {
    const ep = [
      c.endPoint.roadName,
      c.endPoint.direction,
      c.endPoint.milePost != null ? `MP ${c.endPoint.milePost}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (ep) lines.push(`**To:** ${escapeMarkdownInline(ep)}`);
  }
  if (c.timeUpdated) lines.push(`**Updated:** ${escapeMarkdownInline(c.timeUpdated)}`);
  if (c.travelTimeId != null) lines.push(`**ID:** ${c.travelTimeId}`);
  return lines.join('\n');
}
