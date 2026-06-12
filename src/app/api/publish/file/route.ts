/**
 * POST /api/publish/file — Exports a single media item as a download. Handles
 * the rename-via-template + optional resize/recompress pipeline used by the
 * publish UI's "Save File" flow, and writes a PublishLog row so the history
 * panel reflects the export.
 */
import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { getObjectStream } from '@/lib/s3';
import { renderName, DEFAULT_TEMPLATE } from '@/lib/file-naming';
import { validateExportLongEdge } from '@/lib/image-sizes';

const DEFAULT_JPEG_QUALITY = 80;

interface FileRequest {
  mediaId: string;
  template?: string;
  customText?: string;
  collectionId?: string;
  sequence?: number;
  sizeName?: string;
  longEdge?: number;
  quality?: number;
}

/**
 * Coerce a user-supplied JPEG quality into the sharp-accepted 1..100 range,
 * falling back to the project default for missing / nonsensical values.
 */
function validateQuality(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_JPEG_QUALITY;
  const roundedQuality = Math.round(value);
  if (roundedQuality < 1 || roundedQuality > 100) return DEFAULT_JPEG_QUALITY;
  return roundedQuality;
}

/** Drain a Node Readable into a single Buffer. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const body = (await request.json()) as FileRequest;
  const {
    mediaId,
    template = DEFAULT_TEMPLATE,
    customText,
    collectionId,
    sequence = 1,
    sizeName,
  } = body;
  if (!mediaId) {
    return new Response(JSON.stringify({ error: 'mediaId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const longEdge = body.longEdge !== undefined ? validateExportLongEdge(body.longEdge) : null;
  if (body.longEdge !== undefined && longEdge === null) {
    return new Response(JSON.stringify({ error: 'longEdge must be between 64 and 10000' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const quality = validateQuality(body.quality);

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    include: { uploader: { select: { username: true, name: true } } },
  });
  if (!media) {
    return new Response(JSON.stringify({ error: 'Media not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only photos get resized — video resizing isn't supported here, and the
  // file naming template needs to see the .jpg extension so the rendered
  // filename matches what we actually return.
  const willResize = longEdge !== null && !media.isVideo;
  const renamedFilename = willResize
    ? `${media.originalFilename.replace(/\.[^.]+$/, '')}.jpg`
    : media.originalFilename;
  const renderedFilename = renderName(template, {
    captureTime: media.captureTime,
    photographerName: media.photographerName || media.uploader.name || media.uploader.username,
    originalFilename: renamedFilename,
    sequence,
    customText,
  });

  let responseBody: Buffer;
  let contentType: string;
  if (willResize && longEdge) {
    const s3Stream = await getObjectStream(media.s3Key);
    const originalBytes = await streamToBuffer(s3Stream as Readable);
    responseBody = await sharp(originalBytes)
      .rotate() // honor EXIF orientation so portrait images export upright
      .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    contentType = 'image/jpeg';
  } else {
    const s3Stream = await getObjectStream(media.s3Key);
    responseBody = await streamToBuffer(s3Stream as Readable);
    contentType = media.mimeType || 'application/octet-stream';
  }

  await prisma.publishLog.create({
    data: {
      mediaId: media.id,
      collectionId: collectionId || null,
      publishedById: authResult.user.id,
      destination: 'file_export',
      destDetails: {
        template,
        customText: customText || null,
        sizeName: sizeName || null,
        longEdge: longEdge || null,
        quality: longEdge ? quality : null,
        mode: 'folder',
      } as object,
      success: true,
    },
  });

  return new Response(new Uint8Array(responseBody), {
    headers: {
      'Content-Type': contentType,
      // Strip embedded quotes from the filename so the header stays valid.
      // X-Filename is the URI-encoded copy the browser-side download code
      // reads when it needs the original unicode name.
      'Content-Disposition': `attachment; filename="${renderedFilename.replace(/"/g, '')}"`,
      'X-Filename': encodeURIComponent(renderedFilename),
    },
  });
}
