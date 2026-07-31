/**
 * @fileoverview Tool to search WA highway alerts, incidents, and construction notices.
 * @module mcp-server/tools/definitions/search-alerts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { coordinatePair } from '@/mcp-server/tools/coordinate-pair.js';
import { byIdThenContent } from '@/services/traffic/stable-order.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const searchAlerts = tool('wsdot_search_alerts', {
  title: 'Search Highway Alerts',
  description:
    'Returns active WA highway alerts: incidents, construction, closures, and restrictions. ' +
    'Filter by state route ("I-90", "90", "SR 520", or "520" all work), ' +
    'WSDOT region (Northwest, Olympic, Southwest, South Central, North Central, Eastern), ' +
    "or milepost range, matched against the alert's full extent. " +
    'Omit all filters to return all current statewide alerts. ' +
    'Results are ordered by alertId and paged — pass offset/limit to page through the full set ' +
    '(the notice reports the next offset).',
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .optional()
      .describe(
        'State route to filter by. Accepts natural forms — "I-90", "90", "090", "SR 520", "520" — matched case- and space-insensitively to the route number. A route-type prefix is compared only when both sides carry one, so "SR 26" never matches US 26 while a bare "26" matches either. Omit to include all routes.',
      ),
    region: z
      .string()
      .optional()
      .describe(
        'WSDOT region name as it appears in alert data: "Northwest", "Olympic", "Southwest", "South Central", "North Central", or "Eastern". Matching is case-insensitive.',
      ),
    startMilepost: z
      .number()
      .optional()
      .describe(
        'Start of the milepost range. An alert matches when its extent overlaps the range, so a closure running from MP 10 to MP 30 is returned for a range starting at MP 20. Either bound may be given alone. Alerts reporting no milepost are always included.',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Maximum alerts to return in this page (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      ),
  }),
  output: z.object({
    alerts: z
      .array(
        z
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
            endTime: z
              .string()
              .optional()
              .describe('When the event is expected to end (ISO 8601).'),
            lastUpdatedTime: z
              .string()
              .optional()
              .describe('When this alert was last updated (ISO 8601).'),
          })
          .describe('A highway alert or incident.'),
      )
      .describe('Matching highway alerts.'),
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
        'Informational note about the page window, or guidance when no alerts matched the filters or the offset ran past the end.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const parts: string[] = [];
        if (filters.stateRoute) parts.push(`- **Route:** ${filters.stateRoute}`);
        if (filters.region) parts.push(`- **Region:** ${filters.region}`);
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
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSDOT rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
    },
  ],

  async handler(input, ctx) {
    const stateRoute = input.stateRoute?.trim() || undefined;
    const region = input.region?.trim() || undefined;
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
    const limit = input.limit ?? DEFAULT_LIMIT;
    const alerts = matched.slice(offset, offset + limit);
    const hasMore = offset + alerts.length < totalCount;
    const nextOffset = hasMore ? offset + alerts.length : null;

    ctx.log.info('Alerts fetched', { totalCount, offset, limit, returned: alerts.length });

    ctx.enrich({ totalCount, appliedFilters, nextOffset, hasMore });

    if (totalCount === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        hasFilters
          ? 'No alerts matched the applied filters. Try removing the stateRoute, region, or milepost filters to broaden results.'
          : 'No active highway alerts statewide at this time.',
      );
    } else if (alerts.length === 0) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of ${totalCount} matching alerts. Use an offset between 0 and ${totalCount - 1}.`,
      );
    } else {
      const window = `Showing alerts ${offset + 1}–${offset + alerts.length} of ${totalCount}.`;
      ctx.enrich.notice(
        hasMore ? `${window} Pass offset=${nextOffset} for the next page.` : window,
      );
    }

    return { alerts };
  },

  format: (result) => {
    if (result.alerts.length === 0) {
      return [{ type: 'text', text: 'No active alerts found.' }];
    }
    const lines: string[] = [];
    for (const a of result.alerts) {
      const id = a.alertId != null ? ` #${a.alertId}` : '';
      // A headline can run to several paragraphs; only its first line belongs in the heading,
      // otherwise the trailing alert ID lands at the end of the last paragraph.
      const [heading, ...restOfHeadline] = (a.headlineDescription ?? '').split('\n');
      lines.push(`### ${heading || 'Alert'}${id}`);
      if (restOfHeadline.length > 0) lines.push(restOfHeadline.join('\n'));
      if (a.eventCategory) lines.push(`**Category:** ${a.eventCategory}`);
      if (a.eventStatus) lines.push(`**Status:** ${a.eventStatus}`);
      if (a.priority) lines.push(`**Priority:** ${a.priority}`);
      if (a.region) lines.push(`**Region:** ${a.region}`);
      if (a.county) lines.push(`**County:** ${a.county}`);
      if (a.startRoadwayLocation) {
        const loc = a.startRoadwayLocation;
        const parts = [
          loc.roadName,
          loc.direction,
          loc.milePost != null ? `MP ${loc.milePost}` : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        if (parts) lines.push(`**Location:** ${parts}`);
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
        if (endParts) lines.push(`**End Location:** ${endParts}`);
        const endCoords = coordinatePair(end.latitude, end.longitude);
        if (endCoords) lines.push(`**End Coords:** ${endCoords}`);
      }
      if (a.extendedDescription) lines.push(a.extendedDescription);
      if (a.startTime) lines.push(`**Start:** ${a.startTime}`);
      if (a.endTime) lines.push(`**End:** ${a.endTime}`);
      if (a.lastUpdatedTime) lines.push(`**Updated:** ${a.lastUpdatedTime}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
