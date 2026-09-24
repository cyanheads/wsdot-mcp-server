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
    'Requires numeric terminal IDs — use wsdot_get_ferry_terminals to resolve terminal names to IDs; ' +
    'terminalPairs on wsdot_get_ferry_routes lists the pairs with service on a date. ' +
    'Set remainingOnly to true to show only future departures for today (useful for "next ferry" queries). ' +
    'For future dates, all sailings for that day are returned. ' +
    "Each sailing carries its vessel ID, WSF's loading-rule code, and the pair's annotations that " +
    'apply to it — notes such as "No interisland vehicles" that decide whether a sailing takes a car. ' +
    'Sailing times are ISO 8601 UTC while tripDate is the Pacific service day, so evening sailings ' +
    'carry the next UTC date — convert to America/Los_Angeles before quoting a clock time. ' +
    'Cancellations are not carried here — WSF drops a cancelled sailing from the schedule instead ' +
    'of flagging it, so a listed sailing is not confirmation that it will run. Check ' +
    'wsdot_get_ferry_alerts for disruptions; those are scoped to a route, not an individual sailing.',
  annotations: { readOnlyHint: true },
  input: z.object({
    departingTerminalId: z
      .number()
      .int()
      .positive()
      .describe(
        'Numeric ID of the departing terminal. Use wsdot_get_ferry_terminals to look up terminal IDs.',
      ),
    arrivingTerminalId: z
      .number()
      .int()
      .positive()
      .describe('Numeric ID of the arriving terminal.'),
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
    annotations: z
      .array(z.string().describe('One note, as plain text.'))
      .optional()
      .describe(
        "Notes WSF attaches to this pair's sailings (vehicle restrictions, routing, delays), converted " +
          'from HTML to plain text with link destinations kept as "text (url)". Sailings point at the ' +
          'ones that apply to them through annotationIndexes. Empty when the pair has none.',
      ),
    sailingNotes: z
      .string()
      .optional()
      .describe(
        'A note covering every sailing on this pair (e.g. a boarding-pass requirement), converted from ' +
          'HTML to plain text. Absent when WSF publishes none, which is the case for most pairs.',
      ),
    sailings: z
      .array(
        z
          .object({
            departureTime: z
              .string()
              .optional()
              .describe(
                'Scheduled departure time (ISO 8601, UTC). WSF publishes schedules in Pacific time, ' +
                  'so a sailing late in the service day carries the following UTC calendar date and ' +
                  'will not match tripDate. Convert to America/Los_Angeles before showing a clock time.',
              ),
            arrivalTime: z
              .string()
              .optional()
              .describe(
                'Scheduled arrival time (ISO 8601, UTC), on the same terms as departureTime. ' +
                  'Absent on the routes WSF publishes no arrival time for.',
              ),
            vesselName: z.string().optional().describe('Vessel assigned to this sailing.'),
            vesselId: z
              .number()
              .optional()
              .describe(
                'ID of the assigned vessel — the same vesselId wsdot_get_vessel_locations reports.',
              ),
            loadingRule: z
              .number()
              .optional()
              .describe(
                "WSF's loading-rule code for this sailing. WSF does not document the codes: 3 appears on " +
                  'nearly every sailing, and 1 has appeared only on sailings whose annotation restricts ' +
                  'vehicles. Read the sailing’s annotations for the restriction itself.',
              ),
            vesselHandicapAccessible: z
              .boolean()
              .optional()
              .describe('Whether WSF marks the assigned vessel as handicap accessible.'),
            annotationIndexes: z
              .array(z.number().describe('A position in annotations.'))
              .optional()
              .describe(
                'Positions in annotations of the notes that apply to this sailing; each resolves to an ' +
                  'entry. Empty when none apply.',
              ),
          })
          .describe(
            'One scheduled sailing with departure time, vessel assignment, and the notes that apply to it.',
          ),
      )
      .describe('Scheduled sailings for this route and date.'),
  }),

  enrichment: {
    tripDate: z.string().describe('Date of the schedule (ISO 8601).'),
    remainingOnly: z
      .boolean()
      .describe(
        "Whether the result holds only today's remaining sailings. False for any date other than today, whatever was requested.",
      ),
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
      thrownBy: 'service',
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSF rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_terminal_pair',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The terminal ID pair is invalid or does not form a valid ferry route.',
      recovery:
        'Call wsdot_get_ferry_routes for the same tripDate and pick a departing → arriving pair from a route’s terminalPairs; wsdot_get_ferry_terminals maps terminal names to IDs.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The tripDate is not a valid YYYY-MM-DD date, WSF rejects it as outside the dates it has published a schedule for, or WSF lists no routes on it.',
      retryable: false,
      recovery:
        'Use a YYYY-MM-DD date from today (Pacific time) through the end of the posted schedule, on which wsdot_get_ferry_routes lists routes; when WSF rejects the date, the message states the range it accepts.',
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
        { ...ctx.recoveryFor('invalid_date') },
      );
    }
    const service = getFerryApiService();
    let schedule: FerrySchedule;
    try {
      schedule = await service.getSchedule(
        input.departingTerminalId,
        input.arrivingTerminalId,
        tripDate,
        input.remainingOnly ?? false,
        ctx,
      );
    } catch (err) {
      // The service has already classified an unregistered access code (a server configuration
      // fault) and a trip date outside WSF's window; both keep their own reason.
      if (!(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      if (reason === 'invalid_access_code' || reason === 'invalid_date') throw err;
      // What remains of a rejection — a 200 + {"Message"} body (→ "WSF Ferry API error: …") or a
      // real HTTP 4xx — means there is no schedule for this pair on this date.
      const status = err.data?.status;
      const rejected =
        err.message.includes('WSF Ferry API error') ||
        (typeof status === 'number' && status >= 400 && status < 500);
      if (!rejected) throw err;
      // WSF rejects every pair on an in-window date whose season has no sailings loaded, in the
      // same words it uses for a pair that never has service. The date's route list tells them apart.
      if (!(await service.hasRoutes(tripDate, ctx))) {
        throw ctx.fail(
          'invalid_date',
          `WSF lists no routes on ${tripDate}, so no terminal pair has a schedule that day. The date is inside the window WSF accepts, but no sailings are loaded for it yet.`,
          { ...ctx.recoveryFor('invalid_date') },
          { cause: err },
        );
      }
      throw ctx.fail(
        'invalid_terminal_pair',
        `No ferry schedule for terminal ${input.departingTerminalId} → ${input.arrivingTerminalId} on ${tripDate}. These terminals may not have direct service, or a terminal ID may be invalid.`,
        { ...ctx.recoveryFor('invalid_terminal_pair') },
        { cause: err },
      );
    }

    ctx.log.info('Ferry schedule fetched', {
      departingTerminalId: input.departingTerminalId,
      arrivingTerminalId: input.arrivingTerminalId,
      tripDate,
      sailingsCount: schedule.sailings.length,
    });

    const { remainingOnly } = schedule;
    ctx.enrich({ tripDate, remainingOnly, totalSailings: schedule.sailings.length });
    if (schedule.sailings.length === 0) {
      ctx.enrich.notice(
        remainingOnly
          ? `No remaining sailings today for this terminal pair (${tripDate}). The last sailing may have departed — check wsdot_get_ferry_schedule without remainingOnly for the full day's schedule.`
          : `No sailings found for this terminal pair on ${tripDate}. Check the pair against terminalPairs from wsdot_get_ferry_routes for ${tripDate}.`,
      );
    }

    return {
      departingTerminalName: schedule.departingTerminalName,
      arrivingTerminalName: schedule.arrivingTerminalName,
      ...(schedule.annotations && { annotations: schedule.annotations }),
      ...(schedule.sailingNotes && { sailingNotes: schedule.sailingNotes }),
      sailings: schedule.sailings,
    };
  },

  format: (result) => {
    const route =
      result.departingTerminalName && result.arrivingTerminalName
        ? `${result.departingTerminalName} → ${result.arrivingTerminalName}`
        : 'Ferry Schedule';
    /** A note on a list item's own line, with any line breaks it holds kept under that item. */
    const note = (index: number, indent: string) =>
      `${indent}- [${index}] ${(result.annotations?.[index] ?? 'not listed in annotations').replaceAll('\n', `\n${indent}  `)}`;

    const lines: string[] = [`## Ferry Schedule — ${route}`];
    if (result.departingTerminalName) lines.push(`**From:** ${result.departingTerminalName}`);
    if (result.arrivingTerminalName) lines.push(`**To:** ${result.arrivingTerminalName}`);
    if (result.sailingNotes) lines.push(`**Sailing notes:** ${result.sailingNotes}`);
    if (result.annotations?.length === 0) {
      lines.push('**Annotations:** none');
    } else if (result.annotations) {
      lines.push('**Annotations** (sailings below cite them by index):');
      for (const i of result.annotations.keys()) lines.push(note(i, ''));
    }
    lines.push('');

    if (result.sailings.length === 0) {
      lines.push('No sailings found for this route and date.');
    } else {
      for (const s of result.sailings) {
        const dep = s.departureTime ?? 'Unknown';
        const arr = s.arrivalTime ? ` → ${s.arrivalTime}` : '';
        const vessel = [s.vesselName, s.vesselId != null ? `(vesselId ${s.vesselId})` : undefined]
          .filter(Boolean)
          .join(' ');
        const details = [
          vessel,
          s.loadingRule != null ? `loadingRule ${s.loadingRule}` : undefined,
          s.vesselHandicapAccessible != null
            ? `vesselHandicapAccessible: ${s.vesselHandicapAccessible}`
            : undefined,
        ].filter(Boolean);
        lines.push(`- ${dep}${arr}${details.map((d) => ` | ${d}`).join('')}`);
        for (const i of s.annotationIndexes ?? []) lines.push(note(i, '  '));
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
