/**
 * @fileoverview Tool to fetch active WSF ferry service alerts and disruptions.
 * @module mcp-server/tools/definitions/get-ferry-alerts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFerryApiService } from '@/services/ferry/ferry-service.js';

export const getFerryAlerts = tool('wsdot_get_ferry_alerts', {
  title: 'Get Ferry Alerts',
  description:
    'Returns active WSF ferry service disruptions, delays, and bulletins. ' +
    'Each alert includes impacted route IDs — cross-reference with wsdot_get_ferry_routes ' +
    'to resolve route IDs to human-readable route names. Some IDs (seasonal, San Juan interisland, ' +
    'or international Sidney B.C. routes) may not appear in wsdot_get_ferry_routes for a given date.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    alerts: z
      .array(
        z
          .object({
            alertId: z.number().optional().describe('Unique alert identifier.'),
            alertDescription: z
              .string()
              .optional()
              .describe('Description of the alert or disruption.'),
            impactedRouteIds: z
              .array(z.number())
              .describe(
                'Route IDs affected by this alert. Cross-reference with wsdot_get_ferry_routes to get route names; ' +
                  'some seasonal or interisland route IDs may not be listed there for a given date.',
              ),
            publishDate: z.string().optional().describe('When the alert was published (ISO 8601).'),
          })
          .describe('A WSF ferry service alert or disruption.'),
      )
      .describe('Active ferry service alerts and disruptions.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of active alerts.'),
    notice: z
      .string()
      .optional()
      .describe('Optional notice when no alerts are active. Absent when alerts are present.'),
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
  ],

  async handler(_input, ctx) {
    const alerts = await getFerryApiService().getAlerts(ctx);
    ctx.log.info('Ferry alerts fetched', { count: alerts.length });

    ctx.enrich({ totalCount: alerts.length });
    if (alerts.length === 0) {
      ctx.enrich.notice('No active ferry service alerts at this time.');
    }

    return { alerts };
  },

  format: (result) => {
    if (result.alerts.length === 0) {
      return [{ type: 'text', text: 'No active ferry alerts.' }];
    }
    const lines: string[] = [];
    for (const a of result.alerts) {
      const id = a.alertId != null ? ` #${a.alertId}` : '';
      lines.push(`### Alert${id}`);
      if (a.alertDescription) lines.push(a.alertDescription);
      if (a.impactedRouteIds.length > 0) {
        lines.push(
          `**Impacted Route IDs:** ${a.impactedRouteIds.join(', ')} (use wsdot_get_ferry_routes to look up names)`,
        );
      }
      if (a.publishDate) lines.push(`**Published:** ${a.publishDate}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
