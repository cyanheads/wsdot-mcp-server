/**
 * @fileoverview Tool to fetch real-time vehicle space availability at WSF ferry terminals.
 * @module mcp-server/tools/definitions/get-terminal-space.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFerryApiService } from '@/services/ferry/ferry-service.js';

/**
 * Paging unit is the terminal, not the sailing: offset/limit select whole terminals and each
 * one arrives with every upcoming sailing it reports. WSF operates roughly 20 terminals, so
 * MAX_LIMIT reaches the entire set in one call while the default bounds a browse of all of them.
 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export const getTerminalSpace = tool('wsdot_get_terminal_space', {
  title: 'Get Terminal Space',
  description:
    'Returns real-time drive-up and reservable vehicle space available at WSF terminals for upcoming sailings. ' +
    'Use for "will I make the ferry?" or "how full is the next sailing?" questions. ' +
    'Optionally filter to a specific terminal by ID (use wsdot_get_ferry_terminals for the ID). ' +
    'driveUpSpaceCount is the key field — zero means the drive-up lane is full. ' +
    'Destinations are arrivingTerminalIds, not the itineraryLabel string: a sailing can serve ' +
    'several terminals, and those IDs are what wsdot_get_ferry_schedule accepts. ' +
    `Results are paged by terminal (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}): offset/limit select whole terminals ` +
    'and totalCount counts matching terminals, not sailings — every sailing of a returned terminal is included, ' +
    'so page size varies with how many departures each terminal carries.',
  annotations: { readOnlyHint: true },
  input: z.object({
    departingTerminalId: z
      .number()
      .optional()
      .describe('Filter to a specific terminal by numeric ID. Omit to return all terminals.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based index of the first terminal to return, for paging. Defaults to 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Maximum terminals to return in this page (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}. Counts terminals, not sailings.`,
      ),
  }),
  output: z.object({
    terminals: z
      .array(
        z
          .object({
            terminalId: z.number().optional().describe('Terminal numeric ID.'),
            terminalName: z.string().optional().describe('Terminal name.'),
            departingSpaces: z
              .array(
                z
                  .object({
                    departure: z
                      .string()
                      .optional()
                      .describe('Scheduled departure time for this sailing.'),
                    isCancelled: z
                      .boolean()
                      .optional()
                      .describe('Whether this sailing is cancelled.'),
                    vesselName: z.string().optional().describe('Vessel assigned to this sailing.'),
                    arrivingTerminalIds: z
                      .array(z.number())
                      .optional()
                      .describe(
                        'Numeric IDs of the terminals this sailing serves — the destinations. Pass one to wsdot_get_ferry_schedule as arrivingTerminalId, or resolve names with wsdot_get_ferry_terminals.',
                      ),
                    itineraryLabel: z
                      .string()
                      .optional()
                      .describe(
                        'Upstream itinerary string for the sailing, e.g. "Anacortes -> Friday Harbor". A display label only — it may name the departing terminal or several stops, so do not read it as the destination.',
                      ),
                    displayDriveUpSpace: z
                      .boolean()
                      .optional()
                      .describe(
                        'Whether WSF publishes a drive-up count for this sailing. False means driveUpSpaceCount is not reported, not that the lane is empty.',
                      ),
                    displayReservableSpace: z
                      .boolean()
                      .optional()
                      .describe(
                        'Whether this sailing takes vehicle reservations. False means reservableSpaceCount does not apply.',
                      ),
                    driveUpSpaceCount: z
                      .number()
                      .optional()
                      .describe(
                        'Available drive-up vehicle spaces. Zero means full — oversubscribed sailings report a negative count upstream and are floored to zero here, so this value is never negative.',
                      ),
                    reservableSpaceCount: z
                      .number()
                      .optional()
                      .describe(
                        'Available reservable vehicle spaces, floored at zero like driveUpSpaceCount. Zero means no reservable space remains.',
                      ),
                    maxSpaceCount: z
                      .number()
                      .optional()
                      .describe('Maximum vehicle capacity for this sailing.'),
                    driveUpSpaceHexColor: z
                      .string()
                      .optional()
                      .describe('Color code for drive-up space indicator (for UI rendering).'),
                  })
                  .describe('Space availability for one upcoming sailing.'),
              )
              .describe('Upcoming sailings and available vehicle spaces.'),
          })
          .describe('Space availability at one WSF terminal.'),
      )
      .describe('Terminal space availability by terminal.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total terminals matching the filter across all pages (not just this page). Counts terminals, not sailings.',
      ),
    nextOffset: z
      .number()
      .nullable()
      .describe('Offset to pass to retrieve the next page, or null when this is the last page.'),
    hasMore: z.boolean().describe('True when more terminals remain beyond the current page.'),
    terminalFilter: z
      .number()
      .optional()
      .describe('The terminal ID filter applied, or absent if no filter was used.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational note about the page window, or guidance when no terminal space data is available, the filter matched nothing, or the offset ran past the end.',
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
  ],

  async handler(input, ctx) {
    const all = await getFerryApiService().getTerminalSailingSpace(ctx);
    const filtered =
      input.departingTerminalId != null
        ? all.filter((t) => t.terminalId === input.departingTerminalId)
        : all;

    // Page the filtered set at the terminal level so structuredContent and content[] carry the
    // identical page and no terminal's sailings are split across two calls (the service stays
    // filter-only; paging is a tool-handler concern). totalCount stays the full match count.
    const totalCount = filtered.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const terminals = filtered.slice(offset, offset + limit);
    const hasMore = offset + terminals.length < totalCount;
    const nextOffset = hasMore ? offset + terminals.length : null;

    ctx.log.info('Terminal space fetched', {
      total: all.length,
      totalCount,
      offset,
      limit,
      returned: terminals.length,
    });

    ctx.enrich({
      totalCount,
      nextOffset,
      hasMore,
      ...(input.departingTerminalId != null && { terminalFilter: input.departingTerminalId }),
    });

    if (totalCount === 0) {
      ctx.enrich.notice(
        input.departingTerminalId != null
          ? `No terminal space data found for terminal ID ${input.departingTerminalId}. Use wsdot_get_ferry_terminals to verify valid terminal IDs.`
          : 'No terminal space data available. The WSF API may be temporarily unavailable — retry in 30 seconds.',
      );
    } else if (terminals.length === 0) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of ${totalCount} matching terminals. Use an offset between 0 and ${totalCount - 1}.`,
      );
    } else {
      const window = `Showing terminals ${offset + 1}–${offset + terminals.length} of ${totalCount}, each with all of its upcoming sailings.`;
      ctx.enrich.notice(
        hasMore ? `${window} Pass offset=${nextOffset} for the next page.` : window,
      );
    }

    return { terminals };
  },

  format: (result) => {
    if (result.terminals.length === 0) {
      return [{ type: 'text', text: 'No terminal space data available.' }];
    }
    const lines: string[] = [];
    for (const t of result.terminals) {
      const tId = t.terminalId != null ? ` (ID: ${t.terminalId})` : '';
      lines.push(`### ${t.terminalName ?? 'Terminal'}${tId}`);
      if (t.departingSpaces.length === 0) {
        lines.push('No upcoming sailings.');
      } else {
        for (const s of t.departingSpaces) {
          /**
           * Every sailing WSF publishes carries an explicit cancellation flag, so rendering
           * only the `true` case leaves `content[]` silent about a status `structuredContent`
           * states outright.
           */
          const cancelled =
            s.isCancelled === true
              ? ' [CANCELLED]'
              : s.isCancelled === false
                ? ' [not cancelled]'
                : '';
          const itinerary = s.itineraryLabel ? ` → ${s.itineraryLabel}` : '';
          const vessel = s.vesselName ? ` | ${s.vesselName}` : '';
          lines.push(`**${s.departure ?? 'Unknown'}**${itinerary}${vessel}${cancelled}`);
          if (s.arrivingTerminalIds) {
            lines.push(
              s.arrivingTerminalIds.length > 0
                ? `  arrivingTerminalIds: ${s.arrivingTerminalIds.join(', ')}`
                : '  arrivingTerminalIds: none listed',
            );
          }
          /**
           * The display flag and the count it describes are independently optional: nothing
           * upstream guarantees a cleared flag comes with a null count, so each is rendered on
           * its own terms rather than one gating the other. A set flag rides the count line
           * below when there is one; without a count it has nothing else to carry it.
           */
          if (s.displayDriveUpSpace === false) {
            lines.push('  Drive-up: not reported for this sailing (displayDriveUpSpace: false)');
          } else if (s.displayDriveUpSpace === true && s.driveUpSpaceCount == null) {
            lines.push(
              '  Drive-up: reported for this sailing, count absent (displayDriveUpSpace: true)',
            );
          }
          if (s.driveUpSpaceCount != null) {
            const full = s.driveUpSpaceCount <= 0 ? ' (FULL)' : '';
            lines.push(
              `  Drive-up: ${s.driveUpSpaceCount}${s.maxSpaceCount != null ? `/${s.maxSpaceCount}` : ''} spaces${full}`,
            );
          } else if (s.maxSpaceCount != null) {
            // Capacity otherwise rides the drive-up line, so a sailing reporting capacity with
            // no drive-up count (an empty SpaceForArrivalTerminals) would drop it from content[].
            lines.push(`  Capacity: ${s.maxSpaceCount} spaces`);
          }
          if (s.displayReservableSpace === false) {
            lines.push(
              '  Reservable: no reservations on this sailing (displayReservableSpace: false)',
            );
          } else if (s.displayReservableSpace === true && s.reservableSpaceCount == null) {
            lines.push(
              '  Reservable: reservations taken on this sailing, count absent (displayReservableSpace: true)',
            );
          }
          if (s.reservableSpaceCount != null) {
            const full = s.reservableSpaceCount <= 0 ? ' (FULL)' : '';
            lines.push(`  Reservable: ${s.reservableSpaceCount} spaces${full}`);
          }
          if (s.driveUpSpaceHexColor) {
            lines.push(`  Space color indicator: ${s.driveUpSpaceHexColor}`);
          }
        }
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
