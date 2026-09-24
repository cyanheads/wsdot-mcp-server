/**
 * @fileoverview Tool to search highway camera locations and metadata from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/search-cameras.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { coordinatePair } from '@/mcp-server/tools/coordinate-pair.js';
import {
  continuationNotice,
  fitPageToBudget,
  MAX_FILTER_LENGTH,
  PAGE_BYTE_BUDGET,
  renderPage,
} from '@/mcp-server/tools/page-budget.js';
import { byIdThenContent } from '@/services/traffic/stable-order.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** The region codes the camera feed carries in `Region`. */
const REGIONS = ['ER', 'NC', 'NW', 'OL', 'OS', 'SC', 'SW', 'WA'];

const CameraSchema = z
  .object({
    cameraId: z.number().optional().describe('Unique camera identifier.'),
    title: z.string().optional().describe('Camera title or location description.'),
    description: z.string().optional().describe('Additional description.'),
    imageUrl: z
      .string()
      .optional()
      .describe('URL of the WSDOT-hosted camera image (JPEG). WSDOT copyright applies.'),
    imageWidth: z.number().optional().describe('Image width in pixels.'),
    imageHeight: z.number().optional().describe('Image height in pixels.'),
    roadName: z.string().optional().describe('Road the camera monitors.'),
    direction: z
      .string()
      .optional()
      .describe(
        'Traffic-direction code monitored: N/S/E/W, B (both), NB/SB/EB/WB. Some sites use other location-specific markers.',
      ),
    milePost: z.number().optional().describe('Milepost location of the camera.'),
    region: z.string().optional().describe('WSDOT region.'),
    latitude: z.number().optional().describe('Camera latitude.'),
    longitude: z.number().optional().describe('Camera longitude.'),
  })
  .describe('Camera metadata and image URL for one WSDOT highway camera.');

