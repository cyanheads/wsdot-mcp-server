/**
 * @fileoverview Tool to list all WSF ferry routes operating on a given date.
 * @module mcp-server/tools/definitions/get-ferry-routes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { FerryApiService, getFerryApiService } from '@/services/ferry/ferry-service.js';

export const getFerryRoutes = tool('wsdot_get_ferry_routes', {
  title: 'Get Ferry Routes',
  description:
    'Returns the main WSF ferry routes operating on a given date. ' +
    'Route IDs correspond to impactedRouteIds in ferry alerts from wsdot_get_ferry_alerts, though some ' +
    'alert route IDs (seasonal, San Juan interisland, or Sidney B.C.) may not appear in this list. ' +
    'To get terminal IDs for schedule and space lookups, use wsdot_get_ferry_terminals.',
  annotations: { readOnlyHint: true },
  input: z.object({
    tripDate: z
      .string()
      .optional()
      .describe(
        'Date for which to list routes, in ISO 8601 format (YYYY-MM-DD). ' +
          'Defaults to today if omitted.',
      ),
  }),
  output: z.object({
    routes: z
      .array(
        z
          .object({
            routeId: z
              .number()
              .optional()
              .describe(
                'Numeric route identifier. Corresponds to impactedRouteIds in ferry alerts.',
              ),
            routeAbbrev: z
              .string()
              .optional()
              .describe('Short route abbreviation (e.g. "SEA-BBI").'),
            description: z
              .string()
              .optional()
              .describe('Full route description (e.g. "Seattle/Bainbridge Island").'),
          })
          .describe('A WSF ferry route operating on the requested date.'),
      )
      .describe('Ferry routes operating on the requested date.'),
  }),

  enrichment: {
    tripDate: z.string().describe('Date for which routes were retrieved (ISO 8601).'),
    totalCount: z.number().describe('Total number of routes returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional notice when no routes are available for the date. Absent on normal results.',
      ),
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'WSF Ferry API is unreachable or returns a non-2xx response after retries.',
      retryable: true,
      recovery:
        'Retry in 30 seconds. If the issue persists, check wsdot.wa.gov/ferries for service status.',
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSF rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The provided tripDate is not a valid ISO 8601 date.',
      recovery: 'Provide a valid date in YYYY-MM-DD format, such as 2026-05-23.',
    },
  ],

  async handler(input, ctx) {
    let tripDate: string;
    try {
      tripDate = input.tripDate?.trim()
        ? FerryApiService.toFerryDate(input.tripDate.trim())
        : FerryApiService.todayFerryDate();
    } catch {
      throw ctx.fail(
        'invalid_date',
        `Invalid date: "${input.tripDate}". Expected YYYY-MM-DD format (e.g. 2026-05-23).`,
      );
    }

    const routes = await getFerryApiService().getRoutes(tripDate, ctx);
    ctx.log.info('Ferry routes fetched', { tripDate, count: routes.length });

    ctx.enrich({ tripDate, totalCount: routes.length });
    if (routes.length === 0) {
      ctx.enrich.notice(
        `No ferry routes found for ${tripDate}. The WSF API may be temporarily unavailable or no routes operate on this date — retry in 30 seconds.`,
      );
    }

    return { routes };
  },

  format: (result) => {
    if (result.routes.length === 0) {
      return [{ type: 'text', text: 'No ferry routes found for this date.' }];
    }
    const lines: string[] = [];
    for (const r of result.routes) {
      const name = r.description ?? r.routeAbbrev ?? 'Unknown route';
      lines.push(`### ${name}`);
      if (r.routeAbbrev != null) lines.push(`**Abbrev:** ${r.routeAbbrev}`);
      if (r.routeId != null) lines.push(`**Route ID:** ${r.routeId}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
