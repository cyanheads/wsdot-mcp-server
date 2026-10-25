/**
 * @fileoverview CommonMark round-trip coverage for upstream text in tool output.
 * @module tests/tools/markdown-parity.test
 */
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
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
import { markdownText } from '../helpers/assertions.js';

const markdown = new MarkdownIt('commonmark');
const value = 'A *closure* [detail](https://example.com) `bridge` <tag> | ~lane~';

describe('upstream text survives CommonMark parsing', () => {
  const cases = [
    ['routes', () => getFerryRoutes.format!({ routes: [{ description: value }] })],
    ['schedule', () => getFerrySchedule.format!({ sailingNotes: value, sailings: [] })],
    [
      'ferry alerts',
      () => getFerryAlerts.format!({ alerts: [{ bulletinText: value, impactedRouteIds: [] }] }),
    ],
    ['terminals', () => getFerryTerminals.format!({ terminals: [{ terminalName: value }] })],
    ['border waits', () => getBorderWaits.format!({ crossings: [{ crossingName: value }] })],
    ['passes', () => getMountainPasses.format!({ passes: [{ weatherCondition: value }] })],
    [
      'space',
      () => getTerminalSpace.format!({ terminals: [{ terminalName: value, departingSpaces: [] }] }),
    ],
    ['tolls', () => getTollRates.format!({ rates: [{ message: value }] })],
    ['travel times', () => getTravelTimes.format!({ corridors: [{ description: value }] })],
    [
      'vessels',
      () => getVesselLocations.format!({ vessels: [{ vesselName: value, opRouteAbbrev: [] }] }),
    ],
    ['highway alerts', () => searchAlerts.format!({ alerts: [{ extendedDescription: value }] })],
    ['cameras', () => searchCameras.format!({ cameras: [{ description: value }] })],
  ] as const;
  it.each(cases)('%s', (_name, format) => {
    const blocks = format();
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    expect(markdownText(text)).toContain(value);
  });

  it('renders camera URLs as images with the original destination', () => {
    const blocks = searchCameras.format!({
      cameras: [{ imageUrl: 'https://example.com/camera.jpg?x=1&y=2' }],
    });
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const images = markdown
      .parse(text, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'image');
    expect(images.map((image) => image.attrGet('src'))).toEqual([
      'https://example.com/camera.jpg?x=1&y=2',
    ]);
  });
});
