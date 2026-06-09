/**
 * @fileoverview Tests for WSF ferry tools: terminals, routes, schedule, vessel locations,
 * terminal space, and ferry alerts.
 * @module tests/tools/ferry-tools.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted so vi.mock factory runs before imports) ---

const mockService = {
  getTerminals: vi.fn(),
  getRoutes: vi.fn(),
  getSchedule: vi.fn(),
  getVesselLocations: vi.fn(),
  getTerminalSailingSpace: vi.fn(),
  getAlerts: vi.fn(),
};

const mockToFerryDate = vi.fn((isoDate: string) => isoDate.trim().slice(0, 10));

vi.mock('@/services/ferry/ferry-service.js', () => ({
  getFerryApiService: () => mockService,
  FerryApiService: {
    toFerryDate: (isoDate: string) => mockToFerryDate(isoDate),
    todayFerryDate: () => '2026-05-23',
  },
}));

// --- Import tools after mocks are set up ---

import { getFerryAlerts } from '@/mcp-server/tools/definitions/get-ferry-alerts.tool.js';
import { getFerryRoutes } from '@/mcp-server/tools/definitions/get-ferry-routes.tool.js';
import { getFerrySchedule } from '@/mcp-server/tools/definitions/get-ferry-schedule.tool.js';
import { getFerryTerminals } from '@/mcp-server/tools/definitions/get-ferry-terminals.tool.js';
import { getTerminalSpace } from '@/mcp-server/tools/definitions/get-terminal-space.tool.js';
import { getVesselLocations } from '@/mcp-server/tools/definitions/get-vessel-locations.tool.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default (valid) implementation before each test
  mockToFerryDate.mockImplementation((isoDate: string) => isoDate.trim().slice(0, 10));
});

// ---------------------------------------------------------------------------
// getFerryTerminals
// ---------------------------------------------------------------------------

describe('getFerryTerminals', () => {
  const terminalFixture = {
    terminalId: 3,
    terminalName: 'Bainbridge Island',
    terminalAbbrev: 'BI',
    latitude: 47.6237,
    longitude: -122.5112,
  };

  it('returns terminals from the service', async () => {
    mockService.getTerminals.mockResolvedValue([terminalFixture]);
    const ctx = createMockContext();
    const input = getFerryTerminals.input.parse({});
    const result = await getFerryTerminals.handler(input, ctx);
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].terminalId).toBe(3);
    expect(result.terminals[0].terminalName).toBe('Bainbridge Island');
  });

  it('enriches with totalCount', async () => {
    mockService.getTerminals.mockResolvedValue([terminalFixture]);
    const ctx = createMockContext();
    const input = getFerryTerminals.input.parse({});
    await getFerryTerminals.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no terminals returned', async () => {
    mockService.getTerminals.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryTerminals.input.parse({});
    await getFerryTerminals.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty terminals list', async () => {
    mockService.getTerminals.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryTerminals.input.parse({});
    const result = await getFerryTerminals.handler(input, ctx);
    expect(result.terminals).toHaveLength(0);
  });

  it('formats terminals with ID and name', () => {
    const output = { terminals: [terminalFixture] };
    const blocks = getFerryTerminals.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Bainbridge Island');
    expect(text).toContain('BI');
    expect(text).toContain('3'); // terminalId
    expect(text).toContain('47.6237');
    expect(text).toContain('-122.5112');
  });

  it('handles sparse terminal (no optional fields)', () => {
    const sparse = { terminalId: 7, terminalName: 'Seattle' };
    const output = { terminals: [sparse] };
    const blocks = getFerryTerminals.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('7');
  });
});

// ---------------------------------------------------------------------------
// getFerryRoutes
// ---------------------------------------------------------------------------

describe('getFerryRoutes', () => {
  const routeFixture = {
    routeId: 1,
    routeAbbrev: 'SEA-BI',
    description: 'Seattle/Bainbridge Island',
  };

  it('returns routes for today when no date provided', async () => {
    mockService.getRoutes.mockResolvedValue([routeFixture]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({});
    const result = await getFerryRoutes.handler(input, ctx);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].description).toBe('Seattle/Bainbridge Island');
  });

  it('enriches with totalCount and tripDate', async () => {
    mockService.getRoutes.mockResolvedValue([routeFixture]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({ tripDate: '2026-05-23' });
    await getFerryRoutes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.tripDate).toBe('2026-05-23');
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no routes returned', async () => {
    mockService.getRoutes.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({ tripDate: '2026-05-23' });
    await getFerryRoutes.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns routes for a specific date', async () => {
    mockService.getRoutes.mockResolvedValue([routeFixture]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({ tripDate: '2026-05-23' });
    const result = await getFerryRoutes.handler(input, ctx);
    expect(result.routes).toHaveLength(1);
    expect(mockService.getRoutes).toHaveBeenCalledWith('2026-05-23', ctx);
  });

  it('returns empty routes list', async () => {
    mockService.getRoutes.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryRoutes.input.parse({});
    const result = await getFerryRoutes.handler(input, ctx);
    expect(result.routes).toHaveLength(0);
  });

  it('formats routes with key fields', () => {
    const output = { routes: [routeFixture] };
    const blocks = getFerryRoutes.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle/Bainbridge Island');
    expect(text).toContain('SEA-BI');
    expect(text).toContain('1'); // routeId
  });

  it('surfaces invalid_date reason via ctx.fail when tripDate is invalid', async () => {
    mockToFerryDate.mockImplementation(() => {
      throw new Error('Invalid date');
    });
    const ctx = createMockContext({ errors: getFerryRoutes.errors });
    const input = getFerryRoutes.input.parse({ tripDate: 'not-a-date' });
    const err = await getFerryRoutes.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_date' });
  });
});

// ---------------------------------------------------------------------------
// getFerrySchedule
// ---------------------------------------------------------------------------

describe('getFerrySchedule', () => {
  const scheduleFixture = {
    departingTerminalName: 'Seattle',
    arrivingTerminalName: 'Bainbridge Island',
    tripDate: '2026-05-23',
    sailings: [
      {
        departureTime: '6:00 AM',
        arrivalTime: '6:35 AM',
        isCancelled: false,
        vesselName: 'Yakima',
      },
      {
        departureTime: '7:00 AM',
        arrivalTime: '7:35 AM',
        isCancelled: true,
        vesselName: 'Walla Walla',
      },
    ],
  };

  it('returns schedule for given terminal pair', async () => {
    mockService.getSchedule.mockResolvedValue(scheduleFixture);
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
    });
    const result = await getFerrySchedule.handler(input, ctx);
    expect(result.sailings).toHaveLength(2);
    expect(result.departingTerminalName).toBe('Seattle');
    expect(result.arrivingTerminalName).toBe('Bainbridge Island');
  });

  it('enriches with tripDate, remainingOnly, and totalSailings', async () => {
    mockService.getSchedule.mockResolvedValue(scheduleFixture);
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
    });
    await getFerrySchedule.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalSailings).toBe(2);
    expect(enrichment.remainingOnly).toBe(false);
    expect(enrichment.tripDate).toBeDefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no sailings returned', async () => {
    mockService.getSchedule.mockResolvedValue({
      ...scheduleFixture,
      sailings: [],
    });
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
    });
    await getFerrySchedule.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalSailings).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('defaults remainingOnly to false', async () => {
    mockService.getSchedule.mockResolvedValue(scheduleFixture);
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
    });
    await getFerrySchedule.handler(input, ctx);
    expect(mockService.getSchedule).toHaveBeenCalledWith(7, 3, expect.any(String), false, ctx);
  });

  it('passes remainingOnly when set to true', async () => {
    mockService.getSchedule.mockResolvedValue(scheduleFixture);
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      remainingOnly: true,
    });
    await getFerrySchedule.handler(input, ctx);
    expect(mockService.getSchedule).toHaveBeenCalledWith(7, 3, expect.any(String), true, ctx);
  });

  it('uses provided tripDate', async () => {
    mockService.getSchedule.mockResolvedValue(scheduleFixture);
    const ctx = createMockContext();
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: '2026-05-23',
    });
    await getFerrySchedule.handler(input, ctx);
    expect(mockService.getSchedule).toHaveBeenCalledWith(7, 3, '2026-05-23', false, ctx);
  });

  it('formats schedule with sailings', () => {
    const output = {
      departingTerminalName: 'Seattle',
      arrivingTerminalName: 'Bainbridge Island',
      sailings: [
        {
          departureTime: '6:00 AM',
          arrivalTime: '6:35 AM',
          isCancelled: false,
          vesselName: 'Yakima',
        },
        { departureTime: '7:00 AM', isCancelled: true },
      ],
    };
    const blocks = getFerrySchedule.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle → Bainbridge Island');
    expect(text).toContain('6:00 AM');
    expect(text).toContain('Yakima');
    expect(text).toContain('CANCELLED');
  });

  it('formats empty sailings list', () => {
    const output = {
      sailings: [],
    };
    const blocks = getFerrySchedule.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No sailings found');
  });

  it('surfaces invalid_date reason via ctx.fail when tripDate is invalid', async () => {
    mockToFerryDate.mockImplementation(() => {
      throw new Error('Invalid date');
    });
    const ctx = createMockContext({ errors: getFerrySchedule.errors });
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
      tripDate: 'not-a-date',
    });
    const err = await getFerrySchedule.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_date' });
  });

  it('surfaces invalid_terminal_pair reason via ctx.fail when API returns WSF error', async () => {
    mockService.getSchedule.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ValidationError, 'WSF Ferry API error: Invalid terminal pair'),
    );
    const ctx = createMockContext({ errors: getFerrySchedule.errors });
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 9999,
      arrivingTerminalId: 9998,
    });
    const err = await getFerrySchedule.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_terminal_pair' });
  });

  it('maps an HTTP 4xx from getSchedule to invalid_terminal_pair', async () => {
    mockService.getSchedule.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'WSF Ferry API returned HTTP 400.'),
    );
    const ctx = createMockContext({ errors: getFerrySchedule.errors });
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 999,
      arrivingTerminalId: 3,
    });
    const err = await getFerrySchedule.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'invalid_terminal_pair' });
  });

  it('re-throws non-WSF errors from getSchedule without wrapping', async () => {
    mockService.getSchedule.mockRejectedValue(new Error('Network timeout'));
    const ctx = createMockContext({ errors: getFerrySchedule.errors });
    const input = getFerrySchedule.input.parse({
      departingTerminalId: 7,
      arrivingTerminalId: 3,
    });
    const err = await getFerrySchedule.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Network timeout');
  });
});

// ---------------------------------------------------------------------------
// getVesselLocations
// ---------------------------------------------------------------------------

describe('getVesselLocations', () => {
  const vesselFixture = {
    vesselId: 20,
    vesselName: 'Yakima',
    inService: true,
    atDock: false,
    departingTerminalId: 7,
    departingTerminalName: 'Seattle',
    arrivingTerminalId: 3,
    arrivingTerminalName: 'Bainbridge Island',
    latitude: 47.5938,
    longitude: -122.4699,
    speed: 12.5,
    heading: 270,
    leftDock: '08:00 AM',
    eta: '08:35 AM',
    scheduledDeparture: '08:00 AM',
    opRouteAbbrev: ['SEA-BI'],
    timestamp: '/Date(1700000000000-0800)/',
  };

  it('returns vessel locations from the service', async () => {
    mockService.getVesselLocations.mockResolvedValue([vesselFixture]);
    const ctx = createMockContext();
    const input = getVesselLocations.input.parse({});
    const result = await getVesselLocations.handler(input, ctx);
    expect(result.vessels).toHaveLength(1);
    expect(result.vessels[0].vesselName).toBe('Yakima');
    expect(result.vessels[0].speed).toBe(12.5);
    expect(result.vessels[0].opRouteAbbrev).toEqual(['SEA-BI']);
  });

  it('enriches with totalCount', async () => {
    mockService.getVesselLocations.mockResolvedValue([vesselFixture]);
    const ctx = createMockContext();
    const input = getVesselLocations.input.parse({});
    await getVesselLocations.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no vessels returned', async () => {
    mockService.getVesselLocations.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getVesselLocations.input.parse({});
    await getVesselLocations.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
  });

  it('returns empty vessels list', async () => {
    mockService.getVesselLocations.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getVesselLocations.input.parse({});
    const result = await getVesselLocations.handler(input, ctx);
    expect(result.vessels).toHaveLength(0);
  });

  it('formats vessels with key fields', () => {
    const output = { vessels: [vesselFixture] };
    const blocks = getVesselLocations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Yakima');
    expect(text).toContain('In Service:** Yes');
    expect(text).toContain('At Dock:** No');
    expect(text).toContain('Seattle');
    expect(text).toContain('Bainbridge Island');
    expect(text).toContain('12.5 knots');
    expect(text).toContain('270°');
    expect(text).toContain('SEA-BI');
    expect(text).toContain('20'); // vesselId
  });

  it('formats empty vessels list', () => {
    const blocks = getVesselLocations.format!({ vessels: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No vessel location data');
  });

  it('handles sparse vessel (minimal fields, empty opRouteAbbrev)', () => {
    const sparse = { vesselId: 5, vesselName: 'Wenatchee', opRouteAbbrev: [] };
    const output = { vessels: [sparse] };
    const blocks = getVesselLocations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Wenatchee');
    expect(text).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// getTerminalSpace
// ---------------------------------------------------------------------------

describe('getTerminalSpace', () => {
  const terminalSpaceFixture = {
    terminalId: 7,
    terminalName: 'Seattle',
    departingSpaces: [
      {
        departure: '10:00 AM',
        isCancelled: false,
        vesselName: 'Yakima',
        arrivingTerminalName: 'Bainbridge Island',
        driveUpSpaceCount: 50,
        reservableSpaceCount: 100,
        maxSpaceCount: 202,
        driveUpSpaceHexColor: '#00FF00',
      },
    ],
  };

  it('returns all terminals when no filter provided', async () => {
    mockService.getTerminalSailingSpace.mockResolvedValue([terminalSpaceFixture]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({});
    const result = await getTerminalSpace.handler(input, ctx);
    expect(result.terminals).toHaveLength(1);
  });

  it('enriches with totalCount and no terminalFilter when no filter', async () => {
    mockService.getTerminalSailingSpace.mockResolvedValue([terminalSpaceFixture]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({});
    await getTerminalSpace.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.terminalFilter).toBeUndefined();
  });

  it('enriches terminalFilter when filter provided', async () => {
    mockService.getTerminalSailingSpace.mockResolvedValue([terminalSpaceFixture]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({ departingTerminalId: 7 });
    await getTerminalSpace.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.terminalFilter).toBe(7);
  });

  it('enriches notice when filter matches no terminal', async () => {
    mockService.getTerminalSailingSpace.mockResolvedValue([terminalSpaceFixture]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({ departingTerminalId: 999 });
    await getTerminalSpace.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('999');
  });

  it('filters to a specific terminal by ID', async () => {
    const otherTerminal = {
      ...terminalSpaceFixture,
      terminalId: 3,
      terminalName: 'Bainbridge Island',
      departingSpaces: [],
    };
    mockService.getTerminalSailingSpace.mockResolvedValue([terminalSpaceFixture, otherTerminal]);
    const ctx = createMockContext();
    const input = getTerminalSpace.input.parse({ departingTerminalId: 7 });
    const result = await getTerminalSpace.handler(input, ctx);
    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].terminalId).toBe(7);
  });

  it('formats terminal space with key fields', () => {
    const output = { terminals: [terminalSpaceFixture] };
    const blocks = getTerminalSpace.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Seattle');
    expect(text).toContain('7'); // terminalId
    expect(text).toContain('10:00 AM');
    expect(text).toContain('Yakima');
    expect(text).toContain('Bainbridge Island');
    expect(text).toContain('50');
    expect(text).toContain('202');
  });

  it('shows FULL when driveUpSpaceCount is 0', () => {
    const fullTerminal = {
      ...terminalSpaceFixture,
      departingSpaces: [{ ...terminalSpaceFixture.departingSpaces[0], driveUpSpaceCount: 0 }],
    };
    const output = { terminals: [fullTerminal] };
    const blocks = getTerminalSpace.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FULL');
  });

  it('formats empty terminals list', () => {
    const blocks = getTerminalSpace.format!({ terminals: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No terminal space data');
  });
});

// ---------------------------------------------------------------------------
// getFerryAlerts
// ---------------------------------------------------------------------------

describe('getFerryAlerts', () => {
  const alertFixture = {
    alertId: 201,
    alertDescription: 'Vessel Wenatchee out of service due to mechanical issues.',
    impactedRouteIds: [1, 2],
    publishDate: '2023-11-14T22:13:20.000Z',
  };

  it('returns alerts from the service', async () => {
    mockService.getAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = getFerryAlerts.input.parse({});
    const result = await getFerryAlerts.handler(input, ctx);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].alertId).toBe(201);
    expect(result.alerts[0].impactedRouteIds).toEqual([1, 2]);
  });

  it('enriches with totalCount', async () => {
    mockService.getAlerts.mockResolvedValue([alertFixture]);
    const ctx = createMockContext();
    const input = getFerryAlerts.input.parse({});
    await getFerryAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('enriches notice when no alerts', async () => {
    mockService.getAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryAlerts.input.parse({});
    await getFerryAlerts.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No active');
  });

  it('returns empty alerts list', async () => {
    mockService.getAlerts.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFerryAlerts.input.parse({});
    const result = await getFerryAlerts.handler(input, ctx);
    expect(result.alerts).toHaveLength(0);
  });

  it('formats alerts with key fields', () => {
    const output = { alerts: [alertFixture] };
    const blocks = getFerryAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('201'); // alertId
    expect(text).toContain('Wenatchee out of service');
    expect(text).toContain('1, 2'); // impactedRouteIds
    expect(text).toContain('wsdot_get_ferry_routes');
  });

  it('formats empty alerts list', () => {
    const blocks = getFerryAlerts.format!({ alerts: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active ferry alerts');
  });

  it('handles alert with empty impactedRouteIds', () => {
    const alertNoRoutes = {
      alertId: 202,
      alertDescription: 'Maintenance notice.',
      impactedRouteIds: [],
    };
    const output = { alerts: [alertNoRoutes] };
    const blocks = getFerryAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Maintenance notice');
    // Should not render "Impacted Route IDs:" line when empty
    expect(text).not.toContain('Impacted Route IDs:');
  });
});
