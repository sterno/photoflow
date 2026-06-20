/**
 * /api/collections — list and create collections.
 *   GET  — collections for a given event (or the active event), filtered to
 *          what the caller is allowed to see.
 *   POST — create a manual or smart collection in an event.
 * Smart collections persist a filter spec instead of a join-table list; the
 * member set is recomputed on each read of /api/collections/[id].
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag, unstable_cache } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { requireClientAccess } from '@/lib/require-auth';
import { getActiveEvent } from '@/lib/active-event';
import { parseMediaFilters } from '@/lib/media-filters';

/**
 * Cached fetch of every collection in an event. The shared per-event bucket
 * is then narrowed to per-user visibility (own collections + public) by the
 * route handler. Keeping the user filter out of the cache key lets all users
 * share one bucket per event — N users → 1 DB query per cache window
 * instead of N.
 *
 * Tag is `collections:event:{eventId}`; every write path
 * (POST /api/collections, PATCH/DELETE /api/collections/[id]) calls
 * revalidateTag so edits show up on the next read.
 */
function fetchEventCollections(eventId: string) {
  return unstable_cache(
    async () =>
      prisma.collection.findMany({
        where: { eventId },
        orderBy: { updatedAt: 'desc' },
        include: {
          createdBy: { select: { username: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
    ['collections:event', eventId],
    { tags: [`collections:event:${eventId}`], revalidate: 300 },
  )();
}

export async function GET(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const eventIdParam = request.nextUrl.searchParams.get('eventId');
  // Caller may target a specific event; otherwise fall back to the active one.
  // Scope the lookup to the active client so a forged eventId from another
  // client can't surface that client's collections.
  const event = eventIdParam
    ? await prisma.event.findFirst({ where: { id: eventIdParam, clientId } })
    : await getActiveEvent(clientId);
  if (!event) return NextResponse.json({ collections: [] });

  // Visibility model: a user sees their own collections (regardless of
  // visibility) plus any collection in the event marked public. Private
  // collections owned by other users are hidden — they don't appear in the
  // list, can't be opened, and can't be added to. Filtering happens here
  // rather than in the cached fetcher so users share the same bucket.
  const allCollections = await fetchEventCollections(event.id);
  const userId = authResult.ctx.id;
  const collections = allCollections.filter(
    (collection) => collection.isPublic || collection.createdById === userId,
  );

  // _count.items is meaningless for smart collections (always 0); leave it for
  // manual ones and let the UI fetch smart counts lazily on the detail page.
  return NextResponse.json({
    collections,
    eventId: event.id,
    currentUserId: userId,
  });
}

export async function POST(request: NextRequest) {
  const authResult = await requireClientAccess();
  if (authResult.response) return authResult.response;
  const { clientId } = authResult.ctx;

  const body = await request.json();
  const { name, description, eventId, isSmart, filters, isPublic } = body;
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  // Scope target-event resolution to the active client so a collection can't be
  // created against another client's event.
  const event = eventId
    ? await prisma.event.findFirst({ where: { id: eventId, clientId } })
    : await getActiveEvent(clientId);
  if (!event) return NextResponse.json({ error: 'No event available' }, { status: 400 });

  const isSmartCollection = Boolean(isSmart);
  const parsedFilters = isSmartCollection ? parseMediaFilters(filters) : null;
  // A smart collection with zero filters would match every photo — likely a
  // mistake, so reject up front rather than silently surface the whole event.
  if (isSmartCollection && parsedFilters && Object.keys(parsedFilters).length === 0) {
    return NextResponse.json(
      { error: 'Smart collections need at least one filter' },
      { status: 400 },
    );
  }

  const collection = await prisma.collection.create({
    data: {
      name,
      description: description || null,
      eventId: event.id,
      createdById: authResult.ctx.id,
      isSmart: isSmartCollection,
      isPublic: Boolean(isPublic), // default private; opt-in to public on create
      // JSON round-trip strips undefined and yields a plain Prisma-Json value.
      filters: parsedFilters ? JSON.parse(JSON.stringify(parsedFilters)) : null,
    },
  });
  revalidateTag(`collections:event:${event.id}`, { expire: 0 });
  return NextResponse.json({ collection }, { status: 201 });
}