export const searchCameras = tool('wsdot_search_cameras', {
  title: 'Search Highway Cameras',
  description:
    'Returns WSDOT highway camera locations, descriptions, and image URLs. ' +
    'Camera images are copyright WSDOT — only metadata and image URLs are returned, not image bytes. ' +
    'Filter by state route ("I-90", "90", "SR 520", or "520" all work), WSDOT region, milepost range, ' +
    'or words in the camera title ("Snoqualmie"). ' +
    'Results are ordered by cameraId and paged — pass offset/limit to page through the full set. ' +
    `A page ends at limit or at a ${PAGE_BYTE_BUDGET.toLocaleString('en-US')}-byte response budget, whichever comes first; the notice reports the next offset.`,
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'State route to filter by. Accepts natural forms — "I-90", "90", "090", "SR 520", "520" — matched case- and space-insensitively to the route number. Camera road names carry a route-type prefix, which is compared when the filter carries one too: "SR 26" excludes US 26, while a bare "26" returns both. A lettered suffix is part of the route, so "US 97" excludes US 97A. Omit to include all routes.',
      ),
    region: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'WSDOT region code: NW (Northwest), SW (Southwest), OL (Olympic), ER (Eastern), SC (South Central), NC (North Central), OS (Oregon — the TripCheck cameras around Portland), or WA (airport cameras plus a few ferry-terminal cameras — most ferry-terminal cameras sit in NW and OL). Matching is case-insensitive; any other value is rejected. These are codes, not the region names wsdot_search_alerts takes.',
      ),
    startMilepost: z
      .number()
      .optional()
      .describe(
        'Start of the milepost range to filter cameras. Either bound may be given alone; when both are given, startMilepost must not exceed endMilepost. Cameras reporting no milepost are always included.',
      ),
    endMilepost: z.number().optional().describe('End of the milepost range to filter cameras.'),
    titleContains: z
      .string()
      .max(MAX_FILTER_LENGTH)
      .optional()
      .describe(
        'Words to find in the camera title, as WSDOT wrote it. Case-insensitive; every whitespace-separated word must appear, in any order — "Snoqualmie" returns "Snoqualmie Summit" and "East Snoqualmie Summit" but not a nearby camera titled "Hyak". Most titles lead with route and milepost ("I-90 at MP 52: …"), so filter a route with stateRoute rather than here. Combines with the other filters. Omit to include every title.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Zero-based index of the first camera to return, for paging. Defaults to 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Maximum cameras to return in this page (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}. A large page ends sooner, at the ${PAGE_BYTE_BUDGET.toLocaleString('en-US')}-byte response budget.`,
      ),
  }),
  output: z.object({
    cameras: z
      .array(CameraSchema)
      .describe('Camera metadata and image URLs. Images are copyright WSDOT.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total cameras matching the filters across all pages (not just this page).'),
    nextOffset: z
      .number()
      .nullable()
      .describe('Offset to pass to retrieve the next page, or null when this is the last page.'),
    hasMore: z.boolean().describe('True when more cameras remain beyond the current page.'),
    appliedFilters: z
      .object({
        stateRoute: z.string().optional().describe('State route filter applied.'),
        region: z.string().optional().describe('Region filter applied.'),
        startMilepost: z.number().optional().describe('Start milepost filter applied.'),
        endMilepost: z.number().optional().describe('End milepost filter applied.'),
        titleContains: z.string().optional().describe('Title words filter applied.'),
      })
      .describe('Active filters applied to the camera search.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Informational note about the page window, copyright, or empty results. Absent when not applicable.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const parts: string[] = [];
        if (filters.stateRoute) parts.push(`- **Route:** ${filters.stateRoute}`);
        if (filters.region) parts.push(`- **Region:** ${filters.region}`);
        if (filters.startMilepost != null) parts.push(`- **Start MP:** ${filters.startMilepost}`);
        if (filters.endMilepost != null) parts.push(`- **End MP:** ${filters.endMilepost}`);
        if (filters.titleContains) parts.push(`- **Title contains:** ${filters.titleContains}`);
        return parts.length > 0
          ? `**Applied Filters:**\n${parts.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'WSDOT Traffic API is unreachable or returns a non-2xx response after retries.',
      retryable: true,
      recovery:
        'Retry in 30 seconds. If the issue persists, check wsdot.wa.gov for service status.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSDOT rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_region',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The region is not one of the region codes the camera feed carries.',
      recovery: `Pass one of the region codes ${REGIONS.join(', ')} (case-insensitive), or omit region.`,
    },
    {
      reason: 'invalid_milepost_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'startMilepost is greater than endMilepost.',
      recovery:
        'Pass startMilepost less than or equal to endMilepost, or give only one bound for an open-ended range.',
    },
  ],

  async handler(input, ctx) {
    const stateRoute = input.stateRoute?.trim() || undefined;
    const region = input.region?.trim() || undefined;
    const titleContains = input.titleContains?.trim() || undefined;
    if (region && !REGIONS.includes(region.toUpperCase())) {
      throw ctx.fail(
        'invalid_region',
        `Unknown region "${region}" — wsdot_search_cameras takes a WSDOT region code.`,
        { ...ctx.recoveryFor('invalid_region') },
      );
    }
    if (
      input.startMilepost != null &&
      input.endMilepost != null &&
      input.startMilepost > input.endMilepost
    ) {
      throw ctx.fail(
        'invalid_milepost_range',
        `startMilepost ${input.startMilepost} is greater than endMilepost ${input.endMilepost}.`,
        { ...ctx.recoveryFor('invalid_milepost_range') },
      );
    }
    const fetched = await getTrafficApiService().searchCameras(
      {
        ...(stateRoute && { stateRoute }),
        ...(region && { region }),
        ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
        ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      },
      ctx,
    );

    // Every word must appear somewhere in the title; a camera with no title cannot match.
    const tokens = titleContains?.toLowerCase().split(/\s+/);
    const matched = tokens
      ? fetched.filter((c) => {
          const title = c.title?.toLowerCase();
          return title != null && tokens.every((t) => title.includes(t));
        })
      : fetched;

    // The camera feed serves one camera set in more than one row order, so a given offset is only
    // reproducible once the rows are ordered here. Cameras with no cameraId sort last.
    const allCameras = matched.toSorted(byIdThenContent((c) => c.cameraId));

    const appliedFilters = {
      ...(stateRoute && { stateRoute }),
      ...(region && { region }),
      ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
      ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      ...(titleContains && { titleContains }),
    };

    // Page the full filtered set so structuredContent and content[] carry the identical
    // page (the service stays filter-only; paging is a tool-handler concern). totalCount
    // stays the full match count so the agent knows how much lies beyond this page.
    const totalCount = allCameras.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const requested = allCameras.slice(offset, offset + limit);
    const cameras = fitPageToBudget(requested, renderCamera, appliedFilters);
    const hasMore = offset + cameras.length < totalCount;
    const nextOffset = hasMore ? offset + cameras.length : null;

    ctx.log.info('Cameras fetched', { totalCount, offset, limit, returned: cameras.length });

    ctx.enrich({ totalCount, appliedFilters, nextOffset, hasMore });

    if (totalCount === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        hasFilters
          ? 'No cameras matched the applied filters. Try removing the stateRoute, region, milepost, or titleContains filters.'
          : 'No camera data available statewide.',
      );
    } else if (cameras.length === 0) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of ${totalCount} matching cameras. Use an offset between 0 and ${totalCount - 1}.`,
      );
    } else {
      const shown = `Showing cameras ${offset + 1}–${offset + cameras.length} of ${totalCount}. Camera images are copyright WSDOT.`;
      ctx.enrich.notice(
        nextOffset === null
          ? shown
          : `${shown} ${continuationNotice(nextOffset, cameras.length < requested.length)}`,
      );
    }

    return { cameras };
  },

  format: (result) => {
    if (result.cameras.length === 0) {
      return [{ type: 'text', text: 'No cameras found.' }];
    }
    return [{ type: 'text', text: renderPage(result.cameras, renderCamera) }];
  },
});

/** One camera's `content[]` block — shared by `format()` and the page-budget charge. */
function renderCamera(c: z.infer<typeof CameraSchema>): string {
  const lines = [`### ${c.title ?? `Camera ${c.cameraId ?? ''}`}`];
  if (c.description) lines.push(c.description);
  // Direction and milepost stand on their own — gating the whole line on roadName drops
  // them from content[] for a camera that reports a position but no road name.
  const loc = [c.roadName, c.direction, c.milePost != null ? `MP ${c.milePost}` : undefined]
    .filter(Boolean)
    .join(' ');
  if (loc) lines.push(`**Location:** ${loc}`);
  if (c.region) lines.push(`**Region:** ${c.region}`);
  if (c.imageUrl) lines.push(`**Image:** ${c.imageUrl}`);
  if (c.imageWidth != null && c.imageHeight != null) {
    lines.push(`**Size:** ${c.imageWidth}×${c.imageHeight}px`);
  } else if (c.imageWidth != null) {
    lines.push(`**Size:** ${c.imageWidth}px wide (height not reported)`);
  } else if (c.imageHeight != null) {
    lines.push(`**Size:** ${c.imageHeight}px tall (width not reported)`);
  }
  const coords = coordinatePair(c.latitude, c.longitude);
  if (coords) lines.push(`**Coords:** ${coords}`);
  if (c.cameraId != null) lines.push(`**ID:** ${c.cameraId}`);
  return lines.join('\n');
}
