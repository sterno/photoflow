/**
 * Photo-stream endpoint. Returns the newest ~20 media items for the active
 * event that match the supplied filters. Backs the subscriber-mode live
 * gallery that polls every 1–2 minutes for new uploads.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSignedDownloadUrl } from '@/lib/s3';
import { requireAuth } from '@/lib/require-auth';
import { getActiveEvent } from '@/lib/active-event';
import { buildMediaWhere, parseMediaFilters } from '@/lib/media-filters';

/**
 * GET /api/photos/stream — latest 20 matching media for the active event.
 *
 * Sort is fixed to createdAt desc (arrival order) rather than capture time:
 * the stream view is intentionally a "what's new" feed, not a chronological
 * timeline of when shots were taken.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth();
    if (authResult.response) return authResult.response;

    const searchParams = request.nextUrl.searchParams;
    const filters = parseMediaFilters({
      photographer: searchParams.get('photographer'),
      keyword: searchParams.get('keyword'),
      peopleCount: searchParams.get('peopleCount'),
      personName: searchParams.get('personName'),
      shotType: searchParams.get('shotType'),
      focalLength: searchParams.get('focalLength'),
    });

    const event = await getActiveEvent();
    if (!event) return NextResponse.json({ photos: [] });

    // buildMediaWhere returns null when filters are inherently empty (e.g.
    // a personName the AI has never tagged) — short-circuit so we don't
    // burn a DB roundtrip on a guaranteed-empty query.
    const where = await buildMediaWhere(event.id, filters);
    if (where === null) {
      return NextResponse.json({ photos: [], totalCount: 0 });
    }

    const media = await prisma.media.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { uploader: { select: { username: true, name: true } } },
    });

    const photosWithUrls = await Promise.all(
      media.map(async (item) => {
        let previewUrl = '';
        let thumbnailUrl = '';
        try {
          if (item.s3PreviewKey) {
            previewUrl = await getSignedDownloadUrl(item.s3PreviewKey);
          } else if (item.s3ThumbnailKey) {
            previewUrl = await getSignedDownloadUrl(item.s3ThumbnailKey);
          }
          if (item.s3ThumbnailKey) {
            thumbnailUrl = await getSignedDownloadUrl(item.s3ThumbnailKey);
          }
        } catch (error) {
          console.error('Error generating signed URL:', error);
        }

        return {
          id: item.id,
          filename: item.filename,
          previewUrl,
          thumbnailUrl,
          photographerName: item.photographerName || item.uploader.name || item.uploader.username,
          captureTime: item.captureTime || item.createdAt,
          addedAt: item.createdAt,
          aiCaption: item.aiCaption,
          focalLength: item.focalLength,
          isVideo: item.isVideo,
          cameraModel: item.cameraModel,
          fStop: item.fStop,
          shutterSpeed: item.shutterSpeed,
          iso: item.iso,
          aiPeopleCount: item.aiPeopleCount,
          aiVisibleNames: item.aiVisibleNames,
          aiShotType: item.aiShotType,
          processing: item.processedAt === null,
        };
      }),
    );

    return NextResponse.json({
      photos: photosWithUrls,
      totalCount: photosWithUrls.length,
    });
  } catch (error) {
    console.error('Error fetching photo stream:', error);
    return NextResponse.json(
      { error: 'Failed to fetch photos' },
      { status: 500 }
    );
  }
}
