/**
 * @fileoverview Tool to fetch named corridor travel times from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/get-travel-times.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

export const getTravelTimes = tool('wsdot_get_travel_times', {
  title: 'Get Travel Times',
  description:
    'Returns current vs. average travel times for named WA highway corridors (I-5, I-90, SR 520, SR 99, ' +
    'I-405, SR 167, etc.). Use for "how congested is I-5?" or commute time estimates. ' +
    'Filter by partial route name (e.g. "I-5", "SR 520") to narrow results. ' +
    'When current time exceeds average, the corridor is congested.',
  annotations: { readOnlyHint: true },
  input: z.object({
    route: z
      .string()
      .optional()
      .describe(
        'Optional text filter applied to corridor names (e.g. "I-5", "SR 520", "I-405"). ' +
          'Case-insensitive. Omit to return all corridors.',
      ),
  }),
  output: z.object({
    corridors: z
      .array(
        z
          .object({
            travelTimeId: z.number().optional().describe('Unique corridor identifier.'),
            name: z
              .string()
              .optional()
              .describe('Corridor name (e.g. "I-5: Northgate to Downtown").'),
            description: z.string().optional().describe('Additional corridor description.'),
            currentTimeInMinutes: z.number().optional().describe('Current travel time in minutes.'),
            averageTimeInMinutes: z
              .number()
              .optional()
              .describe('Historical average travel time in minutes.'),
            delayInMinutes: z
              .number()
              .optional()
              .describe('Delay above average in minutes. Positive means congestion.'),
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
          .describe('Travel time data for one highway corridor.'),
      )
      .describe('Travel time corridors matching the filter.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of corridors returned.'),
    routeFilter: z
      .string()
      .optional()
      .describe('The route name filter applied (lowercased), or absent if no filter was used.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when no corridors matched the route filter. Absent when results are returned.',
      ),
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
    const all = await getTrafficApiService().getTravelTimes(ctx);
    const routeFilter = input.route?.trim() ? input.route.trim().toLowerCase() : undefined;
    const filtered = routeFilter
      ? all.filter((t) => t.name?.toLowerCase().includes(routeFilter))
      : all;

    const corridors = filtered.map((t) => ({
      ...t,
      delayInMinutes:
        t.currentTimeInMinutes != null && t.averageTimeInMinutes != null
          ? t.currentTimeInMinutes - t.averageTimeInMinutes
          : undefined,
    }));

    ctx.log.info('Travel times fetched', { total: all.length, returned: corridors.length });

    ctx.enrich({ totalCount: corridors.length, ...(routeFilter && { routeFilter }) });
    if (corridors.length === 0) {
      ctx.enrich.notice(
        routeFilter
          ? `No corridors matched the route filter "${routeFilter}". Try a broader filter (e.g. "I-5" instead of "I-5 NB") or omit the filter to list all corridors.`
          : 'No travel time data available. The WSDOT API may be temporarily unavailable — retry in 30 seconds.',
      );
    }

    return { corridors };
  },

  format: (result) => {
    if (result.corridors.length === 0) {
      return [{ type: 'text', text: 'No corridors matched.' }];
    }
    const lines: string[] = [];
    for (const c of result.corridors) {
      lines.push(`### ${c.name ?? 'Corridor'}`);
      if (c.description) lines.push(c.description);
      if (c.currentTimeInMinutes != null) lines.push(`**Current:** ${c.currentTimeInMinutes} min`);
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
        if (sp) lines.push(`**From:** ${sp}`);
      }
      if (c.endPoint) {
        const ep = [
          c.endPoint.roadName,
          c.endPoint.direction,
          c.endPoint.milePost != null ? `MP ${c.endPoint.milePost}` : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        if (ep) lines.push(`**To:** ${ep}`);
      }
      if (c.timeUpdated) lines.push(`**Updated:** ${c.timeUpdated}`);
      if (c.travelTimeId != null) lines.push(`**ID:** ${c.travelTimeId}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
