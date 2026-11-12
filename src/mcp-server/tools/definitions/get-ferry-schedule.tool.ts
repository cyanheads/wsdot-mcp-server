/**
 * @fileoverview Tool to fetch departure times for a specific WSF ferry route.
 * @module mcp-server/tools/definitions/get-ferry-schedule.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { resolveTripDate, tripLookupFailure } from '@/mcp-server/tools/ferry-trip-rejection.js';
import { localThenUtc } from '@/mcp-server/tools/local-time.js';
import { CALL_BUDGET_MS, getFerryApiService } from '@/services/ferry/ferry-service.js';
import type { FerrySchedule } from '@/services/ferry/types.js';

export const getFerrySchedule = tool('wsdot_get_ferry_schedule', {
  title: 'Get Ferry Schedule',
  description: `Returns departure times for a specific WSF ferry route on a given date. Requires numeric terminal IDs — use wsdot_get_ferry_terminals to resolve terminal names to IDs; terminalPairs on wsdot_get_ferry_routes lists the pairs with service on a date. Set remainingOnly to true to show only future departures for today (useful for "next ferry" queries); a query after midnight also includes the previous service day's sailings still to depart, listed first. Each sailing's serviceDate names the service day whose schedule lists it. For future dates, all sailings for that day are returned. Each sailing carries its vessel ID, WSF's loading-rule code, and the pair's annotations that apply to it — notes such as "No interisland vehicles" that decide whether a sailing takes a car. Sailing times are ISO 8601 UTC, each beside a Local sibling (departureTimeLocal, arrivalTimeLocal) holding the same instant in Pacific time with its UTC offset — quote the Local form as the clock time. tripDate is the Pacific service day, so an evening sailing's UTC time carries the next calendar date. Cancellations are not carried here — WSF drops a cancelled sailing from the schedule instead of flagging it, so a listed sailing is not confirmation that it will run. Check wsdot_get_ferry_alerts for disruptions; those are scoped to a route, not an individual sailing.`,
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
        "When true, returns only future sailings for today. A WSF service day runs past midnight, so before 3 a.m. Pacific the result also includes the previous service day's sailings still to depart, first and marked with that day's serviceDate. Ignored for any other date. Default: false.",
      ),
  }),
  output: z.object({
    departingTerminalName: z.string().optional().describe('Departing terminal name.'),
    arrivingTerminalName: z.string().optional().describe('Arriving terminal name.'),
    annotations: z
      .array(z.string().describe('One note, as plain text.'))
      .optional()
      .describe(
        'Notes WSF attaches to this pair\'s sailings (vehicle restrictions, routing, delays), converted from HTML to plain text with link destinations kept as "text (url)". Sailings point at the ones that apply to them through annotationIndexes; the previous service day\'s sailings add the notes they cite that the list lacks. Empty when the pair has none.',
      ),
    sailingNotes: z
      .string()
      .optional()
      .describe(
        'A note covering every sailing on this pair (e.g. a boarding-pass requirement), converted from HTML to plain text. Absent when WSF publishes none, which is the case for most pairs.',
      ),
    sailings: z
      .array(
        z
          .object({
            departureTime: z
              .string()
              .optional()
              .describe(
                'Scheduled departure time (ISO 8601, UTC). A sailing late in the Pacific service day carries the following UTC calendar date, so it will not match tripDate; departureTimeLocal carries the Pacific clock time.',
              ),
            departureTimeLocal: z
              .string()
              .optional()
              .describe(
                'departureTime as Pacific time (America/Los_Angeles): ISO 8601 with its UTC offset, the same instant at the same precision — the form to quote as a clock time. Absent when departureTime is absent or not an ISO 8601 instant.',
              ),
            arrivalTime: z
              .string()
              .optional()
              .describe(
                'Scheduled arrival time (ISO 8601, UTC), on the same terms as departureTime. Absent on the routes WSF publishes no arrival time for.',
              ),
            arrivalTimeLocal: z
              .string()
              .optional()
              .describe(
                'arrivalTime as Pacific time (America/Los_Angeles): ISO 8601 with its UTC offset, the same instant at the same precision — the form to quote as a clock time. Absent when arrivalTime is absent or not an ISO 8601 instant.',
              ),
            serviceDate: z
              .string()
              .describe(
                "The Pacific service day (YYYY-MM-DD) whose schedule lists this sailing. It is tripDate, except for the previous service day's sailings a remainingOnly query made after midnight leads with, which carry that day — so a 01:35 sailing can belong to the day before its own calendar date.",
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
                "WSF's loading-rule code for this sailing. WSF does not document the codes: 3 appears on nearly every sailing, and 1 has appeared only on sailings whose annotation restricts vehicles. Read the sailing’s annotations for the restriction itself.",
              ),
            vesselHandicapAccessible: z
              .boolean()
              .optional()
              .describe('Whether WSF marks the assigned vessel as handicap accessible.'),
            annotationIndexes: z
              .array(z.number().describe('A position in annotations.'))
              .optional()
              .describe(
                'Positions in annotations of the notes that apply to this sailing; each resolves to an entry. Empty when none apply.',
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
        "Whether the result holds only remaining sailings: today's, led before 3 a.m. Pacific by the previous service day's still to depart. False for any date other than today, whatever was requested.",
      ),
    totalSailings: z
      .number()
      .describe("Total number of sailings returned, the previous service day's included."),
    notice: z
      .string()
      .optional()
      .describe(
        "Present when no sailings are found, or when the previous service day's late sailings could not be checked because its schedule could not be read.",
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
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: `The WSF Ferry API requests the call makes did not finish within its ${CALL_BUDGET_MS / 1000}-second budget, retries included.`,
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
      thrownBy: 'service',
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
    const tripDate = resolveTripDate(input.tripDate, ctx.fail);
    // One budget for the schedule read, the previous service day's read a post-midnight
    // remainingOnly query adds, and the routes check a rejection chains.
    const deadlineAt = Date.now() + CALL_BUDGET_MS;
    let schedule: FerrySchedule;
    try {
      schedule = await getFerryApiService().getSchedule(
        input.departingTerminalId,
        input.arrivingTerminalId,
        tripDate,
        input.remainingOnly ?? false,
        ctx,
        deadlineAt,
      );
    } catch (err) {
      throw await tripLookupFailure(
        err,
        {
          subject: 'schedule',
          departingTerminalId: input.departingTerminalId,
          arrivingTerminalId: input.arrivingTerminalId,
          tripDate,
          deadlineAt,
        },
        ctx.fail,
        ctx,
      );
    }

    ctx.log.info('Ferry schedule fetched', {
      departingTerminalId: input.departingTerminalId,
      arrivingTerminalId: input.arrivingTerminalId,
      tripDate,
      sailingsCount: schedule.sailings.length,
    });

    const { previousServiceDayUnread, remainingOnly } = schedule;
    ctx.enrich({ tripDate, remainingOnly, totalSailings: schedule.sailings.length });
    const notices = [
      ...(schedule.sailings.length === 0
        ? [
            remainingOnly
              ? `No remaining sailings today for this terminal pair (${tripDate}). The last sailing may have departed — check wsdot_get_ferry_schedule without remainingOnly for the full day's schedule.`
              : `No sailings found for this terminal pair on ${tripDate}. Check the pair against terminalPairs from wsdot_get_ferry_routes for ${tripDate}.`,
          ]
        : []),
      ...(previousServiceDayUnread
        ? [
            `The previous service day's (${previousServiceDayUnread.serviceDate}) late sailings could not be checked: WSF's schedule for that day could not be read (${previousServiceDayUnread.detail}), so any of them still to depart are missing from this list. Call again to include them.`,
          ]
        : []),
    ];
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
      `${indent}- [${index}] ${escapeMarkdownInline(result.annotations?.[index] ?? 'not listed in annotations').replaceAll('\n', `\n${indent}  `)}`;

    const lines: string[] = [`## Ferry Schedule — ${escapeMarkdownInline(route)}`];
    if (result.departingTerminalName)
      lines.push(`**From:** ${escapeMarkdownInline(result.departingTerminalName)}`);
    if (result.arrivingTerminalName)
      lines.push(`**To:** ${escapeMarkdownInline(result.arrivingTerminalName)}`);
    if (result.sailingNotes)
      lines.push(`**Sailing notes:** ${escapeMarkdownInline(result.sailingNotes)}`);
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
        const dep = escapeMarkdownInline(
          s.departureTime ? localThenUtc(s.departureTime, s.departureTimeLocal) : 'Unknown',
        );
        const arr = s.arrivalTime
          ? ` → ${escapeMarkdownInline(localThenUtc(s.arrivalTime, s.arrivalTimeLocal))}`
          : '';
        const vessel = [s.vesselName, s.vesselId != null ? `(vesselId ${s.vesselId})` : undefined]
          .filter(Boolean)
          .join(' ');
        const details = [
          escapeMarkdownInline(vessel),
          s.loadingRule != null ? `loadingRule ${s.loadingRule}` : undefined,
          s.vesselHandicapAccessible != null
            ? `vesselHandicapAccessible: ${s.vesselHandicapAccessible}`
            : undefined,
        ].filter(Boolean);
        lines.push(
          `- ${dep}${arr} | serviceDate ${s.serviceDate}${details.map((d) => ` | ${d}`).join('')}`,
        );
        for (const i of s.annotationIndexes ?? []) lines.push(note(i, '  '));
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
