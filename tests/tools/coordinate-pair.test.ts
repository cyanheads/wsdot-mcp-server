/**
 * @fileoverview Tests for the shared coordinate-pair renderer used by every tool `format()`.
 * @module tests/tools/coordinate-pair.test
 */

import { describe, expect, it } from 'vitest';

import { coordinatePair } from '@/mcp-server/tools/coordinate-pair.js';

describe('coordinatePair', () => {
  it('renders both sides at full upstream precision', () => {
    expect(coordinatePair(48.542482, -122.989813)).toBe('48.542482, -122.989813');
  });

  it('keeps a populated latitude when the longitude is absent', () => {
    expect(coordinatePair(47.6237, undefined)).toBe('47.6237, longitude not reported');
  });

  it('keeps a populated longitude when the latitude is absent', () => {
    expect(coordinatePair(undefined, -122.5112)).toBe('latitude not reported, -122.5112');
  });

  it('returns undefined only when neither side is present', () => {
    expect(coordinatePair(undefined, undefined)).toBeUndefined();
  });

  it('renders a zero coordinate rather than treating it as absent', () => {
    // 0 is falsy but a real position — a truthiness guard would drop the equator and the
    // prime meridian from content[] while structuredContent kept them.
    expect(coordinatePair(0, 0)).toBe('0, 0');
    expect(coordinatePair(0, undefined)).toBe('0, longitude not reported');
  });
});
