/**
 * @fileoverview Tool to fetch current dynamic toll rates from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/get-toll-rates.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { coordinatePair } from '@/mcp-server/tools/coordinate-pair.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Washington's Interstate route numbers. The feed reports a bare, zero-padded route number with
 * no route type, so a blanket "SR" prefix mislabels I-405; every other number the feed carries
 * is a state route.
 */
const INTERSTATE_ROUTE_NUMBERS = new Set(['5', '82', '90', '182', '205', '405', '705']);

/** Turns an upstream route number ("099", "405") into its posted designation ("SR 99", "I-405"). */
function routeDesignation(stateRoute: string): string {
  const number = stateRoute.replace(/^0+(?=\d)/, '');
  return INTERSTATE_ROUTE_NUMBERS.has(number) ? `I-${number}` : `SR ${number}`;
}

export const getTollRates = tool('wsdot_get_toll_rates', {
  title: 'Get Toll Rates',
  description:
    'Returns current dynamic toll rates for WA express lanes and tolled facilities: SR 99 (WSDOT Tunnel), ' +
    'SR 167 HOT Lanes, I-405 Express Lanes, SR 509 tolled segment, and the SR 520 Bridge. ' +
    'Rates are time-banded and change dynamically based on traffic conditions. ' +
    'stateRoute is a bare, zero-padded route number ("099", "405") — the posted designation is in ' +
    'the rendered text. Results are paged — pass offset/limit to page through the full set ' +
    '(the notice reports the next offset).',
  annotations: { readOnlyHint: true },
  input: z.object({
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based index of the first toll rate to return, for paging. Defaults to 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Maximum toll rates to return in this page (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      ),
  }),
  output: z.object({
    rates: z
      .array(
        z
          .object({
            tripName: z.string().optional().describe('Name of the tolled trip or lane segment.'),
            stateRoute: z.string().optional().describe('State route number.'),
            travelDirection: z
              .string()
              .optional()
              .describe(
                'Travel direction code for this toll segment: N (north), S (south), E (east), W (west).',
              ),
            startMilepost: z.number().optional().describe('Starting milepost of the toll segment.'),
            endMilepost: z.number().optional().describe('Ending milepost of the toll segment.'),
            tollRateInDollars: z.number().optional().describe('Current toll rate in US dollars.'),
            message: z.string().optional().describe('Dynamic message associated with this toll.'),
            startLocationName: z
              .string()
              .optional()
              .describe('Human-readable start location name.'),
            endLocationName: z.string().optional().describe('Human-readable end location name.'),
            startLatitude: z.number().optional().describe('Latitude of the segment start point.'),
            startLongitude: z.number().optional().describe('Longitude of the segment start point.'),
            endLatitude: z.number().optional().describe('Latitude of the segment end point.'),
            endLongitude: z.number().optional().describe('Longitude of the segment end point.'),
            timeUpdated: z
              .string()
              .optional()
              .describe('When this toll rate was last updated (ISO 8601).'),
          })
          .describe('Current toll rate for one segment or trip.'),
      )
      .describe('Current toll rates for all active tolled facilities.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total toll rate entries across all pages (not just this page).'),
    nextOffset: z
      .number()
      .nullable()
      .describe('Offset to pass to retrieve the next page, or null when this is the last page.'),
    hasMore: z.boolean().describe('True when more toll rates remain beyond the current page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational note about the page window, or guidance when no toll rate data is available or the offset ran past the end.',
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
    const allRates = await getTrafficApiService().getTollRates(ctx);

    // Page the full set so structuredContent and content[] carry the identical page (the
    // service stays filter-only; paging is a tool-handler concern). totalCount stays the
    // full entry count so the agent knows how much lies beyond this page.
    const totalCount = allRates.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rates = allRates.slice(offset, offset + limit);
    const hasMore = offset + rates.length < totalCount;
    const nextOffset = hasMore ? offset + rates.length : null;

    ctx.log.info('Toll rates fetched', { totalCount, offset, limit, returned: rates.length });

    ctx.enrich({ totalCount, nextOffset, hasMore });

    if (totalCount === 0) {
      ctx.enrich.notice(
        'No toll rate data available. The WSDOT API may be temporarily unavailable — retry in 30 seconds.',
      );
    } else if (rates.length === 0) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of ${totalCount} toll rate entries. Use an offset between 0 and ${totalCount - 1}.`,
      );
    } else {
      const window = `Showing toll rates ${offset + 1}–${offset + rates.length} of ${totalCount}.`;
      ctx.enrich.notice(
        hasMore ? `${window} Pass offset=${nextOffset} for the next page.` : window,
      );
    }

    return { rates };
  },

  format: (result) => {
    if (result.rates.length === 0) {
      return [{ type: 'text', text: 'No toll rate data available.' }];
    }
    const lines: string[] = [];
    for (const r of result.rates) {
      // tripName is an opaque upstream key ("099tp03268"); the endpoint names read as a segment,
      // so they lead. A segment whose ends carry the same name collapses to one.
      const ends = [r.startLocationName, r.endLocationName].filter(Boolean);
      const segment = [...new Set(ends)].join(' → ');
      lines.push(`### ${segment || r.tripName || 'Toll segment'}`);
      if (r.tripName) lines.push(`**Trip:** ${r.tripName}`);
      if (r.stateRoute) lines.push(`**Route:** ${routeDesignation(r.stateRoute)}`);
      if (r.travelDirection) lines.push(`**Direction:** ${r.travelDirection}`);
      if (r.startLocationName) lines.push(`**From:** ${r.startLocationName}`);
      if (r.endLocationName) lines.push(`**To:** ${r.endLocationName}`);
      if (r.startMilepost != null) lines.push(`**Start MP:** ${r.startMilepost}`);
      if (r.endMilepost != null) lines.push(`**End MP:** ${r.endMilepost}`);
      if (r.tollRateInDollars != null) lines.push(`**Rate:** $${r.tollRateInDollars.toFixed(2)}`);
      if (r.message) lines.push(`**Message:** ${r.message}`);
      const startCoords = coordinatePair(r.startLatitude, r.startLongitude);
      if (startCoords) lines.push(`**Start Coords:** ${startCoords}`);
      const endCoords = coordinatePair(r.endLatitude, r.endLongitude);
      if (endCoords) lines.push(`**End Coords:** ${endCoords}`);
      if (r.timeUpdated) lines.push(`**Updated:** ${r.timeUpdated}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
