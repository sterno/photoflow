/**
 * /api/collections/[id] — per-collection REST handlers.
 *   GET    — return the collection plus its items. For smart collections the
 *            items are computed live from filters; for manual ones they come
 *            from the join table. Items are decorated with signed thumbnail
 *            URLs for direct rendering in the UI.
 *   PATCH  — owner-only edit (name, description, public flag, filters).
 *   DELETE — owner-only delete.
 * Visibility rule: a collection is hidden (404) from non-owners when private.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { getSignedDownloadUrl } from '@/lib/s3';
import { buildMediaWhere, parseMediaFilters, summarizeFilters } from '@/lib/media-filters';

type UploaderShape = { name: string | null; username: string };
type MediaItemShape = {
  id: string;
  filename: string;
  originalFilename: string;
  s3PreviewKey: string | null;
  s3ThumbnailKey: string | null;
  photographerName: string | null;
  captureTime: Date | null;
  aiCaption: string | null;
  uploader: UploaderShape;
};

/**
 * Shape a Media row into the wire format expected by the collection viewer:
 * stable identifier, order, and a signed preview/thumbnail URL. Falls back
 * silently to an empty thumbnail string when signing fails so a single bad
 * S3 key doesn't poison the whole response.
 */
async function renderItem(media: MediaItemShape, itemId: string, orderIndex: number) {
  let thumbnailUrl = '';
  try {
    // Prefer the larger preview when available; UI uses srcset to choose.
    const s3Key = media.s3PreviewKey || media.s3ThumbnailKey;
    if (s3Key) thumbnailUrl = await getSignedDownloadUrl(s3Key);
  } catch (err) {
    console.error('signed url failed', err);
  }
  return {
    itemId,
    orderIndex,
    media: {
      id: media.id,
      filename: media.filename,
      originalFilename: media.originalFilename,
      thumbnailUrl,
      photographerName: media.photographerName || media.uploader.name || media.uploader.username,
      captureTime: media.captureTime,
      aiCaption: media.aiCaption,
    },
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const { id } = await params;
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      createdBy: { select: { username: true, name: true } },
      event: { select: { id: true, name: true, clientId: true } },
    },
  });
  if (!collection) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Cross-client isolation: a collection in another client is invisible (404)
  // from the active client. Switch clients to reach it.
  if (collection.event.clientId !== clientId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // Hide private collections from non-owners. 404 (not 403) so we don't leak
  // the existence of someone else's private collection by id-guessing.
  if (!collection.isPublic && collection.createdById !== authResult.ctx.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let items: Awaited<ReturnType<typeof renderItem>>[] = [];
  const filters = collection.isSmart ? parseMediaFilters(collection.filters) : {};

  if (collection.isSmart) {
    // Smart collections recompute their contents from filters on every read.
    const where = await buildMediaWhere(collection.event.id, filters);
    if (where) {
      const matchingMedia = await prisma.media.findMany({
        where,
        // Match the browse view's arrival-first ordering so smart collections
        // don't sink videos and EXIF-less photos (whose captureTime is null)
        // to the bottom.
        orderBy: [{ createdAt: 'desc' }, { captureTime: 'desc' }],
        include: { uploader: { select: { username: true, name: true } } },
      });
      // Synthesize a stable itemId for smart entries (no real join row exists).
      items = await Promise.all(
        matchingMedia.map((media, index) => renderItem(media, `smart-${media.id}`, index)),
      );
    }
  } else {
    // Manual collection: order is user-controlled via orderIndex.
    const itemRows = await prisma.collectionItem.findMany({
      where: { collectionId: id },
      orderBy: { orderIndex: 'asc' },
      include: { media: { include: { uploader: { select: { username: true, name: true } } } } },
    });
    items = await Promise.all(
      itemRows.map((row) => renderItem(row.media, row.id, row.orderIndex)),
    );
  }

  return NextResponse.json({
    collection: {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      event: collection.event,
      // Prefer the user's configured display name; fall back to the login
      // handle so accounts without a name still render something.
      createdBy: collection.createdBy.name || collection.createdBy.username,
      createdById: collection.createdById,
      isOwner: collection.createdById === authResult.ctx.id,
      isPublic: collection.isPublic,
      updatedAt: collection.updatedAt,
      isSmart: collection.isSmart,
      filters: collection.isSmart ? filters : null,
      filterSummary: collection.isSmart ? summarizeFilters(filters) : null,
      items,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const existing = await prisma.collection.findUnique({
    where: { id },
    select: { createdById: true, isPublic: true, event: { select: { clientId: true } } },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Only the owner can edit, and only within the active client. Normalize to
  // 404 across the board (even for public/other-client collections) so the
  // response shape doesn't reveal another collection's existence — matches
  // GET's leak-avoidance rationale.
  if (
    existing.event.clientId !== authResult.ctx.clientId ||
    existing.createdById !== authResult.ctx.id
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await request.json();
  // Sparse update — keys absent from the body are left alone.
  const updateData: Record<string, unknown> = {};
  if (typeof body.name === 'string') updateData.name = body.name;
  if ('description' in body) updateData.description = body.description || null;
  if ('isPublic' in body) updateData.isPublic = Boolean(body.isPublic);
  if ('filters' in body) {
    const parsedFilters = parseMediaFilters(body.filters);
    // Round-trip through JSON to strip undefined values and produce a plain
    // object Prisma accepts as a Json column value.
    updateData.filters = JSON.parse(JSON.stringify(parsedFilters));
  }

  const collection = await prisma.collection.update({ where: { id }, data: updateData });
  revalidateTag(`collections:event:${collection.eventId}`, 'minutes');
  return NextResponse.json({ collection });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;

  const { id } = await params;
  const existing = await prisma.collection.findUnique({
    where: { id },
    select: { createdById: true, isPublic: true, eventId: true, event: { select: { clientId: true } } },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Same normalize-to-404 rationale as PATCH/GET, including cross-client scope.
  if (
    existing.event.clientId !== authResult.ctx.clientId ||
    existing.createdById !== authResult.ctx.id
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await prisma.collection.delete({ where: { id } });
  revalidateTag(`collections:event:${existing.eventId}`, 'minutes');
  return NextResponse.json({ success: true });
}
