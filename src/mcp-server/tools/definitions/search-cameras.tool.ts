/**
 * @fileoverview Tool to search highway camera locations and metadata from the WSDOT Traffic API.
 * @module mcp-server/tools/definitions/search-cameras.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTrafficApiService } from '@/services/traffic/traffic-service.js';

const MAX_INLINE_CAMERAS = 20;

export const searchCameras = tool('wsdot_search_cameras', {
  title: 'Search Highway Cameras',
  description:
    'Returns WSDOT highway camera locations, descriptions, and image URLs. ' +
    'Camera images are copyright WSDOT — only metadata and image URLs are returned, not image bytes. ' +
    'Filter by state route (e.g. "090" for I-90), WSDOT region, or milepost range. ' +
    'Omit all filters to list all cameras statewide (potentially hundreds).',
  annotations: { readOnlyHint: true },
  input: z.object({
    stateRoute: z
      .string()
      .optional()
      .describe('Zero-padded 3-digit state route number (e.g. "005" for I-5, "090" for I-90).'),
    region: z
      .string()
      .optional()
      .describe(
        'WSDOT region code: NW (Northwest), SW (Southwest), OL (Olympic), ER (Eastern), SC (South Central), OS (Olympic South), NC (North Central), or WA (statewide). Matching is case-insensitive.',
      ),
    startMilepost: z.number().optional().describe('Start of milepost range to filter cameras.'),
    endMilepost: z.number().optional().describe('End of milepost range to filter cameras.'),
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
            direction: z.string().optional().describe('Traffic direction monitored.'),
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
    totalCount: z.number().describe('Total number of cameras returned.'),
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
        'Informational note about result truncation, copyright, or empty results. Absent when not applicable.',
      ),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (filters) => {
        const parts: string[] = [];
        if (filters.stateRoute) parts.push(`- **Route:** SR ${filters.stateRoute}`);
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
  ],

  async handler(input, ctx) {
    const stateRoute = input.stateRoute?.trim() || undefined;
    const region = input.region?.trim() || undefined;
    const cameras = await getTrafficApiService().searchCameras(
      {
        ...(stateRoute && { stateRoute }),
        ...(region && { region }),
        ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
        ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
      },
      ctx,
    );

    const appliedFilters = {
      ...(stateRoute && { stateRoute }),
      ...(region && { region }),
      ...(input.startMilepost != null && { startMilepost: input.startMilepost }),
      ...(input.endMilepost != null && { endMilepost: input.endMilepost }),
    };

    ctx.log.info('Cameras fetched', { count: cameras.length });

    ctx.enrich({ totalCount: cameras.length, appliedFilters });

    if (cameras.length === 0) {
      const hasFilters = Object.keys(appliedFilters).length > 0;
      ctx.enrich.notice(
        hasFilters
          ? 'No cameras matched the applied filters. Try removing the stateRoute, region, or milepost filters.'
          : 'No camera data available statewide.',
      );
    } else if (cameras.length > MAX_INLINE_CAMERAS) {
      ctx.enrich.notice(
        `Showing first ${MAX_INLINE_CAMERAS} of ${cameras.length} cameras in content[]. All cameras are in structuredContent. Add filters (stateRoute, region, or mileposts) to narrow results. Camera images are copyright WSDOT.`,
      );
    } else {
      ctx.enrich.notice('Camera images are copyright WSDOT. Follow image URLs to view live feeds.');
    }

    return { cameras };
  },

  format: (result) => {
    const lines: string[] = [];
    const display = result.cameras.slice(0, MAX_INLINE_CAMERAS);
    for (const c of display) {
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
    if (result.cameras.length > MAX_INLINE_CAMERAS) {
      lines.push(
        `_... ${result.cameras.length - MAX_INLINE_CAMERAS} more cameras in structuredContent_`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
