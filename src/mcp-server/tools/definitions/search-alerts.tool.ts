/**
 * @fileoverview Tool to search WA highway alerts, incidents, and construction notices.
 * @module mcp-server/tools/definitions/search-alerts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { coordinatePair } from '@/mcp-server/tools/coordinate-pair.js';
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
import { byIdThenContent } from '@/services/traffic/stable-order.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const LIMIT: PageLimitSpec = {
  tool: 'wsdot_search_alerts',
  unit: 'alerts',
  defaultLimit: 20,
  maxLimit: 500,
};

/** The region names the alerts feed carries in `Region`. */
const REGIONS = ['Eastern', 'North Central', 'Northwest', 'Olympic', 'South Central', 'Southwest'];

const AlertSchema = z
  .object({
    alertId: z.number().optional().describe('Unique alert identifier.'),
    headlineDescription: z
      .string()
      .optional()
      .describe(
        'Short summary of the alert, as plain text. Upstream authors these in a rich-text editor, so any markup is normalized away and a link is rendered inline as "link text (url)".',
      ),
    extendedDescription: z
      .string()
      .optional()
      .describe(
        'Full description of the alert, normalized to plain text on the same terms as headlineDescription. Often absent — most alerts carry only a headline.',
      ),
    eventCategory: z
      .string()
      .optional()
      .describe('Category (e.g. "Incident", "Construction", "Closure").'),
    eventStatus: z.string().optional().describe('Current status of the event.'),
    priority: z.string().optional().describe('Priority level.'),
    region: z.string().optional().describe('WSDOT region where the alert is located.'),
    county: z.string().optional().describe('County where the alert is located.'),
    startRoadwayLocation: z
      .object({
        roadName: z.string().optional().describe('Road name.'),
        direction: z
          .string()
          .optional()
          .describe(
            'Travel direction code: N/S/E/W, B (both directions), A (alternating); may appear as NB/SB/EB/WB.',
          ),
        milePost: z.number().optional().describe('Starting milepost.'),
        latitude: z.number().optional().describe('Latitude.'),
        longitude: z.number().optional().describe('Longitude.'),
      })
      .optional()
      .describe('Start location of the alert.'),
    endRoadwayLocation: z
      .object({
        roadName: z.string().optional().describe('Road name.'),
        direction: z
          .string()
          .optional()
          .describe(
            'Travel direction code: N/S/E/W, B (both directions), A (alternating); may appear as NB/SB/EB/WB.',
          ),
        milePost: z.number().optional().describe('Ending milepost.'),
        latitude: z.number().optional().describe('Latitude.'),
        longitude: z.number().optional().describe('Longitude.'),
      })
      .optional()
      .describe('End location of the alert, if the event spans a range.'),
    startTime: z
      .string()
      .optional()
      .describe('When the event started or is scheduled to start (ISO 8601).'),
    endTime: z.string().optional().describe('When the event is expected to end (ISO 8601).'),
    lastUpdatedTime: z.string().optional().describe('When this alert was last updated (ISO 8601).'),
  })
  .describe('A highway alert or incident.');

