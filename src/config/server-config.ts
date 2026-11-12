/**
 * @fileoverview Server-specific environment variable configuration for wsdot-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  accessCode: z
    .string()
    .describe('WSDOT Traveler API access code. Used for both traffic and ferry endpoints.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    accessCode: 'WSDOT_ACCESS_CODE',
  });
  return _config;
}

const LimitClampSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      "Clamp a paged tool's limit above its maximum to that maximum, with a notice; false rejects it.",
    ),
});

/**
 * Whether the paged tools clamp an over-maximum `limit` (WSDOT_CLAMP_LIMITS, default true).
 * Parsed on every call and never cached: the `limit` schemas read it when `tool()` emits them at
 * module load, which under Node precedes the framework loading `.env`, so a cached read would
 * ignore a flag set only there. Kept apart from {@link getServerConfig} so listing tools needs no
 * WSDOT_ACCESS_CODE.
 *
 * @throws ConfigurationError naming WSDOT_CLAMP_LIMITS when the value is not a boolean word.
 */
export function clampLimitsEnabled(): boolean {
  return parseEnvConfig(LimitClampSchema, { clampLimits: 'WSDOT_CLAMP_LIMITS' }).clampLimits;
}
