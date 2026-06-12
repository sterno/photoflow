// POST /api/publish/zip — streams a ZIP archive of the requested media to the
// client. Optionally resizes images on the fly via sharp, applies a configurable
// filename template per entry, and records a publish log row for each item so
// publish history stays in sync.

import 'server-only';
import { NextRequest } from 'next/server';
import archiver from 'archiver';
import { Readable } from 'stream';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';
import { getObjectStream } from '@/lib/s3';
import { renderName, DEFAULT_TEMPLATE } from '@/lib/file-naming';
import { validateExportLongEdge } from '@/lib/image-sizes';
import { attachmentContentDisposition } from '@/lib/content-disposition';
import { MAX_INPUT_PIXELS } from '@/lib/imageProcessor';

const DEFAULT_JPEG_QUALITY = 80;

interface ZipRequest {
  mediaIds: string[];
  template?: string;
  customText?: string;
  collectionId?: string;
  filename?: string;
  sizeName?: string; // for logging / display
  longEdge?: number; // omitted or invalid = original size
  quality?: number; // JPEG quality 1-100, only used when resizing
}

/**
 * Coerce the client-supplied JPEG quality into a safe integer in [1, 100],
 * falling back to the default for anything missing or out of range. Avoids
 * passing junk straight through to sharp.
 */
function validateQuality(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_JPEG_QUALITY;
  const qualityInt = Math.round(value);
  if (qualityInt < 1 || qualityInt > 100) return DEFAULT_JPEG_QUALITY;
  return qualityInt;
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const body = (await request.json()) as ZipRequest;
  const { mediaIds, template = DEFAULT_TEMPLATE, customText, collectionId, filename, sizeName } = body;
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return new Response(JSON.stringify({ error: 'mediaIds is required' }), {
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

  const media = await prisma.media.findMany({
    where: { id: { in: mediaIds } },
    include: { uploader: { select: { username: true, name: true } } },
  });
  if (media.length === 0) {
    return new Response(JSON.stringify({ error: 'No media found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Preserve the caller's requested order — Prisma's `in` clause returns rows
  // in DB order, but the client expects the ZIP entries to follow mediaIds.
  const ordered = mediaIds
    .map((id) => media.find((row) => row.id === id))
    .filter((row): row is (typeof media)[number] => Boolean(row));

  const archive = archiver('zip', { zlib: { level: 6 } });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      archive.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      archive.on('end', () => controller.close());
      archive.on('warning', (err) => console.warn('archiver warning:', err));
      archive.on('error', (err) => controller.error(err));

      (async () => {
        try {
          let sequence = 1;
          for (const mediaRow of ordered) {
            // Decide per-file: resize only when longEdge is set and the file is an image.
            const willResize = longEdge !== null && !mediaRow.isVideo;

            // Force .jpg extension on resized output so renderName picks it up correctly.
            const renamedFilename = willResize
              ? `${mediaRow.originalFilename.replace(/\.[^.]+$/, '')}.jpg`
              : mediaRow.originalFilename;

            const name = renderName(template, {
              captureTime: mediaRow.captureTime,
              photographerName: mediaRow.photographerName || mediaRow.uploader.name || mediaRow.uploader.username,
              originalFilename: renamedFilename,
              sequence: sequence++,
              customText,
            });

            if (willResize && longEdge) {
              // Pipe S3 → sharp transform → archiver. Avoids loading the full
              // original AND the full resized output into memory per file —
              // the old buffer-then-resize pattern peaked at original_size +
              // resized_size per item, which OOMed on 60 MB RAWs at small
              // memory limits.
              const s3Stream = (await getObjectStream(mediaRow.s3Key)) as Readable;
              const transform = sharp({ limitInputPixels: MAX_INPUT_PIXELS })
                .rotate() // honor EXIF orientation
                .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality });
              archive.append(s3Stream.pipe(transform), { name });
            } else {
              const s3Stream = await getObjectStream(mediaRow.s3Key);
              archive.append(s3Stream as Readable, { name });
            }
          }
          await archive.finalize();

          await prisma.publishLog.createMany({
            data: ordered.map((mediaRow) => ({
              mediaId: mediaRow.id,
              collectionId: collectionId || null,
              publishedById: authResult.user.id,
              destination: 'file_export',
              destDetails: {
                template,
                customText: customText || null,
                sizeName: sizeName || null,
                longEdge: longEdge || null,
                quality: longEdge ? quality : null,
              } as object,
              success: true,
            })),
          });
        } catch (e) {
          console.error('zip stream error:', e);
          controller.error(e);
        }
      })();
    },
    cancel() {
      archive.abort();
    },
  });

  const zipName = filename || `photoflow_${Date.now()}.zip`;
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': attachmentContentDisposition(zipName),
    },
  });
}