export const searchAlerts = tool('wsdot_search_alerts', {
  title: 'Search Highway Alerts',
  description: `Returns active WA highway alerts: incidents, construction, closures, and restrictions. Filter by state route ("I-90", "90", "SR 520", or "520" all work), WSDOT region (Northwest, Olympic, Southwest, South Central, North Central, Eastern), or milepost range, matched against the alert's full extent. Omit all filters to return all current statewide alerts. Results are ordered by alertId and paged — pass offset/limit to page through the full set.`,
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'State route to filter by. Accepts natural forms — "I-90", "90", "090", "SR 520", "520" — matched case- and space-insensitively to the route number. A route-type prefix is compared only when both sides carry one, so "SR 26" never matches US 26 while a bare "26" matches either. Omit to include all routes.',
      ),
    region: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'WSDOT region name as it appears in alert data: "Northwest", "Olympic", "Southwest", "South Central", "North Central", or "Eastern". Matching is case-insensitive; any other value is rejected. These are names, not the two-letter codes wsdot_search_cameras takes.',
      ),
    startMilepost: z
      .number()
      .optional()
      .describe(
        'Start of the milepost range. An alert matches when its extent overlaps the range, so a closure running from MP 10 to MP 30 is returned for a range starting at MP 20. Either bound may be given alone; when both are given, startMilepost must not exceed endMilepost. Alerts reporting no milepost are always included.',
      ),
    endMilepost: z
      .number()
      .optional()
      .describe(
        'End of the milepost range. Matched by extent overlap like startMilepost, so an alert beginning inside the range and continuing past it is returned.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based index of the first alert to return, for paging. Defaults to 0.'),
    limit: pageLimitSchema(LIMIT),
  }),
  output: z.object({
    alerts: z.array(AlertSchema).describe('Matching highway alerts.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total alerts matching the filters across all pages (not just this page).'),
    nextOffset: z
      .number()
      .nullable()
      .describe('Offset to pass to retrieve the next page, or null when this is the last page.'),
    hasMore: z.boolean().describe('True when more alerts remain beyond the current page.'),
    appliedFilters: z
      .object({
        stateRoute: z.string().optional().describe('State route filter applied.'),
        region: z.string().optional().describe('Region filter applied.'),
        startMilepost: z.number().optional().describe('Start milepost filter applied.'),
        endMilepost: z.number().optional().describe('End milepost filter applied.'),
      })
      .describe('Active filters applied to the alert search.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational note about the page window, or guidance when no alerts matched the filters or the offset ran past the end. Ends with the applied limit when a larger one was clamped.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const parts: string[] = [];
        if (filters.stateRoute)
          parts.push(`- **Route:** ${escapeMarkdownInline(filters.stateRoute)}`);
        if (filters.region) parts.push(`- **Region:** ${escapeMarkdownInline(filters.region)}`);
        if (filters.startMilepost != null) parts.push(`- **Start MP:** ${filters.startMilepost}`);
        if (filters.endMilepost != null) parts.push(`- **End MP:** ${filters.endMilepost}`);
        return parts.length > 0
          ? `**Applied Filters:**\n${parts.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
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
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region is not one of the WSDOT region names the alerts feed carries.',
      recovery: `Pass one of the region names ${REGIONS.join(', ')} (case-insensitive), or omit region.`,
    },
    {
      reason: 'invalid_milepost_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'startMilepost is greater than endMilepost.',
      recovery:
        'Pass startMilepost less than or equal to endMilepost, or give only one bound for an open-ended range.',
    },
  ],

  async handler(input, ctx) {
    const stateRoute = input.stateRoute?.trim() || undefined;
    const region = input.region?.trim() || undefined;
    if (region && !REGIONS.some((r) => r.toLowerCase() === region.toLowerCase())) {
      throw ctx.fail(
        'invalid_region',
        `Unknown region "${region}" — wsdot_search_alerts takes a WSDOT region name.`,
      );
    }
    if (
      input.startMilepost != null &&
      input.endMilepost != null &&
      input.startMilepost > input.endMilepost
    ) {
      throw ctx.fail(
        'invalid_milepost_range',
        `startMilepost ${input.startMilepost} is greater than endMilepost ${input.endMilepost}.`,
      );
    }
    const fetched = await getTrafficApiService().searchAlerts(
      {
        ...(stateRoute && { stateRoute }),
        ...(region && { region }),
        ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
        ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      },
      ctx,
    );

    // The alerts feed serves one alert set in more than one row order, so a given offset is only
    // reproducible once the rows are ordered here. Alerts with no alertId sort last.
    const matched = fetched.toSorted(byIdThenContent((a) => a.alertId));

    const appliedFilters = {
      ...(stateRoute && { stateRoute }),
      ...(region && { region }),
      ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
      ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
    };

    // Page the full filtered set so structuredContent and content[] carry the identical
    // page (the service stays filter-only; paging is a tool-handler concern). totalCount
    // stays the full match count so the agent knows how much lies beyond this page.
    const totalCount = matched.length;
    const offset = input.offset ?? 0;
    const page = clampPageLimit(LIMIT, input.limit, ctx);
    const { rows: alerts, hasMore, nextOffset } = slicePage(matched, offset, page.limit);

    ctx.log.info('Alerts fetched', {
      totalCount,
      offset,
      limit: page.limit,
      returned: alerts.length,
    });

    ctx.enrich({ totalCount, appliedFilters, nextOffset, hasMore });

    if (totalCount === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        withClampNotice(
          hasFilters
            ? 'No alerts matched the applied filters. Try removing the stateRoute, region, or milepost filters to broaden results.'
            : 'No active highway alerts statewide at this time.',
          page,
        ),
      );
    } else if (alerts.length === 0) {
      ctx.enrich.notice(
        withClampNotice(
          `Offset ${offset} is past the end of ${totalCount} matching alerts. Use an offset between 0 and ${totalCount - 1}.`,
          page,
        ),
      );
    } else {
      const shown = `Showing alerts ${offset + 1}–${offset + alerts.length} of ${totalCount}.`;
      ctx.enrich.notice(withClampNotice(withContinuation(shown, nextOffset), page));
    }

    return { alerts };
  },

  format: (result) => {
    if (result.alerts.length === 0) {
      return [{ type: 'text', text: 'No active alerts found.' }];
    }
    return [{ type: 'text', text: renderPage(result.alerts, renderAlert) }];
  },
});

/** A line break in alert text: the feed writes CRLF, and a lone CR or LF reads the same. */
const LINE_BREAK = /\r\n|\r|\n/;

/** One alert's `content[]` block, as `format()` renders it. */
function renderAlert(a: z.infer<typeof AlertSchema>): string {
  const lines: string[] = [];
  const id = a.alertId != null ? ` #${a.alertId}` : '';
  // A headline can run to several paragraphs; only its first line belongs in the heading,
  // otherwise the trailing alert ID lands at the end of the last paragraph.
  const [heading = '', ...restOfHeadline] = (a.headlineDescription ?? '').trim().split(LINE_BREAK);
  lines.push(`### ${escapeMarkdownInline(heading.trim() || 'Alert')}${id}`);
  const body = plainTextLines(restOfHeadline);
  if (body) lines.push(body);
  if (a.eventCategory) lines.push(`**Category:** ${escapeMarkdownInline(a.eventCategory)}`);
  if (a.eventStatus) lines.push(`**Status:** ${escapeMarkdownInline(a.eventStatus)}`);
  if (a.priority) lines.push(`**Priority:** ${escapeMarkdownInline(a.priority)}`);
  if (a.region) lines.push(`**Region:** ${escapeMarkdownInline(a.region)}`);
  if (a.county) lines.push(`**County:** ${escapeMarkdownInline(a.county)}`);
  if (a.startRoadwayLocation) {
    const loc = a.startRoadwayLocation;
    const parts = [
      loc.roadName,
      loc.direction,
      loc.milePost != null ? `MP ${loc.milePost}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (parts) lines.push(`**Location:** ${escapeMarkdownInline(parts)}`);
    const coords = coordinatePair(loc.latitude, loc.longitude);
    if (coords) lines.push(`**Coords:** ${coords}`);
  }
  if (a.endRoadwayLocation) {
    const end = a.endRoadwayLocation;
    const endParts = [
      end.roadName,
      end.direction,
      end.milePost != null ? `MP ${end.milePost}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (endParts) lines.push(`**End Location:** ${escapeMarkdownInline(endParts)}`);
    const endCoords = coordinatePair(end.latitude, end.longitude);
    if (endCoords) lines.push(`**End Coords:** ${endCoords}`);
  }
  const description = plainTextLines((a.extendedDescription ?? '').split(LINE_BREAK));
  if (description) lines.push(description);
  if (a.startTime) lines.push(`**Start:** ${escapeMarkdownInline(a.startTime)}`);
  if (a.endTime) lines.push(`**End:** ${escapeMarkdownInline(a.endTime)}`);
  if (a.lastUpdatedTime) lines.push(`**Updated:** ${escapeMarkdownInline(a.lastUpdatedTime)}`);
  return lines.join('\n');
}

/**
 * Lines of upstream plain text — the headline after its heading, or the extended description — as
 * Markdown. Each line is trimmed and escaped on its own, and consecutive lines join as one
 * paragraph; a run of blank lines between text stays one paragraph break, and blank lines at
 * either end are dropped. Escaping the lines as one value would turn each break into a backslash
 * hard break, a blank line into a lone `\` line, and a line's edge spaces into `&#32;`.
 */
function plainTextLines(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines.map((l) => l.trim())) {
    if (line) out.push(escapeMarkdownInline(line));
    else if (out.length > 0 && out.at(-1) !== '') out.push('');
  }
  if (out.at(-1) === '') out.pop();
  return out.join('\n');
}
