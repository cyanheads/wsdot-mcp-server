#!/usr/bin/env node
/**
 * @fileoverview wsdot-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
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
} from './mcp-server/tools/definitions/index.js';
import { initFerryApiService } from './services/ferry/ferry-service.js';
import { initTrafficApiService } from './services/traffic/traffic-service.js';

await createApp({
  name: 'wsdot-mcp-server',
  title: 'wsdot-mcp-server',
  tools: [
    getMountainPasses,
    searchAlerts,
    getTravelTimes,
    getTollRates,
    getBorderWaits,
    searchCameras,
    getFerryTerminals,
    getFerryRoutes,
    getFerrySchedule,
    getVesselLocations,
    getTerminalSpace,
    getFerryAlerts,
  ],
  resources: [],
  prompts: [],
  instructions:
    'WSDOT Traveler Information server for Washington State. Traffic tools (mountain passes, alerts, travel times, toll rates, border waits, cameras) use the WSDOT Traffic API. Ferry tools use the WSF Ferry API. For ferry schedule and space lookups, first call wsdot_get_ferry_terminals to resolve terminal names to numeric IDs. Ferry route IDs from wsdot_get_ferry_routes correspond to impactedRouteIds in wsdot_get_ferry_alerts.',
  landing: { requireAuth: false },
  setup(core) {
    initTrafficApiService(core.config, core.storage);
    initFerryApiService(core.config, core.storage);
  },
});
