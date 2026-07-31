/**
 * @fileoverview Tool to search highway camera locations and metadata from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/search-cameras.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { byIdThenContent } from '@/services/traffic/stable-order.js';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const searchCameras = tool('wsdot_search_cameras', {
  title: 'Search Highway Cameras',
  description:
    'Returns WSDOT highway camera locations, descriptions, and image URLs. ' +
    'Camera images are copyright WSDOT — only metadata and image URLs are returned, not image bytes. ' +
    'Filter by state route ("I-90", "90", "SR 520", or "520" all work), WSDOT region, or milepost range. ' +
    'Results are ordered by cameraId and paged — pass offset/limit to page through the full set ' +
    '(the notice reports the next offset).',
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .optional()
      .describe(
        'State route to filter by. Accepts natural forms — "I-90", "90", "090", "SR 520", "520" — matched case- and space-insensitively to the route number. Camera road names carry a route-type prefix, which is compared when the filter carries one too: "SR 26" excludes US 26, while a bare "26" returns both. A lettered suffix is part of the route, so "US 97" excludes US 97A. Omit to include all routes.',
      ),
    region: z
      .string()
      .optional()
      .describe(
        'WSDOT region code: NW (Northwest), SW (Southwest), OL (Olympic), ER (Eastern), SC (South Central), OS (Olympic South), NC (North Central), or WA (statewide). Matching is case-insensitive.',
      ),
    startMilepost: z.number().optional().describe('Start of milepost range to filter cameras.'),
    endMilepost: z.number().optional().describe('End of milepost range to filter cameras.'),
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
        `Maximum cameras to return in this page (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      ),
  }),
  output: z.object({
    cameras: z
      .array(
        z
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
          .describe('Camera metadata and image URL for one WSDOT highway camera.'),
      )
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
    },
    {
      reason: 'invalid_access_code',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'WSDOT rejected the request because WSDOT_ACCESS_CODE is missing, invalid, or not registered.',
      retryable: false,
      recovery:
        'Register an access code at https://wsdot.wa.gov/traffic/api/, set WSDOT_ACCESS_CODE on the server, and restart it.',
    },
  ],

  async handler(input, ctx) {
    const stateRoute = input.stateRoute?.trim() || undefined;
    const region = input.region?.trim() || undefined;
    const fetched = await getTrafficApiService().searchCameras(
      {
        ...(stateRoute && { stateRoute }),
        ...(region && { region }),
        ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
        ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      },
      ctx,
    );

    // The camera feed serves one camera set in more than one row order, so a given offset is only
    // reproducible once the rows are ordered here. Cameras with no cameraId sort last.
    const allCameras = fetched.toSorted(byIdThenContent((c) => c.cameraId));

    const appliedFilters = {
      ...(stateRoute && { stateRoute }),
      ...(region && { region }),
      ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
      ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
    };

    // Page the full filtered set so structuredContent and content[] carry the identical
    // page (the service stays filter-only; paging is a tool-handler concern). totalCount
    // stays the full match count so the agent knows how much lies beyond this page.
    const totalCount = allCameras.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const cameras = allCameras.slice(offset, offset + limit);
    const hasMore = offset + cameras.length < totalCount;
    const nextOffset = hasMore ? offset + cameras.length : null;

    ctx.log.info('Cameras fetched', { totalCount, offset, limit, returned: cameras.length });

    ctx.enrich({ totalCount, appliedFilters, nextOffset, hasMore });

    if (totalCount === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        hasFilters
          ? 'No cameras matched the applied filters. Try removing the stateRoute, region, or milepost filters.'
          : 'No camera data available statewide.',
      );
    } else if (cameras.length === 0) {
      ctx.enrich.notice(
        `Offset ${offset} is past the end of ${totalCount} matching cameras. Use an offset between 0 and ${totalCount - 1}.`,
      );
    } else {
      const window = `Showing cameras ${offset + 1}–${offset + cameras.length} of ${totalCount}. Camera images are copyright WSDOT.`;
      ctx.enrich.notice(
        hasMore ? `${window} Pass offset=${nextOffset} for the next page.` : window,
      );
    }

    return { cameras };
  },

  format: (result) => {
    if (result.cameras.length === 0) {
      return [{ type: 'text', text: 'No cameras found.' }];
    }
    const lines: string[] = [];
    for (const c of result.cameras) {
      lines.push(`### ${c.title ?? `Camera ${c.cameraId ?? ''}`}`);
      if (c.description) lines.push(c.description);
      if (c.roadName) {
        const loc = [c.roadName, c.direction, c.milePost != null ? `MP ${c.milePost}` : undefined]
          .filter(Boolean)
          .join(' ');
        lines.push(`**Location:** ${loc}`);
      }
      if (c.region) lines.push(`**Region:** ${c.region}`);
      if (c.imageUrl) lines.push(`**Image:** ${c.imageUrl}`);
      if (c.imageWidth != null && c.imageHeight != null) {
        lines.push(`**Size:** ${c.imageWidth}×${c.imageHeight}px`);
      }
      if (c.latitude != null && c.longitude != null) {
        lines.push(`**Coords:** ${c.latitude}, ${c.longitude}`);
      }
      if (c.cameraId != null) lines.push(`**ID:** ${c.cameraId}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
