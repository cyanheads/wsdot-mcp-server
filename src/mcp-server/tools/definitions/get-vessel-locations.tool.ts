/**
 * @fileoverview Tool to fetch real-time vessel positions for all active WSF ferries.
 * @module mcp-server/tools/definitions/get-vessel-locations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFerryApiService } from '@/services/ferry/ferry-service.js';

export const getVesselLocations = tool('wsdot_get_vessel_locations', {
  title: 'Get Vessel Locations',
  description:
    'Returns real-time AIS positions, speed, heading, ETA, and dock status for all active WSF vessels. ' +
    'Use for "where is the ferry now?", vessel tracking, or checking if a vessel is in service. ' +
    'Position data may lag by 30–60 seconds. Many fields are null for vessels not currently operating.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    vessels: z
      .array(
        z
          .object({
            vesselId: z.number().optional().describe('Unique vessel identifier.'),
            vesselName: z
              .string()
              .optional()
              .describe('Vessel name (e.g. "Yakima", "Walla Walla").'),
            inService: z
              .boolean()
              .optional()
              .describe('Whether the vessel is currently in service.'),
            atDock: z
              .boolean()
              .optional()
              .describe('True when the vessel is docked at a terminal.'),
            departingTerminalId: z
              .number()
              .optional()
              .describe('Terminal the vessel is departing from.'),
            departingTerminalName: z.string().optional().describe('Departing terminal name.'),
            arrivingTerminalId: z
              .number()
              .optional()
              .describe('Terminal the vessel is heading toward.'),
            arrivingTerminalName: z.string().optional().describe('Arriving terminal name.'),
            latitude: z.number().optional().describe('Current latitude (AIS position).'),
            longitude: z.number().optional().describe('Current longitude (AIS position).'),
            speed: z.number().optional().describe('Speed in knots.'),
            heading: z.number().optional().describe('Heading in degrees (0–359).'),
            leftDock: z.string().optional().describe('Time the vessel last left the dock.'),
            eta: z
              .string()
              .optional()
              .describe('Estimated arrival time at the destination terminal.'),
            scheduledDeparture: z.string().optional().describe('Scheduled departure time.'),
            opRouteAbbrev: z
              .array(z.string())
              .describe('Abbreviations of routes this vessel operates on.'),
            timestamp: z
              .string()
              .optional()
              .describe('AIS data timestamp — indicates position data age.'),
          })
          .describe('Real-time position and status for one WSF vessel.'),
      )
      .describe('All WSF vessels with real-time position data.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of vessels returned.'),
    notice: z
      .string()
      .optional()
      .describe('Optional notice when no vessel data is available. Absent on normal results.'),
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
    const vessels = await getFerryApiService().getVesselLocations(ctx);
    ctx.log.info('Vessel locations fetched', { count: vessels.length });

    ctx.enrich({ totalCount: vessels.length });
    if (vessels.length === 0) {
      ctx.enrich.notice(
        'No vessel location data available. The WSF API may be temporarily unavailable — retry in 30 seconds.',
      );
    }

    return { vessels };
  },

  format: (result) => {
    if (result.vessels.length === 0) {
      return [{ type: 'text', text: 'No vessel location data available.' }];
    }
    const lines: string[] = [];
    for (const v of result.vessels) {
      const name = v.vesselName ?? `Vessel ${v.vesselId ?? '?'}`;
      lines.push(`### ${name}`);
      if (typeof v.inService === 'boolean')
        lines.push(`**In Service:** ${v.inService ? 'Yes' : 'No'}`);
      if (typeof v.atDock === 'boolean') lines.push(`**At Dock:** ${v.atDock ? 'Yes' : 'No'}`);
      if (v.departingTerminalId != null || v.departingTerminalName) {
        lines.push(
          `**Departing:** ${v.departingTerminalName ?? ''}${v.departingTerminalId != null ? ` (ID: ${v.departingTerminalId})` : ''}`,
        );
      }
      if (v.arrivingTerminalId != null || v.arrivingTerminalName) {
        lines.push(
          `**Arriving:** ${v.arrivingTerminalName ?? ''}${v.arrivingTerminalId != null ? ` (ID: ${v.arrivingTerminalId})` : ''}`,
        );
      }
      if (v.latitude != null && v.longitude != null) {
        // Render full upstream precision so content[] matches structuredContent — rounding here
        // creates client-dependent vessel positions (the two channels must carry identical data).
        lines.push(`**Position:** ${v.latitude}, ${v.longitude}`);
      }
      if (v.speed != null) lines.push(`**Speed:** ${v.speed} knots`);
      if (v.heading != null) lines.push(`**Heading:** ${v.heading}°`);
      if (v.leftDock) lines.push(`**Left Dock:** ${v.leftDock}`);
      if (v.eta) lines.push(`**ETA:** ${v.eta}`);
      if (v.scheduledDeparture) lines.push(`**Scheduled Departure:** ${v.scheduledDeparture}`);
      if (v.opRouteAbbrev.length > 0) lines.push(`**Routes:** ${v.opRouteAbbrev.join(', ')}`);
      if (v.timestamp) lines.push(`**Position Timestamp:** ${v.timestamp}`);
      if (v.vesselId != null) lines.push(`**Vessel ID:** ${v.vesselId}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
