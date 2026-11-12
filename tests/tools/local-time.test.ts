/**
 * @fileoverview Tests for the shared ferry-time renderer used by the ferry tools' `format()`.
 * @module tests/tools/local-time.test
 */

import { describe, expect, it } from 'vitest';

import { localThenUtc } from '@/mcp-server/tools/local-time.js';

describe('localThenUtc', () => {
  it('renders the Pacific form first and the UTC instant in parentheses', () => {
    expect(localThenUtc('2026-11-05T13:30:00.000Z', '2026-11-05T05:30:00.000-08:00')).toBe(
      '2026-11-05T05:30:00.000-08:00 (2026-11-05T13:30:00.000Z)',
    );
  });

  it('renders the UTC value alone when there is no Pacific form', () => {
    expect(localThenUtc('6:00 AM')).toBe('6:00 AM');
    expect(localThenUtc('6:00 AM', undefined)).toBe('6:00 AM');
  });
});
