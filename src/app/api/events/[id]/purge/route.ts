/**
 * POST /api/events/[id]/purge — admin-only deep delete of every Media row
 * (and its S3 objects) attached to an event, while keeping the Event row
 * itself. Used to clean up after a botched import or to reset a test event.
 * S3 deletion runs before the DB transaction so a failure here leaves the
 * DB intact and the purge is safely retriable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { ClientRole } from '@/generated/prisma/client';
import { deleteFromS3 } from '@/lib/s3';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess(ClientRole.CLIENT_ADMIN);
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const { id } = await params;

  // Scope to the active client; another client's event is a 404.
  const event = await prisma.event.findFirst({
    where: { id, clientId },
    select: { id: true, name: true },
  });
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  const mediaRows = await prisma.media.findMany({
    where: { eventId: id },
    select: { id: true, s3Key: true, s3ThumbnailKey: true, s3PreviewKey: true },
  });

  if (mediaRows.length === 0) {
    return NextResponse.json({ deletedMedia: 0, s3Deleted: 0, s3Errors: [] });
  }

  // Collect every S3 key — original, thumbnail, and preview variants — into a
  // single flat list for batched deletion.
  const s3KeysToDelete: string[] = [];
  for (const row of mediaRows) {
    if (row.s3Key) s3KeysToDelete.push(row.s3Key);
    if (row.s3ThumbnailKey) s3KeysToDelete.push(row.s3ThumbnailKey);
    if (row.s3PreviewKey) s3KeysToDelete.push(row.s3PreviewKey);
  }

  // Step 1: wipe S3 first. If this fails we abort — orphaned S3 objects are worse
  // than orphaned DB rows for cost, and the user can retry the purge.
  const { deleted: s3Deleted, errors: s3Errors } = await deleteFromS3(s3KeysToDelete);
  if (s3Errors.length > 0 && s3Deleted === 0) {
    return NextResponse.json(
      { error: 'S3 deletion failed', s3Errors },
      { status: 502 },
    );
  }

  // Step 2: clean DB. Drop child rows that reference Media first to satisfy
  // FK constraints, then the Media rows themselves.
  const mediaIds = mediaRows.map((row) => row.id);
  const deletedMediaCount = await prisma.$transaction(async (tx) => {
    await tx.collectionItem.deleteMany({ where: { mediaId: { in: mediaIds } } });
    await tx.publishLog.deleteMany({ where: { mediaId: { in: mediaIds } } });
    const deleted = await tx.media.deleteMany({ where: { id: { in: mediaIds } } });
    return deleted.count;
  });

  console.log(
    `Purged event ${event.id} (${event.name}): ${deletedMediaCount} media rows, ${s3Deleted} S3 objects deleted` +
      (s3Errors.length > 0 ? `, ${s3Errors.length} S3 errors` : ''),
  );

  // Both the events list (media counts) and the per-event name cache are now
  // stale for this event.
  revalidateTag(`events:list:${clientId}`, { expire: 0 });
  revalidateTag(`photos:names:${event.id}`, { expire: 0 });
  return NextResponse.json({
    deletedMedia: deletedMediaCount,
    s3Deleted,
    s3Errors,
  });
}
