/**
 * GET /api/publish/sizes — Returns the configured export sizes (e.g. "Web",
 * "Print") plus the min/max long-edge bounds the UI's slider should clamp to.
 * Read by the publish dialog so size presets stay in sync with admin config.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { getGlobalImageSizes, EXPORT_EDGE_BOUNDS } from '@/lib/image-sizes';

export async function GET() {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const config = await getGlobalImageSizes(); // event-level overrides aren't surfaced here yet
  return NextResponse.json({
    exportSizes: config.exportSizes,
    bounds: EXPORT_EDGE_BOUNDS,
  });
}
