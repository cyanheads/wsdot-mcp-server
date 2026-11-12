/**
 * @fileoverview CommonMark round-trip coverage for upstream text in tool output.
 * @module tests/tools/markdown-parity.test
 */
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { getBorderWaits } from '@/mcp-server/tools/definitions/get-border-waits.tool.js';
import { getFerryAlerts } from '@/mcp-server/tools/definitions/get-ferry-alerts.tool.js';
import { getFerryFares } from '@/mcp-server/tools/definitions/get-ferry-fares.tool.js';
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
import { formattedText, markdownText } from '../helpers/assertions.js';

const markdown = new MarkdownIt('commonmark');
const value = 'A *closure* [detail](https://example.com) `bridge` <tag> | ~lane~';

describe('highway alert text broken by CRLF', () => {
  // Live-shaped text: wrapped mid-sentence after a space, then a blank line before contact text.
  const lines = [
    'Single lane closure on I-5 near exit 99 ',
    '(milepost 11) will close nightly. ',
    `${value} `,
    '',
    'Contact: Olympic Region 360-357-2600',
  ];

  it('read back every non-blank headline line, trimmed and in order', () => {
    const text = formattedText(
      searchAlerts.format!({ alerts: [{ alertId: 77, headlineDescription: lines.join('\r\n') }] }),
    );
    const [heading = '', ...body] = lines.filter((line) => line !== '').map((line) => line.trim());
    expect(markdownText(text)).toBe([`${heading} #77`, ...body].join('\n'));
    expect(
      markdown.parse(text, {}).filter((token) => token.type === 'paragraph_open'),
    ).toHaveLength(2);
  });

  it('read back every non-blank extended description line, trimmed and in order', () => {
    const text = formattedText(
      searchAlerts.format!({ alerts: [{ alertId: 77, extendedDescription: lines.join('\r\n') }] }),
    );
    const body = lines.filter((line) => line !== '').map((line) => line.trim());
    expect(markdownText(text)).toBe(['Alert #77', ...body].join('\n'));
    expect(
      markdown.parse(text, {}).filter((token) => token.type === 'paragraph_open'),
    ).toHaveLength(2);
  });
});

describe('upstream text survives CommonMark parsing', () => {
  const cases = [
    ['routes', () => getFerryRoutes.format!({ routes: [{ description: value }] })],
    ['schedule', () => getFerrySchedule.format!({ sailingNotes: value, sailings: [] })],
    ['fares collection', () => getFerryFares.format!({ collectionDescription: value, fares: [] })],
    [
      'fares terminals',
      () =>
        getFerryFares.format!({
          departingTerminalName: value,
          arrivingTerminalName: 'X',
          fares: [],
        }),
    ],
    ['fare description', () => getFerryFares.format!({ fares: [{ description: value }] })],
    ['fare category', () => getFerryFares.format!({ fares: [{ category: value }] })],
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
    ['camera owner', () => searchCameras.format!({ cameras: [{ owner: value }] })],
    [
      'linked camera owner',
      () =>
        searchCameras.format!({ cameras: [{ owner: value, ownerUrl: 'https://example.com/o' }] }),
    ],
  ] as const;
  it.each(cases)('%s', (_name, format) => {
    const blocks = format();
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    expect(markdownText(text)).toContain(value);
  });

  /** A ferry time and its Pacific sibling, as content[] pairs them. */
  const utc = '2026-11-05T13:30:00.000Z';
  const local = '2026-11-05T05:30:00.000-08:00';
  const timeCases = [
    [
      'schedule',
      () =>
        getFerrySchedule.format!({
          sailings: [{ departureTime: utc, departureTimeLocal: local, serviceDate: '2026-11-04' }],
        }),
    ],
    [
      'vessels',
      () =>
        getVesselLocations.format!({
          vessels: [{ leftDock: utc, leftDockLocal: local, opRouteAbbrev: [] }],
        }),
    ],
    [
      'space',
      () =>
        getTerminalSpace.format!({
          terminals: [{ departingSpaces: [{ departure: utc, departureLocal: local }] }],
        }),
    ],
    [
      'ferry alerts',
      () =>
        getFerryAlerts.format!({
          alerts: [{ impactedRouteIds: [], publishDate: utc, publishDateLocal: local }],
        }),
    ],
  ] as const;
  it.each(timeCases)('%s time and its Pacific sibling', (_name, format) => {
    const blocks = format();
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    expect(markdownText(text)).toContain(`${local} (${utc})`);
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

  it('links a camera owner to its URL with the original destination', () => {
    const blocks = searchCameras.format!({
      cameras: [
        { owner: 'A & A Contract Customs Brokers', ownerUrl: 'http://www.aacb.com/?a=1&b=2' },
      ],
    });
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    const links = markdown
      .parse(text, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'link_open');
    expect(links.map((link) => link.attrGet('href'))).toEqual(['http://www.aacb.com/?a=1&b=2']);
    expect(markdownText(text)).toContain('Owner: A & A Contract Customs Brokers');
  });
});
