/**
 * Single-media detail endpoint.
 *
 * Returns everything the photo-detail overlay needs: full EXIF/AI metadata,
 * uploader + event relations, and freshly-signed S3 URLs for preview, inline
 * view, and download.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSignedDownloadUrl } from '@/lib/s3';
import { requireClientAccess } from '@/lib/require-auth';

/**
 * GET /api/photos/[id] — fetch a single media item with signed S3 URLs.
 *
 * Returns 404 if the id is unknown. Signed-URL failures are logged but do
 * not fail the request (the client can still render metadata without a
 * preview rather than seeing the whole panel error out).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireClientAccess();
    if (authResult.response) return authResult.response;

    const { id } = await params;

    // Scope to the active client via the event relation so a media id from
    // another client can't be fetched cross-tenant.
    const media = await prisma.media.findFirst({
      where: { id, event: { clientId: authResult.ctx.clientId } },
      include: {
        uploader: {
          select: { username: true, name: true }
        },
        event: {
          select: { name: true }
        }
      }
    });

    if (!media) {
      return NextResponse.json(
        { error: 'Photo not found' },
        { status: 404 }
      );
    }

    // Generate signed URLs
    let previewUrl = '';
    let originalUrl = '';
    let originalViewUrl = '';

    try {
      if (media.s3PreviewKey) {
        previewUrl = await getSignedDownloadUrl(media.s3PreviewKey);
      } else if (media.s3ThumbnailKey) {
        // Fallback to thumbnail if no preview
        previewUrl = await getSignedDownloadUrl(media.s3ThumbnailKey);
      }

      if (media.s3Key) {
        // Two URLs for the original:
        //   originalUrl  — signed with Content-Disposition: attachment so the
        //                  Download Original button saves a file.
        //   originalViewUrl — signed without disposition so the rapid-review
        //                    zoom overlay can render it inline in <img>.
        originalUrl = await getSignedDownloadUrl(media.s3Key, {
          downloadFilename: media.originalFilename || media.filename,
        });
        originalViewUrl = await getSignedDownloadUrl(media.s3Key);
      }
    } catch (error) {
      console.error('Error generating signed URLs:', error);
    }

    return NextResponse.json({
      id: media.id,
      filename: media.filename,
      originalFilename: media.originalFilename,
      previewUrl,
      originalUrl,
      originalViewUrl,
      photographerName: media.photographerName || media.uploader.name || media.uploader.username,
      captureTime: media.captureTime,
      aiCaption: media.aiCaption,
      aiTags: media.aiTags,
      aiPeopleCount: media.aiPeopleCount,
      aiVisibleNames: media.aiVisibleNames,
      aiShotType: media.aiShotType,
      width: media.width,
      height: media.height,
      fileSize: media.fileSize,
      mimeType: media.mimeType,
      isVideo: media.isVideo,
      duration: media.duration,
      
      // Camera metadata
      fStop: media.fStop,
      shutterSpeed: media.shutterSpeed,
      iso: media.iso,
      focalLength: media.focalLength,
      cameraModel: media.cameraModel,
      lens: media.lens,
      latitude: media.latitude,
      longitude: media.longitude,
      
      // Relations
      uploader: media.uploader,
      event: media.event,
      createdAt: media.createdAt,
      processedAt: media.processedAt,
    });

  } catch (error) {
    console.error('Error fetching photo details:', error);
    return NextResponse.json(
      { error: 'Failed to fetch photo details' },
      { status: 500 }
    );
  }
}