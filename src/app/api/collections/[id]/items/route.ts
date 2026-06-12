/**
 * /api/collections/[id]/items — add or remove media from a manual collection.
 *   POST   — append given mediaIds (de-duped against existing items).
 *   DELETE — remove given mediaIds from the collection.
 * Smart collections are auto-populated from filters and reject both verbs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/require-auth';

// Single fetch returns everything a write path needs: smart-vs-manual, the
// owner id, and visibility — used to reject smart-collection writes, hidden
// private collections, and (in the future) more granular permission checks.
async function loadCollectionMeta(id: string) {
  return prisma.collection.findUnique({
    where: { id },
    select: { isSmart: true, isPublic: true, createdById: true },
  });
}

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const meta = await loadCollectionMeta(id);
  if (!meta) return notFound();
  // Hide other users' private collections — same rule as the GET route.
  if (!meta.isPublic && meta.createdById !== authResult.user.id) return notFound();
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

  // Filter out media already in the collection so we never create duplicates.
  const mediaIdsToAdd = mediaIds.filter((mediaId) => !existingMediaIds.has(mediaId));
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
  }

  return NextResponse.json({
    added: mediaIdsToAdd.length,
    skipped: mediaIds.length - mediaIdsToAdd.length,
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const meta = await loadCollectionMeta(id);
  if (!meta) return notFound();
  if (!meta.isPublic && meta.createdById !== authResult.user.id) return notFound();
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

  await prisma.collectionItem.deleteMany({
    where: { collectionId: id, mediaId: { in: mediaIds } },
  });
  return NextResponse.json({ success: true });
}
