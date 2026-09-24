/**
 * @fileoverview Wire-level blank-string parity for `wsdot_get_mountain_passes` and
 * `wsdot_get_ferry_terminals`. Only the upstream HTTP boundary is stubbed: the real services
 * normalize the payload, and `runToolContract` carries it through output-schema validation,
 * `format()`, and enrichment, so each assertion is about what a client receives on both surfaces.
 * @module tests/tools/blank-string-wire.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ accessCode: 'test-access-code' }),
}));

import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { getMountainPasses } from '@/mcp-server/tools/definitions/get-mountain-passes.tool.js';
import { initFerryApiService } from '@/services/ferry/ferry-service.js';
import { initTrafficApiService } from '@/services/traffic/traffic-service.js';

const PASSES_ENDPOINT =
  /\/Traffic\/api\/MountainPassConditions\/MountainPassConditionsREST\.svc\/GetMountainPassConditionsAsJson\?/;
const TERMINALS_ENDPOINT = /\/Ferries\/API\/Terminals\/rest\/terminallocations\?/;

const http = createFetchMock();

beforeEach(() => {
  initTrafficApiService({} as never, {} as never);
  initFerryApiService({} as never, {} as never);
  http.reset();
  http.install();
});

afterEach(() => {
  http.restore();
});

/** Every text block of a contract result, joined. */
function wireText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/** The `required` list of the array items under `field` in a tool's advertised output schema. */
function requiredItemFields(output: z.ZodType, field: string): string[] {
  const property = z.toJSONSchema(output).properties?.[field];
  const items = typeof property === 'object' ? property.items : undefined;
  if (typeof items !== 'object' || Array.isArray(items)) {
    throw new Error(`Expected an array schema under "${field}".`);
  }
  return items.required ?? [];
}

interface WirePass {
  mountainPassId?: number;
  mountainPassName?: string;
  weatherCondition?: string;
}

interface WireTerminal {
  terminalId?: number;
  terminalName?: string;
}

describe('wsdot_get_mountain_passes — blank upstream strings on the wire', () => {
  it('carries a blank WeatherCondition on neither surface and a populated one on both', async () => {
    http.route({
      match: PASSES_ENDPOINT,
      respond: Response.json([
        { MountainPassId: 11, MountainPassName: 'Snoqualmie Pass', WeatherCondition: '' },
        { MountainPassId: 12, MountainPassName: 'Stevens Pass', WeatherCondition: ' \t ' },
        { MountainPassId: 13, MountainPassName: 'White Pass', WeatherCondition: 'Snowing ' },
      ]),
    });
    const result = await runToolContract(getMountainPasses, {});
    expect(result.isError).toBeFalsy();

    const { passes } = result.structuredContent as { passes: WirePass[] };
    const structuredWeather = passes.filter((p) => 'weatherCondition' in p);
    const renderedWeather = wireText(result).match(/\*\*Weather:\*\*/g) ?? [];
    expect(structuredWeather).toEqual([
      { mountainPassId: 13, mountainPassName: 'White Pass', weatherCondition: 'Snowing' },
    ]);
    expect(renderedWeather).toHaveLength(structuredWeather.length);
    expect(wireText(result)).toContain('### White Pass\n**Weather:** Snowing\n');
  });

  it('keeps a pass with no ID or name, fabricating neither, and renders its fields on both surfaces', async () => {
    http.route({
      match: PASSES_ENDPOINT,
      respond: Response.json([
        { MountainPassId: 11, MountainPassName: 'Snoqualmie Pass', RoadCondition: 'Wet' },
        { MountainPassName: '  ', TemperatureInFahrenheit: 28, RoadCondition: 'Compact snow' },
      ]),
    });
    const result = await runToolContract(getMountainPasses, {});
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as { passes: WirePass[]; totalCount: number };
    expect(structured.totalCount).toBe(2);
    expect(structured.passes[1]).toEqual({
      temperatureInFahrenheit: 28,
      roadCondition: 'Compact snow',
    });
    expect(JSON.stringify(structured)).not.toContain('Unknown');

    const text = wireText(result);
    expect(text).toContain('### Mountain pass\n**Temperature:** 28°F\n**Road:** Compact snow\n');
    expect(text).not.toContain('**ID:** 0');
    expect(text).not.toContain('Unknown');
    expect(text).not.toContain('undefined');
  });

  it('answers an empty feed with an empty list and a notice on both surfaces', async () => {
    http.route({ match: PASSES_ENDPOINT, respond: Response.json([]) });
    const result = await runToolContract(getMountainPasses, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ passes: [], totalCount: 0 });
    expect((result.structuredContent as { notice?: string }).notice).toContain('No mountain pass');
    expect(wireText(result)).toContain('No mountain pass data available.');
  });

  it('advertises every pass field as optional, the ID and name included', () => {
    expect(requiredItemFields(getMountainPasses.output, 'passes')).toEqual([]);
  });
});

describe('wsdot_get_ferry_terminals — blank and padded upstream strings on the wire', () => {
  it('trims the padded Coupeville name on both surfaces, keeping the bold intact', async () => {
    http.route({
      match: TERMINALS_ENDPOINT,
      respond: Response.json([
        {
          TerminalID: 11,
          TerminalName: 'Coupeville ',
          TerminalAbbrev: 'COU',
          Latitude: 48.1597,
          Longitude: -122.6725,
        },
        { TerminalID: 3, TerminalName: 'Bainbridge Island', TerminalAbbrev: 'BI' },
      ]),
    });
    const result = await runToolContract(getFerryTerminals, {});
    expect(result.isError).toBeFalsy();

    const { terminals } = result.structuredContent as { terminals: WireTerminal[] };
    expect(terminals.map((t) => t.terminalName)).toEqual(['Coupeville', 'Bainbridge Island']);

    const text = wireText(result);
    expect(text).toContain('- **Coupeville** (COU) — ID: 11 | 48.1597, -122.6725');
    expect(text).toContain('- **Bainbridge Island** (BI) — ID: 3');
    expect(text).not.toContain('**Coupeville **');
  });

  it('keeps a terminal with no ID or name, fabricating neither, and renders its fields on both surfaces', async () => {
    http.route({
      match: TERMINALS_ENDPOINT,
      respond: Response.json([
        { TerminalID: 3, TerminalName: 'Bainbridge Island' },
        { TerminalName: '', TerminalAbbrev: 'XX', Latitude: 47.6, Longitude: -122.5 },
      ]),
    });
    const result = await runToolContract(getFerryTerminals, {});
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as { terminals: WireTerminal[] };
    expect(structured.terminals[1]).toEqual({
      terminalAbbrev: 'XX',
      latitude: 47.6,
      longitude: -122.5,
    });
    expect(JSON.stringify(structured)).not.toContain('Unknown');

    const text = wireText(result);
    expect(text).toContain('- **Terminal** (XX) — 47.6, -122.5');
    expect(text).not.toContain('ID: 0');
    expect(text).not.toContain('Unknown');
    expect(text).not.toContain('undefined');
  });

  it('advertises every terminal field as optional, the ID and name included', () => {
    expect(requiredItemFields(getFerryTerminals.output, 'terminals')).toEqual([]);
  });
});
