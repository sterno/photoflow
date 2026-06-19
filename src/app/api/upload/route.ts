/**
 * POST /api/upload — Primary ingest endpoint for the publisher view. Accepts
 * a single file, normalizes its MIME, uploads original/thumbnail/preview to
 * S3, extracts EXIF (or video) metadata, persists a Media row, and (for
 * photos on AI-enabled events) kicks off a background AI captioning job
 * using Next.js's `after()` so the response isn't blocked on Claude.
 */
import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3, generateS3Key } from '@/lib/s3';
import {
  extractMetadata,
  generateThumbnail,
  generatePreview,
  generateVideoThumbnail,
  generateVideoPreview,
  extractVideoMetadata,
  type ImageMetadata,
} from '@/lib/imageProcessor';
import { resolveImageSizesForEvent } from '@/lib/image-sizes';
import { generateImageCaption } from '@/lib/claudeAI';
import { withAiSlot } from '@/lib/ai-limit';
import { requireClientAccess } from '@/lib/require-auth';
import { getActiveEvent } from '@/lib/active-event';
import { ClientRole } from '@/generated/prisma/client';

export async function POST(request: NextRequest) {
  try {
    // Upload is a write into the active client; require at least PUBLISHER
    // within that client (super-admins pass as CLIENT_ADMIN).
    const authResult = await requireClientAccess(ClientRole.PUBLISHER);
    if (authResult.response) return authResult.response;
    const userId = authResult.ctx.id;

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // The file extension is the trustworthy signal, not the client-supplied
    // MIME: browsers (notably iOS Safari with HEVC .mov) lie about Content-Type,
    // and a forged type is a security problem — see normalizedMime below. We
    // therefore validate and key everything off the extension.
    const EXT_TO_MIME: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      heic: 'image/heic',
      heif: 'image/heif',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
    };
    const MAX_BYTES = 60 * 1024 * 1024;
    const ext = file.name.includes('.')
      ? file.name.split('.').pop()!.toLowerCase()
      : '';
    if (!(ext in EXT_TO_MIME)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Allowed: JPEG, PNG, HEIC, MP4, MOV.' },
        { status: 415 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large (${file.size} bytes; max ${MAX_BYTES}).` },
        { status: 413 }
      );
    }

    const activeEvent = await getActiveEvent(authResult.ctx.clientId);

    if (!activeEvent) {
      return NextResponse.json(
        { error: 'No active event found' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Derive the stored MIME from the (validated) extension and never from the
    // client-supplied file.type. Trusting the client type let a valid JPEG be
    // uploaded as "text/html" and then served back as HTML from the S3 origin
    // (a JPEG can carry arbitrary markup in an EXIF comment while staying a
    // valid image) — i.e. attacker-controlled HTML hosted on URLs the app
    // hands out. Keying off the extension also fixes the iOS Safari case where
    // HEVC .mov files arrive with an empty/octet-stream type.
    const normalizedMime = EXT_TO_MIME[ext];
    const isVideo = normalizedMime.startsWith('video/');

    const originalKey = generateS3Key(activeEvent.id, file.name, 'original');
    const thumbnailKey = generateS3Key(activeEvent.id, file.name, 'thumbnail');
    // Videos now get a preview frame too so the gallery/rapid-review can show
    // a real frame instead of relying on the 150px thumbnail.
    const previewKey = generateS3Key(activeEvent.id, file.name, 'preview');

    await uploadToS3(originalKey, buffer, normalizedMime);

    let metadata: ImageMetadata = {};
    let videoDuration: number | null = null;
    let videoWidth: number | null = null;
    let videoHeight: number | null = null;
    let thumbnailBuffer: Buffer;
    let previewBuffer: Buffer | undefined;

    if (isVideo) {
      // generateVideoThumbnail / generateVideoPreview / extractVideoMetadata
      // all share an internal frame cache so ffmpeg actually runs once.
      const sizes = await resolveImageSizesForEvent(activeEvent.id);
      const videoMetadata = await extractVideoMetadata(buffer);
      videoDuration = videoMetadata.duration;
      videoWidth = videoMetadata.width;
      videoHeight = videoMetadata.height;
      thumbnailBuffer = await generateVideoThumbnail(buffer, sizes.thumbnail);
      previewBuffer = await generateVideoPreview(buffer, sizes.preview);
    } else {
      metadata = await extractMetadata(buffer);
      const sizes = await resolveImageSizesForEvent(activeEvent.id);
      thumbnailBuffer = await generateThumbnail(buffer, sizes.thumbnail);
      previewBuffer = await generatePreview(buffer, sizes.preview);
    }

    // Both video and photo thumbnails go out as JPEG now (the video flow runs
    // the ffmpeg-extracted frame through Sharp, which re-encodes to JPEG).
    await uploadToS3(thumbnailKey, thumbnailBuffer, 'image/jpeg');
    if (previewBuffer) {
      await uploadToS3(previewKey, previewBuffer, 'image/jpeg');
    }

    // Photos start with processedAt=null and fill in AI fields asynchronously.
    // Videos don't go through the AI pipeline, so they're "done" immediately.
    const willRunAi = !isVideo && activeEvent.aiEnabled;

    const media = await prisma.media.create({
      data: {
        eventId: activeEvent.id,
        uploaderId: userId,
        filename: `${Date.now()}-${file.name}`,
        originalFilename: file.name,
        s3Key: originalKey,
        s3ThumbnailKey: thumbnailKey,
        s3PreviewKey: previewKey,
        mimeType: normalizedMime,
        fileSize: buffer.length,
        isVideo,
        duration: isVideo ? videoDuration : null,
        width: isVideo ? videoWidth : (metadata.width || null),
        height: isVideo ? videoHeight : (metadata.height || null),
        photographerName: metadata.photographerName || null,
        captureTime: metadata.captureTime || null,
        fStop: metadata.fStop || null,
        shutterSpeed: metadata.shutterSpeed || null,
        iso: metadata.iso || null,
        focalLength: metadata.focalLength || null,
        cameraModel: metadata.cameraModel || null,
        lens: metadata.lens || null,
        latitude: metadata.latitude || null,
        longitude: metadata.longitude || null,
        aiCaption: '',
        aiTags: [],
        aiPeopleCount: 0,
        aiVisibleNames: [],
        aiShotType: 'other',
        // willRunAi → stays null until the background task completes; the
        // gallery shows an "AI processing" badge for these. On AI failure the
        // row stays at null so a future sweeper / retry can pick it up.
        processedAt: willRunAi ? null : new Date(),
      },
    });

    if (willRunAi) {
      const mediaId = media.id;
      // Send the JPEG preview (not the original) to Claude. This covers HEIC
      // inputs — Anthropic's API only accepts JPEG/PNG/GIF/WebP — and is also
      // smaller/faster for every other format. previewBuffer is guaranteed
      // non-null here because willRunAi is only true for non-video uploads.
      const aiInputBuffer = previewBuffer ?? buffer;
      after(async () => {
        try {
          const aiResult = await withAiSlot(() => generateImageCaption(aiInputBuffer, 'image/jpeg'));
          await prisma.media.update({
            where: { id: mediaId },
            data: {
              aiCaption: aiResult.description,
              aiTags: aiResult.tags,
              aiPeopleCount: aiResult.peopleCount,
              aiVisibleNames: aiResult.visibleNames,
              aiShotType: aiResult.shotType,
              processedAt: new Date(),
            },
          });
        } catch (error) {
          console.error(`AI analysis failed for media ${mediaId}; leaving unprocessed:`, error);
        }
      });
    }

    return NextResponse.json({
      success: true,
      mediaId: media.id,
    });

  } catch (error) {
    console.error('Upload error:', error);
    // Returning the message lets the FileUpload error chip say something
    // useful (e.g. "Sharp: unsupported image format") instead of a generic
    // "Upload failed", which makes future regressions much easier to spot.
    const errorMessage = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
