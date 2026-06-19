/**
 * Bulk media delete endpoint. Handles authorization, DB cleanup of related
 * rows (publish logs, collection items), and best-effort S3 object removal.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { deleteFromS3 } from '@/lib/s3';
import { requireClientAccess } from '@/lib/require-auth';

// Bulk delete media. Body: { ids: string[] }.
//
// Permission rules (within the active client):
//   - CLIENT_ADMIN (and global super-admin) can delete any media.
//   - PUBLISHER can delete only media they uploaded.
//   - SUBSCRIBER cannot delete.
//
// If any requested id is not deletable by the caller, the entire request is
// rejected (status 403) — we don't want a "partial success" surprise where
// some photos vanish from a multi-select and others don't.
//
// Side effects:
//   - PublishLog rows referencing the deleted media have their mediaId
//     nulled (the FK is nullable; we keep the audit trail).
//   - CollectionItem rows referencing the deleted media are removed.
//   - S3 originals + thumbnails + previews are deleted.
//
// Returns { deleted: number, s3Errors: string[] }. S3 errors are logged but
// do NOT fail the response — the DB rows are gone and the user shouldn't see
// the photos resurrect because an S3 key wouldn't clean up.
export async function POST(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;
  const { ctx } = authResult;

  // SUBSCRIBER is read-only; PUBLISHER and CLIENT_ADMIN may delete.
  if (ctx.clientRole === 'SUBSCRIBER') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'No ids provided' }, { status: 400 });
  }
  // Defensive cap: keeps a single request from holding a connection forever.
  if (ids.length > 1000) {
    return NextResponse.json({ error: 'Too many ids (max 1000)' }, { status: 400 });
  }

  // Scope to the active client via the event relation: ids belonging to another
  // client are simply not found here, so they can never be deleted cross-tenant.
  const media = await prisma.media.findMany({
    where: { id: { in: ids }, event: { clientId: ctx.clientId } },
    select: {
      id: true,
      uploaderId: true,
      s3Key: true,
      s3ThumbnailKey: true,
      s3PreviewKey: true,
    },
  });

  if (media.length === 0) {
    return NextResponse.json({ deleted: 0, s3Errors: [] });
  }

  if (ctx.clientRole !== 'CLIENT_ADMIN') {
    // Publishers may only delete their own uploads. Reject the whole batch
    // if any id belongs to someone else (no partial deletes — see file doc).
    const foreignRow = media.find((m) => m.uploaderId !== ctx.id);
    if (foreignRow) {
      return NextResponse.json(
        { error: 'You can only delete photos you uploaded' },
        { status: 403 },
      );
    }
  }

  const deletableIds = media.map((m) => m.id);
  // Collect every S3 object across the three resize tiers (original,
  // thumbnail, preview) — some rows may be missing one or more tiers.
  const s3Keys: string[] = [];
  for (const m of media) {
    if (m.s3Key) s3Keys.push(m.s3Key);
    if (m.s3ThumbnailKey) s3Keys.push(m.s3ThumbnailKey);
    if (m.s3PreviewKey) s3Keys.push(m.s3PreviewKey);
  }

  // DB first: if S3 deletion succeeds but DB doesn't, the row references a
  // missing object and the UI will show broken images. Doing DB first means
  // the worst case is orphaned S3 objects, which can be cleaned up later.
  await prisma.$transaction([
    prisma.publishLog.updateMany({
      where: { mediaId: { in: deletableIds } },
      data: { mediaId: null },
    }),
    prisma.collectionItem.deleteMany({
      where: { mediaId: { in: deletableIds } },
    }),
    prisma.media.deleteMany({
      where: { id: { in: deletableIds } },
    }),
  ]);

  const s3Result = await deleteFromS3(s3Keys);
  if (s3Result.errors.length > 0) {
    console.error('S3 deletion errors during media delete:', s3Result.errors);
  }

  return NextResponse.json({
    deleted: deletableIds.length,
    s3Errors: s3Result.errors,
  });
}
