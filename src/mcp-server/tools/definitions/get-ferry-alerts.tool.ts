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
    'Each alert carries a one-line summary plus the bulletin title, kind, and full body — the body ' +
    'is where detail such as a replacement sailing appears. ' +
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
            alertTitle: z.string().optional().describe("The bulletin's own title."),
            alertDescription: z
              .string()
              .optional()
              .describe(
                'One-line summary of the alert or disruption, as shown on the route pages. Falls back to the title when upstream publishes no summary.',
              ),
            bulletinText: z
              .string()
              .optional()
              .describe(
                'Full bulletin body as plain text, normalized from the upstream HTML — links are rendered inline as "link text (url)". Detail that appears nowhere else, such as a replacement sailing, lives here.',
              ),
            alertType: z
              .string()
              .optional()
              .describe('Alert kind as WSF categorizes it, e.g. "All Alerts".'),
            affectsAllRoutes: z
              .boolean()
              .optional()
              .describe(
                'True when the alert applies fleet-wide. A fleet-wide alert need not enumerate routes, so while this is true an empty impactedRouteIds means every route rather than none.',
              ),
            impactedRouteIds: z
              .array(z.number())
              .describe(
                'Route IDs affected by this alert. Cross-reference with wsdot_get_ferry_routes to get route names; ' +
                  'some seasonal or interisland route IDs may not be listed there for a given date. ' +
                  'Empty means no specific routes unless affectsAllRoutes is true, which makes it fleet-wide.',
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
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSF rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
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
      lines.push(`### ${a.alertTitle ?? 'Alert'}${id}`);
      if (a.alertType) lines.push(`**Type:** ${a.alertType}`);
      if (a.alertDescription) lines.push(a.alertDescription);
      if (a.bulletinText) lines.push(a.bulletinText);
      if (a.impactedRouteIds.length > 0) {
        lines.push(
          `**Impacted Route IDs:** ${a.impactedRouteIds.join(', ')} (use wsdot_get_ferry_routes to look up names)`,
        );
      }
      // An alert with no route IDs is ambiguous on its own — say which of the two it is.
      if (a.affectsAllRoutes) {
        lines.push('**Impacted Routes:** all routes — this alert affects the whole fleet.');
      } else if (a.affectsAllRoutes === false && a.impactedRouteIds.length === 0) {
        lines.push('**Impacted Routes:** none listed — this alert names no specific route.');
      }
      if (a.publishDate) lines.push(`**Published:** ${a.publishDate}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
