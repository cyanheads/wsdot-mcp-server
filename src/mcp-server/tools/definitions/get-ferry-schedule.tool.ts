/**
 * @fileoverview Tool to fetch departure times for a specific WSF ferry route.
 * @module mcp-server/tools/definitions/get-ferry-schedule.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { FerryApiService, getFerryApiService } from '@/services/ferry/ferry-service.js';
import type { FerrySchedule } from '@/services/ferry/types.js';

export const getFerrySchedule = tool('wsdot_get_ferry_schedule', {
  title: 'Get Ferry Schedule',
  description:
    'Returns departure times for a specific WSF ferry route on a given date. ' +
    'Requires numeric terminal IDs — use wsdot_get_ferry_terminals to resolve terminal names to IDs. ' +
    'Set remainingOnly to true to show only future departures for today (useful for "next ferry" queries). ' +
    'For future dates, all sailings for that day are returned. ' +
    'Cancellations are not carried here — WSF drops a cancelled sailing from the schedule instead ' +
    'of flagging it, so a listed sailing is not confirmation that it will run. Check ' +
    'wsdot_get_ferry_alerts for disruptions; those are scoped to a route, not an individual sailing.',
  annotations: { readOnlyHint: true },
  input: z.object({
    departingTerminalId: z
      .number()
      .describe(
        'Numeric ID of the departing terminal. Use wsdot_get_ferry_terminals to look up terminal IDs.',
      ),
    arrivingTerminalId: z.number().describe('Numeric ID of the arriving terminal.'),
    tripDate: z
      .string()
      .optional()
      .describe('Date in ISO 8601 format (YYYY-MM-DD). Defaults to today if omitted.'),
    remainingOnly: z
      .boolean()
      .optional()
      .describe(
        'When true, returns only future sailings for today. Ignored for future dates. Default: false.',
      ),
  }),
  output: z.object({
    departingTerminalName: z.string().optional().describe('Departing terminal name.'),
    arrivingTerminalName: z.string().optional().describe('Arriving terminal name.'),
    sailings: z
      .array(
        z
          .object({
            departureTime: z.string().optional().describe('Scheduled departure time.'),
            arrivalTime: z.string().optional().describe('Scheduled arrival time.'),
            vesselName: z.string().optional().describe('Vessel assigned to this sailing.'),
          })
          .describe('One scheduled sailing with departure time and vessel assignment.'),
      )
      .describe('Scheduled sailings for this route and date.'),
  }),

  enrichment: {
    tripDate: z.string().describe('Date of the schedule (ISO 8601).'),
    remainingOnly: z.boolean().describe('Whether the result shows only remaining sailings.'),
    totalSailings: z.number().describe('Total number of sailings returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional notice when no sailings are found — e.g. invalid terminal pair or no service for this date. Absent when sailings are present.',
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
      reason: 'invalid_terminal_pair',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The terminal ID pair is invalid or does not form a valid ferry route.',
      recovery:
        'Use wsdot_get_ferry_terminals to list valid terminal IDs and wsdot_get_ferry_routes to find valid pairs.',
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
    const remainingOnly = input.remainingOnly ?? false;

    let schedule: FerrySchedule;
    try {
      schedule = await getFerryApiService().getSchedule(
        input.departingTerminalId,
        input.arrivingTerminalId,
        tripDate,
        remainingOnly,
        ctx,
      );
    } catch (err) {
      // WSF rejects an invalid or non-through terminal pair with either a 200 + {"Message"} body
      // (→ "WSF Ferry API error: …") or a real HTTP 4xx. Both mean the same to the caller: there is
      // no direct schedule for this pair. An unregistered access code is also a 4xx but is a server
      // configuration fault — it keeps its own reason instead of being reported as a bad pair.
      if (!(err instanceof McpError) || err.data?.reason === 'invalid_access_code') throw err;
      const status = err.data?.status;
      const noDirectService =
        err.message.includes('WSF Ferry API error') ||
        (typeof status === 'number' && status >= 400 && status < 500);
      if (!noDirectService) throw err;
      throw ctx.fail(
        'invalid_terminal_pair',
        `No ferry schedule for terminal ${input.departingTerminalId} → ${input.arrivingTerminalId} on ${tripDate}. These terminals may not have direct service, or a terminal ID may be invalid.`,
        {
          recovery: {
            hint: 'Use wsdot_get_ferry_terminals for valid IDs and wsdot_get_ferry_routes for served routes.',
          },
        },
      );
    }

    ctx.log.info('Ferry schedule fetched', {
      departingTerminalId: input.departingTerminalId,
      arrivingTerminalId: input.arrivingTerminalId,
      tripDate,
      sailingsCount: schedule.sailings.length,
    });

    ctx.enrich({ tripDate, remainingOnly, totalSailings: schedule.sailings.length });
    if (schedule.sailings.length === 0) {
      ctx.enrich.notice(
        remainingOnly
          ? `No remaining sailings today for this terminal pair (${tripDate}). The last sailing may have departed — check wsdot_get_ferry_schedule without remainingOnly for the full day's schedule.`
          : `No sailings found for this terminal pair on ${tripDate}. Verify terminal IDs with wsdot_get_ferry_terminals and valid routes with wsdot_get_ferry_routes.`,
      );
    }

    return {
      departingTerminalName: schedule.departingTerminalName,
      arrivingTerminalName: schedule.arrivingTerminalName,
      sailings: schedule.sailings,
    };
  },

  format: (result) => {
    const route =
      result.departingTerminalName && result.arrivingTerminalName
        ? `${result.departingTerminalName} → ${result.arrivingTerminalName}`
        : 'Ferry Schedule';
    const lines: string[] = [`## Ferry Schedule — ${route}`];
    if (result.departingTerminalName) lines.push(`**From:** ${result.departingTerminalName}`);
    if (result.arrivingTerminalName) lines.push(`**To:** ${result.arrivingTerminalName}`);
    lines.push('');

    if (result.sailings.length === 0) {
      lines.push('No sailings found for this route and date.');
    } else {
      for (const s of result.sailings) {
        const dep = s.departureTime ?? 'Unknown';
        const arr = s.arrivalTime ? ` → ${s.arrivalTime}` : '';
        const vessel = s.vesselName ? ` | ${s.vesselName}` : '';
        lines.push(`- ${dep}${arr}${vessel}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
