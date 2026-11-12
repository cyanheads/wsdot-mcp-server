/**
 * @fileoverview WSDOT_CLAMP_LIMITS parsing: the default, the boolean words it accepts, an invalid
 * value failing with the variable named, a fresh read on every call, and independence from
 * WSDOT_ACCESS_CODE, so listing tools needs no credential.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampLimitsEnabled } from '@/config/server-config.js';
import { rejection } from '../helpers/assertions.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('clampLimitsEnabled', () => {
  it.each([
    ['unset', undefined, true],
    ['blank', '', true],
    ['true', 'true', true],
    ['on', 'on', true],
    ['false', 'false', false],
    ['0', '0', false],
    ['NO', 'NO', false],
  ])('reads %s as %s', (_label, value, expected) => {
    vi.stubEnv('WSDOT_CLAMP_LIMITS', value);
    expect(clampLimitsEnabled()).toBe(expected);
  });

  it('rejects a value that is not a boolean word with a configuration error naming the variable', async () => {
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'maybe');
    const error = (await rejection(() => clampLimitsEnabled())) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toContain('WSDOT_CLAMP_LIMITS');
  });

  it('reads the environment again on every call', () => {
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
    expect(clampLimitsEnabled()).toBe(false);
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'true');
    expect(clampLimitsEnabled()).toBe(true);
  });

  it('needs no WSDOT_ACCESS_CODE', () => {
    vi.stubEnv('WSDOT_ACCESS_CODE', undefined);
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
    expect(clampLimitsEnabled()).toBe(false);
  });
});
