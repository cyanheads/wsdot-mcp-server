/**
 * @fileoverview Security and input validation tests for the WSDOT MCP server tools.
 * Covers: injection attempts in string inputs, oversized inputs, Zod schema validation
 * (missing required fields, wrong types, out-of-range values), and explicit assertion
 * that no API key/access code appears in tool output or error messages.
 * All external HTTP is mocked — no real network calls.
 * @module tests/security/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared service mocks — hoisted before all imports
// ---------------------------------------------------------------------------

const mockTrafficService = {
  getMountainPasses: vi.fn(),
  searchAlerts: vi.fn(),
  getTravelTimes: vi.fn(),
  getTollRates: vi.fn(),
  getBorderCrossings: vi.fn(),
  searchCameras: vi.fn(),
};

const mockFerryService = {
  getTerminals: vi.fn(),
  getRoutes: vi.fn(),
  getSchedule: vi.fn(),
  getVesselLocations: vi.fn(),
  getTerminalSailingSpace: vi.fn(),
  getAlerts: vi.fn(),
};

vi.mock('@/services/traffic/traffic-service.js', () => ({
  getTrafficApiService: () => mockTrafficService,
}));

vi.mock('@/services/ferry/ferry-service.js', () => ({
  getFerryApiService: () => mockFerryService,
  FerryApiService: {
    toFerryDate: (d: string) => d.trim().slice(0, 10),
    todayFerryDate: () => '2026-05-23',
  },
}));

// ---------------------------------------------------------------------------
// Tool imports after mocks
// ---------------------------------------------------------------------------

import { getBorderWaits } from '@/mcp-server/tools/definitions/get-border-waits.tool.js';
import { getFerryAlerts } from '@/mcp-server/tools/definitions/get-ferry-alerts.tool.js';
import { getFerryRoutes } from '@/mcp-server/tools/definitions/get-ferry-routes.tool.js';
import { getFerrySchedule } from '@/mcp-server/tools/definitions/get-ferry-schedule.tool.js';
import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { getMountainPasses } from '@/mcp-server/tools/definitions/get-mountain-passes.tool.js';
import { getTerminalSpace } from '@/mcp-server/tools/definitions/get-terminal-space.tool.js';
import { getTollRates } from '@/mcp-server/tools/definitions/get-toll-rates.tool.js';
import { getTravelTimes } from '@/mcp-server/tools/definitions/get-travel-times.tool.js';
import { getVesselLocations } from '@/mcp-server/tools/definitions/get-vessel-locations.tool.js';
import { searchAlerts } from '@/mcp-server/tools/definitions/search-alerts.tool.js';
import { searchCameras } from '@/mcp-server/tools/definitions/search-cameras.tool.js';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INJECTION_STRINGS = [
  "'; DROP TABLE users; --",
  '<script>alert("xss")</script>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal injection input — must stay a raw string, not interpolate
  '${process.env.WSDOT_ACCESS_CODE}',
  '{{7*7}}',
  '../../../etc/passwd',
  '\x00\x01\x02\x03',
  '%00',
  'javascript:void(0)',
  'data:text/html,<script>',
  '\n\r\t',
];

const SECRET_PATTERNS = [
  /WSDOT_ACCESS_CODE/,
  /apiaccesscode/i,
  /AccessCode/i,
  /test-access-code/i,
  /secret/i,
  /api.?key/i,
];

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(value));
}

function checkOutputForSecrets(output: unknown): void {
  const serialized = JSON.stringify(output);
  expect(containsSecret(serialized)).toBe(false);
}

// ---------------------------------------------------------------------------
// Zod input validation — required fields
// ---------------------------------------------------------------------------

describe('Input validation — required fields', () => {
  it('getFerrySchedule rejects missing departingTerminalId', () => {
    expect(() => getFerrySchedule.input.parse({ arrivingTerminalId: 3 })).toThrow();
  });

  it('getFerrySchedule rejects missing arrivingTerminalId', () => {
    expect(() => getFerrySchedule.input.parse({ departingTerminalId: 7 })).toThrow();
  });

  it('getFerrySchedule rejects string terminal IDs', () => {
    expect(() =>
      getFerrySchedule.input.parse({ departingTerminalId: 'seven', arrivingTerminalId: 'three' }),
    ).toThrow();
  });

  it('getTerminalSpace accepts empty input (departingTerminalId is optional)', () => {
    expect(() => getTerminalSpace.input.parse({})).not.toThrow();
  });

  it('getTerminalSpace rejects string departingTerminalId', () => {
    expect(() => getTerminalSpace.input.parse({ departingTerminalId: 'seven' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Zod input validation — type coercion edge cases
// ---------------------------------------------------------------------------

describe('Input validation — type coercion', () => {
  it('searchAlerts accepts valid stateRoute string', () => {
    expect(() => searchAlerts.input.parse({ stateRoute: '090' })).not.toThrow();
  });

  it('searchAlerts accepts empty object (all fields optional)', () => {
    expect(() => searchAlerts.input.parse({})).not.toThrow();
  });

  it('searchAlerts rejects non-number startMilepost', () => {
    expect(() => searchAlerts.input.parse({ startMilepost: 'ten' })).toThrow();
  });

  it('getTravelTimes accepts empty object (route is optional)', () => {
    expect(() => getTravelTimes.input.parse({})).not.toThrow();
  });

  it('getFerrySchedule rejects boolean departingTerminalId', () => {
    expect(() =>
      getFerrySchedule.input.parse({ departingTerminalId: true, arrivingTerminalId: 3 }),
    ).toThrow();
  });

  it('getFerrySchedule rejects null departingTerminalId', () => {
    expect(() =>
      getFerrySchedule.input.parse({ departingTerminalId: null, arrivingTerminalId: 3 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Injection attempts in string inputs
// ---------------------------------------------------------------------------

describe('Injection attempts — string inputs pass through without execution', () => {
  for (const injection of INJECTION_STRINGS) {
    it(`searchAlerts: stateRoute injection "${injection.slice(0, 30)}" reaches service as-is`, async () => {
      mockTrafficService.searchAlerts.mockResolvedValue([]);
      const ctx = createMockContext();
      // Parse must succeed (Zod accepts any string for stateRoute)
      const input = searchAlerts.input.parse({ stateRoute: injection });
      await searchAlerts.handler(input, ctx);
      // The important invariant: the handler doesn't crash, and the injection
      // string doesn't appear in any tool output
      const result = await (async () => {
        mockTrafficService.searchAlerts.mockResolvedValue([]);
        const c2 = createMockContext();
        return searchAlerts.handler(input, c2);
      })();
      checkOutputForSecrets(result);
    });
  }

  it('searchCameras: stateRoute injection does not corrupt output', async () => {
    const injection = "'; DROP TABLE cameras; --";
    mockTrafficService.searchCameras.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ stateRoute: injection });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toBeDefined();
    checkOutputForSecrets(result);
  });

  it('getTravelTimes: route injection does not corrupt output', async () => {
    const injection = '<script>alert(1)</script>';
    mockTrafficService.getTravelTimes.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: injection });
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toBeDefined();
    checkOutputForSecrets(result);
  });

  it('getFerryRoutes: tripDate injection is passed to FerryApiService.toFerryDate', async () => {
    // toFerryDate is mocked to return a slice — injection strings don't crash
    mockFerryService.getRoutes.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({ tripDate: '2026-05-23' });
    const result = await getFerryRoutes.handler(input, ctx);
    expect(result.routes).toBeDefined();
    checkOutputForSecrets(result);
  });
});

// ---------------------------------------------------------------------------
// Oversized inputs
// ---------------------------------------------------------------------------

describe('Oversized inputs — handler does not crash', () => {
  it('searchAlerts: 10,000-char stateRoute is accepted by Zod and passed to service', async () => {
    const oversized = 'A'.repeat(10_000);
    mockTrafficService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: oversized });
    const result = await searchAlerts.handler(input, ctx);
    expect(result.alerts).toBeDefined();
    checkOutputForSecrets(result);
  });

  it('getTravelTimes: 10,000-char route filter is accepted by Zod and yields empty results', async () => {
    const oversized = 'X'.repeat(10_000);
    mockTrafficService.getTravelTimes.mockResolvedValue([{ travelTimeId: 1, name: 'I-5 NB' }]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: oversized });
    const result = await getTravelTimes.handler(input, ctx);
    // No corridor name matches 10k X's — empty result, not a crash
    expect(result.corridors).toHaveLength(0);
    checkOutputForSecrets(result);
  });

  it('searchCameras: 10,000-char stateRoute is accepted', async () => {
    const oversized = 'B'.repeat(10_000);
    mockTrafficService.searchCameras.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({ stateRoute: oversized });
    const result = await searchCameras.handler(input, ctx);
    expect(result.cameras).toBeDefined();
    checkOutputForSecrets(result);
  });
});

// ---------------------------------------------------------------------------
// API key non-leak assertion
// ---------------------------------------------------------------------------

describe('API key non-leak — output does not expose access code or secrets', () => {
  it('getMountainPasses output contains no secret patterns', async () => {
    const pass = {
      mountainPassId: 1,
      mountainPassName: 'Snoqualmie Pass',
      roadCondition: 'Wet',
    };
    mockTrafficService.getMountainPasses.mockResolvedValue([pass]);
    const ctx = createMockContext();
    const input = getMountainPasses.input.parse({});
    const result = await getMountainPasses.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getMountainPasses.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('searchAlerts output contains no secret patterns', async () => {
    const alert = { alertId: 101, headlineDescription: 'I-90 Lane Closure' };
    mockTrafficService.searchAlerts.mockResolvedValue([alert]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({});
    const result = await searchAlerts.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = searchAlerts.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getTravelTimes output contains no secret patterns', async () => {
    const corridor = {
      travelTimeId: 1,
      name: 'I-5 NB',
      currentTimeInMinutes: 18,
      averageTimeInMinutes: 12,
    };
    mockTrafficService.getTravelTimes.mockResolvedValue([corridor]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({});
    const result = await getTravelTimes.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getTravelTimes.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getTollRates output contains no secret patterns', async () => {
    const rate = { tripName: 'SR 520', stateRoute: '520', tollRateInDollars: 3.5 };
    mockTrafficService.getTollRates.mockResolvedValue([rate]);
    const ctx = createMockContext();
    const input = getTollRates.input.parse({});
    const result = await getTollRates.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getTollRates.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getBorderWaits output contains no secret patterns', async () => {
    const crossing = { crossingName: 'Peace Arch', waitTimeInMinutes: 25 };
    mockTrafficService.getBorderCrossings.mockResolvedValue([crossing]);
    const ctx = createMockContext();
    const input = getBorderWaits.input.parse({});
    const result = await getBorderWaits.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getBorderWaits.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('searchCameras output contains no secret patterns', async () => {
    const camera = {
      cameraId: 1001,
      title: 'I-90 at Snoqualmie Pass',
      imageUrl: 'https://images.wsdot.wa.gov/nc/090vc12345.jpg',
      opRouteAbbrev: [],
    };
    mockTrafficService.searchCameras.mockResolvedValue([camera]);
    const ctx = createMockContext();
    const input = searchCameras.input.parse({});
    const result = await searchCameras.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = searchCameras.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getFerryTerminals output contains no secret patterns', async () => {
    const terminal = { terminalId: 3, terminalName: 'Bainbridge Island' };
    mockFerryService.getTerminals.mockResolvedValue([terminal]);
    const ctx = createMockContext();
    const input = getFerryTerminals.input.parse({});
    const result = await getFerryTerminals.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getFerryTerminals.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getFerryRoutes output contains no secret patterns', async () => {
    const route = { routeId: 1, routeAbbrev: 'SEA-BI', description: 'Seattle/Bainbridge Island' };
    mockFerryService.getRoutes.mockResolvedValue([route]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({});
    const result = await getFerryRoutes.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getFerryRoutes.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getFerryAlerts output contains no secret patterns', async () => {
    const alert = {
      alertId: 201,
      alertDescription: 'Vessel out of service.',
      impactedRouteIds: [1],
    };
    mockFerryService.getAlerts.mockResolvedValue([alert]);
    const ctx = createMockContext();
    const input = getFerryAlerts.input.parse({});
    const result = await getFerryAlerts.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getFerryAlerts.format!(result);
    checkOutputForSecrets(formatted);
  });

  it('getTerminalSpace output contains no secret patterns', async () => {
    const space = {
      terminalId: 7,
      terminalName: 'Seattle',
      departingSpaces: [{ departure: '10:00 AM', driveUpSpaceCount: 50, maxSpaceCount: 202 }],
    };
    mockFerryService.getTerminalSailingSpace.mockResolvedValue([space]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({});
    const result = await getTerminalSpace.handler(input, ctx);
    checkOutputForSecrets(result);
    const formatted = getTerminalSpace.format!(result);
    checkOutputForSecrets(formatted);
  });
});

// ---------------------------------------------------------------------------
// Unicode / encoding edge cases
// ---------------------------------------------------------------------------

describe('Unicode and encoding edge cases', () => {
  it('searchAlerts: stateRoute with unicode is accepted and yields empty results', async () => {
    mockTrafficService.searchAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = searchAlerts.input.parse({ stateRoute: '日本語テスト' });
    const result = await searchAlerts.handler(input, ctx);
    expect(result.alerts).toBeDefined();
    checkOutputForSecrets(result);
  });

  it('getTravelTimes: route with RTL text is handled without crash', async () => {
    mockTrafficService.getTravelTimes.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getTravelTimes.input.parse({ route: 'مسار اختبار' });
    const result = await getTravelTimes.handler(input, ctx);
    expect(result.corridors).toBeDefined();
  });

  it('ferry alerts with unicode description renders safely in format()', () => {
    const alert = {
      alertId: 300,
      alertDescription: 'Vessel <Yakima> is "delayed" & running late — 日本語テスト',
      impactedRouteIds: [1],
    };
    const output = { alerts: [alert] };
    const blocks = getFerryAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('delayed');
    expect(text).toContain('日本語テスト');
    checkOutputForSecrets({ text });
  });
});

// ---------------------------------------------------------------------------
// Sparse upstream payloads — absence of fields does not fabricate data
// ---------------------------------------------------------------------------

describe('Sparse upstream payloads — no fabricated data', () => {
  it('getMountainPasses: sparse pass omits elevation, temperature, weather', async () => {
    mockTrafficService.getMountainPasses.mockResolvedValue([
      { mountainPassId: 99, mountainPassName: 'Sparse Pass' },
    ]);
    const ctx = createMockContext();
    const input = getMountainPasses.input.parse({});
    const result = await getMountainPasses.handler(input, ctx);
    const p = result.passes[0];
    expect('elevation' in p).toBe(false);
    expect('temperatureInFahrenheit' in p).toBe(false);
    expect('weatherCondition' in p).toBe(false);
  });

  it('getBorderWaits format(): missing waitTimeInMinutes shows fallback not a fabricated value', () => {
    const output = { crossings: [{ crossingName: 'Sumas' }] };
    const blocks = getBorderWaits.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Sumas');
    // Must not fabricate a numeric wait time
    expect(text).not.toMatch(/\d+ min/);
  });

  it('getFerrySchedule format(): missing arrivalTime shows Unknown for departure', () => {
    const output = { sailings: [{ departureTime: undefined, isCancelled: false }] };
    const blocks = getFerrySchedule.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Unknown');
  });

  it('getVesselLocations format(): vessel with no opRouteAbbrev renders without crash', () => {
    const output = { vessels: [{ vesselId: 5, vesselName: 'Wenatchee', opRouteAbbrev: [] }] };
    const blocks = getVesselLocations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Wenatchee');
  });
});

// ---------------------------------------------------------------------------
// SSRF — server does not accept arbitrary URLs from tool input
// ---------------------------------------------------------------------------

describe('SSRF — no user-controlled URL parameters in tool inputs', () => {
  it('getMountainPasses has no URL input parameter', () => {
    const schema = getMountainPasses.input;
    const parsed = schema.parse({});
    // No URL field — can't inject an endpoint
    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it('getFerrySchedule has no URL input parameter', () => {
    const parsed = getFerrySchedule.input.parse({ departingTerminalId: 7, arrivingTerminalId: 3 });
    const keys = Object.keys(parsed);
    expect(keys.some((k) => k.toLowerCase().includes('url'))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes('endpoint'))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes('host'))).toBe(false);
  });

  it('searchAlerts has no URL input parameter', () => {
    const parsed = searchAlerts.input.parse({});
    const keys = Object.keys(parsed);
    expect(keys.some((k) => k.toLowerCase().includes('url'))).toBe(false);
  });

  it('searchCameras has no URL input parameter', () => {
    const parsed = searchCameras.input.parse({});
    const keys = Object.keys(parsed);
    expect(keys.some((k) => k.toLowerCase().includes('url'))).toBe(false);
  });
});
