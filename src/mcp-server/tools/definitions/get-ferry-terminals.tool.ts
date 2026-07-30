/**
 * @fileoverview Tool to list all WSF ferry terminals with their numeric IDs.
 * @module mcp-server/tools/definitions/get-ferry-terminals.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFerryApiService } from '@/services/ferry/ferry-service.js';

export const getFerryTerminals = tool('wsdot_get_ferry_terminals', {
  title: 'Get Ferry Terminals',
  description:
    'Returns all WSF ferry terminals with their numeric IDs, names, and abbreviations. ' +
    'Call this first to resolve human-readable terminal names (e.g. "Bainbridge Island", ' +
    '"Seattle", "Kingston") to the numeric terminal IDs required by the schedule and space tools. ' +
    'The terminal list is small (~22 terminals) and rarely changes.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    terminals: z
      .array(
        z
          .object({
            terminalId: z
              .number()
              .describe('Numeric terminal ID used in schedule and space API calls.'),
            terminalName: z.string().describe('Full terminal name (e.g. "Bainbridge Island").'),
            terminalAbbrev: z.string().optional().describe('Short abbreviation (e.g. "BI").'),
            latitude: z.number().optional().describe('Terminal latitude.'),
            longitude: z.number().optional().describe('Terminal longitude.'),
          })
          .describe('A WSF ferry terminal with its ID and location.'),
      )
      .describe('All WSF ferry terminals.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of terminals returned.'),
    notice: z
      .string()
      .optional()
      .describe('Optional notice when no terminal data is available. Absent on normal results.'),
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
    const terminals = await getFerryApiService().getTerminals(ctx);
    ctx.log.info('Ferry terminals fetched', { count: terminals.length });

    ctx.enrich({ totalCount: terminals.length });
    if (terminals.length === 0) {
      ctx.enrich.notice(
        'No terminal data available. The WSF API may be temporarily unavailable — retry in 30 seconds.',
      );
    }

    return { terminals };
  },

  format: (result) => {
    if (result.terminals.length === 0) {
      return [{ type: 'text', text: 'No ferry terminal data available.' }];
    }
    const lines: string[] = [];
    for (const t of result.terminals) {
      const abbrev = t.terminalAbbrev ? ` (${t.terminalAbbrev})` : '';
      const coords =
        t.latitude != null && t.longitude != null ? ` | ${t.latitude}, ${t.longitude}` : '';
      lines.push(`- **${t.terminalName}**${abbrev} — ID: ${t.terminalId}${coords}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
