/**
 * @fileoverview Tool to fetch WSF's fares for one ferry trip between two terminals on a date.
 * @module mcp-server/tools/definitions/get-ferry-fares.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { resolveTripDate, tripLookupFailure } from '@/mcp-server/tools/ferry-trip-rejection.js';
import { CALL_BUDGET_MS, getFerryApiService } from '@/services/ferry/ferry-service.js';
import type { FerryFares } from '@/services/ferry/types.js';

/** A dollar amount with cents, or as WSF gave it when it carries finer precision than cents. */
function dollars(amount: number): string {
  const cents = amount.toFixed(2);
  return `$${Number(cents) === amount ? cents : String(amount)}`;
}

export const getFerryFares = tool('wsdot_get_ferry_fares', {
  title: 'Get Ferry Fares',
  description:
    "Returns WSF's fares for one ferry trip between two terminals on a date: every fare line item — passenger, senior and youth, vehicle and driver by length, motorcycle, bicycle, and multi-ride cards — with its amount in dollars, plus WSF's statement of which terminal collects which fares. Requires numeric terminal IDs — use wsdot_get_ferry_terminals to resolve terminal names to IDs; terminalPairs on wsdot_get_ferry_routes lists the pairs with service on a date, the same pairs wsdot_get_ferry_schedule accepts. WSF collects most fares in one direction only, so a line reads 0 on a leg whose departing terminal does not collect it: read collectionDescription before quoting a 0 as free travel, and query the reverse direction for where that fare is charged.",
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
      .describe(
        'Travel date in ISO 8601 format (YYYY-MM-DD), the Pacific service day. Defaults to today if omitted.',
      ),
    roundTrip: z
      .boolean()
      .optional()
      .describe(
        "When true, each amount is WSF's total for a round trip starting at the departing terminal: twice the one-way fare where both terminals collect it, the one-way fare where the return leg collects nothing, and the whole round-trip charge on a leg out of a terminal that collects nothing. Default: false (one way).",
      ),
  }),
  output: z.object({
    departingTerminalName: z.string().optional().describe('Departing terminal name.'),
    arrivingTerminalName: z.string().optional().describe('Arriving terminal name.'),
    collectionDescription: z
      .string()
      .optional()
      .describe(
        'WSF\'s statement of which terminal collects which fares on this pair, e.g. "Passenger and vehicle/driver fares are collected at Anacortes, while no fares are collected at Friday Harbor." A fare the departing terminal does not collect reads 0 on this leg. Absent when WSF\'s statement could not be read, which the notice then reports.',
      ),
    fares: z
      .array(
        z
          .object({
            fareLineItemId: z.number().optional().describe("WSF's ID for this fare line."),
            description: z
              .string()
              .optional()
              .describe(
                'The fare as WSF names it, e.g. "Vehicle Under 22\' (standard veh) & Driver", converted from HTML to plain text with link destinations kept as "text (url)".',
              ),
            category: z
              .string()
              .optional()
              .describe(
                'WSF\'s grouping for the line: "Passenger", "Vehicle, Motorcycle, and Stowage Fares", or "Vehicle Length-Based".',
              ),
            amountInDollars: z
              .number()
              .optional()
              .describe(
                "WSF's fare in US dollars for the requested trip, passed through as given. 0 means WSF charges nothing for this line on this leg: on most pairs because the departing terminal does not collect it (collectionDescription says which terminal does), and for some lines, such as youth fares, because the fare itself is free.",
              ),
            directionIndependent: z
              .boolean()
              .optional()
              .describe(
                'True for a line WSF prices the same in either direction, such as a multi-ride card, which keeps its amount on a leg whose departing terminal collects nothing.',
              ),
          })
          .describe('One fare line item and its amount.'),
      )
      .describe(
        "WSF's fare line items for this trip, in WSF's order, which groups them by category. Empty when WSF lists none, which the notice then reports.",
      ),
  }),

  enrichment: {
    tripDate: z
      .string()
      .describe('Trip date the fares apply to (YYYY-MM-DD, Pacific service day).'),
    roundTrip: z
      .boolean()
      .describe("Whether the amounts are WSF's round-trip totals (true) or one-way fares (false)."),
    totalCount: z.number().describe('Number of fare line items returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        "Present when WSF lists no fare line items for the pair, or when WSF's collection statement and the terminal names could not be read; says which.",
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
      when: 'WSF lists no fares for the terminal ID pair on the trip date — the terminals have no direct service that day, or an ID is invalid.',
      recovery:
        'Call wsdot_get_ferry_routes for the same tripDate and pick a departing → arriving pair from a route’s terminalPairs; wsdot_get_ferry_terminals maps terminal names to IDs.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The tripDate is not a valid YYYY-MM-DD date, WSF rejects it as outside the dates it has published fares for, or WSF lists no routes on it.',
      retryable: false,
      recovery:
        'Use a YYYY-MM-DD date from today (Pacific time) through the end of the posted fares, on which wsdot_get_ferry_routes lists routes; when WSF rejects the date, the message states the range it accepts.',
    },
  ],

  async handler(input, ctx) {
    const tripDate = resolveTripDate(input.tripDate, ctx.fail);
    const { departingTerminalId, arrivingTerminalId } = input;
    const roundTrip = input.roundTrip ?? false;
    // One budget for both fares requests and the routes check a rejection chains.
    const deadlineAt = Date.now() + CALL_BUDGET_MS;
    let result: FerryFares;
    try {
      result = await getFerryApiService().getFares(
        departingTerminalId,
        arrivingTerminalId,
        tripDate,
        roundTrip,
        ctx,
        deadlineAt,
      );
    } catch (err) {
      throw await tripLookupFailure(
        err,
        { subject: 'fares', departingTerminalId, arrivingTerminalId, tripDate, deadlineAt },
        ctx.fail,
        ctx,
      );
    }

    const { combo, fares } = result;
    ctx.log.info('Ferry fares fetched', {
      departingTerminalId,
      arrivingTerminalId,
      tripDate,
      roundTrip,
      faresCount: fares.length,
      combo: combo.kind,
    });

    ctx.enrich({ tripDate, roundTrip, totalCount: fares.length });
    const notices = [
      ...(fares.length === 0
        ? [
            `WSF lists no fare line items for terminal ${departingTerminalId} → ${arrivingTerminalId} on ${tripDate}. Check the pair against terminalPairs from wsdot_get_ferry_routes for ${tripDate}.`,
          ]
        : []),
      ...(combo.kind === 'unavailable'
        ? [
            `WSF's statement of which terminal collects these fares, and the terminal names, could not be read (${combo.detail}). The fare line items are complete; a 0 amount means the departing terminal does not collect that fare on this leg — query the reverse direction to see where it is charged.`,
          ]
        : []),
    ];
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...(combo.kind === 'read' && {
        ...(combo.departingTerminalName && { departingTerminalName: combo.departingTerminalName }),
        ...(combo.arrivingTerminalName && { arrivingTerminalName: combo.arrivingTerminalName }),
        ...(combo.collectionDescription && {
          collectionDescription: combo.collectionDescription,
        }),
      }),
      fares,
    };
  },

  format: (result) => {
    const lines: string[] = [
      result.departingTerminalName && result.arrivingTerminalName
        ? `## Ferry Fares — ${escapeMarkdownInline(`${result.departingTerminalName} → ${result.arrivingTerminalName}`)}`
        : '## Ferry Fares',
    ];
    lines.push(
      `**Fare collection:** ${result.collectionDescription ? escapeMarkdownInline(result.collectionDescription) : 'not reported'}`,
    );
    if (result.departingTerminalName)
      lines.push(`**From:** ${escapeMarkdownInline(result.departingTerminalName)}`);
    if (result.arrivingTerminalName)
      lines.push(`**To:** ${escapeMarkdownInline(result.arrivingTerminalName)}`);

    if (result.fares.length === 0) {
      lines.push('', 'No fares listed for this pair and date.');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    // WSF's order groups the lines by category, so a heading opens each run of one category.
    let category: string | undefined | null = null;
    for (const fare of result.fares) {
      if (fare.category !== category) {
        category = fare.category;
        lines.push('', `### ${escapeMarkdownInline(category ?? 'Category not reported')}`);
      }
      const details = [
        fare.amountInDollars != null ? dollars(fare.amountInDollars) : 'amount not reported',
        fare.fareLineItemId != null ? `fareLineItemId ${fare.fareLineItemId}` : undefined,
        fare.directionIndependent != null
          ? `directionIndependent: ${fare.directionIndependent}`
          : undefined,
      ].filter(Boolean);
      lines.push(
        `- ${escapeMarkdownInline(fare.description ?? 'Description not reported')}: ${details.join(' | ')}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
