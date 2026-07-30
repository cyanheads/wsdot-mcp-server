/**
 * @fileoverview Tool to search WA highway alerts, incidents, and construction notices.
 * @module mcp-server/tools/definitions/search-alerts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

export const searchAlerts = tool('wsdot_search_alerts', {
  title: 'Search Highway Alerts',
  description:
    'Returns active WA highway alerts: incidents, construction, closures, and restrictions. ' +
    'Filter by state route ("I-90", "90", "SR 520", or "520" all work), ' +
    'WSDOT region (Northwest, Olympic, Southwest, South Central, North Central, Eastern), ' +
    'or milepost range. Omit all filters to return all current statewide alerts.',
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .optional()
      .describe(
        'State route to filter by. Accepts natural forms — "I-90", "90", "090", "SR 520", "520" — matched case- and space-insensitively to the canonical WSDOT route number. Omit to include all routes.',
      ),
    region: z
      .string()
      .optional()
      .describe(
        'WSDOT region name as it appears in alert data: "Northwest", "Olympic", "Southwest", "South Central", "North Central", or "Eastern". Matching is case-insensitive.',
      ),
    startMilepost: z.number().optional().describe('Start of milepost range to filter alerts.'),
    endMilepost: z.number().optional().describe('End of milepost range to filter alerts.'),
  }),
  output: z.object({
    alerts: z
      .array(
        z
          .object({
            alertId: z.number().optional().describe('Unique alert identifier.'),
            headlineDescription: z.string().optional().describe('Short summary of the alert.'),
            extendedDescription: z.string().optional().describe('Full description of the alert.'),
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
    totalCount: z.number().describe('Total number of alerts returned.'),
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
        'Optional guidance when no alerts matched — suggests broadening or removing filters. Absent when results are returned.',
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
    const alerts = await getTrafficApiService().searchAlerts(
      {
        ...(stateRoute && { stateRoute }),
        ...(region && { region }),
        ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
        ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      },
      ctx,
    );
    ctx.log.info('Alerts fetched', { count: alerts.length });

    const appliedFilters = {
      ...(stateRoute && { stateRoute }),
      ...(region && { region }),
      ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
      ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
    };

    ctx.enrich({ totalCount: alerts.length, appliedFilters });
    if (alerts.length === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        hasFilters
          ? 'No alerts matched the applied filters. Try removing the stateRoute, region, or milepost filters to broaden results.'
          : 'No active highway alerts statewide at this time.',
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
      lines.push(`### ${a.headlineDescription ?? 'Alert'}${id}`);
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
        if (loc.latitude != null && loc.longitude != null) {
          lines.push(`**Coords:** ${loc.latitude}, ${loc.longitude}`);
        }
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
        if (end.latitude != null && end.longitude != null) {
          lines.push(`**End Coords:** ${end.latitude}, ${end.longitude}`);
        }
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
