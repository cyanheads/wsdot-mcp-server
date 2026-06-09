/**
 * @fileoverview Tool to fetch Canada border crossing wait times from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/get-border-waits.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

export const getBorderWaits = tool('wsdot_get_border_waits', {
  title: 'Get Border Wait Times',
  description:
    'Returns current vehicle wait times at WA→Canada land border crossings on I-5 (Peace Arch and ' +
    'Pacific Highway, Blaine), SR 539 (Lynden), and SR 9 (Sumas), including Nexus-lane variants. ' +
    'crossingName is a route code (e.g. "I5", "I5Nexus", "SR539"); the readable name is in ' +
    'location.description. Wait times are in minutes; a crossing reporting no current data is omitted. ' +
    'Use for "how long is the border wait?" questions.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    crossings: z
      .array(
        z
          .object({
            crossingName: z
              .string()
              .optional()
              .describe(
                'Route-code crossing identifier (e.g. "I5", "I5Nexus", "SR539", "SR9"). ' +
                  'See location.description for the readable name.',
              ),
            waitTimeInMinutes: z
              .number()
              .optional()
              .describe(
                'Current vehicle wait time in minutes. Omitted when the crossing reports no data ' +
                  '(WSDOT emits a -1 sentinel for closed/unmonitored crossings).',
              ),
            updateTime: z
              .string()
              .optional()
              .describe('When this wait time was last updated (ISO 8601).'),
            location: z
              .object({
                description: z
                  .string()
                  .optional()
                  .describe(
                    'Readable crossing/lane name (e.g. "I-5 General Purpose", "I-5 Nexus Lane").',
                  ),
                roadName: z.string().optional().describe('Road serving the crossing.'),
                direction: z
                  .string()
                  .optional()
                  .describe(
                    'Travel direction code (N/S/E/W/B); frequently null for border crossings.',
                  ),
                milePost: z.number().optional().describe('Milepost of the crossing.'),
                latitude: z.number().optional().describe('Latitude of the crossing.'),
                longitude: z.number().optional().describe('Longitude of the crossing.'),
              })
              .optional()
              .describe('Geographic location and readable name of the crossing.'),
          })
          .describe('Wait time data for one border crossing.'),
      )
      .describe('All WA/Canada border crossing wait times.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of crossings returned.'),
    notice: z
      .string()
      .optional()
      .describe('Optional notice when no crossing data is available. Absent on normal results.'),
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
  ],

  async handler(_input, ctx) {
    const crossings = await getTrafficApiService().getBorderCrossings(ctx);
    ctx.log.info('Border crossings fetched', { count: crossings.length });

    ctx.enrich({ totalCount: crossings.length });
    if (crossings.length === 0) {
      ctx.enrich.notice(
        'No border crossing data available. The WSDOT API may be temporarily unavailable — retry in 30 seconds.',
      );
    }

    return { crossings };
  },

  format: (result) => {
    if (result.crossings.length === 0) {
      return [{ type: 'text', text: 'No border crossing data available.' }];
    }
    const lines: string[] = [];
    for (const c of result.crossings) {
      const heading = c.location?.description ?? c.crossingName ?? 'Border Crossing';
      lines.push(`### ${heading}`);
      if (c.crossingName && c.crossingName !== heading) lines.push(`**Code:** ${c.crossingName}`);
      if (c.waitTimeInMinutes != null) {
        lines.push(`**Wait:** ${c.waitTimeInMinutes} min`);
      } else {
        lines.push('**Wait:** Not available');
      }
      if (c.location?.roadName) lines.push(`**Road:** ${c.location.roadName}`);
      if (c.location?.direction) lines.push(`**Direction:** ${c.location.direction}`);
      if (c.location?.milePost != null) lines.push(`**Milepost:** ${c.location.milePost}`);
      if (c.location?.latitude != null && c.location.longitude != null) {
        lines.push(`**Coords:** ${c.location.latitude}, ${c.location.longitude}`);
      }
      if (c.updateTime) lines.push(`**Updated:** ${c.updateTime}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
