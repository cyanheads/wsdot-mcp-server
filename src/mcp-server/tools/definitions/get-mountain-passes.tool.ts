/**
 * @fileoverview Tool to fetch all WA mountain pass conditions from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/get-mountain-passes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

export const getMountainPasses = tool('wsdot_get_mountain_passes', {
  title: 'Get Mountain Pass Conditions',
  description:
    'Returns current road conditions for all Washington State mountain passes: status, weather, ' +
    'road condition, traction laws, temperature, and elevation. Includes all ~12 passes ' +
    '(Snoqualmie, Stevens, White, Blewett, Cayuse, etc.). Use for "is the pass open?", ' +
    'traction law status, or winter driving planning.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    passes: z
      .array(
        z
          .object({
            mountainPassId: z.number().describe('Numeric identifier for the pass.'),
            mountainPassName: z
              .string()
              .describe('Human-readable pass name (e.g. "Snoqualmie Pass").'),
            elevation: z.number().optional().describe('Pass summit elevation in feet.'),
            temperatureInFahrenheit: z
              .number()
              .optional()
              .describe('Current temperature at the pass in Fahrenheit.'),
            weatherCondition: z
              .string()
              .optional()
              .describe('Current weather description (e.g. "Snowing", "Cloudy").'),
            roadCondition: z
              .string()
              .optional()
              .describe('Road surface condition (e.g. "Wet", "Snow and Ice Covered").'),
            travelAdvisoryActive: z
              .boolean()
              .optional()
              .describe('True when a travel advisory is in effect.'),
            restrictionOne: z
              .object({
                text: z
                  .string()
                  .optional()
                  .describe(
                    'Restriction / traction-law text (e.g. "Traction Tires Required, Chains Required (Except All Wheel Drive)"). ' +
                      'Reads "No current information available" or "No restrictions" when nothing is in effect.',
                  ),
                travelDirection: z
                  .string()
                  .optional()
                  .describe(
                    'Direction this restriction applies to (e.g. "Northbound", "Eastbound", "Both directions").',
                  ),
              })
              .optional()
              .describe('Primary travel/traction restriction (typically one direction of travel).'),
            restrictionTwo: z
              .object({
                text: z
                  .string()
                  .optional()
                  .describe('Restriction / traction-law text for the second direction.'),
                travelDirection: z
                  .string()
                  .optional()
                  .describe(
                    'Direction this restriction applies to (e.g. "Southbound", "Westbound").',
                  ),
              })
              .optional()
              .describe(
                'Secondary travel/traction restriction (typically the opposite direction).',
              ),
            dateUpdated: z
              .string()
              .optional()
              .describe('Timestamp of the last condition update (ISO 8601).'),
            latitude: z.number().optional().describe('Pass latitude.'),
            longitude: z.number().optional().describe('Pass longitude.'),
          })
          .describe('Conditions for one mountain pass.'),
      )
      .describe('All WA mountain pass conditions.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of passes returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional notice when no pass data is available — e.g. API temporarily unavailable. Absent on normal results.',
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
  ],

  async handler(_input, ctx) {
    const passes = await getTrafficApiService().getMountainPasses(ctx);
    ctx.log.info('Mountain passes fetched', { count: passes.length });

    ctx.enrich({ totalCount: passes.length });
    if (passes.length === 0) {
      ctx.enrich.notice(
        'No mountain pass data available. The WSDOT API may be temporarily unavailable — retry in 30 seconds.',
      );
    }

    return { passes };
  },

  format: (result) => {
    if (result.passes.length === 0) {
      return [{ type: 'text', text: 'No mountain pass data available.' }];
    }
    const lines: string[] = [];
    for (const p of result.passes) {
      lines.push(`### ${p.mountainPassName}`);
      if (p.elevation != null) lines.push(`**Elevation:** ${p.elevation} ft`);
      if (p.temperatureInFahrenheit != null)
        lines.push(`**Temperature:** ${p.temperatureInFahrenheit}°F`);
      if (p.weatherCondition) lines.push(`**Weather:** ${p.weatherCondition}`);
      if (p.roadCondition) lines.push(`**Road:** ${p.roadCondition}`);
      if (typeof p.travelAdvisoryActive === 'boolean') {
        lines.push(`**Travel Advisory:** ${p.travelAdvisoryActive ? 'ACTIVE' : 'None'}`);
      }
      if (p.restrictionOne?.text || p.restrictionOne?.travelDirection) {
        const r = [p.restrictionOne.travelDirection, p.restrictionOne.text]
          .filter(Boolean)
          .join(': ');
        lines.push(`**Restriction 1:** ${r}`);
      }
      if (p.restrictionTwo?.text || p.restrictionTwo?.travelDirection) {
        const r = [p.restrictionTwo.travelDirection, p.restrictionTwo.text]
          .filter(Boolean)
          .join(': ');
        lines.push(`**Restriction 2:** ${r}`);
      }
      if (p.dateUpdated) lines.push(`**Updated:** ${p.dateUpdated}`);
      lines.push(`**ID:** ${p.mountainPassId}`);
      if (p.latitude != null && p.longitude != null) {
        lines.push(`**Coords:** ${p.latitude}, ${p.longitude}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
