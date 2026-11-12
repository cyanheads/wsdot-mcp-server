/**
 * @fileoverview Pins the tool-input surface every client sees: an argument the schema does not
 * declare is rejected by name rather than silently stripped, and the emitted schema says so in
 * the 2020-12 dialect. Both are wire-visible, and neither is expressible from a handler test —
 * a stripped key and a rejected key produce the same handler call, so only a parse-level
 * assertion separates them. Every tool is covered because the guarantee is the surface's, not
 * any one tool's. The `limit` each paged tool advertises is pinned here too, in both
 * WSDOT_CLAMP_LIMITS modes.
 * @module tests/tools/input-strictness.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBorderWaits,
  getFerryAlerts,
  getFerryFares,
  getFerryRoutes,
  getFerrySchedule,
  getFerryTerminals,
  getMountainPasses,
  getTerminalSpace,
  getTollRates,
  getTravelTimes,
  getVesselLocations,
  searchAlerts,
  searchCameras,
} from '@/mcp-server/tools/definitions/index.js';

/** Arguments that satisfy each tool's required fields, so only the extra key can fail the parse. */
const tools = [
  { tool: getBorderWaits, valid: {} },
  { tool: getFerryAlerts, valid: {} },
  {
    tool: getFerryFares,
    valid: {
      departingTerminalId: 1,
      arrivingTerminalId: 10,
      tripDate: '2026-11-13',
      roundTrip: true,
    },
  },
  { tool: getFerryRoutes, valid: { tripDate: '2026-08-25' } },
  {
    tool: getFerrySchedule,
    valid: { departingTerminalId: 7, arrivingTerminalId: 3, remainingOnly: true },
  },
  { tool: getFerryTerminals, valid: {} },
  { tool: getMountainPasses, valid: {} },
  { tool: getTerminalSpace, valid: { departingTerminalId: 7, offset: 0, limit: 5 } },
  { tool: getTollRates, valid: { stateRoute: 'SR 520', offset: 0, limit: 5 } },
  { tool: getTravelTimes, valid: { route: 'I-5', offset: 0, limit: 5 } },
  { tool: getVesselLocations, valid: {} },
  { tool: searchAlerts, valid: { stateRoute: 'I-90', region: 'Northwest', offset: 0, limit: 5 } },
  {
    tool: searchCameras,
    valid: {
      stateRoute: 'I-90',
      region: 'NW',
      titleContains: 'Snoqualmie',
      startMilepost: 50,
      endMilepost: 55,
      offset: 0,
      limit: 5,
    },
  },
] as const;

/** The single `unrecognized_keys` issue a strict object raises, or a failure naming what came back. */
function unrecognizedKeys(call: () => unknown): string[] {
  try {
    call();
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issue = error.issues.find((i) => i.code === 'unrecognized_keys');
    if (!issue) throw new Error(`Expected an unrecognized_keys issue, got: ${error.message}`);
    return [...issue.keys];
  }
  throw new Error('Expected the parse to reject the undeclared key, but it succeeded.');
}

describe('tool inputs are strict', () => {
  for (const { tool, valid } of tools) {
    it(`${tool.name} rejects an undeclared argument by name`, () => {
      expect(unrecognizedKeys(() => tool.input.parse({ ...valid, notAParameter: 'x' }))).toEqual([
        'notAParameter',
      ]);
    });

    it(`${tool.name} still accepts every argument it declares`, () => {
      expect(() => tool.input.parse(valid)).not.toThrow();
    });

    it(`${tool.name} advertises additionalProperties: false in the 2020-12 dialect`, () => {
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    });
  }

  it('names every undeclared key at once rather than stopping at the first', () => {
    expect(
      unrecognizedKeys(() => searchAlerts.input.parse({ route: 'I-5', milepost: 12 })),
    ).toEqual(['route', 'milepost']);
  });

  it('rejects a near-miss spelling of a real parameter instead of ignoring it', () => {
    // The failure mode strictness exists for: a stripped `state_route` silently returned every
    // alert in the state, which reads as a working call with a useless answer.
    expect(unrecognizedKeys(() => searchAlerts.input.parse({ state_route: 'I-90' }))).toEqual([
      'state_route',
    ]);
  });
});

/**
 * The `limit` a client reads from `tools/list` follows WSDOT_CLAMP_LIMITS: while clamping, no
 * `maximum` (a larger value is served at the cap and disclosed); with `false`, the cap. Read through
 * a JSON round trip, as a client receives it.
 */
describe('paged tools advertise limit per WSDOT_CLAMP_LIMITS', () => {
  const paged = [
    { tool: searchAlerts, maximum: 500 },
    { tool: searchCameras, maximum: 500 },
    { tool: getTravelTimes, maximum: 500 },
    { tool: getTollRates, maximum: 500 },
    { tool: getTerminalSpace, maximum: 20 },
  ] as const;

  const advertisedLimit = (tool: (typeof paged)[number]['tool']) =>
    JSON.parse(JSON.stringify(z.toJSONSchema(tool.input, { io: 'input' }))).properties.limit as {
      description: string;
      maximum?: number;
      minimum: number;
    };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists exactly the five paged tools as taking a limit', () => {
    const withLimit = tools.filter(
      ({ tool }) => 'limit' in (z.toJSONSchema(tool.input, { io: 'input' }).properties ?? {}),
    );
    expect(withLimit.map(({ tool }) => tool.name).sort()).toEqual(
      paged.map(({ tool }) => tool.name).sort(),
    );
  });

  for (const { tool, maximum } of paged) {
    it.each([
      ['unset', undefined],
      ['true', 'true'],
    ])(`${tool.name} advertises no maximum while WSDOT_CLAMP_LIMITS is %s`, (_mode, flag) => {
      vi.stubEnv('WSDOT_CLAMP_LIMITS', flag);
      const limit = advertisedLimit(tool);
      expect(limit.maximum).toBeUndefined();
      expect(limit.minimum).toBe(1);
      expect(limit.description).toContain(`a larger value returns at most ${maximum} and says so.`);
    });

    it(`${tool.name} advertises maximum ${maximum} with WSDOT_CLAMP_LIMITS=false`, () => {
      vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
      const limit = advertisedLimit(tool);
      expect(limit.maximum).toBe(maximum);
      expect(limit.minimum).toBe(1);
      expect(limit.description).toContain(`(1–${maximum})`);
    });
  }
});
