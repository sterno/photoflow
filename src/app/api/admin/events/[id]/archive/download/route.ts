// Admin API route: download the latest archive ZIP for an event. Prefers a
// presigned S3 redirect when available; falls back to streaming the in-flight
// temp file from local disk during the upload phase.
// GET /api/admin/events/[id]/archive/download
import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ArchiveJobStatus, ClientRole } from '@/generated/prisma/client';
import { getSignedDownloadUrl } from '@/lib/s3';
import { archiveTempPath } from '@/server/archive/streamToZipToS3';
import type { ArchiveOptions } from '@/server/archive/types';

/**
 * Download the latest archive for this event.
 *
 *   - If the row is DONE with an s3Key, 302 to a presigned S3 URL so the
 *     browser pulls the bytes directly from S3 (no proxying through Next).
 *   - Otherwise, if the worker has progressed to the upload phase (build is
 *     done and the temp ZIP exists on local disk), stream the local file.
 *     Lets admins start downloading before the S3 upload completes.
 *
 * Race protection: on POSIX systems, fs.createReadStream holds the inode
 * alive even if the worker unlinks the path mid-download, so an in-flight
 * download won't be killed by cleanup.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;

  const { id: eventId } = await params;
  const job = await prisma.archiveJob.findFirst({
    where: {
      eventId,
      // Scope to the active client so a foreign event id yields no archive.
      event: { clientId: authResult.ctx.clientId },
      status: { in: [ArchiveJobStatus.DONE, ArchiveJobStatus.RUNNING] },
    },
    orderBy: { createdAt: 'desc' },
    include: { event: { select: { name: true } } },
  });
  if (!job) {
    return NextResponse.json({ error: 'No archive available' }, { status: 404 });
  }

  // Build a human-friendly filename: photoflow-archive-<event-slug>-<YYYYMMDD>.zip
  const dateStamp = (job.completedAt ?? job.createdAt).toISOString().slice(0, 10).replace(/-/g, '');
  const eventSlug = job.event.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';
  const downloadFilename = `photoflow-archive-${eventSlug}-${dateStamp}.zip`;

  // S3 path — preferred once the row reaches DONE.
  if (job.status === ArchiveJobStatus.DONE && job.s3Key) {
    const presignedUrl = await getSignedDownloadUrl(job.s3Key, { downloadFilename });
    return NextResponse.redirect(presignedUrl, 302);
  }

  // Local-file path — available once the worker has flipped to upload phase.
  const archiveOptions = (job.options as ArchiveOptions | null) ?? {};
  if (archiveOptions.currentPhase !== 'uploading') {
    return NextResponse.json({ error: 'Archive is still building' }, { status: 409 });
  }
  const tempPath = archiveTempPath(job.id);
  if (!existsSync(tempPath)) {
    return NextResponse.json({ error: 'Archive temp file not found' }, { status: 404 });
  }
  const fileStats = statSync(tempPath);
  const nodeStream = createReadStream(tempPath);
  // Node Readable → Web ReadableStream so Next's Response can consume it.
  const webStream = Readable.toWeb(nodeStream) as NodeReadableStream<Uint8Array>;
  return new Response(webStream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': fileStats.size.toString(),
      'Content-Disposition': `attachment; filename="${downloadFilename}"`,
    },
  });
}
