/**
 * /api/collections/[id]/items — add or remove media from a manual collection.
 *   POST   — append given mediaIds (de-duped against existing items).
 *   DELETE — remove given mediaIds from the collection.
 * Smart collections are auto-populated from filters and reject both verbs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';

// Single fetch returns everything a write path needs: smart-vs-manual, the
// owner id, visibility, and the owning event's client (for cross-client
// isolation) and eventId (so we only add media from the same event).
async function loadCollectionMeta(id: string) {
  return prisma.collection.findUnique({
    where: { id },
    select: {
      isSmart: true,
      isPublic: true,
      createdById: true,
      eventId: true,
      event: { select: { clientId: true } },
    },
  });
}

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const meta = await loadCollectionMeta(id);
  if (!meta) return notFound();
  // Cross-client isolation, then per-user visibility — same 404 rule as GET.
  if (meta.event.clientId !== authResult.ctx.clientId) return notFound();
  if (!meta.isPublic && meta.createdById !== authResult.ctx.id) return notFound();
  if (meta.isSmart) {
    return NextResponse.json(
      { error: 'Smart collections are auto-populated; items cannot be added manually' },
      { status: 400 },
    );
  }
  const body = await request.json();
  const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
  if (mediaIds.length === 0) {
    return NextResponse.json({ error: 'mediaIds is required' }, { status: 400 });
  }

  const existingItems = await prisma.collectionItem.findMany({
    where: { collectionId: id },
    select: { mediaId: true, orderIndex: true },
  });
  const existingMediaIds = new Set(existingItems.map((item) => item.mediaId));
  // Append new items after the highest current orderIndex so existing order
  // is preserved. Start at 0 when the collection is empty.
  const nextOrderIndex = existingItems.reduce((max, item) => Math.max(max, item.orderIndex), -1) + 1;

  // Only media from the SAME event may join the collection — this also blocks
  // smuggling in another client's media id (whose event has a different client).
  const sameEventMedia = await prisma.media.findMany({
    where: { id: { in: mediaIds }, eventId: meta.eventId },
    select: { id: true },
  });
  const allowedMediaIds = new Set(sameEventMedia.map((m) => m.id));

  // Filter out media already in the collection (no dupes) and any id that isn't
  // a member of this event.
  const mediaIdsToAdd = mediaIds.filter(
    (mediaId) => allowedMediaIds.has(mediaId) && !existingMediaIds.has(mediaId),
  );
  if (mediaIdsToAdd.length > 0) {
    await prisma.collectionItem.createMany({
      data: mediaIdsToAdd.map((mediaId, offset) => ({
        collectionId: id,
        mediaId,
        orderIndex: nextOrderIndex + offset,
      })),
    });
    // Bump updatedAt so the "recently changed" sort on the listing reflects
    // additions; Prisma won't update it automatically for a child-table write.
    await prisma.collection.update({ where: { id }, data: { updatedAt: new Date() } });
    // Item count + updatedAt sort on the cached collection list just changed.
    revalidateTag(`collections:event:${meta.eventId}`, { expire: 0 });
  }

  return NextResponse.json({
    added: mediaIdsToAdd.length,
    skipped: mediaIds.length - mediaIdsToAdd.length,
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const meta = await loadCollectionMeta(id);
  if (!meta) return notFound();
  if (meta.event.clientId !== authResult.ctx.clientId) return notFound();
  if (!meta.isPublic && meta.createdById !== authResult.ctx.id) return notFound();
  if (meta.isSmart) {
    return NextResponse.json(
      { error: 'Smart collections are auto-populated; items cannot be removed manually' },
      { status: 400 },
    );
  }
  const body = await request.json();
  const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
  if (mediaIds.length === 0) {
    return NextResponse.json({ error: 'mediaIds is required' }, { status: 400 });
  }

  const { count } = await prisma.collectionItem.deleteMany({
    where: { collectionId: id, mediaId: { in: mediaIds } },
  });
  // Removed items change the cached collection list's item count.
  if (count > 0) revalidateTag(`collections:event:${meta.eventId}`, { expire: 0 });
  return NextResponse.json({ success: true });
}
