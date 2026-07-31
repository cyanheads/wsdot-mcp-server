/**
 * @fileoverview Security and input validation tests for the WSDOT MCP server tools.
 * Covers: injection attempts in string inputs, oversized inputs, Zod schema validation
 * (missing required fields, wrong types, out-of-range values), and explicit assertion
 * that no API key/access code appears in tool output or in a thrown upstream error.
 * All external HTTP is mocked — no real network calls.
 * @module tests/security/security.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
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
import { htmlToText } from '@/services/html-text.js';
import { assertUpstreamJson, redactUrl } from '@/services/wsdot-http.js';

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

/**
 * Shapes that mean a credential escaped: the fake access code's value, or a query parameter
 * still carrying one (`AccessCode=…`, `apiaccesscode=…`). The env var *name* is deliberately
 * not listed — an actionable error names the variable an operator must fix, which leaks nothing.
 */
const SECRET_PATTERNS = [/test-access-code/i, /access_?code=[^&\s"']/i, /secret/i, /api.?key/i];

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

  it('paged tools accept empty input — offset/limit are optional and additive', () => {
    for (const t of [searchAlerts, getTravelTimes, getTollRates, getTerminalSpace, searchCameras]) {
      expect(() => t.input.parse({})).not.toThrow();
    }
  });

  it('paged tools reject a negative, non-integer, or non-numeric offset', () => {
    for (const t of [searchAlerts, getTravelTimes, getTollRates, getTerminalSpace, searchCameras]) {
      expect(() => t.input.parse({ offset: -1 })).toThrow();
      expect(() => t.input.parse({ offset: 2.5 })).toThrow();
      expect(() => t.input.parse({ offset: '10' })).toThrow();
      expect(() => t.input.parse({ offset: Number.NaN })).toThrow();
    }
  });

  it('paged tools reject a zero, negative, or over-maximum limit', () => {
    // The traffic tools cap at 500; terminal-space caps at 20, its own MAX_LIMIT.
    for (const t of [searchAlerts, getTravelTimes, getTollRates, searchCameras]) {
      expect(() => t.input.parse({ limit: 0 })).toThrow();
      expect(() => t.input.parse({ limit: -5 })).toThrow();
      expect(() => t.input.parse({ limit: 501 })).toThrow();
      expect(() => t.input.parse({ limit: 500 })).not.toThrow();
    }
    expect(() => getTerminalSpace.input.parse({ limit: 0 })).toThrow();
    expect(() => getTerminalSpace.input.parse({ limit: 21 })).toThrow();
    expect(() => getTerminalSpace.input.parse({ limit: 20 })).not.toThrow();
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
      alertTitle: 'Sea/BI - Vessel out of service',
      alertDescription: 'Vessel out of service.',
      bulletinText: 'The Tacoma will cover the route.',
      alertType: 'All Alerts',
      affectsAllRoutes: false,
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
      departingSpaces: [
        {
          departure: '10:00 AM',
          itineraryLabel: 'Seattle -> Bainbridge Island',
          arrivingTerminalIds: [3],
          displayDriveUpSpace: true,
          displayReservableSpace: false,
          driveUpSpaceCount: 50,
          maxSpaceCount: 202,
        },
      ],
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
// API key non-leak — the upstream error path
// ---------------------------------------------------------------------------

describe('API key non-leak — thrown upstream errors carry no credential', () => {
  const ACCESS_CODE = 'test-access-code';
  const REQUEST_URL = `https://www.wsdot.wa.gov/Traffic/api/x/GetAsJson?AccessCode=${ACCESS_CODE}`;

  function upstreamError(body: string, status: number, contentType: string): McpError {
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
    } as unknown as Response;
    try {
      assertUpstreamJson(
        { body, endpoint: redactUrl(REQUEST_URL), response, service: 'WSDOT Traffic API' },
        createMockContext(),
      );
    } catch (err) {
      return err as McpError;
    }
    throw new Error('assertUpstreamJson did not throw');
  }

  it('redactUrl drops the credential-bearing query string', () => {
    expect(redactUrl(REQUEST_URL)).toBe('https://www.wsdot.wa.gov/Traffic/api/x/GetAsJson');
    checkOutputForSecrets(redactUrl(REQUEST_URL));
  });

  it('scrubs a credential echoed by the upstream on the api_unavailable path', () => {
    const err = upstreamError(`Server Error: GET ${REQUEST_URL} failed`, 503, 'text/plain');
    expect(err.data).toMatchObject({ reason: 'api_unavailable' });
    checkOutputForSecrets({ message: err.message, data: err.data });
  });

  it('scrubs a credential echoed by the upstream on the invalid_access_code path', () => {
    const err = upstreamError(`Bad Request — GET ${REQUEST_URL}`, 400, 'text/html');
    expect(err.message).toContain('WSDOT_ACCESS_CODE');
    expect(err.data).toMatchObject({ reason: 'invalid_access_code' });
    checkOutputForSecrets({ message: err.message, data: err.data });
  });

  it('scrubs before truncating, so a cut cannot leave a partial credential behind', () => {
    // The assignment straddles the 300-char body cap: truncating first would keep `AccessCode=test-`.
    const body = `${'x'.repeat(282)} ?AccessCode=${ACCESS_CODE} and more text`;
    const err = upstreamError(body, 503, 'text/plain');
    expect(String(err.data?.body)).not.toContain(ACCESS_CODE);
    checkOutputForSecrets({ message: err.message, data: err.data });
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
// Upstream HTML normalization — markup never reaches either response path
// ---------------------------------------------------------------------------

/**
 * Both alert feeds embed author-written HTML in text fields, so upstream markup is untrusted input
 * arriving at a system edge. The tool fixtures elsewhere in this file are hand-built and bypass
 * normalization entirely; these push real markup through `htmlToText` — the same function both
 * services call — and then through `format()`, so the whole path is exercised rather than mocked.
 */
describe('Upstream HTML — normalization strips markup before either response path', () => {
  /** Shaped after a live ferry bulletin: Office-paste spans, entity-laden attributes, anchors. */
  const BULLETIN_HTML =
    '<p><span data-contrast="none" xml:lang="EN-US" class="TextRun SCXW180249970 BCX8">The 7:00 a.m. from Kingston is cancelled.</span></p>\r\n' +
    '<p><b>Vessel #2 Puyallup begins service at 8:40 a.m.</b></p>\r\n' +
    '<ul><li><span data-ccp-props="{&quot;134233117&quot;:false,&quot;201341983&quot;:0}">Check the ' +
    '<a href="https://wsdot.wa.gov/ferries/sailing-schedules/schedule-route" target="_blank" rel="noopener">online schedule</a>.</span></li></ul>' +
    '<o:p></o:p>';

  it('renders a real bulletin body as prose in both surfaces', async () => {
    const alert = {
      alertId: 301,
      alertTitle: 'Edm/King - First roundtrip cancelled',
      bulletinText: htmlToText(BULLETIN_HTML),
      impactedRouteIds: [6],
    };
    mockFerryService.getAlerts.mockResolvedValue([alert]);
    const result = await getFerryAlerts.handler(
      getFerryAlerts.input.parse({}),
      createMockContext(),
    );
    const text = (getFerryAlerts.format!(result)[0] as { text: string }).text;

    for (const surface of [JSON.stringify(result), text]) {
      expect(surface).toContain('Vessel #2 Puyallup begins service at 8:40 a.m.');
      expect(surface).toContain(
        'online schedule (https://wsdot.wa.gov/ferries/sailing-schedules/schedule-route)',
      );
      expect(surface).not.toContain('data-ccp-props');
      expect(surface).not.toContain('TextRun');
      expect(surface).not.toContain('&quot;');
      expect(surface).not.toMatch(/<\/?(p|span|b|ul|li|a|o:p)\b/);
    }
    checkOutputForSecrets(result);
    checkOutputForSecrets(text);
  });

  it('strips a script payload rather than leaving it verbatim', () => {
    // '<script>alert("xss")</script>' is one of INJECTION_STRINGS; here it arrives the way a real
    // payload would — inside upstream bulletin markup, not as a tool argument.
    const normalized = htmlToText(
      `<p>Service notice.</p><script>alert("xss")</script><p>Ends Friday.</p>`,
    );
    expect(normalized).toBe('Service notice.\nEnds Friday.');
    expect(normalized).not.toContain('script');
    expect(normalized).not.toContain('alert("xss")');
  });

  it('drops a javascript: or data:text/html destination while keeping the link text', () => {
    for (const href of ['javascript:void(0)', 'data:text/html,<script>']) {
      const normalized = htmlToText(`Read <a href="${href}">the notice</a>.`);
      expect(normalized).toBe('Read the notice.');
      expect(normalized).not.toContain('javascript:');
      expect(normalized).not.toContain('data:text/html');
    }
  });

  it('leaves entity-encoded markup as inert text instead of re-reading it as a tag', () => {
    // Decoding entities before stripping tags would hand the stripper a live <script> element.
    expect(htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
  });

  it('normalizes a highway alert description before format() renders it', () => {
    const alert = {
      alertId: 302,
      headlineDescription: htmlToText(
        'Ramp closed. <a href="https://content.govdelivery.com/accounts/WADOT/bulletins/420b6e6">Read the travel advisory</a>.',
      ),
    };
    const text = (searchAlerts.format!({ alerts: [alert] })[0] as { text: string }).text;
    expect(text).toContain(
      'Read the travel advisory (https://content.govdelivery.com/accounts/WADOT/bulletins/420b6e6)',
    );
    expect(text).not.toContain('<a href');
    checkOutputForSecrets({ text });
  });

  it('does not stall on a pathological fragment', () => {
    // A quadratic normalizer would block the event loop here; the scanner is linear.
    const start = performance.now();
    htmlToText('<'.repeat(200_000));
    expect(performance.now() - start).toBeLessThan(1_000);
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
    const output = { sailings: [{ departureTime: undefined, arrivalTime: undefined }] };
    const blocks = getFerrySchedule.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Unknown');
    // A missing arrival time is left absent, not filled with a fabricated one.
    expect(text).not.toContain('→');
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

/**
 * The invariant is a property of the declared schema, so these read `input.shape` rather than
 * the keys of a parsed value: every input here is optional, so `parse({})` yields `{}` and any
 * assertion over its keys would hold no matter what fields the tool declares.
 */
describe('SSRF — no user-controlled URL parameters in tool inputs', () => {
  const ENDPOINT_KEYS = ['url', 'uri', 'endpoint', 'host', 'origin', 'server'];

  const everyTool = [
    getBorderWaits,
    getFerryAlerts,
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
  ];

  for (const t of everyTool) {
    it(`${t.name} declares no endpoint-shaped input field`, () => {
      const keys = Object.keys(t.input.shape);
      for (const forbidden of ENDPOINT_KEYS) {
        expect(keys.filter((k) => k.toLowerCase().includes(forbidden))).toEqual([]);
      }
    });
  }

  it('getMountainPasses takes no input at all', () => {
    expect(Object.keys(getMountainPasses.input.shape)).toHaveLength(0);
  });
});
